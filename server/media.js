const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36";

const wait = (milliseconds) => new Promise((resolve) => {
  const timer = setTimeout(resolve, milliseconds);
  timer.unref?.();
});

const isTimeoutError = (error) => ["AbortError", "TimeoutError"].includes(error?.name)
  || /timeout|timed out/i.test(String(error?.message || ""));

export class BilibiliMediaProxy {
  constructor({ fetchImpl = fetch, concurrency = 6, maxQueue = 256, maxEntries = 256, maxBytes = 32 * 1024 * 1024 } = {}) {
    this.fetchImpl = fetchImpl;
    this.concurrency = concurrency;
    this.maxQueue = maxQueue;
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.active = 0;
    this.waiters = [];
    this.cache = new Map();
    this.cacheBytes = 0;
    this.inFlight = new Map();
  }

  async load(source) {
    const key = String(source);
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    if (this.inFlight.has(key)) return this.inFlight.get(key);
    const pending = this.withSlot(() => this.fetchAsset(key))
      .then((asset) => {
        this.store(key, asset);
        return asset;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, pending);
    return pending;
  }

  async withSlot(task) {
    if (this.active >= this.concurrency) {
      if (this.waiters.length >= this.maxQueue) throw new Error("图片代理队列繁忙");
      await new Promise((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }

  async fetchAsset(source) {
    try {
      return await this.fetchOnce(source);
    } catch (error) {
      if (isTimeoutError(error)) throw error;
      await wait(150);
      return this.fetchOnce(source);
    }
  }

  async fetchOnce(source) {
    const upstream = await this.fetchImpl(source, {
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        Referer: "https://live.bilibili.com/",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(4_000),
    });
    if (!upstream.ok) throw new Error(`图片源返回 ${upstream.status}`);
    const contentType = upstream.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) throw new Error("远端资源不是图片");
    const content = Buffer.from(await upstream.arrayBuffer());
    if (content.length > 10 * 1024 * 1024) throw new Error("图片资源过大");
    return { content, contentType };
  }

  store(key, asset) {
    if (asset.content.length > this.maxBytes) return;
    this.cache.set(key, asset);
    this.cacheBytes += asset.content.length;
    while (this.cache.size > this.maxEntries || this.cacheBytes > this.maxBytes) {
      const oldestKey = this.cache.keys().next().value;
      const oldest = this.cache.get(oldestKey);
      this.cache.delete(oldestKey);
      this.cacheBytes -= oldest.content.length;
    }
  }
}
