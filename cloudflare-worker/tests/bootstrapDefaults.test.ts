import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CURRENT_CONFIG } from "../src/currentConfig.ts";

test("seeds current config defaults with an admin app key for first login", () => {
  assert.equal(DEFAULT_CURRENT_CONFIG.app.app_key, "admin");
  assert.equal(DEFAULT_CURRENT_CONFIG.app.function_enabled, false);
  assert.equal(DEFAULT_CURRENT_CONFIG.app.function_key, "");
  assert.equal(DEFAULT_CURRENT_CONFIG.token.consumed_mode_enabled, false);
  assert.equal(DEFAULT_CURRENT_CONFIG.video.enable_public_asset, false);
});

test("keeps current repo config sections required by the admin config page", () => {
  for (const key of [
    "app",
    "proxy",
    "retry",
    "token",
    "cache",
    "chat",
    "image",
    "imagine_fast",
    "video",
    "voice",
    "asset",
    "nsfw",
    "usage",
  ]) {
    assert.ok(key in DEFAULT_CURRENT_CONFIG);
  }
});
