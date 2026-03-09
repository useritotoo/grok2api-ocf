import assert from "node:assert/strict";
import test from "node:test";

import { splitSqlStatements } from "../src/schema.ts";

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
