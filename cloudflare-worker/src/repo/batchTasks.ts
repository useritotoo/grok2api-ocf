import { dbFirst, dbRun } from "../db";
import type { Env } from "../env";

export type BatchTaskStatus = "running" | "completed" | "cancelled" | "error";

export interface BatchTaskSnapshot {
  task_id: string;
  kind: string;
  status: BatchTaskStatus;
  total: number;
  processed: number;
  success: number;
  failed: number;
  cancelled: boolean;
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

interface BatchTaskRow {
  task_id: string;
  kind: string;
  status: BatchTaskStatus;
  total: number;
  processed: number;
  success: number;
  failed: number;
  cancelled: number;
  result: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore parse errors
  }
  return null;
}

function toSnapshot(row: BatchTaskRow | null): BatchTaskSnapshot | null {
  if (!row) return null;
  return {
    task_id: row.task_id,
    kind: row.kind,
    status: row.status,
    total: row.total,
    processed: row.processed,
    success: row.success,
    failed: row.failed,
    cancelled: Boolean(row.cancelled),
    result: parseJsonObject(row.result),
    error: row.error,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
  };
}

export async function deleteExpiredBatchTasks(
  db: Env["DB"],
  now = Date.now(),
): Promise<void> {
  await dbRun(db, "DELETE FROM batch_tasks WHERE expires_at <= ?", [now]);
}

export async function createBatchTask(
  db: Env["DB"],
  args: { kind: string; total: number; ttlMs?: number },
): Promise<BatchTaskSnapshot> {
  await deleteExpiredBatchTasks(db);
  const now = Date.now();
  const ttlMs = Math.max(60_000, Number(args.ttlMs ?? 5 * 60 * 1000));
  const taskId = crypto.randomUUID().replaceAll("-", "");
  await dbRun(
    db,
    "INSERT INTO batch_tasks(task_id, kind, status, total, processed, success, failed, cancelled, result, error, created_at, updated_at, expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [
      taskId,
      args.kind,
      "running",
      Math.max(0, Math.floor(Number(args.total || 0))),
      0,
      0,
      0,
      0,
      null,
      null,
      now,
      now,
      now + ttlMs,
    ],
  );
  const task = await getBatchTask(db, taskId);
  if (!task) throw new Error("Failed to create batch task");
  return task;
}

export async function getBatchTask(
  db: Env["DB"],
  taskId: string,
): Promise<BatchTaskSnapshot | null> {
  await deleteExpiredBatchTasks(db);
  const row = await dbFirst<BatchTaskRow>(
    db,
    "SELECT task_id, kind, status, total, processed, success, failed, cancelled, result, error, created_at, updated_at, expires_at FROM batch_tasks WHERE task_id = ?",
    [taskId],
  );
  return toSnapshot(row);
}

export async function updateBatchTaskProgress(
  db: Env["DB"],
  taskId: string,
  args: { processed: number; success: number; failed: number },
): Promise<void> {
  const now = Date.now();
  await dbRun(
    db,
    "UPDATE batch_tasks SET processed = ?, success = ?, failed = ?, updated_at = ? WHERE task_id = ?",
    [
      Math.max(0, Math.floor(Number(args.processed || 0))),
      Math.max(0, Math.floor(Number(args.success || 0))),
      Math.max(0, Math.floor(Number(args.failed || 0))),
      now,
      taskId,
    ],
  );
}

export async function finishBatchTask(
  db: Env["DB"],
  taskId: string,
  args: {
    status: Exclude<BatchTaskStatus, "running">;
    processed?: number;
    success?: number;
    failed?: number;
    result?: Record<string, unknown> | null;
    error?: string | null;
  },
): Promise<void> {
  const current = await getBatchTask(db, taskId);
  if (!current) return;
  const now = Date.now();
  await dbRun(
    db,
    "UPDATE batch_tasks SET status = ?, processed = ?, success = ?, failed = ?, result = ?, error = ?, updated_at = ? WHERE task_id = ?",
    [
      args.status,
      Math.max(0, Math.floor(Number(args.processed ?? current.processed))),
      Math.max(0, Math.floor(Number(args.success ?? current.success))),
      Math.max(0, Math.floor(Number(args.failed ?? current.failed))),
      args.result ? JSON.stringify(args.result) : null,
      args.error ? String(args.error) : null,
      now,
      taskId,
    ],
  );
}

export async function markBatchTaskCancelled(
  db: Env["DB"],
  taskId: string,
): Promise<void> {
  await dbRun(
    db,
    "UPDATE batch_tasks SET cancelled = 1, updated_at = ? WHERE task_id = ?",
    [Date.now(), taskId],
  );
}

export async function isBatchTaskCancelled(
  db: Env["DB"],
  taskId: string,
): Promise<boolean> {
  const row = await dbFirst<{ cancelled: number }>(
    db,
    "SELECT cancelled FROM batch_tasks WHERE task_id = ?",
    [taskId],
  );
  return Boolean(row?.cancelled);
}
