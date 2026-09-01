const DEFAULT_BARK_SERVER_URL = "https://api.day.app";
const DEFAULT_BARK_TITLE = "{streamer_name} 开播了";
const DEFAULT_BARK_BODY = "{streamer_name} 正在直播：{title}\n{url}";

const valueFor = (room, snapshot, key) => ({
  streamer_name: room.streamer_name || snapshot.streamer_name || "直播间",
  title: snapshot.title || room.room_title || "未命名直播",
  room_number: room.room_number,
  alias: room.alias || "",
  url: room.alias || room.room_number,
  live_url: `https://live.bilibili.com/${encodeURIComponent(room.room_number)}`,
})[key] || "";

const renderTemplate = (template, room, snapshot) => String(template)
  .replace(/\{([a-z_]+)\}/gi, (_match, key) => valueFor(room, snapshot, key.toLowerCase()));

const parseDeviceTokens = (value) => [...new Set(String(value || "")
  .split(/[\s,，、]+/)
  .map((token) => token.trim())
  .filter(Boolean))];

export class BarkNotifier {
  constructor({ fetchImpl = globalThis.fetch, logger = console } = {}) {
    this.fetch = fetchImpl;
    this.logger = logger;
  }

  async notify(room, snapshot) {
    const tokens = parseDeviceTokens(room.bark_device_token);
    if (!tokens.length || !this.fetch) return { skipped: true, sent: 0 };
    const serverUrl = String(room.bark_server_url || DEFAULT_BARK_SERVER_URL).trim().replace(/\/+$/, "");
    const title = renderTemplate(room.bark_title || DEFAULT_BARK_TITLE, room, snapshot);
    const body = renderTemplate(room.bark_body || DEFAULT_BARK_BODY, room, snapshot);
    const payload = JSON.stringify({ title, body, url: valueFor(room, snapshot, "live_url"), group: "NyaBiliLive" });
    const results = await Promise.allSettled(tokens.map(async (token) => {
      const response = await this.fetch(`${serverUrl}/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: payload,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Bark HTTP ${response.status}`);
      return token;
    }));
    const failed = results.filter((result) => result.status === "rejected");
    if (failed.length) throw new Error(`${failed.length}/${tokens.length} 个 Bark 设备投送失败：${failed[0].reason.message}`);
    return { sent: tokens.length };
  }
}

export { DEFAULT_BARK_SERVER_URL, DEFAULT_BARK_TITLE, DEFAULT_BARK_BODY, parseDeviceTokens, renderTemplate };
