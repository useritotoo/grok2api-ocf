import assert from "node:assert/strict";
import test from "node:test";

import {
  createImageEventStream,
  resolveConversationStreamSettings,
} from "../src/routes/openai.ts";

function createDelayedNdjsonResponse(lines: string[], delayMs: number): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (!lines.length) {
        controller.close();
        return;
      }

      controller.enqueue(encoder.encode(`${lines[0]}\n`));
      if (lines.length === 1) {
        controller.close();
        return;
      }

      setTimeout(() => {
        for (const line of lines.slice(1)) {
          controller.enqueue(encoder.encode(`${line}\n`));
        }
        controller.close();
      }, delayMs);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
  }

  output += decoder.decode();
  return output;
}

test("resolveConversationStreamSettings prefers current video.stream_timeout for video models", () => {
  const resolved = resolveConversationStreamSettings({
    requestedModel: "grok-imagine-1.0-video",
    current: {
      chat: { stream_timeout: 60 },
      video: { stream_timeout: 7 },
    } as any,
    grok: {
      stream_first_response_timeout: 30,
      stream_chunk_timeout: 120,
      stream_total_timeout: 600,
    } as any,
  });

  assert.equal(resolved.stream_chunk_timeout, 7);
});

test("createImageEventStream stops early when current image.stream_timeout is exceeded", async () => {
  const upstream = createDelayedNdjsonResponse(
    [
      JSON.stringify({
        result: {
          response: {
            streamingImageGenerationResponse: {
              imageIndex: 0,
              progress: 35,
            },
          },
        },
      }),
      JSON.stringify({
        result: {
          response: {
            modelResponse: {
              generatedImageUrls: ["https://assets.grok.com/generated/image-timeout.png"],
            },
          },
        },
      }),
    ],
    200,
  );

  const output = await readStream(
    createImageEventStream({
      upstream,
      responseFormat: "url",
      baseUrl: "https://worker.example.com",
      cookie: "sso=test",
      settings: {
        filtered_tags: "",
        show_thinking: true,
      } as any,
      n: 2,
      streamTimeoutMs: 10,
    }),
  );

  assert.match(output, /image_generation\.partial_image/);
  assert.doesNotMatch(output, /image_generation\.completed/);
  assert.doesNotMatch(output, /image-timeout\.png/);
});
