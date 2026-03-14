import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const videoHtmlPath = path.join(repoRoot, "_public/static/function/pages/video.html");
const videoJsPath = path.join(repoRoot, "_public/static/function/js/video.js");

test("video page defaults to 480p resolution, caps duration at 15 seconds, and exposes the workspace actions", () => {
  const html = readFileSync(videoHtmlPath, "utf8");

  assert.match(html, /<option value="480p"\s+selected>480p<\/option>/);
  assert.match(
    html,
    /<input id="lengthSelect" class="geist-input" type="number" min="6" max="15" step="1" value="15">/,
  );
  assert.match(html, /视频工作区/);
  assert.match(html, /<button id="upscaleBtn"[^>]*>/);
  assert.match(html, /<span>AI\s*超分<\/span>/);
});

test("video page JS keeps generation at 15 seconds and extends up to 90 seconds", () => {
  const js = readFileSync(videoJsPath, "utf8");

  assert.match(js, /const MAX_VIDEO_SECONDS = 15;/);
  assert.match(js, /const MAX_EXTEND_VIDEO_SECONDS = 90;/);
  assert.match(js, /const videoLength = getRequestedVideoLength\(MAX_VIDEO_SECONDS, MAX_VIDEO_SECONDS\);/);
  assert.match(js, /const videoLength = getRequestedVideoLength\(MAX_EXTEND_VIDEO_SECONDS, DEFAULT_EXTEND_SECONDS\);/);
  assert.match(js, /function getRequestedResolutionName\(\)\s*\{\s*return resolutionSelect \? String\(resolutionSelect\.value \|\| ''\)\.trim\(\) \|\| '480p' : '480p';/);
});
