import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../server/index.js";

const projectConfig = path.resolve("config.example.json");
let directory;
let app;
let agent;
let bilibiliSnapshot;
let danmakuConnections;
const defaultAdminPassword = "nya123nya321";
const testAdminPassword = "test-admin-password-2026";

async function loginAdmin() {
  const login = await agent.post("/api/auth/login")
    .send({ username: "admin", password: defaultAdminPassword })
    .expect(200);
  assert.equal(login.body.must_change_password, true);
  await agent.post("/api/auth/change-password").send({
    current_password: defaultAdminPassword,
    new_password: testAdminPassword,
    confirm_password: testAdminPassword,
  }).expect(200);
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "nyabililive-"));
  const configPath = path.join(directory, "config.json");
  fs.copyFileSync(projectConfig, configPath);
  bilibiliSnapshot = null;
  danmakuConnections = [];
  app = createApp({
    databasePath: path.join(directory, "test.db"),
    configPath,
    seed: true,
    logger: false,
    bilibiliClient: {
      async fetchRoomSnapshot(roomNumber) {
        if (!bilibiliSnapshot) throw new Error("mock sync unavailable");
        return { room_number: String(roomNumber), ...bilibiliSnapshot };
      },
    },
    bilibiliAuthClient: {
      async createQrLogin() {
        return { key: "mock-qr-key", image: "data:image/png;base64,bW9jaw==" };
      },
      async createAppQrLogin() {
        return { key: "mock-app-key", image: "data:image/png;base64,YXBw" };
      },
      async pollQrLogin(key) {
        assert.equal(key, "mock-qr-key");
        return {
          status: "confirmed",
          cookie: "SESSDATA=long-session; DedeUserID=24680; buvid3=mock-buvid",
          profile: { uid: "24680", username: "扫码测试账号", avatar_url: "" },
        };
      },
      async verifyCookie(cookie) {
        assert.match(cookie, /SESSDATA=long-session/);
        return { uid: "24680", username: "扫码测试账号", avatar_url: "" };
      },
      async pollAppQrLogin(key) {
        assert.equal(key, "mock-app-key");
        return {
          status: "confirmed",
          cookie: "SESSDATA=app-session; DedeUserID=24680; buvid3=app-buvid",
          profile: { uid: "24680", username: "APP 测试账号", avatar_url: "" },
          app_access_key: "app-access-secret",
          app_refresh_token: "app-refresh-secret",
          app_expires_at: "2027-01-13T00:00:00.000Z",
        };
      },
      async refreshWebCookie(cookie, refreshToken) {
        return { status: "fresh", message: "Cookie 暂不需要刷新", cookie, web_refresh_token: refreshToken };
      },
      async refreshCredentials(cookie) {
        assert.match(cookie, /SESSDATA=long-session/);
        return {
          cookie: cookie.includes("buvid3=") ? cookie : `${cookie}; buvid3=mock-buvid`,
          profile: { uid: "24680", username: "扫码测试账号", avatar_url: "" },
        };
      },
    },
    danmakuListenerFactory(roomNumber, handler, options) {
      const instance = { roomNumber, handler, options, closed: false, close() { this.closed = true; } };
      danmakuConnections.push(instance);
      return instance;
    },
  });
  agent = request.agent(app);
});

afterEach(() => {
  app.locals.danmakuCollector.stop();
  app.locals.database.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("public archive", () => {
  test("serves the room path and seeded archive data", async () => {
    await request(app).get("/nya").expect(200).expect("Content-Type", /html/);
    await request(app).get("/config.json").expect(404);
    await request(app).get("/.env").expect(404);
    const room = await request(app).get("/api/rooms/nya").expect(200);
    assert.equal(room.body.room_number, "21452505");
    assert.equal(room.body.sessions.length, 3);

    const live = room.body.sessions.find((session) => session.status === "live");
    const summary = await request(app).get(`/api/sessions/${live.id}/summary`).expect(200);
    assert.ok(summary.body.stats.danmaku_count > 0);
    assert.ok(summary.body.stats.gift_revenue > 0);
  });

  test("filters audience by message count", async () => {
    const room = await request(app).get("/api/rooms/nya").expect(200);
    const sessionId = room.body.sessions[0].id;
    const everyone = await request(app).get(`/api/sessions/${sessionId}/viewers?min_messages=0`).expect(200);
    const active = await request(app).get(`/api/sessions/${sessionId}/viewers?min_messages=5`).expect(200);
    assert.ok(everyone.body.total > active.body.total);
    assert.ok(active.body.items.every((user) => user.message_count >= 5));

    const firstAscending = await request(app).get(`/api/sessions/${sessionId}/viewers?sort=first_entered_at&order=asc&limit=200`).expect(200);
    assert.equal(firstAscending.body.sort_by, "first_entered_at");
    assert.equal(firstAscending.body.order, "asc");
    assert.ok(firstAscending.body.items.every((item, index, items) => index === 0 || items[index - 1].first_entered_at <= item.first_entered_at));

    const recentDescending = await request(app).get(`/api/sessions/${sessionId}/viewers?sort=last_entered_at&order=desc&limit=200`).expect(200);
    assert.ok(recentDescending.body.items.every((item, index, items) => index === 0 || items[index - 1].last_entered_at >= item.last_entered_at));
  });

  test("orders danmaku and returns the complete gift history", async () => {
    const room = await request(app).get("/api/rooms/nya").expect(200);
    const sessionId = room.body.sessions[0].id;
    const ascending = await request(app).get(`/api/sessions/${sessionId}/danmaku?order=asc&limit=200`).expect(200);
    const descending = await request(app).get(`/api/sessions/${sessionId}/danmaku?order=desc&limit=200`).expect(200);
    assert.equal(ascending.body.items[0].sent_at, descending.body.items.at(-1).sent_at);
    assert.equal(descending.body.items[0].sent_at, ascending.body.items.at(-1).sent_at);

    const gifts = await request(app).get(`/api/sessions/${sessionId}/gifts`).expect(200);
    assert.equal(gifts.body.history.length, gifts.body.history_total);
    assert.ok(gifts.body.history.every((item) => item.username && item.gift_name));
    assert.ok(gifts.body.history.every((item, index, items) => index === 0 || items[index - 1].received_at >= item.received_at));
  });
});

describe("administration and ingestion", () => {
  test("rotates placeholder secrets and rejects cross-site writes", async () => {
    const security = app.locals.config.value.security;
    assert.notEqual(security.ingest_token, "replace-with-a-long-random-token");
    assert.notEqual(security.session_secret, "replace-with-a-long-random-secret");
    assert.ok(security.ingest_token.length >= 40);
    assert.ok(security.session_secret.length >= 40);

    const saved = JSON.parse(fs.readFileSync(app.locals.config.filePath, "utf8"));
    assert.equal(saved.security.ingest_token, security.ingest_token);
    assert.equal(saved.security.session_secret, security.session_secret);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(app.locals.config.filePath).mode & 0o777, 0o600);
    }

    const rotatedAgain = app.locals.config.save({
      ...app.locals.config.value,
      security: {
        ...app.locals.config.value.security,
        ingest_token: "replace-with-a-long-random-token",
        session_secret: "replace-with-a-long-random-secret",
      },
    });
    assert.notEqual(rotatedAgain.security.ingest_token, "replace-with-a-long-random-token");
    assert.notEqual(rotatedAgain.security.session_secret, "replace-with-a-long-random-secret");

    const login = await agent.post("/api/auth/login")
      .send({ username: "admin", password: defaultAdminPassword })
      .expect(200);
    assert.match(login.headers["set-cookie"].join(";"), /samesite=strict/i);

    const proxiedLogin = await request(app).post("/api/auth/login")
      .set("Host", "live.example.test")
      .set("Origin", "https://live.example.test")
      .set("Sec-Fetch-Site", "same-origin")
      .set("X-Forwarded-Proto", "https")
      .send({ username: "admin", password: defaultAdminPassword })
      .expect(200);
    assert.match(proxiedLogin.headers["set-cookie"].join(";"), /secure/i);

    await request(app).post("/api/auth/login")
      .set("Host", "live.example.test")
      .set("Origin", "https://live.example.test")
      .send({ username: "admin", password: defaultAdminPassword })
      .expect(200);

    await agent.post("/api/auth/logout")
      .set("Origin", "https://attacker.example")
      .set("Sec-Fetch-Site", "cross-site")
      .send({})
      .expect(403);
  });

  test("requires login and creates a room and session", async () => {
    await agent.get("/api/admin/rooms").expect(401);
    await agent.post("/api/auth/login").send({ username: "admin", password: "wrong" }).expect(401);
    const login = await agent.post("/api/auth/login").send({ username: "admin", password: defaultAdminPassword }).expect(200);
    assert.equal(login.body.must_change_password, true);
    await agent.get("/api/admin/rooms").expect(428);
    await agent.post("/api/auth/change-password").send({ current_password: defaultAdminPassword, new_password: "short", confirm_password: "short" }).expect(400);
    await agent.post("/api/auth/change-password").send({ current_password: defaultAdminPassword, new_password: testAdminPassword, confirm_password: testAdminPassword }).expect(200);

    const created = await agent.post("/api/admin/rooms").send({
      room_number: "123456",
      alias: "test-room",
      streamer_name: "测试直播间",
      avatar_url: "",
      description: "测试",
      enabled: true,
    }).expect(201);
    assert.equal(created.body.alias, "test-room");

    const session = await agent.post(`/api/admin/rooms/${created.body.id}/sessions`).send({
      title: "测试场次",
      area: "聊天电台",
      parent_area: "娱乐",
      status: "live",
      peak_popularity: 0,
      cover_url: "",
      note: "",
    }).expect(201);
    assert.equal(session.body.title, "测试场次");
  });

  test("validates ingest tokens and updates reports", async () => {
    const room = await request(app).get("/api/rooms/nya").expect(200);
    const sessionId = room.body.sessions[0].id;
    const event = {
      type: "danmaku",
      session_id: sessionId,
      user: { uid: "new-user", username: "新观众", avatar_url: "", guard_level: 0 },
      content: "这是一条新弹幕",
      medal_name: "",
      medal_level: 0,
    };
    await request(app).post("/api/ingest").send(event).expect(401);
    await request(app).post("/api/ingest")
      .set("Authorization", `Bearer ${app.locals.config.value.security.ingest_token}`)
      .send(event).expect(201);
    const result = await request(app).get(`/api/sessions/${sessionId}/danmaku?q=${encodeURIComponent("新弹幕")}`).expect(200);
    assert.equal(result.body.total, 1);
  });

  test("collects WebSocket danmaku, entries and gifts into the active session", async () => {
    bilibiliSnapshot = {
      bili_uid: "778899",
      streamer_name: "弹幕采集测试主播",
      avatar_url: "",
      live_status: 1,
      title: "弹幕采集测试场次",
      cover_url: "",
      area: "聊天电台",
      parent_area: "娱乐",
      live_time: "2026-07-16T12:00:00.000Z",
      attention: 1024,
      online: 256,
    };
    await loginAdmin();
    const created = await agent.post("/api/admin/rooms").send({
      room_number: "7788",
      alias: "collector-test",
      streamer_name: "",
      avatar_url: "",
      description: "",
      enabled: true,
    }).expect(201);
    const room = await request(app).get("/api/rooms/collector-test").expect(200);
    const session = room.body.sessions.find((item) => item.status === "live");
    app.locals.danmakuCollector.reconcile();

    const connection = danmakuConnections.find((item) => String(item.roomNumber) === "7788");
    assert.ok(connection);
    assert.equal(connection.options.ws.uid, 0);
    connection.handler.onOpen();
    connection.handler.onStartListen();

    const user = { uid: 778899, uname: "采集测试观众", face: "", identity: { guard_level: 0 } };
    connection.handler.onUserAction({ id: "enter-1", timestamp: 1_752_688_100_000, body: { action: "enter", timestamp: 1_752_688_100_000, user } });
    connection.handler.onIncomeDanmu({ id: "danmaku-1", timestamp: 1_752_688_101_000, body: { timestamp: 1_752_688_101_000, user, content: "WebSocket 采集成功" } });
    connection.handler.onGift({ id: "gift-1", timestamp: 1_752_688_102_000, body: { user, gift_name: "小花花", coin_type: "gold", price: 1000, amount: 2 } });

    const danmaku = await request(app).get(`/api/sessions/${session.id}/danmaku?q=${encodeURIComponent("WebSocket 采集成功")}`).expect(200);
    assert.equal(danmaku.body.total, 1);
    const viewers = await request(app).get(`/api/sessions/${session.id}/viewers?q=${encodeURIComponent("采集测试观众")}`).expect(200);
    assert.equal(viewers.body.total, 1);
    assert.equal(viewers.body.items[0].message_count, 1);
    assert.equal(viewers.body.items[0].entry_count, 1);
    assert.equal(viewers.body.items[0].first_entered_at, new Date(1_752_688_100_000).toISOString());
    assert.equal(viewers.body.items[0].last_entered_at, new Date(1_752_688_100_000).toISOString());
    const gifts = await request(app).get(`/api/sessions/${session.id}/gifts`).expect(200);
    assert.equal(gifts.body.gifts.find((item) => item.gift_name === "小花花").total_value, 2);

    const monitor = await agent.get("/api/admin/monitor").expect(200);
    const status = monitor.body.danmaku.rooms.find((item) => item.room_number === "7788");
    assert.equal(status.status, "listening");
    assert.equal(status.message_count, 3);
  });

  test("configuration switch disables room mutations", async () => {
    await loginAdmin();
    const config = await agent.get("/api/admin/config").expect(200);
    config.body.features.admin_room_management = false;
    await agent.put("/api/admin/config").send(config.body).expect(200);
    await agent.post("/api/admin/rooms").send({
      room_number: "999",
      streamer_name: "不可创建",
      alias: "",
      avatar_url: "",
      description: "",
      enabled: true,
    }).expect(403);
  });

  test("stores QR login credentials and uses the authenticated danmaku identity", async () => {
    await loginAdmin();
    const qr = await agent.post("/api/admin/bilibili-auth/qr").send({}).expect(200);
    assert.equal(qr.body.key, "mock-qr-key");
    assert.match(qr.body.image, /^data:image\/png/);
    const login = await agent.get("/api/admin/bilibili-auth/qr/mock-qr-key").expect(200);
    assert.equal(login.body.status, "confirmed");
    assert.equal(login.body.profile.username, "扫码测试账号");
    assert.equal(login.body.cookie, undefined);

    const config = await agent.get("/api/admin/config").expect(200);
    assert.match(config.body.security.bilibili_cookie, /DedeUserID=24680/);
    const verified = await agent.post("/api/admin/bilibili-auth/verify").send({}).expect(200);
    assert.equal(verified.body.uid, "24680");
    const monitor = await agent.get("/api/admin/monitor").expect(200);
    assert.deepEqual(monitor.body.danmaku.auth, {
      mode: "authenticated",
      uid: "24680",
      buvid_configured: true,
      sessdata_configured: true,
      app_configured: false,
      app_expires_at: null,
    });
    const restarted = await agent.post("/api/admin/danmaku/restart").send({}).expect(200);
    assert.equal(restarted.body.ok, true);

    bilibiliSnapshot = {
      bili_uid: "99", streamer_name: "登录采集测试", avatar_url: "", live_status: 1,
      title: "登录连接", cover_url: "", area: "聊天", parent_area: "娱乐",
      live_time: "2026-07-17T00:00:00.000Z", attention: 1, online: 1,
    };
    await agent.post("/api/admin/rooms").send({
      room_number: "2468", alias: "auth-room", streamer_name: "", avatar_url: "",
      description: "", enabled: true,
    }).expect(201);
    app.locals.danmakuCollector.reconcile();
    const connection = danmakuConnections.find((item) => String(item.roomNumber) === "2468");
    assert.equal(connection.options.ws.uid, 24680);
    assert.equal(connection.options.ws.buvid, "mock-buvid");
    assert.match(connection.options.ws.headers.Cookie, /SESSDATA=long-session/);

    const appQr = await agent.post("/api/admin/bilibili-auth/app-qr").send({}).expect(200);
    assert.equal(appQr.body.key, "mock-app-key");
    const appLogin = await agent.get("/api/admin/bilibili-auth/app-qr/mock-app-key").expect(200);
    assert.equal(appLogin.body.status, "confirmed");
    assert.equal(appLogin.body.profile.username, "APP 测试账号");
    assert.equal(appLogin.body.app_access_key, undefined);
    assert.equal(appLogin.body.app_refresh_token, undefined);
    const appConfig = await agent.get("/api/admin/config").expect(200);
    assert.equal(appConfig.body.security.bilibili_app_access_key, "app-access-secret");
    assert.equal(appConfig.body.security.bilibili_app_refresh_token, "app-refresh-secret");
    const appMonitor = await agent.get("/api/admin/monitor").expect(200);
    assert.equal(appMonitor.body.danmaku.auth.app_configured, true);
    assert.equal(appMonitor.body.danmaku.auth.app_expires_at, "2027-01-13T00:00:00.000Z");
    const refresh = await agent.post("/api/admin/bilibili-auth/cookie-refresh").send({}).expect(200);
    assert.equal(refresh.body.status, "fresh");
  });

  test("synchronizes room metadata and manages the live session lifecycle", async () => {
    bilibiliSnapshot = {
      bili_uid: "778899",
      streamer_name: "自动同步主播",
      avatar_url: "https://example.com/avatar.jpg",
      live_status: 1,
      title: "自动获取的直播标题",
      cover_url: "https://example.com/cover.jpg",
      area: "视频唱见",
      parent_area: "娱乐",
      live_time: "2026-07-16T12:00:00.000Z",
      online: 4567,
    };
    await loginAdmin();
    const created = await agent.post("/api/admin/rooms").send({
      room_number: "7788",
      alias: "auto-room",
      streamer_name: "",
      avatar_url: "",
      description: "",
      enabled: true,
    }).expect(201);
    assert.equal(created.body.streamer_name, "自动同步主播");
    assert.equal(created.body.live_status, 1);

    const room = await request(app).get("/api/rooms/auto-room").expect(200);
    assert.equal(room.body.sessions.length, 1);
    assert.equal(room.body.sessions[0].title, "自动获取的直播标题");
    assert.equal(room.body.sessions[0].status, "live");

    bilibiliSnapshot = { ...bilibiliSnapshot, live_status: 0, online: 0 };
    await agent.post(`/api/admin/rooms/${created.body.id}/sync`).send({}).expect(200);
    const ended = await request(app).get("/api/rooms/auto-room").expect(200);
    assert.equal(ended.body.sessions[0].status, "ended");
    assert.ok(ended.body.sessions[0].ended_at);
  });
});
