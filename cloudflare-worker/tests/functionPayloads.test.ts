import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildImagineStartPayload,
  buildVideoStartPayload,
} = require("../../_public/static/function/js/function-payloads.js");

test("buildImagineStartPayload includes image_reference when a reference url is provided", () => {
  const payload = buildImagineStartPayload({
    prompt: "Turn this sketch into a polished poster",
    aspectRatio: "1:1",
    nsfw: false,
    referenceUrl: "/images/upload-ref.png",
  });

  assert.deepEqual(payload, {
    prompt: "Turn this sketch into a polished poster",
    aspect_ratio: "1:1",
    nsfw: false,
    image_reference: {
      image_url: "/images/upload-ref.png",
    },
  });
});

test("buildVideoStartPayload includes image_reference when a reference url is provided", () => {
  const payload = buildVideoStartPayload({
    prompt: "Animate this portrait",
    aspectRatio: "9:16",
    videoLength: 10,
    resolutionName: "720p",
    preset: "normal",
    reasoningEffort: "medium",
    referenceUrl: "/images/upload-ref.png",
  });

  assert.deepEqual(payload, {
    prompt: "Animate this portrait",
    aspect_ratio: "9:16",
    video_length: 10,
    resolution_name: "720p",
    preset: "normal",
    reasoning_effort: "medium",
    image_reference: {
      image_url: "/images/upload-ref.png",
    },
  });
});
