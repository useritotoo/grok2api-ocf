import { dbFirst, dbRun } from "./db";
import { getCurrentConfig, normalizeApiKeyList } from "./currentConfig";
import type { Env } from "./env";
import { nowMs } from "./utils/time";

export interface GlobalSettings {
  base_url?: string;
  log_level?: string;
  image_mode?: "url" | "base64" | "b64_json";
  admin_username?: string;
  admin_password?: string;
  image_cache_max_size_mb?: number;
  video_cache_max_size_mb?: number;
}

export interface GrokSettings {
  api_key?: string;
  proxy_url?: string;
  proxy_pool_url?: string;
  proxy_pool_interval?: number;
  cache_proxy_url?: string;
  cf_clearance?: string; // stored as VALUE only (no "cf_clearance=" prefix)
  x_statsig_id?: string;
  dynamic_statsig?: boolean;
  filtered_tags?: string;
  show_thinking?: boolean;
  temporary?: boolean;
  video_poster_preview?: boolean;
  stream_first_response_timeout?: number;
  stream_chunk_timeout?: number;
  stream_total_timeout?: number;
  retry_status_codes?: number[];
  image_generation_method?: string;
}

export interface TokenSettings {
  auto_refresh?: boolean;
  refresh_interval_hours?: number;
  fail_threshold?: number;
  save_delay_ms?: number;
  reload_interval_sec?: number;
}

export interface CacheSettings {
  enable_auto_clean?: boolean;
  limit_mb?: number;
  keep_base64_cache?: boolean;
}

export interface PerformanceSettings {
  assets_max_concurrent?: number;
  media_max_concurrent?: number;
  usage_max_concurrent?: number;
  assets_delete_batch_size?: number;
  admin_assets_batch_size?: number;
}

export interface RegisterSettings {
  worker_domain?: string;
  email_domain?: string;
  admin_password?: string;
  yescaptcha_key?: string;
  solver_url?: string;
  solver_browser_type?: string;
  solver_threads?: number;
  register_threads?: number;
  default_count?: number;
  auto_start_solver?: boolean;
  solver_debug?: boolean;
  max_errors?: number;
  max_runtime_minutes?: number;
}

export interface SettingsBundle {
  global: Required<GlobalSettings>;
  grok: Required<GrokSettings>;
  token: Required<TokenSettings>;
  cache: Required<CacheSettings>;
  performance: Required<PerformanceSettings>;
  register: Required<RegisterSettings>;
}

const DEFAULTS: SettingsBundle = {
  global: {
    base_url: "",
    log_level: "INFO",
    image_mode: "url",
    admin_username: "admin",
    admin_password: "admin",
    image_cache_max_size_mb: 512,
    video_cache_max_size_mb: 1024,
  },
  grok: {
    api_key: "",
    proxy_url: "",
    proxy_pool_url: "",
    proxy_pool_interval: 300,
    cache_proxy_url: "",
    cf_clearance: "",
    x_statsig_id: "",
    dynamic_statsig: true,
    filtered_tags: "xaiartifact,xai:tool_usage_card",
    show_thinking: true,
    temporary: false,
    video_poster_preview: false,
    stream_first_response_timeout: 30,
    stream_chunk_timeout: 120,
    stream_total_timeout: 600,
    retry_status_codes: [401, 429, 403],
    image_generation_method: "legacy",
  },
  token: {
    auto_refresh: true,
    refresh_interval_hours: 8,
    fail_threshold: 5,
    save_delay_ms: 500,
    reload_interval_sec: 30,
  },
  cache: {
    enable_auto_clean: true,
    limit_mb: 1024,
    keep_base64_cache: true,
  },
  performance: {
    assets_max_concurrent: 25,
    media_max_concurrent: 50,
    usage_max_concurrent: 25,
    assets_delete_batch_size: 10,
    admin_assets_batch_size: 10,
  },
  register: {
    worker_domain: "",
    email_domain: "",
    admin_password: "",
    yescaptcha_key: "",
    solver_url: "http://127.0.0.1:5072",
    solver_browser_type: "camoufox",
    solver_threads: 5,
    register_threads: 10,
    default_count: 100,
    auto_start_solver: true,
    solver_debug: false,
    max_errors: 0,
    max_runtime_minutes: 0,
  },
};

const IMAGE_METHOD_LEGACY = "legacy";
const IMAGE_METHOD_IMAGINE_WS_EXPERIMENTAL = "imagine_ws_experimental";
const IMAGE_METHOD_ALIASES: Record<string, string> = {
  imagine_ws: IMAGE_METHOD_IMAGINE_WS_EXPERIMENTAL,
  experimental: IMAGE_METHOD_IMAGINE_WS_EXPERIMENTAL,
  new: IMAGE_METHOD_IMAGINE_WS_EXPERIMENTAL,
  new_method: IMAGE_METHOD_IMAGINE_WS_EXPERIMENTAL,
};

function safeParseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function stripCfPrefix(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("cf_clearance=") ? trimmed.slice("cf_clearance=".length) : trimmed;
}

export function normalizeCfCookie(value: string): string {
  const cleaned = stripCfPrefix(value);
  return cleaned ? `cf_clearance=${cleaned}` : "";
}

export function normalizeImageGenerationMethod(value: unknown): string {
  const candidate = String(value ?? "")
    .trim()
    .toLowerCase();
  if (candidate === IMAGE_METHOD_IMAGINE_WS_EXPERIMENTAL) {
    return IMAGE_METHOD_IMAGINE_WS_EXPERIMENTAL;
  }
  if (IMAGE_METHOD_ALIASES[candidate]) {
    return IMAGE_METHOD_ALIASES[candidate];
  }
  return IMAGE_METHOD_LEGACY;
}

export async function getSettings(env: Env): Promise<SettingsBundle> {
  const current = await getCurrentConfig(env);
  const legacyPerformanceRow = await dbFirst<{ value: string }>(
    env.DB,
    "SELECT value FROM settings WHERE key = ?",
    ["performance"],
  );
  const legacyRegisterRow = await dbFirst<{ value: string }>(
    env.DB,
    "SELECT value FROM settings WHERE key = ?",
    ["register"],
  );

  const appCfg = current.app ?? {};
  const proxyCfg = current.proxy ?? {};
  const retryCfg = current.retry ?? {};
  const tokenCfg = { ...DEFAULTS.token, ...(current.token ?? {}) } as TokenSettings;
  const cacheCfg = { ...DEFAULTS.cache, ...(current.cache ?? {}) } as CacheSettings;
  const imageCfg = current.image ?? {};
  const assetCfg = current.asset ?? {};
  const chatCfg = current.chat ?? {};

  const globalCfg: GlobalSettings = {
    ...DEFAULTS.global,
    base_url: String(appCfg.app_url ?? DEFAULTS.global.base_url),
    image_mode: (String(appCfg.image_format ?? DEFAULTS.global.image_mode) as GlobalSettings["image_mode"]) ?? "url",
    admin_username: "admin",
    admin_password: String(appCfg.app_key ?? DEFAULTS.global.admin_password),
  };

  const grokCfg: GrokSettings = {
    ...DEFAULTS.grok,
    api_key: normalizeApiKeyList(appCfg.api_key)[0] ?? "",
    proxy_url: String(proxyCfg.base_proxy_url ?? DEFAULTS.grok.proxy_url),
    cache_proxy_url: String(proxyCfg.asset_proxy_url ?? DEFAULTS.grok.cache_proxy_url),
    cf_clearance: stripCfPrefix(String(proxyCfg.cf_clearance ?? "")),
    dynamic_statsig: Boolean(appCfg.dynamic_statsig ?? DEFAULTS.grok.dynamic_statsig),
    filtered_tags: Array.isArray(appCfg.filter_tags)
      ? appCfg.filter_tags.map((item) => String(item ?? "").trim()).filter(Boolean).join(",")
      : String(appCfg.filter_tags ?? DEFAULTS.grok.filtered_tags),
    show_thinking: Boolean(appCfg.thinking ?? DEFAULTS.grok.show_thinking),
    temporary: Boolean(appCfg.temporary ?? DEFAULTS.grok.temporary),
    stream_chunk_timeout: Number(chatCfg.stream_timeout ?? DEFAULTS.grok.stream_chunk_timeout),
    stream_total_timeout: Number(chatCfg.stream_timeout ?? DEFAULTS.grok.stream_total_timeout),
    retry_status_codes: Array.isArray(retryCfg.retry_status_codes)
      ? retryCfg.retry_status_codes.map((item) => Number(item)).filter((item) => Number.isFinite(item))
      : DEFAULTS.grok.retry_status_codes,
  };

  const mergedGrok = {
    ...DEFAULTS.grok,
    ...grokCfg,
    cf_clearance: stripCfPrefix(grokCfg.cf_clearance ?? ""),
  };
  mergedGrok.image_generation_method = normalizeImageGenerationMethod(
    mergedGrok.image_generation_method,
  );

  const performanceCfg = legacyPerformanceRow?.value
    ? safeParseJson<PerformanceSettings>(legacyPerformanceRow.value, DEFAULTS.performance)
    : {
        ...DEFAULTS.performance,
        assets_max_concurrent: Number(assetCfg.upload_concurrent ?? DEFAULTS.performance.assets_max_concurrent),
        media_max_concurrent: Number(assetCfg.download_concurrent ?? DEFAULTS.performance.media_max_concurrent),
        usage_max_concurrent: Number(current.usage?.concurrent ?? DEFAULTS.performance.usage_max_concurrent),
        assets_delete_batch_size: Number(assetCfg.delete_batch_size ?? DEFAULTS.performance.assets_delete_batch_size),
        admin_assets_batch_size: Number(assetCfg.list_batch_size ?? DEFAULTS.performance.admin_assets_batch_size),
      };

  const registerCfg = legacyRegisterRow?.value
    ? safeParseJson<RegisterSettings>(legacyRegisterRow.value, DEFAULTS.register)
    : DEFAULTS.register;

  return {
    global: { ...DEFAULTS.global, ...globalCfg },
    grok: mergedGrok,
    token: { ...DEFAULTS.token, ...tokenCfg },
    cache: { ...DEFAULTS.cache, ...cacheCfg },
    performance: { ...DEFAULTS.performance, ...performanceCfg },
    register: { ...DEFAULTS.register, ...registerCfg },
  };
}

export async function saveSettings(
  env: Env,
  updates: {
    global_config?: GlobalSettings;
    grok_config?: GrokSettings;
    token_config?: TokenSettings;
    cache_config?: CacheSettings;
    performance_config?: PerformanceSettings;
    register_config?: RegisterSettings;
  },
): Promise<void> {
  const now = nowMs();
  const current = await getSettings(env);

  const nextGlobal: GlobalSettings = { ...current.global, ...(updates.global_config ?? {}) };
  const nextGrok: GrokSettings = {
    ...current.grok,
    ...(updates.grok_config ?? {}),
    cf_clearance: stripCfPrefix(updates.grok_config?.cf_clearance ?? current.grok.cf_clearance ?? ""),
  };
  nextGrok.image_generation_method = normalizeImageGenerationMethod(nextGrok.image_generation_method);
  const nextToken: TokenSettings = { ...current.token, ...(updates.token_config ?? {}) };
  const nextCache: CacheSettings = { ...current.cache, ...(updates.cache_config ?? {}) };
  const nextPerformance: PerformanceSettings = { ...current.performance, ...(updates.performance_config ?? {}) };
  const nextRegister: RegisterSettings = { ...current.register, ...(updates.register_config ?? {}) };

  await dbRun(
    env.DB,
    "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    ["global", JSON.stringify(nextGlobal), now],
  );
  await dbRun(
    env.DB,
    "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    ["grok", JSON.stringify(nextGrok), now],
  );
  await dbRun(
    env.DB,
    "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    ["token", JSON.stringify(nextToken), now],
  );
  await dbRun(
    env.DB,
    "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    ["cache", JSON.stringify(nextCache), now],
  );
  await dbRun(
    env.DB,
    "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    ["performance", JSON.stringify(nextPerformance), now],
  );
  await dbRun(
    env.DB,
    "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    ["register", JSON.stringify(nextRegister), now],
  );
}

