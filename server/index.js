import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cookieSession from "cookie-session";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { ZodError } from "zod";
import { ArchiveDatabase } from "./database.js";
import { BilibiliRoomMonitor } from "./bilibili.js";
import { BilibiliAuthClient } from "./bilibili-auth.js";
import { DanmakuCollector } from "./danmaku.js";
import { BilibiliMediaProxy } from "./media.js";
import { ConfigStore } from "./config.js";
import {
  changePasswordSchema,
  ingestEventSchema,
  loginSchema,
  roomCreateSchema,
  roomClaimManagersUpdateSchema,
  roomUpdateSchema,
  sessionCreateSchema,
  sessionUpdateSchema,
  viewerNoteUpdateSchema,
} from "./schemas.js";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultConfigPath = path.join(rootDirectory, "config.json");
const defaultDatabasePath = path.join(rootDirectory, "data", "nyabililive.db");
const staticDirectory = path.join(rootDirectory, "static");
const environment = typeof process === "undefined" ? {} : process.env;
const argumentsList = typeof process === "undefined" ? [] : process.argv;
const DEFAULT_ADMIN_PASSWORD = "nya123nya321";
const CLAIM_CODE_PREFIX = "Nya-bl";
const CLAIM_CHALLENGE_TTL = 15 * 60 * 1000;
const CLAIM_COOKIE_NAME = "nyabililive_room_claims";
const CLAIM_COOKIE_MAX_AGE = 180 * 24 * 60 * 60 * 1000;
const SAFE_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const httpError = (status, message) => Object.assign(new Error(message), { status });
const parsePositiveInt = (value, fallback, maximum = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(value ?? fallback, 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw httpError(400, "查询参数必须是非负整数");
  return Math.min(parsed, maximum);
};
const parseOption = (value, allowed, fallback, label) => {
  const selected = String(value || fallback).toLowerCase();
  if (!allowed.includes(selected)) throw httpError(400, `${label}不受支持`);
  return selected;
};
const safeEqual = (first, second) => crypto.timingSafeEqual(
  crypto.createHash("sha256").update(String(first)).digest(),
  crypto.createHash("sha256").update(String(second)).digest(),
);
const isInsideDirectory = (parent, candidate) => {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};
const parseCookieHeader = (header = "") => Object.fromEntries(String(header).split(/;\s*/).filter(Boolean).map((entry) => {
  const index = entry.indexOf("=");
  return index >= 0 ? [entry.slice(0, index), entry.slice(index + 1)] : [entry, ""];
}));
const serializeCookie = (name, value, {
  path: cookiePath = "/",
  maxAge = null,
  httpOnly = true,
  sameSite = "Strict",
  secure = false,
} = {}) => [
  `${name}=${value}`,
  `Path=${cookiePath}`,
  Number.isFinite(maxAge) ? `Max-Age=${Math.max(0, Math.floor(maxAge / 1000))}` : "",
  httpOnly ? "HttpOnly" : "",
  sameSite ? `SameSite=${sameSite}` : "",
  secure ? "Secure" : "",
].filter(Boolean).join("; ");
const encodeSignedJson = (payload, secret) => {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
};
const decodeSignedJson = (value, secret) => {
  if (!value || !String(value).includes(".")) return null;
  const [body, signature] = String(value).split(".", 2);
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  if (!safeEqual(signature, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
};
const requestMatchesOrigin = (request) => {
  const fetchSite = String(request.get("Sec-Fetch-Site") || "").toLowerCase();
  if (fetchSite === "same-origin" || fetchSite === "none") return true;
  if (fetchSite === "cross-site" || fetchSite === "same-site") return false;
  const source = request.get("Origin") || request.get("Referer");
  if (!source) return true;
  try {
    const sourceUrl = new URL(source);
    const requestHost = String(request.get("host") || "").split(",")[0].trim().toLowerCase();
    return sourceUrl.host.toLowerCase() === requestHost;
  } catch {
    return false;
  }
};

export function createApp({
  databasePath = environment.NYABILILIVE_DB || defaultDatabasePath,
  configPath = environment.NYABILILIVE_CONFIG || defaultConfigPath,
  seed = true,
  logger = environment.NODE_ENV !== "test",
  bilibiliClient,
  bilibiliAuthClient = new BilibiliAuthClient(),
  danmakuListenerFactory,
  bilibiliUserProfileFetcher,
  mediaFetch = fetch,
} = {}) {
  if (isInsideDirectory(staticDirectory, path.resolve(configPath))) {
    throw new Error("NYABILILIVE_CONFIG 不能位于 static 公开目录内");
  }
  const config = new ConfigStore(configPath);
  const database = new ArchiveDatabase(databasePath, { seed });
  const monitor = new BilibiliRoomMonitor({
    database,
    config,
    client: bilibiliClient,
    logger: logger ? console : { warn() {} },
  });
  const danmakuCollector = new DanmakuCollector({
    database,
    config,
    listenerFactory: danmakuListenerFactory,
    profileFetcher: bilibiliUserProfileFetcher,
    logger: logger ? console : { info() {}, warn() {} },
  });
  const mediaProxy = new BilibiliMediaProxy({ fetchImpl: mediaFetch });
  let authMaintenanceInFlight = false;
  let lastAuthMaintenance = null;
  const maintainBilibiliAuth = async () => {
    if (authMaintenanceInFlight) return { status: "running", last_checked_at: lastAuthMaintenance };
    const security = config.value.security;
    if (!security.bilibili_cookie.trim()) return { status: "disabled", last_checked_at: lastAuthMaintenance };
    authMaintenanceInFlight = true;
    try {
      const result = await bilibiliAuthClient.refreshWebCookie(
        security.bilibili_cookie,
        security.bilibili_web_refresh_token,
      );
      if (result.status === "refreshed") {
        config.save({
          ...config.value,
          security: {
            ...config.value.security,
            bilibili_cookie: result.cookie,
            bilibili_web_refresh_token: result.web_refresh_token,
          },
        });
        danmakuCollector.restart();
      }
      lastAuthMaintenance = new Date().toISOString();
      return { status: result.status, message: result.message, last_checked_at: lastAuthMaintenance };
    } finally {
      authMaintenanceInFlight = false;
    }
  };
  const app = express();

  app.set("trust proxy", environment.NYABILILIVE_TRUST_PROXY === "1" ? 1 : "loopback");

  app.locals.config = config;
  app.locals.database = database;
  app.locals.monitor = monitor;
  app.locals.danmakuCollector = danmakuCollector;
  app.locals.mediaProxy = mediaProxy;
  app.locals.bilibiliAuthClient = bilibiliAuthClient;
  app.locals.maintainBilibiliAuth = maintainBilibiliAuth;
  app.disable("x-powered-by");
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
  }));
  if (logger) app.use(morgan("dev"));
  app.use(express.json({ limit: "2mb" }));
  app.use((request, _response, next) => {
    if (!SAFE_HTTP_METHODS.has(request.method) && !requestMatchesOrigin(request)) {
      return next(httpError(403, "已拒绝来自其他站点的写入请求"));
    }
    return next();
  });
  app.use((request, response, next) => {
    try {
      config.read();
      cookieSession({
        name: "nyabililive_admin",
        keys: [config.value.security.session_secret],
        maxAge: 8 * 60 * 60 * 1000,
        httpOnly: true,
        sameSite: "strict",
        secure: request.secure,
      })(request, response, next);
    } catch (error) {
      next(error);
    }
  });
  app.use((request, _response, next) => {
    const parsed = decodeSignedJson(
      parseCookieHeader(request.get("cookie"))[CLAIM_COOKIE_NAME],
      config.value.security.session_secret,
    );
    request.roomClaims = parsed?.claims && typeof parsed.claims === "object" ? parsed.claims : {};
    next();
  });

  const claimedRooms = (request) => Object.entries(request.roomClaims || {}).map(([roomId, claim]) => ({
    room_id: Number(roomId),
    ...claim,
  }));
  const claimRecordForRoom = (request, roomId) => request.roomClaims?.[String(roomId)] || null;
  const setRoomClaimsCookie = (request, response, claims) => {
    if (!claims || !Object.keys(claims).length) {
      response.append("Set-Cookie", serializeCookie(CLAIM_COOKIE_NAME, "", {
        maxAge: 0,
        secure: request.secure,
      }));
      return;
    }
    response.append("Set-Cookie", serializeCookie(
      CLAIM_COOKIE_NAME,
      encodeSignedJson({ claims }, config.value.security.session_secret),
      { maxAge: CLAIM_COOKIE_MAX_AGE, secure: request.secure },
    ));
  };
  const pruneClaimChallenges = (session) => {
    const entries = Object.entries(session?.claim_challenges || {}).filter(([, challenge]) => (
      challenge?.issued_at && (Date.now() - new Date(challenge.issued_at).getTime()) < CLAIM_CHALLENGE_TTL
    ));
    return Object.fromEntries(entries.slice(-12));
  };
  const updateSessionData = (request, updater) => {
    const current = request.session || {};
    const nextValue = updater({ ...current });
    request.session = nextValue && Object.keys(nextValue).length ? nextValue : null;
  };
  const isRoomClaimed = (request, roomId) => Boolean(claimRecordForRoom(request, roomId));
  const roomAccessMode = (request, roomId) => (isAdminSession(request) ? "admin" : (isRoomClaimed(request, roomId) ? "claim" : "guest"));
  const canAccessRoomProtectedData = (request, roomId) => roomAccessMode(request, roomId) !== "guest";
  const requireRoomClaimOrAdmin = (request, response, next) => {
    if (isAdminSession(request)) return next();
    const roomId = Number(request.params.id);
    if (!roomId || !isRoomClaimed(request, roomId)) return next(httpError(401, "请先登录管理后台或认领这个直播间"));
    return next();
  };

  const requireAdmin = (request, _response, next) => {
    if (request.session?.username !== config.value.security.admin_username) {
      return next(httpError(401, "请先登录管理后台"));
    }
    return next();
  };
  const isAdminSession = (request) => request.session?.username === config.value.security.admin_username;
  const requireChangedAdminPassword = (request, response, next) => {
    requireAdmin(request, response, (error) => {
      if (error) return next(error);
      if (safeEqual(config.value.security.admin_password, DEFAULT_ADMIN_PASSWORD)) {
        return next(httpError(428, "请先修改默认管理员密码"));
      }
      return next();
    });
  };
  const requireRoomManagement = (request, response, next) => {
    requireAdmin(request, response, (error) => {
      if (error) return next(error);
      if (!config.value.features.admin_room_management) {
        return next(httpError(403, "配置已关闭房间增删改功能"));
      }
      return next();
    });
  };

  app.use(["/api/auth", "/api/admin"], (_request, response, next) => {
    response.set("Cache-Control", "no-store");
    response.set("Pragma", "no-cache");
    next();
  });

  app.get("/health", (_request, response) => {
    response.json({ status: "ok", database: database.counts() });
  });

  app.get("/api/config", (_request, response) => response.json(config.publicValue()));

  app.get("/api/media", async (request, response, next) => {
    let source;
    try {
      source = new URL(String(request.query.url || ""));
      const allowed = source.protocol === "https:"
        && (source.hostname === "hdslb.com" || source.hostname.endsWith(".hdslb.com"));
      if (!allowed) return next(httpError(400, "只允许代理 Bilibili 图片资源"));
      const asset = await mediaProxy.load(source.href);
      response.set("Content-Type", asset.contentType);
      response.set("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
      return response.send(asset.content);
    } catch (error) {
      if (!source) return next(httpError(400, "图片地址无效"));
      response.set("Referrer-Policy", "no-referrer");
      response.set("Cache-Control", "no-store");
      return response.redirect(307, source.href);
    }
  });

  app.get("/api/rooms", (_request, response, next) => {
    if (!config.value.features.public_room_directory) {
      return next(httpError(403, "公开房间目录已关闭"));
    }
    return response.json({ items: database.listRooms({ enabledOnly: true }) });
  });

  app.get("/api/rooms/:identifier", (request, response, next) => {
    const room = database.getRoom(request.params.identifier);
    if (!room) return next(httpError(404, "没有找到这个直播间"));
    return response.json({ ...room, sessions: database.listSessions(room.id) });
  });

  app.get("/api/rooms/:identifier/claim", (request, response, next) => {
    const room = database.getRoom(request.params.identifier);
    if (!room) return next(httpError(404, "没有找到这个直播间"));
    const activeSession = database.getActiveSessionForRoom(room.id);
    const claim = claimRecordForRoom(request, room.id);
    const managers = database.listRoomClaimManagers(room.id);
    return response.json({
      room_id: room.id,
      room_number: room.room_number,
      alias: room.alias || "",
      streamer_name: room.streamer_name,
      avatar_url: room.avatar_url,
      current_title: room.room_title || "",
      bili_uid: room.bili_uid ? String(room.bili_uid) : "",
      live_status: Number(room.live_status || 0),
      claim_prefix: `${CLAIM_CODE_PREFIX}${room.claim_key}-`,
      active_session_id: activeSession?.id || null,
      claim_manager_count: managers.length,
      claimed: Boolean(claim),
      claim: claim || null,
    });
  });

  app.post("/api/rooms/:identifier/claim/challenge", (request, response, next) => {
    const room = database.getRoom(request.params.identifier);
    if (!room) return next(httpError(404, "没有找到这个直播间"));
    const managers = database.listRoomClaimManagers(room.id);
    if (!managers.length) return next(httpError(409, "这个直播间还没有配置认领管理者 UID"));
    if (Number(room.live_status || 0) !== 1 || !database.getActiveSessionForRoom(room.id)) {
      return next(httpError(409, "当前未开播，暂时无法通过弹幕认领"));
    }
    const challenge = crypto.randomBytes(6).toString("base64").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6).padEnd(6, "0");
    const issuedAt = new Date().toISOString();
    const code = `${CLAIM_CODE_PREFIX}${room.claim_key}-${challenge}`;
    updateSessionData(request, (session) => ({
      ...session,
      claim_challenges: {
        ...pruneClaimChallenges(session),
        [String(room.id)]: {
          room_id: room.id,
          room_claim_key: room.claim_key,
          code,
          issued_at: issuedAt,
        },
      },
    }));
    return response.json({
      code,
      issued_at: issuedAt,
      expires_at: new Date(Date.now() + CLAIM_CHALLENGE_TTL).toISOString(),
    });
  });

  app.post("/api/rooms/:identifier/claim/verify", (request, response, next) => {
    const room = database.getRoom(request.params.identifier);
    if (!room) return next(httpError(404, "没有找到这个直播间"));
    const managers = database.listRoomClaimManagers(room.id);
    if (!managers.length) return next(httpError(409, "这个直播间还没有配置认领管理者 UID"));
    if (Number(room.live_status || 0) !== 1 || !database.getActiveSessionForRoom(room.id)) {
      return next(httpError(409, "当前未开播，暂时无法通过弹幕认领"));
    }
    const challenges = pruneClaimChallenges(request.session || {});
    const challenge = challenges[String(room.id)];
    if (!challenge || challenge.room_claim_key !== room.claim_key || !challenge.code?.startsWith(`${CLAIM_CODE_PREFIX}${room.claim_key}-`)) {
      return next(httpError(409, "认领码已失效，请重新生成"));
    }
    const matched = database.findActiveClaimDanmaku(room.id, challenge.code);
    if (!matched) {
      return next(httpError(404, "还没有在当前直播弹幕中找到来自已配置管理者 UID 的认领码"));
    }
    const claim = {
      uid: String(matched.bili_uid),
      username: matched.username,
      claimed_at: new Date().toISOString(),
      matched_at: matched.sent_at,
      room_number: room.room_number,
      alias: room.alias || "",
    };
    const claims = { ...(request.roomClaims || {}), [String(room.id)]: claim };
    request.roomClaims = claims;
    setRoomClaimsCookie(request, response, claims);
    delete challenges[String(room.id)];
    updateSessionData(request, (session) => ({
      ...session,
      claim_challenges: challenges,
    }));
    return response.json({ ok: true, claim });
  });

  app.get("/api/sessions/:id/summary", (request, response, next) => {
    const result = database.sessionSummary(Number(request.params.id));
    if (!result) return next(httpError(404, "场次不存在"));
    return response.json(result);
  });

  app.get("/api/sessions/:id/danmaku", (request, response) => {
    const limit = parsePositiveInt(request.query.limit, config.value.display.danmaku_page_size, 200);
    const offset = parsePositiveInt(request.query.offset, 0);
    const order = parseOption(request.query.order, ["asc", "desc"], "desc", "排序方向");
    const session = database.getSession(Number(request.params.id));
    response.json(database.listDanmaku(Number(request.params.id), {
      query: String(request.query.q || "").trim(),
      limit,
      offset,
      order,
      includeNotes: canAccessRoomProtectedData(request, session?.room_id),
    }));
  });

  app.get("/api/sessions/:id/gifts", (request, response) => {
    const session = database.getSession(Number(request.params.id));
    response.json(database.giftReport(Number(request.params.id), {
      includeNotes: canAccessRoomProtectedData(request, session?.room_id),
    }));
  });

  app.get("/api/sessions/:id/viewers", (request, response) => {
    const limit = parsePositiveInt(request.query.limit, 100, 200);
    const offset = parsePositiveInt(request.query.offset, 0);
    const sortBy = parseOption(request.query.sort, ["first_entered_at", "last_entered_at"], "last_entered_at", "排序字段");
    const order = parseOption(request.query.order, ["asc", "desc"], "desc", "排序方向");
    const session = database.getSession(Number(request.params.id));
    response.json(database.listViewers(Number(request.params.id), {
      minMessages: parsePositiveInt(request.query.min_messages, 0),
      query: String(request.query.q || "").trim(),
      limit,
      offset,
      sortBy,
      order,
      includeNotes: canAccessRoomProtectedData(request, session?.room_id),
    }));
  });

  app.post("/api/auth/login", (request, response, next) => {
    const credentials = loginSchema.parse(request.body);
    const security = config.value.security;
    if (!safeEqual(credentials.username, security.admin_username)
      || !safeEqual(credentials.password, security.admin_password)) {
      return next(httpError(401, "用户名或密码不正确"));
    }
    updateSessionData(request, (session) => ({ ...session, username: security.admin_username }));
    return response.json({
      username: security.admin_username,
      must_change_password: safeEqual(security.admin_password, DEFAULT_ADMIN_PASSWORD),
    });
  });

  app.post("/api/auth/logout", (request, response) => {
    updateSessionData(request, (session) => {
      delete session.username;
      return session;
    });
    response.json({ ok: true });
  });

  app.get("/api/auth/me", (request, response) => {
    const username = request.session?.username;
    const adminAuthenticated = isAdminSession(request);
    const roomClaims = claimedRooms(request);
    const authenticated = adminAuthenticated || roomClaims.length > 0;
    response.json({
      authenticated,
      auth_mode: adminAuthenticated ? "admin" : (roomClaims.length ? "claim" : "guest"),
      username: adminAuthenticated ? username : (roomClaims[0]?.username || null),
      must_change_password: adminAuthenticated && safeEqual(config.value.security.admin_password, DEFAULT_ADMIN_PASSWORD),
      room_claims: roomClaims,
    });
  });

  app.post("/api/auth/change-password", requireAdmin, (request, response, next) => {
    const passwords = changePasswordSchema.parse(request.body);
    const security = config.value.security;
    if (!safeEqual(passwords.current_password, security.admin_password)) {
      return next(httpError(401, "当前密码不正确"));
    }
    if (safeEqual(passwords.new_password, security.admin_password)) {
      return next(httpError(400, "新密码不能与当前密码相同"));
    }
    if (safeEqual(passwords.new_password, DEFAULT_ADMIN_PASSWORD)) {
      return next(httpError(400, "不能继续使用默认管理员密码"));
    }
    config.save({
      ...config.value,
      security: { ...security, admin_password: passwords.new_password },
    });
    updateSessionData(request, (session) => ({ ...session, username: security.admin_username }));
    return response.json({ username: security.admin_username, must_change_password: false });
  });

  app.use("/api/admin", requireChangedAdminPassword);

  app.get("/api/admin/config", requireAdmin, (_request, response) => response.json(config.value));
  app.put("/api/admin/config", requireAdmin, (request, response) => {
    if (safeEqual(request.body?.security?.admin_password, DEFAULT_ADMIN_PASSWORD)) {
      throw httpError(400, "不能恢复默认管理员密码");
    }
    const saved = config.save(request.body);
    monitor.restart();
    danmakuCollector.restart();
    response.json(saved);
  });

  app.get("/api/admin/monitor", requireAdmin, (_request, response) => response.json({
    ...monitor.status(),
    danmaku: danmakuCollector.status(),
  }));

  app.post("/api/admin/bilibili-auth/qr", requireAdmin, async (_request, response) => {
    response.json(await bilibiliAuthClient.createQrLogin());
  });

  app.get("/api/admin/bilibili-auth/qr/:key", requireAdmin, async (request, response) => {
    const result = await bilibiliAuthClient.pollQrLogin(String(request.params.key), "");
    if (result.status === "confirmed") {
      config.save({
        ...config.value,
        security: {
          ...config.value.security,
          bilibili_cookie: result.cookie,
          bilibili_web_refresh_token: result.web_refresh_token || "",
          bilibili_app_access_key: "",
          bilibili_app_refresh_token: "",
          bilibili_app_expires_at: "",
        },
      });
      danmakuCollector.restart();
      return response.json({ status: result.status, message: "登录成功", profile: result.profile });
    }
    return response.json(result);
  });

  app.post("/api/admin/bilibili-auth/app-qr", requireAdmin, async (_request, response) => {
    response.json(await bilibiliAuthClient.createAppQrLogin());
  });

  app.get("/api/admin/bilibili-auth/app-qr/:key", requireAdmin, async (request, response) => {
    const result = await bilibiliAuthClient.pollAppQrLogin(String(request.params.key), "");
    if (result.status === "confirmed") {
      config.save({
        ...config.value,
        security: {
          ...config.value.security,
          bilibili_cookie: result.cookie,
          bilibili_web_refresh_token: "",
          bilibili_app_access_key: result.app_access_key,
          bilibili_app_refresh_token: result.app_refresh_token,
          bilibili_app_expires_at: result.app_expires_at,
        },
      });
      danmakuCollector.restart();
      return response.json({ status: result.status, message: "APP 登录成功", profile: result.profile, expires_at: result.app_expires_at });
    }
    return response.json(result);
  });

  app.post("/api/admin/bilibili-auth/verify", requireAdmin, async (_request, response) => {
    const result = await bilibiliAuthClient.refreshCredentials(config.value.security.bilibili_cookie);
    config.save({
      ...config.value,
      security: { ...config.value.security, bilibili_cookie: result.cookie },
    });
    danmakuCollector.restart();
    response.json(result.profile);
  });

  app.post("/api/admin/bilibili-auth/cookie-refresh", requireAdmin, async (_request, response) => {
    response.json(await maintainBilibiliAuth());
  });

  app.post("/api/admin/danmaku/restart", requireAdmin, (_request, response) => {
    danmakuCollector.restart();
    response.json({ ok: true, danmaku: danmakuCollector.status() });
  });

  app.put("/api/rooms/:id/viewer-notes/:uid", requireRoomClaimOrAdmin, (request, response, next) => {
    const saved = database.saveRoomUserNote(
      Number(request.params.id),
      String(request.params.uid),
      viewerNoteUpdateSchema.parse(request.body).note,
    );
    if (!saved) return next(httpError(404, "房间或用户不存在"));
    return response.json(saved);
  });

  app.get("/api/admin/rooms", requireAdmin, (_request, response) => {
    response.json({
      items: database.listRooms(),
      management_enabled: config.value.features.admin_room_management,
    });
  });

  app.post("/api/admin/rooms", requireRoomManagement, async (request, response) => {
    let room = database.createRoom(roomCreateSchema.parse(request.body));
    try {
      room = (await monitor.syncRoom(room.id)).room;
    } catch {
      room = database.getRoomById(room.id);
    }
    response.status(201).json(room);
  });

  app.patch("/api/admin/rooms/:id", requireRoomManagement, (request, response, next) => {
    const result = database.updateRoom(Number(request.params.id), roomUpdateSchema.parse(request.body));
    if (!result) return next(httpError(404, "房间不存在"));
    return response.json(result);
  });

  const getRoomClaimManagers = (request, response, next) => {
    const room = database.getRoomById(Number(request.params.id));
    if (!room) return next(httpError(404, "房间不存在"));
    const items = database.listRoomClaimManagers(room.id);
    return response.json({
      room_id: room.id,
      room_number: room.room_number,
      alias: room.alias || "",
      streamer_name: room.streamer_name,
      bili_uid: room.bili_uid ? String(room.bili_uid) : "",
      items,
    });
  };

  const updateRoomClaimManagers = (request, response, next) => {
    const room = database.getRoomById(Number(request.params.id));
    if (!room) return next(httpError(404, "房间不存在"));
    const items = database.replaceRoomClaimManagers(room.id, roomClaimManagersUpdateSchema.parse(request.body).uids);
    return response.json({
      room_id: room.id,
      items,
      enforced_uid: room.bili_uid ? String(room.bili_uid) : "",
    });
  };

  app.get(["/api/admin/rooms/:id/claim-managers", "/api/admin/rooms/:id/managers"], requireAdmin, getRoomClaimManagers);
  app.put(["/api/admin/rooms/:id/claim-managers", "/api/admin/rooms/:id/managers"], requireRoomManagement, updateRoomClaimManagers);

  app.post("/api/admin/rooms/:id/reorder", requireRoomManagement, (request, response, next) => {
    const direction = parseOption(request.body?.direction, ["up", "down"], "", "移动方向");
    const result = database.moveRoom(Number(request.params.id), direction);
    if (!result) return next(httpError(404, "房间不存在"));
    return response.json({ room: result, items: database.listRooms() });
  });

  app.delete("/api/admin/rooms/:id", requireRoomManagement, (request, response, next) => {
    if (request.query.confirm !== "true") return next(httpError(400, "删除房间需要 confirm=true"));
    if (!database.deleteRoom(Number(request.params.id))) return next(httpError(404, "房间不存在"));
    return response.json({ ok: true });
  });

  app.post("/api/admin/rooms/:id/sync", requireAdmin, async (request, response) => {
    const result = await monitor.syncRoom(Number(request.params.id));
    danmakuCollector.reconcile();
    response.json(result);
  });

  app.post("/api/admin/rooms/:id/sessions", requireAdmin, (request, response) => {
    const result = database.createSession(Number(request.params.id), sessionCreateSchema.parse(request.body));
    response.status(201).json(result);
  });

  app.patch("/api/admin/sessions/:id", requireAdmin, (request, response, next) => {
    const result = database.updateSession(Number(request.params.id), sessionUpdateSchema.parse(request.body));
    if (!result) return next(httpError(404, "场次不存在"));
    return response.json(result);
  });

  app.post("/api/ingest", (request, response, next) => {
    const token = String(request.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token || !safeEqual(token, config.value.security.ingest_token)) {
      return next(httpError(401, "采集令牌无效"));
    }
    return response.status(201).json(database.ingest(ingestEventSchema.parse(request.body)));
  });

  app.use("/api", (_request, _response, next) => next(httpError(404, "API 路由不存在")));
  app.all(["/config.json", "/.env"], (_request, _response, next) => next(httpError(404, "页面不存在")));
  app.use(express.static(staticDirectory, { index: false, maxAge: 0 }));
  app.get(["/admin", "/login"], (_request, response) => response.sendFile(path.join(staticDirectory, "console.html")));
  app.get("/claim/:identifier", (_request, response) => response.sendFile(path.join(staticDirectory, "claim.html")));
  app.get(["/", "/:identifier"], (_request, response) => response.sendFile(path.join(staticDirectory, "public.html")));
  app.use((_request, _response, next) => next(httpError(404, "页面不存在")));

  app.use((error, _request, response, _next) => {
    if (error instanceof ZodError) {
      const detail = error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("；");
      return response.status(400).json({ error: `数据校验失败：${detail}` });
    }
    if (typeof error.code === "string" && error.code.startsWith("SQLITE_CONSTRAINT")) {
      const message = error.code === "SQLITE_CONSTRAINT_FOREIGNKEY"
        ? "关联的房间或场次不存在"
        : "房间号、别名或记录标识已存在";
      return response.status(409).json({ error: message });
    }
    if (logger && (!error.status || error.status >= 500)) console.error(error);
    return response.status(error.status || 500).json({ error: error.status ? error.message : "服务器处理请求时发生错误" });
  });

  return app;
}

export function startServer(options = {}) {
  const app = createApp(options);
  const config = app.locals.config.value;
  const host = environment.HOST || config.app.host;
  const port = Number(environment.PORT || config.app.port);
  const server = app.listen(port, host, () => {
    console.log(`NyaBiliLive running at http://${host}:${port}`);
    app.locals.monitor.start();
    app.locals.danmakuCollector.start();
    void app.locals.maintainBilibiliAuth().catch((error) => console.warn(`[bilibili-auth] ${error.message}`));
  });
  const authMaintenanceTimer = setInterval(() => {
    void app.locals.maintainBilibiliAuth().catch((error) => console.warn(`[bilibili-auth] ${error.message}`));
  }, 24 * 60 * 60 * 1000);
  authMaintenanceTimer.unref?.();
  server.on("close", () => {
    app.locals.monitor.stop();
    app.locals.danmakuCollector.stop();
    clearInterval(authMaintenanceTimer);
  });
  return { app, server };
}

const isEntryPoint = argumentsList[1] && path.resolve(argumentsList[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) startServer();
