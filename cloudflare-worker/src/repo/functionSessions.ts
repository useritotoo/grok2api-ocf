import { dbAll, dbFirst, dbRun } from "../db";
import type { Env } from "../env";

export type FunctionSessionKind = "imagine" | "video";

export interface FunctionSessionRecord<TPayload = Record<string, unknown>> {
  task_id: string;
  kind: FunctionSessionKind;
  payload: TPayload;
  created_at: number;
  expires_at: number;
}

interface FunctionSessionRow {
  task_id: string;
  kind: FunctionSessionKind;
  payload: string;
  created_at: number;
  expires_at: number;
}

function parsePayload<TPayload>(payload: string): TPayload {
  try {
    return JSON.parse(payload) as TPayload;
  } catch {
    return {} as TPayload;
  }
}

export async function deleteExpiredFunctionSessions(
  db: Env["DB"],
  now = Date.now(),
): Promise<void> {
  await dbRun(db, "DELETE FROM function_sessions WHERE expires_at <= ?", [now]);
}

export async function upsertFunctionSession<TPayload>(
  db: Env["DB"],
  args: FunctionSessionRecord<TPayload>,
): Promise<void> {
  await deleteExpiredFunctionSessions(db);
  await dbRun(
    db,
    "INSERT INTO function_sessions(task_id, kind, payload, created_at, expires_at) VALUES(?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET kind=excluded.kind, payload=excluded.payload, created_at=excluded.created_at, expires_at=excluded.expires_at",
    [
      args.task_id,
      args.kind,
      JSON.stringify(args.payload ?? {}),
      args.created_at,
      args.expires_at,
    ],
  );
}

export async function getFunctionSession<TPayload>(
  db: Env["DB"],
  taskId: string,
  kind?: FunctionSessionKind,
): Promise<FunctionSessionRecord<TPayload> | null> {
  await deleteExpiredFunctionSessions(db);
  const row = await dbFirst<FunctionSessionRow>(
    db,
    kind
      ? "SELECT task_id, kind, payload, created_at, expires_at FROM function_sessions WHERE task_id = ? AND kind = ?"
      : "SELECT task_id, kind, payload, created_at, expires_at FROM function_sessions WHERE task_id = ?",
    kind ? [taskId, kind] : [taskId],
  );
  if (!row) return null;
  return {
    task_id: row.task_id,
    kind: row.kind,
    payload: parsePayload<TPayload>(row.payload),
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

export async function deleteFunctionSessions(
  db: Env["DB"],
  taskIds: string[],
  kind?: FunctionSessionKind,
): Promise<number> {
  const cleaned = taskIds.map((item) => item.trim()).filter(Boolean);
  if (!cleaned.length) return 0;
  const placeholders = cleaned.map(() => "?").join(",");
  const params = kind ? [kind, ...cleaned] : cleaned;
  const countRow = await dbFirst<{ c: number }>(
    db,
    kind
      ? `SELECT COUNT(1) AS c FROM function_sessions WHERE kind = ? AND task_id IN (${placeholders})`
      : `SELECT COUNT(1) AS c FROM function_sessions WHERE task_id IN (${placeholders})`,
    params,
  );
  await dbRun(
    db,
    kind
      ? `DELETE FROM function_sessions WHERE kind = ? AND task_id IN (${placeholders})`
      : `DELETE FROM function_sessions WHERE task_id IN (${placeholders})`,
    params,
  );
  return Number(countRow?.c ?? 0);
}

export async function listFunctionSessions(
  db: Env["DB"],
  kind?: FunctionSessionKind,
): Promise<Array<FunctionSessionRecord<Record<string, unknown>>>> {
  await deleteExpiredFunctionSessions(db);
  const rows = await dbAll<FunctionSessionRow>(
    db,
    kind
      ? "SELECT task_id, kind, payload, created_at, expires_at FROM function_sessions WHERE kind = ? ORDER BY created_at DESC"
      : "SELECT task_id, kind, payload, created_at, expires_at FROM function_sessions ORDER BY created_at DESC",
    kind ? [kind] : [],
  );
  return rows.map((row) => ({
    task_id: row.task_id,
    kind: row.kind,
    payload: parsePayload(row.payload),
    created_at: row.created_at,
    expires_at: row.expires_at,
  }));
}
