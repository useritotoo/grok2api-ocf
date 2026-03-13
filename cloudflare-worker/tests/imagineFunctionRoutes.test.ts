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
  const sessions = new Map<string, Record<string, unknown>>();

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
          if (sql.startsWith("INSERT INTO function_sessions")) {
            const taskId = String(params[0] ?? "");
            const payloadText = String(params[2] ?? "{}");
            sessions.set(taskId, JSON.parse(payloadText));
          }
          return Promise.resolve({ success: true });
        },
      };
    },
    batch() {
      return Promise.resolve([]);
    },
  } as any;

  return { db, sessions };
}

test("function imagine start stores n and infinite mode in the session payload", async () => {
  const fakeDb = createFakeDb();
  const response = await (worker.fetch as any)(
    new Request("https://example.com/v1/function/imagine/start", {
      method: "POST",
      headers: {
        Authorization: "Bearer function-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: "A glass city in the rain",
        aspect_ratio: "16:9",
        nsfw: false,
        n: 5,
        infinite_mode: true,
        image_reference: {
          image_url: "/images/upload-demo.png",
        },
      }),
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
  const payload = (await response.json()) as { task_id: string };
  assert.ok(payload.task_id);
  assert.deepEqual(fakeDb.sessions.get(payload.task_id), {
    prompt: "A glass city in the rain",
    aspect_ratio: "16:9",
    nsfw: false,
    image_reference: ["/images/upload-demo.png"],
    n: 5,
    infinite_mode: true,
  });
});

test("function imagine start stores multiple reference images in the session payload", async () => {
  const fakeDb = createFakeDb();
  const response = await (worker.fetch as any)(
    new Request("https://example.com/v1/function/imagine/start", {
      method: "POST",
      headers: {
        Authorization: "Bearer function-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: "Use all reference angles",
        aspect_ratio: "1:1",
        nsfw: null,
        n: 3,
        infinite_mode: false,
        image_reference: [
          { image_url: "/images/upload-demo-1.png" },
          { image_url: "/images/upload-demo-2.png" },
          { image_url: "/images/upload-demo-3.png" },
        ],
      }),
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
  const payload = (await response.json()) as { task_id: string };
  assert.ok(payload.task_id);
  assert.deepEqual(fakeDb.sessions.get(payload.task_id), {
    prompt: "Use all reference angles",
    aspect_ratio: "1:1",
    nsfw: null,
    image_reference: [
      "/images/upload-demo-1.png",
      "/images/upload-demo-2.png",
      "/images/upload-demo-3.png",
    ],
    n: 3,
    infinite_mode: false,
  });
});
