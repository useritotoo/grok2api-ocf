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

test("getSettings keeps grok stream defaults when current chat config is still untouched default", async () => {
  const settings = await getSettings(createEnv({}));

  assert.equal(settings.grok.stream_first_response_timeout, 30);
  assert.equal(settings.grok.stream_chunk_timeout, 120);
  assert.equal(settings.grok.stream_total_timeout, 600);
});

test("getSettings does not mix legacy proxy cookies into a customized current proxy section", async () => {
  const settings = await getSettings(
    createEnv({
      proxy: {
        base_proxy_url: "https://current-proxy.example",
      },
      grok: {
        proxy_url: "https://legacy-proxy.example",
        cache_proxy_url: "https://legacy-assets.example",
        cf_clearance: "legacy-stale-clearance",
      },
    }),
  );

  assert.equal(settings.grok.proxy_url, "https://current-proxy.example");
  assert.equal(settings.grok.cache_proxy_url, "");
  assert.equal(settings.grok.cf_clearance, "");
});

test("getSettings exposes current proxy cookie jar and fingerprint fields to Worker runtime", async () => {
  const settings = await getSettings(
    createEnv({
      proxy: {
        cf_cookies: "cf_bm=bm-token; cf_clearance=jar-clearance",
        cf_clearance: "manual-clearance",
        browser: "chrome136",
        user_agent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
        enabled: true,
      },
    }),
  );

  assert.equal((settings.grok as any).cf_cookies, "cf_bm=bm-token; cf_clearance=jar-clearance");
  assert.equal((settings.grok as any).browser, "chrome136");
  assert.equal(
    (settings.grok as any).user_agent,
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  );
  assert.equal((settings.grok as any).proxy_enabled, true);
});

test("chat completions omit legacy cf_clearance when the current proxy section is already customized", async () => {
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
                message: "current proxy cookie ok",
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
    createEnv({
      proxy: {
        base_proxy_url: "https://current-proxy.example",
      },
      grok: {
        cf_clearance: "legacy-stale-clearance",
      },
    }),
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  assert.match(capturedCookie, /sso-rw=legacy-sso-token/);
  assert.doesNotMatch(capturedCookie, /cf_clearance=/);
});

test("chat completions forward current cf_cookies when proxy section provides a cookie jar", async () => {
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
                message: "cookie jar ok",
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
    createEnv({
      proxy: {
        cf_cookies: "cf_bm=bm-token; cf_clearance=jar-clearance",
      },
    }),
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  assert.match(capturedCookie, /sso-rw=legacy-sso-token/);
  assert.match(capturedCookie, /cf_bm=bm-token/);
  assert.match(capturedCookie, /cf_clearance=jar-clearance/);
});

test("chat completions forward current disable_memory and custom_instruction into the Grok payload", async () => {
  let capturedPayload: Record<string, unknown> | null = null;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://grok.com/rest/app-chat/conversations/new") {
      capturedPayload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(
        `${JSON.stringify({
          result: {
            response: {
              modelResponse: {
                model: "grok-4",
                message: "payload config ok",
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
    createEnv({
      app: {
        disable_memory: true,
        custom_instruction: "Always answer with terse bullet points.",
      },
    }),
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  assert.ok(capturedPayload);
  assert.equal(capturedPayload["disableMemory"], true);
  assert.equal(capturedPayload["customPersonality"], "Always answer with terse bullet points.");
});

test("chat completions respect current retry.max_retry instead of always retrying three times", async () => {
  let attempts = 0;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://grok.com/rest/app-chat/conversations/new") {
      attempts += 1;
      return new Response("upstream failure", {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
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
    createEnv({
      retry: {
        max_retry: 0,
        retry_status_codes: [500],
      },
    }),
    createExecutionContext(),
  );

  assert.equal(response.status, 500);
  assert.equal(attempts, 1);
});

test("chat completions default to current app.stream when request.stream is omitted", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://grok.com/rest/app-chat/conversations/new") {
      return new Response(
        `${JSON.stringify({
          result: {
            response: {
              token: "streamed by config",
              isThinking: false,
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
        messages: [{ role: "user", content: "hello" }],
      }),
    }),
    createEnv({
      app: {
        stream: true,
      },
    }),
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  assert.match(String(response.headers.get("content-type") ?? ""), /text\/event-stream/i);
  const bodyText = await response.text();
  assert.match(bodyText, /streamed by config/);
});

test("video chat completions respect current app.video_format when configured as url", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://grok.com/rest/media/post/create") {
      return new Response(JSON.stringify({ post: { id: "legacy-video-post" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://grok.com/rest/app-chat/conversations/new") {
      return new Response(
        `${JSON.stringify({
          result: {
            response: {
              streamingVideoGenerationResponse: {
                progress: 100,
                videoUrl:
                  "https://assets.grok.com/generated/12345678-1234-1234-1234-1234567890ab/generated_video.mp4",
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
        model: "grok-imagine-1.0-video",
        stream: false,
        messages: [{ role: "user", content: "Create a skyline timelapse" }],
        video_config: {
          aspect_ratio: "16:9",
          video_length: 6,
          resolution_name: "480p",
          preset: "normal",
        },
      }),
    }),
    createEnv({
      app: {
        video_format: "url",
      },
    }),
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    choices: Array<{ message?: { content?: string } }>;
  };
  const content = String(payload.choices[0]?.message?.content ?? "").trim();
  assert.doesNotMatch(content, /<video/i);
  assert.match(content, /^https:\/\/example\.com\/images\//);
});

test("chat completions replace cf_clearance inside current cookie jar when manual cf_clearance is configured", async () => {
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
                message: "cookie override ok",
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
    createEnv({
      proxy: {
        cf_cookies: "cf_bm=bm-token; cf_clearance=jar-clearance",
        cf_clearance: "manual-clearance",
        enabled: false,
      },
    }),
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  assert.match(capturedCookie, /cf_bm=bm-token/);
  assert.match(capturedCookie, /cf_clearance=manual-clearance/);
  assert.doesNotMatch(capturedCookie, /cf_clearance=jar-clearance/);
});

test("chat completions keep solver-managed cookie jar unchanged when proxy refresh is enabled", async () => {
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
                message: "solver cookie ok",
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
    createEnv({
      proxy: {
        cf_cookies: "cf_bm=bm-token; cf_clearance=jar-clearance",
        cf_clearance: "manual-clearance",
        enabled: true,
      },
    }),
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  assert.match(capturedCookie, /cf_bm=bm-token/);
  assert.match(capturedCookie, /cf_clearance=jar-clearance/);
  assert.doesNotMatch(capturedCookie, /cf_clearance=manual-clearance/);
});

test.after(() => {
  globalThis.fetch = originalFetch;
});
