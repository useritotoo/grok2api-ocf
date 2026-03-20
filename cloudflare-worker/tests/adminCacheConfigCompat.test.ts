import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.ts";

const originalFetch = globalThis.fetch;

function createExecutionContext(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as any;
}

function createCacheAdminDb() {
  const settings = new Map<string, string>([
    ["app", JSON.stringify({ app_key: "admin", api_key: "" })],
    ["asset", JSON.stringify({ list_batch_size: 2, list_concurrent: 4 })],
  ]);
  const tokens = [
    {
      token: "token-a",
      token_type: "sso",
      created_time: 1,
      remaining_queries: -1,
      heavy_remaining_queries: -1,
      consumed: 0,
      status: "active",
      tags: "[]",
      note: "",
      cooldown_until: null,
      last_failure_time: null,
      last_failure_reason: null,
      failed_count: 0,
      last_asset_clear_at: null,
    },
    {
      token: "token-b",
      token_type: "sso",
      created_time: 2,
      remaining_queries: -1,
      heavy_remaining_queries: -1,
      consumed: 0,
      status: "active",
      tags: "[]",
      note: "",
      cooldown_until: null,
      last_failure_time: null,
      last_failure_reason: null,
      failed_count: 0,
      last_asset_clear_at: null,
    },
    {
      token: "token-c",
      token_type: "sso",
      created_time: 3,
      remaining_queries: -1,
      heavy_remaining_queries: -1,
      consumed: 0,
      status: "active",
      tags: "[]",
      note: "",
      cooldown_until: null,
      last_failure_time: null,
      last_failure_reason: null,
      failed_count: 0,
      last_asset_clear_at: null,
    },
  ];

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
          return Promise.resolve(null);
        },
        all<T>() {
          if (sql.includes("SELECT key, value FROM settings WHERE key IN")) {
            return Promise.resolve({
              results: [...settings.entries()].map(([key, value]) => ({ key, value })) as T[],
            });
          }
          if (sql.startsWith("SELECT token, token_type, created_time")) {
            return Promise.resolve({ results: tokens as T[] });
          }
          if (sql === "SELECT type as type, COUNT(1) as count, COALESCE(SUM(size),0) as bytes FROM kv_cache GROUP BY type") {
            return Promise.resolve({ results: [] as T[] });
          }
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

test("admin cache route respects asset.list_batch_size as the token-level parallel cap", async () => {
  let inFlight = 0;
  let maxInFlight = 0;

  try {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).startsWith("https://grok.com/rest/assets")) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return new Response(JSON.stringify({ assets: [], nextPageToken: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(input);
    }) as typeof fetch;

    const response = await (worker.fetch as any)(
      new Request("https://example.com/api/v1/admin/cache?scope=all&include_accounts=0&include_details=1", {
        headers: { Authorization: "Bearer admin" },
      }),
      {
        DB: createCacheAdminDb(),
        BUILD_SHA: "dev",
        CACHE_RESET_TZ_OFFSET_MINUTES: "480",
        KV_CLEANUP_BATCH: "200",
      } as any,
      createExecutionContext(),
    );

    assert.equal(response.status, 200);
    assert.equal(maxInFlight, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
