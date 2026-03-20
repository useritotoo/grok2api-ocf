import assert from "node:assert/strict";
import test from "node:test";

import { clearAssetsForToken, listAssets } from "../src/grok/assets.ts";

const originalFetch = globalThis.fetch;

test("listAssets keeps Grok page size and respects current asset.list_timeout", async () => {
  const originalTimeout = AbortSignal.timeout;
  const sentinelSignal = new AbortController().signal;
  let timeoutMs = -1;
  let requestedUrl = "";

  (AbortSignal as any).timeout = (ms: number) => {
    timeoutMs = ms;
    return sentinelSignal;
  };

  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      assert.equal(init?.signal, sentinelSignal);
      return new Response(JSON.stringify({ assets: [], nextPageToken: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await (listAssets as any)(
      "token-1",
      { browser: "chrome136", user_agent: "Mozilla/5.0", cf_cookies: "" },
      {
        list_timeout: 9,
      },
    );

    assert.match(requestedUrl, /pageSize=50/);
    assert.equal(timeoutMs, 9000);
  } finally {
    (AbortSignal as any).timeout = originalTimeout;
  }
});

test("clearAssetsForToken respects current asset.delete_timeout", async () => {
  const originalTimeout = AbortSignal.timeout;
  const sentinelSignal = new AbortController().signal;
  const seenTimeouts: number[] = [];
  const seenMethods: string[] = [];

  (AbortSignal as any).timeout = (ms: number) => {
    seenTimeouts.push(ms);
    return sentinelSignal;
  };

  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenMethods.push(String(init?.method ?? "GET"));
      assert.equal(init?.signal, sentinelSignal);
      if (String(init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({ assets: [{ assetId: "asset-1" }], nextPageToken: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const result = await (clearAssetsForToken as any)(
      "token-1",
      { browser: "chrome136", user_agent: "Mozilla/5.0", cf_cookies: "" },
      {
        delete_timeout: 11,
      },
    );

    assert.deepEqual(result, { total: 1, success: 1, failed: 0 });
    assert.deepEqual(seenMethods, ["GET", "DELETE"]);
    assert.equal(seenTimeouts.at(-1), 11000);
  } finally {
    (AbortSignal as any).timeout = originalTimeout;
    globalThis.fetch = originalFetch;
  }
});

test("clearAssetsForToken respects current asset.delete_concurrent", async () => {
  let inFlight = 0;
  let maxInFlight = 0;

  try {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (String(init?.method ?? "GET") === "GET") {
        return new Response(
          JSON.stringify({
            assets: [{ assetId: "asset-1" }, { assetId: "asset-2" }, { assetId: "asset-3" }],
            nextPageToken: null,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const result = await (clearAssetsForToken as any)(
      "token-1",
      { browser: "chrome136", user_agent: "Mozilla/5.0", cf_cookies: "" },
      {
        delete_concurrent: 2,
      },
    );

    assert.deepEqual(result, { total: 3, success: 3, failed: 0 });
    assert.equal(maxInFlight, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test.after(() => {
  globalThis.fetch = originalFetch;
});
