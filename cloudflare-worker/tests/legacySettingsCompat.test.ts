import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.ts";
import { getSettings } from "../src/settings.ts";

const originalFetch = globalThis.fetch;

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

function createFakeDb(settingsEntries: Record<string, unknown>): D1Database {
  const settings = new Map<string, string>(
    Object.entries(settingsEntries).map(([key, value]) => [key, JSON.stringify(value)]),
  );

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
          if (sql.includes("SELECT token FROM tokens")) {
            return Promise.resolve(({ token: "legacy-sso-token" } as unknown) as T);
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

function createEnv(settingsEntries: Record<string, unknown>) {
  return {
    DB: createFakeDb(settingsEntries),
    BUILD_SHA: "dev",
    CACHE_RESET_TZ_OFFSET_MINUTES: "480",
    KV_CACHE_MAX_BYTES: "26214400",
    KV_CLEANUP_BATCH: "200",
  } as any;
}

const LEGACY_SETTINGS = {
  global: {
    base_url: "https://legacy.example",
    image_mode: "base64",
    admin_username: "legacy-admin",
    admin_password: "legacy-password",
  },
  grok: {
    api_key: "legacy-api-key",
    proxy_url: "https://legacy-proxy.example",
    cache_proxy_url: "https://legacy-assets.example",
    cf_clearance: "legacy-clearance-token",
    dynamic_statsig: false,
    x_statsig_id: "legacy-statsig-id",
    filtered_tags: "legacy-tag-1,legacy-tag-2",
    show_thinking: false,
    temporary: true,
    video_poster_preview: true,
    retry_status_codes: [401, 429, 500],
    image_generation_method: "legacy",
  },
};

test("getSettings falls back to legacy global and grok rows when current sections are still default", async () => {
  const settings = await getSettings(createEnv(LEGACY_SETTINGS));

  assert.equal(settings.global.base_url, "https://legacy.example");
  assert.equal(settings.global.image_mode, "base64");
  assert.equal(settings.global.admin_username, "legacy-admin");
  assert.equal(settings.global.admin_password, "legacy-password");

  assert.equal(settings.grok.api_key, "legacy-api-key");
  assert.equal(settings.grok.proxy_url, "https://legacy-proxy.example");
  assert.equal(settings.grok.cache_proxy_url, "https://legacy-assets.example");
  assert.equal(settings.grok.cf_clearance, "legacy-clearance-token");
  assert.equal(settings.grok.dynamic_statsig, false);
  assert.equal(settings.grok.x_statsig_id, "legacy-statsig-id");
  assert.equal(settings.grok.filtered_tags, "legacy-tag-1,legacy-tag-2");
  assert.equal(settings.grok.show_thinking, false);
  assert.equal(settings.grok.temporary, true);
  assert.equal(settings.grok.video_poster_preview, true);
  assert.deepEqual(settings.grok.retry_status_codes, [401, 429, 500]);
  assert.equal(settings.grok.image_generation_method, "legacy");
});

test("images/method still reports legacy mode when only the legacy grok row is configured", async () => {
  const response = await (worker.fetch as any)(
    new Request("https://example.com/v1/images/method"),
    createEnv(LEGACY_SETTINGS),
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  const payload = (await response.json()) as { image_generation_method: string };
  assert.equal(payload.image_generation_method, "legacy");
});

test("chat completions still send legacy cf_clearance to Grok upstream when current proxy config is unset", async () => {
  let capturedCookie = "";

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://grok.com/rest/app-chat/conversations/new") {
      const headers = new Headers(init?.headers);
      capturedCookie = headers.get("Cookie") ?? "";
      return new Response(
        `${JSON.stringify({
          result: {
            response: {
              modelResponse: {
                model: "grok-4",
                message: "legacy cookie ok",
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
        messages: [{ role: "user", content: "hello" }],
      }),
    }),
    createEnv(LEGACY_SETTINGS),
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  assert.match(capturedCookie, /sso-rw=legacy-sso-token/);
  assert.match(capturedCookie, /cf_clearance=legacy-clearance-token/);
});

test.after(() => {
  globalThis.fetch = originalFetch;
});
