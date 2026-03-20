import assert from "node:assert/strict";
import test from "node:test";

import { runKvDailyClear } from "../src/kv/cleanup.ts";

interface CacheRow {
  key: string;
  type: "image" | "video";
  size: number;
  last_access_at: number;
}

function createCleanupEnv(args: {
  cacheConfig: Record<string, unknown>;
  rows: CacheRow[];
}) {
  const settings = new Map<string, string>([
    ["cache", JSON.stringify(args.cacheConfig)],
  ]);
  const rows = [...args.rows];
  const deletedKeys: string[] = [];

  const db: D1Database = {
    prepare(sql: string) {
      let params: unknown[] = [];
      return {
        bind(...bound: unknown[]) {
          params = bound;
          return this;
        },
        first<T>() {
          if (sql === "SELECT value FROM settings WHERE key = ?") {
            const key = String(params[0] ?? "");
            const value = settings.get(key);
            return Promise.resolve(value ? ({ value } as T) : null);
          }
          return Promise.resolve(null);
        },
        all<T>() {
          if (sql.includes("SELECT key, value FROM settings WHERE key IN")) {
            return Promise.resolve({
              results: [...settings.entries()].map(([key, value]) => ({ key, value })) as T[],
            });
          }
          if (sql === "SELECT type, COALESCE(SUM(size),0) as bytes FROM kv_cache GROUP BY type") {
            const grouped = new Map<string, number>();
            for (const row of rows) {
              grouped.set(row.type, (grouped.get(row.type) ?? 0) + row.size);
            }
            return Promise.resolve({
              results: [...grouped.entries()].map(([type, bytes]) => ({ type, bytes })) as T[],
            });
          }
          if (sql === "SELECT key,type,size,last_access_at FROM kv_cache ORDER BY last_access_at ASC LIMIT ?") {
            const limit = Number(params[0] ?? 0);
            return Promise.resolve({
              results: [...rows]
                .sort((left, right) => left.last_access_at - right.last_access_at)
                .slice(0, limit) as T[],
            });
          }
          return Promise.resolve({ results: [] as T[] });
        },
        run() {
          if (sql.startsWith("DELETE FROM kv_cache WHERE key IN")) {
            const keys = params.map((item) => String(item ?? ""));
            deletedKeys.push(...keys);
            for (const key of keys) {
              const index = rows.findIndex((row) => row.key === key);
              if (index >= 0) rows.splice(index, 1);
            }
          }
          return Promise.resolve({ success: true });
        },
      };
    },
    batch() {
      return Promise.resolve([]);
    },
  } as any;

  const kvDeletes: string[] = [];
  const env = {
    DB: db,
    KV_CACHE: {
      delete(key: string) {
        kvDeletes.push(key);
        return Promise.resolve();
      },
    },
    KV_CLEANUP_BATCH: "10",
  } as any;

  return { env, deletedKeys, kvDeletes, rows };
}

test("runKvDailyClear respects cache.enable_auto_clean", async () => {
  const { env, deletedKeys, kvDeletes, rows } = createCleanupEnv({
    cacheConfig: { enable_auto_clean: false, limit_mb: 1 },
    rows: [
      { key: "image/a", type: "image", size: 2 * 1024 * 1024, last_access_at: 1 },
    ],
  });

  const result = await runKvDailyClear(env);

  assert.deepEqual(result, { deleted: 0 });
  assert.deepEqual(deletedKeys, []);
  assert.deepEqual(kvDeletes, []);
  assert.equal(rows.length, 1);
});

test("runKvDailyClear trims cache down to cache.limit_mb instead of deleting everything", async () => {
  const { env, deletedKeys, kvDeletes, rows } = createCleanupEnv({
    cacheConfig: { enable_auto_clean: true, limit_mb: 3 },
    rows: [
      { key: "image/oldest", type: "image", size: 2 * 1024 * 1024, last_access_at: 1 },
      { key: "image/newer", type: "image", size: 2 * 1024 * 1024, last_access_at: 2 },
      { key: "video/latest", type: "video", size: 1 * 1024 * 1024, last_access_at: 3 },
    ],
  });

  const result = await runKvDailyClear(env);

  assert.deepEqual(result, { deleted: 1 });
  assert.deepEqual(deletedKeys, ["image/oldest"]);
  assert.deepEqual(kvDeletes, ["image/oldest"]);
  assert.deepEqual(
    rows.map((row) => row.key),
    ["image/newer", "video/latest"],
  );
});
