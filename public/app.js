/* ThuongView — frontend */
(() => {
  'use strict';

  // ---------------- State ----------------
  const LS_KEY = 'tv-filters';
  const defaults = { range: '7', from: '', to: '', pageId: 'all', tagId: 'all', q: '', sort: 'views', dir: 'desc', pinHot: true, hotOnly: false };
  const state = {
    status: null,
    data: null,
    stars: {},
    tags: { tags: [], pageTags: {} },
    error: null,
    errorCode: null,
    notice: null,
    filter: { ...defaults, ...load(LS_KEY, {}) },
    route: { name: 'dashboard', id: null },
    paging: {}, // key danh sách -> trang hiện tại
    sizes: load('tv-sizes', {}), // key danh sách -> số dòng mỗi trang
    selected: new Set(), // page đang được chọn ở tab Pages
    modal: null,
    charts: [],
    loading: false,
  };
  // dữ liệu chỉ quét tối đa 30 ngày → bỏ các lựa chọn cũ dài hơn
  if (!['today', '3', '7', '14', '30', 'custom'].includes(state.filter.range)) state.filter.range = '30';

  function load(key, fb) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fb; } catch { return fb; }
  }
  function save(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ }
  }

  // ---------------- API ----------------
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || `Lỗi ${res.status}`), { status: res.status, code: body.code });
    return body;
  }

  // ---------------- Utils ----------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nfFull = new Intl.NumberFormat('vi-VN');
  const full = (n) => (n == null ? '—' : nfFull.format(n));
  function compact(n) {
    if (n == null) return '—';
    const a = Math.abs(n);
    const f = (v, d) => String(+v.toFixed(d)).replace('.', ',');
    if (a >= 1e9) return f(n / 1e9, a >= 1e10 ? 0 : 1) + 'B';
    if (a >= 1e6) return f(n / 1e6, a >= 1e7 ? 0 : 1) + 'M';
    if (a >= 1e3) return f(n / 1e3, a >= 1e4 ? 0 : 1) + 'K';
    return String(Math.round(n));
  }
  const pad = (n) => String(n).padStart(2, '0');
  const fmtDate = (t) => { const d = new Date(t); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`; };
  const fmtDateTime = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())} ${fmtDate(t)}`; };
  const fmtTime = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  function ago(t) {
    const s = (Date.now() - new Date(t).getTime()) / 1000;
    if (s < 60) return 'vừa xong';
    if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
    if (s < 86400) return `${Math.floor(s / 3600)} giờ trước`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)} ngày trước`;
    return fmtDate(t);
  }
  const dur = (s) => (s == null ? '' : `${Math.floor(s / 60)}:${pad(Math.round(s % 60))}`);
  const initials = (name) => esc((name || '?').trim().split(/\s+/).slice(-1)[0][0] || '?').toUpperCase();

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  // ---------------- Mốc view & ngọn lửa ----------------
  const milestones = () => state.status?.settings?.milestones || [5000, 10000, 20000];
  function tierOf(m) {
    const i = milestones().indexOf(m);
    return i < 0 ? 0 : Math.min(i + 1, 5);
  }
  function fireBadge(r) {
    if (!r.milestone) return '';
    const t = tierOf(r.milestone);
    return `<span class="fire t${t}" title="Đã vượt mốc ${full(r.milestone)} view">${'🔥'.repeat(t)} ${compact(r.milestone)}+</span>`;
  }
  const isNewMilestone = (r) => r.milestone && r.milestoneAt && Date.now() - r.milestoneAt < 86400000;
  const newBadge = (r) => (isNewMilestone(r) ? `<span class="new-badge" title="Đạt mốc lúc ${fmtDateTime(r.milestoneAt)}">MỚI</span>` : '');

  // ---------------- Lọc dữ liệu ----------------
  const RANGES = [
    ['today', 'Hôm nay'], ['3', '3 ngày'], ['7', '7 ngày'], ['14', '14 ngày'], ['30', '30 ngày'], ['custom', 'Tùy chọn'],
  ];
  const scanDays = () => state.data?.scanDays || state.status?.settings?.scanDays || 30;
  function rangeBounds() {
    const f = state.filter;
    const now = new Date();
    const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    if (f.range === 'custom') {
      const from = f.from ? new Date(`${f.from}T00:00:00`).getTime() : -Infinity;
      const to = f.to ? new Date(`${f.to}T23:59:59.999`).getTime() : Infinity;
      return { from, to };
    }
    const days = f.range === 'today' ? 1 : Number(f.range);
    const d = new Date(now);
    d.setDate(d.getDate() - (days - 1));
    return { from: startOfDay(d), to: Infinity };
  }
  function rangeLabel() {
    const f = state.filter;
    if (f.range === 'custom') return `từ ${f.from ? fmtDate(f.from) : '…'} đến ${f.to ? fmtDate(f.to) : 'nay'}`;
    if (f.range === 'today') return 'hôm nay';
    return `${f.range} ngày gần đây`;
  }

  const pageById = () => new Map((state.data?.pages || []).map((p) => [p.id, p]));

  // ---------------- Tags ----------------
  const tagById = () => new Map(state.tags.tags.map((t) => [t.id, t]));
  const tagIdsOf = (pageId) => state.tags.pageTags[pageId] || [];
  function tagsOf(pageId) {
    const map = tagById();
    return tagIdsOf(pageId).map((id) => map.get(id)).filter(Boolean);
  }
  function tagChip(t, extra = '') {
    return `<span class="tag" style="--tag:${esc(t.color)}" ${extra}>${t.icon ? `<span class="tag-icon">${esc(t.icon)}</span>` : ''}${esc(t.name)}</span>`;
  }
  const tagChips = (pageId) => tagsOf(pageId).map((t) => tagChip(t)).join('');
  function pageMatchesTag(pageId, tagId = state.filter.tagId) {
    if (tagId === 'all') return true;
    if (tagId === 'none') return tagIdsOf(pageId).length === 0;
    return tagIdsOf(pageId).includes(Number(tagId));
  }

  function filteredReels({ ignoreDate = false, ignoreQuery = false, ignoreTag = false } = {}) {
    if (!state.data) return [];
    const f = state.filter;
    const { from, to } = rangeBounds();
    const onPage = state.route.name === 'page';
    const pageId = onPage ? state.route.id : f.pageId;
    const q = ignoreQuery ? '' : f.q.trim().toLowerCase();
    return state.data.reels.filter((r) => {
      if (pageId !== 'all' && r.pageId !== pageId) return false;
      if (!onPage && !ignoreTag && !pageMatchesTag(r.pageId)) return false;
      if (!ignoreDate) {
        const t = new Date(r.createdTime).getTime();
        if (t < from || t > to) return false;
      }
      if (q && !(r.description || '').toLowerCase().includes(q) && r.id !== q) return false;
      return true;
    });
  }

  const SORTS = {
    views: (r) => r.views,
    date: (r) => new Date(r.createdTime).getTime(),
    growth: (r) => r.growth ?? -1,
    likes: (r) => r.likes ?? -1,
    comments: (r) => r.comments ?? -1,
  };
  function sortReels(list, { pinHot = state.filter.pinHot } = {}) {
    const key = SORTS[state.filter.sort] || SORTS.views;
    const dir = state.filter.dir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      if (pinHot && (b.milestone || 0) !== (a.milestone || 0)) return (b.milestone || 0) - (a.milestone || 0);
      return (key(a) - key(b)) * dir || b.views - a.views;
    });
  }

  function summarize(list) {
    const total = list.reduce((s, r) => s + r.views, 0);
    const growthList = list.filter((r) => r.growth != null);
    return {
      count: list.length,
      total,
      avg: list.length ? Math.round(total / list.length) : 0,
      hot: list.filter((r) => r.milestone > 0).length,
      growth: growthList.length ? growthList.reduce((s, r) => s + r.growth, 0) : null,
      growthSince: growthList.length ? Math.min(...growthList.map((r) => r.growthSince)) : null,
      top: list.reduce((m, r) => (!m || r.views > m.views ? r : m), null),
    };
  }

  // ---------------- Phân trang ----------------
  const PAGE_SIZES = [10, 20, 30, 50, 100];
  const sizeOf = (key) => (PAGE_SIZES.includes(state.sizes[key]) ? state.sizes[key] : 10);

  // Trả về phần tử của trang hiện tại + thanh phân trang
  function paginate(key, items) {
    const size = sizeOf(key);
    const total = items.length;
    const pages = Math.max(1, Math.ceil(total / size));
    const cur = Math.min(Math.max(1, state.paging[key] || 1), pages);
    state.paging[key] = cur;
    const start = (cur - 1) * size;
    return { items: items.slice(start, start + size), start, html: pagerHtml(key, cur, pages, total, start, size) };
  }

  function pagerHtml(key, cur, pages, total, start, size) {
    if (total <= PAGE_SIZES[0]) return '';
    const btn = (p, label, { active = false, disabled = false, title = '' } = {}) =>
      `<button class="pg-btn ${active ? 'active' : ''}" data-goto="${key}:${p}" ${disabled ? 'disabled' : ''} ${active ? 'aria-current="page"' : ''} ${title ? `title="${title}" aria-label="${title}"` : ''}>${label}</button>`;
    // các số trang: 1 … (cur-1) cur (cur+1) … last
    const nums = new Set([1, pages, cur - 1, cur, cur + 1].filter((p) => p >= 1 && p <= pages));
    if (cur <= 3) [2, 3, 4].forEach((p) => p <= pages && nums.add(p));
    if (cur >= pages - 2) [pages - 1, pages - 2, pages - 3].forEach((p) => p >= 1 && nums.add(p));
    const sorted = [...nums].sort((a, b) => a - b);
    let parts = '';
    sorted.forEach((p, i) => {
      if (i && p - sorted[i - 1] > 1) parts += '<span class="pg-gap">…</span>';
      parts += btn(p, p, { active: p === cur });
    });
    return `
      <div class="pager" data-pager="${key}">
        <span class="pg-info num">${full(start + 1)}–${full(Math.min(start + size, total))} / ${full(total)}</span>
        <div class="pg-nums">
          ${btn(cur - 1, '‹', { disabled: cur === 1, title: 'Trang trước' })}
          ${parts}
          ${btn(cur + 1, '›', { disabled: cur === pages, title: 'Trang sau' })}
        </div>
        <label class="pg-size">Hiển thị
          <select class="input" data-size="${key}">
            ${PAGE_SIZES.map((n) => `<option value="${n}" ${n === size ? 'selected' : ''}>${n}</option>`).join('')}
          </select> / trang
        </label>
      </div>`;
  }

  // ---------------- Components ----------------
  function thumbImg(r) {
    return r.picture ? `<img src="${esc(r.picture)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : '';
  }
  function starBtn(r) {
    const on = Boolean(state.stars[r.id]);
    return `<button class="star-btn ${on ? 'on' : ''}" data-action="star" data-id="${esc(r.id)}" title="${on ? 'Bỏ theo dõi' : 'Đánh dấu sao để theo dõi'}" aria-pressed="${on}" aria-label="Đánh dấu sao">${on ? '★' : '☆'}</button>`;
  }
  function growthText(r) {
    if (r.growth == null) return '<span class="muted">—</span>';
    const since = Date.now() - r.growthSince >= 23 * 3600000 ? '24h' : `từ ${fmtTime(r.growthSince)}`;
    return `<span class="growth" title="Tăng ${full(r.growth)} view ${since}">+${compact(r.growth)}</span> <span class="reel-meta" style="display:inline">${since}</span>`;
  }

  function reelCard(r, pages) {
    const p = pages.get(r.pageId);
    return `
      <article class="card reel-card ${r.milestone ? 'hot' : ''}">
        <a class="thumb" href="${esc(r.permalink)}" target="_blank" rel="noopener" aria-label="Mở reel trên Facebook">
          ▶ ${thumbImg(r)}
          ${fireBadge(r)}${newBadge(r)}
          <span class="views-overlay num" title="${full(r.views)} view">${compact(r.views)}</span>
          ${r.length ? `<span class="dur">${dur(r.length)}</span>` : ''}
        </a>
        <div class="thumb-star">${starBtn(r)}</div>
        <div class="reel-body">
          <a class="caption" href="${esc(r.permalink)}" target="_blank" rel="noopener">${esc(r.description) || '<i>(Không có mô tả)</i>'}</a>
          <div class="reel-meta"><a href="#/page/${esc(r.pageId)}">${esc(p?.name || '')}</a><span title="${fmtDateTime(r.createdTime)}">${ago(r.createdTime)}</span></div>
          <div class="reel-stats num"><span>${growthText(r)}</span>${r.likes != null ? `<span>👍 ${compact(r.likes)}</span>` : ''}${r.comments != null ? `<span>💬 ${compact(r.comments)}</span>` : ''}</div>
        </div>
      </article>`;
  }

  function filterBar({ showPage = true, showTag = true, placeholder = 'Tìm theo mô tả reel…' } = {}) {
    const f = state.filter;
    const pages = state.data?.pages || [];
    return `
      <div class="card filters">
        <div class="chips" role="group" aria-label="Lọc theo ngày đăng">
          ${RANGES.map(([k, l]) => `<button class="chip ${f.range === k ? 'active' : ''}" data-range="${k}">${l}</button>`).join('')}
        </div>
        ${f.range === 'custom' ? (() => {
          const min = new Date(); min.setDate(min.getDate() - (scanDays() - 1));
          const lim = `min="${isoDay(min)}" max="${isoDay(new Date())}"`;
          return `
          <div class="custom-range">
            <input type="date" class="input" id="f-from" value="${esc(f.from)}" ${lim} aria-label="Từ ngày">
            <span>→</span>
            <input type="date" class="input" id="f-to" value="${esc(f.to)}" ${lim} aria-label="Đến ngày">
          </div>`;
        })() : ''}
        ${showPage ? `
          <select class="input" id="f-page" aria-label="Chọn page">
            <option value="all">Tất cả page (${pages.length})</option>
            ${pages.map((p) => `<option value="${esc(p.id)}" ${f.pageId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
          </select>` : ''}
        ${showTag ? tagSelect() : ''}
        <input class="input grow" id="f-q" type="search" placeholder="${esc(placeholder)}" value="${esc(f.q)}">
        <button class="btn" data-action="refresh" ${state.loading ? 'disabled' : ''}>${state.loading ? 'Đang tải…' : '↻ Làm mới'}</button>
        <span class="meta">${state.progress ? `⏳ ${esc(progressText())}` : state.data ? `Cập nhật ${fmtTime(state.data.fetchedAt)}${state.data.mode === 'demo' ? ' · Dữ liệu demo' : ''}` : ''}</span>
      </div>`;
  }

  function tagSelect() {
    const f = state.filter;
    const { tags } = state.tags;
    const count = (id) => (state.data?.pages || []).filter((p) => pageMatchesTag(p.id, String(id))).length;
    return `
      <div class="tag-filter">
        <select class="input" id="f-tag" aria-label="Lọc theo tag">
          <option value="all">🏷 Tất cả tag</option>
          ${tags.map((t) => `<option value="${t.id}" ${String(f.tagId) === String(t.id) ? 'selected' : ''}>${esc(t.icon)} ${esc(t.name)} (${count(t.id)})</option>`).join('')}
          ${tags.length ? `<option value="none" ${f.tagId === 'none' ? 'selected' : ''}>Chưa gắn tag (${count('none')})</option>` : ''}
        </select>
        <button class="btn" data-action="manage-tags" title="Tạo / sửa tag">🏷 Tag</button>
      </div>`;
  }

  function warnings() {
    const w = state.data?.warnings || [];
    if (!w.length) return '';
    return `<div class="warn"><b>Lưu ý:</b><ul>${w.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
  }

  function kpis(list, extra = '') {
    const s = summarize(list);
    const minM = milestones()[0];
    const growthHint = s.growthSince ? (Date.now() - s.growthSince >= 23 * 3600000 ? 'so với 24h trước' : `kể từ ${fmtTime(s.growthSince)}`) : 'cần làm mới thêm lần nữa';
    return `
      <div class="kpis">
        ${extra}
        <div class="card kpi"><div class="label">Tổng view</div><div class="value num" title="${full(s.total)}">${compact(s.total)}</div><div class="hint num">${full(s.total)} view</div></div>
        <div class="card kpi"><div class="label">Số reels</div><div class="value num">${full(s.count)}</div><div class="hint">đăng ${rangeLabel()}</div></div>
        <div class="card kpi"><div class="label">View trung bình / reel</div><div class="value num">${compact(s.avg)}</div><div class="hint num">${full(s.avg)}</div></div>
        <div class="card kpi"><div class="label">🔥 Reels đạt mốc</div><div class="value num">${full(s.hot)}</div><div class="hint">≥ ${compact(minM)} view</div></div>
        <div class="card kpi"><div class="label">View tăng thêm</div><div class="value num" style="color:var(--good)">${s.growth == null ? '—' : '+' + compact(s.growth)}</div><div class="hint">${growthHint}</div></div>
      </div>`;
  }

  function hotSection(list, pages) {
    const hot = sortReels(list.filter((r) => r.milestone > 0), { pinHot: true });
    const ms = milestones();
    const counts = ms.map((m) => [m, hot.filter((r) => r.milestone === m).length]).filter(([, c]) => c).reverse();
    return `
      <section class="section">
        <div class="section-head">
          <h2>🔥 Reels đạt mốc view</h2>
          <span class="sub">${hot.length ? counts.map(([m, c]) => `${c} reel ≥ ${compact(m)}`).join(' · ') : `Chưa có reel nào ≥ ${compact(ms[0])} view trong ${rangeLabel()}`}</span>
        </div>
        ${hot.length ? (() => {
          const pg = paginate('hot', hot);
          return `<div class="reel-grid">${pg.items.map((r) => reelCard(r, pages)).join('')}</div>${pg.html}`;
        })() : ''}
      </section>`;
  }

  function starredSection(pages, { full: isFull = false } = {}) {
    const list = sortReels(filteredReels({ ignoreDate: true }).filter((r) => state.stars[r.id]), { pinHot: false });
    const missing = Object.keys(state.stars).filter((id) => !state.data.reels.some((r) => r.id === id)).length;
    if (!isFull && !list.length) {
      return `<section class="section"><div class="section-head"><h2>⭐ Reels đang theo dõi</h2><span class="sub">Bấm ☆ trên reel bất kỳ để ghim vào đây</span></div></section>`;
    }
    return `
      <section class="section">
        <div class="section-head">
          <h2>⭐ Reels đang theo dõi</h2>
          <span class="sub">${list.length} reel · hiển thị mọi ngày đăng${missing ? ` · ${missing} reel đã đánh dấu không còn trong dữ liệu` : ''}</span>
          ${!isFull ? '<a class="right" href="#/starred">Xem tất cả →</a>' : ''}
        </div>
        ${list.length ? (() => {
          const pg = paginate('starred', list);
          return `<div class="reel-grid">${pg.items.map((r) => reelCard(r, pages)).join('')}</div>${pg.html}`;
        })() : '<div class="card empty">Chưa có reel nào được đánh dấu sao.</div>'}
      </section>`;
  }

  function pageStatsTable(list) {
    const byPage = new Map();
    for (const p of state.data.pages) byPage.set(p.id, { p, reels: [] });
    for (const r of list) byPage.get(r.pageId)?.reels.push(r);
    const rows = [...byPage.values()]
      .filter((x) => (state.filter.pageId === 'all' || x.p.id === state.filter.pageId) && pageMatchesTag(x.p.id))
      .map((x) => ({ ...x, s: summarize(x.reels) }))
      .sort((a, b) => b.s.total - a.s.total);
    const pg = paginate('pagestats', rows);
    return `
      <section class="section">
        <div class="section-head"><h2>Bảng thống kê theo page</h2><span class="sub">${rows.length} page · reels đăng ${rangeLabel()}</span></div>
        <div class="card table-wrap">
          <table>
            <thead><tr><th class="r">#</th><th>Page</th><th class="r">Reels</th><th class="r">Tổng view</th><th class="r">TB / reel</th><th class="r">🔥 Đạt mốc</th><th class="r">View tăng</th><th>Reel cao nhất</th></tr></thead>
            <tbody>
              ${pg.items.map(({ p, s }, i) => `
                <tr>
                  <td class="r num muted">${pg.start + i + 1}</td>
                  <td><div class="page-cell"><a href="#/page/${esc(p.id)}">${avatar(p)}</a><div><a href="#/page/${esc(p.id)}">${esc(p.name)}</a>${p.error ? ' <span title="' + esc(p.error) + '">⚠️</span>' : ''}<div class="tags">${tagChips(p.id)}</div></div></div></td>
                  <td class="r num">${full(s.count)}</td>
                  <td class="r num"><b>${full(s.total)}</b></td>
                  <td class="r num">${full(s.avg)}</td>
                  <td class="r num">${s.hot || '—'}</td>
                  <td class="r num">${s.growth == null ? '—' : `<span class="growth">+${full(s.growth)}</span>`}</td>
                  <td class="reel-cell">${s.top ? `<a href="${esc(s.top.permalink)}" target="_blank" rel="noopener" class="caption" style="-webkit-line-clamp:1">${esc(s.top.description) || '(Không có mô tả)'}</a><span class="reel-meta num">${full(s.top.views)} view</span>` : '<span class="reel-meta">—</span>'}</td>
                </tr>`).join('')}
            </tbody>
          </table>
          ${pg.html}
        </div>
      </section>`;
  }

  // Thống kê theo tag (1 page có nhiều tag thì được tính vào từng tag)
  function tagStatsSection() {
    const { tags } = state.tags;
    if (!tags.length) {
      return `<section class="section"><div class="section-head"><h2>🏷 Thống kê theo tag</h2><span class="sub">Gắn tag cho page để xem thống kê theo nhóm.</span><button class="btn right" data-action="manage-tags">Tạo tag</button></div></section>`;
    }
    const list = filteredReels({ ignoreTag: true });
    const visiblePages = state.data.pages.filter((p) => state.filter.pageId === 'all' || p.id === state.filter.pageId);
    const rows = [...tags.map((t) => ({ t, key: String(t.id) })), { t: { name: 'Chưa gắn tag', icon: '', color: '#85847f' }, key: 'none' }]
      .map(({ t, key }) => {
        const ids = new Set(visiblePages.filter((p) => pageMatchesTag(p.id, key)).map((p) => p.id));
        return { t, key, pageCount: ids.size, s: summarize(list.filter((r) => ids.has(r.pageId))) };
      })
      .filter((r) => r.key !== 'none' || r.pageCount)
      .sort((a, b) => b.s.total - a.s.total);
    const max = Math.max(1, ...rows.map((r) => r.s.total));
    return `
      <section class="section">
        <div class="section-head">
          <h2>🏷 Thống kê theo tag</h2><span class="sub">Reels đăng ${rangeLabel()} · bấm vào tag để lọc</span>
          <button class="btn right" data-action="manage-tags">Quản lý tag</button>
        </div>
        <div class="card table-wrap">
          <table>
            <thead><tr><th>Tag</th><th class="r">Page</th><th class="r">Reels</th><th class="r">Tổng view</th><th style="width:22%"></th><th class="r">TB / reel</th><th class="r">🔥 Đạt mốc</th><th class="r">View tăng</th></tr></thead>
            <tbody>
              ${rows.map(({ t, key, pageCount, s }) => `
                <tr class="clickable ${String(state.filter.tagId) === key ? 'selected-row' : ''}" data-tag-filter="${key}" title="Lọc theo tag này">
                  <td>${tagChip(t)}</td>
                  <td class="r num">${pageCount}</td>
                  <td class="r num">${full(s.count)}</td>
                  <td class="r num"><b>${full(s.total)}</b></td>
                  <td><div class="share-bar"><span style="width:${(s.total / max) * 100}%;background:${esc(t.color)}"></span></div></td>
                  <td class="r num">${full(s.avg)}</td>
                  <td class="r num">${s.hot || '—'}</td>
                  <td class="r num">${s.growth == null ? '—' : `<span class="growth">+${full(s.growth)}</span>`}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </section>`;
  }

  function avatar(p, cls = '') {
    return `<span class="avatar ${cls}">${p.picture ? `<img src="${esc(p.picture)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : initials(p.name)}</span>`;
  }

  function reelsTable(list, pages, { title = 'Tất cả reels' } = {}) {
    let rows = list;
    let pg = null;
    if (state.filter.hotOnly) rows = rows.filter((r) => r.milestone > 0);
    rows = sortReels(rows);
    const f = state.filter;
    const th = (key, label, cls = 'r') => `<th class="sortable ${cls} ${f.sort === key ? 'sorted' : ''}" data-sort="${key}">${label}${f.sort === key ? (f.dir === 'desc' ? ' ↓' : ' ↑') : ''}</th>`;
    return `
      <section class="section" id="reels-section">
        <div class="section-head">
          <h2>${title}</h2>
          <span class="sub">${rows.length} reel · ${rangeLabel()}</span>
          <span class="right" style="display:flex;gap:14px;flex-wrap:wrap">
            <label class="check"><input type="checkbox" id="f-pin" ${f.pinHot ? 'checked' : ''}> Ghim reels 🔥 lên đầu</label>
            <label class="check"><input type="checkbox" id="f-hot" ${f.hotOnly ? 'checked' : ''}> Chỉ reels đạt mốc</label>
          </span>
        </div>
        <div class="card table-wrap">
          ${rows.length ? `
          <table class="reels">
            <thead><tr><th></th>${th('date', 'Reel', '')}${th('views', 'View')}${th('growth', 'Tăng')}${th('likes', 'Thích')}${th('comments', 'Bình luận')}<th></th></tr></thead>
            <tbody>
              ${(pg = paginate('reels', rows)).items.map((r) => {
                const p = pages.get(r.pageId);
                return `
                <tr class="${r.milestone ? 'hot-row' : ''}">
                  <td class="c-thumb"><a class="mini-thumb" href="${esc(r.permalink)}" target="_blank" rel="noopener">▶${thumbImg(r)}</a></td>
                  <td class="c-reel reel-cell">
                    <a class="caption" href="${esc(r.permalink)}" target="_blank" rel="noopener">${esc(r.description) || '<i>(Không có mô tả)</i>'}</a>
                    <div class="reel-meta"><a href="#/page/${esc(r.pageId)}">${esc(p?.name || '')}</a><span title="${fmtDateTime(r.createdTime)}">${fmtDateTime(r.createdTime)}</span>${r.length ? `<span>⏱ ${dur(r.length)}</span>` : ''}</div>
                  </td>
                  <td class="c-views r views-cell num" title="${full(r.views)} view${r.reach != null ? ` · tiếp cận ${full(r.reach)}` : ''}">${full(r.views)}${fireBadge(r)}${newBadge(r)}</td>
                  <td class="c-extra r num" data-label="Tăng:">${growthText(r)}</td>
                  <td class="c-hide-m r num">${full(r.likes)}</td>
                  <td class="c-hide-m r num">${full(r.comments)}</td>
                  <td class="c-star r">${starBtn(r)}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
          ${pg.html}
          ` : `<div class="empty">Không có reel nào khớp bộ lọc.</div>`}
        </div>
      </section>`;
  }

  function chartsSection({ byPage = true } = {}) {
    return `
      <section class="section charts" style="${byPage ? '' : 'grid-template-columns:1fr'}">
        ${byPage ? `<div class="card chart-card"><h3>View theo page</h3><div class="sub">Top 15 page · tổng view của reels đăng ${rangeLabel()}</div><div class="chart-box" id="chart-pages-box"><canvas id="chart-pages" role="img" aria-label="Biểu đồ tổng view theo page"></canvas></div></div>` : ''}
        <div class="card chart-card"><h3>View theo ngày đăng</h3><div class="sub">Tổng view của các reel, nhóm theo ngày đăng</div><div class="chart-box"><canvas id="chart-days" role="img" aria-label="Biểu đồ view theo ngày đăng"></canvas></div></div>
      </section>`;
  }

  // ---------------- Charts ----------------
  function destroyCharts() {
    state.charts.forEach((c) => c.destroy());
    state.charts = [];
  }
  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  function baseOptions(horizontal) {
    const grid = cssVar('--grid');
    const muted = cssVar('--text-2');
    const valueAxis = { beginAtZero: true, grid: { color: grid }, border: { display: false }, ticks: { color: muted, callback: (v) => compact(v) } };
    const catAxis = { grid: { display: false }, border: { color: grid }, ticks: { color: muted, autoSkip: true, maxRotation: 0 } };
    return {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: horizontal ? 'y' : 'x',
      animation: { duration: 250 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => ` ${full(c.parsed[horizontal ? 'x' : 'y'])} view` } },
      },
      scales: horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis },
    };
  }
  function drawCharts(list) {
    destroyCharts();
    if (typeof Chart === 'undefined') return;
    const color = cssVar('--series-1');
    const bar = { backgroundColor: color, hoverBackgroundColor: color, borderRadius: 4, borderSkipped: 'start', maxBarThickness: 28 };

    const pc = $('#chart-pages');
    if (pc) {
      const totals = new Map();
      for (const p of state.data.pages) {
        if ((state.filter.pageId === 'all' || state.filter.pageId === p.id) && pageMatchesTag(p.id)) totals.set(p.id, { name: p.name, v: 0 });
      }
      for (const r of list) if (totals.has(r.pageId)) totals.get(r.pageId).v += r.views;
      const rows = [...totals.values()].sort((a, b) => b.v - a.v).slice(0, 15);
      $('#chart-pages-box').style.height = `${Math.max(180, rows.length * 34 + 40)}px`;
      state.charts.push(new Chart(pc, {
        type: 'bar',
        data: { labels: rows.map((r) => (r.name.length > 22 ? r.name.slice(0, 21) + '…' : r.name)), datasets: [{ data: rows.map((r) => r.v), ...bar }] },
        options: baseOptions(true),
      }));
    }

    const dc = $('#chart-days');
    if (dc) {
      const { from } = rangeBounds();
      const times = list.map((r) => new Date(r.createdTime).getTime());
      const start = Number.isFinite(from) ? from : (times.length ? Math.min(...times) : Date.now());
      const endBound = rangeBounds().to;
      const end = Number.isFinite(endBound) ? Math.min(endBound, Date.now()) : Date.now();
      const spanDays = (end - start) / 86400000;
      const byMonth = spanDays > 62;
      const buckets = new Map();
      const d = new Date(start);
      d.setHours(0, 0, 0, 0);
      if (byMonth) d.setDate(1);
      while (d.getTime() <= end) {
        const key = byMonth ? `${pad(d.getMonth() + 1)}/${d.getFullYear()}` : `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
        buckets.set(key, 0);
        byMonth ? d.setMonth(d.getMonth() + 1) : d.setDate(d.getDate() + 1);
      }
      for (const r of list) {
        const t = new Date(r.createdTime);
        const key = byMonth ? `${pad(t.getMonth() + 1)}/${t.getFullYear()}` : `${pad(t.getDate())}/${pad(t.getMonth() + 1)}`;
        if (buckets.has(key)) buckets.set(key, buckets.get(key) + r.views);
      }
      const opts = baseOptions(false);
      opts.plugins.tooltip.callbacks.title = (items) => `${byMonth ? 'Tháng' : 'Ngày'} ${items[0].label}`;
      state.charts.push(new Chart(dc, {
        type: 'bar',
        data: { labels: [...buckets.keys()], datasets: [{ data: [...buckets.values()], ...bar }] },
        options: opts,
      }));
    }
  }

  // ---------------- Views ----------------
  const FB_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.04V9.41c0-3.02 1.8-4.7 4.54-4.7 1.31 0 2.68.24 2.68.24v2.97h-1.5c-1.5 0-1.96.93-1.96 1.89v2.26h3.33l-.53 3.49h-2.8V24C19.62 23.1 24 18.1 24 12.07"/></svg>';

  function loginButton(label = 'Đăng nhập với Facebook', rerequest = false) {
    if (!state.status?.loginEnabled) {
      return '<div class="warn" style="margin:0">Quản trị viên chưa cấu hình đăng nhập Facebook (thiếu <code>FB_APP_ID</code> / <code>FB_APP_SECRET</code> trong file <code>.env</code>).</div>';
    }
    return `<a class="btn fb-btn" href="/auth/login${rerequest ? '?rerequest=1' : ''}">${FB_ICON} ${label}</a>`;
  }

  function viewSetup() {
    return `
      <div class="setup">
        <h1>Theo dõi view Reels của các Page bạn quản lý</h1>
        <p class="lead">Đăng nhập bằng tài khoản Facebook đang quản lý Page. Không cần cài đặt hay lấy token, mọi thứ diễn ra tự động.</p>
        <div class="setup-grid">
          <div class="card panel">
            <h2>Đăng nhập</h2>
            <ol>
              <li>Bấm nút bên dưới, đăng nhập Facebook.</li>
              <li>Ở bước chọn Page, <b>chọn tất cả Page</b> bạn muốn theo dõi.</li>
              <li>Giữ nguyên mọi quyền được hỏi, rồi bấm <b>Lưu / Tiếp tục</b>.</li>
            </ol>
            ${loginButton()}
            <p style="font-size:12px;margin-top:14px">Nếu Facebook báo “ứng dụng chưa sẵn sàng / không có quyền truy cập”, hãy nhờ quản trị viên thêm bạn làm <b>Tester</b> của ứng dụng rồi chấp nhận lời mời tại <a href="https://developers.facebook.com/requests/" target="_blank" rel="noopener">developers.facebook.com/requests</a>.</p>
          </div>
          <div class="card panel">
            <h2>Xem thử trước</h2>
            <p>Dùng dữ liệu demo để xem giao diện: thống kê, reels 🔥 đạt mốc, đánh dấu sao, lọc theo ngày…</p>
            <button class="btn" data-action="demo">Dùng dữ liệu demo</button>
          </div>
        </div>
      </div>`;
  }

  function accountNotice() {
    const st = state.status;
    if (st?.mode !== 'live' || !st.tokenExpiresAt) return '';
    const left = st.tokenExpiresAt - Date.now();
    if (left > 7 * 86400000) return '';
    return `<div class="warn">⏳ Phiên Facebook của bạn ${left > 0 ? `sẽ hết hạn sau ${Math.max(1, Math.round(left / 86400000))} ngày` : 'đã hết hạn'}. ${loginButton('Đăng nhập lại để gia hạn')}</div>`;
  }

  function viewDashboard() {
    const pages = pageById();
    const list = filteredReels();
    return `
      <div id="filters">${filterBar()}</div>
      ${warnings()}
      ${kpis(list, `<div class="card kpi"><div class="label">Pages</div><div class="value num">${state.data.pages.filter((p) => pageMatchesTag(p.id)).length}</div><div class="hint">${state.filter.tagId === 'all' ? 'đang quản lý' : 'thuộc tag đang lọc'}</div></div>`)}
      ${hotSection(list, pages)}
      ${starredSection(pages)}
      ${chartsSection()}
      ${tagStatsSection()}
      ${pageStatsTable(list)}
      ${reelsTable(list, pages)}`;
  }

  function viewPages() {
    // Ở tab Pages, ô tìm kiếm lọc theo tên page
    const list = filteredReels({ ignoreQuery: true });
    const q = state.filter.q.trim().toLowerCase();
    const shown = state.data.pages
      .filter((p) => (!q || p.name.toLowerCase().includes(q) || (p.business || '').toLowerCase().includes(q)) && pageMatchesTag(p.id))
      .map((p) => ({ p, s: summarize(list.filter((r) => r.pageId === p.id)) }))
      .sort((a, b) => Boolean(a.p.error) - Boolean(b.p.error) || b.s.total - a.s.total);
    state.shownPageIds = shown.map((x) => x.p.id);
    const errCount = state.data.pages.filter((p) => p.error).length;
    const sel = state.selected;
    const pg = paginate('pages', shown);
    const cards = pg.items.map(({ p, s }) => {
      const allCount = state.data.reels.filter((r) => r.pageId === p.id).length;
      const on = sel.has(p.id);
      return `
        <div class="card page-card ${on ? 'selected' : ''}">
          <div class="top">
            <label class="pick" title="Chọn page để gắn tag hàng loạt"><input type="checkbox" data-select="${esc(p.id)}" ${on ? 'checked' : ''} aria-label="Chọn ${esc(p.name)}"></label>
            <a href="#/page/${esc(p.id)}">${avatar(p, 'lg')}</a>
            <div class="grow-1">
              <a class="name" href="#/page/${esc(p.id)}">${esc(p.name)}</a>
              <div class="cat">${esc(p.category)}${p.followers != null ? ` · ${compact(p.followers)} người theo dõi` : ''}${p.business ? ` · 🏢 ${esc(p.business)}` : ''}</div>
            </div>
          </div>
          <div class="tags">${tagChips(p.id)}<button class="tag-add" data-action="edit-page-tags" data-id="${esc(p.id)}" title="Gắn / gỡ tag">＋ Tag</button></div>
          <a class="stat-row num" href="#/page/${esc(p.id)}">
            <div class="s"><b>${compact(s.total)}</b><span>view (${esc(rangeLabel())})</span></div>
            <div class="s"><b>${s.count}</b><span>reels / ${allCount} đã quét</span></div>
            <div class="s"><b>${s.hot}</b><span>🔥 đạt mốc</span></div>
          </a>
          ${p.error ? `<div class="reel-meta" style="color:var(--danger)">⚠️ ${esc(p.error)}</div>` : ''}
        </div>`;
    }).join('');
    const allShownSelected = shown.length > 0 && shown.every((x) => sel.has(x.p.id));
    return `
      <div id="filters">${filterBar({ showPage: false, placeholder: 'Tìm theo tên page…' })}</div>
      ${warnings()}
      <div class="section-head">
        <h2>Các page đang quản lý</h2>
        <span class="sub">${state.data.pages.length} page${state.data.businesses?.length ? ` · gồm page của Business: ${state.data.businesses.map(esc).join(', ')}` : ''}${errCount ? ` · ${errCount} page chưa lấy được dữ liệu` : ''}${shown.length !== state.data.pages.length ? ` · đang hiện ${shown.length} page khớp bộ lọc` : ''}</span>
        ${shown.length ? `<button class="btn right" data-action="select-all-pages">${allShownSelected ? 'Bỏ chọn tất cả' : `Chọn tất cả ${shown.length} page`}</button>` : ''}
      </div>
      ${sel.size ? `
        <div class="card bulk-bar">
          <b>Đã chọn ${sel.size} page</b>
          <button class="btn primary" data-action="bulk-tags">🏷 Gắn / gỡ tag</button>
          <button class="btn" data-action="clear-selection">Bỏ chọn</button>
        </div>` : ''}
      ${!state.data.pages.length ? '<div class="card empty">Tài khoản này chưa quản lý page nào (hoặc thiếu quyền <code>pages_show_list</code>).</div>'
        : shown.length ? `<div class="page-grid">${cards}</div>${pg.html}` : '<div class="card empty">Không có page nào khớp bộ lọc.</div>'}`;
  }

  function viewPage(id) {
    const p = state.data.pages.find((x) => x.id === id);
    if (!p) return '<div class="card empty">Không tìm thấy page. <a href="#/pages">Quay lại danh sách</a></div>';
    const pages = pageById();
    const list = filteredReels();
    const allCount = state.data.reels.filter((r) => r.pageId === id).length;
    return `
      <div class="page-title">
        ${avatar(p, 'lg')}
        <div>
          <h1>${esc(p.name)}</h1>
          <div class="tags" style="margin:4px 0">${tagChips(p.id)}<button class="tag-add" data-action="edit-page-tags" data-id="${esc(p.id)}">＋ Tag</button></div>
          <div class="reel-meta" style="font-size:13px">${esc(p.category)}${p.followers != null ? ` · ${full(p.followers)} người theo dõi` : ''}${p.fanCount != null ? ` · ${full(p.fanCount)} lượt thích page` : ''}${p.business ? ` · 🏢 ${esc(p.business)}` : ''} · ${allCount} reels trong ${scanDays()} ngày qua · <a href="${esc(p.link)}" target="_blank" rel="noopener">Mở trên Facebook ↗</a></div>
        </div>
      </div>
      ${p.error ? `<div class="warn">⚠️ ${esc(p.error)}</div>` : ''}
      <div id="filters">${filterBar({ showPage: false, showTag: false })}</div>
      ${kpis(list)}
      ${hotSection(list, pages)}
      ${chartsSection({ byPage: false })}
      ${reelsTable(list, pages, { title: `Reels của ${esc(p.name)}` })}`;
  }

  function viewStarred() {
    return `
      <div id="filters">${filterBar()}</div>
      ${starredSection(pageById(), { full: true })}`;
  }

  function viewSettings() {
    const st = state.status;
    const s = st.settings;
    const exp = st.tokenExpiresAt;
    const expText = st.mode !== 'live' ? '' : exp === 0 ? 'Phiên Facebook không hết hạn.' : exp ? `Phiên Facebook hết hạn lúc ${fmtDateTime(exp)}. Đăng nhập lại để gia hạn.` : '';
    return `
      <div class="page-title"><h1>Cài đặt</h1></div>
      <div class="settings-grid">
        <div class="card panel">
          <h2>Tài khoản</h2>
          <p>${st.mode === 'demo' ? 'Bạn đang xem <b>dữ liệu demo</b>.' : `Đang đăng nhập: <b>${esc(st.user?.name || '')}</b>`}</p>
          ${expText ? `<p class="reel-meta" style="font-size:13px">${esc(expText)}</p>` : ''}
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            ${st.mode === 'demo' ? loginButton() : loginButton('Đăng nhập lại / chọn thêm Page', true)}
            <button class="btn danger" data-action="logout">Đăng xuất</button>
          </div>
          ${st.mode === 'live' ? '<p style="font-size:12px;margin-top:14px">Thiếu Page? Bấm “Đăng nhập lại / chọn thêm Page” và tích chọn các Page còn thiếu ở bước chọn Page.</p>' : ''}
        </div>
        <div class="card panel">
          <h2>Hiển thị & dữ liệu</h2>
          <form id="settings-form">
            <div class="form-row">
              <label for="s-milestones">Các mốc view được ghim 🔥</label>
              <input class="input" id="s-milestones" value="${esc(s.milestones.join(', '))}">
              <span class="help">Ngăn cách bằng dấu phẩy. Reel vượt mốc nào sẽ được ghim lên đầu với số ngọn lửa tương ứng. Mặc định: 5000, 10000, 20000, 50000…</span>
            </div>
            <div class="form-row">
              <label for="s-scan">Quét reels trong bao nhiêu ngày gần nhất</label>
              <input class="input" id="s-scan" type="number" min="1" max="30" value="${s.scanDays || 30}">
              <span class="help">Tối đa 30 ngày. Chỉ quét reels đăng trong khoảng này, không quét reels cũ hơn để tránh chậm máy.</span>
            </div>
            <div class="form-row">
              <label for="s-cache">Thời gian lưu cache (phút)</label>
              <input class="input" id="s-cache" type="number" min="1" max="1440" value="${s.cacheMinutes}">
              <span class="help">Trong khoảng này dữ liệu lấy từ bộ nhớ, bấm “Làm mới” để tải lại ngay.</span>
            </div>
            <div class="form-row">
              <label for="s-max">Số reels tối đa mỗi page (trong khoảng ngày quét)</label>
              <input class="input" id="s-max" type="number" min="10" max="2000" value="${s.maxReelsPerPage}">
              <span class="help">Lấy các reels mới nhất. Càng nhiều thì tải càng lâu.</span>
            </div>
            <button class="btn primary" type="submit">Lưu cài đặt</button>
          </form>
        </div>
      </div>`;
  }

  // ---------------- Hộp thoại tag ----------------
  const TAG_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948', '#6b6a65'];
  const TAG_EMOJIS = ['🔥', '⭐', '💰', '🎯', '📌', '🚀', '💎', '👑', '🏆', '📈', '🎬', '🍜', '✈️', '😂', '📚', '🛒', '❤️', '🌱', '⚠️', '🧪'];

  function tagForm(tag) {
    const v = tag || { name: '', icon: '📌', color: TAG_COLORS[0] };
    const custom = !TAG_COLORS.includes(v.color);
    return `
      <form id="tag-form" class="tag-form" data-edit="${tag ? tag.id : ''}">
        <div class="tf-row">
          <label class="tf-label" for="tf-icon">Icon</label>
          <div class="tf-icons">
            <input class="input tf-icon-input" id="tf-icon" value="${esc(v.icon)}" maxlength="8" aria-label="Icon (emoji)">
            ${TAG_EMOJIS.map((e) => `<button type="button" class="emoji-btn" data-emoji="${e}">${e}</button>`).join('')}
          </div>
        </div>
        <div class="tf-row">
          <label class="tf-label" for="tf-name">Tên</label>
          <input class="input" id="tf-name" value="${esc(v.name)}" maxlength="40" placeholder="VD: Ẩm thực, Page chính, Cần đẩy…" required>
        </div>
        <div class="tf-row">
          <span class="tf-label">Màu</span>
          <div class="swatches" role="radiogroup" aria-label="Màu tag">
            ${TAG_COLORS.map((c) => `<label class="swatch" style="--sw:${c}"><input type="radio" name="tf-color" value="${c}" ${v.color === c ? 'checked' : ''} aria-label="${c}"><span></span></label>`).join('')}
            <label class="swatch custom" title="Màu khác"><input type="radio" name="tf-color" value="custom" ${custom ? 'checked' : ''} aria-label="Màu khác"><input type="color" id="tf-custom" value="${custom ? esc(v.color) : '#8f2bd1'}"></label>
          </div>
        </div>
        <div class="tf-row tf-actions">
          <span class="tf-label">Xem trước</span>
          <span id="tag-preview">${tagChip({ ...v, name: v.name || 'Tên tag' })}</span>
          <span class="right" style="display:flex;gap:8px">
            ${tag ? '<button type="button" class="btn" data-action="tag-cancel-edit">Huỷ</button>' : ''}
            <button class="btn primary" type="submit">${tag ? 'Lưu thay đổi' : '＋ Tạo tag'}</button>
          </span>
        </div>
      </form>`;
  }

  function readTagForm() {
    const checked = document.querySelector('input[name="tf-color"]:checked')?.value;
    return {
      icon: $('#tf-icon').value.trim(),
      name: $('#tf-name').value.trim(),
      color: !checked || checked === 'custom' ? $('#tf-custom').value : checked,
    };
  }

  function modalManage() {
    const { tags } = state.tags;
    const editing = tags.find((t) => t.id === state.modal.edit);
    const pageCount = (id) => Object.values(state.tags.pageTags).filter((ids) => ids.includes(id)).length;
    return `
      <h2 id="modal-title">🏷 Quản lý tag</h2>
      <p class="muted" style="margin-top:0">Tag giúp nhóm các page để lọc và thống kê. Mỗi page có thể có nhiều tag.</p>
      <h3>${editing ? 'Sửa tag' : 'Tạo tag mới'}</h3>
      ${tagForm(editing)}
      <h3>Danh sách tag (${tags.length})</h3>
      ${tags.length ? `<div class="tag-list">${tags.map((t) => `
        <div class="tag-list-row ${editing?.id === t.id ? 'editing' : ''}">
          ${tagChip(t)}
          <span class="muted">${pageCount(t.id)} page</span>
          <span class="right" style="display:flex;gap:6px">
            <button class="btn sm" data-action="tag-edit" data-tag="${t.id}">Sửa</button>
            <button class="btn sm danger" data-action="tag-delete" data-tag="${t.id}">Xoá</button>
          </span>
        </div>`).join('')}</div>` : '<p class="muted">Chưa có tag nào.</p>'}`;
  }

  function modalPageTags() {
    const ids = state.modal.pageIds;
    const pages = pageById();
    const { tags } = state.tags;
    const title = ids.length === 1 ? `Tag của “${esc(pages.get(ids[0])?.name || '')}”` : `Gắn / gỡ tag cho ${ids.length} page`;
    return `
      <h2 id="modal-title">🏷 ${title}</h2>
      <p class="muted" style="margin-top:0">${ids.length === 1 ? 'Bấm vào tag để gắn hoặc gỡ.' : 'Bấm vào tag: nếu tất cả page đã có tag thì gỡ, ngược lại thì gắn cho tất cả.'}</p>
      ${tags.length ? `<div class="tag-toggle-list">${tags.map((t) => {
        const n = ids.filter((id) => tagIdsOf(id).includes(t.id)).length;
        const st = n === 0 ? 'none' : n === ids.length ? 'all' : 'some';
        return `<button class="tag-toggle ${st}" data-action="tag-toggle" data-tag="${t.id}" aria-pressed="${st === 'all'}">
          <span class="tt-box">${st === 'all' ? '✓' : st === 'some' ? '–' : ''}</span>${tagChip(t)}
          ${ids.length > 1 ? `<span class="muted num">${n}/${ids.length}</span>` : ''}
        </button>`;
      }).join('')}</div>` : '<p class="muted">Chưa có tag nào, tạo tag đầu tiên bên dưới.</p>'}
      <h3>Tạo tag mới & gắn luôn</h3>
      ${tagForm(null)}`;
  }

  function renderModal() {
    let root = $('#modal-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'modal-root';
      document.body.appendChild(root);
    }
    if (!state.modal) { root.innerHTML = ''; document.body.classList.remove('modal-open'); return; }
    const body = state.modal.type === 'manage' ? modalManage() : modalPageTags();
    root.innerHTML = `
      <div class="modal-backdrop" data-action="close-modal">
        <div class="modal card" role="dialog" aria-modal="true" aria-labelledby="modal-title">
          <button class="icon-btn modal-close" data-action="close-modal" aria-label="Đóng">✕</button>
          ${body}
        </div>
      </div>`;
    document.body.classList.add('modal-open');
  }

  function openModal(m) {
    state.modal = m;
    renderModal();
    setTimeout(() => $('#tf-name')?.focus(), 0);
  }

  async function saveTags(promise) {
    try {
      state.tags = await promise;
      if (state.filter.tagId !== 'all' && state.filter.tagId !== 'none' && !state.tags.tags.some((t) => String(t.id) === String(state.filter.tagId))) {
        state.filter.tagId = 'all';
      }
      render();
      renderModal();
      return true;
    } catch (err) {
      toast(`Lỗi: ${err.message}`);
      return false;
    }
  }

  // ---------------- Render ----------------
  // Thông báo trả về từ trang đăng nhập Facebook (#/?err=… hoặc #/?perm=…)
  const PERM_LABEL = {
    pages_show_list: 'xem danh sách Page',
    pages_read_engagement: 'đọc nội dung & tương tác của Page',
    read_insights: 'xem số liệu thống kê (view)',
    pages_read_user_content: 'đọc bài đăng / reels của Page',
    business_management: 'xem các Page thuộc Business (Trang quản lý tài sản doanh nghiệp)',
  };
  function notice() {
    const n = state.notice;
    if (!n) return '';
    if (n.err) return `<div class="warn" style="border-color:var(--danger)">⚠️ ${esc(n.err)}</div>`;
    if (n.perm) {
      return `<div class="warn">⚠️ Bạn chưa cấp đủ quyền: <b>${n.perm.map((p) => esc(PERM_LABEL[p] || p)).join(', ')}</b>. Thiếu quyền này app sẽ không lấy được số view.
        <div style="margin-top:8px">${loginButton('Cấp lại quyền', true)}</div></div>`;
    }
    return '';
  }

  function parseRoute() {
    const [rawPath, query] = location.hash.replace(/^#\/?/, '').split('?');
    if (query) {
      const q = new URLSearchParams(query);
      if (q.get('err')) state.notice = { err: q.get('err') };
      else if (q.get('perm')) state.notice = { perm: q.get('perm').split(',') };
      history.replaceState(null, '', `${location.pathname}#/${rawPath}`);
    }
    const [name, id] = rawPath.split('/');
    if (name === 'page' && id) return { name: 'page', id: decodeURIComponent(id) };
    if (['pages', 'starred', 'settings'].includes(name)) return { name, id: null };
    return { name: 'dashboard', id: null };
  }

  function progressText() {
    const p = state.progress;
    if (!p) return '';
    if (p.stage === 'pages') return 'Đang lấy danh sách page…';
    return `Đã tải reels của ${p.done}/${p.total} page`;
  }
  function progressBar() {
    const p = state.progress;
    if (!p || !p.total) return '';
    return `<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${p.total}" aria-valuenow="${p.done}"><span style="width:${Math.round((p.done / p.total) * 100)}%"></span></div>`;
  }

  function renderHeader() {
    const st = state.status;
    const active = state.route.name === 'page' ? 'pages' : state.route.name;
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === active));
    const u = st?.user;
    $('#user-chip').innerHTML = u ? `<a href="#/settings" class="user-chip" title="Tài khoản & cài đặt">${u.picture ? `<img src="${esc(u.picture)}" alt="" referrerpolicy="no-referrer">` : ''}<span>${esc(u.name)}</span></a>` : '';
  }

  function render() {
    renderHeader();
    const app = $('#app');
    const st = state.status;
    if (!st) { app.innerHTML = '<div class="loading">Đang tải…</div>'; return; }
    if (!st.user) { destroyCharts(); app.innerHTML = notice() + viewSetup(); return; }
    if (state.route.name === 'settings') { destroyCharts(); app.innerHTML = notice() + viewSettings(); return; }
    if (state.error && !state.data) {
      destroyCharts();
      app.innerHTML = `${notice()}<div class="card error-box"><b>Không tải được dữ liệu:</b> ${esc(state.error)}<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">${state.errorCode === 'TOKEN_EXPIRED' ? loginButton('Đăng nhập lại') : '<button class="btn" data-action="refresh">Thử lại</button>'}</div></div>`;
      return;
    }
    if (!state.data) {
      destroyCharts();
      app.innerHTML = `<div class="loading">
        <div style="font-size:16px;color:var(--text);margin-bottom:6px">Đang tải dữ liệu từ Facebook…</div>
        <div>${esc(progressText() || 'Lần đầu có thể mất vài phút nếu có nhiều page.')}</div>
        ${progressBar()}
      </div>`;
      return;
    }

    const views = { dashboard: viewDashboard, pages: viewPages, starred: viewStarred, page: () => viewPage(state.route.id) };
    // giữ lại vị trí con trỏ trong ô tìm kiếm khi render lại
    const active = document.activeElement;
    const focusId = active?.id;
    const caret = focusId === 'f-q' ? active.selectionStart : null;
    app.innerHTML = notice() + accountNotice() + views[state.route.name]();
    if (focusId) {
      const el = document.getElementById(focusId);
      if (el) { el.focus(); if (caret != null) el.setSelectionRange(caret, caret); }
    }
    if (state.route.name === 'dashboard' || state.route.name === 'page') drawCharts(filteredReels());
    else destroyCharts();
  }

  // ---------------- Data loading ----------------
  async function loadStatus() {
    state.status = await api('/api/status');
  }
  let pollTimer;
  async function loadData(force = false, { silent = false, polling = false } = {}) {
    if (!state.status?.user) return;
    if (state.loading && !polling) return;
    clearTimeout(pollTimer);
    state.loading = true;
    if (force) state.forced = true;
    if (!silent) render();
    let keepPolling = false;
    try {
      const [data, stars, tags] = await Promise.all([api(`/api/data${force ? '?refresh=1' : ''}`), api('/api/stars'), api('/api/tags')]);
      state.stars = stars;
      state.tags = tags;
      state.error = null;
      state.errorCode = null;
      if (data.loading) {
        // server vẫn đang tải (nhiều page) → giữ dữ liệu cũ nếu có, hỏi lại sau 2 giây
        state.progress = data.progress;
        if (data.pages) state.data = data;
        keepPolling = true;
        pollTimer = setTimeout(() => loadData(false, { silent: true, polling: true }), 2000);
        return;
      }
      state.progress = null;
      state.data = data;
      if (state.filter.pageId !== 'all' && !data.pages.some((p) => p.id === state.filter.pageId)) state.filter.pageId = 'all';
      if (data.refreshError) toast(`Không cập nhật được: ${data.refreshError}`);
      else if (state.forced) toast('Đã cập nhật dữ liệu mới nhất');
      state.forced = false;
    } catch (e) {
      state.progress = null;
      state.forced = false;
      state.error = e.message;
      state.errorCode = e.code;
      if (e.code === 'NOT_LOGGED_IN') { state.data = null; await loadStatus(); }
      if (e.code === 'TOKEN_EXPIRED') state.data = null;
      if (state.data || silent) toast(`Lỗi: ${e.message}`);
    } finally {
      if (!keepPolling) state.loading = false;
      render();
    }
  }

  function setFilter(patch, { resetPaging = true } = {}) {
    Object.assign(state.filter, patch);
    if (resetPaging) state.paging = {};
    save(LS_KEY, { ...state.filter, q: '' });
    render();
  }

  // ---------------- Events ----------------
  function goToPage(key, page) {
    state.paging[key] = page;
    render();
    // đưa đầu danh sách vào màn hình nếu đang bị cuộn quá
    const section = document.querySelector(`[data-pager="${key}"]`)?.closest('.section') || document.querySelector(`[data-pager="${key}"]`)?.parentElement;
    if (section && section.getBoundingClientRect().top < 0) section.scrollIntoView({ block: 'start' });
  }

  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action],[data-range],[data-sort],[data-goto],[data-tag-filter],[data-emoji]');
    if (!el) return;
    if (el.dataset.goto) {
      const [key, p] = el.dataset.goto.split(':');
      return goToPage(key, Number(p));
    }
    if (el.dataset.tagFilter) {
      const v = el.dataset.tagFilter;
      return setFilter({ tagId: String(state.filter.tagId) === v ? 'all' : v });
    }
    if (el.dataset.emoji) {
      $('#tf-icon').value = el.dataset.emoji;
      return updateTagPreview();
    }
    if (el.dataset.range) {
      const patch = { range: el.dataset.range };
      if (el.dataset.range === 'custom' && !state.filter.from) {
        const d = new Date(); d.setDate(d.getDate() - 6);
        patch.from = isoDay(d); patch.to = isoDay(new Date());
      }
      return setFilter(patch);
    }
    if (el.dataset.sort) {
      const key = el.dataset.sort;
      const dir = state.filter.sort === key && state.filter.dir === 'desc' ? 'asc' : 'desc';
      return setFilter({ sort: key, dir });
    }
    const action = el.dataset.action;
    if (action === 'star') {
      e.preventDefault();
      const id = el.dataset.id;
      const on = Boolean(state.stars[id]);
      try {
        state.stars = await api(`/api/stars/${encodeURIComponent(id)}`, { method: on ? 'DELETE' : 'PUT', body: on ? undefined : {} });
        toast(on ? 'Đã bỏ theo dõi reel' : '⭐ Đã thêm vào danh sách theo dõi');
        render();
      } catch (err) { toast(`Lỗi: ${err.message}`); }
    } else if (action === 'refresh') {
      loadData(true);
    } else if (action === 'close-modal') {
      if (el.classList.contains('modal-backdrop') && e.target !== el) return; // bấm bên trong hộp thoại
      state.modal = null; renderModal();
    } else if (action === 'manage-tags') {
      openModal({ type: 'manage', edit: null });
    } else if (action === 'edit-page-tags') {
      openModal({ type: 'page-tags', pageIds: [el.dataset.id] });
    } else if (action === 'bulk-tags') {
      openModal({ type: 'page-tags', pageIds: [...state.selected] });
    } else if (action === 'select-all-pages') {
      const ids = state.shownPageIds || [];
      const all = ids.length && ids.every((id) => state.selected.has(id));
      ids.forEach((id) => (all ? state.selected.delete(id) : state.selected.add(id)));
      render();
    } else if (action === 'clear-selection') {
      state.selected.clear(); render();
    } else if (action === 'tag-edit') {
      state.modal.edit = Number(el.dataset.tag); renderModal(); $('#tf-name')?.focus();
    } else if (action === 'tag-cancel-edit') {
      state.modal.edit = null; renderModal();
    } else if (action === 'tag-delete') {
      const t = state.tags.tags.find((x) => x.id === Number(el.dataset.tag));
      if (!t || !confirm(`Xoá tag “${t.name}”? Tag sẽ bị gỡ khỏi tất cả page.`)) return;
      if (state.modal.edit === t.id) state.modal.edit = null;
      await saveTags(api(`/api/tags/${t.id}`, { method: 'DELETE' }));
    } else if (action === 'tag-toggle') {
      const tagId = Number(el.dataset.tag);
      const ids = state.modal.pageIds;
      const allHave = ids.every((id) => tagIdsOf(id).includes(tagId));
      await saveTags(api('/api/page-tags', { method: 'POST', body: { pageIds: ids, add: allHave ? [] : [tagId], remove: allHave ? [tagId] : [] } }));
    } else if (action === 'demo') {
      await api('/api/demo', { method: 'POST' });
      state.data = null; state.notice = null; state.stars = {}; state.tags = { tags: [], pageTags: {} }; state.selected.clear();
      await loadStatus(); location.hash = '#/'; render(); loadData();
    } else if (action === 'logout') {
      if (!confirm('Đăng xuất khỏi ThuongView?')) return;
      await api('/auth/logout', { method: 'POST' });
      state.data = null; state.stars = {}; state.notice = null; state.tags = { tags: [], pageTags: {} }; state.selected.clear();
      await loadStatus(); location.hash = '#/'; render();
    }
  });

  function updateTagPreview() {
    const el = $('#tag-preview');
    if (el) el.innerHTML = tagChip({ ...readTagForm(), name: readTagForm().name || 'Tên tag' });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.modal) { state.modal = null; renderModal(); }
  });

  let qTimer;
  document.addEventListener('input', (e) => {
    if (e.target.closest('#tag-form')) {
      if (e.target.id === 'tf-custom') { const r = document.querySelector('input[name="tf-color"][value="custom"]'); if (r) r.checked = true; }
      return updateTagPreview();
    }
    if (e.target.id === 'f-q') {
      clearTimeout(qTimer);
      const v = e.target.value;
      qTimer = setTimeout(() => setFilter({ q: v }), 200);
    }
  });

  document.addEventListener('change', (e) => {
    const id = e.target.id;
    const t = e.target;
    if (t.closest('#tag-form')) return updateTagPreview();
    if (t.dataset.size) {
      state.sizes[t.dataset.size] = Number(t.value);
      save('tv-sizes', state.sizes);
      return goToPage(t.dataset.size, 1);
    }
    if (t.dataset.select) {
      t.checked ? state.selected.add(t.dataset.select) : state.selected.delete(t.dataset.select);
      return render();
    }
    if (id === 'f-tag') setFilter({ tagId: t.value });
    else if (id === 'f-page') setFilter({ pageId: e.target.value });
    else if (id === 'f-from') setFilter({ from: e.target.value });
    else if (id === 'f-to') setFilter({ to: e.target.value });
    else if (id === 'f-pin') setFilter({ pinHot: e.target.checked }, { resetPaging: false });
    else if (id === 'f-hot') setFilter({ hotOnly: e.target.checked });
  });

  document.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    if (e.target.id === 'tag-form') {
      const v = readTagForm();
      if (!v.name) return toast('Vui lòng nhập tên tag');
      const editId = Number(e.target.dataset.edit) || null;
      btn.disabled = true;
      if (editId) {
        if (await saveTags(api(`/api/tags/${editId}`, { method: 'PUT', body: v }))) {
          state.modal.edit = null; renderModal(); toast('Đã lưu tag');
        }
      } else {
        const before = new Set(state.tags.tags.map((t) => t.id));
        const ok = await saveTags(api('/api/tags', { method: 'POST', body: v }));
        const created = ok && state.tags.tags.find((t) => !before.has(t.id));
        // đang ở hộp thoại gắn tag cho page → gắn luôn tag vừa tạo
        if (created && state.modal?.type === 'page-tags') {
          await saveTags(api('/api/page-tags', { method: 'POST', body: { pageIds: state.modal.pageIds, add: [created.id] } }));
        }
        if (created) toast(`Đã tạo tag “${created.name}”`);
      }
      if (btn.isConnected) btn.disabled = false;
      return;
    }
    if (e.target.id === 'settings-form') {
      btn.disabled = true;
      const milestones = $('#s-milestones').value.split(/[,;\s]+/).map((x) => Number(x.replace(/[^\d]/g, ''))).filter((n) => n > 0);
      try {
        await api('/api/settings', { method: 'POST', body: { milestones, scanDays: $('#s-scan').value, cacheMinutes: $('#s-cache').value, maxReelsPerPage: $('#s-max').value } });
        await loadStatus();
        toast('Đã lưu cài đặt');
        state.data = null;
        render();
        loadData();
      } catch (err) { toast(`Lỗi: ${err.message}`); }
      btn.disabled = false;
    }
  });

  window.addEventListener('hashchange', () => {
    state.route = parseRoute();
    state.paging = {};
    state.modal = null;
    renderModal();
    render();
    window.scrollTo(0, 0);
  });

  $('#theme-btn').addEventListener('click', () => {
    const root = document.documentElement;
    const isDark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = isDark ? 'light' : 'dark';
    try { localStorage.setItem('tv-theme', root.dataset.theme); } catch { /* ignore */ }
    render();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);

  // Tự làm mới mỗi 5 phút khi tab đang mở
  setInterval(() => {
    if (document.visibilityState === 'visible' && state.data && !state.loading) loadData(false, { silent: true });
  }, 5 * 60000);

  // ---------------- Init ----------------
  (async () => {
    state.route = parseRoute();
    try {
      await loadStatus();
    } catch (e) {
      $('#app').innerHTML = `<div class="card error-box">Không kết nối được server: ${esc(e.message)}</div>`;
      return;
    }
    render();
    loadData();
  })();
})();
