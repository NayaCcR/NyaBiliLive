const ROOM_INFO_URL = "https://api.live.bilibili.com/room/v1/Room/get_info";
const MASTER_INFO_URL = "https://api.live.bilibili.com/live_user/v1/Master/info";

function bilibiliHeaders(roomNumber) {
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    Referer: `https://live.bilibili.com/${roomNumber}`,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36",
  };
}

function normalizeLiveTime(value) {
  if (!value || value === "0000-00-00 00:00:00") return null;
  const parsed = new Date(`${String(value).replace(" ", "T")}+08:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export class BilibiliApiClient {
  constructor({ fetchImpl = globalThis.fetch } = {}) {
    if (!fetchImpl) throw new Error("当前 Node 运行时不支持 fetch");
    this.fetch = fetchImpl;
  }

  async request(url, roomNumber, timeoutSeconds) {
    const response = await this.fetch(url, {
      headers: bilibiliHeaders(roomNumber),
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
    if (!response.ok) throw new Error(`Bilibili HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.code !== 0) throw new Error(`Bilibili API ${payload.code}: ${payload.message || payload.msg || "请求失败"}`);
    return payload.data;
  }

  async fetchRoomSnapshot(roomNumber, { timeoutSeconds = 10 } = {}) {
    const room = await this.request(
      `${ROOM_INFO_URL}?room_id=${encodeURIComponent(roomNumber)}`,
      roomNumber,
      timeoutSeconds,
    );
    let master = null;
    if (room.uid) {
      try {
        master = await this.request(
          `${MASTER_INFO_URL}?uid=${encodeURIComponent(room.uid)}`,
          roomNumber,
          timeoutSeconds,
        );
      } catch {
        // The room lifecycle can still be synchronized when the optional profile endpoint is rate-limited.
      }
    }
    return {
      room_number: String(room.room_id || roomNumber),
      bili_uid: room.uid ? String(room.uid) : null,
      streamer_name: master?.info?.uname || "",
      avatar_url: master?.info?.face || "",
      live_status: Number(room.live_status || 0),
      title: room.title || "未命名直播",
      cover_url: room.user_cover || room.keyframe || room.background || "",
      keyframe_url: room.keyframe || "",
      area: room.area_name || "",
      parent_area: room.parent_area_name || "",
      live_time: normalizeLiveTime(room.live_time),
      attention: Number(room.attention || 0),
      online: Number(room.online || 0),
      checked_at: new Date().toISOString(),
    };
  }
}

export class BilibiliRoomMonitor {
  constructor({ database, config, client = new BilibiliApiClient(), logger = console } = {}) {
    this.database = database;
    this.config = config;
    this.client = client;
    this.logger = logger;
    this.timer = null;
    this.inFlight = false;
    this.lastRunAt = null;
    this.lastResult = null;
  }

  status() {
    return {
      enabled: this.config.value.monitoring.enabled,
      running: Boolean(this.timer),
      in_flight: this.inFlight,
      interval_seconds: this.config.value.monitoring.interval_seconds,
      last_run_at: this.lastRunAt,
      last_result: this.lastResult,
    };
  }

  start() {
    this.stop();
    if (!this.config.value.monitoring.enabled) return;
    const interval = this.config.value.monitoring.interval_seconds * 1000;
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref?.();
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  restart() {
    this.start();
  }

  async syncRoom(roomId) {
    const room = this.database.getRoomById(roomId);
    if (!room) throw new Error("房间不存在");
    try {
      const snapshot = await this.client.fetchRoomSnapshot(room.room_number, {
        timeoutSeconds: this.config.value.monitoring.request_timeout_seconds,
      });
      return this.database.applyRoomSnapshot(room.id, snapshot, {
        updateProfile: this.config.value.monitoring.auto_update_room_profile,
      });
    } catch (error) {
      this.database.recordRoomSyncError(room.id, error.message);
      throw error;
    }
  }

  async tick() {
    if (this.inFlight || !this.config.value.monitoring.enabled) return this.lastResult;
    this.inFlight = true;
    const result = { checked: 0, synced: 0, failed: 0 };
    try {
      for (const room of this.database.listMonitorableRooms()) {
        result.checked += 1;
        try {
          await this.syncRoom(room.id);
          result.synced += 1;
        } catch (error) {
          result.failed += 1;
          this.logger.warn?.(`[bilibili] room ${room.room_number}: ${error.message}`);
        }
      }
      this.lastRunAt = new Date().toISOString();
      this.lastResult = result;
      return result;
    } finally {
      this.inFlight = false;
    }
  }
}
