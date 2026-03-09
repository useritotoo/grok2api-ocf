import test from "node:test";
import assert from "node:assert/strict";

import {
  buildInternalRequestUrl,
  parseSseChunk,
} from "../src/routes/functionHelpers";

test("buildInternalRequestUrl preserves the public origin for internal function proxy calls", () => {
  const url = buildInternalRequestUrl(
    "https://demo.example/v1/function/chat/completions",
    "/chat/completions",
  );

  assert.equal(url, "https://demo.example/chat/completions");
});

test("parseSseChunk promotes the SSE event name into the payload type", () => {
  const payload = parseSseChunk(
    'event: image_generation.completed\ndata: {"url":"https://demo.example/images/abc"}\n\n',
  );

  assert.deepEqual(payload, {
    type: "image_generation.completed",
    url: "https://demo.example/images/abc",
  });
});
