import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.ts";

function createExecutionContext(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as any;
}

function createAssetBinding(): Fetcher {
  return {
    fetch(request: Request): Promise<Response> {
      const pathname = new URL(request.url).pathname;
      return Promise.resolve(new Response(`asset:${pathname}`, { status: 200 }));
    },
    connect() {
      throw new Error("Socket connections are not used in these tests");
    },
  } as any;
}

function createAdminTokenDb(): D1Database {
  const settings = new Map<string, string>([
    ["app", JSON.stringify({ app_key: "admin", api_key: "", function_enabled: true })],
    ["token", JSON.stringify({ consumed_mode_enabled: true })],
  ]);
  const tokenRows = [
    {
      token: "worker-basic",
      token_type: "sso",
      created_time: 1,
      remaining_queries: 80,
      heavy_remaining_queries: -1,
      status: "active",
      tags: "[]",
      note: "",
      cooldown_until: null,
      last_failure_time: null,
      last_failure_reason: null,
      failed_count: 0,
      last_asset_clear_at: null,
      consumed: 4,
    },
  ];

  return {
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
          if (sql === "SELECT COUNT(1) as c FROM api_keys WHERE is_active = 1") {
            return Promise.resolve(({ c: 0 } as unknown) as T);
          }
          return Promise.resolve(null);
        },
        all<T>() {
          if (sql.includes("SELECT key, value FROM settings")) {
            return Promise.resolve({
              results: [...settings.entries()].map(([key, value]) => ({ key, value })) as T[],
            });
          }
          if (sql.includes("SELECT token, token_type, created_time")) {
            return Promise.resolve({ results: tokenRows as T[] });
          }
          if (sql === "PRAGMA table_info(tokens)") {
            return Promise.resolve({
              results: [
                { name: "token" },
                { name: "token_type" },
                { name: "created_time" },
                { name: "remaining_queries" },
                { name: "heavy_remaining_queries" },
                { name: "status" },
                { name: "failed_count" },
                { name: "cooldown_until" },
                { name: "last_failure_time" },
                { name: "last_failure_reason" },
                { name: "tags" },
                { name: "note" },
                { name: "last_asset_clear_at" },
                { name: "consumed" },
              ] as T[],
            });
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
}

test("admin token route returns old-compatible payload shape", async () => {
  const response = await (worker.fetch as any)(
    new Request("https://example.com/api/v1/admin/tokens", {
      headers: { Authorization: "Bearer admin" },
    }),
    {
      DB: createAdminTokenDb(),
      ASSETS: createAssetBinding(),
      BUILD_SHA: "dev",
      CACHE_RESET_TZ_OFFSET_MINUTES: "480",
      KV_CACHE_MAX_BYTES: "26214400",
      KV_CLEANUP_BATCH: "200",
    } as any,
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    tokens: Record<string, Array<{ token: string; consumed: number }>>;
    consumed_mode_enabled: boolean;
  };

  assert.equal(payload.consumed_mode_enabled, true);
  assert.equal(payload.tokens.ssoBasic?.[0]?.token, "sso=worker-basic");
  assert.equal(payload.tokens.ssoBasic?.[0]?.consumed, 4);
});
