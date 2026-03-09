import assert from "node:assert/strict";
import test from "node:test";

import {
  getFaviconAssetPath,
  getStaticPagePath,
} from "../src/sitePaths.ts";

test("maps current public pages to worker asset paths", () => {
  assert.equal(getStaticPagePath("/login"), "/function/pages/login.html");
  assert.equal(getStaticPagePath("/chat"), "/function/pages/chat.html");
  assert.equal(getStaticPagePath("/admin/token"), "/admin/pages/token.html");
});

test("omits legacy pages that no longer exist in the current repo", () => {
  assert.equal(getStaticPagePath("/admin/keys"), null);
  assert.equal(getStaticPagePath("/admin/datacenter"), null);
});

test("uses the current repo favicon asset path", () => {
  assert.equal(getFaviconAssetPath(), "/common/img/favicon/favicon.ico");
});
