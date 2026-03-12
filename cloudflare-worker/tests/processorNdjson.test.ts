import assert from "node:assert/strict";
import test from "node:test";

import { parseOpenAiFromGrokNdjson } from "../src/grok/processor.ts";

function createChunkedResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
      controller.close();
    },
  });
  const response = new Response(stream, {
    headers: { "content-type": "application/x-ndjson" },
  });
  (response as Response & { text: () => Promise<string> }).text = async () => {
    throw new Error("parseOpenAiFromGrokNdjson should not call resp.text()");
  };
  return response;
}

test("parseOpenAiFromGrokNdjson incrementally consumes chunked NDJSON without resp.text()", async () => {
  const response = createChunkedResponse([
    '{"result":{"response":{"modelResponse":{"model":"grok-4","message":"Hel',
    'lo from chunked NDJSON"}}}}\n',
  ]);

  const parsed = await parseOpenAiFromGrokNdjson(response, {
    cookie: "cookie",
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
      video_poster_preview: false,
      stream_first_response_timeout: 30,
      stream_chunk_timeout: 120,
      stream_total_timeout: 600,
      retry_status_codes: [401, 429, 403],
      image_generation_method: "imagine_ws_experimental",
    },
    global: {
      base_url: "https://example.com",
      log_level: "INFO",
      image_mode: "url",
      admin_username: "admin",
      admin_password: "admin",
      image_cache_max_size_mb: 512,
      video_cache_max_size_mb: 1024,
    },
    origin: "https://example.com",
    requestedModel: "grok-4",
  });

  assert.equal(parsed.model, "grok-4");
  assert.deepEqual(parsed.choices, [
    {
      index: 0,
      message: { role: "assistant", content: "Hello from chunked NDJSON" },
      finish_reason: "stop",
    },
  ]);
});
