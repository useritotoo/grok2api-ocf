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
  const videoCacheRows = [
    {
      key: "video/users-demo-generated-abcd1234abcd1234abcd1234abcd1234-generated_video_hd.mp4",
      type: "video",
      size: 4096,
      content_type: "video/mp4",
      created_at: 1710000000000,
      last_access_at: 1710000000500,
      expires_at: 1710086400000,
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
          if (sql === "SELECT COUNT(1) as c FROM api_keys WHERE is_active = 1") {
            return Promise.resolve(({ c: 0 } as unknown) as T);
          }
          if (sql === "SELECT COUNT(1) as c FROM kv_cache WHERE type = ?") {
            const type = String(params[0] ?? "");
            return Promise.resolve(({ c: videoCacheRows.filter((row) => row.type === type).length } as unknown) as T);
          }
          return Promise.resolve(null);
        },
        all<T>() {
          if (
            sql ===
            "SELECT key,type,size,content_type,created_at,last_access_at,expires_at FROM kv_cache WHERE type = ? ORDER BY last_access_at DESC LIMIT ? OFFSET ?"
          ) {
            const type = String(params[0] ?? "");
            return Promise.resolve({
              results: videoCacheRows
                .filter((row) => row.type === type)
                .sort((a, b) => Number(b.last_access_at) - Number(a.last_access_at)) as T[],
            });
          }
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

test("function video start accepts extension requests with an empty prompt and stores extension metadata", async () => {
  const fakeDb = createFakeDb();
  const response = await (worker.fetch as any)(
    new Request("https://example.com/v1/function/video/start", {
      method: "POST",
      headers: {
        Authorization: "Bearer function-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: "",
        aspect_ratio: "16:9",
        video_length: 10,
        resolution_name: "720p",
        preset: "spicy",
        is_video_extension: true,
        extend_post_id: "abcd1234abcd1234abcd1234abcd1234",
        video_extension_start_time: 4.25,
        original_post_id: "orig1234orig1234orig1234orig1234",
        file_attachment_id: "file1234file1234file1234file1234",
        stitch_with_extend: true,
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
    prompt: "",
    aspect_ratio: "16:9",
    video_length: 10,
    resolution_name: "720p",
    preset: "spicy",
    image_reference: null,
    reasoning_effort: null,
    is_video_extension: true,
    extend_post_id: "abcd1234abcd1234abcd1234abcd1234",
    video_extension_start_time: 4.25,
    original_post_id: "orig1234orig1234orig1234orig1234",
    file_attachment_id: "file1234file1234file1234file1234",
    stitch_with_extend: true,
  });
});

test("function video cache list returns view urls for cached videos", async () => {
  const fakeDb = createFakeDb();
  const response = await (worker.fetch as any)(
    new Request("https://example.com/v1/function/video/cache/list?page=1&page_size=20", {
      headers: { Authorization: "Bearer function-secret" },
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
  const payload = (await response.json()) as {
    items: Array<{ name: string; view_url: string; preview_url: string }>;
  };
  assert.equal(payload.items.length, 1);
  assert.equal(
    payload.items[0]?.view_url,
    "/images/users-demo-generated-abcd1234abcd1234abcd1234abcd1234-generated_video_hd.mp4",
  );
  assert.equal(payload.items[0]?.preview_url, payload.items[0]?.view_url);
});
