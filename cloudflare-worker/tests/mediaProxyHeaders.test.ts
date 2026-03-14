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

function createFakeDb(): D1Database {
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

function normalizeHeaders(input: HeadersInit | undefined): Record<string, string> {
  if (!input) return {};
  if (input instanceof Headers) {
    return Object.fromEntries(input.entries());
  }
  if (Array.isArray(input)) {
    return Object.fromEntries(input.map(([key, value]) => [String(key), String(value)]));
  }
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, String(value)]));
}

test("video proxy miss removes upstream CSP headers and uses media fetch headers", async () => {
  const waitUntilTasks: Promise<unknown>[] = [];
  let upstreamHeaders: Record<string, string> = {};

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    upstreamHeaders = normalizeHeaders(init?.headers);
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: {
        "content-type": "video/mp4",
        "content-length": "4",
        "content-security-policy": "default-src 'none'",
        "content-security-policy-report-only": "default-src 'self'",
      },
    });
  }) as typeof fetch;

  const response = await (worker.fetch as any)(
    new Request("https://example.com/images/demo.mp4"),
    {
      DB: createFakeDb(),
      KV_CACHE: {
        async getWithMetadata() {
          return null;
        },
      },
      BUILD_SHA: "dev",
      CACHE_RESET_TZ_OFFSET_MINUTES: "480",
      KV_CACHE_MAX_BYTES: "1",
      KV_CLEANUP_BATCH: "200",
    } as any,
    createExecutionContext(waitUntilTasks),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "video/mp4");
  assert.equal(response.headers.get("content-security-policy"), null);
  assert.equal(response.headers.get("content-security-policy-report-only"), null);
  assert.equal(upstreamHeaders["Sec-Fetch-Dest"], "video");
  assert.equal(upstreamHeaders["Sec-Fetch-Mode"], "no-cors");
  assert.equal(upstreamHeaders["Sec-Fetch-User"], undefined);
  assert.equal(upstreamHeaders["Upgrade-Insecure-Requests"], undefined);
  assert.ok(!String(upstreamHeaders.Accept || "").includes("text/html"));

  await Promise.all(waitUntilTasks);
});

test.after(() => {
  globalThis.fetch = originalFetch;
});
