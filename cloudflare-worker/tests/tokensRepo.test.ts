import assert from "node:assert/strict";
import test from "node:test";

import { applyCooldown, recordTokenFailure, selectBestToken } from "../src/repo/tokens.ts";

function createTokenDb(initial?: Partial<{ failed_count: number; status: string; cooldown_until: number | null }>) {
  const state = {
    failed_count: initial?.failed_count ?? 0,
    status: initial?.status ?? "active",
    cooldown_until: initial?.cooldown_until ?? null,
    last_failure_time: null as number | null,
    last_failure_reason: null as string | null,
  };

  const db: D1Database = {
    prepare(sql: string) {
      let params: unknown[] = [];
      return {
        bind(...bound: unknown[]) {
          params = bound;
          return this;
        },
        first<T>() {
          if (sql === "SELECT failed_count FROM tokens WHERE token = ?") {
            return Promise.resolve(({ failed_count: state.failed_count } as unknown) as T);
          }
          if (sql === "SELECT remaining_queries FROM tokens WHERE token = ?") {
            return Promise.resolve(({ remaining_queries: -1 } as unknown) as T);
          }
          return Promise.resolve(null);
        },
        all<T>() {
          return Promise.resolve({ results: [] as T[] });
        },
        run() {
          if (sql.includes("failed_count = failed_count + 1")) {
            state.failed_count += 1;
            state.last_failure_time = Number(params[0] ?? 0);
            state.last_failure_reason = String(params[1] ?? "");
          } else if (sql.includes("last_failure_time = ?") && sql.includes("last_failure_reason = ?")) {
            state.last_failure_time = Number(params[0] ?? 0);
            state.last_failure_reason = String(params[1] ?? "");
          } else if (sql === "UPDATE tokens SET status = 'expired' WHERE token = ?") {
            state.status = "expired";
          } else if (sql.startsWith("UPDATE tokens SET cooldown_until = ?")) {
            state.cooldown_until = Number(params[0] ?? 0);
          }
          return Promise.resolve({ success: true });
        },
      };
    },
    batch() {
      return Promise.resolve([]);
    },
  } as any;

  return { db, state };
}

function createSelectionDb(
  rows: Array<{
    token: string;
    token_type: "sso" | "ssoSuper";
    remaining_queries?: number;
    heavy_remaining_queries?: number;
    consumed?: number;
    status?: string;
    failed_count?: number;
    cooldown_until?: number | null;
    created_time?: number;
  }>,
  options?: {
    consumed_mode_enabled?: boolean;
  },
) {
  const normalized = rows.map((row, index) => ({
    token: row.token,
    token_type: row.token_type,
    remaining_queries: row.remaining_queries ?? -1,
    heavy_remaining_queries: row.heavy_remaining_queries ?? -1,
    consumed: row.consumed ?? 0,
    status: row.status ?? "active",
    failed_count: row.failed_count ?? 0,
    cooldown_until: row.cooldown_until ?? null,
    created_time: row.created_time ?? index + 1,
  }));

  const db: D1Database = {
    prepare(sql: string) {
      let params: unknown[] = [];
      return {
        bind(...bound: unknown[]) {
          params = bound;
          return this;
        },
        first<T>() {
          if (sql === "SELECT value FROM settings WHERE key = ?") {
            const key = String(params[0] ?? "");
            if (key === "token") {
              return Promise.resolve(
                ({
                  value: JSON.stringify({
                    consumed_mode_enabled: Boolean(options?.consumed_mode_enabled),
                  }),
                } as unknown) as T,
              );
            }
            return Promise.resolve(null);
          }
          if (sql.includes("SELECT token FROM tokens")) {
            const tokenType = String(params[0] ?? "");
            const maxFailures = Number(params[1] ?? 0);
            const now = Number(params[2] ?? 0);
            const consumedMode = sql.includes("ORDER BY consumed ASC");
            const field = sql.includes("heavy_remaining_queries") ? "heavy_remaining_queries" : "remaining_queries";
            const candidates = normalized
              .filter((row) => row.token_type === tokenType)
              .filter((row) => row.status !== "expired")
              .filter((row) => row.failed_count < maxFailures)
              .filter((row) => row.cooldown_until === null || row.cooldown_until <= now)
              .filter((row) => consumedMode || Number(row[field]) !== 0)
              .sort((a, b) => {
                if (consumedMode) {
                  if (Number(a.consumed) !== Number(b.consumed)) {
                    return Number(a.consumed) - Number(b.consumed);
                  }
                  return Number(a.created_time) - Number(b.created_time);
                }
                const aUnlimited = Number(a[field]) === -1 ? 0 : 1;
                const bUnlimited = Number(b[field]) === -1 ? 0 : 1;
                if (aUnlimited !== bUnlimited) return aUnlimited - bUnlimited;
                if (Number(a[field]) !== Number(b[field])) return Number(b[field]) - Number(a[field]);
                return Number(a.created_time) - Number(b.created_time);
              });
            const picked = candidates[0];
            return Promise.resolve(picked ? (({ token: picked.token } as unknown) as T) : null);
          }
          return Promise.resolve(null);
        },
        all<T>() {
          return Promise.resolve({ results: [] as T[] });
        },
        run() {
          return Promise.resolve({ success: true });
        },
      };
    },
    batch() {
      return Promise.resolve([]);
    },
  } as any;

  return db;
}

test("429 failures only update last failure metadata and do not expire tokens", async () => {
  const { db, state } = createTokenDb({ failed_count: 2 });

  await recordTokenFailure(db as any, "token-1", 429, "rate limited");

  assert.equal(state.failed_count, 2);
  assert.equal(state.status, "active");
  assert.match(state.last_failure_reason ?? "", /^429:/);
});

test("401 failures still expire tokens after the threshold", async () => {
  const { db, state } = createTokenDb({ failed_count: 2 });

  await recordTokenFailure(db as any, "token-1", 401, "unauthorized");

  assert.equal(state.failed_count, 3);
  assert.equal(state.status, "expired");
});

test("429 cooldown stays short on the worker pool", async () => {
  const { db, state } = createTokenDb();
  const before = Date.now();

  await applyCooldown(db as any, "token-1", 429);

  const cooldownMs = Number(state.cooldown_until ?? 0) - before;
  assert.ok(cooldownMs >= 55_000, `cooldown too short: ${cooldownMs}`);
  assert.ok(cooldownMs <= 180_000, `cooldown too long: ${cooldownMs}`);
});

test("video 720p requests prefer ssoSuper tokens before sso basic tokens", async () => {
  const db = createSelectionDb([
    { token: "basic-token", token_type: "sso", created_time: 1 },
    { token: "super-token", token_type: "ssoSuper", created_time: 2 },
  ]);

  const selected = await selectBestToken(db as any, "grok-imagine-1.0-video", {
    resolution_name: "720p",
    video_length: 6,
  } as any);

  assert.deepEqual(selected, { token: "super-token", token_type: "ssoSuper" });
});

test("video 720p requests fall back to sso basic tokens when no super token is available", async () => {
  const db = createSelectionDb([{ token: "basic-token", token_type: "sso", created_time: 1 }]);

  const selected = await selectBestToken(db as any, "grok-imagine-1.0-video", {
    resolution_name: "720p",
    video_length: 6,
  } as any);

  assert.deepEqual(selected, { token: "basic-token", token_type: "sso" });
});

test("consumed mode prefers the least consumed active token even when quota is 0", async () => {
  const db = createSelectionDb(
    [
      {
        token: "least-consumed",
        token_type: "sso",
        remaining_queries: 0,
        consumed: 0,
        status: "active",
        created_time: 1,
      },
      {
        token: "more-consumed",
        token_type: "sso",
        remaining_queries: 80,
        consumed: 5,
        status: "active",
        created_time: 2,
      },
    ],
    { consumed_mode_enabled: true },
  );

  const selected = await selectBestToken(db as any, "grok-4");

  assert.deepEqual(selected, { token: "least-consumed", token_type: "sso" });
});
