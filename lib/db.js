// Lưu trữ SQLite (dùng module có sẵn của Node, không cần cài thêm)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const DATA_DIR = path.resolve('data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'thuongview.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,              -- Facebook user id, hoặc "demo:<uuid>" cho khách xem demo
    mode TEXT NOT NULL,               -- 'live' | 'demo'
    name TEXT NOT NULL,
    picture TEXT,
    token_enc TEXT,                   -- token đã mã hoá AES-256-GCM
    token_expires INTEGER,            -- ms; 0 = không hết hạn; NULL = không rõ
    settings TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    last_login INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stars (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reel_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, reel_id)
  );
  -- Tag của page (riêng từng người)
  CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS page_tags (
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    page_id TEXT NOT NULL,
    PRIMARY KEY (tag_id, page_id)
  );
  -- Lịch sử view của reel (dùng chung: cùng 1 reel thì view như nhau với mọi người)
  CREATE TABLE IF NOT EXISTS snaps (
    reel_id TEXT NOT NULL,
    t INTEGER NOT NULL,
    v INTEGER NOT NULL,
    PRIMARY KEY (reel_id, t)
  );
  -- Thời điểm reel đạt mốc (theo từng người, vì mỗi người có thể đặt mốc khác nhau)
  CREATE TABLE IF NOT EXISTS reached (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reel_id TEXT NOT NULL,
    m INTEGER NOT NULL,
    t INTEGER NOT NULL,
    PRIMARY KEY (user_id, reel_id)
  );
`);

// ---------- Mã hoá token ----------
function loadKey() {
  if (process.env.APP_SECRET) return crypto.createHash('sha256').update(process.env.APP_SECRET).digest();
  const file = path.join(DATA_DIR, 'secret.key');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
}
const KEY = loadKey();

export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
export function decrypt(payload) {
  if (!payload) return null;
  try {
    const [iv, tag, enc] = payload.split('.').map((s) => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ---------- Users ----------
export const DEFAULT_SETTINGS = {
  milestones: [5000, 10000, 20000, 50000, 100000, 200000, 500000, 1000000, 2000000, 5000000, 10000000],
  cacheMinutes: 10,
  maxReelsPerPage: 300,
  scanDays: 30, // chỉ quét reels đăng trong N ngày gần nhất (tối đa 30)
};
export const MAX_SCAN_DAYS = 30;

// ---------- Tags ----------
export function getTags(userId) {
  const tags = db.prepare('SELECT id, name, icon, color FROM tags WHERE user_id = ? ORDER BY created_at, id').all(userId)
    .map((t) => ({ ...t }));
  const pageTags = {};
  for (const r of db.prepare('SELECT pt.page_id, pt.tag_id FROM page_tags pt JOIN tags t ON t.id = pt.tag_id WHERE t.user_id = ?').all(userId)) {
    (pageTags[r.page_id] ||= []).push(r.tag_id);
  }
  return { tags, pageTags };
}
const ownsTag = (userId, id) => Boolean(db.prepare('SELECT 1 FROM tags WHERE id = ? AND user_id = ?').get(id, userId));

export function createTag(userId, { name, icon, color }) {
  db.prepare('INSERT INTO tags (user_id, name, icon, color, created_at) VALUES (?, ?, ?, ?, ?)').run(userId, name, icon, color, Date.now());
}
export function updateTag(userId, id, { name, icon, color }) {
  db.prepare('UPDATE tags SET name = ?, icon = ?, color = ? WHERE id = ? AND user_id = ?').run(name, icon, color, id, userId);
}
export function deleteTag(userId, id) {
  db.prepare('DELETE FROM tags WHERE id = ? AND user_id = ?').run(id, userId);
}
export function changePageTags(userId, pageIds, add = [], remove = []) {
  const ins = db.prepare('INSERT OR IGNORE INTO page_tags (tag_id, page_id) VALUES (?, ?)');
  const del = db.prepare('DELETE FROM page_tags WHERE tag_id = ? AND page_id = ?');
  db.exec('BEGIN');
  try {
    for (const t of add) if (ownsTag(userId, t)) for (const p of pageIds) ins.run(t, p);
    for (const t of remove) if (ownsTag(userId, t)) for (const p of pageIds) del.run(t, p);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function getUser(id) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return null;
  let settings = {};
  try { settings = JSON.parse(u.settings); } catch { /* bỏ qua */ }
  return {
    id: u.id,
    mode: u.mode,
    name: u.name,
    picture: u.picture,
    token: decrypt(u.token_enc),
    tokenExpiresAt: u.token_expires,
    settings: { ...DEFAULT_SETTINGS, ...settings },
  };
}

export function upsertUser({ id, mode, name, picture = null, token = null, tokenExpiresAt = null }) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO users (id, mode, name, picture, token_enc, token_expires, created_at, last_login)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET mode = excluded.mode, name = excluded.name, picture = excluded.picture,
      token_enc = excluded.token_enc, token_expires = excluded.token_expires, last_login = excluded.last_login
  `).run(id, mode, name, picture, token ? encrypt(token) : null, tokenExpiresAt, now, now);
}

export function saveSettings(userId, settings) {
  db.prepare('UPDATE users SET settings = ? WHERE id = ?').run(JSON.stringify(settings), userId);
}

export function listUsers() {
  return db.prepare("SELECT id, name, mode, last_login FROM users WHERE mode = 'live' ORDER BY last_login DESC").all();
}

// ---------- Sessions ----------
const SESSION_DAYS = 30;
export function createSession(userId) {
  const id = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (id, user_id, expires) VALUES (?, ?, ?)').run(id, userId, Date.now() + SESSION_DAYS * 86400000);
  return { id, maxAge: SESSION_DAYS * 86400000 };
}
export function getSessionUserId(id) {
  if (!id) return null;
  const s = db.prepare('SELECT user_id, expires FROM sessions WHERE id = ?').get(id);
  if (!s || s.expires < Date.now()) return null;
  return s.user_id;
}
export function deleteSession(id) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}
export function cleanup() {
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(now);
  // khách demo không hoạt động quá 7 ngày
  db.prepare("DELETE FROM users WHERE mode = 'demo' AND last_login < ? AND id NOT IN (SELECT user_id FROM sessions)").run(now - 7 * 86400000);
  db.prepare('DELETE FROM snaps WHERE t < ?').run(now - 8 * 86400000);
}

// ---------- Stars ----------
export function getStars(userId) {
  const out = {};
  for (const r of db.prepare('SELECT reel_id, at, note FROM stars WHERE user_id = ?').all(userId)) out[r.reel_id] = { at: r.at, note: r.note };
  return out;
}
export function setStar(userId, reelId, note = '') {
  db.prepare('INSERT OR REPLACE INTO stars (user_id, reel_id, at, note) VALUES (?, ?, ?, ?)').run(userId, reelId, Date.now(), note);
}
export function removeStar(userId, reelId) {
  db.prepare('DELETE FROM stars WHERE user_id = ? AND reel_id = ?').run(userId, reelId);
}

// ---------- Lịch sử view & mốc ----------
const HOUR = 3600000;
const qLast = db.prepare('SELECT t, v FROM snaps WHERE reel_id = ? ORDER BY t DESC LIMIT 1');
const qInsert = db.prepare('INSERT OR IGNORE INTO snaps (reel_id, t, v) VALUES (?, ?, ?)');
const qBase24 = db.prepare('SELECT t, v FROM snaps WHERE reel_id = ? AND t <= ? ORDER BY t DESC LIMIT 1');
const qOldest = db.prepare('SELECT t, v FROM snaps WHERE reel_id = ? ORDER BY t ASC LIMIT 1');
const qReached = db.prepare('SELECT m, t FROM reached WHERE user_id = ? AND reel_id = ?');
const qSetReached = db.prepare('INSERT OR REPLACE INTO reached (user_id, reel_id, m, t) VALUES (?, ?, ?, ?)');

export function applyHistory(userId, reels, milestones) {
  const now = Date.now();
  const sorted = [...milestones].sort((a, b) => a - b);
  db.exec('BEGIN');
  try {
    const out = reels.map((r) => {
      const last = qLast.get(r.id);
      if (!last || now - last.t >= 30 * 60000) qInsert.run(r.id, now, r.views);

      let base = qBase24.get(r.id, now - 24 * HOUR);
      if (!base) {
        const o = qOldest.get(r.id);
        if (o && now - o.t >= 10 * 60000) base = o;
      }

      const milestone = sorted.filter((m) => r.views >= m).pop() || 0;
      const prev = qReached.get(userId, r.id);
      let at = prev?.t || 0;
      if (!prev) qSetReached.run(userId, r.id, milestone, 0);
      else if (milestone > prev.m) { at = now; qSetReached.run(userId, r.id, milestone, now); }
      else if (milestone < prev.m) qSetReached.run(userId, r.id, milestone, prev.t);

      return {
        ...r,
        growth: base ? Math.max(0, r.views - base.v) : null,
        growthSince: base ? base.t : null,
        milestone,
        milestoneAt: at,
      };
    });
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
