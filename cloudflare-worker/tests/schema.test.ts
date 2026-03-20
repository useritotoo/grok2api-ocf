import assert from "node:assert/strict";
import test from "node:test";

import { ensureDbSchema, splitSqlStatements } from "../src/schema.ts";

test("keeps a multiline CREATE TABLE statement intact", () => {
  const statements = splitSqlStatements(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

  assert.equal(statements.length, 1);
  assert.match(statements[0]!, /CREATE TABLE IF NOT EXISTS settings \(/);
  assert.match(statements[0]!, /value TEXT NOT NULL/);
});

test("does not split semicolons inside quoted strings", () => {
  const statements = splitSqlStatements(`
INSERT INTO settings(key, value) VALUES ('proxy', '{"user_agent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7); Chrome"}');
CREATE INDEX IF NOT EXISTS idx_settings_key ON settings(key);
`);

  assert.equal(statements.length, 2);
  assert.match(statements[0]!, /Macintosh; Intel Mac OS X 10_15_7/);
  assert.match(statements[1]!, /CREATE INDEX IF NOT EXISTS idx_settings_key/);
});

test("ensureDbSchema adds the consumed column when missing", async () => {
  const executed: string[] = [];
  const db: D1Database = {
    prepare(sql: string) {
      executed.push(sql);
      return {
        bind() {
          return this;
        },
        first<T>() {
          return Promise.resolve(null as T | null);
        },
        all<T>() {
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
          return Promise.resolve({ results: [] as T[] });
        },
        run() {
          return Promise.resolve({ success: true });
        },
      };
    },
    batch(statements: any[]) {
      for (const statement of statements) {
        if (statement && typeof statement === "object" && "statement" in statement) {
          executed.push(String((statement as { statement: string }).statement));
        }
      }
      return Promise.resolve([]);
    },
  } as any;

  await ensureDbSchema(db);

  assert.ok(
    executed.some((sql) => sql.includes("ALTER TABLE tokens ADD COLUMN consumed INTEGER")),
    executed.join("\n"),
  );
});
