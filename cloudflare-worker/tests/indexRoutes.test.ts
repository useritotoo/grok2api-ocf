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

function createAssetBinding(): Fetcher {
  return {
    fetch(request: Request): Promise<Response> {
      const pathname = new URL(request.url).pathname;
      return Promise.resolve(
        new Response(`asset:${pathname}`, {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      );
    },
    connect() {
      throw new Error("Socket connections are not used in these tests");
    },
  } as any;
}

function createConfigDb(overrides: Record<string, unknown> = {}): D1Database {
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

  for (const [key, value] of Object.entries(overrides)) {
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
          if (sql === "SELECT key, name, is_active FROM api_keys WHERE key = ?") {
            return Promise.resolve(null);
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

test("serves the login page even before the DB binding is ready", async () => {
  const response = await (worker.fetch as any)(
    new Request("https://example.com/login?v=dev"),
    {
      ASSETS: createAssetBinding(),
      BUILD_SHA: "dev",
      CACHE_RESET_TZ_OFFSET_MINUTES: "480",
      KV_CACHE_MAX_BYTES: "26214400",
      KV_CLEANUP_BATCH: "200",
    } as any,
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "asset:/function/pages/login.html");
  assert.equal(response.headers.get("x-grok2api-build"), "dev");
});

test("reports binding status on /health instead of crashing when DB is missing", async () => {
  const response = await (worker.fetch as any)(
    new Request("https://example.com/health"),
    {
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
    status: string;
    bindings: { db: boolean; assets: boolean; kv_cache: boolean };
  };
  assert.equal(payload.status, "healthy");
  assert.equal(payload.bindings.db, false);
  assert.equal(payload.bindings.assets, true);
});

test("accepts the default admin key on /v1/admin/verify before DB bootstrap", async () => {
  const response = await (worker.fetch as any)(
    new Request("https://example.com/v1/admin/verify", {
      headers: { Authorization: "Bearer admin" },
    }),
    {
      ASSETS: createAssetBinding(),
      BUILD_SHA: "dev",
      CACHE_RESET_TZ_OFFSET_MINUTES: "480",
      KV_CACHE_MAX_BYTES: "26214400",
      KV_CLEANUP_BATCH: "200",
    } as any,
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "success" });
});

test("returns the default function access error instead of 500 when DB is not ready", async () => {
  const response = await (worker.fetch as any)(
    new Request("https://example.com/v1/function/verify"),
    {
      ASSETS: createAssetBinding(),
      BUILD_SHA: "dev",
      CACHE_RESET_TZ_OFFSET_MINUTES: "480",
      KV_CACHE_MAX_BYTES: "26214400",
      KV_CLEANUP_BATCH: "200",
    } as any,
    createExecutionContext(),
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: "Function access is disabled",
    code: "FUNCTION_DISABLED",
  });
});

test("does not fall back to ASSETS for unknown API routes", async () => {
  let assetFetchCount = 0;
  const response = await (worker.fetch as any)(
    new Request("https://example.com/v1/videos/video_test123", {
      headers: { Authorization: "Bearer admin" },
    }),
    {
      DB: createConfigDb(),
      ASSETS: {
        fetch() {
          assetFetchCount += 1;
          return Promise.resolve(new Response("unexpected asset fallback", { status: 200 }));
        },
        connect() {
          throw new Error("Socket connections are not used in these tests");
        },
      } satisfies Fetcher,
      BUILD_SHA: "dev",
      CACHE_RESET_TZ_OFFSET_MINUTES: "480",
      KV_CACHE_MAX_BYTES: "26214400",
      KV_CLEANUP_BATCH: "200",
    } as any,
    createExecutionContext(),
  );

  assert.equal(response.status, 404);
  assert.equal(assetFetchCount, 0);
});

test("does not fall back to ASSETS for suspicious probe paths", async () => {
  let assetFetchCount = 0;
  const response = await (worker.fetch as any)(
    new Request("https://example.com/.env.save"),
    {
      ASSETS: {
        fetch() {
          assetFetchCount += 1;
          return Promise.resolve(new Response("unexpected asset fallback", { status: 200 }));
        },
        connect() {
          throw new Error("Socket connections are not used in these tests");
        },
      } satisfies Fetcher,
      BUILD_SHA: "dev",
      CACHE_RESET_TZ_OFFSET_MINUTES: "480",
      KV_CACHE_MAX_BYTES: "26214400",
      KV_CLEANUP_BATCH: "200",
    } as any,
    createExecutionContext(),
  );

  assert.equal(response.status, 404);
  assert.equal(assetFetchCount, 0);
});

test("redirects the legacy datacenter entry to the worker datacenter page route", async () => {
  const response = await (worker.fetch as any)(
    new Request("https://example.com/admin/datacenter"),
    {
      ASSETS: createAssetBinding(),
      BUILD_SHA: "dev",
      CACHE_RESET_TZ_OFFSET_MINUTES: "480",
      KV_CACHE_MAX_BYTES: "26214400",
      KV_CLEANUP_BATCH: "200",
    } as any,
    createExecutionContext(),
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/admin/pages/datacenter?v=dev");
});
