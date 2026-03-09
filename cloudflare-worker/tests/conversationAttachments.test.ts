import test from "node:test";
import assert from "node:assert/strict";

import { extractContent } from "../src/grok/conversation";

test("extractContent keeps chat file attachments from file_data blocks", () => {
  const result = extractContent([
    {
      role: "user",
      content: [
        { type: "text", text: "Summarize this file" },
        {
          type: "file",
          file: {
            file_data: "data:text/plain;base64,SGVsbG8sIHdvcmxkIQ==",
          },
        },
      ],
    },
  ] as any);

  assert.equal(result.content, "Summarize this file");
  assert.deepEqual(result.attachments, [
    {
      kind: "file",
      value: "data:text/plain;base64,SGVsbG8sIHdvcmxkIQ==",
    },
  ]);
});

test("extractContent treats image-style file_data as image attachments", () => {
  const result = extractContent([
    {
      role: "user",
      content: [
        { type: "text", text: "Describe this image" },
        {
          type: "file",
          file: {
            file_data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA",
          },
        },
      ],
    },
  ] as any);

  assert.deepEqual(result.attachments, [
    {
      kind: "image",
      value: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA",
    },
  ]);
});
