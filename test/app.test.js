import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../server/index.js";
import { ArchiveDatabase } from "../server/database.js";
import { fetchBilibiliUserProfiles } from "../server/bilibili-profile.js";

const projectConfig = path.resolve("config.example.json");
let directory;
let app;
let agent;
let bilibiliSnapshot;
let danmakuConnections;
let profileRequests;
let profileResponse;
let mediaFetchCalls;
let mediaFetchImpl;
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
  profileRequests = [];
  profileResponse = [];
  mediaFetchCalls = 0;
  mediaFetchImpl = async () => new Response(Buffer.from([137, 80, 78, 71]), {
    headers: { "Content-Type": "image/png" },
  });
  app = createApp({
    databasePath: path.join(directory, "test.db"),
    configPath,
    seed: "demo",
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
      async pollQrLogin(key, existingCookie) {
        assert.equal(key, "mock-qr-key");
        assert.equal(existingCookie, "");
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
      async pollAppQrLogin(key, existingCookie) {
        assert.equal(key, "mock-app-key");
        assert.equal(existingCookie, "");
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
    async bilibiliUserProfileFetcher(uids) {
      profileRequests.push([...uids]);
      return profileResponse.filter((profile) => uids.includes(String(profile.uid)));
    },
    mediaFetch(...argumentsList) {
      mediaFetchCalls += 1;
      return mediaFetchImpl(...argumentsList);
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
  test("seeds the production database with the default room and test sessions", () => {
    const database = new ArchiveDatabase(path.join(directory, "production-seed.db"), { seed: true });
    const rooms = database.listRooms();
    assert.equal(rooms.length, 1);
    assert.equal(rooms[0].room_number, "9213049");
    assert.equal(rooms[0].alias, "naya");
    assert.equal(rooms[0].avatar_url, "");
    assert.equal(rooms[0].description, "柳柳的直播间");
    assert.equal(database.counts().live_sessions, 3);
    assert.ok(database.listSessions(rooms[0].id).every((session) => session.title.startsWith("测试场次") && session.status === "ended"));
    database.close();
  });

  test("serves the room path and seeded archive data", async () => {
    await request(app).get("/naya").expect(200).expect("Content-Type", /html/);
    await request(app).get("/config.json").expect(404);
    await request(app).get("/.env").expect(404);
    const room = await request(app).get("/api/rooms/naya").expect(200);
    assert.equal(room.body.room_number, "9213049");
    assert.equal(room.body.sessions.length, 3);

    const sample = room.body.sessions[0];
    const summary = await request(app).get(`/api/sessions/${sample.id}/summary`).expect(200);
    assert.ok(summary.body.stats.danmaku_count > 0);
    assert.ok(summary.body.stats.gift_revenue > 0);
  });

  test("caches proxied media and falls back to the Bilibili CDN after a timeout", async () => {
    const source = "https://i0.hdslb.com/bfs/face/avatar-test.png";
    mediaFetchImpl = async () => {
      if (mediaFetchCalls === 1) throw new Error("temporary fetch failure");
      return new Response(Buffer.from([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } });
    };
    await request(app).get(`/api/media?url=${encodeURIComponent(source)}`).expect(200).expect("Content-Type", /image\/png/);
    await request(app).get(`/api/media?url=${encodeURIComponent(source)}`).expect(200);
    assert.equal(mediaFetchCalls, 2);

    mediaFetchImpl = async () => { throw Object.assign(new Error("request timed out"), { name: "TimeoutError", code: 23 }); };
    const fallbackSource = "https://i1.hdslb.com/bfs/face/fallback.png";
    const fallback = await request(app).get(`/api/media?url=${encodeURIComponent(fallbackSource)}`).expect(307);
    assert.equal(fallback.headers.location, fallbackSource);
    assert.equal(fallback.headers["referrer-policy"], "no-referrer");
  });

  test("requests batched user avatars from the authenticated VC endpoint", async () => {
    let captured;
    const profiles = await fetchBilibiliUserProfiles(["2", "3", "2", "guest:test"], {
      cookie: "SESSDATA=test-session",
      async fetchImpl(url, options) {
        captured = { url: String(url), cookie: options.headers.Cookie };
        return new Response(JSON.stringify({
          code: 0,
          data: [{ mid: 2, name: "测试用户", face: "https://i0.hdslb.com/bfs/face/test.jpg" }],
        }), { headers: { "Content-Type": "application/json" } });
      },
    });
    assert.equal(new URL(captured.url).hostname, "api.vc.bilibili.com");
    assert.equal(new URL(captured.url).searchParams.get("uids"), "2,3");
    assert.equal(captured.cookie, "SESSDATA=test-session");
    assert.deepEqual(profiles, [{ uid: "2", username: "测试用户", avatar_url: "https://i0.hdslb.com/bfs/face/test.jpg" }]);
  });

  test("filters audience by message count", async () => {
    const room = await request(app).get("/api/rooms/naya").expect(200);
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

  test("stores room-specific viewer notes and hides them from anonymous viewers", async () => {
    await loginAdmin();
    const room = await request(app).get("/api/rooms/naya").expect(200);
    const sessionId = room.body.sessions[0].id;
    const targetViewer = (await request(app).get(`/api/sessions/${sessionId}/viewers?min_messages=0&limit=1`).expect(200)).body.items[0];
    const targetDanmaku = (await request(app).get(`/api/sessions/${sessionId}/danmaku?limit=1`).expect(200)).body.items[0];
    const targetGift = (await request(app).get(`/api/sessions/${sessionId}/gifts`).expect(200)).body.history[0];

    await request(app)
      .put(`/api/rooms/${room.body.id}/viewer-notes/${encodeURIComponent(targetViewer.bili_uid)}`)
      .send({ note: "熟客" })
      .expect(401);

    const saved = await agent
      .put(`/api/rooms/${room.body.id}/viewer-notes/${encodeURIComponent(targetViewer.bili_uid)}`)
      .send({ note: "熟客" })
      .expect(200);
    assert.equal(saved.body.note, "熟客");

    const anonymous = await request(app).get(`/api/sessions/${sessionId}/viewers?min_messages=0&limit=1`).expect(200);
    assert.equal(anonymous.body.items[0].room_note, "");

    const authenticated = await agent.get(`/api/sessions/${sessionId}/viewers?min_messages=0&limit=1`).expect(200);
    assert.equal(authenticated.body.items[0].room_note, "熟客");

    await agent
      .put(`/api/rooms/${room.body.id}/viewer-notes/${encodeURIComponent(targetDanmaku.bili_uid)}`)
      .send({ note: "弹幕备注" })
      .expect(200);

    const anonymousDanmaku = await request(app).get(`/api/sessions/${sessionId}/danmaku?limit=1`).expect(200);
    assert.equal(anonymousDanmaku.body.items[0].room_note, "");

    const authenticatedDanmaku = await agent.get(`/api/sessions/${sessionId}/danmaku?limit=1`).expect(200);
    assert.equal(authenticatedDanmaku.body.items[0].room_note, "弹幕备注");

    await agent
      .put(`/api/rooms/${room.body.id}/viewer-notes/${encodeURIComponent(targetGift.bili_uid)}`)
      .send({ note: "礼物备注" })
      .expect(200);

    const anonymousGifts = await request(app).get(`/api/sessions/${sessionId}/gifts`).expect(200);
    assert.ok(anonymousGifts.body.ranking.every((item) => item.room_note === ""));
    assert.ok(anonymousGifts.body.history.every((item) => item.room_note === ""));

    const authenticatedGifts = await agent.get(`/api/sessions/${sessionId}/gifts`).expect(200);
    assert.ok(authenticatedGifts.body.ranking.some((item) => item.room_note === "礼物备注"));
    assert.ok(authenticatedGifts.body.history.some((item) => item.room_note === "礼物备注"));

    await agent
      .put(`/api/rooms/${room.body.id}/viewer-notes/${encodeURIComponent(targetViewer.bili_uid)}`)
      .send({ note: "" })
      .expect(200);

    const cleared = await agent.get(`/api/sessions/${sessionId}/viewers?min_messages=0&limit=1`).expect(200);
    assert.equal(cleared.body.items[0].room_note, "");
  });

  test("orders danmaku and returns the complete gift history", async () => {
    const room = await request(app).get("/api/rooms/naya").expect(200);
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

  test("claims a live room only through configured manager UID danmaku and persists it in cookies", async () => {
    bilibiliSnapshot = {
      bili_uid: "24680",
      streamer_name: "认领测试主播",
      avatar_url: "",
      live_status: 1,
      title: "认领测试场次",
      cover_url: "",
      area: "聊天电台",
      parent_area: "娱乐",
      live_time: "2026-07-21T12:00:00.000Z",
      attention: 2048,
      online: 512,
    };
    await loginAdmin();
    await agent.post("/api/admin/rooms").send({
      room_number: "246801",
      alias: "claim-test",
      streamer_name: "",
      avatar_url: "",
      description: "",
      enabled: true,
    }).expect(201);

    const room = await request(app).get("/api/rooms/claim-test").expect(200);
    const session = room.body.sessions.find((item) => item.status === "live");
    const initialManagers = await agent.get(`/api/admin/rooms/${room.body.id}/claim-managers`).expect(200);
    assert.deepEqual(initialManagers.body.items.map((item) => item.bili_uid), ["24680"]);
    const compatibleManagers = await agent.get(`/api/admin/rooms/${room.body.id}/managers`).expect(200);
    assert.deepEqual(compatibleManagers.body.items.map((item) => item.bili_uid), ["24680"]);

    const updatedManagers = await agent.put(`/api/admin/rooms/${room.body.id}/claim-managers`)
      .send({ uids: ["556677"] })
      .expect(200);
    assert.deepEqual(updatedManagers.body.items.map((item) => item.bili_uid), ["24680", "556677"]);

    const claimant = request.agent(app);
    const context = await claimant.get("/api/rooms/claim-test/claim").expect(200);
    assert.match(context.body.claim_prefix, /^Nya-bl[a-z0-9]{4}-$/);
    assert.equal(context.body.claimed, false);
    assert.equal(context.body.claim_manager_count, 2);

    const challenge = await claimant.post("/api/rooms/claim-test/claim/challenge").send({}).expect(200);
    assert.match(challenge.body.code, /^Nya-bl[a-z0-9]{4}-[a-z0-9]{6}$/);
    app.locals.database.ingest({
      type: "danmaku",
      session_id: session.id,
      timestamp: "2026-07-21T12:05:00.000Z",
      user: { uid: "998877", username: "路人观众", avatar_url: "", guard_level: 0 },
      content: challenge.body.code,
      medal_name: "",
      medal_level: 0,
    });
    const rejected = await claimant.post("/api/rooms/claim-test/claim/verify").send({}).expect(404);
    assert.match(rejected.body.error, /已配置管理者 UID/);

    app.locals.database.ingest({
      type: "danmaku",
      session_id: session.id,
      timestamp: "2026-07-21T12:06:00.000Z",
      user: { uid: "556677", username: "房管小助手", avatar_url: "", guard_level: 0 },
      content: challenge.body.code,
      medal_name: "",
      medal_level: 0,
    });
    const verified = await claimant.post("/api/rooms/claim-test/claim/verify").send({}).expect(200);
    assert.equal(verified.body.claim.uid, "556677");
    assert.equal(verified.body.claim.username, "房管小助手");

    const claimed = await claimant.get("/api/rooms/claim-test/claim").expect(200);
    assert.equal(claimed.body.claimed, true);
    assert.equal(claimed.body.claim.uid, "556677");

    const auth = await claimant.get("/api/auth/me").expect(200);
    assert.equal(auth.body.authenticated, true);
    assert.equal(auth.body.auth_mode, "claim");
    assert.ok(auth.body.room_claims.some((item) => item.uid === "556677" && item.alias === "claim-test"));

    const roomViewer = await claimant.get(`/api/sessions/${session.id}/viewers?min_messages=0&limit=1`).expect(200);
    await claimant
      .put(`/api/rooms/${room.body.id}/viewer-notes/${encodeURIComponent(roomViewer.body.items[0].bili_uid)}`)
      .send({ note: "认领备注" })
      .expect(200);
    const noted = await claimant.get(`/api/sessions/${session.id}/viewers?min_messages=0&limit=1`).expect(200);
    assert.equal(noted.body.items[0].room_note, "认领备注");
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

    const reordered = await agent.post(`/api/admin/rooms/${created.body.id}/reorder`)
      .send({ direction: "up" })
      .expect(200);
    assert.equal(reordered.body.items[0].id, created.body.id);
    const publicRooms = await request(app).get("/api/rooms").expect(200);
    assert.equal(publicRooms.body.items[0].id, created.body.id);
    await agent.post(`/api/admin/rooms/${created.body.id}/reorder`)
      .send({ direction: "sideways" })
      .expect(400);

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
    const room = await request(app).get("/api/rooms/naya").expect(200);
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
    const rawDanmakuInfo = [];
    rawDanmakuInfo[0] = [];
    rawDanmakuInfo[0][15] = { user: { base: { face: "https://i0.hdslb.com/bfs/face/raw-avatar.jpg" } } };
    connection.handler.onIncomeDanmu({ id: "danmaku-1", timestamp: 1_752_688_101_000, raw: { info: rawDanmakuInfo }, body: { timestamp: 1_752_688_101_000, user, content: "WebSocket 采集成功" } });
    connection.handler.onGift({
      id: "gift-1",
      timestamp: 1_752_688_102_000,
      raw: { gift_img: "https://s1.hdslb.com/bfs/live/gift-small-flower.png" },
      body: { user, gift_name: "小花花", coin_type: "gold", price: 1000, amount: 2 },
    });
    connection.handler.onGuardBuy({
      id: "guard-1",
      timestamp: 1_752_688_103_000,
      raw: { payflow_id: "payflow-guard-1" },
      body: {
        user: { uid: 667788, uname: "上舰测试观众", face: "https://i0.hdslb.com/bfs/face/guard-avatar.jpg" },
        gift_name: "舰长",
        price: 138000,
      },
    });
    connection.handler.raw.COMBO_SEND({
      combo_id: "combo-small-1",
      batch_combo_id: "combo-small-batch-1",
      uid: 556677,
      uname: "一电池测试观众",
      face: "https://i0.hdslb.com/bfs/face/combo-avatar.jpg",
      gift_name: "小心心",
      gift_img: "https://s1.hdslb.com/bfs/live/gift-heart.png",
      combo_total_coin: 100,
      total_num: 1,
      timestamp: 1_752_688_104_000,
      coin_type: "gold",
    });

    const danmaku = await request(app).get(`/api/sessions/${session.id}/danmaku?q=${encodeURIComponent("WebSocket 采集成功")}`).expect(200);
    assert.equal(danmaku.body.total, 1);
    assert.equal(danmaku.body.items[0].avatar_url, "https://i0.hdslb.com/bfs/face/raw-avatar.jpg");
    const viewers = await request(app).get(`/api/sessions/${session.id}/viewers?q=${encodeURIComponent("采集测试观众")}`).expect(200);
    assert.equal(viewers.body.total, 1);
    assert.equal(viewers.body.items[0].message_count, 1);
    assert.equal(viewers.body.items[0].entry_count, 1);
    assert.equal(viewers.body.items[0].first_entered_at, new Date(1_752_688_100_000).toISOString());
    assert.equal(viewers.body.items[0].last_entered_at, new Date(1_752_688_100_000).toISOString());
    const gifts = await request(app).get(`/api/sessions/${session.id}/gifts`).expect(200);
    assert.equal(gifts.body.gifts.find((item) => item.gift_name === "小花花").total_value, 2);
    assert.equal(gifts.body.gifts.find((item) => item.gift_name === "舰长").total_value, 138);
    assert.equal(gifts.body.gifts.find((item) => item.gift_name === "小心心").total_value, 0.1);
    assert.equal(gifts.body.history.find((item) => item.gift_name === "小花花").gift_icon_url, "https://s1.hdslb.com/bfs/live/gift-small-flower.png");
    assert.equal(gifts.body.history.find((item) => item.gift_name === "舰长").username, "上舰测试观众");
    assert.equal(gifts.body.history.find((item) => item.gift_name === "小心心").username, "一电池测试观众");

    const monitor = await agent.get("/api/admin/monitor").expect(200);
    const status = monitor.body.danmaku.rooms.find((item) => item.room_number === "7788");
    assert.equal(status.status, "listening");
    assert.equal(status.message_count, 5);

    connection.handler.onClose();
    const closedMonitor = await agent.get("/api/admin/monitor").expect(200);
    const closedStatus = closedMonitor.body.danmaku.rooms.find((item) => item.room_number === "7788");
    assert.equal(closedStatus.status, "closed");
    assert.match(closedStatus.last_error, /连接已关闭/);

    connection.handler.onIncomeDanmu({ id: "danmaku-after-close", timestamp: 1_752_688_103_000, body: { timestamp: 1_752_688_103_000, user, content: "关闭事件后的有效弹幕" } });
    const recoveredMonitor = await agent.get("/api/admin/monitor").expect(200);
    const recoveredStatus = recoveredMonitor.body.danmaku.rooms.find((item) => item.room_number === "7788");
    assert.equal(recoveredStatus.status, "listening");
    assert.equal(recoveredStatus.last_error, "");
    assert.equal(recoveredStatus.message_count, 6);

    const missingAvatarUser = { uid: 889900, uname: "等待头像补全", face: "", identity: { guard_level: 0 } };
    profileResponse = [{ uid: "889900", username: "头像已补全", avatar_url: "https://i1.hdslb.com/bfs/face/enriched.jpg" }];
    connection.handler.onIncomeDanmu({ id: "profile-enrichment", timestamp: 1_752_688_103_500, body: { timestamp: 1_752_688_103_500, user: missingAvatarUser, content: "等待批量补全头像" } });
    await app.locals.danmakuCollector.flushProfileQueue();
    const enriched = await request(app).get(`/api/sessions/${session.id}/danmaku?q=${encodeURIComponent("等待批量补全头像")}`).expect(200);
    assert.deepEqual(profileRequests.at(-1), ["889900"]);
    assert.equal(enriched.body.items[0].username, "等待头像补全");
    assert.equal(enriched.body.items[0].avatar_url, "https://i1.hdslb.com/bfs/face/enriched.jpg");

    app.locals.danmakuCollector.stopRoom(created.body.id);
    connection.handler.onIncomeDanmu({ id: "stale-danmaku", timestamp: 1_752_688_104_000, body: { timestamp: 1_752_688_104_000, user, content: "旧连接不应写入" } });
    const staleResult = await request(app).get(`/api/sessions/${session.id}/danmaku?q=${encodeURIComponent("旧连接不应写入")}`).expect(200);
    assert.equal(staleResult.body.total, 0);
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
    const previous = await agent.get("/api/admin/config").expect(200);
    Object.assign(previous.body.security, {
      bilibili_cookie: "SESSDATA=old-session; DedeUserID=13579; buvid3=old-buvid",
      bilibili_web_refresh_token: "old-web-refresh",
      bilibili_app_access_key: "old-app-access",
      bilibili_app_refresh_token: "old-app-refresh",
      bilibili_app_expires_at: "2026-12-31T00:00:00.000Z",
    });
    await agent.put("/api/admin/config").send(previous.body).expect(200);
    const qr = await agent.post("/api/admin/bilibili-auth/qr").send({}).expect(200);
    assert.equal(qr.body.key, "mock-qr-key");
    assert.match(qr.body.image, /^data:image\/png/);
    const login = await agent.get("/api/admin/bilibili-auth/qr/mock-qr-key").expect(200);
    assert.equal(login.body.status, "confirmed");
    assert.equal(login.body.profile.username, "扫码测试账号");
    assert.equal(login.body.cookie, undefined);

    const config = await agent.get("/api/admin/config").expect(200);
    assert.match(config.body.security.bilibili_cookie, /DedeUserID=24680/);
    assert.doesNotMatch(config.body.security.bilibili_cookie, /old-session|13579/);
    assert.equal(config.body.security.bilibili_app_access_key, "");
    assert.equal(config.body.security.bilibili_app_refresh_token, "");
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
    assert.equal(appConfig.body.security.bilibili_web_refresh_token, "");
    const appMonitor = await agent.get("/api/admin/monitor").expect(200);
    assert.equal(appMonitor.body.danmaku.auth.app_configured, true);
    assert.equal(appMonitor.body.danmaku.auth.app_expires_at, "2027-01-13T00:00:00.000Z");
    const refresh = await agent.post("/api/admin/bilibili-auth/cookie-refresh").send({}).expect(200);
    assert.equal(refresh.body.status, "fresh");

    const activeConnection = danmakuConnections.filter((item) => String(item.roomNumber) === "2468").at(-1);
    const clearingConfig = await agent.get("/api/admin/config").expect(200);
    for (const field of ["bilibili_cookie", "bilibili_web_refresh_token", "bilibili_app_access_key", "bilibili_app_refresh_token", "bilibili_app_expires_at"]) {
      clearingConfig.body.security[field] = "";
    }
    await agent.put("/api/admin/config").send(clearingConfig.body).expect(200);
    assert.equal(activeConnection.closed, true);
    const clearedConfig = await agent.get("/api/admin/config").expect(200);
    for (const field of ["bilibili_cookie", "bilibili_web_refresh_token", "bilibili_app_access_key", "bilibili_app_refresh_token", "bilibili_app_expires_at"]) {
      assert.equal(clearedConfig.body.security[field], "");
    }
    const clearedMonitor = await agent.get("/api/admin/monitor").expect(200);
    assert.equal(clearedMonitor.body.danmaku.auth.mode, "guest");
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
