import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  createReferenceUploadCache,
  buildReferenceUploadKey,
} = require("../../_public/static/function/js/video-reference-cache.js");

test("buildReferenceUploadKey uses file identity fields to fingerprint uploads", () => {
  const key = buildReferenceUploadKey({
    name: "reference.png",
    size: 2048,
    lastModified: 1700000000000,
    type: "image/png",
  });

  assert.equal(key, "reference.png::2048::1700000000000::image/png");
});

test("createReferenceUploadCache reuses the previous upload url for the same file", async () => {
  const cache = createReferenceUploadCache();
  const file = {
    name: "reference.png",
    size: 2048,
    lastModified: 1700000000000,
    type: "image/png",
  };
  let uploadCount = 0;

  const upload = async () => {
    uploadCount += 1;
    return `/uploads/reference-${uploadCount}.png`;
  };

  const first = await cache.getOrUpload(file, upload);
  const second = await cache.getOrUpload(file, upload);

  assert.equal(first, "/uploads/reference-1.png");
  assert.equal(second, "/uploads/reference-1.png");
  assert.equal(uploadCount, 1);
});

test("createReferenceUploadCache clears the cached upload after reset", async () => {
  const cache = createReferenceUploadCache();
  const file = {
    name: "reference.png",
    size: 2048,
    lastModified: 1700000000000,
    type: "image/png",
  };
  let uploadCount = 0;

  const upload = async () => {
    uploadCount += 1;
    return `/uploads/reference-${uploadCount}.png`;
  };

  await cache.getOrUpload(file, upload);
  cache.reset();
  const next = await cache.getOrUpload(file, upload);

  assert.equal(next, "/uploads/reference-2.png");
  assert.equal(uploadCount, 2);
});
