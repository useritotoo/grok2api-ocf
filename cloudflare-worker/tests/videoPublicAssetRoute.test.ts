import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.ts";

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
            return Promise.resolve(({ token: "video-sso-token", token_type: "sso" } as unknown) as T);
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

function encodeAssetPath(raw: string): string {
  const bytes = new TextEncoder().encode(raw);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `u_${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}`;
}

test("video chat completions can publish the final video asset when enable_public_asset is on", async () => {
  let createLinkCalls = 0;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://grok.com/rest/media/post/create") {
      return new Response(JSON.stringify({ post: { id: "seed-post-id" } }), {
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
                thumbnailImageUrl:
                  "https://assets.grok.com/generated/12345678-1234-1234-1234-1234567890ab/generated_thumbnail.jpg",
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
    if (url === "https://grok.com/rest/media/post/create-link") {
      createLinkCalls += 1;
      return new Response(
        JSON.stringify({
          shareLink:
            "https://imagine-public.x.ai/imagine-public/share-videos/12345678-1234-1234-1234-1234567890ab.mp4?cache=1",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
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
        messages: [{ role: "user", content: "Create a dramatic skyline timelapse" }],
        video_config: {
          aspect_ratio: "16:9",
          video_length: 6,
          resolution_name: "480p",
          preset: "normal",
        },
      }),
    }),
    createEnv({
      video: {
        enable_public_asset: true,
      },
    }),
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  assert.equal(createLinkCalls, 1);

  const payload = (await response.json()) as {
    choices: Array<{ message?: { content?: string } }>;
  };
  const content = String(payload.choices[0]?.message?.content ?? "");
  assert.match(
    content,
    new RegExp(
      `/images/${encodeAssetPath("https://imagine-public.x.ai/imagine-public/share-videos/12345678-1234-1234-1234-1234567890ab.mp4?cache=1")}`,
    ),
  );
  assert.doesNotMatch(
    content,
    new RegExp(
      `/images/${encodeAssetPath("https://assets.grok.com/generated/12345678-1234-1234-1234-1234567890ab/generated_video.mp4")}`,
    ),
  );
});

test.after(() => {
  globalThis.fetch = originalFetch;
});
