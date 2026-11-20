import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  getUser, upsertUser, saveSettings, createSession, getSessionUserId, deleteSession, cleanup,
  getStars, setStar, removeStar, applyHistory, DEFAULT_SETTINGS, MAX_SCAN_DAYS,
  getTags, createTag, updateTag, deleteTag, changePageTags,
} from './lib/db.js';
import {
  fetchAll, exchangeLongLived, inspectToken, loginUrl, exchangeCode, loginConfigured, missingPermissions, GraphError,
} from './lib/facebook.js';
import { demoData } from './lib/demo.js';

const app = express();
app.set('trust proxy', true); // chạy sau Nginx / Cloudflare Tunnel / Render…
app.use(express.json());
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')));

const SID = 'tv_sid';
const STATE = 'tv_state';

// ---------- Cookie ----------
function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function cookieOpts(req, maxAge) {
  return { httpOnly: true, sameSite: 'lax', secure: baseUrl(req).startsWith('https://'), maxAge, path: '/' };
}
function baseUrl(req) {
  return (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}
const redirectUri = (req) => `${baseUrl(req)}/auth/callback`;

function startSession(req, res, userId) {
  const s = createSession(userId);
  res.cookie(SID, s.id, cookieOpts(req, s.maxAge));
}

// ---------- Đăng nhập Facebook ----------
app.get('/auth/login', (req, res) => {
  if (!loginConfigured()) return res.redirect('/#/?err=' + encodeURIComponent('Quản trị viên chưa cấu hình FB_APP_ID / FB_APP_SECRET.'));
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie(STATE, state, cookieOpts(req, 10 * 60000));
  res.redirect(loginUrl(state, redirectUri(req), { rerequest: req.query.rerequest === '1' }));
});

app.get('/auth/callback', async (req, res) => {
  const fail = (msg) => res.redirect('/#/?err=' + encodeURIComponent(msg));
  try {
    if (req.query.error) return fail(req.query.error_description || 'Bạn đã huỷ đăng nhập.');
    const state = readCookie(req, STATE);
    res.clearCookie(STATE, { path: '/' });
    if (!state || state !== req.query.state) return fail('Phiên đăng nhập không hợp lệ, vui lòng thử lại.');

    const short = await exchangeCode(String(req.query.code || ''), redirectUri(req));
    const { token } = await exchangeLongLived(short);
    const { user, expiresAt } = await inspectToken(token);
    upsertUser({ id: user.id, mode: 'live', name: user.name, picture: user.picture, token, tokenExpiresAt: expiresAt });
    cache.delete(user.id);

    // nếu đang dùng phiên demo thì thay bằng phiên thật
    const old = readCookie(req, SID);
    if (old) deleteSession(old);
    startSession(req, res, user.id);

    const missing = await missingPermissions(token);
    res.redirect(missing.length ? '/#/?perm=' + encodeURIComponent(missing.join(',')) : '/#/');
  } catch (e) {
    console.error('[đăng nhập]', e.message);
    fail(`Đăng nhập thất bại: ${e.message}`);
  }
});

app.post('/auth/logout', (req, res) => {
  const sid = readCookie(req, SID);
  if (sid) deleteSession(sid);
  res.clearCookie(SID, { path: '/' });
  res.json({ ok: true });
});

app.post('/api/demo', (req, res) => {
  const id = `demo:${crypto.randomUUID()}`;
  upsertUser({ id, mode: 'demo', name: 'Khách (demo)' });
  const old = readCookie(req, SID);
  if (old) deleteSession(old);
  startSession(req, res, id);
  res.json({ ok: true });
});

// ---------- Xác thực cho /api ----------
function currentUser(req) {
  const uid = getSessionUserId(readCookie(req, SID));
  return uid ? getUser(uid) : null;
}

app.get('/api/status', (req, res) => {
  const u = currentUser(req);
  res.json({
    loginEnabled: loginConfigured(),
    user: u ? { name: u.name, picture: u.picture, mode: u.mode } : null,
    mode: u?.mode || null,
    tokenExpiresAt: u?.tokenExpiresAt ?? null,
    settings: u?.settings || DEFAULT_SETTINGS,
  });
});

app.use('/api', (req, res, next) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Bạn chưa đăng nhập.', code: 'NOT_LOGGED_IN' });
  req.user = u;
  next();
});

// ---------- Dữ liệu (cache theo từng người) ----------
// Tải dữ liệu chạy nền: nhiều page có thể mất vài phút, trình duyệt sẽ hỏi lại tiến độ
const cache = new Map(); // userId -> { data, fetchedAt, pending, progress, lastError }

function startRefresh(user, c) {
  c.progress = { stage: 'pages', done: 0, total: 0 };
  c.pending = (async () => {
    const days = Math.min(MAX_SCAN_DAYS, user.settings.scanDays || MAX_SCAN_DAYS);
    const sinceMs = Date.now() - days * 86400000;
    let raw;
    if (user.mode === 'demo') raw = demoData();
    else {
      if (!user.token) throw Object.assign(new Error('Phiên Facebook đã hết hạn, vui lòng đăng nhập lại.'), { status: 401, code: 'TOKEN_EXPIRED' });
      raw = await fetchAll(user.token, { maxReelsPerPage: user.settings.maxReelsPerPage, sinceMs }, (p) => { c.progress = p; });
    }
    const recent = raw.reels.filter((r) => new Date(r.createdTime).getTime() >= sinceMs);
    const reels = applyHistory(user.id, recent, user.settings.milestones);
    return { mode: user.mode, scanDays: days, sinceMs, fetchedAt: Date.now(), businesses: raw.businesses || [], pages: raw.pages, reels, warnings: raw.warnings };
  })()
    .then((data) => { c.data = data; c.fetchedAt = data.fetchedAt; c.lastError = null; })
    .catch((e) => {
      if (e instanceof GraphError && e.code === 190) {
        e = Object.assign(new Error('Phiên Facebook đã hết hạn hoặc bị thu hồi, vui lòng đăng nhập lại.'), { status: 401, code: 'TOKEN_EXPIRED' });
      }
      console.error('[tải dữ liệu]', user.name, e.message);
      c.lastError = e;
    })
    .finally(() => { c.pending = null; c.progress = null; });
}

async function getData(user, force) {
  let c = cache.get(user.id);
  if (!c) cache.set(user.id, (c = { data: null, fetchedAt: 0, pending: null, progress: null, lastError: null }));
  const stale = !c.data || Date.now() - c.fetchedAt >= user.settings.cacheMinutes * 60000;
  if (!c.pending && (force || stale)) startRefresh(user, c);

  if (c.pending) await Promise.race([c.pending, new Promise((r) => setTimeout(r, 15000))]);
  if (c.pending) return { loading: true, progress: c.progress, ...(c.data || {}) };

  if (c.lastError) {
    const e = c.lastError;
    c.lastError = null;
    if (!c.data || e.code === 'TOKEN_EXPIRED') throw e;
    return { ...c.data, refreshError: e.message };
  }
  return c.data;
}

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error('[lỗi]', req.user?.name, e.message);
  res.status(e.status || 500).json({ error: e.message, code: e.code });
});

app.get('/api/data', wrap(async (req, res) => {
  res.json(await getData(req.user, req.query.refresh === '1'));
}));

app.post('/api/settings', (req, res) => {
  const cur = req.user.settings;
  const b = req.body || {};
  const milestones = Array.isArray(b.milestones)
    ? [...new Set(b.milestones.map(Number).filter((n) => Number.isFinite(n) && n > 0))].sort((a, c) => a - c)
    : cur.milestones;
  const settings = {
    milestones: milestones.length ? milestones : DEFAULT_SETTINGS.milestones,
    cacheMinutes: Math.min(1440, Math.max(1, Number(b.cacheMinutes) || cur.cacheMinutes)),
    maxReelsPerPage: Math.min(2000, Math.max(10, Number(b.maxReelsPerPage) || cur.maxReelsPerPage)),
    scanDays: Math.min(MAX_SCAN_DAYS, Math.max(1, Math.round(Number(b.scanDays)) || cur.scanDays)),
  };
  saveSettings(req.user.id, settings);
  cache.delete(req.user.id);
  res.json({ ok: true, settings });
});

app.get('/api/stars', (req, res) => res.json(getStars(req.user.id)));

app.put('/api/stars/:id', (req, res) => {
  setStar(req.user.id, req.params.id, String(req.body?.note || '').slice(0, 300));
  res.json(getStars(req.user.id));
});

app.delete('/api/stars/:id', (req, res) => {
  removeStar(req.user.id, req.params.id);
  res.json(getStars(req.user.id));
});

// ---------- Tags ----------
function tagInput(b = {}) {
  const name = String(b.name || '').trim().slice(0, 40);
  const icon = [...String(b.icon || '').trim()].slice(0, 4).join('');
  const color = /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '#6b6a65';
  if (!name) throw Object.assign(new Error('Tên tag không được để trống.'), { status: 400 });
  return { name, icon, color };
}
const tagRoute = (fn) => (req, res) => {
  try {
    fn(req);
    res.json(getTags(req.user.id));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
};
app.get('/api/tags', (req, res) => res.json(getTags(req.user.id)));
app.post('/api/tags', tagRoute((req) => createTag(req.user.id, tagInput(req.body))));
app.put('/api/tags/:id', tagRoute((req) => updateTag(req.user.id, Number(req.params.id), tagInput(req.body))));
app.delete('/api/tags/:id', tagRoute((req) => deleteTag(req.user.id, Number(req.params.id))));
// Gắn / gỡ tag cho 1 hoặc nhiều page: { pageIds: [], add: [tagId], remove: [tagId] }
app.post('/api/page-tags', tagRoute((req) => {
  const b = req.body || {};
  const ids = (a) => (Array.isArray(a) ? a.map(Number).filter(Number.isInteger) : []);
  const pageIds = Array.isArray(b.pageIds) ? b.pageIds.map(String).slice(0, 5000) : [];
  changePageTags(req.user.id, pageIds, ids(b.add), ids(b.remove));
}));

// dọn dẹp định kỳ
cleanup();
setInterval(cleanup, 6 * 3600000).unref();

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`ThuongView đang chạy: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (!loginConfigured()) console.log('⚠️  Chưa có FB_APP_ID / FB_APP_SECRET trong .env — chỉ dùng được chế độ demo.');
  if (process.env.BASE_URL) console.log(`Redirect URI cần khai báo trong Facebook App: ${process.env.BASE_URL.replace(/\/$/, '')}/auth/callback`);
});
