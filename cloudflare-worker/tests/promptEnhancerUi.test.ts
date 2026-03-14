import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("prompt enhancer icons keep a 20px footprint in the function pages", () => {
  const scriptPath = path.resolve(import.meta.dirname, "../../_public/static/common/js/prompt-enhancer.js");
  const source = fs.readFileSync(scriptPath, "utf8");

  assert.match(source, /<svg width="20" height="20"/);
  assert.match(source, /\.prompt-enhance-btn svg\s*\{\s*width:\s*20px;\s*height:\s*20px;\s*\}/);
});
