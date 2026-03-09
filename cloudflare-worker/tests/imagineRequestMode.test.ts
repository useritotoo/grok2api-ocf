import test from "node:test";
import assert from "node:assert/strict";

import { resolveImagineGenerationTarget } from "../src/routes/function";

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