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
    n: 5,
    infiniteMode: true,
    referenceUrl: "/images/upload-ref.png",
  });

  assert.deepEqual(payload, {
    prompt: "Turn this sketch into a polished poster",
    aspect_ratio: "1:1",
    nsfw: false,
    n: 5,
    infinite_mode: true,
    image_reference: {
      image_url: "/images/upload-ref.png",
    },
  });
});

test("buildImagineStartPayload includes multiple image_reference items when reference urls are provided", () => {
  const payload = buildImagineStartPayload({
    prompt: "Blend these three lighting references",
    aspectRatio: "3:2",
    nsfw: false,
    n: 2,
    infiniteMode: false,
    referenceUrl: [
      "/images/upload-ref-1.png",
      "/images/upload-ref-2.png",
      "/images/upload-ref-3.png",
    ],
  });

  assert.deepEqual(payload, {
    prompt: "Blend these three lighting references",
    aspect_ratio: "3:2",
    nsfw: false,
    n: 2,
    infinite_mode: false,
    image_reference: [
      { image_url: "/images/upload-ref-1.png" },
      { image_url: "/images/upload-ref-2.png" },
      { image_url: "/images/upload-ref-3.png" },
    ],
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

test("buildVideoStartPayload includes multiple image_reference items when reference urls are provided", () => {
  const payload = buildVideoStartPayload({
    prompt: "Animate using multiple pose references",
    aspectRatio: "16:9",
    videoLength: 6,
    resolutionName: "480p",
    preset: "normal",
    reasoningEffort: "low",
    referenceUrl: [
      "/images/upload-ref-1.png",
      "/images/upload-ref-2.png",
    ],
  });

  assert.deepEqual(payload, {
    prompt: "Animate using multiple pose references",
    aspect_ratio: "16:9",
    video_length: 6,
    resolution_name: "480p",
    preset: "normal",
    reasoning_effort: "low",
    image_reference: [
      { image_url: "/images/upload-ref-1.png" },
      { image_url: "/images/upload-ref-2.png" },
    ],
  });
});

test("buildVideoStartPayload includes video extension fields when provided", () => {
  const payload = buildVideoStartPayload({
    prompt: "",
    aspectRatio: "16:9",
    videoLength: 10,
    resolutionName: "720p",
    preset: "spicy",
    reasoningEffort: "low",
    extension: {
      extendPostId: "abcd1234abcd1234abcd1234abcd1234",
      startTime: 4.25,
      originalPostId: "orig1234orig1234orig1234orig1234",
      fileAttachmentId: "file1234file1234file1234file1234",
      stitchWithExtend: true,
    },
  });

  assert.deepEqual(payload, {
    prompt: "",
    aspect_ratio: "16:9",
    video_length: 10,
    resolution_name: "720p",
    preset: "spicy",
    reasoning_effort: "low",
    is_video_extension: true,
    extend_post_id: "abcd1234abcd1234abcd1234abcd1234",
    video_extension_start_time: 4.25,
    original_post_id: "orig1234orig1234orig1234orig1234",
    file_attachment_id: "file1234file1234file1234file1234",
    stitch_with_extend: true,
  });
});
