import type { Env } from "./env";
import { getCurrentConfigSeedEntries } from "./currentConfig";

function escapeSqlString(value: string): string {
  return value.replaceAll("'", "''");
}

const CURRENT_CONFIG_SEED_SQL = getCurrentConfigSeedEntries()
  .map(
    ({ key, value }) =>
      `  ('${escapeSqlString(key)}','${escapeSqlString(value)}',CAST(strftime('%s','now') AS INTEGER) * 1000)`,
  )
  .join(",\n");

const BASE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY,
  token_type TEXT NOT NULL CHECK (token_type IN ('sso', 'ssoSuper')),
  created_time INTEGER NOT NULL,
  remaining_queries INTEGER NOT NULL DEFAULT -1,
  heavy_remaining_queries INTEGER NOT NULL DEFAULT -1,
  status TEXT NOT NULL DEFAULT 'active',
  failed_count INTEGER NOT NULL DEFAULT 0,
  cooldown_until INTEGER,
  last_failure_time INTEGER,
  last_failure_reason TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_tokens_type ON tokens(token_type);
CREATE INDEX IF NOT EXISTS idx_tokens_status ON tokens(status);
CREATE INDEX IF NOT EXISTS idx_tokens_cooldown_until ON tokens(cooldown_until);

CREATE TABLE IF NOT EXISTS api_keys (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expires_at);

CREATE TABLE IF NOT EXISTS function_sessions (
  task_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('imagine', 'video')),
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_function_sessions_expires ON function_sessions(expires_at);

CREATE TABLE IF NOT EXISTS request_logs (
  id TEXT PRIMARY KEY,
  time TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  ip TEXT NOT NULL,
  model TEXT NOT NULL,
  duration REAL NOT NULL,
  status INTEGER NOT NULL,
  key_name TEXT NOT NULL,
  token_suffix TEXT NOT NULL,
  error TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_request_logs_timestamp ON request_logs(timestamp);

CREATE TABLE IF NOT EXISTS token_refresh_progress (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  running INTEGER NOT NULL DEFAULT 0,
  current INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  success INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO token_refresh_progress (id, running, current, total, success, failed, updated_at)
VALUES (1, 0, 0, 0, 0, 0, CAST(strftime('%s','now') AS INTEGER) * 1000);

CREATE TABLE IF NOT EXISTS batch_tasks (
  task_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'cancelled', 'error')),
  total INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  success INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  cancelled INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_batch_tasks_expires ON batch_tasks(expires_at);

INSERT OR IGNORE INTO settings (key, value, updated_at)
VALUES
  (
    'global',
    '{"base_url":"","log_level":"INFO","image_mode":"url","admin_password":"admin","admin_username":"admin","image_cache_max_size_mb":512,"video_cache_max_size_mb":1024}',
    CAST(strftime('%s','now') AS INTEGER) * 1000
  ),
  (
    'grok',
    '{"api_key":"","proxy_url":"","proxy_pool_url":"","proxy_pool_interval":300,"cache_proxy_url":"","cf_clearance":"","x_statsig_id":"","dynamic_statsig":true,"filtered_tags":"xaiartifact,xai:tool_usage_card","show_thinking":true,"temporary":false,"stream_first_response_timeout":30,"stream_chunk_timeout":120,"stream_total_timeout":600,"retry_status_codes":[401,429]}',
    CAST(strftime('%s','now') AS INTEGER) * 1000
  ),
${CURRENT_CONFIG_SEED_SQL};
`;

const CACHE_SCHEMA_SQL = `
DROP TABLE IF EXISTS r2_cache;

CREATE TABLE IF NOT EXISTS kv_cache (
  key TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('image', 'video')),
  size INTEGER NOT NULL,
  content_type TEXT,
  created_at INTEGER NOT NULL,
  last_access_at INTEGER NOT NULL,
  expires_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_kv_cache_type_access ON kv_cache(type, last_access_at);
`;

const SETTINGS_SECTIONS_SQL = `
INSERT OR IGNORE INTO settings (key, value, updated_at)
VALUES
  (
    'token',
    '{"auto_refresh":true,"refresh_interval_hours":8,"fail_threshold":5,"save_delay_ms":500,"reload_interval_sec":30}',
    CAST(strftime('%s','now') AS INTEGER) * 1000
  ),
  (
    'cache',
    '{"enable_auto_clean":true,"limit_mb":1024,"keep_base64_cache":true}',
    CAST(strftime('%s','now') AS INTEGER) * 1000
  ),
  (
    'performance',
    '{"assets_max_concurrent":25,"media_max_concurrent":50,"usage_max_concurrent":25,"assets_delete_batch_size":10,"admin_assets_batch_size":10}',
    CAST(strftime('%s','now') AS INTEGER) * 1000
  ),
  (
    'register',
    '{"worker_domain":"","email_domain":"","admin_password":"","yescaptcha_key":"","solver_url":"http://127.0.0.1:5072","solver_browser_type":"camoufox","solver_threads":5,"register_threads":10,"default_count":100,"auto_start_solver":true,"solver_debug":false,"max_errors":0,"max_runtime_minutes":0}',
    CAST(strftime('%s','now') AS INTEGER) * 1000
  );
`;

const API_KEY_USAGE_SQL = `
CREATE TABLE IF NOT EXISTS api_key_usage_daily (
  key TEXT NOT NULL,
  day TEXT NOT NULL,
  chat_used INTEGER NOT NULL DEFAULT 0,
  heavy_used INTEGER NOT NULL DEFAULT 0,
  image_used INTEGER NOT NULL DEFAULT 0,
  video_used INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (key, day)
);

CREATE INDEX IF NOT EXISTS idx_api_key_usage_day ON api_key_usage_daily(day);
`;

const schemaReady = new WeakMap<Env["DB"], Promise<void>>();

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inString = false;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]!;
    current += char;

    if (char === "'") {
      const next = sql[i + 1];
      if (inString && next === "'") {
        current += next;
        i += 1;
        continue;
      }
      inString = !inString;
      continue;
    }

    if (char === ";" && !inString) {
      const statement = current.slice(0, -1).trim();
      if (statement) statements.push(statement);
      current = "";
    }
  }

  const trailing = current.trim();
  if (trailing) statements.push(trailing);
  return statements;
}

async function runSqlBundle(db: Env["DB"], sql: string): Promise<void> {
  const statements = splitSqlStatements(sql).map((statement) => db.prepare(statement));
  if (!statements.length) return;
  await db.batch(statements);
}

async function ensureApiKeyQuotaColumns(db: Env["DB"]): Promise<void> {
  const res = await db.prepare("PRAGMA table_info(api_keys)").all<{ name: string }>();
  const columns = new Set((res.results ?? []).map((row) => String(row.name)));

  if (!columns.has("chat_limit")) {
    await db.prepare("ALTER TABLE api_keys ADD COLUMN chat_limit INTEGER NOT NULL DEFAULT -1").run();
  }
  if (!columns.has("heavy_limit")) {
    await db.prepare("ALTER TABLE api_keys ADD COLUMN heavy_limit INTEGER NOT NULL DEFAULT -1").run();
  }
  if (!columns.has("image_limit")) {
    await db.prepare("ALTER TABLE api_keys ADD COLUMN image_limit INTEGER NOT NULL DEFAULT -1").run();
  }
  if (!columns.has("video_limit")) {
    await db.prepare("ALTER TABLE api_keys ADD COLUMN video_limit INTEGER NOT NULL DEFAULT -1").run();
  }
}

async function ensureTokenMetadataColumns(db: Env["DB"]): Promise<void> {
  const res = await db.prepare("PRAGMA table_info(tokens)").all<{ name: string }>();
  const columns = new Set((res.results ?? []).map((row) => String(row.name)));

  if (!columns.has("last_asset_clear_at")) {
    await db.prepare("ALTER TABLE tokens ADD COLUMN last_asset_clear_at INTEGER").run();
  }
}

async function ensureDbSchemaInternal(db: Env["DB"]): Promise<void> {
  await runSqlBundle(db, BASE_SCHEMA_SQL);
  await runSqlBundle(db, CACHE_SCHEMA_SQL);
  await runSqlBundle(db, SETTINGS_SECTIONS_SQL);
  await ensureApiKeyQuotaColumns(db);
  await ensureTokenMetadataColumns(db);
  await runSqlBundle(db, API_KEY_USAGE_SQL);
}

export function ensureDbSchema(db: Env["DB"]): Promise<void> {
  const cached = schemaReady.get(db);
  if (cached) return cached;

  const pending = ensureDbSchemaInternal(db).catch((error) => {
    schemaReady.delete(db);
    throw error;
  });
  schemaReady.set(db, pending);
  return pending;
}
