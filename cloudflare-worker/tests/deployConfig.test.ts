import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const workerRoot = path.resolve(import.meta.dirname, "..");

test("cloudflare connected builds deploy without remote D1 migrations", async () => {
  const packageJsonPath = path.join(workerRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    scripts?: Record<string, string>;
  };

  assert.equal(packageJson.scripts?.deploy, "wrangler deploy");
  assert.equal(packageJson.scripts?.["deploy:local"], "npm run build && npm run deploy");
  assert.match(packageJson.scripts?.build ?? "", /sync-assets/);
  assert.doesNotMatch(packageJson.scripts?.deploy ?? "", /migrations apply/i);
});

test("wrangler config matches the connected build worker name", async () => {
  const wranglerTomlPath = path.join(workerRoot, "wrangler.toml");
  const wranglerToml = await readFile(wranglerTomlPath, "utf8");

  assert.match(wranglerToml, /^name = "grok2api-ocf"$/m);
});
