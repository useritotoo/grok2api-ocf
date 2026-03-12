import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const chatHtmlPath = path.join(repoRoot, "_public/static/function/pages/chat.html");
const chatCssPath = path.join(repoRoot, "_public/static/function/css/chat.css");

test("chat mobile model chip keeps the label element in markup", () => {
  const html = readFileSync(chatHtmlPath, "utf8");

  assert.match(
    html,
    /<span class="model-label" id="modelLabel">[^<]+<\/span>/,
  );
});

test("chat mobile model chip hides the model label under the mobile breakpoint", () => {
  const css = readFileSync(chatCssPath, "utf8");
  const mobileMediaBlock = css.match(/@media \(max-width: 720px\) \{[\s\S]*?\n\}/);

  assert.ok(mobileMediaBlock, "expected a mobile media block in chat.css");
  assert.match(
    mobileMediaBlock[0],
    /\.model-chip\s+\.model-label\s*\{\s*display:\s*none;\s*\}/,
  );
});
