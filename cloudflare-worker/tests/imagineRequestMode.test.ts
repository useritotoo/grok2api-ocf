import test from "node:test";
import assert from "node:assert/strict";

import {
  buildImagineGenerationBody,
  resolveImagineGenerationTarget,
} from "../src/routes/function";

test("uses the edit image model when imagine requests include a reference image", () => {
  assert.deepEqual(resolveImagineGenerationTarget("https://example.com/reference.png"), {
    path: "/images/edits",
    model: "grok-imagine-1.0-edit",
  });
});

test("uses the base image model when imagine requests do not include a reference image", () => {
  assert.deepEqual(resolveImagineGenerationTarget(""), {
    path: "/images/generations",
    model: "grok-imagine-1.0",
  });
});

test("maps imagine aspect ratios to upstream image sizes for generation requests", () => {
  assert.deepEqual(
    buildImagineGenerationBody({
      prompt: "A neon skyline",
      aspect_ratio: "16:9",
      nsfw: false,
      image_reference: null,
    }),
    {
      model: "grok-imagine-1.0",
      prompt: "A neon skyline",
      n: 6,
      stream: false,
      response_format: "b64_json",
      size: "1280x720",
      concurrency: 1,
    },
  );
});
