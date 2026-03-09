import assert from "node:assert/strict";
import test from "node:test";

import {
  chooseImageSizeFromAspectRatio,
  isFunctionSessionExpired,
} from "../src/function/taskHelpers.ts";

test("maps function imagine aspect ratios to image sizes", () => {
  assert.equal(chooseImageSizeFromAspectRatio("16:9"), "1280x720");
  assert.equal(chooseImageSizeFromAspectRatio("9:16"), "720x1280");
  assert.equal(chooseImageSizeFromAspectRatio("1:1"), "1024x1024");
  assert.equal(chooseImageSizeFromAspectRatio("weird"), "1024x1792");
});

test("treats expired function sessions as invalid", () => {
  assert.equal(isFunctionSessionExpired(1_000, 1_601), true);
  assert.equal(isFunctionSessionExpired(1_000, 1_600), false);
});
