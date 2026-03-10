import test from "node:test";
import assert from "node:assert/strict";

import {
  createOpenAiStreamFromGrokNdjson,
  parseOpenAiFromGrokNdjson,
} from "../src/grok/processor";

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

function extractDeltaContents(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as { choices?: Array<{ delta?: { content?: string } }> })
    .map((chunk) => String(chunk.choices?.[0]?.delta?.content ?? ""))
    .filter(Boolean);
}

test("createOpenAiStreamFromGrokNdjson emits markdown image for cardAttachment", async () => {
  const payload = [
    JSON.stringify({ result: { response: { token: "before ", isThinking: false } } }),
    JSON.stringify({
      result: {
        response: {
          cardAttachment: {
            jsonData: JSON.stringify({
              image: {
                original: "https://example.com/demo.png",
                title: "demo",
              },
            }),
          },
        },
      },
    }),
  ].join("\n") + "\n";

  const output = await readStream(
    createOpenAiStreamFromGrokNdjson(new Response(payload), {
      cookie: "",
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
      requestedModel: "grok-4",
    }),
  );

  assert.match(output, /!\[demo\]\(https:\/\/example\.com\/demo\.png\)/);
});

test("createOpenAiStreamFromGrokNdjson closes think blocks and emits final modelResponse text", async () => {
  const payload = [
    JSON.stringify({ result: { response: { token: "analysis", isThinking: true } } }),
    JSON.stringify({
      result: {
        response: {
          modelResponse: {
            message: "final answer",
            generatedImageUrls: [],
          },
        },
      },
    }),
  ].join("\n") + "\n";

  const output = await readStream(
    createOpenAiStreamFromGrokNdjson(new Response(payload), {
      cookie: "",
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
      requestedModel: "grok-4",
    }),
  );

  const contents = extractDeltaContents(output);
  assert.equal(contents[0], "<think>\nanalysis");
  assert.equal(contents[1], "\n</think>\nfinal answer");
});

test("parseOpenAiFromGrokNdjson replaces grok:render image cards with markdown", async () => {
  const payload = [
    JSON.stringify({
      result: {
        response: {
          modelResponse: {
            message: 'prefix <grok:render card_id="card-1"></grok:render> suffix',
            cardAttachmentsJson: [
              JSON.stringify({
                id: "card-1",
                image: {
                  original: "https://example.com/nonstream.png",
                  title: "nonstream",
                },
              }),
            ],
            generatedImageUrls: [],
          },
        },
      },
    }),
  ].join("\n") + "\n";

  const response = await parseOpenAiFromGrokNdjson(new Response(payload), {
    cookie: "",
    settings: {
      filtered_tags: "xaiartifact,xai:tool_usage_card,grok:render",
      show_thinking: true,
      video_poster_preview: false,
    } as any,
    global: { base_url: "" } as any,
    origin: "https://worker.example.com",
    requestedModel: "grok-4",
  });

  const content = String((response.choices as any[])[0]?.message?.content ?? "");
  assert.match(content, /!\[nonstream\]\(https:\/\/example\.com\/nonstream\.png\)/);
  assert.doesNotMatch(content, /<grok:render/);
});
