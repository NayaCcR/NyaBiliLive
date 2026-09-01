const overviewCollapsed = (() => { try { return localStorage.getItem("nyabililive:overview-collapsed") === "true"; } catch { return false; } })();
const state = { config: null, auth: null, authenticated: false, roomAuthenticated: false, room: null, session: null, activeTab: "gifts", archiveView: "sessions", danmakuOffset: 0, danmakuOrder: "desc", danmakuSuperchat: "all", viewerOffset: 0, viewerSort: "last_entered_at", viewerOrder: "desc", viewerData: null, viewerEditingUid: null, viewerNoteDraft: "", viewerNoteSavingUid: null, durationTimer: null, liveRefreshTimer: null, liveRefreshInFlight: false, liveRefreshGeneration: 0, currentWaitingRefreshTimer: null, currentWaitingRefreshInFlight: false, currentWaitingRefreshGeneration: 0, currentWaitingMode: "danmaku", danmakuRenderedOnce: false, danmakuSignature: "", viewerSignature: "", overviewCollapsed, giftData: null, giftSignature: "", giftMode: "overview", giftUserId: null, giftHistoryOrder: "desc", waitingMode: "gifts", waitingDanmakuOrder: "desc" };
const app = document.querySelector("#app");
const escapeHtml = (value = "") => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
const count = (value) => new Intl.NumberFormat("zh-CN").format(Number(value || 0));
const money = (value) => new Intl.NumberFormat("zh-CN", { style: "currency", currency: state.config?.display?.currency || "CNY", maximumFractionDigits: 2 }).format(Number(value || 0));
const batteries = (value) => `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(Number(value || 0) * 10)} 电池`;
const giftAmount = (value) => `<span class="gift-amount"><small>${batteries(value)}</small><em>${money(value)}</em></span>`;
const initials = (name = "N") => [...String(name).trim()].slice(0, 2).join("").toUpperCase() || "N";
const mediaUrl = (url) => url ? `/api/media?url=${encodeURIComponent(String(url).replace(/^http:\/\/([^/]*\.hdslb\.com)/i, "https://$1"))}` : "";
const formatDate = (value, full = true) => value ? new Intl.DateTimeFormat("zh-CN", full ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false } : { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value)) : "尚未同步";
const formatTimestamp = (value) => value ? new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value)) : "—";
const durationLabel = (start, end = Date.now()) => {
  const seconds = Math.max(0, Math.floor((new Date(end).getTime() - new Date(start).getTime()) / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return `${days ? `${days} 天 ` : ""}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
};

document.addEventListener("error", (event) => {
  if (event.target.matches?.(".user-avatar img")) event.target.remove();
}, true);

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败 (${response.status})`);
  return payload;
}

function identifierFromPath() {
  const value = decodeURIComponent(location.pathname.split("/").filter(Boolean)[0] || "");
  return ["admin", "login"].includes(value) ? "" : value;
}

async function boot() {
  try {
    const [config, auth] = await Promise.all([api("/api/config"), api("/api/auth/me")]);
    state.config = config;
    state.auth = auth;
    state.authenticated = Boolean(auth.authenticated);
    document.title = config.app.site_name;
    const authEntry = document.querySelector("#auth-entry");
    if (auth.authenticated) {
      authEntry.textContent = auth.auth_mode === "admin" ? auth.username : "已认领";
      authEntry.href = auth.auth_mode === "admin" ? "/admin" : "/";
      authEntry.classList.add("signed-in");
    }
    const identifier = identifierFromPath();
    if (identifier) await renderRoom(identifier); else await renderDirectory();
  } catch (error) { renderError(error.message); }
}

async function renderDirectory() {
  const data = await api("/api/rooms");
  app.replaceChildren(document.querySelector("#directory-template").content.cloneNode(true));
  document.querySelector("#directory-note").textContent = state.config.monitoring?.enabled
    ? `每 ${state.config.monitoring.interval_seconds} 秒自动检查直播状态与场次信息。`
    : "直播状态自动检查当前已关闭。";
  document.querySelector("#room-count").textContent = `${data.items.length} 个房间`;
  const grid = document.querySelector("#room-grid");
  if (!data.items.length) { grid.innerHTML = '<div class="empty-state"><strong>还没有直播间</strong><p>管理员添加房间后会显示在这里。</p></div>'; return; }
  data.items.forEach((room) => grid.append(createRoomCard(room)));
}

function createRoomCard(room) {
  const href = `/${encodeURIComponent(room.alias || room.room_number)}`;
  const card = document.createElement("a");
  card.className = "room-card";
  card.href = href;
  const isLive = Number(room.live_status) === 1;
  card.innerHTML = `
    <span class="room-card-media"><span class="media-fallback">${initials(room.streamer_name)}</span><span class="live-badge ${isLive ? "" : "offline"}">${isLive ? "直播中" : "未开播"}</span></span>
    <span class="room-card-content">
      <span class="room-card-profile"><span class="mini-avatar">${initials(room.streamer_name)}</span><span><strong>${escapeHtml(room.streamer_name)}</strong><small>${escapeHtml(room.alias ? `/${room.alias}` : `房间 ${room.room_number}`)}</small></span></span>
      <strong class="room-card-title">${escapeHtml(room.current_title || (isLive ? "直播信息同步中" : "最近没有直播"))}</strong>
      <span class="room-card-facts"><span><small>房间号</small><strong>${escapeHtml(room.room_number)}</strong></span><span><small>关注</small><strong>${count(room.attention)}</strong></span><span><small>${isLive ? "当前人气" : "归档场次"}</small><strong>${count(isLive ? room.online : room.session_count)}</strong></span><span><small>最近直播</small><strong>${room.current_started_at ? formatDate(room.current_started_at, false) : "暂无"}</strong></span></span>
      <span class="room-card-meta"><span>${escapeHtml(room.current_parent_area || "未分类")}${room.current_area ? ` · ${escapeHtml(room.current_area)}` : ""}</span><span>${room.last_sync_at ? `${formatDate(room.last_sync_at)} 更新` : "等待首次同步"}</span></span>
    </span>`;
  const media = card.querySelector(".room-card-media");
  if (room.current_cover) { const image = document.createElement("img"); image.src = mediaUrl(room.current_cover); image.alt = ""; media.prepend(image); media.classList.add("has-image"); }
  const avatar = card.querySelector(".mini-avatar");
  if (room.avatar_url) { avatar.innerHTML = `<img src="${escapeHtml(mediaUrl(room.avatar_url))}" alt="">`; avatar.classList.add("has-image"); }
  return card;
}

async function renderRoom(identifier) {
  stopLiveRefresh();
  stopCurrentWaitingRefresh();
  state.room = await api(`/api/rooms/${encodeURIComponent(identifier)}`);
  state.roomAuthenticated = Boolean(
    state.auth?.auth_mode === "admin"
    || state.auth?.room_claims?.some((item) => Number(item.room_id) === Number(state.room.id)),
  );
  app.replaceChildren(document.querySelector("#room-template").content.cloneNode(true));
  document.querySelector("#session-count").textContent = `${state.room.sessions.length} 个场次`;
  document.querySelector("#open-live-room").href = `https://live.bilibili.com/${encodeURIComponent(state.room.room_number)}`;
  document.querySelector("#claim-live-room").href = `/claim/${encodeURIComponent(state.room.alias || state.room.room_number)}`;
  const claimButton = document.querySelector("#claim-live-room");
  const claimed = state.auth?.room_claims?.some((item) => Number(item.room_id) === Number(state.room.id));
  if (claimed) {
    claimButton.textContent = "已认领";
    claimButton.classList.add("signed-in");
  }
  bindRoomEvents();
  renderSessionStrip();
  const currentWaiting = await loadCurrentWaitingEvents();
  if (!Number(currentWaiting.live_status)) startCurrentWaitingRefresh();
  if (state.room.sessions.length) await selectSession(state.room.sessions[0].id); else renderNoSessions();
  applyArchiveView();
}

function bindRoomEvents() {
  const toggle = document.querySelector("#overview-toggle");
  toggle.addEventListener("click", () => {
    state.overviewCollapsed = !state.overviewCollapsed;
    try { localStorage.setItem("nyabililive:overview-collapsed", String(state.overviewCollapsed)); } catch {}
    applyOverviewState();
  });
  applyOverviewState();
  document.querySelector("#refresh-room").addEventListener("click", refreshRoom);
  document.querySelector("#session-prev").addEventListener("click", () => document.querySelector("#session-strip").scrollBy({ left: -360, behavior: "smooth" }));
  document.querySelector("#session-next").addEventListener("click", () => document.querySelector("#session-strip").scrollBy({ left: 360, behavior: "smooth" }));
  document.querySelectorAll("[data-archive-view]").forEach((button) => button.addEventListener("click", () => {
    state.archiveView = button.dataset.archiveView;
    applyArchiveView();
  }));
  document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => switchTab(tab.dataset.tab)));
}

function applyArchiveView() {
  const showSessions = state.archiveView === "sessions";
  document.querySelectorAll("[data-archive-view]").forEach((button) => button.classList.toggle("active", button.dataset.archiveView === state.archiveView));
  document.querySelector("#session-strip").hidden = !showSessions;
  document.querySelector(".archive-controls").hidden = !showSessions;
  document.querySelector("#selected-session").hidden = !showSessions || !state.room.sessions.length;
  document.querySelector("#current-waiting").hidden = showSessions;
}

async function refreshRoom(event) {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await renderRoom(identifierFromPath());
    toast("场次数据已刷新");
  } catch (error) {
    toast(error.message, "error");
    button.disabled = false;
  }
}

function applyOverviewState() {
  const overview = document.querySelector("#live-overview");
  const toggle = document.querySelector("#overview-toggle");
  if (!overview || !toggle) return;
  overview.classList.toggle("collapsed", state.overviewCollapsed);
  toggle.setAttribute("aria-expanded", String(!state.overviewCollapsed));
  toggle.title = state.overviewCollapsed ? "展开场次概览" : "折叠场次概览";
  toggle.querySelector("span").textContent = state.overviewCollapsed ? "展开概览" : "收起概览";
  toggle.querySelector("b").textContent = state.overviewCollapsed ? "⌄" : "⌃";
}

function renderSessionStrip() {
  const strip = document.querySelector("#session-strip");
  state.room.sessions.forEach((session) => {
    const button = document.createElement("button");
    button.type = "button"; button.className = "session-card"; button.dataset.sessionId = session.id;
    button.innerHTML = `<span class="session-thumb"><span class="media-fallback">${initials(session.area || "LIVE")}</span><em class="${session.status === "live" ? "live" : ""}">${session.status === "live" ? "直播中" : formatDate(session.started_at, false)}</em></span><span class="session-card-copy"><strong>${escapeHtml(session.title)}</strong><small>${escapeHtml([session.parent_area, session.area].filter(Boolean).join(" · ") || "未分类")}</small><span>${formatDate(session.started_at)} · ${durationLabel(session.started_at, session.ended_at || Date.now())}</span></span>`;
    const thumb = button.querySelector(".session-thumb");
    if (session.cover_url) { const image = document.createElement("img"); image.src = mediaUrl(session.cover_url); image.alt = ""; thumb.prepend(image); thumb.classList.add("has-image"); }
    button.addEventListener("click", () => selectSession(session.id));
    strip.append(button);
  });
}

async function selectSession(sessionId) {
  stopLiveRefresh();
  const selectionGeneration = state.liveRefreshGeneration;
  if (state.durationTimer) { clearInterval(state.durationTimer); state.durationTimer = null; }
  state.session = state.room.sessions.find((session) => session.id === sessionId);
  state.danmakuOffset = 0;
  state.viewerOffset = 0;
  state.giftUserId = null;
  state.danmakuRenderedOnce = false;
  state.danmakuSignature = "";
  state.viewerSignature = "";
  state.viewerData = null;
  state.viewerEditingUid = null;
  state.viewerNoteDraft = "";
  state.viewerNoteSavingUid = null;
  document.querySelectorAll(".session-card").forEach((card) => card.classList.toggle("active", Number(card.dataset.sessionId) === sessionId));
  try {
    const [summary, gifts] = await Promise.all([api(`/api/sessions/${sessionId}/summary`), api(`/api/sessions/${sessionId}/gifts`)]);
    if (selectionGeneration !== state.liveRefreshGeneration || state.session?.id !== sessionId) return;
    renderSessionSummary(summary); renderGifts(gifts); await loadActiveTab();
    if (selectionGeneration !== state.liveRefreshGeneration || state.session?.id !== sessionId) return;
    startLiveRefresh(summary);
  } catch (error) { toast(error.message, "error"); }
}

function renderSessionSummary(session) {
  state.session = { ...state.session, ...session };
  if (state.durationTimer) { clearInterval(state.durationTimer); state.durationTimer = null; }
  document.querySelector("#collapsed-session-title").textContent = session.title;
  document.querySelector("#session-state").textContent = session.status === "live" ? "LIVE · 直播中" : "已结束";
  document.querySelector("#session-state").className = session.status === "live" ? "live" : "";
  document.querySelector("#session-area").textContent = [session.parent_area, session.area].filter(Boolean).join(" / ") || "未分类";
  document.querySelector("#session-date").textContent = formatDate(session.started_at);
  document.querySelector("#session-title").textContent = session.title;
  document.querySelector("#session-note").textContent = session.note || "本场直播的互动记录已按时间保存。";
  document.querySelector("#session-start").textContent = formatTimestamp(session.started_at);
  document.querySelector("#session-end").textContent = session.ended_at ? formatTimestamp(session.ended_at) : "直播中";
  const updateDuration = () => { document.querySelector("#session-duration").textContent = durationLabel(session.started_at, session.ended_at || Date.now()); };
  updateDuration();
  if (!session.ended_at && session.status === "live") state.durationTimer = setInterval(updateDuration, 1000);
  const cover = document.querySelector("#cover-art");
  cover.querySelector("img")?.remove();
  if (session.cover_url) { const image = document.createElement("img"); image.src = mediaUrl(session.cover_url); image.alt = ""; cover.prepend(image); }
  cover.classList.toggle("has-image", Boolean(session.cover_url));
  document.querySelector("#stats-grid").innerHTML = [
    ["峰值人气", count(session.peak_popularity)], ["弹幕", count(session.stats.danmaku_count)],
    ["进房用户", count(session.stats.viewer_count)], ["打赏", money(session.stats.gift_revenue)],
  ].map(([label, value]) => `<span class="stat-item"><small>${label}</small><strong>${value}</strong></span>`).join("");
}

function switchTab(name) {
  state.activeTab = name;
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach((panel) => { panel.hidden = panel.id !== `panel-${name}`; });
  loadActiveTab();
}

async function loadActiveTab() {
  if (!state.session) return;
  if (state.activeTab === "danmaku") await loadDanmaku();
  if (state.activeTab === "viewers") await loadViewers();
  if (state.activeTab === "waiting") await loadWaitingEvents();
}

function stopLiveRefresh() {
  if (state.liveRefreshTimer) clearInterval(state.liveRefreshTimer);
  state.liveRefreshTimer = null;
  state.liveRefreshInFlight = false;
  state.liveRefreshGeneration += 1;
}

function startLiveRefresh(session) {
  stopLiveRefresh();
  if (session.status !== "live" || session.ended_at) return;
  const generation = state.liveRefreshGeneration;
  state.liveRefreshTimer = setInterval(() => refreshLiveSession(generation), 3000);
}

async function refreshLiveSession(generation) {
  if (generation !== state.liveRefreshGeneration || document.hidden || state.liveRefreshInFlight || !state.session) return;
  const sessionId = state.session.id;
  state.liveRefreshInFlight = true;
  try {
    const summary = await api(`/api/sessions/${sessionId}/summary`);
    if (generation !== state.liveRefreshGeneration || state.session?.id !== sessionId) return;
    renderSessionSummary(summary);
    if (summary.status !== "live" || summary.ended_at) {
      stopLiveRefresh();
      await renderRoom(identifierFromPath());
      return;
    }
    const panel = document.querySelector(`#panel-${state.activeTab}`);
    if (panel?.contains(document.activeElement)) return;
    if (state.activeTab === "gifts") {
      const gifts = await api(`/api/sessions/${sessionId}/gifts`);
      if (generation !== state.liveRefreshGeneration || state.session?.id !== sessionId) return;
      if (giftDataSignature(gifts) !== state.giftSignature) renderGifts(gifts);
    }
    if (state.activeTab === "danmaku") await loadDanmaku(false, { silent: true, animateNew: true, sessionId });
    if (state.activeTab === "viewers") await loadViewers(false, { silent: true, sessionId });
  } catch {}
  finally { if (generation === state.liveRefreshGeneration) state.liveRefreshInFlight = false; }
}

function userAvatar(user) {
  const uid = String(user.bili_uid || user.uid || "");
  const fallback = `<span class="avatar-fallback">${escapeHtml(initials(user.username))}</span>`;
  const content = user.avatar_url ? `${fallback}<img src="${escapeHtml(mediaUrl(user.avatar_url))}" alt="">` : fallback;
  if (/^[1-9]\d*$/.test(uid)) {
    return `<a class="user-avatar" href="https://space.bilibili.com/${encodeURIComponent(uid)}" target="_blank" rel="noopener" title="前往 ${escapeHtml(user.username)} 的个人空间">${content}</a>`;
  }
  return `<span class="user-avatar">${content}</span>`;
}

function viewerNoteMarkup(item) {
  if (!state.roomAuthenticated) return "";
  const uid = String(item.bili_uid);
  const note = String(item.room_note || "");
  const editing = state.viewerEditingUid === uid;
  if (editing) {
    return `<span class="viewer-note-editor"><input type="text" data-note-input="${escapeHtml(uid)}" value="${escapeHtml(state.viewerNoteDraft)}" maxlength="120" placeholder="输入备注后回车" aria-label="编辑用户备注"${state.viewerNoteSavingUid === uid ? " disabled" : ""}></span>`;
  }
  if (note) {
    return `<button type="button" class="viewer-note viewer-note-text" data-note-edit="${escapeHtml(uid)}" title="点击修改备注">${escapeHtml(note)}</button>`;
  }
  return `<button type="button" class="viewer-note viewer-note-action" data-note-edit="${escapeHtml(uid)}" aria-label="添加用户备注">备注</button>`;
}

function noteBadge(user) {
  if (!state.roomAuthenticated || !user?.room_note) return "";
  return `<span class="room-note-badge" title="${escapeHtml(user.room_note)}">${escapeHtml(user.room_note)}</span>`;
}

function usernameWithNote(user, { medal = "", extraClass = "" } = {}) {
  const className = ["username-line", extraClass].filter(Boolean).join(" ");
  return `<span class="${className}"><strong>${escapeHtml(user.username)}</strong>${medal}${noteBadge(user)}</span>`;
}

function viewerDataSignature(data) {
  return `${data.total}:${data.items.map((item) => `${item.bili_uid}:${item.last_entered_at}:${item.entry_count}:${item.message_count}:${item.room_note || ""}`).join(",")}`;
}

async function saveViewerNote(uid, note) {
  if (!state.roomAuthenticated || !state.room) return;
  state.viewerNoteSavingUid = uid;
  try {
    await api(`/api/rooms/${state.room.id}/viewer-notes/${encodeURIComponent(uid)}`, {
      method: "PUT",
      body: JSON.stringify({ note }),
    });
    state.viewerEditingUid = null;
    state.viewerNoteDraft = "";
    state.viewerSignature = "";
    await loadViewers(false, { sessionId: state.session?.id });
    toast(note.trim() ? "备注已保存" : "备注已清除");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    state.viewerNoteSavingUid = null;
  }
}

function renderGifts(data) {
  state.giftData = data;
  state.giftSignature = giftDataSignature(data);
  if (!state.giftUserId || !data.ranking.some((user) => String(user.bili_uid) === state.giftUserId)) {
    state.giftUserId = data.ranking.length ? String(data.ranking[0].bili_uid) : null;
  }
  renderGiftPanel();
}

function giftDataSignature(data) {
  const latest = data.history?.[0];
  return `${data.history_total ?? data.history?.length ?? 0}:${latest?.id ?? ""}:${latest?.received_at ?? ""}`;
}

function giftHistoryRows(items, emptyText = "暂无礼物流水") {
  return items.map((gift) => `<article class="gift-history-row">${userAvatar(gift)}<span>${usernameWithNote(gift)}<small>${escapeHtml(gift.gift_name)} × ${count(gift.count)}</small></span>${giftAmount(gift.total_value)}<time>${formatTimestamp(gift.received_at)}</time></article>`).join("") || `<div class="empty-inline">${escapeHtml(emptyText)}</div>`;
}

function orderedByTimestamp(items, timestampKey, order = "desc") {
  const direction = order === "asc" ? 1 : -1;
  return [...items].sort((left, right) => {
    const timeComparison = String(left[timestampKey]).localeCompare(String(right[timestampKey]));
    return timeComparison === 0 ? (Number(left.id) - Number(right.id)) * direction : timeComparison * direction;
  });
}

function orderedGiftHistory(items) {
  return orderedByTimestamp(items, "received_at", state.giftHistoryOrder);
}

function timeOrderControl(attribute, order, ariaLabel) {
  return `<nav class="segmented-control" aria-label="${escapeHtml(ariaLabel)}"><button type="button" ${attribute}="desc" class="${order === "desc" ? "active" : ""}">最新优先</button><button type="button" ${attribute}="asc" class="${order === "asc" ? "active" : ""}">最早优先</button></nav>`;
}

function giftHistoryOrderControl() {
  return timeOrderControl("data-gift-order", state.giftHistoryOrder, "礼物送出时间排序");
}

function waitingDanmakuOrderControl() {
  return timeOrderControl("data-waiting-danmaku-order", state.waitingDanmakuOrder, "候场弹幕发送时间排序");
}

function giftOverview(data) {
  return `<div class="two-column-data"><section><header class="data-title"><div><p class="kicker">SUPPORT RANKING</p><h3>本场支持榜</h3></div><span>${data.ranking.length} 位</span></header><div class="ranking-list">${data.ranking.map((user, index) => `<article class="ranking-row"><b>${index + 1}</b>${userAvatar(user)}<span>${usernameWithNote(user)}<small>${count(user.gift_count)} 件礼物 · ${count(user.send_count)} 次送出</small><small class="gift-time-range"><time>首次 ${formatTimestamp(user.first_gift_at)}</time><time>最近 ${formatTimestamp(user.last_gift_at)}</time></small></span>${giftAmount(user.total_value)}</article>`).join("") || '<div class="empty-inline">暂无打赏记录</div>'}</div></section><section><header class="data-title"><div><p class="kicker">GIFT BREAKDOWN</p><h3>礼物信息</h3></div><span>${data.gifts.length} 种</span></header><div class="gift-list">${data.gifts.map((gift) => `<article class="gift-row"><span class="gift-icon">${initials(gift.gift_name)}</span><span><strong>${escapeHtml(gift.gift_name)}</strong><small>${count(gift.count)} 件</small><small class="gift-time-range"><time>首次 ${formatTimestamp(gift.first_gift_at)}</time><time>最近 ${formatTimestamp(gift.last_gift_at)}</time></small></span>${giftAmount(gift.total_value)}</article>`).join("") || '<div class="empty-inline">暂无礼物记录</div>'}</div></section></div>`;
}

function giftHistoryOverview(data) {
  return `<section class="gift-history-section gift-history-page"><header class="data-title responsive"><div><p class="kicker">ALL GIFT RECORDS</p><h3>礼物总览</h3></div><span>${count(data.history_total ?? data.history.length)} 条</span></header><div class="list-toolbar gift-history-toolbar"><p class="result-note">按送礼时间排列</p>${giftHistoryOrderControl()}</div><div class="gift-history-list">${giftHistoryRows(orderedGiftHistory(data.history))}</div></section>`;
}

function giftPersonal(data) {
  const user = data.ranking.find((item) => String(item.bili_uid) === state.giftUserId);
  if (!user) return '<div class="empty-inline">暂无个人送礼记录</div>';
  const history = orderedGiftHistory(data.history.filter((item) => String(item.bili_uid) === state.giftUserId));
  return `<section class="personal-gift-summary"><header>${userAvatar(user)}<span>${usernameWithNote(user)}<small>UID ${escapeHtml(user.bili_uid)}</small><small class="personal-gift-times"><time>首次送礼 ${formatTimestamp(user.first_gift_at)}</time><time>最近送礼 ${formatTimestamp(user.last_gift_at)}</time></small></span></header><div><span><small>累计礼物</small><strong>${count(user.gift_count)} 件</strong></span><span><small>原始单位</small><strong>${batteries(user.total_value)}</strong></span><span><small>折算金额</small><strong>${money(user.total_value)}</strong></span><span><small>流水记录</small><strong>${count(history.length)} 条</strong></span></div></section><section class="gift-history-section"><header class="data-title"><div><p class="kicker">PERSONAL GIFT HISTORY</p><h3>个人送礼记录</h3></div><span>${history.length} 条</span></header><div class="list-toolbar gift-history-toolbar"><p class="result-note">按送礼时间排列</p>${giftHistoryOrderControl()}</div><div class="gift-history-list">${giftHistoryRows(history)}</div></section>`;
}

function renderGiftPanel() {
  const panel = document.querySelector("#panel-gifts");
  const data = state.giftData;
  if (!panel || !data) return;
  const userSelect = state.giftMode === "personal" && data.ranking.length
    ? `<label class="gift-user-select"><span>用户</span><select id="gift-user-select">${data.ranking.map((user) => `<option value="${escapeHtml(user.bili_uid)}" ${String(user.bili_uid) === state.giftUserId ? "selected" : ""}>${escapeHtml(user.username)}${user.room_note ? ` · ${escapeHtml(user.room_note)}` : ""} · ${escapeHtml(user.bili_uid)}</option>`).join("")}</select></label>`
    : "";
  const giftViews = { overview: giftOverview, history: giftHistoryOverview, personal: giftPersonal };
  const renderView = giftViews[state.giftMode] || giftOverview;
  panel.innerHTML = `<header class="gift-view-toolbar"><nav class="segmented-control" aria-label="礼物记录视图"><button type="button" data-gift-mode="overview" class="${state.giftMode === "overview" ? "active" : ""}">总览</button><button type="button" data-gift-mode="history" class="${state.giftMode === "history" ? "active" : ""}">礼物总览</button><button type="button" data-gift-mode="personal" class="${state.giftMode === "personal" ? "active" : ""}">个人送礼</button></nav>${userSelect}</header><div id="gift-view-content">${renderView(data)}</div>`;
  panel.querySelectorAll("[data-gift-mode]").forEach((button) => button.addEventListener("click", () => {
    state.giftMode = button.dataset.giftMode; renderGiftPanel();
  }));
  panel.querySelectorAll("[data-gift-order]").forEach((button) => button.addEventListener("click", () => {
    state.giftHistoryOrder = button.dataset.giftOrder; renderGiftPanel();
  }));
  panel.querySelector("#gift-user-select")?.addEventListener("change", (event) => {
    state.giftUserId = event.currentTarget.value; renderGiftPanel();
  });
}

async function loadDanmaku(reset = true, { silent = false, animateNew = false, sessionId = state.session?.id } = {}) {
  if (reset) state.danmakuOffset = 0;
  const panel = document.querySelector("#panel-danmaku");
  const query = panel.querySelector("#danmaku-search")?.value || "";
  const previousIds = new Set([...panel.querySelectorAll("[data-danmaku-id]")].map((row) => row.dataset.danmakuId));
  if (!silent) panel.innerHTML = '<div class="panel-loading">读取弹幕记录…</div>';
  try {
    const limit = state.config.display.danmaku_page_size;
    const data = await api(`/api/sessions/${sessionId}/danmaku?q=${encodeURIComponent(query)}&limit=${limit}&offset=${state.danmakuOffset}&order=${state.danmakuOrder}&superchat=${state.danmakuSuperchat}`);
    if (state.session?.id !== sessionId) return;
    const signature = `${data.total}:${data.items.map((item) => item.id).join(",")}`;
    if (silent && signature === state.danmakuSignature) return;
    const rows = data.items.map((item) => {
      const arriving = animateNew && state.danmakuRenderedOnce && !previousIds.has(String(item.id));
      return `<article class="danmaku-row${item.is_superchat ? " superchat" : ""}${arriving ? " live-arrival" : ""}" data-danmaku-id="${item.id}">${userAvatar(item)}<div><header>${usernameWithNote(item, { medal: item.medal_name ? `<span class="medal">${escapeHtml(item.medal_name)} ${item.medal_level}</span>` : "" })}<time>${formatTimestamp(item.sent_at)}</time></header><p>${escapeHtml(item.content)}</p>${item.is_superchat ? `<span class="superchat-batteries">${batteries(item.superchat_price)}</span>` : ""}</div></article>`;
    }).join("") || '<div class="empty-inline">没有符合条件的弹幕</div>';
    panel.innerHTML = `<header class="data-title responsive"><div><p class="kicker">DANMAKU HISTORY</p><h3>弹幕历史</h3></div><form class="search-form" id="danmaku-form"><input id="danmaku-search" type="search" value="${escapeHtml(query)}" placeholder="搜索弹幕、用户或 UID"><button>搜索</button></form></header><div class="list-toolbar"><p class="result-note">${count(data.total)} 条记录</p><div class="sort-controls"><nav class="segmented-control sc-filter-control" aria-label="醒目留言筛选"><button type="button" data-danmaku-superchat="all" class="${state.danmakuSuperchat === "all" ? "active" : ""}">全部</button><button type="button" data-danmaku-superchat="only" class="${state.danmakuSuperchat === "only" ? "active" : ""}">只显示 SC</button><button type="button" data-danmaku-superchat="exclude" class="${state.danmakuSuperchat === "exclude" ? "active" : ""}">过滤 SC</button></nav>${timeOrderControl("data-danmaku-order", state.danmakuOrder, "弹幕发送时间排序")}</div></div><div class="danmaku-list">${rows}</div><div class="pagination"><button id="danmaku-prev" ${state.danmakuOffset === 0 ? "disabled" : ""}>上一页</button><button id="danmaku-next" ${state.danmakuOffset + data.items.length >= data.total ? "disabled" : ""}>下一页</button></div>`;
    state.danmakuRenderedOnce = true;
    state.danmakuSignature = signature;
    panel.querySelector("#danmaku-form").addEventListener("submit", (event) => { event.preventDefault(); loadDanmaku(true); });
    panel.querySelectorAll("[data-danmaku-order]").forEach((button) => button.addEventListener("click", () => { state.danmakuOrder = button.dataset.danmakuOrder; loadDanmaku(true); }));
    panel.querySelectorAll("[data-danmaku-superchat]").forEach((button) => button.addEventListener("click", () => { state.danmakuSuperchat = button.dataset.danmakuSuperchat; loadDanmaku(true); }));
    panel.querySelector("#danmaku-prev").addEventListener("click", () => { state.danmakuOffset = Math.max(0, state.danmakuOffset - limit); loadDanmaku(false); });
    panel.querySelector("#danmaku-next").addEventListener("click", () => { state.danmakuOffset += limit; loadDanmaku(false); });
  } catch (error) { panel.innerHTML = `<div class="empty-inline error">${escapeHtml(error.message)}</div>`; }
}

async function loadViewers(reset = false, { silent = false, sessionId = state.session?.id } = {}) {
  if (reset) state.viewerOffset = 0;
  const panel = document.querySelector("#panel-viewers");
  const minimum = panel.querySelector("#message-min")?.value ?? state.config.display.default_min_messages;
  const query = panel.querySelector("#viewer-search")?.value || "";
  if (!silent) panel.innerHTML = '<div class="panel-loading">整理观众记录…</div>';
  try {
    const limit = 100;
    const data = await api(`/api/sessions/${sessionId}/viewers?min_messages=${encodeURIComponent(minimum)}&q=${encodeURIComponent(query)}&limit=${limit}&offset=${state.viewerOffset}&sort=${state.viewerSort}&order=${state.viewerOrder}`);
    if (state.session?.id !== sessionId) return;
    state.viewerData = data;
    const signature = viewerDataSignature(data);
    if (silent && signature === state.viewerSignature) return;
    panel.innerHTML = `<header class="data-title responsive"><div><p class="kicker">AUDIENCE LOG</p><h3>进房与发言用户</h3>${state.roomAuthenticated ? '<p class="viewer-note-help">可在用户名上方点击添加[备注]</p>' : ""}</div><form class="viewer-filters" id="viewer-form"><label>至少发言 <input id="message-min" type="number" min="0" value="${Number(minimum)}"> 条</label><input id="viewer-search" type="search" value="${escapeHtml(query)}" placeholder="用户名或 UID"><button>筛选</button></form></header><div class="list-toolbar"><p class="result-note">显示 ${count(data.total)} 位用户</p><div class="sort-controls"><label class="sort-select">排序依据 <select id="viewer-sort"><option value="last_entered_at" ${state.viewerSort === "last_entered_at" ? "selected" : ""}>最近进入时间</option><option value="first_entered_at" ${state.viewerSort === "first_entered_at" ? "selected" : ""}>首次进入时间</option></select></label><nav class="segmented-control" aria-label="进房用户排序方向"><button type="button" data-viewer-order="desc" class="${state.viewerOrder === "desc" ? "active" : ""}">倒序</button><button type="button" data-viewer-order="asc" class="${state.viewerOrder === "asc" ? "active" : ""}">正序</button></nav></div></div><div class="table-wrap"><table><thead><tr><th>用户</th><th class="viewer-uid-column">UID</th><th>首次进入</th><th>最近进入</th><th>进入</th><th>发言</th></tr></thead><tbody>${data.items.map((item) => `<tr class="viewer-table-row"><td><span class="user-cell">${userAvatar(item)}<span class="viewer-name-stack">${viewerNoteMarkup(item)}<strong>${escapeHtml(item.username)}</strong></span></span></td><td class="viewer-uid-column"><span class="viewer-uid-value">${escapeHtml(item.bili_uid)}</span></td><td>${formatTimestamp(item.first_entered_at)}</td><td>${formatTimestamp(item.last_entered_at)}</td><td>${count(item.entry_count)}</td><td><strong>${count(item.message_count)}</strong></td></tr>`).join("") || '<tr><td colspan="6" class="empty-cell">没有符合条件的用户</td></tr>'}</tbody></table></div><div class="pagination"><button id="viewer-prev" ${state.viewerOffset === 0 ? "disabled" : ""}>上一页</button><button id="viewer-next" ${state.viewerOffset + data.items.length >= data.total ? "disabled" : ""}>下一页</button></div>`;
    panel.querySelector("#viewer-form").addEventListener("submit", (event) => { event.preventDefault(); loadViewers(true); });
    panel.querySelector("#viewer-sort").addEventListener("change", (event) => { state.viewerSort = event.currentTarget.value; loadViewers(true); });
    panel.querySelectorAll("[data-viewer-order]").forEach((button) => button.addEventListener("click", () => { state.viewerOrder = button.dataset.viewerOrder; loadViewers(true); }));
    panel.querySelector("#viewer-prev").addEventListener("click", () => { state.viewerOffset = Math.max(0, state.viewerOffset - limit); loadViewers(false); });
    panel.querySelector("#viewer-next").addEventListener("click", () => { state.viewerOffset += limit; loadViewers(false); });
    panel.querySelectorAll("[data-note-edit]").forEach((button) => button.addEventListener("click", () => {
      const uid = button.dataset.noteEdit;
      const item = data.items.find((entry) => String(entry.bili_uid) === uid);
      state.viewerEditingUid = uid;
      state.viewerNoteDraft = String(item?.room_note || "");
      state.viewerSignature = "";
      loadViewers(false, { sessionId });
    }));
    panel.querySelectorAll("[data-note-input]").forEach((input) => {
      input.addEventListener("keydown", async (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          await saveViewerNote(event.currentTarget.dataset.noteInput, event.currentTarget.value);
        }
        if (event.key === "Escape") {
          state.viewerEditingUid = null;
          state.viewerNoteDraft = "";
          state.viewerSignature = "";
          loadViewers(false, { sessionId });
        }
      });
      input.addEventListener("blur", () => {
        if (state.viewerNoteSavingUid === input.dataset.noteInput) return;
        state.viewerEditingUid = null;
        state.viewerNoteDraft = "";
        state.viewerSignature = "";
        loadViewers(false, { sessionId });
      });
      input.focus();
      input.select();
    });
    state.viewerSignature = signature;
  } catch (error) { panel.innerHTML = `<div class="empty-inline error">${escapeHtml(error.message)}</div>`; }
}

function waitingDanmakuRows(items, emptyText = "本场直播前没有捕获到候场弹幕") {
  return orderedByTimestamp(items, "sent_at", state.waitingDanmakuOrder).map((item) => `<article class="danmaku-row${item.is_superchat ? " superchat" : ""}">${userAvatar(item)}<div><header>${usernameWithNote(item, { medal: item.medal_name ? `<span class="medal">${escapeHtml(item.medal_name)} ${item.medal_level}</span>` : "" })}<time>${formatTimestamp(item.sent_at)}</time></header><p>${escapeHtml(item.content)}</p>${item.is_superchat ? `<span class="superchat-batteries">${batteries(item.superchat_price)}</span>` : ""}</div></article>`).join("") || `<div class="empty-inline">${escapeHtml(emptyText)}</div>`;
}

function waitingViewerRows(items, emptyText = "本场直播前没有捕获到候场用户") {
  return items.map((item) => `<tr><td><span class="user-cell">${userAvatar(item)}<span class="viewer-name-stack">${noteBadge(item)}<strong>${escapeHtml(item.username)}</strong></span></span></td><td class="viewer-uid-column"><span class="viewer-uid-value">${escapeHtml(item.bili_uid)}</span></td><td>${formatTimestamp(item.first_entered_at)}</td><td>${formatTimestamp(item.last_entered_at)}</td><td>${count(item.entry_count)}</td><td><strong>${count(item.message_count)}</strong></td><td>${count(item.event_count)}</td></tr>`).join("") || `<tr><td colspan="7" class="empty-cell">${escapeHtml(emptyText)}</td></tr>`;
}

function stopCurrentWaitingRefresh() {
  if (state.currentWaitingRefreshTimer) clearInterval(state.currentWaitingRefreshTimer);
  state.currentWaitingRefreshTimer = null;
  state.currentWaitingRefreshInFlight = false;
  state.currentWaitingRefreshGeneration += 1;
}

function startCurrentWaitingRefresh() {
  stopCurrentWaitingRefresh();
  const generation = state.currentWaitingRefreshGeneration;
  state.currentWaitingRefreshTimer = setInterval(() => refreshCurrentWaitingEvents(generation), 5000);
}

async function refreshCurrentWaitingEvents(generation) {
  if (generation !== state.currentWaitingRefreshGeneration || document.hidden || state.currentWaitingRefreshInFlight || !state.room) return;
  state.currentWaitingRefreshInFlight = true;
  try {
    const data = await loadCurrentWaitingEvents({ silent: true });
    if (generation !== state.currentWaitingRefreshGeneration) return;
    if (Number(data.live_status)) {
      stopCurrentWaitingRefresh();
      await renderRoom(identifierFromPath());
    }
  } catch {}
  finally { if (generation === state.currentWaitingRefreshGeneration) state.currentWaitingRefreshInFlight = false; }
}

function renderCurrentWaitingEvents(data) {
  const section = document.querySelector("#current-waiting");
  if (!section) return;
  const isLive = Number(data.live_status) === 1;
  const monitored = Number(data.waiting_monitor_enabled) === 1;
  const automaticTotal = data.counts.gift_count + data.counts.danmaku_count + data.counts.entry_count;
  const views = {
    gifts: `<section><header class="data-title"><div><p class="kicker">WAITING GIFTS</p><h3>候场礼物</h3></div><span>${count(data.counts.gift_count)} 条</span></header><div class="gift-history-list">${giftHistoryRows(data.gifts, "下一场还没有捕获到候场礼物")}</div></section>`,
    danmaku: `<section><header class="data-title"><div><p class="kicker">WAITING DANMAKU</p><h3>候场弹幕</h3></div><span>${count(data.counts.danmaku_count)} 条</span></header><div class="list-toolbar"><p class="result-note">按发送时间排列</p>${waitingDanmakuOrderControl()}</div><div class="danmaku-list">${waitingDanmakuRows(data.danmaku, "下一场还没有捕获到候场弹幕")}</div></section>`,
    viewers: `<section><header class="data-title"><div><p class="kicker">WAITING AUDIENCE</p><h3>候场进房用户</h3></div><span>${count(data.counts.user_count)} 位</span></header><div class="table-wrap"><table><thead><tr><th>用户</th><th class="viewer-uid-column">UID</th><th>首次出现</th><th>最近出现</th><th>进入</th><th>发言</th><th>事件</th></tr></thead><tbody>${waitingViewerRows(data.viewers, "下一场还没有捕获到候场用户")}</tbody></table></div></section>`,
  };
  const statusText = isLive ? "本场已开播" : monitored ? "候场监控中" : "候场监控已关闭";
  const statusClass = isLive ? "archived" : monitored ? "monitoring" : "paused";
  const summaryText = isLive ? "开播前的候场事件已归档到当前场次" : monitored ? "页面每 5 秒同步一次当前候场记录" : "已有记录仍会在下次开播时归档";
  section.innerHTML = `<header class="current-waiting-heading"><div><p class="kicker">NEXT SESSION · WAITING ROOM</p><h2>下一场候场</h2><p>这些是尚未归入任何场次的临时记录；检测到开播后，会整体归档到新场次的“候场归档”。</p></div><span class="current-waiting-state ${statusClass}">${statusText}</span></header><div class="current-waiting-summary"><strong>${count(automaticTotal)}</strong><span>条待归档事件</span><small>${summaryText}</small></div><nav class="segmented-control waiting-event-tabs" aria-label="当前候场事件类型"><button type="button" data-current-waiting-mode="gifts" class="${state.currentWaitingMode === "gifts" ? "active" : ""}">礼物 ${count(data.counts.gift_count)}</button><button type="button" data-current-waiting-mode="danmaku" class="${state.currentWaitingMode === "danmaku" ? "active" : ""}">弹幕 ${count(data.counts.danmaku_count)}</button><button type="button" data-current-waiting-mode="viewers" class="${state.currentWaitingMode === "viewers" ? "active" : ""}">进房用户 ${count(data.counts.user_count)}</button></nav><div class="current-waiting-view">${views[state.currentWaitingMode] || views.danmaku}</div>`;
  section.querySelectorAll("[data-current-waiting-mode]").forEach((button) => button.addEventListener("click", () => {
    state.currentWaitingMode = button.dataset.currentWaitingMode;
    renderCurrentWaitingEvents(data);
  }));
  section.querySelectorAll("[data-waiting-danmaku-order]").forEach((button) => button.addEventListener("click", () => {
    state.waitingDanmakuOrder = button.dataset.waitingDanmakuOrder;
    renderCurrentWaitingEvents(data);
  }));
}

async function loadCurrentWaitingEvents({ silent = false } = {}) {
  const section = document.querySelector("#current-waiting");
  if (!silent && section) {
    section.innerHTML = '<div class="panel-loading">读取下一场候场记录…</div>';
  }
  try {
    const roomId = state.room.id;
    const identifier = state.room.alias || state.room.room_number;
    const data = await api(`/api/rooms/${encodeURIComponent(identifier)}/waiting-events`);
    if (Number(state.room?.id) !== Number(roomId)) return data;
    renderCurrentWaitingEvents(data);
    return data;
  } catch (error) {
    if (!silent && section) section.innerHTML = `<div class="empty-inline error">${escapeHtml(error.message)}</div>`;
    throw error;
  }
}

function decodeXmlEntities(value) {
  const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return String(value || "").replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const hexadecimal = entity[1]?.toLowerCase() === "x";
      const code = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return entities[entity.toLowerCase()] || match;
  });
}

function parseRecorderXml(text) {
  const source = String(text || "");
  if (!/<BililiveRecorderRecordInfo\b/i.test(source) && !/<d\b/i.test(source)) throw new Error("XML 中没有找到录播姬弹幕记录");
  const startMatch = source.match(/<BililiveRecorderRecordInfo\b[^>]*\bstart_time="([^"]+)"/i);
  const recordingStart = startMatch ? Date.parse(decodeXmlEntities(startMatch[1])) : NaN;
  const events = [];
  const matcher = /<d\b([^>]*)>([\s\S]*?)<\/d>/gi;
  let match;
  while ((match = matcher.exec(source))) {
    const attributes = match[1];
    const p = attributes.match(/\bp="([^"]*)"/i)?.[1]?.split(",") || [];
    const offsetSeconds = Number(p[0]);
    const rawTimestamp = Number(p[4]);
    const timestamp = Number.isFinite(rawTimestamp) && rawTimestamp > 0
      ? (rawTimestamp < 1_000_000_000_000 ? rawTimestamp * 1000 : rawTimestamp)
      : (Number.isFinite(recordingStart) && Number.isFinite(offsetSeconds) ? recordingStart + offsetSeconds * 1000 : NaN);
    const occurredAt = Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
    const content = decodeXmlEntities(match[2]).trim();
    if (!occurredAt || !content) continue;
    events.push({
      username: decodeXmlEntities(attributes.match(/\buser="([^"]*)"/i)?.[1] || "").trim(),
      content,
      occurred_at: occurredAt,
      offset_seconds: Number.isFinite(offsetSeconds) && offsetSeconds >= 0 ? offsetSeconds : null,
    });
    if (events.length > 20_000) throw new Error("XML 弹幕超过 20000 条，请裁剪到需要补录的时间段后重试");
  }
  if (!events.length) throw new Error("XML 中没有可用于匹配的普通弹幕");
  return events;
}

function supplementRows(items) {
  return items.map((item) => `<article class="danmaku-row supplement-row">${userAvatar(item)}<span class="supplement-sequence">#${String(item.sequence_no).padStart(4, "0")}</span><div><header>${usernameWithNote(item)}${item.bili_uid ? `<span class="supplement-uid">UID ${escapeHtml(item.bili_uid)}</span>` : ""}<time>${item.occurred_at ? formatTimestamp(item.occurred_at) : "仅保留顺序"}</time></header><p>${escapeHtml(item.content)}</p><small class="supplement-source">${item.source_kind === "ocr+xml" ? `OCR + XML 时间匹配${item.xml_username ? ` · XML 昵称 ${escapeHtml(item.xml_username)}` : ""}` : "仅 OCR · 无推测时间戳"}</small></div></article>`).join("") || '<div class="empty-inline">还没有手动补充记录</div>';
}

function supplementImporter() {
  if (!state.roomAuthenticated) return "";
  return `<form class="supplement-importer" id="supplement-import-form"><header><div><p class="kicker">MANUAL RECOVERY</p><h4>OCR / XML 补录</h4></div><span>管理者可用</span></header><div class="supplement-input-grid"><label><strong>1. OCR 截图</strong><input id="supplement-images" type="file" accept="image/png,image/jpeg,image/webp,image/bmp" multiple><small>可选择多张，按选择顺序识别；图片不会发送给第三方 OCR 服务。</small></label><button class="secondary-button" id="supplement-run-ocr" type="button">开始 OCR</button><label class="full"><strong>2. 检查识别文本</strong><textarea id="supplement-ocr-text" rows="9" placeholder="每条一行，例如：柳雪杨Naya：来了！"></textarea><small>可以直接粘贴或修改。只有“昵称：内容”格式会保存；没有 XML 时不会生成时间戳。</small></label><label class="full"><strong>3. 录播姬 XML（可选）</strong><input id="supplement-xml" type="file" accept=".xml,text/xml,application/xml"><small>仅用于按内容和遮罩昵称匹配真实时间，不会导入未匹配的 XML 记录。</small></label></div><footer><span id="supplement-progress">等待选择截图</span><button class="primary-button" type="submit">保存补充记录</button></footer></form>`;
}

function supplementView(data) {
  const batches = data.batches.map((batch) => `<span class="supplement-batch"><b>#${batch.first_sequence_no}–#${batch.last_sequence_no}</b>${count(batch.item_count)} 条 · ${count(batch.matched_time_count)} 条匹配时间${state.roomAuthenticated ? `<button type="button" data-delete-supplement-batch="${escapeHtml(batch.batch_id)}">删除批次</button>` : ""}</span>`).join("");
  return `${supplementImporter()}<section class="supplement-records"><header class="data-title"><div><p class="kicker">RECOVERED RECORDS</p><h3>补充记录</h3></div><span>${count(data.total)} 条</span></header>${batches ? `<div class="supplement-batches">${batches}</div>` : ""}<div class="danmaku-list">${supplementRows(data.items)}</div></section>`;
}

async function recognizeSupplementImages(panel) {
  const files = [...panel.querySelector("#supplement-images").files];
  if (!files.length) throw new Error("请先选择至少一张截图");
  const button = panel.querySelector("#supplement-run-ocr");
  const progress = panel.querySelector("#supplement-progress");
  const output = panel.querySelector("#supplement-ocr-text");
  button.disabled = true;
  try {
    const recognized = [];
    for (const [index, file] of files.entries()) {
      progress.textContent = `正在识别第 ${index + 1}/${files.length} 张…首次使用需下载中文模型`;
      const result = await api(`/api/rooms/${state.room.id}/ocr`, {
        method: "POST",
        headers: { "Content-Type": file.type || "image/png" },
        body: file,
      });
      recognized.push(result.text);
    }
    output.value = [output.value.trim(), recognized.join("\n")].filter(Boolean).join("\n");
    progress.textContent = `OCR 完成，共 ${files.length} 张；请检查文本后保存`;
  } finally {
    button.disabled = false;
  }
}

function bindSupplementView(panel) {
  const form = panel.querySelector("#supplement-import-form");
  panel.querySelectorAll("[data-delete-supplement-batch]").forEach((button) => button.addEventListener("click", async () => {
    if (!confirm("确定删除这一批补充记录吗？内部序号不会自动重排。")) return;
    try {
      await api(`/api/rooms/${state.room.id}/sessions/${state.session.id}/supplement-events/${encodeURIComponent(button.dataset.deleteSupplementBatch)}`, { method: "DELETE" });
      await loadWaitingEvents();
      toast("补录批次已删除");
    } catch (error) { toast(error.message, "error"); }
  }));
  if (!form) return;
  form.querySelector("#supplement-run-ocr").addEventListener("click", async () => {
    try { await recognizeSupplementImages(panel); }
    catch (error) { form.querySelector("#supplement-progress").textContent = error.message; toast(error.message, "error"); }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button[type=submit]");
    const progress = form.querySelector("#supplement-progress");
    button.disabled = true;
    try {
      const xmlFile = form.querySelector("#supplement-xml").files[0];
      progress.textContent = xmlFile ? "正在解析 XML 并匹配时间…" : "正在按 OCR 顺序保存…";
      const xmlEvents = xmlFile ? parseRecorderXml(await xmlFile.text()) : [];
      const result = await api(`/api/rooms/${state.room.id}/sessions/${state.session.id}/supplement-events`, {
        method: "POST",
        body: JSON.stringify({ ocr_text: form.querySelector("#supplement-ocr-text").value, xml_events: xmlEvents }),
      });
      toast(`已补充 ${result.imported_count} 条，${result.matched_time_count} 条匹配到 XML 时间`);
      await loadWaitingEvents();
    } catch (error) {
      progress.textContent = error.message;
      toast(error.message, "error");
      button.disabled = false;
    }
  });
}

function renderWaitingEvents(data, supplements) {
  const panel = document.querySelector("#panel-waiting");
  if (!panel) return;
  const views = {
    gifts: `<section><header class="data-title"><div><p class="kicker">WAITING GIFTS</p><h3>候场礼物</h3></div><span>${count(data.counts.gift_count)} 条</span></header><div class="gift-history-list">${giftHistoryRows(data.gifts)}</div></section>`,
    danmaku: `<section><header class="data-title"><div><p class="kicker">WAITING DANMAKU</p><h3>候场弹幕</h3></div><span>${count(data.counts.danmaku_count)} 条</span></header><div class="list-toolbar"><p class="result-note">按发送时间排列</p>${waitingDanmakuOrderControl()}</div><div class="danmaku-list">${waitingDanmakuRows(data.danmaku)}</div></section>`,
    viewers: `<section><header class="data-title"><div><p class="kicker">WAITING AUDIENCE</p><h3>候场进房用户</h3></div><span>${count(data.counts.user_count)} 位</span></header><div class="table-wrap"><table><thead><tr><th>用户</th><th class="viewer-uid-column">UID</th><th>首次出现</th><th>最近出现</th><th>进入</th><th>发言</th><th>事件</th></tr></thead><tbody>${waitingViewerRows(data.viewers)}</tbody></table></div></section>`,
    supplements: supplementView(supplements),
  };
  panel.innerHTML = `<div class="waiting-intro"><div><p class="kicker">ARCHIVED WAITING</p><h3>本场候场归档</h3><small>这些自动事件原本位于房间的“下一场候场”，并在本场开播时归档；手动补充记录也保存在本场。</small></div><span>${count(data.counts.gift_count + data.counts.danmaku_count + data.counts.entry_count)} 条自动事件</span></div><nav class="segmented-control waiting-event-tabs" aria-label="候场归档类型"><button type="button" data-waiting-mode="gifts" class="${state.waitingMode === "gifts" ? "active" : ""}">礼物 ${count(data.counts.gift_count)}</button><button type="button" data-waiting-mode="danmaku" class="${state.waitingMode === "danmaku" ? "active" : ""}">弹幕 ${count(data.counts.danmaku_count)}</button><button type="button" data-waiting-mode="viewers" class="${state.waitingMode === "viewers" ? "active" : ""}">进房用户 ${count(data.counts.user_count)}</button><button type="button" data-waiting-mode="supplements" class="${state.waitingMode === "supplements" ? "active" : ""}">补充记录 ${count(supplements.total)}</button></nav><div class="waiting-event-view">${views[state.waitingMode] || views.gifts}</div>`;
  panel.querySelectorAll("[data-waiting-mode]").forEach((button) => button.addEventListener("click", () => {
    state.waitingMode = button.dataset.waitingMode;
    renderWaitingEvents(data, supplements);
  }));
  panel.querySelectorAll("[data-waiting-danmaku-order]").forEach((button) => button.addEventListener("click", () => {
    state.waitingDanmakuOrder = button.dataset.waitingDanmakuOrder;
    renderWaitingEvents(data, supplements);
  }));
  if (state.waitingMode === "supplements") bindSupplementView(panel);
}

async function loadWaitingEvents({ sessionId = state.session?.id } = {}) {
  const panel = document.querySelector("#panel-waiting");
  panel.innerHTML = '<div class="panel-loading">整理候场事件…</div>';
  try {
    const [data, supplements] = await Promise.all([
      api(`/api/sessions/${sessionId}/waiting-events`),
      api(`/api/sessions/${sessionId}/supplement-events`),
    ]);
    if (state.session?.id !== sessionId) return;
    renderWaitingEvents(data, supplements);
  } catch (error) { panel.innerHTML = `<div class="empty-inline error">${escapeHtml(error.message)}</div>`; }
}

function renderNoSessions() {
  document.querySelector("#live-overview").innerHTML = '<div class="empty-state"><strong>暂无场次记录</strong><p>检测到下一次开播后会自动创建场次。</p></div>';
  document.querySelector("#session-strip").innerHTML = '<div class="empty-inline">暂无场次记录</div>';
  document.querySelector("#selected-session").hidden = true;
}

function renderError(message) { app.innerHTML = `<section class="error-state"><span>404</span><h1>没有找到直播记录</h1><p>${escapeHtml(message)}</p><a href="/">返回房间列表</a></section>`; }
function toast(message, type = "") { const element = document.createElement("div"); element.className = `toast ${type}`; element.textContent = message; document.body.append(element); setTimeout(() => element.remove(), 3200); }

boot();
