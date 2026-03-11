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
          if (sql === "SELECT COUNT(1) as c FROM kv_cache WHERE type = ?") {
            const type = String(params[0] ?? "");
            const count = [...cacheRows.values()].filter((row) => row.type === type).length;
            return Promise.resolve(({ c: count } as unknown) as T);
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
              results: [...cacheRows.values()]
                .filter((row) => row.type === type)
                .sort((a, b) => Number(b.last_access_at) - Number(a.last_access_at)) as T[],
            });
          }
          return Promise.resolve({ results: [] as T[] });
        },
        run() {
          if (sql.startsWith("DELETE FROM kv_cache WHERE key = ?")) {
            cacheRows.delete(String(params[0] ?? ""));
          }
          if (sql.includes("INSERT INTO kv_cache")) {
            cacheRows.set(String(params[0] ?? ""), {
              key: String(params[0] ?? ""),
              type: String(params[1] ?? ""),
              size: Number(params[2] ?? 0),
              content_type: String(params[3] ?? ""),
              created_at: Number(params[4] ?? 0),
              last_access_at: Number(params[5] ?? 0),
              expires_at: Number(params[6] ?? 0),
            });
          }
          if (sql.startsWith("UPDATE kv_cache SET last_access_at = ? WHERE key = ?")) {
            const row = cacheRows.get(String(params[1] ?? ""));
            if (row) {
              row.last_access_at = Number(params[0] ?? row.last_access_at);
            }
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

test("range video responses warm the local cache in the background", async () => {
  const waitUntilTasks: Promise<unknown>[] = [];
  const cacheRows = new Map<string, any>();
  const kvStore = new Map<string, Uint8Array>();
  const fullBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const partialBytes = fullBytes.slice(0, 4);

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const range = String((init?.headers as Record<string, string> | undefined)?.Range ?? "");
    if (range) {
      return new Response(partialBytes, {
        status: 206,
        headers: {
          "content-type": "video/mp4",
          "content-length": String(partialBytes.byteLength),
          "content-range": `bytes 0-${partialBytes.byteLength - 1}/${fullBytes.byteLength}`,
        },
      });
    }
    return new Response(fullBytes, {
      status: 200,
      headers: {
        "content-type": "video/mp4",
        "content-length": String(fullBytes.byteLength),
      },
    });
  }) as typeof fetch;

  const response = await (worker.fetch as any)(
    new Request("https://example.com/images/demo.mp4", {
      headers: { Range: "bytes=0-3" },
    }),
    {
      DB: createFakeDb(cacheRows),
      KV_CACHE: {
        async getWithMetadata() {
          return null;
        },
        async put(key: string, value: ReadableStream<Uint8Array>) {
          const reader = value.getReader();
          const chunks: Uint8Array[] = [];
          while (true) {
            const { value: chunk, done } = await reader.read();
            if (done) break;
            if (chunk) {
              chunks.push(chunk);
            }
          }
          const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
          const merged = new Uint8Array(total);
          let offset = 0;
          chunks.forEach((chunk) => {
            merged.set(chunk, offset);
            offset += chunk.byteLength;
          });
          kvStore.set(key, merged);
        },
      },
      BUILD_SHA: "dev",
      CACHE_RESET_TZ_OFFSET_MINUTES: "480",
      KV_CACHE_MAX_BYTES: "26214400",
      KV_CLEANUP_BATCH: "200",
    } as any,
    createExecutionContext(waitUntilTasks),
  );

  assert.equal(response.status, 206);
  await Promise.all(waitUntilTasks);
  assert.ok(kvStore.has("video/demo.mp4"));
  assert.deepEqual([...kvStore.get("video/demo.mp4")!], [...fullBytes]);
  assert.ok(cacheRows.has("video/demo.mp4"));
});

test.after(() => {
  globalThis.fetch = originalFetch;
});
