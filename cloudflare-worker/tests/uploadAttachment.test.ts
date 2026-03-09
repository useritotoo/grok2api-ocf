import test from "node:test";
import assert from "node:assert/strict";

import { prepareUploadAttachment } from "../src/grok/upload";

test("prepareUploadAttachment preserves generic data-uri content for file uploads", () => {
  const payload = prepareUploadAttachment("data:text/plain;base64,SGVsbG8=", "attachment");

  assert.deepEqual(payload, {
    base64: "SGVsbG8=",
    mime: "text/plain",
    filename: "attachment.txt",
  });
});
