import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.ts";

const originalFetch = globalThis.fetch;

function createExecutionContext(waitUntilTasks: Promise<unknown>[]): ExecutionContext {
  return {
    waitUntil(promise: Promise<unknown>) {
      waitUntilTasks.push(Promise.resolve(promise));
    },
    passThroughOnException() {
      // no-op
    },
    props: {},
  } as any;
}

function createFakeDb(cacheRows: Map<string, any>) {
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
          if (sql.includes("SELECT token FROM tokens")) {
            return Promise.resolve(({ token: "test-sso-token" } as unknown) as T);
          }
          return Promise.resolve(null);
        },
        all<T>() {
          return Promise.resolve({ results: [] as T[] });
        },
        run() {
          if (sql.includes("INSERT INTO kv_cache")) {
            cacheRows.set(String(params[0] ?? ""), { key: String(params[0] ?? "") });
          }
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

test("image proxy miss stays in passthrough mode and skips KV/D1 warm caching", async () => {
  const waitUntilTasks: Promise<unknown>[] = [];
  const cacheRows = new Map<string, any>();
  let kvPutCalls = 0;

  globalThis.fetch = (async () =>
    new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: {
        "content-type": "image/jpeg",
        "content-length": "4",
      },
    })) as typeof fetch;

  const response = await (worker.fetch as any)(
    new Request("https://example.com/images/demo.jpg"),
    {
      DB: createFakeDb(cacheRows),
      KV_CACHE: {
        async getWithMetadata() {
          return null;
        },
        async put() {
          kvPutCalls += 1;
        },
      },
      BUILD_SHA: "dev",
      CACHE_RESET_TZ_OFFSET_MINUTES: "480",
      KV_CACHE_MAX_BYTES: "26214400",
      KV_CLEANUP_BATCH: "200",
    } as any,
    createExecutionContext(waitUntilTasks),
  );

  assert.equal(response.status, 200);
  await Promise.all(waitUntilTasks);
  assert.equal(kvPutCalls, 0);
  assert.equal(cacheRows.size, 0);
});

test.after(() => {
  globalThis.fetch = originalFetch;
});
