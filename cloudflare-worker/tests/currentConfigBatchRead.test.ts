import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CURRENT_CONFIG, getCurrentConfig } from "../src/currentConfig.ts";

test("getCurrentConfig loads all sections from a single batched settings query", async () => {
  let batchQueryCount = 0;

  const config = await getCurrentConfig({
    DB: {
      prepare(sql: string) {
        let params: unknown[] = [];
        return {
          bind(...bound: unknown[]) {
            params = bound;
            return this;
          },
          first() {
            throw new Error(`unexpected single-row query: ${sql}`);
          },
          all<T>() {
            if (sql === "PRAGMA table_info(api_keys)") {
              return Promise.resolve({
                results: [
                  { name: "key" },
                  { name: "name" },
                  { name: "created_at" },
                  { name: "is_active" },
                  { name: "chat_limit" },
                  { name: "heavy_limit" },
                  { name: "image_limit" },
                  { name: "video_limit" },
                ] as T[],
              });
            }
            if (sql === "PRAGMA table_info(tokens)") {
              return Promise.resolve({
                results: [
                  { name: "token" },
                  { name: "token_type" },
                  { name: "created_time" },
                  { name: "remaining_queries" },
                  { name: "heavy_remaining_queries" },
                  { name: "status" },
                  { name: "failed_count" },
                  { name: "cooldown_until" },
                  { name: "last_failure_time" },
                  { name: "last_failure_reason" },
                  { name: "tags" },
                  { name: "note" },
                  { name: "last_asset_clear_at" },
                ] as T[],
              });
            }
            if (sql.startsWith("SELECT key, value FROM settings WHERE key IN (")) {
              batchQueryCount += 1;
              return Promise.resolve({
                results: (params as string[]).map((key) => ({
                  key,
                  value: JSON.stringify(DEFAULT_CURRENT_CONFIG[key as keyof typeof DEFAULT_CURRENT_CONFIG]),
                })) as T[],
              });
            }
            throw new Error(`unexpected query: ${sql}`);
          },
          run() {
            return Promise.resolve({ success: true });
          },
        };
      },
      batch(statements: Array<{ run: () => Promise<unknown> }>) {
        return Promise.all(statements.map((statement) => statement.run()));
      },
    } as any,
  } as any);

  assert.equal(batchQueryCount, 1);
  assert.equal(String(config.app.app_key ?? ""), "admin");
  assert.equal(String(config.proxy.browser ?? ""), "chrome136");
  assert.equal(Boolean(config.token.consumed_mode_enabled), false);
  assert.equal(Boolean(config.video.enable_public_asset), false);
  assert.equal(Number(config.video.concurrent ?? 0), 100);
});
