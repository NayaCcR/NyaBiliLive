import { startListen } from "blive-message-listener";
import { parseBilibiliCookie } from "./bilibili-auth.js";
import { fetchBilibiliUserProfiles } from "./bilibili-profile.js";
import { decodeSendGiftV2 } from "./bilibili-gift-v2.js";

const PROFILE_BATCH_SIZE = 20;
const PROFILE_BATCH_DELAY = 15_000;
const PROFILE_RETRY_DELAY = 6 * 60 * 60 * 1000;
const PROFILE_ERROR_BASE_DELAY = 15 * 60_000;
const PROFILE_ERROR_MAX_DELAY = 6 * 60 * 60_000;
const HEARTBEAT_TIMEOUT = 120_000;
const RECONNECT_BASE_DELAY = 30_000;
const RECONNECT_MAX_DELAY = 5 * 60_000;
const MANUAL_RESTART_COOLDOWN = 30_000;

function toIsoTimestamp(value) {
  const numeric = Number(value || Date.now());
  const milliseconds = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  const parsed = new Date(milliseconds);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function messageAvatar(message, user = {}) {
  const candidates = [
    user.face,
    message.raw?.info?.[0]?.[15]?.user?.base?.face,
    message.raw?.info?.[0]?.[15]?.user?.base?.origin_info?.face,
    message.raw?.user_info?.face,
    message.raw?.face,
  ];
  return String(candidates.find((value) => typeof value === "string" && value.trim()) || "");
}

function firstPresent(values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== "");
}

function firstUid(values) {
  return values.map((value) => String(value ?? "").trim()).find((value) => /^[1-9]\d*$/.test(value));
}

function messageUser(message, user = {}) {
  const raw = message.raw || {};
  const rawInfoUser = raw.info?.[2] || [];
  const extraBase = raw.info?.[0]?.[15]?.user?.base || {};
  const originBase = extraBase.origin_info || {};
  return {
    ...user,
    uid: firstUid([
      user.uid, user.mid, rawInfoUser[0], raw.user_info?.uid, raw.user_info?.mid,
      raw.uid, raw.mid, extraBase.uid, extraBase.mid, originBase.uid, originBase.mid,
    ]),
    uname: firstPresent([
      user.uname, user.username, rawInfoUser[1], raw.user_info?.uname, raw.user_info?.name,
      raw.uname, raw.username, raw.name, extraBase.name, extraBase.uname, originBase.name, originBase.uname,
    ]),
    face: messageAvatar(message, user),
    identity: {
      ...(user.identity || {}),
      guard_level: firstPresent([
        user.identity?.guard_level, user.guard_level, raw.user_info?.guard_level,
        raw.guard_level, raw.medal_info?.guard_level,
      ]) || 0,
    },
  };
}

function normalizeUser(user = {}, fallback = "anonymous", avatarUrl = "") {
  const rawUid = String(user.uid ?? user.mid ?? "").trim();
  const uid = /^[1-9]\d*$/.test(rawUid) ? rawUid : "";
  const suppliedUsername = String(user.uname || user.username || "").trim();
  const username = suppliedUsername || "匿名观众";
  return {
    uid: uid || `guest:${suppliedUsername || fallback}`,
    username,
    avatar_url: String(avatarUrl || user.face || ""),
    guard_level: Number(user.identity?.guard_level || 0),
  };
}

function normalizeMessageUser(message, user = message.body?.user, fallback = message.id) {
  const resolved = messageUser(message, user || {});
  return normalizeUser(resolved, fallback, resolved.face);
}

function giftName(body = {}, raw = {}) {
  const candidates = [
    body.gift_name,
    body.gift?.gift_name,
    raw.gift_name,
    raw.giftName,
    raw.original_gift_name,
    raw.batch_combo_send?.gift_name,
    raw.role_name,
  ];
  return String(candidates.find((value) => typeof value === "string" && value.trim()) || "");
}

function messageGiftIcon(message, body = message.body || {}, raw = message.raw || {}) {
  const candidates = [
    body.gift_icon_url,
    body.gift?.gift_icon_url,
    body.gift?.gift_img,
    raw.gift_icon_url,
    raw.gift_img,
    raw.gift_img_basic,
    raw.gift_img_dynamic,
  ];
  return String(candidates.find((value) => typeof value === "string" && value.trim()) || "");
}

function giftCount(body = {}, raw = {}) {
  const candidates = [
    body.amount,
    body.num,
    raw.num,
    raw.gift_num,
    raw.total_num,
    raw.batch_combo_num,
    raw.combo_num,
    raw.batch_combo_send?.gift_num,
    1,
  ];
  return Math.max(1, Number(candidates.find((value) => Number(value) > 0) || 1));
}

function giftUnitPrice(body = {}, raw = {}) {
  const count = giftCount(body, raw);
  const totalCoin = Number(raw.total_coin ?? raw.combo_total_coin ?? body.combo?.total_price ?? 0);
  const coinType = String(body.coin_type || raw.coin_type || "").toLowerCase();
  if (totalCoin > 0 && (coinType === "gold" || !coinType)) {
    return Math.round((totalCoin / 1000 / count) * 100) / 100;
  }
  if (body.coin_type === "gold" || raw.coin_type === "gold") {
    const price = Number(body.price ?? raw.price ?? raw.gift_price ?? 0);
    return price > 0 ? price / 1000 : 0;
  }
  const directPrice = Number(body.price ?? raw.price ?? raw.gift_price ?? 0);
  return directPrice > 0 && (!body.coin_type && !raw.coin_type) ? directPrice / 1000 : 0;
}

function giftTimestamp(message, body = message.body || {}, raw = message.raw || {}) {
  return toIsoTimestamp(
    body.timestamp
    || body.time
    || body.start_time
    || raw.timestamp
    || raw.time
    || raw.start_time
    || message.timestamp,
  );
}

function normalizeGiftUser(message, body = message.body || {}, raw = message.raw || {}, fallback = message.id) {
  if (body.user) return normalizeMessageUser(message, body.user, fallback);
  return normalizeMessageUser(message, {
    uid: raw.uid,
    uname: raw.uname || raw.username,
    face: raw.face,
    identity: { guard_level: raw.guard_level || raw.medal_info?.guard_level || 0 },
  }, fallback);
}

function giftTradeId(prefix, message, body = message.body || {}, raw = message.raw || {}) {
  const key = [
    raw.payflow_id,
    raw.combo_id,
    raw.batch_combo_id,
    raw.tid,
    raw.rnd,
    body.id,
    message.id,
  ].find((value) => value !== undefined && value !== null && String(value).trim());
  return key ? `${prefix}:${key}` : "";
}

export class DanmakuCollector {
  constructor({ database, config, listenerFactory = startListen, profileFetcher = fetchBilibiliUserProfiles, logger = console } = {}) {
    this.database = database;
    this.config = config;
    this.listenerFactory = listenerFactory;
    this.profileFetcher = profileFetcher;
    this.profileFetcherRequiresCookie = profileFetcher === fetchBilibiliUserProfiles;
    this.logger = logger;
    this.connections = new Map();
    this.timer = null;
    this.reconciling = false;
    this.lastReconcileAt = null;
    this.pendingProfileUids = new Set();
    this.profileAttempts = new Map();
    this.profileTimer = null;
    this.profileInFlight = false;
    this.profileGeneration = 0;
    this.lastProfileError = "";
    this.profileFailureStreak = 0;
    this.profileRetryAt = null;
    this.heartbeatRecovery = new Map();
    this.lastManualRestartAt = 0;
  }

  status() {
    const cookie = this.config.value.security.bilibili_cookie.trim();
    const auth = parseBilibiliCookie(cookie);
    return {
      enabled: this.config.value.monitoring.danmaku_enabled,
      running: Boolean(this.timer),
      cookie_configured: Boolean(cookie),
      auth: {
        mode: auth.uid && auth.hasSessdata ? "authenticated" : cookie ? "cookie" : "guest",
        uid: auth.uid ? String(auth.uid) : null,
        buvid_configured: Boolean(auth.buvid),
        sessdata_configured: auth.hasSessdata,
        app_configured: Boolean(this.config.value.security.bilibili_app_access_key),
        app_expires_at: this.config.value.security.bilibili_app_expires_at || null,
      },
      last_reconcile_at: this.lastReconcileAt,
      profile_enrichment: {
        pending: this.pendingProfileUids.size,
        running: this.profileInFlight,
        last_error: this.lastProfileError,
        retry_at: this.profileRetryAt ? new Date(this.profileRetryAt).toISOString() : null,
      },
      rooms: [...this.connections.values()].map((connection) => ({
        room_id: connection.roomId,
        room_number: connection.roomNumber,
        session_id: connection.sessionId,
        status: connection.status,
        connected_at: connection.connectedAt,
        last_event_at: connection.lastEventAt,
        last_heartbeat_at: connection.lastHeartbeatAt,
        heartbeat_status: this.heartbeatStatus(connection),
        heartbeat_restart_count: connection.heartbeatRestartCount,
        reconnect_failure_streak: connection.reconnectFailureStreak,
        last_recovery_at: connection.lastRecoveryAt,
        last_recovery_reason: connection.lastRecoveryReason,
        message_count: connection.messageCount,
        last_error: connection.lastError,
        retry_at: connection.retryAt ? new Date(connection.retryAt).toISOString() : null,
      })),
    };
  }

  start() {
    this.stop();
    if (!this.config.value.monitoring.danmaku_enabled) return;
    const interval = this.config.value.monitoring.danmaku_reconcile_seconds * 1000;
    this.timer = setInterval(() => this.reconcile(), interval);
    this.timer.unref?.();
    this.reconcile();
    for (const user of this.database.listUsersMissingAvatars()) this.queueUserProfile(user);
  }

  stop() {
    this.profileGeneration += 1;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.profileTimer) clearTimeout(this.profileTimer);
    this.profileTimer = null;
    this.profileInFlight = false;
    this.pendingProfileUids.clear();
    for (const roomId of [...this.connections.keys()]) this.stopRoom(roomId);
  }

  restart() {
    this.start();
  }

  manualRestart() {
    const remaining = MANUAL_RESTART_COOLDOWN - (Date.now() - this.lastManualRestartAt);
    if (remaining > 0) return { ok: false, retryAfterSeconds: Math.ceil(remaining / 1000) };
    this.lastManualRestartAt = Date.now();
    this.restart();
    return { ok: true, retryAfterSeconds: 0 };
  }

  heartbeatStatus(connection) {
    if (["closed", "error"].includes(connection.status)) return "offline";
    const latestActivity = Math.max(
      Date.parse(connection.lastHeartbeatAt || "") || 0,
      Date.parse(connection.lastEventAt || "") || 0,
      Date.parse(connection.connectedAt || "") || 0,
    );
    if (!latestActivity) return "waiting";
    return Date.now() - latestActivity >= HEARTBEAT_TIMEOUT ? "stale" : connection.lastHeartbeatAt ? "healthy" : "waiting";
  }

  scheduleRecovery(connection, reason, status = "error") {
    if (connection.recoveryScheduled) {
      connection.status = status;
      return;
    }
    const previous = this.heartbeatRecovery.get(connection.roomId) || { count: 0, failureStreak: 0 };
    const failureStreak = previous.failureStreak + 1;
    const baseDelay = Math.min(RECONNECT_BASE_DELAY * (2 ** (failureStreak - 1)), RECONNECT_MAX_DELAY);
    const delay = Math.min(
      RECONNECT_MAX_DELAY,
      Math.ceil((baseDelay * (1 + Math.random() * 0.2)) / 1000) * 1000,
    );
    const recovery = {
      count: previous.count,
      failureStreak,
      at: new Date().toISOString(),
      retryAt: Date.now() + delay,
      reason: `${reason}，${delay / 1000} 秒后重连`,
    };
    this.heartbeatRecovery.set(connection.roomId, recovery);
    connection.status = status;
    connection.lastError = recovery.reason;
    connection.retryAt = recovery.retryAt;
    connection.recoveryScheduled = true;
    connection.heartbeatRestartCount = recovery.count;
    connection.reconnectFailureStreak = failureStreak;
    connection.lastRecoveryAt = recovery.at;
    connection.lastRecoveryReason = recovery.reason;
    this.logger.warn?.(`[danmaku] room ${connection.roomNumber}: ${recovery.reason}`);
  }

  cancelPendingRecovery(connection, { healthy = false } = {}) {
    if (!connection.recoveryScheduled && !healthy) return;
    const previous = this.heartbeatRecovery.get(connection.roomId);
    if (previous) {
      this.heartbeatRecovery.set(connection.roomId, {
        ...previous,
        failureStreak: healthy ? 0 : previous.failureStreak,
        retryAt: null,
      });
    }
    connection.recoveryScheduled = false;
    connection.retryAt = null;
    if (healthy) connection.reconnectFailureStreak = 0;
  }

  queueUserProfile(user) {
    const uid = String(user?.uid || "");
    if (!/^[1-9]\d*$/.test(uid)) return;
    if (this.profileFetcherRequiresCookie) {
      const cookie = this.config.value.security.bilibili_cookie.trim();
      if (!parseBilibiliCookie(cookie).hasSessdata) return;
    }
    if (user?.avatar_url) {
      this.pendingProfileUids.delete(uid);
      return;
    }
    if (this.database.userHasAvatar(uid)) {
      this.pendingProfileUids.delete(uid);
      return;
    }
    const lastAttempt = this.profileAttempts.get(uid) || 0;
    if (Date.now() - lastAttempt < PROFILE_RETRY_DELAY) return;
    this.pendingProfileUids.add(uid);
    this.scheduleProfileFlush();
  }

  scheduleProfileFlush(delay = PROFILE_BATCH_DELAY) {
    if (this.profileTimer || this.profileInFlight || !this.pendingProfileUids.size) return;
    const retryDelay = this.profileRetryAt ? Math.max(0, this.profileRetryAt - Date.now()) : 0;
    const effectiveDelay = Math.max(delay, retryDelay);
    const generation = this.profileGeneration;
    this.profileTimer = setTimeout(() => {
      this.profileTimer = null;
      if (generation === this.profileGeneration) void this.flushProfileQueue();
    }, effectiveDelay);
    this.profileTimer.unref?.();
  }

  async flushProfileQueue() {
    if (this.profileInFlight || !this.pendingProfileUids.size) return;
    const generation = this.profileGeneration;
    const batch = [...this.pendingProfileUids].slice(0, PROFILE_BATCH_SIZE);
    for (const uid of batch) {
      this.pendingProfileUids.delete(uid);
      this.profileAttempts.set(uid, Date.now());
    }
    this.profileInFlight = true;
    try {
      const profiles = await this.profileFetcher(batch, {
        cookie: this.config.value.security.bilibili_cookie.trim(),
      });
      if (generation !== this.profileGeneration) return;
      for (const profile of profiles) this.database.updateUserProfile(profile);
      this.lastProfileError = "";
      this.profileFailureStreak = 0;
      this.profileRetryAt = null;
    } catch (error) {
      if (generation !== this.profileGeneration) return;
      this.lastProfileError = error instanceof Error ? error.message : String(error);
      this.profileFailureStreak += 1;
      const delay = Math.min(
        PROFILE_ERROR_BASE_DELAY * (2 ** (this.profileFailureStreak - 1)),
        PROFILE_ERROR_MAX_DELAY,
      );
      this.profileRetryAt = Date.now() + delay;
      this.logger.warn?.(`[danmaku] user profile enrichment: ${this.lastProfileError}`);
    } finally {
      if (generation === this.profileGeneration) {
        this.profileInFlight = false;
        this.scheduleProfileFlush(this.profileRetryAt ? Math.max(0, this.profileRetryAt - Date.now()) : PROFILE_BATCH_DELAY);
      }
    }
  }

  reconcile() {
    if (this.reconciling || !this.config.value.monitoring.danmaku_enabled) return;
    this.reconciling = true;
    try {
      // Live rooms always connect. Offline rooms only stay connected when their
      // per-room waiting monitor is enabled, limiting long-lived idle connections.
      const desired = new Map(this.database.listDanmakuMonitorRooms().map((room) => [room.id, room]));
      for (const roomId of this.connections.keys()) {
        if (!desired.has(roomId)) this.stopRoom(roomId);
      }
      for (const room of desired.values()) {
        const current = this.connections.get(room.id);
        if (current) current.sessionId = this.database.getActiveSessionForRoom(room.id)?.id || null;
        const heartbeatExpired = current && this.heartbeatStatus(current) === "stale";
        if (heartbeatExpired && !current.recoveryScheduled) {
          const elapsed = Math.floor((Date.now() - Math.max(
            Date.parse(current.lastHeartbeatAt || "") || 0,
            Date.parse(current.lastEventAt || "") || 0,
            Date.parse(current.connectedAt || "") || 0,
          )) / 1000);
          this.scheduleRecovery(current, `心跳或消息已静默 ${elapsed} 秒`);
        } else if (current?.instance?.closed && !["closed", "error"].includes(current.status)) {
          this.scheduleRecovery(current, "底层连接已关闭", "closed");
        }
        const retryReady = current && (!current.retryAt || Date.now() >= current.retryAt);
        const needsRestart = current && (
          (["closed", "error"].includes(current.status) && retryReady)
        );
        if (!current || needsRestart) {
          if (needsRestart) {
            const recovery = this.heartbeatRecovery.get(room.id);
            if (recovery) this.heartbeatRecovery.set(room.id, {
              ...recovery,
              count: recovery.count + 1,
              at: new Date().toISOString(),
              reason: `${recovery.reason}（已执行）`,
            });
          }
          if (current) this.stopRoom(room.id);
          this.startRoom(room);
        }
      }
      this.lastReconcileAt = new Date().toISOString();
    } finally {
      this.reconciling = false;
    }
  }

  startRoom(room) {
    const recovery = this.heartbeatRecovery.get(room.id) || { count: 0, failureStreak: 0, at: null, reason: "" };
    const connection = {
      roomId: room.id,
      roomNumber: String(room.room_number),
      sessionId: this.database.getActiveSessionForRoom(room.id)?.id || null,
      instance: null,
      status: "connecting",
      connectedAt: null,
      lastEventAt: null,
      lastHeartbeatAt: null,
      heartbeatRestartCount: recovery.count,
      reconnectFailureStreak: recovery.failureStreak,
      lastRecoveryAt: recovery.at,
      lastRecoveryReason: recovery.reason,
      messageCount: 0,
      lastError: "",
      handshakeTimer: null,
      retryAt: null,
      recoveryScheduled: false,
      stopped: false,
      recentGiftTrades: new Map(),
    };
    this.connections.set(room.id, connection);
    const isCurrent = () => !connection.stopped && this.connections.get(room.id) === connection;
    const recordActivity = (countMessage = false) => {
      if (!isCurrent()) return;
      clearHandshakeTimer();
      connection.status = "listening";
      connection.connectedAt ||= new Date().toISOString();
      connection.lastError = "";
      this.cancelPendingRecovery(connection);
      connection.lastEventAt = new Date().toISOString();
      if (countMessage) connection.messageCount += 1;
    };
    const recordEvent = () => recordActivity(true);
    const recordHeartbeat = () => {
      if (!isCurrent()) return;
      clearHandshakeTimer();
      const timestamp = new Date().toISOString();
      connection.status = "listening";
      connection.connectedAt ||= timestamp;
      connection.lastHeartbeatAt = timestamp;
      connection.lastError = "";
      this.cancelPendingRecovery(connection, { healthy: true });
    };
    const clearHandshakeTimer = () => {
      if (connection.handshakeTimer) clearTimeout(connection.handshakeTimer);
      connection.handshakeTimer = null;
    };
    const rememberGiftTrade = (tradeId) => {
      const now = Date.now();
      for (const [key, seenAt] of connection.recentGiftTrades) {
        if (now - seenAt > 10 * 60 * 1000) connection.recentGiftTrades.delete(key);
      }
      if (!tradeId) return true;
      if (connection.recentGiftTrades.has(tradeId)) return false;
      connection.recentGiftTrades.set(tradeId, now);
      return true;
    };
    const reportError = (error) => {
      if (!isCurrent()) return;
      clearHandshakeTimer();
      const message = error instanceof Error ? error.message : String(error);
      this.scheduleRecovery(connection, message);
    };
    const ensureSession = (startedAt = new Date().toISOString()) => {
      const session = this.database.getActiveSessionForRoom(room.id)
        || this.database.ensureLiveSessionFromEvent(room.id, startedAt);
      if (session) connection.sessionId = session.id;
      return session;
    };
    const ingest = (event) => {
      if (!isCurrent()) return;
      try {
        const session = this.database.getActiveSessionForRoom(room.id);
        const matchedUid = String(event.user?.uid || "").startsWith("guest:")
          ? this.database.findUniqueUserUidByUsername(event.user.username)
          : null;
        const user = matchedUid ? { ...event.user, uid: matchedUid } : event.user;
        if (session) this.database.ingest({ ...event, user, session_id: session.id });
        else this.database.ingestWaiting(room.id, { ...event, user });
        this.queueUserProfile(user);
        connection.sessionId = session?.id || null;
        recordEvent();
      } catch (error) {
        reportError(error);
      }
    };
    const handler = {
      onOpen: () => { if (!isCurrent()) return; connection.status = "connected"; connection.connectedAt = new Date().toISOString(); connection.lastError = ""; this.cancelPendingRecovery(connection); },
      onStartListen: () => {
        if (!isCurrent()) return;
        clearHandshakeTimer(); connection.status = "listening"; connection.connectedAt ||= new Date().toISOString(); connection.lastError = ""; this.cancelPendingRecovery(connection);
        this.logger.info?.(`[danmaku] listening room ${room.room_number}, uid ${parseBilibiliCookie(this.config.value.security.bilibili_cookie).uid || 0}`);
      },
      onLiveStart: (message) => {
        if (!isCurrent()) return;
        try {
          ensureSession(toIsoTimestamp(message.timestamp));
          recordActivity();
        } catch (error) {
          reportError(error);
        }
      },
      onLiveEnd: (message) => {
        if (!isCurrent()) return;
        try {
          this.database.endLiveSessionFromEvent(room.id, toIsoTimestamp(message.timestamp));
          connection.sessionId = null;
          recordActivity();
        } catch (error) {
          reportError(error);
        }
      },
      onClose: () => { if (!isCurrent()) return; clearHandshakeTimer(); this.scheduleRecovery(connection, "连接已关闭", "closed"); },
      onError: reportError,
      onIncomeDanmu: (message) => {
        const body = message.body;
        ingest({
          type: "danmaku",
          timestamp: toIsoTimestamp(body.timestamp || message.timestamp),
          user: normalizeMessageUser(message, body.user),
          content: body.content,
          medal_name: body.user?.badge?.name || "",
          medal_level: Number(body.user?.badge?.level || 0),
        });
      },
      onUserAction: (message) => {
        if (message.body.action !== "enter") return;
        ingest({
          type: "enter",
          timestamp: toIsoTimestamp(message.body.timestamp || message.timestamp),
          user: normalizeMessageUser(message, message.body.user),
        });
      },
      onGift: (message) => {
        const body = message.body;
        const tradeId = giftTradeId("gift", message, body, message.raw);
        if (!rememberGiftTrade(tradeId)) return;
        const resolvedGiftName = giftName(body, message.raw);
        if (!resolvedGiftName) return;
        ingest({
          type: "gift",
          timestamp: giftTimestamp(message, body),
          user: normalizeGiftUser(message, body, message.raw),
          gift_name: resolvedGiftName,
          gift_icon_url: messageGiftIcon(message, body),
          count: giftCount(body, message.raw),
          unit_price: giftUnitPrice(body, message.raw),
          trade_id: tradeId,
        });
      },
      onGuardBuy: (message) => {
        const body = message.body;
        const tradeId = giftTradeId("guard", message, body, message.raw);
        if (!rememberGiftTrade(tradeId)) return;
        ingest({
          type: "gift",
          timestamp: giftTimestamp(message, body),
          user: normalizeGiftUser(message, body, message.raw),
          gift_name: giftName(body, message.raw) || "大航海",
          gift_icon_url: messageGiftIcon(message, body),
          count: giftCount(body, message.raw),
          unit_price: giftUnitPrice(body, message.raw),
          trade_id: tradeId,
        });
      },
      onIncomeSuperChat: (message) => {
        const body = message.body;
        const user = normalizeMessageUser(message, body.user);
        ingest({
          type: "danmaku",
          timestamp: toIsoTimestamp(message.timestamp),
          user,
          content: body.content,
          medal_name: body.user?.badge?.name || "",
          medal_level: Number(body.user?.badge?.level || 0),
          is_superchat: true,
          superchat_price: Number(body.price || 0),
        });
        ingest({
          type: "gift",
          timestamp: toIsoTimestamp(message.timestamp),
          user,
          gift_name: "醒目留言",
          gift_icon_url: "",
          count: 1,
          unit_price: Number(body.price || 0),
          trade_id: `superchat:${message.id}`,
        });
      },
      onAttentionChange: (message) => {
        if (!isCurrent()) return;
        recordHeartbeat();
        try {
          const session = this.database.getActiveSessionForRoom(room.id);
          if (session) this.database.updateSession(session.id, {
            peak_popularity: Math.max(Number(session.peak_popularity || 0), Number(message.body.attention || 0)),
          });
        } catch (error) {
          reportError(error);
        }
      },
      onWatchedChange: () => {
        if (!isCurrent()) return;
        connection.lastEventAt = new Date().toISOString();
        connection.status = "listening";
        connection.lastError = "";
        this.cancelPendingRecovery(connection);
      },
      raw: {
        SEND_GIFT_V2: (raw) => {
          let gifts;
          try {
            gifts = decodeSendGiftV2(raw?.pb);
          } catch (error) {
            this.logger.warn?.(`[danmaku] invalid SEND_GIFT_V2 payload in room ${room.room_number}: ${error.message}`);
            return;
          }
          gifts.forEach((gift, index) => {
            const stableId = gift.tid || gift.rnd;
            const syntheticMessage = {
              id: stableId || "",
              timestamp: gift.timestamp || Date.now(),
              body: {
                user: {
                  uid: gift.uid,
                  uname: gift.uname,
                  face: gift.face,
                  identity: { guard_level: gift.guard_level },
                },
                gift_name: gift.gift_name,
                amount: gift.num,
                coin_type: gift.coin_type,
                price: gift.price,
                timestamp: gift.timestamp,
              },
              raw: gift,
            };
            // Use the legacy prefix as well so a gray-release room emitting both formats is not double-counted.
            const tradeId = stableId ? giftTradeId("gift", syntheticMessage, syntheticMessage.body, gift) : "";
            if (!rememberGiftTrade(tradeId)) return;
            const resolvedGiftName = giftName(syntheticMessage.body, gift);
            if (!resolvedGiftName) return;
            ingest({
              type: "gift",
              timestamp: giftTimestamp(syntheticMessage, syntheticMessage.body, gift),
              user: normalizeGiftUser(syntheticMessage, syntheticMessage.body, gift, `gift-v2-${index}`),
              gift_name: resolvedGiftName,
              gift_icon_url: messageGiftIcon(syntheticMessage, syntheticMessage.body, gift),
              count: giftCount(syntheticMessage.body, gift),
              unit_price: giftUnitPrice(syntheticMessage.body, gift),
              trade_id: tradeId,
            });
          });
        },
        COMBO_SEND: (raw) => {
          const syntheticMessage = { id: raw.combo_id || raw.batch_combo_id || raw.rnd || "combo", timestamp: raw.timestamp || raw.tid || Date.now(), body: {}, raw };
          const tradeId = giftTradeId("gift", syntheticMessage, syntheticMessage.body, raw);
          if (!rememberGiftTrade(tradeId)) return;
          const resolvedGiftName = giftName({}, raw);
          if (!resolvedGiftName) return;
          ingest({
            type: "gift",
            timestamp: giftTimestamp(syntheticMessage, syntheticMessage.body, raw),
            user: normalizeGiftUser(syntheticMessage, syntheticMessage.body, raw, tradeId || syntheticMessage.id),
            gift_name: resolvedGiftName,
            gift_icon_url: messageGiftIcon(syntheticMessage, syntheticMessage.body, raw),
            count: giftCount({}, raw),
            unit_price: giftUnitPrice({}, raw),
            trade_id: tradeId,
          });
        },
      },
    };
    try {
      const cookie = this.config.value.security.bilibili_cookie.trim();
      const auth = parseBilibiliCookie(cookie);
      connection.instance = this.listenerFactory(Number(room.room_number), handler, {
        ws: {
          keepalive: true,
          uid: auth.uid,
          ...(auth.buvid ? { buvid: auth.buvid } : {}),
          headers: {
            Referer: `https://live.bilibili.com/${room.room_number}`,
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36",
            ...(cookie ? { Cookie: cookie } : {}),
          },
        },
      });
      connection.handshakeTimer = setTimeout(() => reportError(
        new Error("弹幕握手超时；Bilibili 可能触发 -352 风控，请尝试在管理后台配置浏览器 Cookie"),
      ), 15_000);
      connection.handshakeTimer.unref?.();
      this.logger.info?.(`[danmaku] connecting room ${room.room_number}, session ${room.session_id}`);
    } catch (error) {
      reportError(error);
    }
  }

  stopRoom(roomId) {
    const connection = this.connections.get(roomId);
    if (!connection) return;
    connection.stopped = true;
    if (connection.handshakeTimer) clearTimeout(connection.handshakeTimer);
    try { connection.instance?.close?.(); } catch {}
    this.connections.delete(roomId);
  }
}
