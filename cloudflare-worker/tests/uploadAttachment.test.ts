import test from "node:test";
import assert from "node:assert/strict";

import { prepareUploadAttachment, uploadAttachment } from "../src/grok/upload";

const originalFetch = globalThis.fetch;

test("prepareUploadAttachment preserves generic data-uri content for file uploads", () => {
  const payload = prepareUploadAttachment("data:text/plain;base64,SGVsbG8=", "attachment");

  assert.deepEqual(payload, {
    base64: "SGVsbG8=",
    mime: "text/plain",
    filename: "attachment.txt",
  });
});

test("uploadAttachment respects asset.download_timeout and asset.upload_timeout", async () => {
  const originalTimeout = AbortSignal.timeout;
  const sentinelSignal = new AbortController().signal;
  const timeoutCalls: number[] = [];
  const seenUrls: string[] = [];

  (AbortSignal as any).timeout = (ms: number) => {
    timeoutCalls.push(ms);
    return sentinelSignal;
  };

  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrls.push(String(input));
      assert.equal(init?.signal, sentinelSignal);
      if (String(input) === "https://example.com/input.png") {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }

      return new Response(JSON.stringify({ fileMetadataId: "file-1", fileUri: "/asset/file-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const result = await uploadAttachment(
      "https://example.com/input.png",
      "sso=test",
      { browser: "chrome136", user_agent: "Mozilla/5.0", cf_cookies: "" } as any,
      undefined,
      "image",
      { download_timeout: 7, upload_timeout: 11 },
    );

    assert.deepEqual(result, { fileId: "file-1", fileUri: "/asset/file-1" });
    assert.deepEqual(seenUrls, ["https://example.com/input.png", "https://grok.com/rest/app-chat/upload-file"]);
    assert.deepEqual(timeoutCalls, [7000, 11000]);
  } finally {
    (AbortSignal as any).timeout = originalTimeout;
    globalThis.fetch = originalFetch;
  }
});

test.after(() => {
  globalThis.fetch = originalFetch;
});
