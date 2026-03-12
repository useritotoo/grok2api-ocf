import assert from "node:assert/strict";
import test from "node:test";

import { applyCooldown, recordTokenFailure } from "../src/repo/tokens.ts";

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
          } else if (sql === "UPDATE tokens SET cooldown_until = ? WHERE token = ?") {
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
