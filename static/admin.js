const adminState = { user: null, rooms: [], config: null, managementEnabled: false, view: "overview" };
const root = document.querySelector("#admin-root");
const escapeHtml = (value = "") => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
const number = (value) => new Intl.NumberFormat("zh-CN").format(Number(value || 0));
const initials = (name = "N") => [...name.trim()].slice(0, 2).join("").toUpperCase() || "N";
const dateTime = (value) => value ? new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)) : "尚无记录";

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && url !== "/api/auth/login") showLogin();
    throw new Error(payload.error || `请求失败 (${response.status})`);
  }
  return payload;
}

async function boot() {
  try {
    const session = await api("/api/auth/me");
    if (!session.authenticated) return showLogin();
    adminState.user = session.username;
    await showConsole();
  } catch (error) { showLogin(error.message); }
}

function showLogin(message = "") {
  root.replaceChildren(document.querySelector("#login-template").content.cloneNode(true));
  const form = document.querySelector("#login-form");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      const data = Object.fromEntries(new FormData(form));
      const result = await api("/api/auth/login", { method: "POST", body: JSON.stringify(data) });
      adminState.user = result.username;
      await showConsole();
    } catch (error) { toast(error.message, "error"); button.disabled = false; }
  });
  if (message) toast(message, "error");
}

async function showConsole() {
  root.replaceChildren(document.querySelector("#console-template").content.cloneNode(true));
  document.querySelector("#admin-username").textContent = adminState.user;
  document.querySelectorAll(".admin-nav button").forEach((button) => button.addEventListener("click", () => changeView(button.dataset.view)));
  document.querySelector("#logout").addEventListener("click", async () => { await api("/api/auth/logout", { method: "POST", body: "{}" }); showLogin(); });
  await Promise.all([loadRooms(), loadConfig()]);
  renderView();
}

async function loadRooms() {
  const data = await api("/api/admin/rooms");
  adminState.rooms = data.items;
  adminState.managementEnabled = data.management_enabled;
}

async function loadConfig() { adminState.config = await api("/api/admin/config"); }

function changeView(view) {
  adminState.view = view;
  document.querySelectorAll(".admin-nav button").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  renderView();
}

function renderView() {
  const titles = {
    overview: ["数据概览", "查看直播间与归档数据的当前状态。"],
    rooms: ["房间管理", "维护房间入口，并为直播间创建新的记录场次。"],
    config: ["系统配置", "通过表单或格式化 JSON 编辑同一份配置文件。"],
  };
  document.querySelector("#view-title").textContent = titles[adminState.view][0];
  document.querySelector("#view-description").textContent = titles[adminState.view][1];
  if (adminState.view === "overview") renderOverview();
  if (adminState.view === "rooms") renderRooms();
  if (adminState.view === "config") renderConfig();
}

function renderOverview() {
  const content = document.querySelector("#admin-content");
  const totalSessions = adminState.rooms.reduce((sum, room) => sum + Number(room.session_count || 0), 0);
  const enabledRooms = adminState.rooms.filter((room) => room.enabled).length;
  const recent = [...adminState.rooms].sort((a, b) => String(b.last_live_at).localeCompare(String(a.last_live_at))).slice(0, 5);
  content.innerHTML = `
    <div class="admin-grid">
      <article class="admin-metric"><span>直播间总数</span><strong>${number(adminState.rooms.length)}</strong></article>
      <article class="admin-metric"><span>当前公开房间</span><strong>${number(enabledRooms)}</strong></article>
      <article class="admin-metric"><span>已归档场次</span><strong>${number(totalSessions)}</strong></article>
    </div>
    <section class="admin-panel">
      <header class="admin-panel-heading"><div><h2>最近直播间</h2><p>按最近一次场次时间排序</p></div><button class="button secondary small" id="go-rooms">管理房间</button></header>
      <div class="room-list">${roomRows(recent, false)}</div>
    </section>`;
  document.querySelector("#go-rooms").addEventListener("click", () => changeView("rooms"));
}

function roomRows(rooms, actions = true) {
  return rooms.map((room) => `
    <article class="admin-room-row" data-room-id="${room.id}">
      <span class="room-avatar">${initials(room.streamer_name)}</span>
      <div class="admin-room-main"><strong>${escapeHtml(room.streamer_name)}</strong><span>${escapeHtml(room.description || "暂无房间说明")}</span></div>
      <div class="admin-room-cell"><span>访问地址</span><strong>/${escapeHtml(room.alias || room.room_number)}</strong></div>
      <div class="admin-room-cell"><span>场次 / 最近直播</span><strong>${number(room.session_count)} · ${dateTime(room.last_live_at)}</strong></div>
      ${actions ? `<div class="row-actions"><button type="button" data-action="session" title="创建场次">＋</button><button type="button" data-action="edit" title="编辑房间">✎</button><button type="button" data-action="delete" title="删除房间">×</button></div>` : `<span class="status-badge ${room.enabled ? "" : "off"}">${room.enabled ? "已启用" : "已停用"}</span>`}
    </article>`).join("") || '<div class="empty-inline">还没有直播间</div>';
}

function renderRooms() {
  const content = document.querySelector("#admin-content");
  content.innerHTML = `
    <section class="admin-panel">
      <header class="admin-panel-heading"><div><h2>全部直播间</h2><p>${adminState.rooms.length} 个房间，房间号与别名均可作为前台路径</p></div><button class="button small" id="add-room" ${adminState.managementEnabled ? "" : "disabled"}>添加房间</button></header>
      ${adminState.managementEnabled ? "" : '<p class="management-note">房间增删改已在配置中关闭。仍可创建直播场次，但无法修改房间信息。</p>'}
      <div class="room-list">${roomRows(adminState.rooms)}</div>
    </section>`;
  document.querySelector("#add-room").addEventListener("click", () => openRoomModal());
  content.querySelectorAll("[data-action]").forEach((button) => {
    const room = adminState.rooms.find((item) => item.id === Number(button.closest("[data-room-id]").dataset.roomId));
    if (button.dataset.action === "session") button.addEventListener("click", () => openSessionModal(room));
    if (button.dataset.action === "edit") {
      button.disabled = !adminState.managementEnabled;
      button.addEventListener("click", () => openRoomModal(room));
    }
    if (button.dataset.action === "delete") {
      button.disabled = !adminState.managementEnabled;
      button.addEventListener("click", () => deleteRoom(room));
    }
  });
}

function openRoomModal(room = null) {
  const fragment = document.querySelector("#room-modal-template").content.cloneNode(true);
  document.body.append(fragment);
  const modal = document.querySelector(".modal-backdrop:last-of-type");
  const form = modal.querySelector("#room-form");
  if (room) {
    modal.querySelector("#room-modal-title").textContent = "编辑直播间";
    for (const key of ["room_number", "alias", "streamer_name", "avatar_url", "description"]) form.elements[key].value = room[key] || "";
    form.elements.enabled.checked = Boolean(room.enabled);
  }
  bindModalClose(modal);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    data.enabled = form.elements.enabled.checked;
    try {
      await api(room ? `/api/admin/rooms/${room.id}` : "/api/admin/rooms", { method: room ? "PATCH" : "POST", body: JSON.stringify(data) });
      modal.remove(); await loadRooms(); renderRooms(); toast(room ? "房间信息已更新" : "直播间已添加");
    } catch (error) { toast(error.message, "error"); }
  });
}

function openSessionModal(room) {
  const fragment = document.querySelector("#session-modal-template").content.cloneNode(true);
  document.body.append(fragment);
  const modal = document.querySelector(".modal-backdrop:last-of-type");
  modal.querySelector("#session-modal-title").textContent = `为 ${room.streamer_name} 创建场次`;
  const form = modal.querySelector("#session-form");
  const local = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  form.elements.started_at.value = local;
  bindModalClose(modal);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    data.started_at = new Date(data.started_at).toISOString();
    data.peak_popularity = Number(data.peak_popularity || 0);
    try {
      await api(`/api/admin/rooms/${room.id}/sessions`, { method: "POST", body: JSON.stringify(data) });
      modal.remove(); await loadRooms(); renderRooms(); toast("直播场次已创建");
    } catch (error) { toast(error.message, "error"); }
  });
}

function bindModalClose(modal) {
  modal.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => modal.remove()));
  modal.addEventListener("click", (event) => { if (event.target === modal) modal.remove(); });
}

async function deleteRoom(room) {
  if (!confirm(`确定删除“${room.streamer_name}”吗？该房间的场次、弹幕和礼物记录也会被删除。`)) return;
  try {
    await api(`/api/admin/rooms/${room.id}?confirm=true`, { method: "DELETE", body: "{}" });
    await loadRooms(); renderRooms(); toast("直播间已删除");
  } catch (error) { toast(error.message, "error"); }
}

function renderConfig() {
  const content = document.querySelector("#admin-content");
  content.innerHTML = `
    <section class="admin-panel">
      <header class="admin-panel-heading"><div><h2>配置文件</h2><p>保存后立即生效，并格式化写入 config.json</p></div></header>
      <div class="config-toolbar"><button type="button" class="active" data-mode="visual">可视化编辑</button><button type="button" data-mode="json">格式化 JSON</button></div>
      <div id="config-editor"></div>
    </section>`;
  content.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => {
    content.querySelectorAll("[data-mode]").forEach((item) => item.classList.toggle("active", item === button));
    button.dataset.mode === "visual" ? renderVisualConfig() : renderJsonConfig();
  }));
  renderVisualConfig();
}

function renderVisualConfig() {
  const editor = document.querySelector("#config-editor");
  const c = adminState.config;
  editor.innerHTML = `
    <form class="config-form" id="config-form">
      <section class="config-section"><h3>站点</h3><div class="form-grid">
        ${field("站点名称", "app.site_name", c.app.site_name)}${field("副标题", "app.tagline", c.app.tagline)}
        ${field("监听地址", "app.host", c.app.host)}${field("端口", "app.port", c.app.port, "number")}
        ${field("时区", "app.timezone", c.app.timezone)}
      </div></section>
      <section class="config-section"><h3>功能开关</h3>
        ${toggleField("允许后台管理房间", "关闭后房间增删改 API 与界面按钮同时禁用", "features.admin_room_management", c.features.admin_room_management)}
        ${toggleField("公开房间目录", "允许首页列出房间，并显示顶部房间切换器", "features.public_room_directory", c.features.public_room_directory)}
      </section>
      <section class="config-section"><h3>显示</h3><div class="form-grid">
        ${field("默认最少发言条数", "display.default_min_messages", c.display.default_min_messages, "number")}
        ${field("弹幕每页数量", "display.danmaku_page_size", c.display.danmaku_page_size, "number")}
        ${field("货币代码", "display.currency", c.display.currency)}
      </div></section>
      <section class="config-section"><h3>安全</h3><div class="form-grid">
        ${field("管理员账号", "security.admin_username", c.security.admin_username)}
        ${field("管理员密码", "security.admin_password", c.security.admin_password, "password")}
        ${field("采集令牌", "security.ingest_token", c.security.ingest_token, "password")}
        ${field("会话签名密钥", "security.session_secret", c.security.session_secret, "password")}
      </div></section>
      <div class="config-actions"><button class="button" type="submit">保存并格式化</button></div>
    </form>`;
  editor.querySelector("#config-form").addEventListener("submit", saveVisualConfig);
}

function field(label, name, value, type = "text") {
  return `<label class="field"><span>${label}</span><input type="${type}" name="${name}" value="${escapeHtml(value)}" required></label>`;
}
function toggleField(label, note, name, checked) {
  return `<label class="toggle-field"><div><strong>${label}</strong><span>${note}</span></div><span class="toggle"><input type="checkbox" name="${name}" ${checked ? "checked" : ""}><i></i></span></label>`;
}

async function saveVisualConfig(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const next = structuredClone(adminState.config);
  const read = (name) => data.get(name);
  next.app.site_name = read("app.site_name"); next.app.tagline = read("app.tagline"); next.app.host = read("app.host");
  next.app.port = Number(read("app.port")); next.app.timezone = read("app.timezone");
  next.features.admin_room_management = form.elements["features.admin_room_management"].checked;
  next.features.public_room_directory = form.elements["features.public_room_directory"].checked;
  next.display.default_min_messages = Number(read("display.default_min_messages"));
  next.display.danmaku_page_size = Number(read("display.danmaku_page_size")); next.display.currency = read("display.currency").toUpperCase();
  next.security.admin_username = read("security.admin_username"); next.security.admin_password = read("security.admin_password");
  next.security.ingest_token = read("security.ingest_token"); next.security.session_secret = read("security.session_secret");
  await saveConfig(next);
}

function renderJsonConfig() {
  const editor = document.querySelector("#config-editor");
  editor.innerHTML = `<textarea class="json-editor" id="json-config" spellcheck="false" aria-label="JSON 配置">${escapeHtml(JSON.stringify(adminState.config, null, 2))}</textarea><div class="editor-actions"><button class="button secondary" id="format-json" type="button">格式化</button><button class="button" id="save-json" type="button">校验并保存</button></div>`;
  document.querySelector("#format-json").addEventListener("click", () => {
    const input = document.querySelector("#json-config");
    try { input.value = JSON.stringify(JSON.parse(input.value), null, 2); toast("JSON 已格式化"); } catch { toast("JSON 格式有误", "error"); }
  });
  document.querySelector("#save-json").addEventListener("click", async () => {
    try { await saveConfig(JSON.parse(document.querySelector("#json-config").value)); }
    catch (error) { toast(error.message === "Unexpected end of JSON input" ? "JSON 格式有误" : error.message, "error"); }
  });
}

async function saveConfig(next) {
  try {
    adminState.config = await api("/api/admin/config", { method: "PUT", body: JSON.stringify(next) });
    await loadRooms();
    toast("配置已保存并格式化");
  } catch (error) { toast(error.message, "error"); }
}

function toast(message, type = "") {
  const element = document.createElement("div");
  element.className = `toast ${type}`;
  element.textContent = message;
  document.body.append(element);
  setTimeout(() => element.remove(), 3200);
}

boot();
