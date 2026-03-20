import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.ts";

const originalFetch = globalThis.fetch;

function createExecutionContext(waitUntilTasks?: Promise<unknown>[]): ExecutionContext {
  return {
    waitUntil(promise: Promise<unknown>) {
      waitUntilTasks?.push(Promise.resolve(promise));
    },
    passThroughOnException() {
      // no-op for unit tests
    },
    props: {},
  } as any;
}

function createFakeDb(extraSettings: Record<string, unknown> = {}) {
  const settings = new Map<string, string>(
    Object.entries(extraSettings).map(
      ([key, value]): [string, string] => [key, JSON.stringify(value)],
    ),
  );

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
            return Promise.resolve(({ token: "timeout-sso-token", token_type: "sso" } as unknown) as T);
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

function createEnv(extraSettings: Record<string, unknown> = {}) {
  return {
    DB: createFakeDb(extraSettings),
    BUILD_SHA: "dev",
    CACHE_RESET_TZ_OFFSET_MINUTES: "480",
    KV_CACHE_MAX_BYTES: "26214400",
    KV_CLEANUP_BATCH: "200",
  } as any;
}

test("chat completions use current chat.timeout for the upstream request", async () => {
  const originalTimeout = AbortSignal.timeout;
  const sentinelSignal = new AbortController().signal;
  let timeoutMs = -1;

  (AbortSignal as any).timeout = (ms: number) => {
    timeoutMs = ms;
    return sentinelSignal;
  };

  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://grok.com/rest/app-chat/conversations/new") {
        assert.equal(init?.signal, sentinelSignal);
        return new Response(
          `${JSON.stringify({
            result: {
              response: {
                modelResponse: {
                  model: "grok-4",
                  message: "chat timeout ok",
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
        chat: {
          timeout: 9,
        },
      }),
      createExecutionContext(),
    );

    assert.equal(response.status, 200);
    assert.equal(timeoutMs, 9000);
  } finally {
    (AbortSignal as any).timeout = originalTimeout;
  }
});

test("video chat completions use current video.timeout for the upstream request", async () => {
  const originalTimeout = AbortSignal.timeout;
  const sentinelSignal = new AbortController().signal;
  let timeoutMs = -1;

  (AbortSignal as any).timeout = (ms: number) => {
    timeoutMs = ms;
    return sentinelSignal;
  };

  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://grok.com/rest/app-chat/conversations/new") {
        assert.equal(init?.signal, sentinelSignal);
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
            extend_post_id: "legacy-video-post",
          },
        }),
      }),
      createEnv({
        video: {
          timeout: 11,
        },
      }),
      createExecutionContext(),
    );

    assert.equal(response.status, 200);
    assert.equal(timeoutMs, 11000);
  } finally {
    (AbortSignal as any).timeout = originalTimeout;
  }
});


test("image generations use current image.timeout for the upstream request", async () => {
  const originalTimeout = AbortSignal.timeout;
  const sentinelSignal = new AbortController().signal;
  let timeoutMs = -1;

  (AbortSignal as any).timeout = (ms: number) => {
    timeoutMs = ms;
    return sentinelSignal;
  };

  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://grok.com/rest/app-chat/conversations/new") {
        assert.equal(init?.signal, sentinelSignal);
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
          n: 1,
        }),
      }),
      createEnv({
        image: {
          timeout: 13,
        },
      }),
      createExecutionContext(),
    );

    assert.equal(response.status, 200);
    assert.equal(timeoutMs, 13000);
  } finally {
    (AbortSignal as any).timeout = originalTimeout;
  }
});

test.after(() => {
  globalThis.fetch = originalFetch;
});
