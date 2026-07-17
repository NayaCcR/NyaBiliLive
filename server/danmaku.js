import { startListen } from "blive-message-listener";
import { parseBilibiliCookie } from "./bilibili-auth.js";

function toIsoTimestamp(value) {
  const numeric = Number(value || Date.now());
  const milliseconds = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  const parsed = new Date(milliseconds);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function normalizeUser(user = {}, fallback = "anonymous") {
  const uid = Number(user.uid || 0);
  const username = String(user.uname || user.username || "匿名观众");
  return {
    uid: uid > 0 ? String(uid) : `guest:${username || fallback}`,
    username,
    avatar_url: String(user.face || ""),
    guard_level: Number(user.identity?.guard_level || 0),
  };
}

export class DanmakuCollector {
  constructor({ database, config, listenerFactory = startListen, logger = console } = {}) {
    this.database = database;
    this.config = config;
    this.listenerFactory = listenerFactory;
    this.logger = logger;
    this.connections = new Map();
    this.timer = null;
    this.reconciling = false;
    this.lastReconcileAt = null;
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
      rooms: [...this.connections.values()].map((connection) => ({
        room_id: connection.roomId,
        room_number: connection.roomNumber,
        session_id: connection.sessionId,
        status: connection.status,
        connected_at: connection.connectedAt,
        last_event_at: connection.lastEventAt,
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
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const roomId of [...this.connections.keys()]) this.stopRoom(roomId);
  }

  restart() {
    this.start();
  }

  reconcile() {
    if (this.reconciling || !this.config.value.monitoring.danmaku_enabled) return;
    this.reconciling = true;
    try {
      const desired = new Map(this.database.listLiveRoomsWithSessions().map((room) => [room.id, room]));
      for (const roomId of this.connections.keys()) {
        if (!desired.has(roomId)) this.stopRoom(roomId);
      }
      for (const room of desired.values()) {
        const current = this.connections.get(room.id);
        const retryReady = current && (!current.retryAt || Date.now() >= current.retryAt);
        const needsRestart = current && (
          (["closed", "error"].includes(current.status) && retryReady)
          || (!['connecting', 'closed', 'error'].includes(current.status) && current.instance?.closed)
        );
        if (!current || current.sessionId !== room.session_id || needsRestart) {
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
    const connection = {
      roomId: room.id,
      roomNumber: String(room.room_number),
      sessionId: room.session_id,
      instance: null,
      status: "connecting",
      connectedAt: null,
      lastEventAt: null,
      messageCount: 0,
      lastError: "",
      handshakeTimer: null,
      retryAt: null,
      stopped: false,
    };
    this.connections.set(room.id, connection);
    const isCurrent = () => !connection.stopped && this.connections.get(room.id) === connection;
    const recordEvent = () => {
      if (!isCurrent()) return;
      clearHandshakeTimer();
      connection.status = "listening";
      connection.connectedAt ||= new Date().toISOString();
      connection.lastError = "";
      connection.retryAt = null;
      connection.lastEventAt = new Date().toISOString();
      connection.messageCount += 1;
    };
    const clearHandshakeTimer = () => {
      if (connection.handshakeTimer) clearTimeout(connection.handshakeTimer);
      connection.handshakeTimer = null;
    };
    const reportError = (error) => {
      if (!isCurrent()) return;
      clearHandshakeTimer();
      const message = error instanceof Error ? error.message : String(error);
      connection.status = "error";
      connection.lastError = message;
      connection.retryAt = Date.now() + 30_000;
      this.logger.warn?.(`[danmaku] room ${room.room_number}: ${message}`);
    };
    const ingest = (event) => {
      if (!isCurrent()) return;
      try {
        const session = this.database.getActiveSessionForRoom(room.id);
        if (!session) return;
        this.database.ingest({ ...event, session_id: session.id });
        connection.sessionId = session.id;
        recordEvent();
      } catch (error) {
        reportError(error);
      }
    };
    const handler = {
      onOpen: () => { if (!isCurrent()) return; connection.status = "connected"; connection.connectedAt = new Date().toISOString(); connection.lastError = ""; connection.retryAt = null; },
      onStartListen: () => {
        if (!isCurrent()) return;
        clearHandshakeTimer(); connection.status = "listening"; connection.connectedAt ||= new Date().toISOString(); connection.lastError = ""; connection.retryAt = null;
        this.logger.info?.(`[danmaku] listening room ${room.room_number}, uid ${parseBilibiliCookie(this.config.value.security.bilibili_cookie).uid || 0}`);
      },
      onClose: () => { if (!isCurrent()) return; clearHandshakeTimer(); connection.status = "closed"; connection.lastError = "连接已关闭，30 秒后重试"; connection.retryAt = Date.now() + 30_000; },
      onError: reportError,
      onIncomeDanmu: (message) => {
        const body = message.body;
        ingest({
          type: "danmaku",
          timestamp: toIsoTimestamp(body.timestamp || message.timestamp),
          user: normalizeUser(body.user, message.id),
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
          user: normalizeUser(message.body.user, message.id),
        });
      },
      onGift: (message) => {
        const body = message.body;
        ingest({
          type: "gift",
          timestamp: toIsoTimestamp(message.timestamp),
          user: normalizeUser(body.user, message.id),
          gift_name: body.gift_name,
          gift_icon_url: "",
          count: Math.max(1, Number(body.amount || 1)),
          unit_price: body.coin_type === "gold" ? Number(body.price || 0) / 1000 : 0,
          trade_id: `gift:${message.id}`,
        });
      },
      onIncomeSuperChat: (message) => {
        const body = message.body;
        const user = normalizeUser(body.user, message.id);
        ingest({
          type: "danmaku",
          timestamp: toIsoTimestamp(message.timestamp),
          user,
          content: body.content,
          medal_name: body.user?.badge?.name || "",
          medal_level: Number(body.user?.badge?.level || 0),
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
        try {
          const session = this.database.getActiveSessionForRoom(room.id);
          if (session) this.database.updateSession(session.id, {
            peak_popularity: Math.max(Number(session.peak_popularity || 0), Number(message.body.attention || 0)),
          });
        } catch (error) {
          reportError(error);
        }
      },
    };
    try {
      const cookie = this.config.value.security.bilibili_cookie.trim();
      const auth = parseBilibiliCookie(cookie);
      connection.instance = this.listenerFactory(Number(room.room_number), handler, {
        ws: {
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
