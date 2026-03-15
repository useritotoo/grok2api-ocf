import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const videoHtmlPath = path.join(repoRoot, "_public/static/function/pages/video.html");
const videoJsPath = path.join(repoRoot, "_public/static/function/js/video.js");
const videoCssPath = path.join(repoRoot, "_public/static/function/css/video.css");

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

test("video page keeps the @Image mention menu compact and allows it to flip above the prompt box", () => {
  const js = readFileSync(videoJsPath, "utf8");
  const css = readFileSync(videoCssPath, "utf8");

  assert.match(css, /\.video-prompt-wrap\s*\{[\s\S]*overflow:\s*visible;/);
  assert.match(css, /\.reference-mention-menu\s*\{[\s\S]*min-width:\s*120px;[\s\S]*max-width:\s*min\(248px, calc\(100vw - 24px\)\);/);
  assert.match(css, /\.reference-mention-menu\.is-above\s*\{/);
  assert.match(js, /referenceMentionMenu\.classList\.toggle\('is-above',\s*shouldPlaceAbove\);/);
});

test("video page styles a pending history card with a loading indicator", () => {
  const css = readFileSync(videoCssPath, "utf8");

  assert.match(css, /\.video-item-spinner\s*\{/);
  assert.match(css, /\.video-item-spinner\s*\{[\s\S]*animation:\s*video-item-spinner-spin 0\.9s linear infinite;/);
  assert.match(css, /@keyframes video-item-spinner-spin\s*\{/);
});

test("video page keeps rich prompt input limited to plain text plus @Image chips", () => {
  const js = readFileSync(videoJsPath, "utf8");

  assert.match(js, /promptRichInput\.addEventListener\('paste',/);
  assert.match(js, /normalizePromptRichInputTokens\(false\);/);
});
