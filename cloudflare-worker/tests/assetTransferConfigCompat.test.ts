import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.ts";

const originalFetch = globalThis.fetch;

function createExecutionContext(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as any;
}

function createDbWithAssetConfig(asset: Record<string, unknown>) {
  const settings = new Map<string, string>([
    ["app", JSON.stringify({ app_key: "admin", api_key: "", stream: false, image_format: "base64" })],
    ["asset", JSON.stringify(asset)],
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
            return Promise.resolve(({ token: "asset-sso-token", token_type: "sso" } as unknown) as T);
          }
          return Promise.resolve(null);
        },
        all<T>() {
          if (sql.includes("SELECT key, value FROM settings WHERE key IN")) {
            return Promise.resolve({
              results: [...settings.entries()].map(([key, value]) => ({ key, value })) as T[],
            });
          }
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

test("chat completions respect current asset.upload_concurrent for attachment uploads", async () => {
  let inFlight = 0;
  let maxInFlight = 0;

  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://grok.com/rest/app-chat/upload-file") {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return new Response(JSON.stringify({ fileMetadataId: crypto.randomUUID(), fileUri: "/asset/uploaded" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (String(input) === "https://grok.com/rest/app-chat/conversations/new") {
        return new Response(
          `${JSON.stringify({
            result: {
              response: {
                modelResponse: {
                  model: "grok-4",
                  message: "ok",
                },
              },
            },
          })}\n`,
          {
            status: 200,
            headers: { "content-type": "application/x-ndjson" },
          },
        );
      }

      return originalFetch(input, init);
    }) as typeof fetch;

    const response = await (worker.fetch as any)(
      new Request("https://example.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "grok-4",
          stream: false,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "upload files" },
                { type: "file", file: { data: "data:text/plain;base64,QQ==" } },
                { type: "file", file: { data: "data:text/plain;base64,Qg==" } },
                { type: "file", file: { data: "data:text/plain;base64,Qw==" } },
              ],
            },
          ],
        }),
      }),
      {
        DB: createDbWithAssetConfig({ upload_concurrent: 2 }),
        BUILD_SHA: "dev",
        CACHE_RESET_TZ_OFFSET_MINUTES: "480",
        KV_CLEANUP_BATCH: "200",
      } as any,
      createExecutionContext(),
    );

    assert.equal(response.status, 200);
    assert.equal(maxInFlight, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("image generations respect current asset.download_concurrent for base64 conversions", async () => {
  let inFlight = 0;
  let maxInFlight = 0;

  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://grok.com/rest/app-chat/conversations/new") {
        return new Response(
          `${JSON.stringify({
            result: {
              response: {
                modelResponse: {
                  generatedImageUrls: [
                    "https://assets.grok.com/generated/image-1.png",
                    "https://assets.grok.com/generated/image-2.png",
                  ],
                },
              },
            },
          })}\n`,
          {
            status: 200,
            headers: { "content-type": "application/x-ndjson" },
          },
        );
      }

      if (url.startsWith("https://assets.grok.com/generated/")) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }

      return originalFetch(input, init);
    }) as typeof fetch;

    const response = await (worker.fetch as any)(
      new Request("https://example.com/v1/images/generations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "grok-imagine-1.0",
          prompt: "A neon skyline",
          n: 2,
          response_format: "base64",
        }),
      }),
      {
        DB: createDbWithAssetConfig({ download_concurrent: 1 }),
        BUILD_SHA: "dev",
        CACHE_RESET_TZ_OFFSET_MINUTES: "480",
        KV_CLEANUP_BATCH: "200",
      } as any,
      createExecutionContext(),
    );

    assert.equal(response.status, 200);
    assert.equal(maxInFlight, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test.after(() => {
  globalThis.fetch = originalFetch;
});
