import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.ts";
import { openAiRoutes } from "../src/routes/openai.ts";

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

function createThinWorkerDb(): D1Database {
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
          if (sql === "SELECT token FROM tokens\n       WHERE token_type = ?\n         AND status != 'expired'\n         AND failed_count < ?\n         AND (cooldown_until IS NULL OR cooldown_until <= ?)\n         AND remaining_queries != 0\n       ORDER BY CASE WHEN remaining_queries = -1 THEN 0 ELSE 1 END, remaining_queries DESC, created_time ASC\n       LIMIT 1") {
            return Promise.resolve(null);
          }
          if (sql === "SELECT token FROM tokens\n       WHERE token_type = ?\n         AND status != 'expired'\n         AND failed_count < ?\n         AND (cooldown_until IS NULL OR cooldown_until <= ?)\n         AND heavy_remaining_queries != 0\n       ORDER BY CASE WHEN heavy_remaining_queries = -1 THEN 0 ELSE 1 END, heavy_remaining_queries DESC, created_time ASC\n       LIMIT 1") {
            return Promise.resolve(null);
          }
          return Promise.resolve(null);
        },
        all<T>() {
          if (sql === "PRAGMA table_info(api_keys)") {
            return Promise.resolve({
              results: [
                { name: "key" },
                { name: "name" },
                { name: "created_at" },
                { name: "is_active" },
                { name: "chat_limit" },
                { name: "heavy_limit" },
                { name: "image_limit" },
                { name: "video_limit" },
              ] as T[],
            });
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
              ] as T[],
            });
          }
          if (sql.startsWith("SELECT key, value FROM settings WHERE key IN (")) {
            return Promise.resolve({
              results: Array.from(settings.entries()).map(([key, value]) => ({ key, value })) as T[],
            });
          }
          return Promise.resolve({ results: [] as T[] });
        },
        run() {
          return Promise.resolve({ success: true });
        },
      };
    },
    batch(statements: Array<{ run: () => Promise<unknown> }>) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  } as any;
}

test("function chat completions bypasses internal openAiRoutes.fetch self-dispatch", async () => {
  const originalFetch = openAiRoutes.fetch;
  openAiRoutes.fetch = (() => {
    throw new Error("openAiRoutes.fetch should not be used by function chat");
  }) as typeof openAiRoutes.fetch;

  try {
    const response = await (worker.fetch as any)(
      new Request("https://example.com/v1/function/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer function-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "grok-4",
          stream: false,
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
      {
        DB: createThinWorkerDb(),
        BUILD_SHA: "dev",
        CACHE_RESET_TZ_OFFSET_MINUTES: "480",
        KV_CACHE_MAX_BYTES: "26214400",
        KV_CLEANUP_BATCH: "200",
      } as any,
      createExecutionContext(),
    );

    assert.equal(response.status, 503);
    const payload = (await response.json()) as { error?: { code?: string } };
    assert.equal(payload.error?.code, "NO_AVAILABLE_TOKEN");
  } finally {
    openAiRoutes.fetch = originalFetch;
  }
});

test("function image upload bypasses internal openAiRoutes.fetch self-dispatch", async () => {
  const originalFetch = openAiRoutes.fetch;
  openAiRoutes.fetch = (() => {
    throw new Error("openAiRoutes.fetch should not be used by function upload");
  }) as typeof openAiRoutes.fetch;

  const kvWrites: string[] = [];

  try {
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1, 2, 3, 4])], "demo.png", { type: "image/png" }));

    const response = await (worker.fetch as any)(
      new Request("https://example.com/v1/function/uploads/image", {
        method: "POST",
        headers: {
          Authorization: "Bearer function-secret",
        },
        body: form,
      }),
      {
        DB: createThinWorkerDb(),
        KV_CACHE: {
          put(key: string) {
            kvWrites.push(key);
            return Promise.resolve();
          },
        },
        BUILD_SHA: "dev",
        CACHE_RESET_TZ_OFFSET_MINUTES: "480",
        KV_CACHE_MAX_BYTES: "26214400",
        KV_CLEANUP_BATCH: "200",
      } as any,
      createExecutionContext(),
    );

    assert.equal(response.status, 200);
    assert.equal(kvWrites.length, 1);
  } finally {
    openAiRoutes.fetch = originalFetch;
  }
});
