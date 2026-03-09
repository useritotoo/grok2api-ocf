import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  createState,
  appendPoolTokens,
  getPaginationData,
} = require("../../_public/static/admin/js/token-page-state.js");

test("appendPoolTokens builds stats and filter buckets in one pass", () => {
  const state = createState(["sso=keep-selected"]);

  appendPoolTokens(state, "ssoBasic", [
    { token: "sso=keep-selected", status: "active", quota: 80, tags: [] },
    { token: "sso=needs-cooldown", status: "cooling", quota: 0, tags: ["nsfw"], use_count: 3 },
    { token: "sso=expired-one", status: "expired", quota: 0, tags: [] },
  ]);

  assert.equal(state.flatTokens.length, 3);
  assert.equal(state.selectedCount, 1);
  assert.equal(state.stats.totalTokens, 3);
  assert.equal(state.stats.activeTokens, 1);
  assert.equal(state.stats.coolingTokens, 1);
  assert.equal(state.stats.invalidTokens, 1);
  assert.equal(state.stats.nsfwTokens, 1);
  assert.equal(state.stats.noNsfwTokens, 2);
  assert.equal(state.stats.chatQuota, 80);
  assert.equal(state.stats.totalCalls, 3);
  assert.deepEqual(state.filterIndices.active, [0]);
  assert.deepEqual(state.filterIndices.cooling, [1]);
  assert.deepEqual(state.filterIndices.expired, [2]);
  assert.equal(state.flatTokens[0]._selected, true);
  assert.equal(state.flatTokens[0]._index, 0);
  assert.equal(state.flatTokens[1]._index, 1);
});

test("getPaginationData reuses cached filter indices", () => {
  const state = createState();

  appendPoolTokens(state, "ssoBasic", [
    { token: "sso=one", status: "active", quota: 80, tags: [] },
    { token: "sso=two", status: "active", quota: 70, tags: [] },
    { token: "sso=three", status: "disabled", quota: 60, tags: [] },
  ]);

  const page = getPaginationData(state, "active", 2, 1);

  assert.equal(page.totalCount, 2);
  assert.equal(page.totalPages, 2);
  assert.equal(page.currentPage, 2);
  assert.deepEqual(
    page.visibleTokens.map((token: { token: string }) => token.token),
    ["sso=two"],
  );
});
