const state = {
  config: null,
  room: null,
  session: null,
  sessionData: new Map(),
  activeTab: "gifts",
  danmakuOffset: 0,
};

const app = document.querySelector("#app");
const roomTemplate = document.querySelector("#room-template");

const escapeHtml = (value = "") => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

const number = (value) => new Intl.NumberFormat("zh-CN").format(Number(value || 0));
const money = (value) => new Intl.NumberFormat("zh-CN", {
  style: "currency", currency: state.config?.display?.currency || "CNY", maximumFractionDigits: 2,
}).format(Number(value || 0));

const dateTime = (value, detail = true) => {
  if (!value) return "未记录";
  const date = new Date(value);
  return new Intl.DateTimeFormat("zh-CN", detail
    ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }
    : { year: "numeric", month: "2-digit", day: "2-digit" }
  ).format(date);
};

const duration = (session) => {
  const start = new Date(session.started_at).getTime();
  const end = session.ended_at ? new Date(session.ended_at).getTime() : Date.now();
  const minutes = Math.max(0, Math.floor((end - start) / 60000));
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
};

const initials = (name = "N") => [...name.trim()].slice(0, 2).join("").toUpperCase() || "N";

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败 (${response.status})`);
  return payload;
}

function roomIdentifier() {
  const segment = decodeURIComponent(location.pathname.split("/").filter(Boolean)[0] || "");
  return segment === "admin" ? "" : segment;
}

async function boot() {
  try {
    state.config = await api("/api/config");
    document.title = `${state.config.app.site_name} · 直播记录`;
    document.querySelector("#site-name").textContent = state.config.app.site_name;
    let identifier = roomIdentifier();
    if (!identifier) {
      if (!state.config.features.public_room_directory) {
        throw new Error("请通过直播间号或别名访问，例如 /21452505");
      }
      const rooms = await api("/api/rooms");
      if (!rooms.items.length) throw new Error("还没有可展示的直播间");
      identifier = rooms.items[0].alias || rooms.items[0].room_number;
      history.replaceState({}, "", `/${encodeURIComponent(identifier)}`);
    }
    await loadRoom(identifier);
    if (state.config.features.public_room_directory) loadRoomPicker();
  } catch (error) {
    renderError(error.message);
  }
}

async function loadRoom(identifier) {
  state.room = await api(`/api/rooms/${encodeURIComponent(identifier)}`);
  app.replaceChildren(roomTemplate.content.cloneNode(true));
  document.querySelector("#room-title").textContent = state.room.streamer_name;
  document.querySelector("#room-number").textContent = state.room.room_number;
  document.querySelector("#room-description").textContent = state.room.description || state.config.app.tagline;
  document.querySelector("#room-avatar").textContent = initials(state.room.streamer_name);
  if (state.room.avatar_url) {
    document.querySelector("#room-avatar").style.backgroundImage = `url("${CSS.escape(state.room.avatar_url)}")`;
    document.querySelector("#room-avatar").classList.add("has-image");
  }
  const live = state.room.sessions.find((item) => item.status === "live");
  document.querySelector("#room-status").textContent = live ? "当前正在直播" : "直播记录已归档";
  document.querySelector(".status-dot").classList.toggle("offline", !live);
  bindBaseEvents();
  renderSessions();
  if (state.room.sessions.length) await selectSession(state.room.sessions[0].id);
  else renderEmptySessions();
}

async function loadRoomPicker() {
  try {
    const data = await api("/api/rooms");
    if (data.items.length < 2) return;
    const picker = document.querySelector("#room-picker");
    picker.innerHTML = data.items.map((room) => {
      const id = room.alias || room.room_number;
      return `<option value="${escapeHtml(id)}" ${room.id === state.room.id ? "selected" : ""}>${escapeHtml(room.streamer_name)}</option>`;
    }).join("");
    document.querySelector("#room-picker-wrap").hidden = false;
    picker.addEventListener("change", () => { location.href = `/${encodeURIComponent(picker.value)}`; });
  } catch { /* directory can be disabled while the page is open */ }
}

function bindBaseEvents() {
  document.querySelector("#session-prev").addEventListener("click", () => {
    document.querySelector("#session-strip").scrollBy({ left: -340, behavior: "smooth" });
  });
  document.querySelector("#session-next").addEventListener("click", () => {
    document.querySelector("#session-strip").scrollBy({ left: 340, behavior: "smooth" });
  });
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
  });
}

function renderSessions() {
  const strip = document.querySelector("#session-strip");
  strip.innerHTML = state.room.sessions.map((session) => `
    <button type="button" class="session-card" data-session-id="${session.id}">
      <span class="session-card-cover ${session.cover_url ? "has-cover" : ""}" ${session.cover_url ? `style="background-image:url('${escapeHtml(session.cover_url)}')"` : ""}>
        <span>${initials(session.area || state.room.streamer_name)}</span>
        <em class="${session.status === "live" ? "live" : ""}">${session.status === "live" ? "直播中" : dateTime(session.started_at, false)}</em>
      </span>
      <span class="session-card-body">
        <strong>${escapeHtml(session.title)}</strong>
        <span>${escapeHtml(session.parent_area)} · ${escapeHtml(session.area)}</span>
      </span>
    </button>
  `).join("");
  strip.querySelectorAll(".session-card").forEach((card) => {
    card.addEventListener("click", () => selectSession(Number(card.dataset.sessionId)));
  });
}

async function selectSession(sessionId) {
  document.querySelectorAll(".session-card").forEach((card) => {
    card.classList.toggle("active", Number(card.dataset.sessionId) === sessionId);
  });
  state.session = state.room.sessions.find((item) => item.id === sessionId);
  state.danmakuOffset = 0;
  const cache = state.sessionData.get(sessionId);
  try {
    const [summary, gifts] = cache
      ? [cache.summary, cache.gifts]
      : await Promise.all([
          api(`/api/sessions/${sessionId}/summary`),
          api(`/api/sessions/${sessionId}/gifts`),
        ]);
    state.sessionData.set(sessionId, { summary, gifts });
    renderSummary(summary);
    renderGifts(gifts);
    await loadTab(state.activeTab);
  } catch (error) {
    toast(error.message, "error");
  }
}

function renderSummary(session) {
  document.querySelector("#session-state").textContent = session.status === "live" ? "LIVE · 直播中" : "已结束";
  document.querySelector("#session-state").className = session.status === "live" ? "live" : "";
  document.querySelector("#session-area").textContent = [session.parent_area, session.area].filter(Boolean).join(" / ") || "未分类";
  document.querySelector("#session-date").textContent = dateTime(session.started_at);
  document.querySelector("#session-title").textContent = session.title;
  document.querySelector("#session-note").textContent = session.note || `本场直播持续 ${duration(session)}，完整记录已整理在下方。`;
  document.querySelector("#cover-monogram").textContent = initials(session.area || state.room.streamer_name);
  const art = document.querySelector("#cover-art");
  art.style.backgroundImage = session.cover_url ? `url("${CSS.escape(session.cover_url)}")` : "";
  art.classList.toggle("has-image", Boolean(session.cover_url));
  document.querySelector("#stats-grid").innerHTML = [
    ["峰值人气", number(session.peak_popularity), "本场最高热度"],
    ["弹幕记录", number(session.stats.danmaku_count), "条已保存弹幕"],
    ["进房用户", number(session.stats.viewer_count), "位有记录观众"],
    ["打赏价值", money(session.stats.gift_revenue), `${number(session.stats.gift_count)} 件礼物`],
  ].map(([label, value, note]) => `<article class="stat"><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`).join("");
}

function switchTab(name) {
  state.activeTab = name;
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach((panel) => { panel.hidden = panel.id !== `panel-${name}`; });
  loadTab(name);
}

async function loadTab(name) {
  if (!state.session) return;
  if (name === "danmaku") await loadDanmaku();
  if (name === "viewers") await loadViewers();
}

function avatar(user, rank = "") {
  const content = user.avatar_url
    ? `<img src="${escapeHtml(user.avatar_url)}" alt="" loading="lazy">`
    : `<span>${initials(user.username)}</span>`;
  return `<span class="user-avatar ${rank}">${content}</span>`;
}

function renderGifts(data) {
  const panel = document.querySelector("#panel-gifts");
  const podium = data.ranking.slice(0, 3).map((user, index) => `
    <article class="rank-card rank-${index + 1}">
      <span class="rank-number">${index + 1}</span>
      ${avatar(user, `rank-avatar-${index + 1}`)}
      <div><strong>${escapeHtml(user.username)}</strong><span>${number(user.gift_count)} 件礼物</span></div>
      <b>${money(user.total_value)}</b>
    </article>
  `).join("") || `<div class="empty-inline">这场直播还没有礼物记录</div>`;
  const giftList = data.gifts.map((gift) => `
    <div class="gift-row">
      <span class="gift-symbol">${initials(gift.gift_name)}</span>
      <div><strong>${escapeHtml(gift.gift_name)}</strong><span>共 ${number(gift.count)} 件</span></div>
      <b>${money(gift.total_value)}</b>
    </div>
  `).join("");
  panel.innerHTML = `
    <div class="gift-layout">
      <section class="data-section"><div class="data-heading"><div><p class="eyebrow">SUPPORT RANKING</p><h3>本场支持榜</h3></div><span>${data.ranking.length} 位支持者</span></div><div class="ranking-list">${podium}</div></section>
      <section class="data-section"><div class="data-heading"><div><p class="eyebrow">GIFT BREAKDOWN</p><h3>礼物信息</h3></div><span>${data.gifts.length} 种礼物</span></div><div class="gift-list">${giftList || '<div class="empty-inline">暂无记录</div>'}</div></section>
    </div>
  `;
}

async function loadDanmaku(reset = true) {
  if (reset) state.danmakuOffset = 0;
  const panel = document.querySelector("#panel-danmaku");
  const existingQuery = reset ? (panel.querySelector("#danmaku-search")?.value || "") : (document.querySelector("#danmaku-search")?.value || "");
  panel.innerHTML = `<div class="panel-loading">正在读取弹幕…</div>`;
  try {
    const limit = state.config.display.danmaku_page_size;
    const data = await api(`/api/sessions/${state.session.id}/danmaku?q=${encodeURIComponent(existingQuery)}&limit=${limit}&offset=${state.danmakuOffset}`);
    panel.innerHTML = `
      <section class="data-section full">
        <div class="data-heading responsive-heading">
          <div><p class="eyebrow">DANMAKU HISTORY</p><h3>弹幕历史</h3></div>
          <form class="search-form" id="danmaku-form"><input id="danmaku-search" type="search" value="${escapeHtml(existingQuery)}" placeholder="搜索内容、用户名或 UID" aria-label="搜索弹幕"><button type="submit">搜索</button></form>
        </div>
        <div class="result-meta">找到 ${number(data.total)} 条记录 · 第 ${data.total ? state.danmakuOffset + 1 : 0}–${Math.min(data.total, state.danmakuOffset + data.items.length)} 条</div>
        <div class="danmaku-list">${data.items.map((item) => `
          <article class="danmaku-row">
            ${avatar(item)}
            <div class="danmaku-content"><div><strong>${escapeHtml(item.username)}</strong>${item.medal_name ? `<span class="medal">${escapeHtml(item.medal_name)} ${item.medal_level}</span>` : ""}<time>${dateTime(item.sent_at)}</time></div><p>${escapeHtml(item.content)}</p></div>
          </article>
        `).join("") || '<div class="empty-inline">没有符合条件的弹幕</div>'}</div>
        <div class="pagination"><button type="button" id="danmaku-prev" ${state.danmakuOffset === 0 ? "disabled" : ""}>上一页</button><button type="button" id="danmaku-next" ${state.danmakuOffset + data.items.length >= data.total ? "disabled" : ""}>下一页</button></div>
      </section>`;
    panel.querySelector("#danmaku-form").addEventListener("submit", (event) => { event.preventDefault(); loadDanmaku(true); });
    panel.querySelector("#danmaku-prev").addEventListener("click", () => { state.danmakuOffset = Math.max(0, state.danmakuOffset - limit); loadDanmaku(false); });
    panel.querySelector("#danmaku-next").addEventListener("click", () => { state.danmakuOffset += limit; loadDanmaku(false); });
  } catch (error) { panel.innerHTML = `<div class="empty-inline error">${escapeHtml(error.message)}</div>`; }
}

async function loadViewers() {
  const panel = document.querySelector("#panel-viewers");
  const oldMinimum = panel.querySelector("#message-min")?.value ?? state.config.display.default_min_messages;
  const oldQuery = panel.querySelector("#viewer-search")?.value || "";
  panel.innerHTML = `<div class="panel-loading">正在整理观众记录…</div>`;
  try {
    const data = await api(`/api/sessions/${state.session.id}/viewers?min_messages=${encodeURIComponent(oldMinimum)}&q=${encodeURIComponent(oldQuery)}`);
    panel.innerHTML = `
      <section class="data-section full">
        <div class="data-heading responsive-heading">
          <div><p class="eyebrow">AUDIENCE LOG</p><h3>进房与发言用户</h3></div>
          <form class="viewer-filters" id="viewer-form">
            <label>至少发言 <input id="message-min" type="number" min="0" value="${Number(oldMinimum)}"><span>条</span></label>
            <input id="viewer-search" type="search" value="${escapeHtml(oldQuery)}" placeholder="用户名或 UID" aria-label="搜索用户">
            <button type="submit">筛选</button>
          </form>
        </div>
        <div class="result-meta">当前显示 ${number(data.total)} 位用户，按发言数排序</div>
        <div class="viewer-table-wrap"><table class="viewer-table"><thead><tr><th>用户</th><th>UID</th><th>首次进入</th><th>进入次数</th><th>发言条数</th></tr></thead><tbody>
          ${data.items.map((item) => `<tr><td><div class="user-cell">${avatar(item)}<strong>${escapeHtml(item.username)}</strong></div></td><td>${escapeHtml(item.bili_uid)}</td><td>${dateTime(item.first_entered_at)}</td><td>${number(item.entry_count)}</td><td><b>${number(item.message_count)}</b></td></tr>`).join("") || '<tr><td colspan="5" class="empty-cell">没有符合条件的用户</td></tr>'}
        </tbody></table></div>
      </section>`;
    panel.querySelector("#viewer-form").addEventListener("submit", (event) => { event.preventDefault(); loadViewers(); });
  } catch (error) { panel.innerHTML = `<div class="empty-inline error">${escapeHtml(error.message)}</div>`; }
}

function renderEmptySessions() {
  document.querySelector("#session-strip").innerHTML = `<div class="empty-inline">这个房间还没有场次记录</div>`;
  document.querySelector("#selected-session").innerHTML = `<section class="empty-state"><strong>等待第一场直播</strong><p>创建场次后，弹幕、礼物和观众记录会在这里呈现。</p></section>`;
}

function renderError(message) {
  app.innerHTML = `<section class="error-state"><span>404</span><h1>暂时找不到记录</h1><p>${escapeHtml(message)}</p><a href="/">返回首页</a></section>`;
}

function toast(message, type = "") {
  const element = document.createElement("div");
  element.className = `toast ${type}`;
  element.textContent = message;
  document.body.append(element);
  setTimeout(() => element.remove(), 3200);
}

boot();
