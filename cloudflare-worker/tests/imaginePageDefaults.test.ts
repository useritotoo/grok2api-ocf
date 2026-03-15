import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const imagineHtmlPath = path.join(repoRoot, "_public/static/function/pages/imagine.html");
const imagineJsPath = path.join(repoRoot, "_public/static/function/js/imagine.js");

test("imagine page defaults to auto filter on and six images", () => {
  const html = readFileSync(imagineHtmlPath, "utf8");
  const js = readFileSync(imagineJsPath, "utf8");

  assert.match(html, /<input id="autoFilterToggle" type="checkbox"\s+checked>/);
  assert.match(html, /<option value="6"\s+selected[^>]*data-i18n="imagine\.nCount6">6/);
  assert.match(js, /const n = nSelect \? \(parseInt\(nSelect\.value, 10\) \|\| 6\) : 6;/);
  assert.match(
    js,
    /const nVal = state && state\.imageCount \? state\.imageCount : \(nSelect \? \(parseInt\(nSelect\.value, 10\) \|\| 6\) : 6\);/,
  );
});
