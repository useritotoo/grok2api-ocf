import { Hono } from "hono";
import { isAdminAuthorized, requireAdminAuth } from "../auth";
import { getCurrentConfig, updateCurrentConfig } from "../currentConfig";
import type { Env } from "../env";
import { checkRateLimits } from "../grok/rateLimits";
import { buildSsoCookie, getSettings } from "../settings";
import {
  createBatchTask,
  finishBatchTask,
  getBatchTask,
  isBatchTaskCancelled,
  markBatchTaskCancelled,
  updateBatchTaskProgress,
} from "../repo/batchTasks";
import { updateTokenLimits, updateTokenTags } from "../repo/tokens";
import { dbAll, dbFirst } from "../db";

function normalizeSsoToken(raw: string): string {
  const value = String(raw ?? "").trim();
  return value.startsWith("sso=") ? value.slice(4).trim() : value;
}

function collectRequestedTokens(body: Record<string, unknown>): string[] {
  const tokens: string[] = [];
  if (typeof body.token === "string") tokens.push(body.token);
  if (Array.isArray(body.tokens)) {
    tokens.push(...body.tokens.filter((item): item is string => typeof item === "string"));
  }
  return [...new Set(tokens.map(normalizeSsoToken).filter(Boolean))];
}

function maskToken(token: string): string {
  if (!token) return "";
  if (token.length <= 16) return token;
  return `${token.slice(0, 8)}...${token.slice(-8)}`;
}

async function loadTokenTypeMap(env: Env, tokens: string[]): Promise<Map<string, "sso" | "ssoSuper">> {
  if (!tokens.length) return new Map();
  const placeholders = tokens.map(() => "?").join(",");
  const rows = await dbAll<{ token: string; token_type: "sso" | "ssoSuper" }>(
    env.DB,
    `SELECT token, token_type FROM tokens WHERE token IN (${placeholders})`,
    tokens,
  );
  return new Map(rows.map((row) => [row.token, row.token_type]));
}

function resolvePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function resolvePositiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export async function runRefreshBatch(env: Env, taskId: string, tokens: string[]): Promise<void> {
  const settings = await getSettings(env);
  const usageConfig = settings.current.usage ?? {};
  const batchSize = resolvePositiveInt(usageConfig.batch_size, tokens.length || 1);
  const concurrency = resolvePositiveInt(usageConfig.concurrent, 1);
  const usageTimeoutSeconds = resolvePositiveNumber(usageConfig.timeout, 60);
  const tokenTypeMap = await loadTokenTypeMap(env, tokens);
  const results: Record<string, boolean> = {};
  let processed = 0;
  let success = 0;
  let failed = 0;

  const processOne = async (token: string): Promise<void> => {
    const cookie = buildSsoCookie(token, settings.grok);
    const tokenType = tokenTypeMap.get(token) ?? "sso";
    let ok = false;

    try {
      const normal = await checkRateLimits(cookie, settings.grok, "grok-4", usageTimeoutSeconds);
      const remaining = Number((normal as Record<string, unknown> | null)?.remainingTokens ?? NaN);
      let heavyRemaining: number | null = null;

      if (tokenType === "ssoSuper") {
        const heavy = await checkRateLimits(cookie, settings.grok, "grok-4-heavy", usageTimeoutSeconds);
        const value = Number((heavy as Record<string, unknown> | null)?.remainingTokens ?? NaN);
        if (Number.isFinite(value)) heavyRemaining = value;
      }

      if (Number.isFinite(remaining)) {
        await updateTokenLimits(env.DB, token, {
          remaining_queries: remaining,
          ...(heavyRemaining !== null ? { heavy_remaining_queries: heavyRemaining } : {}),
        });
        ok = true;
      }
    } catch {
      ok = false;
    }

    results[`sso=${token}`] = ok;
    processed += 1;
    if (ok) success += 1;
    else failed += 1;
    await updateBatchTaskProgress(env.DB, taskId, { processed, success, failed });
  };

  for (let start = 0; start < tokens.length; start += batchSize) {
    if (await isBatchTaskCancelled(env.DB, taskId)) {
      await finishBatchTask(env.DB, taskId, { status: "cancelled", processed, success, failed });
      return;
    }

    const batch = tokens.slice(start, start + batchSize);
    let nextIndex = 0;
    let cancelled = false;

    const workers = Array.from({ length: Math.min(concurrency, batch.length) }, async () => {
      while (nextIndex < batch.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        const token = batch[currentIndex];
        if (!token) continue;
        if (await isBatchTaskCancelled(env.DB, taskId)) {
          cancelled = true;
          return;
        }
        await processOne(token);
      }
    });

    await Promise.all(workers);
    if (cancelled) {
      await finishBatchTask(env.DB, taskId, { status: "cancelled", processed, success, failed });
      return;
    }
  }

  await finishBatchTask(env.DB, taskId, {
    status: "completed",
    processed,
    success,
    failed,
    result: {
      status: "success",
      summary: { total: tokens.length, ok: success, fail: failed },
      results,
    },
  });
}

async function runNsfwBatch(env: Env, taskId: string, tokens: string[]): Promise<void> {
  const tokenTypeMap = await loadTokenTypeMap(env, tokens);
  const results: Record<string, Record<string, unknown>> = {};
  let processed = 0;
  let success = 0;
  let failed = 0;

  for (const token of tokens) {
    if (await isBatchTaskCancelled(env.DB, taskId)) {
      await finishBatchTask(env.DB, taskId, { status: "cancelled", processed, success, failed });
      return;
    }

    const tokenType = tokenTypeMap.get(token);
    if (!tokenType) {
      results[maskToken(token)] = { error: "Token not found" };
      processed += 1;
      failed += 1;
      await updateBatchTaskProgress(env.DB, taskId, { processed, success, failed });
      continue;
    }

    const row = await dbFirst<{ tags: string }>(env.DB, "SELECT tags FROM tokens WHERE token = ?", [token]);
    let tags: string[] = [];
    if (row?.tags) {
      try {
        const parsed = JSON.parse(row.tags) as unknown;
        if (Array.isArray(parsed)) {
          tags = parsed.map((item) => String(item ?? "").trim()).filter(Boolean);
        }
      } catch {
        tags = [];
      }
    }

    if (!tags.includes("nsfw")) tags.push("nsfw");
    await updateTokenTags(env.DB, token, tokenType, tags);
    results[maskToken(token)] = { success: true, tags };
    processed += 1;
    success += 1;
    await updateBatchTaskProgress(env.DB, taskId, { processed, success, failed });
  }

  await finishBatchTask(env.DB, taskId, {
    status: "completed",
    processed,
    success,
    failed,
    result: {
      status: "success",
      summary: { total: tokens.length, ok: success, fail: failed },
      results,
    },
  });
}

function batchEventFromTask(task: NonNullable<Awaited<ReturnType<typeof getBatchTask>>>): Record<string, unknown> {
  return {
    task_id: task.task_id,
    kind: task.kind,
    status: task.status,
    total: task.total,
    processed: task.processed,
    success: task.success,
    failed: task.failed,
    updated_at: task.updated_at,
  };
}

async function handleBatchStream(c: any) {
  const token = String(c.req.query("app_key") ?? "").trim() || null;
  const authorized = await isAdminAuthorized(c.env, token);
  if (!authorized) {
    return c.json({ error: "Invalid authentication token", code: "INVALID_APP_KEY" }, 401);
  }

  const taskId = c.req.param("task_id");
  const initial = await getBatchTask(c.env.DB, taskId);
  if (!initial) {
    return c.json({ error: "Task not found", code: "TASK_NOT_FOUND" }, 404);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let lastUpdatedAt = 0;
      while (true) {
        const task = await getBatchTask(c.env.DB, taskId);
        if (!task) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", error: "Task not found" })}\n\n`));
          controller.close();
          return;
        }

        if (lastUpdatedAt === 0) {
          lastUpdatedAt = task.updated_at;
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "snapshot", ...batchEventFromTask(task) })}\n\n`),
          );
        } else if (task.updated_at !== lastUpdatedAt) {
          lastUpdatedAt = task.updated_at;
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "progress", ...batchEventFromTask(task) })}\n\n`),
          );
        } else {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        }

        if (task.status === "completed") {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "done", ...batchEventFromTask(task), result: task.result })}\n\n`,
            ),
          );
          controller.close();
          return;
        }
        if (task.status === "cancelled") {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "cancelled", ...batchEventFromTask(task) })}\n\n`),
          );
          controller.close();
          return;
        }
        if (task.status === "error") {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "error", ...batchEventFromTask(task), error: task.error ?? "Batch failed" })}\n\n`,
            ),
          );
          controller.close();
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-store, must-revalidate",
      connection: "keep-alive",
    },
  });
}

async function handleRefreshAsync(c: any) {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const tokens = collectRequestedTokens(body);
  if (!tokens.length) {
    return c.json({ status: "error", detail: "No tokens provided" }, 400);
  }

  const task = await createBatchTask(c.env.DB, { kind: "tokens_refresh", total: tokens.length });
  c.executionCtx.waitUntil(runRefreshBatch(c.env, task.task_id, tokens));
  return c.json({ status: "success", task_id: task.task_id, total: tokens.length });
}

async function handleEnableNsfwAsync(c: any) {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const tokens = collectRequestedTokens(body);
  if (!tokens.length) {
    return c.json({ status: "error", detail: "No tokens provided" }, 400);
  }

  const task = await createBatchTask(c.env.DB, { kind: "tokens_nsfw", total: tokens.length });
  c.executionCtx.waitUntil(runNsfwBatch(c.env, task.task_id, tokens));
  return c.json({ status: "success", task_id: task.task_id, total: tokens.length });
}

export const currentAdminRoutes = new Hono<{ Bindings: Env }>();

currentAdminRoutes.get("/v1/admin/verify", requireAdminAuth, (c) => c.json({ status: "success" }));
currentAdminRoutes.get("/api/v1/admin/verify", requireAdminAuth, (c) => c.json({ status: "success" }));

currentAdminRoutes.get("/v1/admin/storage", requireAdminAuth, (c) => c.json({ type: "d1" }));
currentAdminRoutes.get("/api/v1/admin/storage", requireAdminAuth, (c) => c.json({ type: "d1" }));

currentAdminRoutes.get("/v1/admin/config", requireAdminAuth, async (c) => c.json(await getCurrentConfig(c.env)));
currentAdminRoutes.get("/api/v1/admin/config", requireAdminAuth, async (c) => c.json(await getCurrentConfig(c.env)));

currentAdminRoutes.post("/v1/admin/config", requireAdminAuth, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<Awaited<ReturnType<typeof getCurrentConfig>>>;
  await updateCurrentConfig(c.env, body);
  return c.json({ status: "success", message: "Config updated" });
});
currentAdminRoutes.post("/api/v1/admin/config", requireAdminAuth, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<Awaited<ReturnType<typeof getCurrentConfig>>>;
  await updateCurrentConfig(c.env, body);
  return c.json({ status: "success", message: "Config updated" });
});

currentAdminRoutes.post("/v1/admin/tokens/refresh/async", requireAdminAuth, handleRefreshAsync);
currentAdminRoutes.post("/api/v1/admin/tokens/refresh/async", requireAdminAuth, handleRefreshAsync);

currentAdminRoutes.post("/v1/admin/tokens/nsfw/enable/async", requireAdminAuth, handleEnableNsfwAsync);
currentAdminRoutes.post("/api/v1/admin/tokens/nsfw/enable/async", requireAdminAuth, handleEnableNsfwAsync);

currentAdminRoutes.get("/v1/admin/batch/:task_id/stream", handleBatchStream);
currentAdminRoutes.get("/api/v1/admin/batch/:task_id/stream", handleBatchStream);

currentAdminRoutes.post("/v1/admin/batch/:task_id/cancel", requireAdminAuth, async (c) => {
  const taskId = c.req.param("task_id");
  const task = await getBatchTask(c.env.DB, taskId);
  if (!task) return c.json({ error: "Task not found", code: "TASK_NOT_FOUND" }, 404);
  await markBatchTaskCancelled(c.env.DB, taskId);
  return c.json({ status: "success" });
});
currentAdminRoutes.post("/api/v1/admin/batch/:task_id/cancel", requireAdminAuth, async (c) => {
  const taskId = c.req.param("task_id");
  const task = await getBatchTask(c.env.DB, taskId);
  if (!task) return c.json({ error: "Task not found", code: "TASK_NOT_FOUND" }, 404);
  await markBatchTaskCancelled(c.env.DB, taskId);
  return c.json({ status: "success" });
});
