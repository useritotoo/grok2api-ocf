import type { Env } from "./env";
import { ensureDbSchema } from "./schema";

export async function dbFirst<T>(
  db: Env["DB"],
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  await ensureDbSchema(db);
  const stmt = db.prepare(sql).bind(...params);
  const row = await stmt.first<T>();
  return row ?? null;
}

export async function dbAll<T>(
  db: Env["DB"],
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  await ensureDbSchema(db);
  const stmt = db.prepare(sql).bind(...params);
  const res = await stmt.all<T>();
  return res.results ?? [];
}

export async function dbRun(
  db: Env["DB"],
  sql: string,
  params: unknown[] = [],
): Promise<void> {
  await ensureDbSchema(db);
  const stmt = db.prepare(sql).bind(...params);
  await stmt.run();
}

