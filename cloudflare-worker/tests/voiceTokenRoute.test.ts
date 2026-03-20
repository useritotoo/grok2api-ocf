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
  const settingEntries: Array<[string, string]> = [
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
    ...Object.entries(extraSettings).map(
      ([key, value]): [string, string] => [key, JSON.stringify(value)],
    ),
  ];
  const settings = new Map<string, string>(settingEntries);

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

test("function voice token preserves upstream livekit urls and ice servers", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://grok.com/rest/livekit/tokens") {
      assert.equal(init?.method, "POST");
      return new Response(
        JSON.stringify({
          token: "voice-token",
          url: "wss://edge.livekit.grok.com",
          urls: ["wss://edge.livekit.grok.com", "wss://livekit.grok.com/rtc"],
          iceServers: [
            {
              urls: ["turn:turn.example.com:3478?transport=udp"],
              username: "demo",
              credential: "secret",
            },
          ],
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
    new Request("https://example.com/v1/function/voice/token?voice=ara&personality=assistant&speed=1", {
      headers: { Authorization: "Bearer function-secret" },
    }),
    {
      DB: createFakeDb(),
      BUILD_SHA: "dev",
      CACHE_RESET_TZ_OFFSET_MINUTES: "480",
      KV_CACHE_MAX_BYTES: "26214400",
      KV_CLEANUP_BATCH: "200",
    } as any,
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    token: string;
    url: string;
    urls?: string[];
    ice_servers?: Array<{ urls: string[]; username?: string; credential?: string }>;
  };
  assert.equal(payload.token, "voice-token");
  assert.equal(payload.url, "wss://edge.livekit.grok.com");
  assert.deepEqual(payload.urls?.slice(0, 2), ["wss://edge.livekit.grok.com", "wss://livekit.grok.com/rtc"]);
  assert.ok(payload.urls?.includes("wss://livekit.grok.com"));
  assert.deepEqual(payload.ice_servers, [
    {
      urls: ["turn:turn.example.com:3478?transport=udp"],
      username: "demo",
      credential: "secret",
    },
  ]);
});

test("function voice token uses current voice.timeout for the upstream request", async () => {
  const originalTimeout = AbortSignal.timeout;
  const sentinelSignal = new AbortController().signal;
  let timeoutMs = -1;

  (AbortSignal as any).timeout = (ms: number) => {
    timeoutMs = ms;
    return sentinelSignal;
  };

  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://grok.com/rest/livekit/tokens") {
        assert.equal(init?.signal, sentinelSignal);
        return new Response(
          JSON.stringify({
            token: "voice-token",
            url: "wss://livekit.grok.com",
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
      new Request("https://example.com/v1/function/voice/token?voice=ara&personality=assistant&speed=1", {
        headers: { Authorization: "Bearer function-secret" },
      }),
      {
        DB: createFakeDb({
          voice: {
            timeout: 7,
          },
        }),
        BUILD_SHA: "dev",
        CACHE_RESET_TZ_OFFSET_MINUTES: "480",
        KV_CACHE_MAX_BYTES: "26214400",
        KV_CLEANUP_BATCH: "200",
      } as any,
      createExecutionContext(),
    );

    assert.equal(response.status, 200);
    assert.equal(timeoutMs, 7000);
  } finally {
    (AbortSignal as any).timeout = originalTimeout;
  }
});

test.after(() => {
  globalThis.fetch = originalFetch;
});
