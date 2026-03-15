import assert from "node:assert/strict";
import test from "node:test";

import { getDynamicHeaders } from "../src/grok/headers.ts";

test("getDynamicHeaders uses configured user agent and browser fingerprint", () => {
  const userAgent =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
  const headers = getDynamicHeaders(
    {
      dynamic_statsig: false,
      x_statsig_id: "static-statsig-id",
      browser: "chrome136",
      user_agent: userAgent,
    } as any,
    "/rest/app-chat/conversations/new",
  );

  assert.equal(headers["User-Agent"], userAgent);
  assert.match(headers["Sec-Ch-Ua"] ?? "", /136/);
  assert.equal(headers["Sec-Ch-Ua-Mobile"], "?0");
  assert.equal(headers["Sec-Ch-Ua-Platform"], '"Windows"');
});
