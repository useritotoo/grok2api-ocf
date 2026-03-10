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

function createFakeDb(configOverrides: Record<string, unknown> = {}): D1Database {
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

  for (const [key, value] of Object.entries(configOverrides)) {
    settings.set(key, JSON.stringify(value));
  }

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

test("allows /v1/models to be loaded with the function key", async () => {
  const response = await (worker.fetch as any)(
    new Request("https://example.com/v1/models", {
      headers: { Authorization: "Bearer function-secret" },
    }),
    {
      DB: createFakeDb(),
      BUILD_SHA: "dev",
      CACHE_RESET_TZ_OFFSET_MINUTES: "480",
      KV_CACHE_MAX_BYTES: "26214400",
      KV_CLEANUP_BATCH: "200",
    } as any,
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  const payload = (await response.json()) as { object: string; data: Array<{ id: string }> };
  assert.equal(payload.object, "list");
  assert.ok(payload.data.some((item) => item.id === "grok-4"));
});
