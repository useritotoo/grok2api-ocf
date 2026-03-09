import type { Env } from "./env";

export interface CurrentConfig {
  app: Record<string, unknown>;
  proxy: Record<string, unknown>;
  retry: Record<string, unknown>;
  token: Record<string, unknown>;
  cache: Record<string, unknown>;
  chat: Record<string, unknown>;
  image: Record<string, unknown>;
  imagine_fast: Record<string, unknown>;
  video: Record<string, unknown>;
  voice: Record<string, unknown>;
  asset: Record<string, unknown>;
  nsfw: Record<string, unknown>;
  usage: Record<string, unknown>;
}

export const DEFAULT_CURRENT_CONFIG: CurrentConfig = {
  app: {
    app_url: "",
    app_key: "admin",
    api_key: "",
    function_enabled: false,
    function_key: "",
    image_format: "url",
    video_format: "html",
    temporary: true,
    disable_memory: true,
    stream: true,
    thinking: true,
    dynamic_statsig: true,
    custom_instruction: "",
    filter_tags: ["xaiartifact", "xai:tool_usage_card", "grok:render"],
  },
  proxy: {
    base_proxy_url: "",
    asset_proxy_url: "",
    cf_cookies: "",
    skip_proxy_ssl_verify: false,
    enabled: false,
    flaresolverr_url: "",
    refresh_interval: 3600,
    timeout: 60,
    cf_clearance: "",
    browser: "chrome136",
    user_agent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  },
  retry: {
    max_retry: 3,
    retry_status_codes: [401, 429, 403],
    reset_session_status_codes: [403],
    retry_backoff_base: 0.5,
    retry_backoff_factor: 2,
    retry_backoff_max: 20,
    retry_budget: 60,
  },
  token: {
    auto_refresh: true,
    refresh_interval_hours: 8,
    super_refresh_interval_hours: 2,
    fail_threshold: 5,
    save_delay_ms: 500,
    usage_flush_interval_sec: 5,
    reload_interval_sec: 30,
  },
  cache: {
    enable_auto_clean: true,
    limit_mb: 512,
  },
  chat: {
    concurrent: 50,
    timeout: 60,
    stream_timeout: 60,
  },
  image: {
    timeout: 60,
    stream_timeout: 60,
    final_timeout: 15,
    blocked_grace_seconds: 10,
    nsfw: true,
    medium_min_bytes: 30000,
    final_min_bytes: 100000,
    blocked_parallel_attempts: 5,
    blocked_parallel_enabled: true,
  },
  imagine_fast: {
    n: 1,
    size: "1024x1024",
    response_format: "url",
  },
  video: {
    concurrent: 100,
    timeout: 60,
    stream_timeout: 60,
    upscale_timing: "complete",
  },
  voice: {
    timeout: 60,
  },
  asset: {
    upload_concurrent: 100,
    upload_timeout: 60,
    download_concurrent: 100,
    download_timeout: 60,
    list_concurrent: 100,
    list_timeout: 60,
    list_batch_size: 50,
    delete_concurrent: 100,
    delete_timeout: 60,
    delete_batch_size: 50,
  },
  nsfw: {
    concurrent: 60,
    batch_size: 30,
    timeout: 60,
  },
  usage: {
    concurrent: 100,
    batch_size: 50,
    timeout: 60,
  },
};

const CONFIG_KEYS = Object.keys(DEFAULT_CURRENT_CONFIG) as Array<keyof CurrentConfig>;

function asPlainObject(input: unknown, fallback: Record<string, unknown>): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...fallback };
  return { ...fallback, ...(input as Record<string, unknown>) };
}

function parseSection(
  raw: string | undefined,
  fallback: Record<string, unknown>,
): Record<string, unknown> {
  if (!raw) return { ...fallback };
  try {
    return asPlainObject(JSON.parse(raw), fallback);
  } catch {
    return { ...fallback };
  }
}

async function ensureCurrentConfigSchema(env: Env): Promise<void> {
  const db = (env as Partial<Env>).DB;
  if (!db || typeof db !== "object") {
    throw new Error("DB binding unavailable");
  }
  const { ensureDbSchema } = await import("./schema");
  await ensureDbSchema(db);
}

export async function getCurrentConfig(env: Env): Promise<CurrentConfig> {
  await ensureCurrentConfigSchema(env);
  const result = {} as CurrentConfig;
  for (const key of CONFIG_KEYS) {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?")
      .bind(key)
      .first<{ value: string }>();
    result[key] = parseSection(row?.value, DEFAULT_CURRENT_CONFIG[key]);
  }
  return result;
}

export async function updateCurrentConfig(
  env: Env,
  updates: Partial<CurrentConfig>,
): Promise<CurrentConfig> {
  await ensureCurrentConfigSchema(env);
  const current = await getCurrentConfig(env);
  const next = { ...current } as CurrentConfig;
  const now = Date.now();

  for (const key of CONFIG_KEYS) {
    if (!(key in updates)) continue;
    const merged = asPlainObject(updates[key], current[key]);
    next[key] = merged;
    await env.DB.prepare(
      "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    )
      .bind(key, JSON.stringify(merged), now)
      .run();
  }

  return next;
}

export function getCurrentConfigSeedEntries(): Array<{ key: string; value: string }> {
  return CONFIG_KEYS.map((key) => ({
    key,
    value: JSON.stringify(DEFAULT_CURRENT_CONFIG[key]),
  }));
}

export function normalizeApiKeyList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .map((item) => String(item ?? "").trim())
      .filter(Boolean);
  }
  const value = String(raw ?? "").trim();
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
