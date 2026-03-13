import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  createReferenceUploadCache,
  abortReferenceUpload,
  buildReferenceUploadKey,
  extractReferenceRemoveId,
  hasPendingReferenceUploads,
  syncReferenceStartButtonState,
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

test("createReferenceUploadCache keeps upload urls isolated per file", async () => {
  const cache = createReferenceUploadCache();
  const firstFile = {
    name: "reference-a.png",
    size: 1024,
    lastModified: 1700000000000,
    type: "image/png",
  };
  const secondFile = {
    name: "reference-b.png",
    size: 4096,
    lastModified: 1700000001234,
    type: "image/png",
  };
  let uploadCount = 0;

  const upload = async (file: { name: string }) => {
    uploadCount += 1;
    return `/uploads/${file.name}-${uploadCount}.png`;
  };

  const first = await cache.getOrUpload(firstFile, upload);
  const second = await cache.getOrUpload(secondFile, upload);
  const firstAgain = await cache.getOrUpload(firstFile, upload);
  const secondAgain = await cache.getOrUpload(secondFile, upload);

  assert.equal(first, "/uploads/reference-a.png-1.png");
  assert.equal(second, "/uploads/reference-b.png-2.png");
  assert.equal(firstAgain, first);
  assert.equal(secondAgain, second);
  assert.equal(uploadCount, 2);
});

test("hasPendingReferenceUploads returns true only while a reference upload is still running", () => {
  assert.equal(hasPendingReferenceUploads([]), false);
  assert.equal(hasPendingReferenceUploads([{ status: "ready" }]), false);
  assert.equal(
    hasPendingReferenceUploads([
      { status: "ready" },
      { status: "uploading" },
    ]),
    true,
  );
});

test("syncReferenceStartButtonState disables the start button during upload and restores it after completion", () => {
  const startBtn = { disabled: false };

  const pending = syncReferenceStartButtonState(startBtn, {
    isRunning: false,
    referenceItems: [{ status: "uploading" }],
  });
  assert.equal(pending, true);
  assert.equal(startBtn.disabled, true);

  const ready = syncReferenceStartButtonState(startBtn, {
    isRunning: false,
    referenceItems: [{ status: "ready" }],
  });
  assert.equal(ready, false);
  assert.equal(startBtn.disabled, false);

  const running = syncReferenceStartButtonState(startBtn, {
    isRunning: true,
    referenceItems: [{ status: "ready" }],
  });
  assert.equal(running, true);
  assert.equal(startBtn.disabled, true);
});

test("extractReferenceRemoveId accepts SVG-like event targets inside the remove button", () => {
  const removeButton = {
    getAttribute(name: string) {
      return name === "data-reference-remove" ? "ref-123" : null;
    },
  };
  const svgTarget = {
    closest(selector: string) {
      return selector === "[data-reference-remove]" ? removeButton : null;
    },
  };

  assert.equal(extractReferenceRemoveId(svgTarget), "ref-123");
  assert.equal(extractReferenceRemoveId(null), "");
  assert.equal(extractReferenceRemoveId({}), "");
});

test("abortReferenceUpload cancels an in-flight upload exactly once", () => {
  let abortCount = 0;
  const item = {
    abortUpload() {
      abortCount += 1;
    },
  };

  assert.equal(abortReferenceUpload(item), true);
  assert.equal(abortCount, 1);
  assert.equal(abortReferenceUpload({}), false);
});
