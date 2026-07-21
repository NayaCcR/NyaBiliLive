const state = { config: null, auth: null, claim: null, challenge: null, loadingChallenge: false, verifying: false };
const app = document.querySelector("#app");
const escapeHtml = (value = "") => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
const formatTimestamp = (value) => value ? new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
}).format(new Date(value)) : "—";
const claimIdentifier = () => decodeURIComponent(location.pathname.split("/").filter(Boolean)[1] || "");

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败 (${response.status})`);
  return payload;
}

function toast(message, type = "") {
  const element = document.createElement("div");
  element.className = `toast ${type}`;
  element.textContent = message;
  document.body.append(element);
  setTimeout(() => element.remove(), 3200);
}

async function boot() {
  try {
    const [config, auth, claim] = await Promise.all([
      api("/api/config"),
      api("/api/auth/me"),
      api(`/api/rooms/${encodeURIComponent(claimIdentifier())}/claim`),
    ]);
    state.config = config;
    state.auth = auth;
    state.claim = claim;
    document.title = `${config.app.site_name} · 认领直播间`;
    const authEntry = document.querySelector("#auth-entry");
    if (auth.authenticated) {
      authEntry.textContent = auth.auth_mode === "admin" ? auth.username : "已认领";
      authEntry.href = auth.auth_mode === "admin" ? "/admin" : `/${encodeURIComponent(claim.alias || claim.room_number)}`;
      authEntry.classList.add("signed-in");
    }
    renderClaimPage();
    if (!claim.claimed && claim.live_status === 1 && Number(claim.claim_manager_count || 0) > 0) await issueChallenge(true);
  } catch (error) {
    app.innerHTML = `<section class="error-state"><span>404</span><h1>无法进入认领页面</h1><p>${escapeHtml(error.message)}</p><a href="/">返回房间列表</a></section>`;
  }
}

function claimSummary() {
  if (!state.claim) return "";
  if (state.claim.claimed && state.claim.claim) {
    return `<div class="claim-status-card claimed"><small>当前浏览器状态</small><strong>已认领</strong><p>认领账号：${escapeHtml(state.claim.claim.username)} · UID ${escapeHtml(state.claim.claim.uid)}</p><span>${formatTimestamp(state.claim.claim.claimed_at)} 认领成功</span></div>`;
  }
  if (!Number(state.claim.claim_manager_count || 0)) {
    return `<div class="claim-status-card warning"><small>当前浏览器状态</small><strong>暂时无法认领</strong><p>这个直播间还没有配置认领管理者 UID。</p><span>请先在后台房间管理里添加允许认领的 UID。</span></div>`;
  }
  if (state.claim.live_status !== 1) {
    return `<div class="claim-status-card warning"><small>当前浏览器状态</small><strong>等待开播</strong><p>认领码只能在直播中的弹幕里验证。</p><span>房间开播后再回来发送认领弹幕就可以。</span></div>`;
  }
  return `<div class="claim-status-card ready"><small>当前浏览器状态</small><strong>等待认领</strong><p>请使用后台已配置的管理者 UID，把认领码发送到当前直播间弹幕。</p><span>当前共允许 ${escapeHtml(state.claim.claim_manager_count)} 个 UID 参与认领。</span></div>`;
}

function challengeBlock() {
  if (!Number(state.claim?.claim_manager_count || 0) || state.claim.live_status !== 1) {
    return `<section class="claim-surface"><header><p class="kicker">CLAIM CODE</p><h2>认领码</h2></header><div class="claim-empty">当前条件还不能生成认领码。</div></section>`;
  }
  const code = state.challenge?.code || `${state.claim.claim_prefix}••••••`;
  return `<section class="claim-surface"><header><p class="kicker">CLAIM CODE</p><h2>认领码</h2><p>固定房间标识为 <code>${escapeHtml(state.claim.claim_prefix)}</code>，后半段会每次刷新随机生成。</p></header><div class="claim-code-box"><code id="claim-code">${escapeHtml(code)}</code><div class="claim-code-actions"><button type="button" class="secondary-button" id="refresh-claim-code" ${state.loadingChallenge ? "disabled" : ""}>${state.loadingChallenge ? "生成中…" : "刷新认领码"}</button><button type="button" class="secondary-button" id="copy-claim-code" ${state.challenge?.code ? "" : "disabled"}>复制认领码</button></div></div><ol class="claim-steps"><li>保持直播间处于开播状态。</li><li>用后台已配置的管理者 UID，把这条完整弹幕发送到当前直播间。</li><li>发送后回到这里点击“开始验证”。</li></ol><div class="claim-verify-actions"><button type="button" class="primary-button" id="verify-claim" ${state.challenge?.code && !state.verifying ? "" : "disabled"}>${state.verifying ? "正在验证…" : "我已发送，开始验证"}</button></div></section>`;
}

function renderClaimPage() {
  if (!state.claim) return;
  app.innerHTML = `<section class="claim-page"><div class="claim-page-heading"><div><a class="back-link" href="/${encodeURIComponent(state.claim.alias || state.claim.room_number)}">← 返回直播记录</a><p class="kicker">ROOM CLAIM</p><h1>认领直播间</h1><p class="page-description">通过当前直播间弹幕完成房间认领，结果会保存在当前浏览器 Cookie。</p></div><a class="secondary-button" href="https://live.bilibili.com/${encodeURIComponent(state.claim.room_number)}" target="_blank" rel="noopener">打开直播间 ↗</a></div><section class="claim-room-overview"><div class="claim-room-copy"><small>直播间</small><strong>${escapeHtml(state.claim.streamer_name || `房间 ${state.claim.room_number}`)}</strong><span>${escapeHtml(state.claim.alias ? `/${state.claim.alias}` : `房间号 ${state.claim.room_number}`)}</span></div><div class="claim-room-copy"><small>当前标题</small><strong>${escapeHtml(state.claim.current_title || "尚未同步直播标题")}</strong><span>${state.claim.live_status === 1 ? "直播中" : "未开播"}</span></div><div class="claim-room-copy"><small>可认领 UID</small><strong>${escapeHtml(state.claim.claim_manager_count)}</strong><span>${state.claim.bili_uid ? `主播 UID ${escapeHtml(state.claim.bili_uid)} 默认在内` : "仅后台已配置的管理者可认领"}</span></div></section>${claimSummary()}${challengeBlock()}</section>`;
  bindClaimEvents();
}

function bindClaimEvents() {
  document.querySelector("#refresh-claim-code")?.addEventListener("click", () => { void issueChallenge(false); });
  document.querySelector("#copy-claim-code")?.addEventListener("click", async () => {
    if (!state.challenge?.code) return;
    try {
      await navigator.clipboard.writeText(state.challenge.code);
      toast("认领码已复制");
    } catch {
      toast("复制失败，请手动复制", "error");
    }
  });
  document.querySelector("#verify-claim")?.addEventListener("click", () => { void verifyClaim(); });
}

async function issueChallenge(silent = false) {
  if (!state.claim) return;
  state.loadingChallenge = true;
  renderClaimPage();
  try {
    state.challenge = await api(`/api/rooms/${encodeURIComponent(claimIdentifier())}/claim/challenge`, {
      method: "POST",
      body: "{}",
    });
    renderClaimPage();
    if (!silent) toast("新的认领码已生成");
  } catch (error) {
    state.loadingChallenge = false;
    renderClaimPage();
    if (!silent) toast(error.message, "error");
    return;
  }
  state.loadingChallenge = false;
  renderClaimPage();
}

async function verifyClaim() {
  if (!state.challenge?.code) return;
  state.verifying = true;
  renderClaimPage();
  try {
    await api(`/api/rooms/${encodeURIComponent(claimIdentifier())}/claim/verify`, {
      method: "POST",
      body: "{}",
    });
    state.challenge = null;
    state.claim = await api(`/api/rooms/${encodeURIComponent(claimIdentifier())}/claim`);
    toast("直播间认领成功");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    state.verifying = false;
    renderClaimPage();
  }
}

boot();
