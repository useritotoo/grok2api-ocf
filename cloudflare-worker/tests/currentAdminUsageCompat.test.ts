import assert from "node:assert/strict";
import test from "node:test";

import { runRefreshBatch } from "../src/routes/currentAdmin.ts";

const originalFetch = globalThis.fetch;

function createRefreshBatchDb() {
  const settings = new Map<string, string>([
    ["usage", JSON.stringify({ concurrent: 2, batch_size: 2, timeout: 7 })],
  ]);
  const batchTask = {
    cancelled: 0,
    processed: 0,
    success: 0,
    failed: 0,
    status: "running",
    result: null as string | null,
  };
  const tokenRows = new Map<string, { token_type: "sso" | "ssoSuper"; remaining?: number; heavy?: number }>([
    ["token-a", { token_type: "sso" }],
    ["token-b", { token_type: "ssoSuper" }],
    ["token-c", { token_type: "sso" }],
  ]);

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
            const value = settings.get(key);
            return Promise.resolve(value ? ({ value } as T) : null);
          }
          if (sql === "SELECT cancelled FROM batch_tasks WHERE task_id = ?") {
            return Promise.resolve(({ cancelled: batchTask.cancelled } as unknown) as T);
          }
          if (sql.startsWith("SELECT task_id, kind, status, total, processed")) {
            return Promise.resolve(
              ({
                task_id: "task-1",
                kind: "tokens_refresh",
                status: batchTask.status,
                total: 3,
                processed: batchTask.processed,
                success: batchTask.success,
                failed: batchTask.failed,
                cancelled: batchTask.cancelled,
                result: batchTask.result,
                error: null,
                created_at: 1,
                updated_at: 1,
                expires_at: Date.now() + 60_000,
              } as unknown) as T,
            );
          }
          return Promise.resolve(null);
        },
        all<T>() {
          if (sql.includes("SELECT key, value FROM settings WHERE key IN")) {
            return Promise.resolve({
              results: [...settings.entries()].map(([key, value]) => ({ key, value })) as T[],
            });
          }
          if (sql.startsWith("SELECT token, token_type FROM tokens WHERE token IN")) {
            const requested = params.map((item) => String(item ?? ""));
            return Promise.resolve({
              results: requested
                .map((token) => {
                  const row = tokenRows.get(token);
                  return row ? { token, token_type: row.token_type } : null;
                })
                .filter(Boolean) as T[],
            });
          }
          return Promise.resolve({ results: [] as T[] });
        },
        run() {
          if (sql.startsWith("UPDATE tokens SET")) {
            const token = String(params.at(-1) ?? "");
            const row = tokenRows.get(token);
            if (row) {
              if (sql.includes("remaining_queries = ?")) row.remaining = Number(params[0] ?? 0);
              if (sql.includes("heavy_remaining_queries = ?")) {
                row.heavy = Number(sql.includes("remaining_queries = ?") ? params[1] ?? 0 : params[0] ?? 0);
              }
            }
          }
          if (sql.startsWith("UPDATE batch_tasks SET processed = ?")) {
            batchTask.processed = Number(params[0] ?? 0);
            batchTask.success = Number(params[1] ?? 0);
            batchTask.failed = Number(params[2] ?? 0);
          }
          if (sql.startsWith("UPDATE batch_tasks SET status = ?")) {
            batchTask.status = String(params[0] ?? "completed");
            batchTask.processed = Number(params[1] ?? batchTask.processed);
            batchTask.success = Number(params[2] ?? batchTask.success);
            batchTask.failed = Number(params[3] ?? batchTask.failed);
            batchTask.result = params[4] ? String(params[4]) : null;
          }
          return Promise.resolve({ success: true });
        },
      };
    },
    batch() {
      return Promise.resolve([]);
    },
  } as any;

  return { db, tokenRows, batchTask };
}

test("runRefreshBatch consumes usage timeout and concurrency from current config", async () => {
  const originalTimeout = AbortSignal.timeout;
  const sentinelSignal = new AbortController().signal;
  const timeoutCalls: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  (AbortSignal as any).timeout = (ms: number) => {
    timeoutCalls.push(ms);
    return sentinelSignal;
  };

  const { db, tokenRows, batchTask } = createRefreshBatchDb();

  try {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      assert.equal(init?.signal, sentinelSignal);
      const body = JSON.parse(String(init?.body ?? "{}")) as { modelName?: string };
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return new Response(
        JSON.stringify({
          remainingTokens: body.modelName === "grok-4-heavy" ? 4 : 12,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;

    await runRefreshBatch(
      {
        DB: db,
      } as any,
      "task-1",
      ["token-a", "token-b", "token-c"],
    );

    assert.deepEqual(timeoutCalls, [7000, 7000, 7000, 7000]);
    assert.equal(maxInFlight, 2);
    assert.equal(batchTask.status, "completed");
    assert.equal(batchTask.processed, 3);
    assert.equal(batchTask.success, 3);
    assert.equal(batchTask.failed, 0);
    assert.equal(tokenRows.get("token-a")?.remaining, 12);
    assert.equal(tokenRows.get("token-b")?.remaining, 12);
    assert.equal(tokenRows.get("token-b")?.heavy, 4);
    assert.equal(tokenRows.get("token-c")?.remaining, 12);
  } finally {
    (AbortSignal as any).timeout = originalTimeout;
    globalThis.fetch = originalFetch;
  }
});

