import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.ts";

function createExecutionContext(): ExecutionContext {
  return {
    waitUntil() {
      // no-op for unit tests
    },
    passThroughOnException() {
      // no-op for unit tests
    },
    props: {},
  } as any;
}

function createFakeDb() {
  const settings = new Map<string, string>([
    [
      "app",
      JSON.stringify({
        app_key: "admin",
        api_key: "",
        function_enabled: true,
        function_key: "function-secret",
        image_format: "url",
        video_format: "html",
      }),
    ],
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
          if (sql === "SELECT COUNT(1) as c FROM api_keys WHERE is_active = 1") {
            return Promise.resolve(({ c: 0 } as unknown) as T);
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

  return { db };
}

test("function prompt enhance rejects an empty prompt", async () => {
  const fakeDb = createFakeDb();
  const response = await (worker.fetch as any)(
    new Request("https://example.com/v1/function/prompt/enhance", {
      method: "POST",
      headers: {
        Authorization: "Bearer function-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt: "   " }),
    }),
    {
      DB: fakeDb.db,
      BUILD_SHA: "dev",
      CACHE_RESET_TZ_OFFSET_MINUTES: "480",
      KV_CACHE_MAX_BYTES: "26214400",
      KV_CLEANUP_BATCH: "200",
    } as any,
    createExecutionContext(),
  );

  assert.equal(response.status, 400);
  const payload = (await response.json()) as { error?: string; code?: string };
  assert.equal(payload.code, "invalid_prompt");
});

test("function prompt enhance stop returns not_found for an unknown request id", async () => {
  const fakeDb = createFakeDb();
  const response = await (worker.fetch as any)(
    new Request("https://example.com/v1/function/prompt/enhance/stop", {
      method: "POST",
      headers: {
        Authorization: "Bearer function-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ request_id: "missing-request" }),
    }),
    {
      DB: fakeDb.db,
      BUILD_SHA: "dev",
      CACHE_RESET_TZ_OFFSET_MINUTES: "480",
      KV_CACHE_MAX_BYTES: "26214400",
      KV_CLEANUP_BATCH: "200",
    } as any,
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  const payload = (await response.json()) as { status?: string; request_id?: string };
  assert.equal(payload.status, "not_found");
  assert.equal(payload.request_id, "missing-request");
});
