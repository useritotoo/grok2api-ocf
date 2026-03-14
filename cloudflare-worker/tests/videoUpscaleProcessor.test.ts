import test from "node:test";
import assert from "node:assert/strict";

import {
  createOpenAiStreamFromGrokNdjson,
  parseOpenAiFromGrokNdjson,
} from "../src/grok/processor.ts";

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

function encodeAssetPath(raw: string): string {
  const bytes = new TextEncoder().encode(raw);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `u_${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}`;
}

const defaultOptions = {
  cookie: "cookie",
  settings: {
    filtered_tags: "xaiartifact,xai:tool_usage_card,grok:render",
    show_thinking: true,
    stream_first_response_timeout: 1,
    stream_chunk_timeout: 1,
    stream_total_timeout: 1,
    video_poster_preview: false,
  } as any,
  global: { base_url: "" } as any,
  origin: "https://worker.example.com",
  requestedModel: "grok-imagine-1.0-video",
};

test("parseOpenAiFromGrokNdjson can replace video urls with an upscaled result before rendering", async () => {
  const payload = [
    JSON.stringify({
      result: {
        response: {
          streamingVideoGenerationResponse: {
            progress: 100,
            videoUrl: "https://assets.example.com/generated_video.mp4",
            thumbnailImageUrl: "https://assets.example.com/generated_thumb.jpg",
          },
        },
      },
    }),
  ].join("\n") + "\n";

  const response = await parseOpenAiFromGrokNdjson(new Response(payload), {
    ...defaultOptions,
    transformVideoAsset: async () => ({
      videoUrl: "https://assets.example.com/generated_video_hd.mp4",
      thumbnailUrl: "https://assets.example.com/generated_thumb_hd.jpg",
    }),
  } as any);

  const content = String((response.choices as any[])[0]?.message?.content ?? "");
  assert.match(
    content,
    new RegExp(`/images/${encodeAssetPath("https://assets.example.com/generated_video_hd.mp4")}`),
  );
  assert.doesNotMatch(
    content,
    new RegExp(`/images/${encodeAssetPath("https://assets.example.com/generated_video.mp4")}`),
  );
});

test("createOpenAiStreamFromGrokNdjson can defer final video output until an upscaled url is available", async () => {
  const payload = [
    JSON.stringify({
      result: {
        response: {
          streamingVideoGenerationResponse: {
            progress: 45,
          },
        },
      },
    }),
    JSON.stringify({
      result: {
        response: {
          streamingVideoGenerationResponse: {
            progress: 100,
            videoUrl: "https://assets.example.com/generated_video.mp4",
            thumbnailImageUrl: "https://assets.example.com/generated_thumb.jpg",
          },
        },
      },
    }),
  ].join("\n") + "\n";

  const output = await readStream(
    createOpenAiStreamFromGrokNdjson(new Response(payload), {
      ...defaultOptions,
      videoMode: "finalize",
      transformVideoAsset: async () => ({
        videoUrl: "https://assets.example.com/generated_video_hd.mp4",
        thumbnailUrl: "https://assets.example.com/generated_thumb_hd.jpg",
      }),
    } as any),
  );

  assert.match(
    output,
    new RegExp(`/images/${encodeAssetPath("https://assets.example.com/generated_video_hd.mp4")}`),
  );
  assert.doesNotMatch(
    output,
    new RegExp(`/images/${encodeAssetPath("https://assets.example.com/generated_video.mp4")}`),
  );
});
