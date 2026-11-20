// Gọi Facebook Graph API: lấy danh sách Page, Reels và view của từng Reel
const VERSION = process.env.FB_API_VERSION || 'v23.0';
const GRAPH = `https://graph.facebook.com/${VERSION}`;
const METRICS = (process.env.FB_REEL_METRICS || 'fb_reels_total_plays,blue_reels_play_count,post_impressions_unique')
  .split(',').map((s) => s.trim()).filter(Boolean);

export class GraphError extends Error {
  constructor(err, status) {
    super(err?.message || `Graph API lỗi (HTTP ${status})`);
    this.code = err?.code;
    this.subcode = err?.error_subcode;
    this.status = status;
  }
}

async function graphFetch(url, options) {
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new GraphError(body.error, res.status);
  return body;
}

export function graphGet(pathOrUrl, params = {}) {
  const url = new URL(pathOrUrl.startsWith('http') ? pathOrUrl : `${GRAPH}/${pathOrUrl.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return graphFetch(url);
}

// Lấy tất cả trang của kết quả có phân trang
async function getAll(path, params, { max = Infinity, stopWhen } = {}) {
  const out = [];
  let body = await graphGet(path, params);
  while (true) {
    for (const item of body.data || []) {
      if (stopWhen?.(item)) return { items: out, truncated: false };
      out.push(item);
      if (out.length >= max) return { items: out, truncated: Boolean(body.paging?.next) };
    }
    if (!body.paging?.next) return { items: out, truncated: false };
    body = await graphGet(body.paging.next);
  }
}

// Graph Batch API: tối đa 50 request / lần gọi
async function batch(token, requests) {
  const results = [];
  for (let i = 0; i < requests.length; i += 50) {
    const chunk = requests.slice(i, i + 50);
    const form = new URLSearchParams({
      access_token: token,
      include_headers: 'false',
      batch: JSON.stringify(chunk.map((relative_url) => ({ method: 'GET', relative_url }))),
    });
    const res = await graphFetch(GRAPH, { method: 'POST', body: form });
    for (const r of res) {
      let body = null;
      try { body = r?.body ? JSON.parse(r.body) : null; } catch { /* bỏ qua */ }
      results.push(r && r.code === 200 ? { ok: true, body } : { ok: false, body });
    }
  }
  return results;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------- Đăng nhập Facebook (OAuth) ----------

export const SCOPES = ['pages_show_list', 'pages_read_engagement', 'read_insights', 'pages_read_user_content', 'business_management'];

export function loginConfigured() {
  return Boolean(process.env.FB_APP_ID && process.env.FB_APP_SECRET);
}

export function loginUrl(state, redirectUri, { rerequest = false } = {}) {
  const url = new URL(`https://www.facebook.com/${VERSION}/dialog/oauth`);
  url.searchParams.set('client_id', process.env.FB_APP_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  if (process.env.FB_LOGIN_CONFIG_ID) {
    // App dạng "Facebook Login for Business" dùng configuration id thay cho scope
    url.searchParams.set('config_id', process.env.FB_LOGIN_CONFIG_ID);
  } else {
    url.searchParams.set('scope', SCOPES.join(','));
  }
  if (rerequest) url.searchParams.set('auth_type', 'rerequest');
  return url.toString();
}

export async function exchangeCode(code, redirectUri) {
  const body = await graphGet('oauth/access_token', {
    client_id: process.env.FB_APP_ID,
    client_secret: process.env.FB_APP_SECRET,
    redirect_uri: redirectUri,
    code,
  });
  return body.access_token;
}

export async function missingPermissions(token) {
  try {
    const body = await graphGet('me/permissions', { access_token: token });
    const granted = new Set((body.data || []).filter((p) => p.status === 'granted').map((p) => p.permission));
    return SCOPES.filter((s) => !granted.has(s));
  } catch {
    return [];
  }
}

// ---------- Token ----------

export async function exchangeLongLived(shortToken) {
  const { FB_APP_ID, FB_APP_SECRET } = process.env;
  if (!FB_APP_ID || !FB_APP_SECRET) return { token: shortToken, exchanged: false };
  const body = await graphGet('oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: FB_APP_ID,
    client_secret: FB_APP_SECRET,
    fb_exchange_token: shortToken,
  });
  return { token: body.access_token, exchanged: true };
}

export async function inspectToken(token) {
  const me = await graphGet('me', { fields: 'id,name,picture.type(large){url}', access_token: token });
  let expiresAt = null;
  const { FB_APP_ID, FB_APP_SECRET } = process.env;
  if (FB_APP_ID && FB_APP_SECRET) {
    try {
      const dbg = await graphGet('debug_token', { input_token: token, access_token: `${FB_APP_ID}|${FB_APP_SECRET}` });
      expiresAt = dbg.data?.expires_at ? dbg.data.expires_at * 1000 : 0; // 0 = không hết hạn
    } catch { /* không bắt buộc */ }
  }
  return { user: { id: me.id, name: me.name, picture: me.picture?.data?.url || null }, expiresAt };
}

// ---------- Pages & Reels ----------

const PAGE_FIELDS = 'id,name,category,link,fan_count,followers_count,picture.type(large){url},access_token';

// Lấy tất cả Page: Page được gán trực tiếp cho tài khoản (me/accounts)
// + Page thuộc các Business Portfolio mà tài khoản là thành viên (owned_pages, client_pages)
export async function fetchPages(userToken) {
  const found = new Map(); // id -> page thô
  const sources = new Map(); // id -> tên business (để hiển thị)
  const add = (p, src) => {
    const prev = found.get(p.id);
    if (!prev || (!prev.access_token && p.access_token)) found.set(p.id, { ...prev, ...p });
    if (src && !sources.has(p.id)) sources.set(p.id, src);
  };

  const { items: mine } = await getAll('me/accounts', { access_token: userToken, limit: 100, fields: PAGE_FIELDS });
  mine.forEach((p) => add(p, null));

  let businesses = [];
  try {
    ({ items: businesses } = await getAll('me/businesses', { access_token: userToken, limit: 100, fields: 'id,name' }));
  } catch { /* chưa cấp quyền business_management → chỉ dùng me/accounts */ }

  for (const b of businesses) {
    for (const edge of ['owned_pages', 'client_pages']) {
      try {
        const { items } = await getAll(`${b.id}/${edge}`, { access_token: userToken, limit: 100, fields: PAGE_FIELDS });
        items.forEach((p) => add(p, b.name));
      } catch { /* không có quyền xem edge này */ }
    }
  }

  // Page chưa có page token → thử xin trực tiếp (được nếu bạn là admin Business)
  const noToken = [...found.values()].filter((p) => !p.access_token);
  if (noToken.length) {
    const res = await batch(userToken, noToken.map((p) => `${p.id}?fields=access_token`)).catch(() => []);
    noToken.forEach((p, i) => {
      if (res[i]?.ok && res[i].body?.access_token) found.get(p.id).access_token = res[i].body.access_token;
    });
  }

  return {
    businesses: businesses.map((b) => b.name),
    pages: [...found.values()].map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category || '',
      link: p.link || `https://facebook.com/${p.id}`,
      picture: p.picture?.data?.url || null,
      fanCount: p.fan_count ?? null,
      followers: p.followers_count ?? null,
      business: sources.get(p.id) || null,
      token: p.access_token || null,
    })).sort((a, b) => a.name.localeCompare(b.name, 'vi')),
  };
}

function readInsights(body) {
  const out = {};
  for (const m of body?.data || []) {
    const v = m.values?.[0]?.value;
    if (typeof v === 'number') out[m.name] = v;
  }
  return out;
}

async function fetchReelsOfPage(page, maxReels, sinceMs) {
  // Reels trả về theo thứ tự mới → cũ: gặp reel cũ hơn mốc thì dừng, không quét tiếp các năm trước
  const { items, truncated } = await getAll(`${page.id}/video_reels`, {
    access_token: page.token,
    limit: 50,
    since: Math.floor(sinceMs / 1000),
    fields: 'id,description,title,created_time,permalink_url,length,picture',
  }, { max: maxReels, stopWhen: (r) => new Date(r.created_time).getTime() < sinceMs });

  // 1 request insights + 1 request like/comment cho mỗi reel, gộp qua Batch API
  const reqs = items.flatMap((r) => [
    `${r.id}/video_insights?metric=${METRICS.join(',')}`,
    `${r.id}?fields=likes.limit(0).summary(true),comments.limit(0).summary(true)`,
  ]);
  const res = reqs.length ? await batch(page.token, reqs) : [];

  // Nếu gọi gộp nhiều metric bị lỗi (metric không hỗ trợ) thì thử từng metric một
  const failed = items.filter((_, i) => !res[i * 2]?.ok);
  const single = new Map();
  if (failed.length) {
    const r2 = await batch(page.token, failed.flatMap((r) => METRICS.map((m) => `${r.id}/video_insights?metric=${m}`)));
    failed.forEach((r, i) => {
      const merged = {};
      METRICS.forEach((_, j) => Object.assign(merged, r2[i * METRICS.length + j]?.ok ? readInsights(r2[i * METRICS.length + j].body) : {}));
      single.set(r.id, merged);
    });
  }

  const reels = items.map((r, i) => {
    const ins = res[i * 2]?.ok ? readInsights(res[i * 2].body) : single.get(r.id) || {};
    const eng = res[i * 2 + 1]?.ok ? res[i * 2 + 1].body : null;
    const views = ins.fb_reels_total_plays ?? ins.blue_reels_play_count ?? null;
    return {
      id: r.id,
      pageId: page.id,
      description: r.description || r.title || '',
      createdTime: r.created_time,
      permalink: r.permalink_url ? (r.permalink_url.startsWith('http') ? r.permalink_url : `https://www.facebook.com${r.permalink_url}`) : `https://www.facebook.com/reel/${r.id}`,
      picture: r.picture || null,
      length: r.length ?? null,
      views: views ?? 0,
      viewsAvailable: views !== null,
      reach: ins.post_impressions_unique ?? null,
      likes: eng?.likes?.summary?.total_count ?? null,
      comments: eng?.comments?.summary?.total_count ?? null,
    };
  });
  return { reels, truncated };
}

const NO_ACCESS = 'Bạn chưa được gán quyền vào Page này (trong Business: Cài đặt doanh nghiệp → Người → gán Page cho bạn).';

export async function fetchAll(userToken, { maxReelsPerPage, sinceMs }, onProgress = () => {}) {
  onProgress({ stage: 'pages', done: 0, total: 0 });
  const { pages, businesses } = await fetchPages(userToken);
  const truncated = [];
  const missingViews = [];
  const failed = [];
  let done = 0;
  onProgress({ stage: 'reels', done, total: pages.length });

  const perPage = await mapLimit(pages, 5, async (page) => {
    try {
      if (!page.token) throw new Error(NO_ACCESS);
      const res = await fetchReelsOfPage(page, maxReelsPerPage, sinceMs);
      if (res.truncated) truncated.push(page.name);
      if (res.reels.some((r) => !r.viewsAvailable)) missingViews.push(page.name);
      return { reels: res.reels, error: null };
    } catch (e) {
      failed.push(page.name);
      return { reels: [], error: e.message };
    } finally {
      onProgress({ stage: 'reels', done: ++done, total: pages.length });
    }
  });

  const names = (list) => list.slice(0, 5).map((n) => `"${n}"`).join(', ') + (list.length > 5 ? ` và ${list.length - 5} page khác` : '');
  const warnings = [];
  const noAccess = pages.filter((p, i) => perPage[i].error === NO_ACCESS).map((p) => p.name);
  if (noAccess.length) warnings.push(`${noAccess.length} page chưa lấy được dữ liệu vì bạn chưa được gán quyền vào page trong Business: ${names(noAccess)}.`);
  const otherFail = failed.filter((n) => !noAccess.includes(n));
  if (otherFail.length) warnings.push(`${otherFail.length} page bị lỗi khi tải reels: ${names(otherFail)} (xem chi tiết ở tab Pages).`);
  if (missingViews.length) warnings.push(`Một số reel không lấy được số view (thiếu quyền read_insights) ở: ${names(missingViews)}.`);
  if (truncated.length) warnings.push(`${truncated.length} page đăng hơn ${maxReelsPerPage} reels trong khoảng thời gian quét, chỉ lấy ${maxReelsPerPage} reels mới nhất: ${names(truncated)}. Tăng giới hạn trong Cài đặt nếu cần.`);

  return {
    businesses,
    pages: pages.map(({ token, ...p }, i) => ({ ...p, error: perPage[i].error })),
    reels: perPage.flatMap((p) => p.reels),
    warnings,
  };
}
