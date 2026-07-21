const adminState = { user: null, mustChangePassword: false, rooms: [], config: null, monitor: null, managementEnabled: false, view: "overview", refreshTimer: null, refreshInFlight: false };
const root = document.querySelector("#admin-root");
const escapeHtml = (value = "") => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
const count = (value) => new Intl.NumberFormat("zh-CN").format(Number(value || 0));
const initials = (name = "N") => [...String(name).trim()].slice(0, 2).join("").toUpperCase() || "N";
const dateTime = (value) => value ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)) : "尚无记录";
const normalizeUidList = (value) => [...new Set(String(value || "")
  .split(/[\s,，、]+/)
  .map((item) => item.trim())
  .filter(Boolean))];
const randomPassword = (length = 24) => {
  const groups = ["abcdefghijkmnopqrstuvwxyz", "ABCDEFGHJKLMNPQRSTUVWXYZ", "23456789", "!@#$%&*-_=+"];
  const alphabet = groups.join("");
  const pick = (characters) => characters[crypto.getRandomValues(new Uint32Array(1))[0] % characters.length];
  const result = groups.map(pick);
  while (result.length < length) result.push(pick(alphabet));
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = crypto.getRandomValues(new Uint32Array(1))[0] % (index + 1);
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result.join("");
};

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !["/api/auth/login", "/api/auth/change-password"].includes(url)) showLogin();
    const error = new Error(payload.error || `请求失败 (${response.status})`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function boot() {
  try {
    const session = await api("/api/auth/me");
    if (!session.authenticated) return showLogin();
    adminState.user = session.username; adminState.mustChangePassword = Boolean(session.must_change_password); await showConsole();
  } catch (error) { showLogin(error.message); }
}

function showLogin(message = "") {
  if (adminState.refreshTimer) { clearInterval(adminState.refreshTimer); adminState.refreshTimer = null; }
  root.replaceChildren(document.querySelector("#login-template").content.cloneNode(true));
  const form = document.querySelector("#login-form");
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); const button = form.querySelector("button[type=submit]"); button.disabled = true;
    try { const result = await api("/api/auth/login", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) }); adminState.user = result.username; adminState.mustChangePassword = Boolean(result.must_change_password); history.replaceState({}, "", "/admin"); await showConsole(); }
    catch (error) { toast(error.message, "error"); button.disabled = false; }
  });
  if (message) toast(message, "error");
}

async function showConsole() {
  root.replaceChildren(document.querySelector("#console-template").content.cloneNode(true));
  document.querySelector("#admin-username").textContent = adminState.user;
  document.querySelectorAll(".admin-nav button").forEach((button) => button.addEventListener("click", () => changeView(button.dataset.view)));
  document.querySelector("#logout").addEventListener("click", async () => { await api("/api/auth/logout", { method: "POST", body: "{}" }); history.replaceState({}, "", "/login"); showLogin(); });
  if (adminState.mustChangePassword) return openForcedPasswordChange();
  await loadConsoleData();
}

async function loadConsoleData() {
  await Promise.all([loadRooms(), loadConfig(), loadMonitor()]); renderView(); startAdminRefresh();
}

function startAdminRefresh() {
  if (adminState.refreshTimer) clearInterval(adminState.refreshTimer);
  adminState.refreshTimer = setInterval(async () => {
    if (document.hidden || adminState.refreshInFlight || document.querySelector(".modal-backdrop")) return;
    if (!['overview', 'rooms'].includes(adminState.view)) return;
    adminState.refreshInFlight = true;
    try {
      await Promise.all([loadRooms(), loadMonitor()]);
      if (adminState.view === "overview") renderOverview();
      if (adminState.view === "rooms") renderRooms();
    } catch {}
    finally { adminState.refreshInFlight = false; }
  }, 4000);
}

function openForcedPasswordChange() {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop forced-password-backdrop";
  backdrop.innerHTML = `<section class="modal password-modal" role="dialog" aria-modal="true" aria-labelledby="password-change-title">
    <header class="modal-heading"><div><p class="kicker">SECURITY REQUIRED</p><h2 id="password-change-title">修改默认管理员密码</h2></div></header>
    <form id="password-change-form">
      <p class="password-change-note">默认密码是公开信息。完成修改前，后台数据和配置接口将保持锁定。</p>
      <div class="form-grid">
        <label class="field full"><span>当前密码</span><input type="password" name="current_password" autocomplete="current-password" required autofocus></label>
        <label class="field"><span>新密码</span><input type="password" name="new_password" autocomplete="new-password" minlength="10" required></label>
        <label class="field"><span>确认新密码</span><input type="password" name="confirm_password" autocomplete="new-password" minlength="10" required></label>
      </div>
      <div class="modal-actions"><button class="secondary-button" type="button" id="generate-admin-password">生成随机密码</button><button class="primary-button" type="submit">修改密码并进入后台</button></div>
    </form>
  </section>`;
  document.body.append(backdrop);
  const form = backdrop.querySelector("#password-change-form");
  backdrop.querySelector("#generate-admin-password").addEventListener("click", () => {
    const password = randomPassword();
    const nextPassword = form.elements.new_password;
    const confirmation = form.elements.confirm_password;
    nextPassword.value = password;
    confirmation.value = password;
    nextPassword.type = "text";
    confirmation.type = "text";
    nextPassword.focus();
    nextPassword.select();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      await api("/api/auth/change-password", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      adminState.mustChangePassword = false;
      backdrop.remove();
      await loadConsoleData();
      toast("管理员密码已修改");
    } catch (error) {
      toast(error.message, "error");
      button.disabled = false;
    }
  });
}

async function loadRooms() { const data = await api("/api/admin/rooms"); adminState.rooms = data.items; adminState.managementEnabled = data.management_enabled; }
async function loadConfig() { adminState.config = await api("/api/admin/config"); }
async function loadMonitor() { adminState.monitor = await api("/api/admin/monitor"); }

function changeView(view) {
  adminState.view = view;
  document.querySelectorAll(".admin-nav button").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  renderView();
}

function renderView() {
  const copy = { overview: ["数据概览", "查看房间同步和场次归档的当前状态。"], rooms: ["房间管理", "添加房间后会立即获取 Bilibili 公开资料。"], config: ["系统配置", "可视化表单与 JSON 编辑器写入同一份配置。"] };
  document.querySelector("#view-title").textContent = copy[adminState.view][0]; document.querySelector("#view-description").textContent = copy[adminState.view][1];
  if (adminState.view === "overview") renderOverview(); if (adminState.view === "rooms") renderRooms(); if (adminState.view === "config") renderConfig();
}

function renderOverview() {
  const totalSessions = adminState.rooms.reduce((sum, room) => sum + Number(room.session_count || 0), 0);
  const liveRooms = adminState.rooms.filter((room) => Number(room.live_status) === 1).length;
  const failedRooms = adminState.rooms.filter((room) => room.last_sync_error).length;
  const danmaku = adminState.monitor.danmaku || { enabled: false, rooms: [] };
  const connectedRooms = danmaku.rooms.filter((room) => ["connected", "listening"].includes(room.status)).length;
  const messageTotal = danmaku.rooms.reduce((sum, room) => sum + Number(room.message_count || 0), 0);
  const lastError = danmaku.rooms.find((room) => room.last_error)?.last_error || "暂无错误";
  const auth = danmaku.auth || { mode: "guest", uid: null };
  const authLabel = auth.mode === "authenticated" ? `已登录 · UID ${auth.uid}` : auth.mode === "cookie" ? "Cookie 不完整" : "访客模式";
  const connectionRows = danmaku.rooms.map((room) => `<article class="danmaku-connection-row"><span><strong>房间 ${escapeHtml(room.room_number)}</strong><small>场次 #${count(room.session_id)}</small></span><span class="state-chip ${["connected", "listening"].includes(room.status) ? "online" : ""}">${escapeHtml(room.status)}</span><span><strong>${count(room.message_count)} 条</strong><small>${room.last_event_at ? `${dateTime(room.last_event_at)} 最近事件` : "等待消息"}</small></span>${room.last_error ? `<small class="error-text">${escapeHtml(room.last_error)}</small>` : ""}</article>`).join("") || '<div class="empty-inline">当前没有需要连接的直播中场次</div>';
  document.querySelector("#admin-content").innerHTML = `<section class="metric-grid"><article><span>直播间</span><strong>${count(adminState.rooms.length)}</strong><small>${adminState.rooms.filter((room) => room.enabled).length} 个已启用</small></article><article><span>正在直播</span><strong>${count(liveRooms)}</strong><small>由公开房间接口检测</small></article><article><span>归档场次</span><strong>${count(totalSessions)}</strong><small>包含直播中场次</small></article><article><span>同步异常</span><strong>${count(failedRooms)}</strong><small>${failedRooms ? "请检查房间详情" : "所有房间正常"}</small></article></section><section class="surface monitor-surface"><header class="surface-heading"><div><p class="kicker">ROOM MONITOR</p><h2>自动同步</h2></div><span class="state-chip ${adminState.monitor.enabled ? "online" : ""}">${adminState.monitor.enabled ? "运行中" : "已关闭"}</span></header><div class="monitor-details"><span><small>检查间隔</small><strong>${adminState.monitor.interval_seconds} 秒</strong></span><span><small>上次运行</small><strong>${dateTime(adminState.monitor.last_run_at)}</strong></span><span><small>上次结果</small><strong>${adminState.monitor.last_result ? `${adminState.monitor.last_result.synced}/${adminState.monitor.last_result.checked} 成功` : "等待首次检查"}</strong></span></div></section><section class="surface monitor-surface"><header class="surface-heading"><div><p class="kicker">DANMAKU COLLECTOR</p><h2>内置弹幕采集</h2></div><div class="surface-actions"><button class="secondary-button small" id="restart-danmaku" type="button">↻ 重连弹幕</button><span class="state-chip ${danmaku.enabled ? "online" : ""}">${danmaku.enabled ? "已启用" : "已关闭"}</span></div></header><div class="monitor-details"><span><small>正在连接</small><strong>${connectedRooms}/${danmaku.rooms.length} 个房间</strong></span><span><small>本次连接已收消息</small><strong>${count(messageTotal)} 条</strong></span><span><small>Bilibili 身份</small><strong>${escapeHtml(authLabel)}</strong></span></div><div class="danmaku-connection-list">${connectionRows}</div>${lastError !== "暂无错误" ? `<p class="collector-error"><strong>最后错误</strong><span>${escapeHtml(lastError)}</span></p>` : ""}</section><section class="surface"><header class="surface-heading"><div><p class="kicker">RECENT ROOMS</p><h2>最近房间</h2></div><button class="secondary-button small" id="go-rooms">管理房间</button></header><div class="admin-room-list">${roomRows(adminState.rooms.slice(0, 5), false)}</div></section>`;
  document.querySelector("#go-rooms").addEventListener("click", () => changeView("rooms"));
  document.querySelector("#restart-danmaku").addEventListener("click", restartDanmaku);
}

async function restartDanmaku(event) {
  const button = event.currentTarget; button.disabled = true;
  try {
    await api("/api/admin/danmaku/restart", { method: "POST", body: "{}" });
    await loadMonitor(); renderOverview(); toast("弹幕连接已重新启动");
  } catch (error) { toast(error.message, "error"); button.disabled = false; }
}

function roomRows(rooms, actions = true) {
  return rooms.map((room, index) => `<article class="admin-room-row" data-room-id="${room.id}"><span class="admin-avatar">${initials(room.streamer_name)}</span><span class="admin-room-copy"><strong>${escapeHtml(room.streamer_name)}</strong><small>/${escapeHtml(room.alias || room.room_number)} · ${count(room.session_count)} 场 · ${count(room.claim_manager_count)} 位管理者</small></span><span class="sync-cell"><span class="state-chip ${Number(room.live_status) === 1 ? "live" : ""}">${Number(room.live_status) === 1 ? "直播中" : "未开播"}</span><small class="${room.last_sync_error ? "error-text" : ""}">${room.last_sync_error ? escapeHtml(room.last_sync_error) : `${dateTime(room.last_sync_at)} 同步`}</small></span>${actions ? `<span class="row-actions"><button data-action="up" title="上移房间" ${index === 0 ? "disabled" : ""}>↑</button><button data-action="down" title="下移房间" ${index === rooms.length - 1 ? "disabled" : ""}>↓</button><button data-action="sync" title="立即同步">↻</button><button data-action="session" title="手动创建场次">＋</button><button data-action="edit" title="编辑房间">✎</button><button data-action="managers" title="认领管理者">👥</button><button data-action="delete" title="删除房间">×</button></span>` : `<a class="room-open-link" href="/${encodeURIComponent(room.alias || room.room_number)}">查看</a>`}</article>`).join("") || '<div class="empty-inline">还没有直播间</div>';
}

function renderRooms() {
  const content = document.querySelector("#admin-content");
  content.innerHTML = `<section class="surface"><header class="surface-heading"><div><p class="kicker">LIVE ROOMS</p><h2>全部直播间</h2><p>${adminState.rooms.length} 个房间，启用后自动检查开播状态</p></div><button class="primary-button small" id="add-room" ${adminState.managementEnabled ? "" : "disabled"}>添加房间</button></header>${adminState.managementEnabled ? "" : '<p class="warning-note">房间增删改已在系统配置中关闭。</p>'}<div class="admin-room-list">${roomRows(adminState.rooms)}</div></section>`;
  document.querySelector("#add-room").addEventListener("click", () => openRoomModal());
  content.querySelectorAll("[data-action]").forEach((button) => {
    const room = adminState.rooms.find((item) => item.id === Number(button.closest("[data-room-id]").dataset.roomId));
    if (["up", "down"].includes(button.dataset.action)) {
      button.disabled = button.disabled || !adminState.managementEnabled;
      button.addEventListener("click", () => moveRoom(room, button.dataset.action));
    }
    if (button.dataset.action === "sync") button.addEventListener("click", () => syncRoom(room, button));
    if (button.dataset.action === "session") button.addEventListener("click", () => openSessionModal(room));
    if (button.dataset.action === "edit") { button.disabled = !adminState.managementEnabled; button.addEventListener("click", () => openRoomModal(room)); }
    if (button.dataset.action === "managers") { button.disabled = !adminState.managementEnabled; button.addEventListener("click", () => openClaimManagersModal(room)); }
    if (button.dataset.action === "delete") { button.disabled = !adminState.managementEnabled; button.addEventListener("click", () => deleteRoom(room)); }
  });
}

async function moveRoom(room, direction) {
  try {
    const data = await api(`/api/admin/rooms/${room.id}/reorder`, { method: "POST", body: JSON.stringify({ direction }) });
    adminState.rooms = data.items;
    renderRooms();
  } catch (error) { toast(error.message, "error"); }
}

async function syncRoom(room, button) {
  button.disabled = true;
  try { await api(`/api/admin/rooms/${room.id}/sync`, { method: "POST", body: "{}" }); await Promise.all([loadRooms(), loadMonitor()]); renderRooms(); toast("房间资料与直播状态已同步"); }
  catch (error) { toast(error.message, "error"); button.disabled = false; }
}

function openRoomModal(room = null) {
  document.body.append(document.querySelector("#room-modal-template").content.cloneNode(true));
  const modal = document.querySelector(".modal-backdrop:last-of-type"); const form = modal.querySelector("#room-form");
  if (room) { modal.querySelector("#room-modal-title").textContent = "编辑直播间"; for (const key of ["room_number", "alias", "streamer_name", "avatar_url", "description"]) form.elements[key].value = room[key] || ""; form.elements.enabled.checked = Boolean(room.enabled); }
  bindModal(modal);
  form.addEventListener("submit", async (event) => { event.preventDefault(); const button = form.querySelector("button[type=submit]"); button.disabled = true; const data = Object.fromEntries(new FormData(form)); data.enabled = form.elements.enabled.checked; try { await api(room ? `/api/admin/rooms/${room.id}` : "/api/admin/rooms", { method: room ? "PATCH" : "POST", body: JSON.stringify(data) }); modal.remove(); await Promise.all([loadRooms(), loadMonitor()]); renderRooms(); toast(room ? "房间信息已更新" : "房间已添加并完成首次同步"); } catch (error) { toast(error.message, "error"); button.disabled = false; } });
}

function openSessionModal(room) {
  document.body.append(document.querySelector("#session-modal-template").content.cloneNode(true));
  const modal = document.querySelector(".modal-backdrop:last-of-type"); const form = modal.querySelector("#session-form"); modal.querySelector("#session-modal-title").textContent = `为 ${room.streamer_name} 创建场次`;
  form.elements.started_at.value = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16); bindModal(modal);
  form.addEventListener("submit", async (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(form)); data.started_at = new Date(data.started_at).toISOString(); data.peak_popularity = Number(data.peak_popularity || 0); try { await api(`/api/admin/rooms/${room.id}/sessions`, { method: "POST", body: JSON.stringify(data) }); modal.remove(); await loadRooms(); renderRooms(); toast("场次已创建"); } catch (error) { toast(error.message, "error"); } });
}

async function openClaimManagersModal(room) {
  try {
    const managerApi = async (options = {}) => {
      try {
        return await api(`/api/admin/rooms/${room.id}/claim-managers`, options);
      } catch (error) {
        if (error.status === 404 && /API 路由不存在/.test(error.message)) {
          return api(`/api/admin/rooms/${room.id}/managers`, options);
        }
        throw error;
      }
    };
    const details = await managerApi();
    document.body.append(document.querySelector("#claim-managers-modal-template").content.cloneNode(true));
    const modal = document.querySelector(".modal-backdrop:last-of-type");
    const form = modal.querySelector("#claim-managers-form");
    modal.querySelector("#claim-managers-modal-title").textContent = `${details.streamer_name} · 认领管理者`;
    form.elements.uids.value = details.items.map((item) => item.bili_uid).join("\n");
    modal.querySelector("#claim-managers-note").textContent = details.bili_uid
      ? `主播 UID ${details.bili_uid} 会自动保留在列表中。追加规则：只填数字 UID；可以一行一个，也可以写成 uid,uid,uid（逗号、中文逗号、空格都可以）。`
      : "当前还没同步到主播 UID；你可以先手动填入允许认领的数字 UID，格式支持一行一个或 uid,uid,uid。";
    bindModal(modal);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = form.querySelector("button[type=submit]");
      button.disabled = true;
      try {
        const uids = normalizeUidList(form.elements.uids.value);
        await managerApi({
          method: "PUT",
          body: JSON.stringify({ uids }),
        });
        modal.remove();
        await loadRooms();
        renderRooms();
        toast("认领管理者已保存");
      } catch (error) {
        toast(error.message, "error");
        button.disabled = false;
      }
    });
  } catch (error) {
    toast(/API 路由不存在/.test(error.message) ? "管理者接口暂不可用，请确认后端已更新并重启" : error.message, "error");
  }
}

function bindModal(modal) { modal.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => modal.remove())); modal.addEventListener("click", (event) => { if (event.target === modal) modal.remove(); }); }
async function deleteRoom(room) { if (!confirm(`确定删除“${room.streamer_name}”及其全部场次记录吗？`)) return; try { await api(`/api/admin/rooms/${room.id}?confirm=true`, { method: "DELETE", body: "{}" }); await loadRooms(); renderRooms(); toast("直播间已删除"); } catch (error) { toast(error.message, "error"); } }

function renderConfig() {
  document.querySelector("#admin-content").innerHTML = `<section class="surface"><header class="surface-heading"><div><p class="kicker">CONFIGURATION</p><h2>配置文件</h2><p>保存后校验并格式化写入 config.json</p></div></header><nav class="editor-tabs"><button class="active" data-mode="visual">可视化编辑</button><button data-mode="json">格式化 JSON</button></nav><div id="config-editor"></div></section>`;
  document.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => { document.querySelectorAll("[data-mode]").forEach((item) => item.classList.toggle("active", item === button)); button.dataset.mode === "visual" ? renderVisualConfig() : renderJsonConfig(); })); renderVisualConfig();
}

function renderVisualConfig() {
  const c = adminState.config; const editor = document.querySelector("#config-editor");
  const auth = adminState.monitor.danmaku?.auth || { mode: "guest", uid: null };
  const authTitle = auth.mode === "authenticated" ? `已登录 Bilibili · UID ${auth.uid}` : auth.mode === "cookie" ? "Cookie 缺少登录身份字段" : "当前使用访客模式";
  const appTitle = auth.app_configured
    ? `APP 长效凭证 · ${auth.app_expires_at ? `${dateTime(auth.app_expires_at)} 到期` : "已配置"}`
    : "APP 长效凭证未配置";
  const hasBilibiliCredentials = Boolean(c.security.bilibili_cookie || c.security.bilibili_web_refresh_token || c.security.bilibili_app_access_key || c.security.bilibili_app_refresh_token);
  editor.innerHTML = `<form class="config-form" id="config-form">
    <section class="config-section"><h3>站点</h3><div class="form-grid">
      ${field("站点名称", "app.site_name", c.app.site_name)}${field("副标题", "app.tagline", c.app.tagline)}
      ${field("监听地址", "app.host", c.app.host)}${field("端口", "app.port", c.app.port, "number")}${field("时区", "app.timezone", c.app.timezone)}
    </div></section>
    <section class="config-section"><h3>房间监视器</h3><div class="form-grid">
      ${field("检查间隔（秒）", "monitoring.interval_seconds", c.monitoring.interval_seconds, "number")}
      ${field("请求超时（秒）", "monitoring.request_timeout_seconds", c.monitoring.request_timeout_seconds, "number")}
      ${field("弹幕协调间隔（秒）", "monitoring.danmaku_reconcile_seconds", c.monitoring.danmaku_reconcile_seconds, "number")}
    </div>${toggleField("启用自动检查", "启动后立即同步，随后按间隔检查", "monitoring.enabled", c.monitoring.enabled)}${toggleField("自动更新主播资料", "使用 Bilibili 公开信息覆盖名称与头像", "monitoring.auto_update_room_profile", c.monitoring.auto_update_room_profile)}${toggleField("启用内置弹幕采集", "检测到直播场次后自动连接弹幕 WebSocket", "monitoring.danmaku_enabled", c.monitoring.danmaku_enabled)}</section>
    <section class="config-section"><h3>功能</h3>${toggleField("允许后台管理房间", "同时控制增删改 API", "features.admin_room_management", c.features.admin_room_management)}${toggleField("公开房间目录", "允许首页列出启用的房间", "features.public_room_directory", c.features.public_room_directory)}</section>
    <section class="config-section"><h3>显示</h3><div class="form-grid">${field("默认最少发言条数", "display.default_min_messages", c.display.default_min_messages, "number")}${field("弹幕每页数量", "display.danmaku_page_size", c.display.danmaku_page_size, "number")}${field("货币代码", "display.currency", c.display.currency)}</div></section>
    <section class="config-section"><h3>安全</h3><div class="form-grid">${field("管理员账号", "security.admin_username", c.security.admin_username, "text", true, "登录管理后台使用的账号。")}${field("管理员密码", "security.admin_password", c.security.admin_password, "password", true, "管理后台密码；修改后请妥善保存。")}${field("采集令牌", "security.ingest_token", c.security.ingest_token, "password", true, "外部采集程序写入 /api/ingest 时使用的 Bearer Token。")}${field("会话签名密钥", "security.session_secret", c.security.session_secret, "password", true, "用于签名后台登录 Cookie；更换后所有管理员会话失效。")}</div></section>
    <section class="config-section"><h3>Bilibili 鉴权</h3>
      <div class="bili-auth-status"><span class="state-chip ${auth.mode === "authenticated" ? "online" : ""}">${escapeHtml(authTitle)}</span><span class="state-chip ${auth.app_configured ? "online" : ""}">${escapeHtml(appTitle)}</span></div>
      <div class="bili-auth-actions"><button class="primary-button small" type="button" id="start-bili-login">Web 扫码登录</button><button class="primary-button small" type="button" id="start-bili-app-login">APP 扫码登录</button><button class="secondary-button small" type="button" id="verify-bili-auth" ${c.security.bilibili_cookie ? "" : "disabled"}>刷新登录状态</button><button class="secondary-button small" type="button" id="refresh-bili-cookie" ${c.security.bilibili_cookie ? "" : "disabled"}>检查 Cookie 续期</button><button class="secondary-button small danger-button" type="button" id="clear-bili-auth" ${hasBilibiliCredentials ? "" : "disabled"}>清除登录凭证</button></div>
      <div class="form-grid auth-secret-grid">${textareaField("完整 Cookie（可选）", "security.bilibili_cookie", c.security.bilibili_cookie, "也可以从已登录的 live.bilibili.com 请求中复制 Cookie")}${field("Web refresh_token（可选）", "security.bilibili_web_refresh_token", c.security.bilibili_web_refresh_token, "password", false)}</div>
      <p class="config-help">Web 扫码用于 Cookie 和官方 Cookie refresh；APP 扫码使用公开 APPKey 获取约 180 天的 access_key 与 refresh_token。两种方式均使用全球 passport.bilibili.com 接口，适用于香港部署。敏感凭证只保存在本机 config.json。</p>
    </section>
    <div class="form-actions"><button class="primary-button" type="submit">保存配置</button></div>
  </form>`;
  editor.querySelector("#config-form").addEventListener("submit", saveVisualConfig);
  editor.querySelector("#start-bili-login").addEventListener("click", () => startBilibiliLogin("web"));
  editor.querySelector("#start-bili-app-login").addEventListener("click", () => startBilibiliLogin("app"));
  editor.querySelector("#verify-bili-auth").addEventListener("click", verifyBilibiliAuth);
  editor.querySelector("#refresh-bili-cookie").addEventListener("click", refreshBilibiliCookie);
  editor.querySelector("#clear-bili-auth").addEventListener("click", clearBilibiliAuth);
}

const field = (label, name, value, type = "text", required = true, note = "") => `<label class="field"><span>${label}</span><input type="${type}" name="${name}" value="${escapeHtml(value)}" ${required ? "required" : ""}>${note ? `<small class="field-note">${escapeHtml(note)}</small>` : ""}</label>`;
const textareaField = (label, name, value, placeholder = "") => `<label class="field full"><span>${label}</span><textarea name="${name}" placeholder="${escapeHtml(placeholder)}">${escapeHtml(value)}</textarea></label>`;
const toggleField = (label, note, name, checked) => `<label class="toggle-field"><span><strong>${label}</strong><small>${note}</small></span><span class="toggle"><input type="checkbox" name="${name}" ${checked ? "checked" : ""}><i></i></span></label>`;

async function startBilibiliLogin(mode) {
  try {
    const isApp = mode === "app";
    const basePath = isApp ? "/api/admin/bilibili-auth/app-qr" : "/api/admin/bilibili-auth/qr";
    const login = await api(basePath, { method: "POST", body: "{}" });
    const modal = document.createElement("div");
    modal.className = "modal-backdrop";
    modal.innerHTML = `<section class="modal qr-modal" role="dialog" aria-modal="true" aria-labelledby="qr-login-title"><header class="modal-heading"><div><p class="kicker">BILIBILI LOGIN</p><h2 id="qr-login-title">${isApp ? "APP 长效登录" : "Web 扫码登录"}</h2></div><button type="button" data-close aria-label="关闭">×</button></header><div class="qr-login-body"><img src="${escapeHtml(login.image)}" alt="Bilibili 登录二维码"><strong id="qr-login-status">请使用哔哩哔哩客户端扫码</strong><p>${isApp ? "确认后将保存 APP access_key、refresh_token 和 Cookie。" : "确认后将保存 Cookie 与 Web refresh_token。"}</p></div></section>`;
    document.body.append(modal);
    bindModal(modal);
    while (modal.isConnected) {
      await new Promise((resolve) => setTimeout(resolve, 1800));
      if (!modal.isConnected) break;
      const result = await api(`${basePath}/${encodeURIComponent(login.key)}`);
      modal.querySelector("#qr-login-status").textContent = result.message;
      if (result.status === "confirmed") {
        toast(`${isApp ? "APP" : "Web"} 登录成功：${result.profile.username}`);
        modal.remove();
        await Promise.all([loadConfig(), loadMonitor()]);
        renderVisualConfig();
      }
      if (["expired", "error"].includes(result.status)) break;
    }
  } catch (error) { toast(error.message, "error"); }
}

async function refreshBilibiliCookie() {
  try {
    const result = await api("/api/admin/bilibili-auth/cookie-refresh", { method: "POST", body: "{}" });
    await Promise.all([loadConfig(), loadMonitor()]);
    renderVisualConfig();
    toast(result.message || "Cookie 状态已检查");
  } catch (error) { toast(error.message, "error"); }
}

async function verifyBilibiliAuth() {
  try {
    const profile = await api("/api/admin/bilibili-auth/verify", { method: "POST", body: "{}" });
    await Promise.all([loadConfig(), loadMonitor()]);
    renderVisualConfig();
    toast(`Cookie 有效：${profile.username}（UID ${profile.uid}）`);
  } catch (error) { toast(error.message, "error"); }
}

async function clearBilibiliAuth() {
  if (!confirm("确定清除当前 Bilibili Cookie、Web 与 APP 凭证吗？现有弹幕连接会立即断开并切回访客模式。")) return;
  try {
    const next = structuredClone(adminState.config);
    for (const field of ["bilibili_cookie", "bilibili_web_refresh_token", "bilibili_app_access_key", "bilibili_app_refresh_token", "bilibili_app_expires_at"]) {
      next.security[field] = "";
    }
    adminState.config = await api("/api/admin/config", { method: "PUT", body: JSON.stringify(next) });
    await Promise.all([loadRooms(), loadMonitor()]);
    renderVisualConfig();
    toast("Bilibili 登录凭证已清除，采集器已切回访客模式");
  } catch (error) { toast(error.message, "error"); }
}

async function saveVisualConfig(event) {
  event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); const next = structuredClone(adminState.config); const read = (name) => data.get(name);
  next.app = { site_name: read("app.site_name"), tagline: read("app.tagline"), host: read("app.host"), port: Number(read("app.port")), timezone: read("app.timezone") };
  next.monitoring = { enabled: form.elements["monitoring.enabled"].checked, interval_seconds: Number(read("monitoring.interval_seconds")), request_timeout_seconds: Number(read("monitoring.request_timeout_seconds")), auto_update_room_profile: form.elements["monitoring.auto_update_room_profile"].checked, danmaku_enabled: form.elements["monitoring.danmaku_enabled"].checked, danmaku_reconcile_seconds: Number(read("monitoring.danmaku_reconcile_seconds")) };
  next.features = { admin_room_management: form.elements["features.admin_room_management"].checked, public_room_directory: form.elements["features.public_room_directory"].checked };
  next.display = { default_min_messages: Number(read("display.default_min_messages")), danmaku_page_size: Number(read("display.danmaku_page_size")), currency: read("display.currency").toUpperCase() };
  next.security = { ...next.security, admin_username: read("security.admin_username"), admin_password: read("security.admin_password"), ingest_token: read("security.ingest_token"), session_secret: read("security.session_secret"), bilibili_cookie: read("security.bilibili_cookie") || "", bilibili_web_refresh_token: read("security.bilibili_web_refresh_token") || "" };
  await saveConfig(next);
}

function renderJsonConfig() {
  const editor = document.querySelector("#config-editor"); editor.innerHTML = `<textarea class="json-editor" id="json-config" spellcheck="false" aria-label="JSON 配置">${escapeHtml(JSON.stringify(adminState.config, null, 2))}</textarea><div class="json-actions"><button class="secondary-button" id="format-json">格式化</button><button class="primary-button" id="save-json">校验并保存</button></div>`;
  document.querySelector("#format-json").addEventListener("click", () => { const input = document.querySelector("#json-config"); try { input.value = JSON.stringify(JSON.parse(input.value), null, 2); toast("JSON 已格式化"); } catch { toast("JSON 格式有误", "error"); } });
  document.querySelector("#save-json").addEventListener("click", async () => { try { await saveConfig(JSON.parse(document.querySelector("#json-config").value)); } catch (error) { toast(error.message, "error"); } });
}

async function saveConfig(next) { try { adminState.config = await api("/api/admin/config", { method: "PUT", body: JSON.stringify(next) }); await Promise.all([loadRooms(), loadMonitor()]); toast("配置已保存并生效"); } catch (error) { toast(error.message, "error"); } }
function toast(message, type = "") { const element = document.createElement("div"); element.className = `toast ${type}`; element.textContent = message; document.body.append(element); setTimeout(() => element.remove(), 3200); }

boot();
