import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const videoHtmlPath = path.join(repoRoot, "_public/static/function/pages/video.html");
const videoJsPath = path.join(repoRoot, "_public/static/function/js/video.js");

test("video page defaults to 720p resolution and 15 second duration", () => {
  const html = readFileSync(videoHtmlPath, "utf8");

  assert.match(html, /<option value="720p"\s+selected>720p<\/option>/);
  assert.match(
    html,
    /<input id="lengthSelect" class="geist-input" type="number" min="6" max="30" step="1" value="15">/,
  );
});

test("video page JS fallbacks align with the 720p and 15 second defaults", () => {
  const js = readFileSync(videoJsPath, "utf8");

  assert.match(js, /videoLength:\s*lengthSelect \? parseInt\(lengthSelect\.value, 10\) : 15,/);
  assert.match(js, /resolutionName:\s*resolutionSelect \? resolutionSelect\.value : '720p',/);
  assert.match(js, /video_length:\s*lengthSelect \? parseInt\(lengthSelect\.value, 10\) : 15,/);
  assert.match(js, /resolution_name:\s*resolutionSelect \? resolutionSelect\.value : '720p',/);
});
