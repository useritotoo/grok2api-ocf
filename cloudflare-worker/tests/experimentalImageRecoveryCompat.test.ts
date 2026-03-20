import assert from "node:assert/strict";
import test from "node:test";

import { collectExperimentalGenerationImages } from "../src/routes/openai.ts";

const originalFetch = globalThis.fetch;

class FakeImagineWebSocket {
  private listeners = new Map<string, Set<EventListener>>();

  constructor(private readonly attempt: number) {}

  accept() {
    // no-op
  }

  send(raw: string) {
    const payload = JSON.parse(raw) as { item?: { content?: Array<{ requestId?: string }> } };
    const requestId = String(payload.item?.content?.[0]?.requestId ?? "");
    queueMicrotask(() => {
      if (this.attempt === 1) {
        this.dispatch("message", {
          data: JSON.stringify({
            type: "image",
            request_id: requestId,
            id: "medium-only",
            url: "https://assets.grok.com/images/medium-only.jpg",
            blob: "a".repeat(50_000),
          }),
        } as Event & { data: string });
      } else {
        this.dispatch("message", {
          data: JSON.stringify({
            type: "image",
            request_id: requestId,
            id: "final-image",
            url: "https://assets.grok.com/images/final-image.jpg",
            blob: "b".repeat(120_000),
          }),
        } as Event & { data: string });
      }
      this.dispatch("close", new Event("close"));
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

test("collectExperimentalGenerationImages retries once when blocked_parallel_attempts is enabled and the first websocket call never reaches a final image", async () => {
  let wsCalls = 0;

  try {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) === "https://grok.com/ws/imagine/listen") {
        wsCalls += 1;
        return {
          status: 101,
          webSocket: new FakeImagineWebSocket(wsCalls),
          text: async () => "",
        } as unknown as Response;
      }
      return originalFetch(input);
    }) as typeof fetch;

    const images = await collectExperimentalGenerationImages({
      prompt: "A neon skyline",
      n: 1,
      cookie: "sso=test-token",
      settings: {
        api_key: "",
        proxy_url: "",
        proxy_pool_url: "",
        proxy_pool_interval: 300,
        cache_proxy_url: "",
        cf_clearance: "",
        x_statsig_id: "",
        dynamic_statsig: true,
        filtered_tags: "",
        show_thinking: true,
        temporary: false,
        disable_memory: false,
        custom_instruction: "",
        video_poster_preview: false,
        stream_first_response_timeout: 30,
        stream_chunk_timeout: 120,
        stream_total_timeout: 600,
        retry_status_codes: [401, 429, 403],
        image_generation_method: "imagine_ws_experimental",
      } as any,
      responseFormat: "url",
      baseUrl: "https://worker.example.com",
      aspectRatio: "1:1",
      concurrency: 1,
      streamTimeoutMs: 10,
      finalTimeoutMs: 20,
      blockedGraceMs: 10,
      blockedParallelAttempts: 1,
      blockedParallelEnabled: false,
      enableNsfw: true,
      finalMinBytes: 100_000,
      mediumMinBytes: 30_000,
    });

    assert.equal(wsCalls, 2);
    assert.deepEqual(images, [
      "https://worker.example.com/images/u_aHR0cHM6Ly9hc3NldHMuZ3Jvay5jb20vaW1hZ2VzL2ZpbmFsLWltYWdlLmpwZw",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
