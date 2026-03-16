import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..", "..");

function readSourceAsset(...parts: string[]): string {
  return readFileSync(resolve(repoRoot, ...parts), "utf8");
}

test("admin header links the datacenter entry to the worker-managed page route", () => {
  const headerHtml = readSourceAsset("_public", "static", "common", "html", "header.html");

  assert.match(headerHtml, /href="\/admin\/pages\/datacenter"/);
  assert.match(headerHtml, /data-nav="\/admin\/pages\/datacenter"/);
});

test("datacenter source assets keep readable Chinese log labels instead of mojibake", () => {
  const datacenterHtml = readSourceAsset("_public", "static", "admin", "pages", "datacenter.html");
  const datacenterJs = readSourceAsset("_public", "static", "admin", "js", "datacenter.js");

  assert.match(datacenterHtml, /后台日志/);
  assert.match(datacenterHtml, /过滤关键词…/);
  assert.match(datacenterHtml, /加载中\.\.\./);
  assert.match(datacenterJs, /\/api\/v1\/admin\/metrics/);
  assert.match(datacenterJs, /\/api\/v1\/admin\/logs\/files/);
  assert.match(datacenterJs, /\/api\/v1\/admin\/logs\/tail/);
  assert.match(datacenterJs, /读取日志失败：/);
  assert.match(datacenterJs, /刷新失败：/);

  assert.doesNotMatch(datacenterJs, /fetchJson\("\/v1\/admin\/metrics"\)/);
  assert.doesNotMatch(datacenterJs, /fetchJson\("\/v1\/admin\/logs\/files"\)/);
  assert.doesNotMatch(datacenterJs, /fetchJson\(`\/v1\/admin\/logs\/tail\?\$\{params\.toString\(\)\}`\)/);
});
