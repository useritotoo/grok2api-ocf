import type { GrokSettings } from "../settings";
import { getDynamicHeaders } from "./headers";
import { toRateLimitModel } from "./models";

const RATE_LIMIT_API = "https://grok.com/rest/rate-limits";

function withTimeout(init: RequestInit, timeoutSeconds?: number | null): RequestInit {
  const normalizedSeconds = Number(timeoutSeconds);
  if (
    !Number.isFinite(normalizedSeconds)
    || normalizedSeconds <= 0
    || typeof AbortSignal === "undefined"
    || typeof AbortSignal.timeout !== "function"
  ) {
    return init;
  }
  return { ...init, signal: AbortSignal.timeout(Math.floor(normalizedSeconds * 1000)) };
}

export async function checkRateLimits(
  cookie: string,
  settings: GrokSettings,
  model: string,
  timeoutSeconds?: number | null,
): Promise<Record<string, unknown> | null> {
  const rateModel = toRateLimitModel(model);
  const headers = getDynamicHeaders(settings, "/rest/rate-limits");
  headers.Cookie = cookie;
  const body = JSON.stringify({ requestKind: "DEFAULT", modelName: rateModel });

  const resp = await fetch(RATE_LIMIT_API, withTimeout({ method: "POST", headers, body }, timeoutSeconds));
  if (!resp.ok) return null;
  return (await resp.json()) as Record<string, unknown>;
}

