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

function createFakeDb() {
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

class FakeImagineWebSocket {
  private listeners = new Map<string, Set<EventListener>>();

  accept() {
    // no-op
  }

  send(raw: string) {
    const payload = JSON.parse(raw) as { item?: { content?: Array<{ requestId?: string }> } };
    const requestId = String(payload.item?.content?.[0]?.requestId ?? "");
    queueMicrotask(() => {
      for (let i = 0; i < 6; i++) {
        this.dispatch("message", {
          data: JSON.stringify({
            type: "image",
            request_id: requestId,
            id: `image-${i}`,
            url: `https://assets.grok.com/images/${i}.jpg`,
            blob: "a".repeat(110_000 + i),
          }),
        } as Event & { data: string });
      }
    });
  }

  close() {
    // no-op
  }

  addEventListener(type: string, listener: EventListener) {
    const bucket = this.listeners.get(type) ?? new Set<EventListener>();
    bucket.add(listener);
    this.listeners.set(type, bucket);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }

  private dispatch(type: string, event: Event) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener.call(this, event);
    }
  }
}

test("image generations use a single imagine websocket call for n=6 and still default to url responses", async () => {
  let wsCalls = 0;
  let conversationCalls = 0;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://grok.com/ws/imagine/listen") {
      wsCalls += 1;
      return {
        status: 101,
        webSocket: new FakeImagineWebSocket(),
        text: async () => "",
      } as unknown as Response;
    }
    if (url === "https://grok.com/rest/app-chat/conversations/new") {
      conversationCalls += 1;
      const body = JSON.stringify({
        result: {
          response: {
            modelResponse: {
              generatedImageUrls: [
                `https://assets.grok.com/images/legacy-${conversationCalls}-a.jpg`,
                `https://assets.grok.com/images/legacy-${conversationCalls}-b.jpg`,
              ],
            },
          },
        },
      });
      return new Response(`${body}\n`, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      });
    }
    return originalFetch(input);
  }) as typeof fetch;

  const response = await (worker.fetch as any)(
    new Request("https://example.com/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "A brutalist city at sunrise",
        n: 6,
      }),
    }),
    {
      DB: createFakeDb(),
      KV_CACHE: {
        async getWithMetadata() {
          return null;
        },
        async put() {
          // no-op
        },
      },
      BUILD_SHA: "dev",
      CACHE_RESET_TZ_OFFSET_MINUTES: "480",
      KV_CACHE_MAX_BYTES: "26214400",
      KV_CLEANUP_BATCH: "200",
    } as any,
    createExecutionContext(),
  );

  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    data: Array<{ url?: string }>;
  };
  assert.equal(payload.data.length, 6);
  assert.ok(payload.data.every((item) => typeof item.url === "string" && item.url.startsWith("https://example.com/images/")));
  assert.equal(wsCalls, 1);
  assert.equal(conversationCalls, 0);
});

test.after(() => {
  globalThis.fetch = originalFetch;
});
