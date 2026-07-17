import { constants, createHash, publicEncrypt } from "node:crypto";
import { load } from "cheerio";
import QRCode from "qrcode";

const QR_GENERATE_URL = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate";
const QR_POLL_URL = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll";
const NAV_URL = "https://api.bilibili.com/x/web-interface/nav";
const FINGERPRINT_URL = "https://api.bilibili.com/x/frontend/finger/spi";
const COOKIE_INFO_URL = "https://passport.bilibili.com/x/passport-login/web/cookie/info";
const COOKIE_REFRESH_URL = "https://passport.bilibili.com/x/passport-login/web/cookie/refresh";
const COOKIE_CONFIRM_URL = "https://passport.bilibili.com/x/passport-login/web/confirm/refresh";
const APP_QR_CREATE_URL = "https://passport.bilibili.com/x/passport-tv-login/qrcode/auth_code";
const APP_QR_POLL_URL = "https://passport.bilibili.com/x/passport-tv-login/qrcode/poll";
const APP_KEY = "4409e2ce8ffd12b8";
const APP_SECRET = "59b43e04ad6965f34319062b478f83dd";
const COOKIE_REFRESH_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDLgd2OAkcGVtoE3ThUREbio0Eg
Uc/prcajMKXvkCKFCWhJYJcLkcM2DKKcSeFpD/j6Boy538YXnR6VhcuUJOhH2x71
nzPjfdTcqMz7djHum0qSZA0AyCBDABUqCrfNgCiJ00Ra7GmRj+YCK1NJEuewlb40
JNrRuoEUXpabUzGB8QIDAQAB
-----END PUBLIC KEY-----`;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36";

function decodeCookieValue(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function parseBilibiliCookie(source = "") {
  const values = new Map();
  for (const part of String(source).split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    values.set(part.slice(0, separator).trim(), decodeCookieValue(part.slice(separator + 1).trim()));
  }
  const uid = Number(values.get("DedeUserID") || 0);
  return {
    uid: Number.isSafeInteger(uid) && uid > 0 ? uid : 0,
    buvid: values.get("buvid3") || values.get("buvid4") || "",
    hasSessdata: Boolean(values.get("SESSDATA")),
    csrf: values.get("bili_jct") || "",
  };
}

function appSign(params) {
  const signed = new URLSearchParams({ ...params, appkey: APP_KEY });
  signed.sort();
  signed.set("sign", createHash("md5").update(`${signed.toString()}${APP_SECRET}`).digest("hex"));
  return signed;
}

function appCookies(data) {
  return (data?.cookie_info?.cookies || []).map((item) => `${item.name}=${item.value}`);
}

function setCookieHeaders(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const combined = headers.get("set-cookie");
  return combined ? combined.split(/,(?=\s*[^;,]+=)/) : [];
}

function mergeCookieHeaders(existing, additions) {
  const values = new Map();
  const apply = (item) => {
    const pair = String(item).split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator <= 0) return;
    values.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
  };
  String(existing).split(";").forEach(apply);
  additions.forEach(apply);
  return [...values].map(([name, value]) => `${name}=${value}`).join("; ");
}

export class BilibiliAuthClient {
  constructor({ fetchImpl = globalThis.fetch } = {}) {
    if (!fetchImpl) throw new Error("当前 Node 运行时不支持 fetch");
    this.fetch = fetchImpl;
  }

  async jsonRequest(url, options = {}) {
    const response = await this.fetch(url, {
      ...options,
      headers: { Accept: "application/json", "User-Agent": USER_AGENT, ...(options.headers || {}) },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`Bilibili HTTP ${response.status}`);
    return { response, payload: await response.json() };
  }

  async createQrLogin() {
    const { payload } = await this.jsonRequest(QR_GENERATE_URL);
    if (payload.code !== 0 || !payload.data?.url || !payload.data?.qrcode_key) {
      throw new Error(payload.message || "无法创建 Bilibili 登录二维码");
    }
    return {
      key: payload.data.qrcode_key,
      image: await QRCode.toDataURL(payload.data.url, { width: 240, margin: 1 }),
    };
  }

  async createAppQrLogin() {
    const body = appSign({ local_id: "0", ts: String(Math.floor(Date.now() / 1000)) });
    const { payload } = await this.jsonRequest(APP_QR_CREATE_URL, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
    });
    if (payload.code !== 0 || !payload.data?.url || !payload.data?.auth_code) {
      throw new Error(payload.message || "无法创建 Bilibili APP 登录二维码");
    }
    return {
      key: payload.data.auth_code,
      image: await QRCode.toDataURL(payload.data.url, { width: 240, margin: 1 }),
    };
  }

  async pollQrLogin(key, existingCookie = "") {
    const url = `${QR_POLL_URL}?qrcode_key=${encodeURIComponent(key)}`;
    const { response, payload } = await this.jsonRequest(url);
    if (payload.code !== 0) throw new Error(payload.message || "Bilibili 登录状态查询失败");
    const code = Number(payload.data?.code);
    if (code === 86101) return { status: "waiting", message: "等待扫码" };
    if (code === 86090) return { status: "scanned", message: "已扫码，请在手机上确认" };
    if (code === 86038) return { status: "expired", message: "二维码已过期" };
    if (code !== 0) return { status: "error", message: payload.data?.message || "登录失败" };

    const cookie = mergeCookieHeaders(existingCookie, setCookieHeaders(response.headers));
    const credentials = await this.refreshCredentials(cookie);
    return { status: "confirmed", ...credentials, web_refresh_token: String(payload.data.refresh_token || "") };
  }

  async pollAppQrLogin(authCode, existingCookie = "") {
    const body = appSign({
      auth_code: authCode, local_id: "0", ts: String(Math.floor(Date.now() / 1000)),
    });
    const { payload } = await this.jsonRequest(APP_QR_POLL_URL, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
    });
    const code = Number(payload.code);
    if (code === 86039) return { status: "waiting", message: "等待扫码" };
    if (code === 86090) return { status: "scanned", message: "已扫码，请在手机上确认" };
    if (code === 86038) return { status: "expired", message: "二维码已过期" };
    if (code !== 0 || !payload.data) return { status: "error", message: payload.message || "APP 登录失败" };

    const token = payload.data.token_info || payload.data;
    const cookie = mergeCookieHeaders(existingCookie, appCookies(payload.data));
    const credentials = await this.refreshCredentials(cookie);
    return {
      status: "confirmed",
      ...credentials,
      app_access_key: String(token.access_token || ""),
      app_refresh_token: String(token.refresh_token || ""),
      app_expires_at: new Date(Date.now() + Number(token.expires_in || 0) * 1000).toISOString(),
    };
  }

  async refreshCredentials(cookie) {
    if (!String(cookie).trim()) throw new Error("尚未配置 Bilibili Cookie");
    const { payload } = await this.jsonRequest(FINGERPRINT_URL, { headers: { Cookie: cookie } });
    if (payload.code !== 0 || !payload.data?.b_3) throw new Error("无法获取 Bilibili buvid");
    const additions = [`buvid3=${payload.data.b_3}`];
    if (payload.data.b_4) additions.push(`buvid4=${payload.data.b_4}`);
    const completedCookie = mergeCookieHeaders(cookie, additions);
    return { cookie: completedCookie, profile: await this.verifyCookie(completedCookie) };
  }

  async verifyCookie(cookie) {
    if (!String(cookie).trim()) throw new Error("尚未配置 Bilibili Cookie");
    const { payload } = await this.jsonRequest(NAV_URL, { headers: { Cookie: cookie } });
    if (payload.code !== 0 || !payload.data?.isLogin) throw new Error("Bilibili Cookie 已失效或未登录");
    return {
      uid: String(payload.data.mid || ""),
      username: String(payload.data.uname || ""),
      avatar_url: String(payload.data.face || ""),
    };
  }

  async refreshWebCookie(cookie, refreshToken) {
    const auth = parseBilibiliCookie(cookie);
    if (!auth.hasSessdata) throw new Error("尚未配置有效的 Bilibili Cookie");
    const infoUrl = `${COOKIE_INFO_URL}?csrf=${encodeURIComponent(auth.csrf)}`;
    const { payload: info } = await this.jsonRequest(infoUrl, { headers: { Cookie: cookie } });
    if (info.code !== 0) throw new Error(info.message || "无法检查 Cookie 刷新状态");
    if (!info.data?.refresh) return { status: "fresh", message: "Cookie 暂不需要刷新", cookie, web_refresh_token: refreshToken };
    if (!refreshToken) throw new Error("Cookie 需要刷新，但缺少 Web refresh_token；请重新进行 Web 扫码登录");
    if (!auth.csrf) throw new Error("Cookie 缺少 bili_jct，无法刷新");

    const message = Buffer.from(`refresh_${info.data.timestamp}`);
    const correspondPath = publicEncrypt({
      key: COOKIE_REFRESH_PUBLIC_KEY,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    }, message).toString("hex");
    const correspond = await this.fetch(`https://www.bilibili.com/correspond/1/${correspondPath}`, {
      headers: { Cookie: cookie, "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(12_000),
    });
    if (!correspond.ok) throw new Error(`获取 Cookie 刷新口令失败 (${correspond.status})`);
    const refreshCsrf = load(await correspond.text())("#1-name").text().trim();
    if (!refreshCsrf) throw new Error("Bilibili 未返回 Cookie 刷新口令");

    const refreshBody = new URLSearchParams({
      csrf: auth.csrf, refresh_csrf: refreshCsrf, source: "main_web", refresh_token: refreshToken,
    });
    const { response, payload } = await this.jsonRequest(COOKIE_REFRESH_URL, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: refreshBody,
    });
    if (payload.code !== 0 || !payload.data?.refresh_token) throw new Error(payload.message || "Cookie 刷新失败");
    const nextCookie = mergeCookieHeaders(cookie, setCookieHeaders(response.headers));
    const nextAuth = parseBilibiliCookie(nextCookie);
    const confirmBody = new URLSearchParams({ csrf: nextAuth.csrf, refresh_token: refreshToken });
    const { payload: confirmation } = await this.jsonRequest(COOKIE_CONFIRM_URL, {
      method: "POST",
      headers: { Cookie: nextCookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: confirmBody,
    });
    if (confirmation.code !== 0) throw new Error(confirmation.message || "Cookie 刷新确认失败");
    return {
      status: "refreshed",
      message: "Cookie 已刷新",
      cookie: nextCookie,
      web_refresh_token: String(payload.data.refresh_token),
    };
  }
}
