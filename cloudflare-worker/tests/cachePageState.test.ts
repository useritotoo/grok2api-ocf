import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  truncateMiddle,
  paginateItems,
  buildOnlineRows,
} = require("../../_public/static/admin/js/cache-page-state.js");

test("truncateMiddle keeps the file extension visible for long cache names", () => {
  assert.equal(
    truncateMiddle("very-long-reference-image-file-name-example.png", 28),
    "very-long-ref...example.png",
  );
  assert.equal(truncateMiddle("short.png", 28), "short.png");
});

test("paginateItems clamps page numbers and slices visible records", () => {
  const page = paginateItems([1, 2, 3, 4, 5], 9, 2);

  assert.equal(page.currentPage, 3);
  assert.equal(page.totalPages, 3);
  assert.deepEqual(page.visibleItems, [5]);
});

test("buildOnlineRows merges account details with cached token state", () => {
  const accountStates = new Map([
    ["token-b", { count: 7, status: "ok", last_asset_clear_at: 200 }],
  ]);

  const rows = buildOnlineRows({
    accounts: [
      { token: "token-a", token_masked: "token-a***", pool: "basic", last_asset_clear_at: 100 },
      { token: "token-b", token_masked: "token-b***", pool: "pro", last_asset_clear_at: 150 },
    ],
    details: [
      { token: "token-a", count: 3, status: "ok", last_asset_clear_at: 120 },
    ],
    online: { token: null, count: 0, status: "not_loaded", last_asset_clear_at: null },
    accountStates,
  });

  assert.deepEqual(rows, [
    {
      token: "token-a",
      token_masked: "token-a***",
      pool: "basic",
      count: 3,
      status: "ok",
      last_asset_clear_at: 120,
    },
    {
      token: "token-b",
      token_masked: "token-b***",
      pool: "pro",
      count: 7,
      status: "ok",
      last_asset_clear_at: 200,
    },
  ]);
});