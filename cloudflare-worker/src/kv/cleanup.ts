import type { Env } from "../env";
import { DEFAULT_CURRENT_CONFIG, getCurrentConfigSection } from "../currentConfig";
import { nowMs } from "../utils/time";
import { deleteCacheRows, getCacheSizeBytes, listOldestRows } from "../repo/cache";

function parseIntSafe(v: string | undefined, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

async function deleteKeys(env: Env, keys: string[]): Promise<void> {
  if (!keys.length) return;
  await Promise.all(keys.map((k) => env.KV_CACHE.delete(k)));
  await deleteCacheRows(env.DB, keys);
}

function resolveLimitBytes(env: Env, cacheConfig: Record<string, unknown>): number {
  const limitMb = Number(cacheConfig.limit_mb);
  if (Number.isFinite(limitMb) && limitMb > 0) {
    return Math.floor(limitMb * 1024 * 1024);
  }

  const envLimitBytes = Number(env.KV_CACHE_MAX_BYTES);
  if (Number.isFinite(envLimitBytes) && envLimitBytes > 0) {
    return Math.floor(envLimitBytes);
  }

  return Math.floor(Number(DEFAULT_CURRENT_CONFIG.cache.limit_mb ?? 512) * 1024 * 1024);
}

export async function runKvDailyClear(env: Env): Promise<{ deleted: number }> {
  const cacheConfig = await getCurrentConfigSection(env, "cache").catch(() => DEFAULT_CURRENT_CONFIG.cache);
  if (cacheConfig.enable_auto_clean === false) {
    return { deleted: 0 };
  }

  const batch = Math.min(500, Math.max(1, parseIntSafe(env.KV_CLEANUP_BATCH, 200)));
  const limitBytes = resolveLimitBytes(env, cacheConfig);
  let currentBytes = (await getCacheSizeBytes(env.DB)).total;
  if (currentBytes <= limitBytes) {
    return { deleted: 0 };
  }

  let deleted = 0;
  for (let i = 0; i < 200 && currentBytes > limitBytes; i++) {
    const rows = await listOldestRows(env.DB, null, null, batch);
    if (!rows.length) break;
    const keys: string[] = [];
    let reclaimedBytes = 0;
    for (const row of rows) {
      keys.push(row.key);
      reclaimedBytes += Number(row.size ?? 0);
      if (currentBytes - reclaimedBytes <= limitBytes) break;
    }
    await deleteKeys(env, keys);
    deleted += keys.length;
    currentBytes = Math.max(0, currentBytes - reclaimedBytes);
    if (rows.length < batch) break;
  }

  return { deleted };
}

export function nextLocalMidnightExpirationSeconds(now = nowMs(), tzOffsetMinutes: number): number {
  const offsetMs = tzOffsetMinutes * 60 * 1000;
  const local = new Date(now + offsetMs);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const day = local.getUTCDate();
  const next = Date.UTC(year, month, day + 1, 0, 0, 0);
  // Convert local-midnight back to UTC epoch seconds
  return Math.floor((next - offsetMs) / 1000);
}

