CREATE TABLE IF NOT EXISTS function_sessions (
  task_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('imagine', 'video')),
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_function_sessions_expires ON function_sessions(expires_at);

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

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  (
    'app',
    '{"app_url":"","app_key":"admin","api_key":"","function_enabled":false,"function_key":"","image_format":"url","video_format":"html","temporary":true,"disable_memory":true,"stream":true,"thinking":true,"dynamic_statsig":true,"custom_instruction":"","filter_tags":["xaiartifact","xai:tool_usage_card","grok:render"]}',
    CAST(strftime('%s','now') AS INTEGER) * 1000
  ),
  (
    'proxy',
    '{"base_proxy_url":"","asset_proxy_url":"","cf_cookies":"","skip_proxy_ssl_verify":false,"enabled":false,"flaresolverr_url":"","refresh_interval":3600,"timeout":60,"cf_clearance":"","browser":"chrome136","user_agent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"}',
    CAST(strftime('%s','now') AS INTEGER) * 1000
  ),
  (
    'retry',
    '{"max_retry":3,"retry_status_codes":[401,429,403],"reset_session_status_codes":[403],"retry_backoff_base":0.5,"retry_backoff_factor":2,"retry_backoff_max":20,"retry_budget":60}',
    CAST(strftime('%s','now') AS INTEGER) * 1000
  ),
  (
    'token',
    '{"auto_refresh":true,"refresh_interval_hours":8,"super_refresh_interval_hours":2,"fail_threshold":5,"save_delay_ms":500,"usage_flush_interval_sec":5,"reload_interval_sec":30}',
    CAST(strftime('%s','now') AS INTEGER) * 1000
  ),
  (
    'cache',
    '{"enable_auto_clean":true,"limit_mb":512}',
    CAST(strftime('%s','now') AS INTEGER) * 1000
  ),
  (
    'chat',
    '{"concurrent":50,"timeout":60,"stream_timeout":60}',
    CAST(strftime('%s','now') AS INTEGER) * 1000
  ),
  (
    'image',
    '{"timeout":60,"stream_timeout":60,"final_timeout":15,"blocked_grace_seconds":10,"nsfw":true,"medium_min_bytes":30000,"final_min_bytes":100000,"blocked_parallel_attempts":5,"blocked_parallel_enabled":true}',
    CAST(strftime('%s','now') AS INTEGER) * 1000
  ),
  (
    'imagine_fast',
    '{"n":1,"size":"1024x1024","response_format":"url"}',
    CAST(strftime('%s','now') AS INTEGER) * 1000
  ),
  (
    'video',
    '{"concurrent":100,"timeout":60,"stream_timeout":60,"upscale_timing":"complete"}',
    CAST(strftime('%s','now') AS INTEGER) * 1000
  ),
  (
    'voice',
    '{"timeout":60}',
    CAST(strftime('%s','now') AS INTEGER) * 1000
  ),
  (
    'asset',
    '{"upload_concurrent":100,"upload_timeout":60,"download_concurrent":100,"download_timeout":60,"list_concurrent":100,"list_timeout":60,"list_batch_size":50,"delete_concurrent":100,"delete_timeout":60,"delete_batch_size":50}',
    CAST(strftime('%s','now') AS INTEGER) * 1000
  ),
  (
    'nsfw',
    '{"concurrent":60,"batch_size":30,"timeout":60}',
    CAST(strftime('%s','now') AS INTEGER) * 1000
  ),
  (
    'usage',
    '{"concurrent":100,"batch_size":50,"timeout":60}',
    CAST(strftime('%s','now') AS INTEGER) * 1000
  );
