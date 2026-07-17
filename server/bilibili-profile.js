const USER_PROFILES_URL = "https://api.vc.bilibili.com/x/im/user_infos";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36";

export async function fetchBilibiliUserProfiles(uids, { fetchImpl = fetch, cookie = "" } = {}) {
  const normalized = [...new Set(uids.map(String).filter((uid) => /^[1-9]\d*$/.test(uid)))].slice(0, 20);
  if (!normalized.length) return [];
  const url = new URL(USER_PROFILES_URL);
  url.searchParams.set("uids", normalized.join(","));
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/json, text/plain, */*",
      Referer: "https://message.bilibili.com/",
      "User-Agent": USER_AGENT,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`用户资料接口返回 ${response.status}`);
  const payload = await response.json();
  if (payload.code !== 0 || !Array.isArray(payload.data)) {
    throw new Error(payload.message || payload.msg || `用户资料接口错误 ${payload.code}`);
  }
  return payload.data.map((profile) => ({
    uid: String(profile.mid || ""),
    username: String(profile.name || ""),
    avatar_url: String(profile.face || ""),
  })).filter((profile) => /^[1-9]\d*$/.test(profile.uid));
}
