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
