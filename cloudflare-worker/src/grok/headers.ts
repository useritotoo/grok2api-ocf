import { DEFAULT_CURRENT_CONFIG } from "../currentConfig";
import type { GrokSettings } from "../settings";

const BASE_HEADERS: Record<string, string> = {
  Accept: "*/*",
  "Accept-Language": "zh-CN,zh;q=0.9",
  Origin: "https://grok.com",
  Referer: "https://grok.com/",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  Baggage: "sentry-environment=production,sentry-public_key=b311e0f2690c81f25e2c4cf6d4f7ce1c",
};

const DEFAULT_USER_AGENT = String(
  DEFAULT_CURRENT_CONFIG.proxy.user_agent ??
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
);
const DEFAULT_BROWSER = String(DEFAULT_CURRENT_CONFIG.proxy.browser ?? "chrome136");

function randomString(length: number, lettersOnly = true): string {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const digits = "0123456789";
  const chars = lettersOnly ? letters : letters + digits;
  let out = "";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < length; i++) out += chars[bytes[i]! % chars.length]!;
  return out;
}

function generateStatsigId(): string {
  let msg: string;
  if (Math.random() < 0.5) {
    const rand = randomString(5, false);
    msg = `e:TypeError: Cannot read properties of null (reading 'children['${rand}']')`;
  } else {
    const rand = randomString(10, true);
    msg = `e:TypeError: Cannot read properties of undefined (reading '${rand}')`;
  }
  return btoa(msg);
}

function normalizeHeaderValue(value: string | undefined, removeAllSpaces = false): string {
  const normalized = String(value ?? "")
    .replace(/[\ufeff\u200b\u200c\u200d]/g, "")
    .trim();
  return removeAllSpaces ? normalized.replace(/\s+/g, "") : normalized;
}

function extractMajorVersion(browser: string, userAgent: string): string | null {
  const browserMatch = browser.match(/(\d{2,3})/);
  if (browserMatch?.[1]) return browserMatch[1];
  for (const pattern of [/Edg\/(\d+)/, /Chrome\/(\d+)/, /Chromium\/(\d+)/]) {
    const match = userAgent.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

function detectPlatform(userAgent: string): string | null {
  const ua = userAgent.toLowerCase();
  if (ua.includes("windows")) return "Windows";
  if (ua.includes("mac os x") || ua.includes("macintosh")) return "macOS";
  if (ua.includes("android")) return "Android";
  if (ua.includes("iphone") || ua.includes("ipad")) return "iOS";
  if (ua.includes("linux")) return "Linux";
  return null;
}

function detectArch(userAgent: string): string | null {
  const ua = userAgent.toLowerCase();
  if (ua.includes("aarch64") || ua.includes(" arm")) return "arm";
  if (ua.includes("x86_64") || ua.includes("x64") || ua.includes("win64") || ua.includes("intel")) return "x86";
  return null;
}

function buildClientHints(browserValue: string | undefined, userAgentValue: string | undefined): Record<string, string> {
  const browser = normalizeHeaderValue(browserValue).toLowerCase();
  const userAgent = normalizeHeaderValue(userAgentValue);
  const ua = userAgent.toLowerCase();

  const isEdge = browser.includes("edge") || ua.includes("edg");
  const isBrave = browser.includes("brave");
  const isChromium =
    ["chrome", "chromium", "edge", "brave"].some((key) => browser.includes(key)) ||
    ua.includes("chrome") ||
    ua.includes("chromium") ||
    ua.includes("edg");
  const isFirefox = browser.includes("firefox") || ua.includes("firefox");
  const isSafari =
    (ua.includes("safari") && !ua.includes("chrome") && !ua.includes("chromium") && !ua.includes("edg")) ||
    browser.includes("safari");

  if (!isChromium || isFirefox || isSafari) return {};

  const version = extractMajorVersion(browser, userAgent);
  if (!version) return {};

  const brand = isEdge
    ? "Microsoft Edge"
    : browser.includes("chromium")
      ? "Chromium"
      : isBrave
        ? "Brave"
        : "Google Chrome";
  const platform = detectPlatform(userAgent);
  const arch = detectArch(userAgent);
  const mobile = ua.includes("mobile") || platform === "Android" || platform === "iOS" ? "?1" : "?0";

  const hints: Record<string, string> = {
    "Sec-Ch-Ua": `"${brand}";v="${version}", "Chromium";v="${version}", "Not(A:Brand";v="24"`,
    "Sec-Ch-Ua-Mobile": mobile,
  };
  if (platform) hints["Sec-Ch-Ua-Platform"] = `"${platform}"`;
  if (arch) {
    hints["Sec-Ch-Ua-Arch"] = arch;
    hints["Sec-Ch-Ua-Bitness"] = "64";
  }
  if (mobile !== "?0") hints["Sec-Ch-Ua-Model"] = "";
  return hints;
}

export function getDynamicHeaders(settings: GrokSettings, pathname: string): Record<string, string> {
  const dynamic = settings.dynamic_statsig !== false;
  const statsigId = dynamic ? generateStatsigId() : (settings.x_statsig_id ?? "").trim();
  if (!dynamic && !statsigId) throw new Error("配置缺少 x_statsig_id（且未启用 dynamic_statsig）");

  const headers: Record<string, string> = { ...BASE_HEADERS };
  const userAgent = normalizeHeaderValue(settings.user_agent ?? DEFAULT_USER_AGENT) || DEFAULT_USER_AGENT;
  headers["User-Agent"] = userAgent;
  Object.assign(headers, buildClientHints(settings.browser ?? DEFAULT_BROWSER, userAgent));
  headers["x-statsig-id"] = statsigId;
  headers["x-xai-request-id"] = crypto.randomUUID();
  headers["Content-Type"] = pathname.includes("upload-file") ? "text/plain;charset=UTF-8" : "application/json";
  return headers;
}
