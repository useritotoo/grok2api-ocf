import type { Env } from "../env";
import { dbAll, dbFirst, dbRun } from "../db";
import { nowMs } from "../utils/time";
import { requiresSuperVideoToken, type VideoConfigInput } from "../grok/video";

export type TokenType = "sso" | "ssoSuper";

export interface TokenRow {
  token: string;
  token_type: TokenType;
  created_time: number;
  remaining_queries: number;
  heavy_remaining_queries: number;
  consumed: number;
  status: string;
  tags: string; // JSON string
  note: string;
  cooldown_until: number | null;
  last_failure_time: number | null;
  last_failure_reason: string | null;
  failed_count: number;
  last_asset_clear_at: number | null;
}

const DEFAULT_FAIL_THRESHOLD = 3;
const SHORT_COOLDOWN_SECONDS = 30;
const RATE_LIMIT_COOLDOWN_SECONDS = 90;
const AUTH_COOLDOWN_SECONDS = 60;
const TOKEN_CONFIG_CACHE_TTL_MS = 1000;
const tokenConfigCache = new WeakMap<
  Env["DB"],
  { value: { consumedModeEnabled: boolean; failThreshold: number }; expiresAt: number }
>();

function isTokenAuthFailure(status: number): boolean {
  return status === 401 || status === 403;
}

function parseTags(tagsJson: string): string[] {
  try {
    const v = JSON.parse(tagsJson) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function normalizeConsumed(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

async function getTokenRuntimeConfig(
  db: Env["DB"],
): Promise<{ consumedModeEnabled: boolean; failThreshold: number }> {
  const now = Date.now();
  const cached = tokenConfigCache.get(db);
  if (cached && cached.expiresAt > now) return cached.value;

  let consumedModeEnabled = false;
  let failThreshold = DEFAULT_FAIL_THRESHOLD;
  try {
    const row = await dbFirst<{ value: string }>(db, "SELECT value FROM settings WHERE key = ?", ["token"]);
    if (row?.value) {
      try {
        const parsed = JSON.parse(row.value) as Record<string, unknown>;
        consumedModeEnabled = Boolean(parsed?.consumed_mode_enabled);
        const parsedFailThreshold = Number(parsed?.fail_threshold);
        if (Number.isFinite(parsedFailThreshold) && parsedFailThreshold > 0) {
          failThreshold = Math.floor(parsedFailThreshold);
        }
      } catch {
        consumedModeEnabled = false;
        failThreshold = DEFAULT_FAIL_THRESHOLD;
      }
    }
  } catch {
    consumedModeEnabled = false;
    failThreshold = DEFAULT_FAIL_THRESHOLD;
  }

  const value = { consumedModeEnabled, failThreshold };
  tokenConfigCache.set(db, { value, expiresAt: now + TOKEN_CONFIG_CACHE_TTL_MS });
  return value;
}

function getSelectionCost(model: string): number {
  return model === "grok-4-heavy" ? 4 : 1;
}

async function incrementTokenConsumed(db: Env["DB"], token: string, amount: number): Promise<void> {
  const safeAmount = Math.max(0, Math.floor(Number(amount) || 0));
  if (!safeAmount) return;
  await dbRun(db, "UPDATE tokens SET consumed = COALESCE(consumed, 0) + ? WHERE token = ?", [safeAmount, token]);
}

export function tokenRowToInfo(row: TokenRow): {
  token: string;
  token_type: TokenType;
  created_time: number;
  remaining_queries: number;
  heavy_remaining_queries: number;
  consumed: number;
  status: string;
  tags: string[];
  note: string;
  cooldown_until: number | null;
  last_failure_time: number | null;
  last_failure_reason: string;
  limit_reason: string;
  cooldown_remaining: number;
  last_asset_clear_at: number | null;
} {
  const now = nowMs();
  const cooldownRemainingMs =
    row.cooldown_until && row.cooldown_until > now ? row.cooldown_until - now : 0;
  const cooldown_remaining = cooldownRemainingMs ? Math.floor((cooldownRemainingMs + 999) / 1000) : 0;
  const limit_reason = cooldownRemainingMs
    ? "cooldown"
    : row.token_type === "ssoSuper"
      ? row.remaining_queries === 0 || row.heavy_remaining_queries === 0
        ? "exhausted"
        : ""
      : row.remaining_queries === 0
        ? "exhausted"
        : "";

  const status = (() => {
    if (row.status === "expired") return "失效";
    if (cooldownRemainingMs) return "冷却中";
    if (row.token_type === "ssoSuper") {
      if (row.remaining_queries === -1 && row.heavy_remaining_queries === -1) return "未使用";
      if (row.remaining_queries === 0 || row.heavy_remaining_queries === 0) return "额度耗尽";
      return "正常";
    }
    if (row.remaining_queries === -1) return "未使用";
    if (row.remaining_queries === 0) return "额度耗尽";
    return "正常";
  })();

  return {
    token: row.token,
    token_type: row.token_type,
    created_time: row.created_time,
    remaining_queries: row.remaining_queries,
    heavy_remaining_queries: row.heavy_remaining_queries,
    consumed: normalizeConsumed(row.consumed),
    status,
    tags: parseTags(row.tags),
    note: row.note ?? "",
    cooldown_until: row.cooldown_until,
    last_failure_time: row.last_failure_time,
    last_failure_reason: row.last_failure_reason ?? "",
    limit_reason,
    cooldown_remaining,
    last_asset_clear_at: row.last_asset_clear_at,
  };
}

export async function listTokens(db: Env["DB"]): Promise<TokenRow[]> {
  return dbAll<TokenRow>(
    db,
    "SELECT token, token_type, created_time, remaining_queries, heavy_remaining_queries, consumed, status, tags, note, cooldown_until, last_failure_time, last_failure_reason, failed_count, last_asset_clear_at FROM tokens ORDER BY created_time DESC",
  );
}

export async function countTokens(db: Env["DB"]): Promise<number> {
  const row = await dbFirst<{ c: number }>(db, "SELECT COUNT(1) as c FROM tokens");
  return row?.c ?? 0;
}

export async function listTokensPage(
  db: Env["DB"],
  limit: number,
  offset: number,
): Promise<TokenRow[]> {
  return dbAll<TokenRow>(
    db,
    "SELECT token, token_type, created_time, remaining_queries, heavy_remaining_queries, consumed, status, tags, note, cooldown_until, last_failure_time, last_failure_reason, failed_count, last_asset_clear_at FROM tokens ORDER BY created_time DESC LIMIT ? OFFSET ?",
    [limit, offset],
  );
}

export async function addTokens(db: Env["DB"], tokens: string[], token_type: TokenType): Promise<number> {
  const now = nowMs();
  const cleaned = tokens.map((t) => t.trim()).filter(Boolean);
  if (!cleaned.length) return 0;

  const stmts = cleaned.map((t) =>
    db
      .prepare(
        "INSERT OR REPLACE INTO tokens(token, token_type, created_time, remaining_queries, heavy_remaining_queries, consumed, status, failed_count, cooldown_until, last_failure_time, last_failure_reason, tags, note) VALUES(?,?,?,?,?,0,'active',0,NULL,NULL,NULL,'[]','')",
      )
      .bind(t, token_type, now, -1, -1),
  );
  await db.batch(stmts);
  return cleaned.length;
}

export async function deleteTokens(db: Env["DB"], tokens: string[], token_type: TokenType): Promise<number> {
  const cleaned = tokens.map((t) => t.trim()).filter(Boolean);
  if (!cleaned.length) return 0;
  const placeholders = cleaned.map(() => "?").join(",");
  const before = await dbFirst<{ c: number }>(
    db,
    `SELECT COUNT(1) as c FROM tokens WHERE token_type = ? AND token IN (${placeholders})`,
    [token_type, ...cleaned],
  );
  await dbRun(db, `DELETE FROM tokens WHERE token_type = ? AND token IN (${placeholders})`, [token_type, ...cleaned]);
  return before?.c ?? 0;
}

export async function updateTokenTags(db: Env["DB"], token: string, token_type: TokenType, tags: string[]): Promise<void> {
  const cleaned = tags.map((t) => t.trim()).filter(Boolean);
  await dbRun(db, "UPDATE tokens SET tags = ? WHERE token = ? AND token_type = ?", [
    JSON.stringify(cleaned),
    token,
    token_type,
  ]);
}

export async function updateTokenNote(db: Env["DB"], token: string, token_type: TokenType, note: string): Promise<void> {
  await dbRun(db, "UPDATE tokens SET note = ? WHERE token = ? AND token_type = ?", [note.trim(), token, token_type]);
}

export async function getAllTags(db: Env["DB"]): Promise<string[]> {
  const rows = await dbAll<{ tags: string }>(db, "SELECT tags FROM tokens");
  const set = new Set<string>();
  for (const r of rows) {
    for (const t of parseTags(r.tags)) set.add(t);
  }
  return [...set].sort();
}

export async function selectBestToken(
  db: Env["DB"],
  model: string,
  options?: VideoConfigInput,
): Promise<{ token: string; token_type: TokenType } | null> {
  const now = nowMs();
  const isHeavy = model === "grok-4-heavy";
  const isVideo = model === "grok-imagine-1.0-video";
  const field = isHeavy ? "heavy_remaining_queries" : "remaining_queries";
  const preferSuperVideo = isVideo && requiresSuperVideoToken(options);
  const { consumedModeEnabled, failThreshold } = await getTokenRuntimeConfig(db);

  const pick = async (token_type: TokenType): Promise<{ token: string; token_type: TokenType } | null> => {
    const row = await dbFirst<{ token: string }>(
      db,
      consumedModeEnabled
        ? `SELECT token FROM tokens
       WHERE token_type = ?
         AND status = 'active'
         AND failed_count < ?
         AND (cooldown_until IS NULL OR cooldown_until <= ?)
       ORDER BY consumed ASC, created_time ASC
       LIMIT 1`
        : `SELECT token FROM tokens
       WHERE token_type = ?
         AND status != 'expired'
         AND failed_count < ?
         AND (cooldown_until IS NULL OR cooldown_until <= ?)
         AND ${field} != 0
       ORDER BY CASE WHEN ${field} = -1 THEN 0 ELSE 1 END, ${field} DESC, created_time ASC
       LIMIT 1`,
      [token_type, failThreshold, now],
    );
    if (!row) return null;
    if (consumedModeEnabled) {
      await incrementTokenConsumed(db, row.token, getSelectionCost(model));
    }
    return { token: row.token, token_type };
  };

  if (isHeavy) return pick("ssoSuper");
  if (preferSuperVideo) {
    return (await pick("ssoSuper")) ?? (await pick("sso"));
  }

  return (await pick("sso")) ?? (await pick("ssoSuper"));
}

export async function recordTokenFailure(
  db: Env["DB"],
  token: string,
  status: number,
  message: string,
): Promise<void> {
  const { failThreshold } = await getTokenRuntimeConfig(db);
  const now = nowMs();
  const reason = `${status}: ${message}`;
  if (isTokenAuthFailure(status)) {
    await dbRun(
      db,
      "UPDATE tokens SET failed_count = failed_count + 1, last_failure_time = ?, last_failure_reason = ? WHERE token = ?",
      [now, reason, token],
    );

    const row = await dbFirst<{ failed_count: number }>(db, "SELECT failed_count FROM tokens WHERE token = ?", [token]);
    if (!row) return;
    if (row.failed_count >= failThreshold) {
      await dbRun(db, "UPDATE tokens SET status = 'expired' WHERE token = ?", [token]);
    }
    return;
  }

  await dbRun(
    db,
    "UPDATE tokens SET last_failure_time = ?, last_failure_reason = ? WHERE token = ?",
    [now, reason, token],
  );
}

export async function applyCooldown(
  db: Env["DB"],
  token: string,
  status: number,
  retryAfterSeconds?: number,
): Promise<void> {
  const now = nowMs();
  const retryAfter =
    Number.isFinite(retryAfterSeconds) && Number(retryAfterSeconds) > 0
      ? Math.max(15, Math.min(300, Math.floor(Number(retryAfterSeconds))))
      : null;
  const seconds =
    status === 429
      ? (retryAfter ?? RATE_LIMIT_COOLDOWN_SECONDS)
      : isTokenAuthFailure(status)
        ? AUTH_COOLDOWN_SECONDS
        : SHORT_COOLDOWN_SECONDS;
  const until = now + seconds * 1000;
  await dbRun(db, "UPDATE tokens SET cooldown_until = ?, consumed = 0 WHERE token = ?", [until, token]);
}

export async function updateTokenLimits(
  db: Env["DB"],
  token: string,
  updates: { remaining_queries?: number; heavy_remaining_queries?: number },
): Promise<void> {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (typeof updates.remaining_queries === "number") {
    parts.push("remaining_queries = ?");
    params.push(updates.remaining_queries);
  }
  if (typeof updates.heavy_remaining_queries === "number") {
    parts.push("heavy_remaining_queries = ?");
    params.push(updates.heavy_remaining_queries);
  }
  if (!parts.length) return;
  params.push(token);
  await dbRun(db, `UPDATE tokens SET ${parts.join(", ")} WHERE token = ?`, params);
}

export async function updateTokenAssetClearAt(
  db: Env["DB"],
  token: string,
  at: number | null,
): Promise<void> {
  await dbRun(db, "UPDATE tokens SET last_asset_clear_at = ? WHERE token = ?", [at, token]);
}
