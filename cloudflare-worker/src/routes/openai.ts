import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "../env";
import { requireApiAuth, requireModelAuth } from "../auth";
import { buildSsoCookie, getSettings } from "../settings";
import { isValidModel, MODEL_CONFIG } from "../grok/models";
import {
  extractContent,
  buildConversationPayload,
  prepareVideoReferencePrompt,
  sendConversationRequest,
} from "../grok/conversation";
import { uploadAttachment, uploadImage, type AssetTransferConfig } from "../grok/upload";
import { getDynamicHeaders } from "../grok/headers";
import { createMediaPost } from "../grok/create";
import { createOpenAiStreamFromGrokNdjson, parseOpenAiFromGrokNdjson } from "../grok/processor";
import { buildVideoGenerationPlan, publicizeVideoUrl, upscaleVideoUrl } from "../grok/video";
import {
  IMAGE_METHOD_IMAGINE_WS_EXPERIMENTAL,
  ImagineWsError,
  collectImagineWsImages,
  resolveAspectRatio,
  resolveImageGenerationMethod,
  sendExperimentalImageEditRequest,
} from "../grok/imagineExperimental";
import { addRequestLog } from "../repo/logs";
import { applyCooldown, recordTokenFailure, selectBestToken } from "../repo/tokens";
import type { ApiAuthInfo } from "../auth";
import { getApiKeyLimits } from "../repo/apiKeys";
import { localDayString, tryConsumeDailyUsage, tryConsumeDailyUsageMulti } from "../repo/apiKeyUsage";
import { nextLocalMidnightExpirationSeconds } from "../kv/cleanup";
import { nowMs } from "../utils/time";
import { arrayBufferToBase64 } from "../utils/base64";
import { upsertCacheRow } from "../repo/cache";
import { consumeNdjsonObjects } from "../utils/ndjson";

function openAiError(message: string, code: string): Record<string, unknown> {
  return { error: { message, type: "invalid_request_error", code } };
}

function getClientIp(req: Request): string {
  return (
    req.headers.get("CF-Connecting-IP") ||
    req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "0.0.0.0"
  );
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (!items.length) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(Math.floor(limit || 1), items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) break;
      results[currentIndex] = await fn(items[currentIndex] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

async function runTasksSettledWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  if (!items.length) return [];
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(Math.floor(limit || 1), items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const idx = nextIndex++;
      if (idx >= items.length) break;
      try {
        const value = await fn(items[idx] as T);
        results[idx] = { status: "fulfilled", value };
      } catch (reason) {
        results[idx] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export const openAiRoutes = new Hono<{ Bindings: Env; Variables: { apiAuth: ApiAuthInfo } }>();

openAiRoutes.use(
  "/*",
  cors({
    origin: "*",
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    maxAge: 86400,
  }),
);

function buildModelPayload(id: string) {
  const cfg = MODEL_CONFIG[id]!;
  return {
    id,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "x-ai",
    display_name: cfg.display_name,
    description: cfg.description,
    raw_model_path: cfg.raw_model_path,
    default_temperature: cfg.default_temperature,
    default_max_output_tokens: cfg.default_max_output_tokens,
    supported_max_output_tokens: cfg.supported_max_output_tokens,
    default_top_p: cfg.default_top_p,
  };
}

export interface OpenAiHandlerArgs {
  request: Request;
  env: Env;
  apiAuth: ApiAuthInfo;
}

function createOpenAiHandlerContext(args: OpenAiHandlerArgs) {
  return {
    env: args.env,
    req: {
      raw: args.request,
      url: args.request.url,
      json: () => args.request.json(),
      formData: () => args.request.formData(),
    },
    get(_key: "apiAuth") {
      return args.apiAuth;
    },
    json(payload: unknown, status = 200) {
      return Response.json(payload, { status });
    },
  };
}

export function createModelListResponse(): Response {
  const data = Object.keys(MODEL_CONFIG).map((id) => buildModelPayload(id));
  return Response.json({ object: "list", data });
}

export function createModelDetailResponse(modelId: string): Response {
  if (!isValidModel(modelId)) {
    return Response.json(openAiError(`Model '${modelId}' not found`, "model_not_found"), { status: 404 });
  }
  return Response.json(buildModelPayload(modelId));
}

openAiRoutes.get("/models", requireModelAuth, async () => createModelListResponse());

openAiRoutes.get("/models/:modelId", requireModelAuth, async (c) => createModelDetailResponse(c.req.param("modelId")));

openAiRoutes.use("/*", requireApiAuth);

function parseIntSafe(v: string | undefined, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function parseRetryNumber(value: unknown, fallback: number, min = 0): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

function parseRetryCodeList(value: unknown, fallback: number[]): number[] {
  if (!Array.isArray(value)) return [...fallback];
  const normalized = value.map((item) => Number(item)).filter((item) => Number.isFinite(item));
  return normalized.length ? normalized : [...fallback];
}

function resolveRetryPolicy(retryConfig: Record<string, unknown> | null | undefined): {
  maxRetry: number;
  retryCodes: number[];
  backoffBaseMs: number;
  backoffFactor: number;
  backoffMaxMs: number;
  retryBudgetMs: number;
} {
  const maxRetry = Math.max(0, Math.floor(parseRetryNumber(retryConfig?.max_retry, 3)));
  const backoffBaseMs = Math.max(0, parseRetryNumber(retryConfig?.retry_backoff_base, 0.5) * 1000);
  const backoffFactor = Math.max(1, parseRetryNumber(retryConfig?.retry_backoff_factor, 2, 1));
  const backoffMaxMs = Math.max(
    backoffBaseMs,
    parseRetryNumber(retryConfig?.retry_backoff_max, 20) * 1000,
  );
  const retryBudgetMs = Math.max(0, parseRetryNumber(retryConfig?.retry_budget, 60) * 1000);
  const retryCodes = parseRetryCodeList(retryConfig?.retry_status_codes, [401, 429, 403]);

  return {
    maxRetry,
    retryCodes,
    backoffBaseMs,
    backoffFactor,
    backoffMaxMs,
    retryBudgetMs,
  };
}

function parseRetryAfterMs(value: string | null): number | null {
  const parsed = Number(value ?? "");
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(0, parsed * 1000);
}

function resolveTimeoutMs(value: unknown, fallbackSeconds: number): number | null {
  const parsed = Number(value);
  const safeSeconds = Number.isFinite(parsed) ? parsed : fallbackSeconds;
  if (!Number.isFinite(safeSeconds) || safeSeconds <= 0) return null;
  return Math.max(1_000, Math.floor(safeSeconds * 1000));
}

function resolveIdleTimeoutSeconds(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function resolveIdleTimeoutMs(value: unknown): number | null {
  const seconds = resolveIdleTimeoutSeconds(value);
  if (seconds === null) return null;
  return Math.max(1, Math.floor(seconds * 1000));
}

function resolveConcurrencyLimit(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return Math.max(1, Math.floor(fallback || 1));
  return Math.max(1, Math.floor(parsed));
}

function buildAssetTransferConfig(
  current: Awaited<ReturnType<typeof getSettings>>["current"],
): AssetTransferConfig {
  const asset = current.asset ?? {};
  return {
    upload_timeout: asset.upload_timeout,
    download_timeout: asset.download_timeout,
  };
}

function computeRetryDelayMs(args: {
  attempt: number;
  status: number;
  retryAfterMs: number | null;
  policy: ReturnType<typeof resolveRetryPolicy>;
}): number {
  if (args.retryAfterMs !== null) {
    return Math.min(args.retryAfterMs, args.policy.backoffMaxMs);
  }
  if (args.status === 429) {
    return Math.min(args.policy.backoffMaxMs, Math.max(args.policy.backoffBaseMs, args.policy.backoffBaseMs * 2));
  }

  const expDelay = args.policy.backoffBaseMs * args.policy.backoffFactor ** Math.max(0, args.attempt - 1);
  return Math.min(args.policy.backoffMaxMs, expDelay);
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs?: number | null,
): Promise<ReadableStreamReadResult<Uint8Array> | { timeout: true }> {
  const normalizedTimeoutMs = Number(timeoutMs);
  if (!Number.isFinite(normalizedTimeoutMs) || normalizedTimeoutMs <= 0) {
    return reader.read();
  }
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ timeout: true } as const), normalizedTimeoutMs);
    reader.read().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function resolveConversationStreamSettings(args: {
  requestedModel: string;
  current: Awaited<ReturnType<typeof getSettings>>["current"];
  grok: Awaited<ReturnType<typeof getSettings>>["grok"];
}): Awaited<ReturnType<typeof getSettings>>["grok"] {
  const resolved = { ...args.grok };
  const modelConfig = MODEL_CONFIG[args.requestedModel];
  const overrideSeconds = modelConfig?.is_video_model
    ? resolveIdleTimeoutSeconds(args.current.video?.stream_timeout)
    : resolveIdleTimeoutSeconds(args.current.chat?.stream_timeout);

  if (overrideSeconds !== null) {
    resolved.stream_chunk_timeout = overrideSeconds;
  }

  return resolved;
}

function quotaError(bucket: string): Record<string, unknown> {
  return openAiError(`Daily quota exceeded: ${bucket}`, "daily_quota_exceeded");
}

function isContentModerationMessage(message: string): boolean {
  const m = String(message || "").toLowerCase();
  return (
    m.includes("content moderated") ||
    m.includes("content-moderated") ||
    m.includes("wke=grok:content-moderated")
  );
}

async function enforceQuota(args: {
  env: Env;
  apiAuth: ApiAuthInfo;
  model: string;
  kind: "chat" | "image" | "video";
  imageCount?: number;
}): Promise<{ ok: true } | { ok: false; resp: Response }> {
  const key = args.apiAuth.key;
  if (!key) return { ok: true };
  if (args.apiAuth.is_admin) return { ok: true };

  const limits = await getApiKeyLimits(args.env.DB, key);
  if (!limits) return { ok: true };

  const tz = parseIntSafe(args.env.CACHE_RESET_TZ_OFFSET_MINUTES, 480);
  const day = localDayString(nowMs(), tz);
  const atMs = nowMs();
  const jsonHeaders = { "content-type": "application/json; charset=utf-8" };

  if (args.model === "grok-4-heavy") {
    const ok = await tryConsumeDailyUsageMulti({
      db: args.env.DB,
      key,
      day,
      atMs,
      updates: [
        { field: "heavy_used", inc: 1, limit: limits.heavy_limit },
        { field: "chat_used", inc: 1, limit: limits.chat_limit },
      ],
    });
    if (!ok) return { ok: false, resp: new Response(JSON.stringify(quotaError("heavy/chat")), { status: 429, headers: jsonHeaders }) };
    return { ok: true };
  }

  if (args.kind === "video") {
    const ok = await tryConsumeDailyUsage({
      db: args.env.DB,
      key,
      day,
      atMs,
      field: "video_used",
      inc: 1,
      limit: limits.video_limit,
    });
    if (!ok) return { ok: false, resp: new Response(JSON.stringify(quotaError("video")), { status: 429, headers: jsonHeaders }) };
    return { ok: true };
  }

  if (args.kind === "image") {
    const inc = Math.max(1, Math.floor(Number(args.imageCount ?? 1) || 1));
    const ok = await tryConsumeDailyUsage({
      db: args.env.DB,
      key,
      day,
      atMs,
      field: "image_used",
      inc,
      limit: limits.image_limit,
    });
    if (!ok) return { ok: false, resp: new Response(JSON.stringify(quotaError("image")), { status: 429, headers: jsonHeaders }) };
    return { ok: true };
  }

  // chat
  const ok = await tryConsumeDailyUsage({
    db: args.env.DB,
    key,
    day,
    atMs,
    field: "chat_used",
    inc: 1,
    limit: limits.chat_limit,
  });
  if (!ok) return { ok: false, resp: new Response(JSON.stringify(quotaError("chat")), { status: 429, headers: jsonHeaders }) };
  return { ok: true };
}

function base64UrlEncodeString(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function encodeAssetPath(raw: string): string {
  try {
    const u = new URL(raw);
    return `u_${base64UrlEncodeString(u.toString())}`;
  } catch {
    const p = raw.startsWith("/") ? raw : `/${raw}`;
    return `p_${base64UrlEncodeString(p)}`;
  }
}

function toProxyUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}/images/${path}`;
}

type ImageResponseFormat = "url" | "base64" | "b64_json";

function resolveResponseFormat(raw: unknown, defaultMode: string): ImageResponseFormat | null {
  const fallback = String(defaultMode || "url").trim().toLowerCase();
  const candidate =
    typeof raw === "string" && raw.trim() ? raw.trim().toLowerCase() : fallback;
  if (candidate === "url" || candidate === "base64" || candidate === "b64_json") {
    return candidate;
  }
  return null;
}

function responseFieldName(format: ImageResponseFormat): ImageResponseFormat {
  return format;
}

function toBool(input: unknown): boolean {
  if (typeof input === "boolean") return input;
  if (typeof input === "number") return input === 1;
  if (typeof input !== "string") return false;
  const normalized = input.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function normalizeGeneratedImageUrls(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((u): u is string => typeof u === "string")
    .map((u) => u.trim())
    .filter((u) => Boolean(u && u !== "/"));
}

function dedupeImages(images: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of images) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function pickImageResults(images: string[], n: number): string[] {
  if (images.length >= n) {
    const pool = images.slice();
    const picked: string[] = [];
    while (picked.length < n && pool.length) {
      const idx = Math.floor(Math.random() * pool.length);
      const [item] = pool.splice(idx, 1);
      if (item) picked.push(item);
    }
    return picked;
  }
  const picked = images.slice();
  while (picked.length < n) picked.push("error");
  return picked;
}

function normalizeImageMime(mime: string): string {
  const m = (mime || "").trim().toLowerCase();
  if (m === "image/jpg") return "image/jpeg";
  return m;
}

function mimeFromFilename(filename: string): string | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return null;
}

async function fetchImageAsBase64(args: {
  rawUrl: string;
  cookie: string;
  settings: Awaited<ReturnType<typeof getSettings>>["grok"];
  timeoutMs?: number | null;
}): Promise<string> {
  let url: URL;
  try {
    url = new URL(args.rawUrl);
  } catch {
    const p = args.rawUrl.startsWith("/") ? args.rawUrl : `/${args.rawUrl}`;
    url = new URL(`https://assets.grok.com${p}`);
  }

  const headers = getDynamicHeaders(args.settings, url.pathname || "/");
  headers.Cookie = args.cookie;
  delete headers["Content-Type"];
  headers.Accept = "image/avif,image/webp,image/*,*/*;q=0.8";
  headers["Sec-Fetch-Dest"] = "image";
  headers["Sec-Fetch-Mode"] = "no-cors";
  headers["Sec-Fetch-Site"] = "same-site";
  headers.Referer = "https://grok.com/";

  const resp = await fetch(
    url.toString(),
    args.timeoutMs !== null
      && args.timeoutMs !== undefined
      && typeof AbortSignal !== "undefined"
      && typeof AbortSignal.timeout === "function"
      ? { method: "GET", headers, redirect: "follow", signal: AbortSignal.timeout(args.timeoutMs) }
      : { method: "GET", headers, redirect: "follow" },
  );
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Image download failed: ${resp.status} ${txt.slice(0, 200)}`);
  }
  return arrayBufferToBase64(await resp.arrayBuffer());
}

async function convertRawUrlByFormat(
  rawUrl: string,
  responseFormat: ImageResponseFormat,
  args: {
    baseUrl: string;
    cookie: string;
    settings: Awaited<ReturnType<typeof getSettings>>["grok"];
    downloadTimeoutMs?: number | null;
  },
): Promise<string> {
  if (responseFormat === "url") {
    return toProxyUrl(args.baseUrl, encodeAssetPath(rawUrl));
  }
  return fetchImageAsBase64({
    rawUrl,
    cookie: args.cookie,
    settings: args.settings,
    timeoutMs: args.downloadTimeoutMs,
  });
}

async function convertImagineFrameByFormat(
  asset: { url: string; blob?: string },
  responseFormat: ImageResponseFormat,
  args: {
    baseUrl: string;
    cookie: string;
    settings: Awaited<ReturnType<typeof getSettings>>["grok"];
    downloadTimeoutMs?: number | null;
  },
): Promise<string> {
  if (responseFormat === "url") {
    return toProxyUrl(args.baseUrl, encodeAssetPath(asset.url));
  }
  if (asset.blob) {
    return asset.blob;
  }
  return fetchImageAsBase64({
    rawUrl: asset.url,
    cookie: args.cookie,
    settings: args.settings,
    timeoutMs: args.downloadTimeoutMs,
  });
}

async function collectImageUrls(
  resp: Response,
  maxResults = Number.POSITIVE_INFINITY,
  readTimeoutMs?: number | null,
): Promise<string[]> {
  const allUrls: string[] = [];
  await consumeNdjsonObjects(resp, async (data) => {
    const err = (data as { error?: { message?: unknown } }).error;
    if (err?.message) throw new Error(String(err.message));
    const grok = (data as { result?: { response?: any } }).result?.response;
    const urls = normalizeGeneratedImageUrls(grok?.modelResponse?.generatedImageUrls);
    if (urls.length) allUrls.push(...urls);
    return allUrls.length >= maxResults;
  }, { readTimeoutMs });
  return allUrls;
}

function imageStageProgress(stage?: string): number {
  if (stage === "final") return 100;
  if (stage === "medium") return 70;
  return 35;
}

function errorStatusCode(error: unknown): number {
  if (error instanceof ImagineWsError && typeof error.status === "number") {
    return error.status;
  }
  return 500;
}

function buildChatImageMarkdown(images: string[]): string {
  return images
    .filter(Boolean)
    .map((image) => `![Generated Image](${image})`)
    .join("\n");
}

function buildSyntheticChatCompletion(model: string, content: string): Record<string, unknown> {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: null,
  };
}

function createSyntheticChatImageStream(args: {
  model: string;
  images: string[];
  onFinish?: (result: { status: number; duration: number }) => Promise<void> | void;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  const makeChunk = (content: string, finishReason?: "stop" | null): string =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model: args.model,
      choices: [
        {
          index: 0,
          delta: content ? { role: "assistant", content } : {},
          finish_reason: finishReason ?? null,
        },
      ],
    })}\n\n`;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const startedAt = Date.now();
      try {
        for (let i = 0; i < args.images.length; i++) {
          const image = args.images[i];
          if (!image || image === "error") continue;
          const prefix = i === 0 ? "" : "\n";
          controller.enqueue(encoder.encode(makeChunk(`${prefix}![Generated Image](${image})`)));
        }
        controller.enqueue(encoder.encode(makeChunk("", "stop")));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        if (args.onFinish) {
          await args.onFinish({ status: 200, duration: (Date.now() - startedAt) / 1000 });
        }
        controller.close();
      } catch (error) {
        if (args.onFinish) {
          await args.onFinish({ status: 500, duration: (Date.now() - startedAt) / 1000 });
        }
        controller.error(error);
      }
    },
  });
}

function buildImageSse(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createImageEventStream(args: {
  upstream: Response;
  responseFormat: ImageResponseFormat;
  baseUrl: string;
  cookie: string;
  settings: Awaited<ReturnType<typeof getSettings>>["grok"];
  n: number;
  streamTimeoutMs?: number | null;
  downloadTimeoutMs?: number | null;
  onFinish?: (result: { status: number; duration: number }) => Promise<void> | void;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const responseField = responseFieldName(args.responseFormat);
  const targetIndex = args.n === 1 ? Math.floor(Math.random() * 2) : null;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const startedAt = Date.now();
      const body = args.upstream.body;
      if (!body) {
        if (args.onFinish) {
          await args.onFinish({ status: 500, duration: (Date.now() - startedAt) / 1000 });
        }
        controller.close();
        return;
      }

      const reader = body.getReader();
      const finalImages: string[] = [];
      let buffer = "";
      let failed = false;
      try {
        while (true) {
          const readResult = await readWithTimeout(reader, args.streamTimeoutMs);
          if ("timeout" in readResult) {
            break;
          }
          const { value, done } = readResult;
          if (done) break;
          if (!value) continue;
          buffer += decoder.decode(value, { stream: true });
          let idx = buffer.indexOf("\n");
          while (idx >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line) {
              idx = buffer.indexOf("\n");
              continue;
            }

            let data: any;
            try {
              data = JSON.parse(line);
            } catch {
              idx = buffer.indexOf("\n");
              continue;
            }

            const err = data?.error;
            if (err?.message) throw new Error(String(err.message));

            const resp = data?.result?.response ?? {};
            const progressInfo = resp.streamingImageGenerationResponse;
            if (progressInfo) {
              const imageIndex = Number(progressInfo.imageIndex ?? 0);
              const progress = Number(progressInfo.progress ?? 0);
              if (args.n === 1 && imageIndex !== targetIndex) {
                idx = buffer.indexOf("\n");
                continue;
              }
              const outIndex = args.n === 1 ? 0 : imageIndex;
              controller.enqueue(
                encoder.encode(
                  buildImageSse("image_generation.partial_image", {
                    type: "image_generation.partial_image",
                    [responseField]: "",
                    index: outIndex,
                    progress,
                  }),
                ),
              );
            }

            const rawUrls = normalizeGeneratedImageUrls(resp?.modelResponse?.generatedImageUrls);
            if (rawUrls.length) {
              for (const rawUrl of rawUrls) {
                const converted = await convertRawUrlByFormat(rawUrl, args.responseFormat, {
                  baseUrl: args.baseUrl,
                  cookie: args.cookie,
                  settings: args.settings,
                  downloadTimeoutMs: args.downloadTimeoutMs,
                });
                finalImages.push(converted);
              }
            }
            idx = buffer.indexOf("\n");
          }
        }

        for (let i = 0; i < finalImages.length; i++) {
          if (args.n === 1 && i !== targetIndex) continue;
          const outIndex = args.n === 1 ? 0 : i;
          controller.enqueue(
            encoder.encode(
              buildImageSse("image_generation.completed", {
                type: "image_generation.completed",
                [responseField]: finalImages[i] ?? "",
                index: outIndex,
                usage: {
                  total_tokens: 50,
                  input_tokens: 25,
                  output_tokens: 25,
                  input_tokens_details: { text_tokens: 5, image_tokens: 20 },
                },
              }),
            ),
          );
        }
        if (args.onFinish) {
          await args.onFinish({ status: 200, duration: (Date.now() - startedAt) / 1000 });
        }
      } catch (e) {
        failed = true;
        console.error("Image stream processing failed:", e);
        if (args.onFinish) {
          await args.onFinish({ status: 500, duration: (Date.now() - startedAt) / 1000 });
        }
        controller.error(e);
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // ignore
        }
        if (!failed) controller.close();
      }
    },
  });
}

function imageResponseData(field: ImageResponseFormat, values: string[]) {
  return values.map((v) => ({ [field]: v }));
}

function getTokenSuffix(token: string): string {
  return token.length >= 6 ? token.slice(-6) : token;
}

const IMAGE_GENERATION_MODEL_ID = "grok-imagine-1.0";
const IMAGE_EDIT_MODEL_ID = "grok-imagine-1.0-edit";

function parseImageCount(input: unknown): number {
  const raw = Number(input ?? 1);
  if (!Number.isFinite(raw)) return 1;
  return Math.max(1, Math.min(10, Math.floor(raw)));
}

function parseImagePrompt(input: unknown): string {
  return String(input ?? "").trim();
}

function parseImageModel(input: unknown, fallback: string): string {
  return String(input ?? fallback).trim() || fallback;
}

function parseImageStream(input: unknown): boolean {
  return toBool(input);
}

function parseImageSize(input: unknown): string {
  return String(input ?? "1024x1024").trim() || "1024x1024";
}

function parseImageConcurrencyOrError(
  input: unknown,
): { value: number } | { error: { message: string; code: string } } {
  if (input === undefined || input === null || String(input).trim() === "") {
    return { value: 1 };
  }
  const parsed = Number(input);
  if (!Number.isFinite(parsed)) {
    return {
      error: { message: "concurrency must be between 1 and 3", code: "invalid_concurrency" },
    };
  }
  const value = Math.floor(parsed);
  if (value < 1 || value > 3) {
    return {
      error: { message: "concurrency must be between 1 and 3", code: "invalid_concurrency" },
    };
  }
  return { value };
}

function parseAllowedImageMime(file: File): string | null {
  const byMime = normalizeImageMime(String(file.type || ""));
  if (byMime === "image/png" || byMime === "image/jpeg" || byMime === "image/webp") return byMime;
  const byName = mimeFromFilename(String(file.name || ""));
  if (byName) return byName;
  return null;
}

function buildCookie(token: string, settings: Awaited<ReturnType<typeof getSettings>>["grok"]): string {
  return buildSsoCookie(token, settings);
}

async function runImageCall(args: {
  requestModel: string;
  prompt: string;
  fileIds: string[];
  cookie: string;
  settings: Awaited<ReturnType<typeof getSettings>>["grok"];
  responseFormat: ImageResponseFormat;
  baseUrl: string;
  timeoutMs?: number | null;
  streamTimeoutMs?: number | null;
  downloadConcurrency?: number;
  downloadTimeoutMs?: number | null;
}): Promise<string[]> {
  const { payload, referer } = buildConversationPayload({
    requestModel: args.requestModel,
    content: args.prompt,
    fileIds: [],
    imgIds: args.fileIds,
    imgUris: [],
    settings: args.settings,
  });
  const upstream = await sendConversationRequest({
    payload,
    cookie: args.cookie,
    settings: args.settings,
    timeoutMs: args.timeoutMs,
    ...(referer ? { referer } : {}),
  });
  if (!upstream.ok) {
    const txt = await upstream.text().catch(() => "");
    throw new Error(`Upstream ${upstream.status}: ${txt.slice(0, 200)}`);
  }
  const rawUrls = await collectImageUrls(upstream, 2, args.streamTimeoutMs);
  const converted = await mapLimit(
    rawUrls,
    Math.min(rawUrls.length || 1, resolveConcurrencyLimit(args.downloadConcurrency, rawUrls.length || 1)),
    async (rawUrl) =>
      convertRawUrlByFormat(rawUrl, args.responseFormat, {
        baseUrl: args.baseUrl,
        cookie: args.cookie,
        settings: args.settings,
        downloadTimeoutMs: args.downloadTimeoutMs,
      }),
  );
  return converted.filter(Boolean);
}

async function runImageStreamCall(args: {
  requestModel: string;
  prompt: string;
  fileIds: string[];
  cookie: string;
  settings: Awaited<ReturnType<typeof getSettings>>["grok"];
  timeoutMs?: number | null;
}): Promise<Response> {
  const { payload, referer } = buildConversationPayload({
    requestModel: args.requestModel,
    content: args.prompt,
    fileIds: [],
    imgIds: args.fileIds,
    imgUris: [],
    settings: args.settings,
  });
  return sendConversationRequest({
    payload,
    cookie: args.cookie,
    settings: args.settings,
    timeoutMs: args.timeoutMs,
    ...(referer ? { referer } : {}),
  });
}

function imageGenerationMethod(settingsBundle: Awaited<ReturnType<typeof getSettings>>) {
  return resolveImageGenerationMethod(settingsBundle.grok.image_generation_method);
}

export async function collectExperimentalGenerationImages(args: {
  prompt: string;
  n: number;
  cookie: string;
  settings: Awaited<ReturnType<typeof getSettings>>["grok"];
  responseFormat: ImageResponseFormat;
  baseUrl: string;
  aspectRatio: string;
  concurrency: number;
  timeoutMs?: number | null;
  streamTimeoutMs?: number | null;
  finalTimeoutMs?: number | null;
  blockedGraceMs?: number | null;
  enableNsfw?: boolean;
  finalMinBytes?: number;
  mediumMinBytes?: number;
  blockedParallelAttempts?: number;
  blockedParallelEnabled?: boolean;
  downloadConcurrency?: number;
  downloadTimeoutMs?: number | null;
}): Promise<string[]> {
  void args.concurrency;
  const targetCount = Math.max(1, args.n);
  const attemptCount = Math.max(0, Math.floor(Number(args.blockedParallelAttempts ?? 0) || 0));
  const parallelEnabled = args.blockedParallelEnabled !== false;
  const mergedResults: string[] = [];
  const seen = new Set<string>();

  const collectOnce = async (): Promise<string[]> => {
    const images = await collectImagineWsImages({
      prompt: args.prompt,
      n: targetCount,
      cookie: args.cookie,
      settings: args.settings,
      timeoutMs: args.timeoutMs ?? undefined,
      streamTimeoutMs: args.streamTimeoutMs ?? undefined,
      finalTimeoutMs: args.finalTimeoutMs ?? undefined,
      blockedGraceMs: args.blockedGraceMs ?? undefined,
      aspectRatio: args.aspectRatio,
      enableNsfw: args.enableNsfw,
      finalMinBytes: args.finalMinBytes,
      mediumMinBytes: args.mediumMinBytes,
    });
    if (!images.length) {
      throw new Error("Experimental imagine websocket returned no images");
    }

    const converted = await mapLimit(
      images,
      Math.min(images.length || 1, resolveConcurrencyLimit(args.downloadConcurrency, images.length || 1)),
      async (image) =>
        convertImagineFrameByFormat(image, args.responseFormat, {
          baseUrl: args.baseUrl,
          cookie: args.cookie,
          settings: args.settings,
          downloadTimeoutMs: args.downloadTimeoutMs,
        }),
    );
    return dedupeImages(converted.filter(Boolean));
  };

  const mergeResults = (values: string[]) => {
    for (const value of values) {
      if (!value || seen.has(value)) continue;
      seen.add(value);
      mergedResults.push(value);
      if (mergedResults.length >= targetCount) break;
    }
  };

  let lastError: unknown = null;
  try {
    mergeResults(await collectOnce());
  } catch (error) {
    lastError = error;
  }

  if (mergedResults.length >= targetCount) {
    return mergedResults.slice(0, targetCount);
  }

  if (attemptCount > 0) {
    const attemptFactories = Array.from({ length: attemptCount }, () => collectOnce);
    const recoveryResults = parallelEnabled
      ? await Promise.allSettled(attemptFactories.map((run) => run()))
      : await (async () => {
          const sequential: PromiseSettledResult<string[]>[] = [];
          for (const run of attemptFactories) {
            try {
              sequential.push({ status: "fulfilled", value: await run() });
            } catch (error) {
              sequential.push({ status: "rejected", reason: error });
            }
            if (mergedResults.length >= targetCount) break;
          }
          return sequential;
        })();

    for (const result of recoveryResults) {
      if (result.status === "fulfilled") {
        mergeResults(result.value);
        if (mergedResults.length >= targetCount) {
          return mergedResults.slice(0, targetCount);
        }
      } else if (!lastError) {
        lastError = result.reason;
      }
    }
  }

  if (mergedResults.length >= targetCount) {
    return mergedResults.slice(0, targetCount);
  }

  if (lastError) throw lastError;
  throw new Error("Experimental imagine websocket returned insufficient images");
}

async function runExperimentalImageEditCall(args: {
  prompt: string;
  fileUris: string[];
  cookie: string;
  settings: Awaited<ReturnType<typeof getSettings>>["grok"];
  responseFormat: ImageResponseFormat;
  baseUrl: string;
  timeoutMs?: number | null;
  streamTimeoutMs?: number | null;
  downloadConcurrency?: number;
  downloadTimeoutMs?: number | null;
}): Promise<string[]> {
  const upstream = await sendExperimentalImageEditRequest({
    prompt: args.prompt,
    fileUris: args.fileUris,
    cookie: args.cookie,
    settings: args.settings,
    timeoutMs: args.timeoutMs,
  });
  const rawUrls = await collectImageUrls(upstream, 2, args.streamTimeoutMs);
  const converted = await mapLimit(
    rawUrls,
    Math.min(rawUrls.length || 1, resolveConcurrencyLimit(args.downloadConcurrency, rawUrls.length || 1)),
    async (rawUrl) =>
      convertRawUrlByFormat(rawUrl, args.responseFormat, {
        baseUrl: args.baseUrl,
        cookie: args.cookie,
        settings: args.settings,
        downloadTimeoutMs: args.downloadTimeoutMs,
      }),
  );
  return converted.filter(Boolean);
}

function createSyntheticImageEventStream(args: {
  selected: string[];
  responseField: ImageResponseFormat;
  onFinish?: (result: { status: number; duration: number }) => Promise<void> | void;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const startedAt = Date.now();
      try {
        let emitted = false;
        for (let i = 0; i < args.selected.length; i++) {
          const value = args.selected[i];
          if (!value || value === "error") continue;
          emitted = true;

          controller.enqueue(
            encoder.encode(
              buildImageSse("image_generation.partial_image", {
                type: "image_generation.partial_image",
                [args.responseField]: "",
                index: i,
                progress: 100,
              }),
            ),
          );
          controller.enqueue(
            encoder.encode(
              buildImageSse("image_generation.completed", {
                type: "image_generation.completed",
                [args.responseField]: value,
                index: i,
                usage: {
                  total_tokens: 50,
                  input_tokens: 25,
                  output_tokens: 25,
                  input_tokens_details: { text_tokens: 5, image_tokens: 20 },
                },
              }),
            ),
          );
        }

        if (!emitted) {
          controller.enqueue(
            encoder.encode(
              buildImageSse("image_generation.completed", {
                type: "image_generation.completed",
                [args.responseField]: "error",
                index: 0,
                usage: {
                  total_tokens: 0,
                  input_tokens: 0,
                  output_tokens: 0,
                  input_tokens_details: { text_tokens: 0, image_tokens: 0 },
                },
              }),
            ),
          );
        }

        if (args.onFinish) {
          await args.onFinish({ status: 200, duration: (Date.now() - startedAt) / 1000 });
        }
        controller.close();
      } catch (e) {
        if (args.onFinish) {
          await args.onFinish({ status: 500, duration: (Date.now() - startedAt) / 1000 });
        }
        controller.error(e);
      }
    },
  });
}

function createStreamErrorImageEventStream(args: {
  message: string;
  responseField: ImageResponseFormat;
  onFinish?: (result: { status: number; duration: number }) => Promise<void> | void;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const startedAt = Date.now();
      try {
        controller.enqueue(
          encoder.encode(
            buildImageSse("image_generation.error", {
              type: "image_generation.error",
              message: args.message,
            }),
          ),
        );
        controller.enqueue(
          encoder.encode(
            buildImageSse("image_generation.completed", {
              type: "image_generation.completed",
              [args.responseField]: "error",
              index: 0,
              usage: {
                total_tokens: 0,
                input_tokens: 0,
                output_tokens: 0,
                input_tokens_details: { text_tokens: 0, image_tokens: 0 },
              },
            }),
          ),
        );
        if (args.onFinish) {
          await args.onFinish({ status: 500, duration: (Date.now() - startedAt) / 1000 });
        }
        controller.close();
      } catch (e) {
        if (args.onFinish) {
          await args.onFinish({ status: 500, duration: (Date.now() - startedAt) / 1000 });
        }
        controller.error(e);
      }
    },
  });
}

function createExperimentalImageEventStream(args: {
  prompt: string;
  n: number;
  cookie: string;
  settings: Awaited<ReturnType<typeof getSettings>>["grok"];
  responseFormat: ImageResponseFormat;
  responseField: ImageResponseFormat;
  baseUrl: string;
  aspectRatio: string;
  concurrency: number;
  timeoutMs?: number | null;
  streamTimeoutMs?: number | null;
  finalTimeoutMs?: number | null;
  blockedGraceMs?: number | null;
  enableNsfw?: boolean;
  finalMinBytes?: number;
  mediumMinBytes?: number;
  blockedParallelAttempts?: number;
  blockedParallelEnabled?: boolean;
  downloadTimeoutMs?: number | null;
  onFinish?: (result: { status: number; duration: number }) => Promise<void> | void;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const safeN = Math.max(1, Math.floor(args.n || 1));
  void args.concurrency;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const startedAt = Date.now();
      const completedByIndex = new Map<number, string>();
      const partialKeyByIndex = new Map<number, string>();

      const emitPartial = (index: number, value: string, progress: number, stage?: string) => {
        if (index < 0 || index >= safeN) return;
        if (!value) return;
        const pct = Math.max(0, Math.min(100, Number(progress) || 0));
        const dedupeKey = `${stage ?? ""}:${value.length}:${pct}`;
        if (partialKeyByIndex.get(index) === dedupeKey) return;
        partialKeyByIndex.set(index, dedupeKey);
        controller.enqueue(
          encoder.encode(
            buildImageSse("image_generation.partial_image", {
              type: "image_generation.partial_image",
              [args.responseField]: value,
              index,
              progress: pct,
              ...(stage ? { stage } : {}),
            }),
          ),
        );
      };

      const emitCompleted = (index: number, value: string) => {
        if (index < 0 || index >= safeN) return;
        if (completedByIndex.has(index)) return;
        const finalValue = String(value || "").trim() || "error";
        completedByIndex.set(index, finalValue);
        const isError = finalValue === "error";
        controller.enqueue(
          encoder.encode(
            buildImageSse("image_generation.completed", {
              type: "image_generation.completed",
              [args.responseField]: finalValue,
              index,
              usage: {
                total_tokens: isError ? 0 : 50,
                input_tokens: isError ? 0 : 25,
                output_tokens: isError ? 0 : 25,
                input_tokens_details: {
                  text_tokens: isError ? 0 : 5,
                  image_tokens: isError ? 0 : 20,
                },
              },
            }),
          ),
        );
      };

      try {
        const images = await collectImagineWsImages({
          prompt: args.prompt,
          n: safeN,
          cookie: args.cookie,
          settings: args.settings,
          timeoutMs: args.timeoutMs ?? undefined,
          streamTimeoutMs: args.streamTimeoutMs ?? undefined,
          finalTimeoutMs: args.finalTimeoutMs ?? undefined,
          blockedGraceMs: args.blockedGraceMs ?? undefined,
          aspectRatio: args.aspectRatio,
          enableNsfw: args.enableNsfw,
          finalMinBytes: args.finalMinBytes,
          mediumMinBytes: args.mediumMinBytes,
          imageCb: async (image) => {
            if (image.isFinal) return;
            const converted = await convertImagineFrameByFormat(image, args.responseFormat, {
              baseUrl: args.baseUrl,
              cookie: args.cookie,
              settings: args.settings,
              downloadTimeoutMs: args.downloadTimeoutMs,
            });
            if (converted) {
              emitPartial(image.index, converted, image.progress || imageStageProgress(image.stage), image.stage);
            }
          },
          completedCb: async (image) => {
            const converted = await convertImagineFrameByFormat(image, args.responseFormat, {
              baseUrl: args.baseUrl,
              cookie: args.cookie,
              settings: args.settings,
              downloadTimeoutMs: args.downloadTimeoutMs,
            });
            if (converted) {
              emitCompleted(image.index, converted);
            }
          },
        });

        for (const image of images) {
          if (completedByIndex.has(image.index)) continue;
          const converted = await convertImagineFrameByFormat(image, args.responseFormat, {
            baseUrl: args.baseUrl,
            cookie: args.cookie,
            settings: args.settings,
            downloadTimeoutMs: args.downloadTimeoutMs,
          });
          if (converted) {
            emitCompleted(image.index, converted);
          }
        }

        for (let i = 0; i < safeN; i++) {
          if (!completedByIndex.has(i)) {
            emitCompleted(i, "error");
          }
        }

        const success = Array.from(completedByIndex.values()).some((v) => v !== "error");
        if (args.onFinish) {
          await args.onFinish({ status: success ? 200 : 500, duration: (Date.now() - startedAt) / 1000 });
        }
        controller.close();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        controller.enqueue(
          encoder.encode(
            buildImageSse("image_generation.error", {
              type: "image_generation.error",
              message,
            }),
          ),
        );
        if (!completedByIndex.has(0)) emitCompleted(0, "error");
        if (args.onFinish) {
          await args.onFinish({ status: 500, duration: (Date.now() - startedAt) / 1000 });
        }
        controller.close();
      }
    },
  });
}

function streamHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": "*",
  };
}

function isValidImageModel(model: string): boolean {
  if (!isValidModel(model)) return false;
  const cfg = MODEL_CONFIG[model];
  return Boolean(cfg?.is_image_model);
}

function invalidResponseFormatMessage(): string {
  return "response_format must be one of [\"b64_json\", \"base64\", \"url\"]";
}

function invalidStreamNMessage(): string {
  return "Streaming is only supported when n=1 or n=2";
}

function imageUsagePayload(values: string[]) {
  return {
    total_tokens: 0 * values.filter((v) => v !== "error").length,
    input_tokens: 0,
    output_tokens: 0 * values.filter((v) => v !== "error").length,
    input_tokens_details: { text_tokens: 0, image_tokens: 0 },
  };
}

function createdTs(): number {
  return Math.floor(Date.now() / 1000);
}

function buildImageJsonPayload(field: ImageResponseFormat, values: string[]) {
  return {
    created: createdTs(),
    data: imageResponseData(field, values),
    usage: imageUsagePayload(values),
  };
}

async function recordImageLog(args: {
  env: Env;
  ip: string;
  model: string;
  start: number;
  keyName: string;
  status: number;
  tokenSuffix?: string;
  error: string;
}) {
  const duration = (Date.now() - args.start) / 1000;
  await addRequestLog(args.env.DB, {
    ip: args.ip,
    model: args.model,
    duration: Number(duration.toFixed(2)),
    status: args.status,
    key_name: args.keyName,
    token_suffix: args.tokenSuffix ?? "",
    error: args.error,
  });
}

function listImageFiles(form: FormData): File[] {
  return [...form.getAll("image"), ...form.getAll("image[]")].filter(
    (item): item is File => item instanceof File,
  );
}

function nonEmptyPromptOrError(prompt: string) {
  if (prompt) return null;
  return { message: "Missing 'prompt'", code: "missing_prompt" };
}

function invalidGenerationModelOrError(model: string) {
  if (model !== IMAGE_GENERATION_MODEL_ID) {
    return {
      message: `The model '${IMAGE_GENERATION_MODEL_ID}' is required for image generations.`,
      code: "model_not_supported",
    };
  }
  if (!isValidModel(model)) return { message: `Model '${model}' not supported`, code: "model_not_supported" };
  if (!isValidImageModel(model)) return { message: `Model '${model}' is not an image model`, code: "invalid_model" };
  return null;
}

function invalidEditModelOrError(model: string) {
  if (model !== IMAGE_EDIT_MODEL_ID) {
    return {
      message: `The model '${IMAGE_EDIT_MODEL_ID}' is required for image edits.`,
      code: "model_not_supported",
    };
  }
  if (!isValidModel(model)) return { message: `Model '${model}' not supported`, code: "model_not_supported" };
  if (!isValidImageModel(model)) return { message: `Model '${model}' is not an image model`, code: "invalid_model" };
  return null;
}

function baseUrlFromSettings(settingsBundle: Awaited<ReturnType<typeof getSettings>>, origin: string): string {
  return (settingsBundle.global.base_url ?? "").trim() || origin;
}

function imageCallPrompt(kind: "generation" | "edit", prompt: string): string {
  return kind === "edit" ? `Image Edit: ${prompt}` : `Image Generation: ${prompt}`;
}

function imageFormatDefault(settingsBundle: Awaited<ReturnType<typeof getSettings>>): string {
  return String(settingsBundle.global.image_mode ?? "url");
}

function parseResponseFormatOrError(raw: unknown, defaultMode: string) {
  const resolved = resolveResponseFormat(raw, defaultMode);
  if (!resolved) {
    return { error: { message: invalidResponseFormatMessage(), code: "invalid_response_format" } };
  }
  return { value: resolved };
}

function resolveImageResponseFormatByMethodOrError(
  raw: unknown,
  defaultMode: string,
  imageMethod: ReturnType<typeof resolveImageGenerationMethod>,
) {
  void imageMethod;
  return parseResponseFormatOrError(raw, defaultMode);
}

openAiRoutes.get("/images/method", async (c) => {
  const settingsBundle = await getSettings(c.env);
  return c.json({ image_generation_method: imageGenerationMethod(settingsBundle) });
});

export async function handleChatCompletionsRequest(args: OpenAiHandlerArgs): Promise<Response> {
  const c = createOpenAiHandlerContext(args);
  const start = Date.now();
  const ip = getClientIp(c.req.raw);
  const keyName = c.get("apiAuth").name ?? "Unknown";

  const origin = new URL(c.req.url).origin;

  let requestedModel = "";
  try {
    const body = (await c.req.json()) as {
      model?: string;
      messages?: any[];
      stream?: boolean;
      video_config?: {
        aspect_ratio?: string;
        video_length?: number;
        resolution?: string;
        resolution_name?: string;
        preset?: string;
        is_video_extension?: boolean;
        extend_post_id?: string;
        video_extension_start_time?: number;
        original_post_id?: string;
        file_attachment_id?: string;
        stitch_with_extend?: boolean;
        parent_post_id?: string;
      };
    };

    requestedModel = String(body.model ?? "");
    if (!requestedModel) return c.json(openAiError("Missing 'model'", "missing_model"), 400);
    if (!Array.isArray(body.messages)) return c.json(openAiError("Missing 'messages'", "missing_messages"), 400);
    if (!isValidModel(requestedModel))
      return c.json(openAiError(`Model '${requestedModel}' not supported`, "model_not_supported"), 400);

    const settingsBundle = await getSettings(c.env);
    const cfg = MODEL_CONFIG[requestedModel]!;
    const isVideoModel = Boolean(cfg.is_video_model);
    const current = settingsBundle.current;
    const conversationSettings = resolveConversationStreamSettings({
      requestedModel,
      current,
      grok: settingsBundle.grok,
    });
    const imageConfig = current.image ?? {};
    const assetTransferConfig = buildAssetTransferConfig(current);
    const uploadConcurrency = resolveConcurrencyLimit(current.asset?.upload_concurrent, 5);
    const imageStreamTimeoutMs = resolveIdleTimeoutMs(imageConfig.stream_timeout);
    const imageFinalTimeoutMs = resolveIdleTimeoutMs(imageConfig.final_timeout);
    const imageBlockedGraceMs = resolveIdleTimeoutMs(imageConfig.blocked_grace_seconds);
    const imageEnableNsfw = imageConfig.nsfw !== false;
    const imageFinalMinBytes = Math.max(1, Math.floor(Number(imageConfig.final_min_bytes ?? 100_000) || 100_000));
    const imageMediumMinBytes = Math.max(1, Math.floor(Number(imageConfig.medium_min_bytes ?? 30_000) || 30_000));
    const blockedParallelAttempts = Math.max(0, Math.floor(Number(imageConfig.blocked_parallel_attempts ?? 0) || 0));
    const blockedParallelEnabled = imageConfig.blocked_parallel_enabled !== false;
    const requestedVideoConfig = isVideoModel ? body.video_config : undefined;
    const retryPolicy = resolveRetryPolicy(current.retry ?? {});

    const stream = body.stream === undefined
      ? Boolean(current.app?.stream ?? true)
      : Boolean(body.stream);
    const requestTimeoutMs = isVideoModel
      ? resolveTimeoutMs(current.video?.timeout, 60)
      : resolveTimeoutMs(current.chat?.timeout, 60);
    const totalAttempts = retryPolicy.maxRetry + 1;
    let retryDelaySpentMs = 0;
    let lastErr: string | null = null;

    // === Quota check (best-effort) ===
    // - heavy: consumes both heavy + chat
    // - image model: counts as 2 images per request (grok upstream emits up to 2)
    // - video model: 1 video per request
    // - others: 1 chat per request
    const quotaKind = cfg.is_video_model ? "video" : cfg.is_image_model ? "image" : "chat";
    const quota = await enforceQuota({
      env: c.env,
      apiAuth: c.get("apiAuth"),
      model: requestedModel,
      kind: quotaKind as any,
      ...(cfg.is_image_model ? { imageCount: 2 } : {}),
    });
    if (!quota.ok) return quota.resp;

    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      const chosen = await selectBestToken(c.env.DB, requestedModel, requestedVideoConfig);
      if (!chosen) return c.json(openAiError("No available token", "NO_AVAILABLE_TOKEN"), 503);

      const jwt = chosen.token;
      const cookie = buildCookie(jwt, settingsBundle.grok);

      const { content, attachments } = extractContent(body.messages as any);
      const videoPlan = isVideoModel
        ? buildVideoGenerationPlan({
            videoConfig: requestedVideoConfig,
            tokenType: chosen.token_type,
            upscaleTiming: current?.video?.upscale_timing,
          })
        : null;

      try {
        const uploads = await mapLimit(attachments, uploadConcurrency, async (attachment) => ({
          attachment,
          uploaded: await uploadAttachment(
            attachment.value,
            cookie,
            settingsBundle.grok,
            c.env.KV_CACHE,
            attachment.kind === "image" ? "image" : attachment.kind,
            assetTransferConfig,
          ),
        }));
        const fileIds = uploads
          .filter((item) => item.attachment.kind !== "image")
          .map((item) => item.uploaded.fileId)
          .filter(Boolean);
        const imageUploads = uploads.filter((item) => item.attachment.kind === "image");
        const imgIds = imageUploads.map((item) => item.uploaded.fileId).filter(Boolean);
        const imgUris = imageUploads.map((item) => item.uploaded.fileUri).filter(Boolean);
        const canUseExperimentalImageChat =
          requestedModel === IMAGE_GENERATION_MODEL_ID &&
          Boolean(cfg.is_image_model) &&
          !fileIds.length &&
          !imgIds.length &&
          !imgUris.length &&
          imageGenerationMethod(settingsBundle) === IMAGE_METHOD_IMAGINE_WS_EXPERIMENTAL;

        if (canUseExperimentalImageChat) {
          try {
            const baseUrl = baseUrlFromSettings(settingsBundle, origin);
            const images = await collectExperimentalGenerationImages({
              prompt: imageCallPrompt("generation", content),
              n: 2,
              cookie,
              settings: settingsBundle.grok,
              responseFormat: "url",
              baseUrl,
              aspectRatio: "2:3",
              concurrency: 1,
              streamTimeoutMs: imageStreamTimeoutMs,
              finalTimeoutMs: imageFinalTimeoutMs,
              blockedGraceMs: imageBlockedGraceMs,
              enableNsfw: imageEnableNsfw,
              finalMinBytes: imageFinalMinBytes,
              mediumMinBytes: imageMediumMinBytes,
              blockedParallelAttempts,
              blockedParallelEnabled,
            });
            const selected = pickImageResults(images, 2);

            if (stream) {
              const sse = createSyntheticChatImageStream({
                model: requestedModel,
                images: selected,
                onFinish: async ({ status, duration }) => {
                  await addRequestLog(c.env.DB, {
                    ip,
                    model: requestedModel,
                    duration: Number(duration.toFixed(2)),
                    status,
                    key_name: keyName,
                    token_suffix: jwt.slice(-6),
                    error: status === 200 ? "" : "stream_error",
                  });
                },
              });

              return new Response(sse, {
                status: 200,
                headers: {
                  "Content-Type": "text/event-stream; charset=utf-8",
                  "Cache-Control": "no-cache",
                  Connection: "keep-alive",
                  "X-Accel-Buffering": "no",
                  "Access-Control-Allow-Origin": "*",
                },
              });
            }

            const duration = (Date.now() - start) / 1000;
            await addRequestLog(c.env.DB, {
              ip,
              model: requestedModel,
              duration: Number(duration.toFixed(2)),
              status: 200,
              key_name: keyName,
              token_suffix: jwt.slice(-6),
              error: "",
            });

            return c.json(buildSyntheticChatCompletion(requestedModel, buildChatImageMarkdown(selected)));
          } catch (experimentalError) {
            const status = errorStatusCode(experimentalError);
            const message =
              experimentalError instanceof Error ? experimentalError.message : String(experimentalError);
            lastErr = message;
            await recordTokenFailure(c.env.DB, jwt, status, message.slice(0, 200));
            await applyCooldown(c.env.DB, jwt, status);
            console.warn("Experimental image chat failed, fallback to legacy:", message);
          }
        }

        const preparedVideoPrompt = isVideoModel
          ? prepareVideoReferencePrompt(content, imgIds, imgUris).promptText
          : content;
        let postId: string | undefined;
        if (isVideoModel) {
          const requestedParentPostId =
            String(body.video_config?.extend_post_id ?? "").trim() ||
            String(body.video_config?.parent_post_id ?? "").trim();
          if (requestedParentPostId) {
            postId = requestedParentPostId;
          } else {
            const post = await createMediaPost(
              { mediaType: "MEDIA_POST_TYPE_VIDEO", prompt: preparedVideoPrompt },
              cookie,
              settingsBundle.grok,
              requestTimeoutMs,
            );
            postId = post.postId || undefined;
          }
        }

        const workerVideoConfig =
          isVideoModel && videoPlan
            ? {
                ...(requestedVideoConfig ?? {}),
                resolution: videoPlan.generationResolution,
                resolution_name: videoPlan.generationResolutionName,
              }
            : undefined;
        const { payload, referer } = buildConversationPayload({
          requestModel: requestedModel,
          content,
          fileIds,
          imgIds,
          imgUris,
          ...(postId ? { postId } : {}),
          ...(workerVideoConfig ? { videoConfig: workerVideoConfig } : {}),
          settings: settingsBundle.grok,
        });

        const upstream = await sendConversationRequest({
          payload,
          cookie,
          settings: conversationSettings,
          timeoutMs: requestTimeoutMs,
          ...(referer ? { referer } : {}),
        });

        if (!upstream.ok) {
          const txt = await upstream.text().catch(() => "");
          lastErr = `Upstream ${upstream.status}: ${txt.slice(0, 200)}`;
          await recordTokenFailure(c.env.DB, jwt, upstream.status, txt.slice(0, 200));
          await applyCooldown(c.env.DB, jwt, upstream.status);
          const retryAfterMs = parseRetryAfterMs(upstream.headers.get("retry-after"));
          const canRetry = retryPolicy.retryCodes.includes(upstream.status) && attempt < totalAttempts - 1;
          if (canRetry) {
            const delayMs = computeRetryDelayMs({
              attempt: attempt + 1,
              status: upstream.status,
              retryAfterMs,
              policy: retryPolicy,
            });
            if (retryDelaySpentMs + delayMs <= retryPolicy.retryBudgetMs) {
              retryDelaySpentMs += delayMs;
              await sleep(delayMs);
              continue;
            }
          }
          break;
        }

        const enablePublicAsset = isVideoModel && current.video?.enable_public_asset === true;
        const transformVideoAsset =
          isVideoModel && (videoPlan?.shouldUpscale || enablePublicAsset)
            ? async (asset: { videoUrl: string; thumbnailUrl?: string }) => {
                let videoUrl = asset.videoUrl;
                if (videoPlan?.shouldUpscale) {
                  const upscaled = await upscaleVideoUrl({
                    videoUrl,
                    cookie,
                    settings: settingsBundle.grok,
                  });
                  videoUrl = upscaled.videoUrl;
                }
                if (enablePublicAsset) {
                  const publicized = await publicizeVideoUrl({
                    videoUrl,
                    cookie,
                    settings: settingsBundle.grok,
                  });
                  videoUrl = publicized.videoUrl;
                }
                return {
                  videoUrl,
                  ...(asset.thumbnailUrl ? { thumbnailUrl: asset.thumbnailUrl } : {}),
                };
              }
            : undefined;
        if (stream) {
          const sse = createOpenAiStreamFromGrokNdjson(upstream, {
            cookie,
            settings: conversationSettings,
            global: settingsBundle.global,
            origin,
            requestedModel,
            ...(videoPlan?.shouldUpscale
              ? {
                  videoMode: videoPlan.upscaleTiming === "complete" ? "finalize" : "eager",
                }
              : {}),
            ...(isVideoModel ? { videoFormat: current.app?.video_format } : {}),
            ...(transformVideoAsset ? { transformVideoAsset } : {}),
            onFinish: async ({ status, duration }) => {
              await addRequestLog(c.env.DB, {
                ip,
                model: requestedModel,
                duration: Number(duration.toFixed(2)),
                status,
                key_name: keyName,
                token_suffix: jwt.slice(-6),
                error: status === 200 ? "" : "stream_error",
              });
            },
          });

          return new Response(sse, {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "X-Accel-Buffering": "no",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }

        const json = await parseOpenAiFromGrokNdjson(upstream, {
          cookie,
          settings: conversationSettings,
          global: settingsBundle.global,
          origin,
          requestedModel,
          ...(isVideoModel ? { videoFormat: current.app?.video_format } : {}),
          ...(transformVideoAsset ? { transformVideoAsset } : {}),
        });

        const duration = (Date.now() - start) / 1000;
        await addRequestLog(c.env.DB, {
          ip,
          model: requestedModel,
          duration: Number(duration.toFixed(2)),
          status: 200,
          key_name: keyName,
          token_suffix: jwt.slice(-6),
          error: "",
        });

        return c.json(json);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        lastErr = msg;
        await recordTokenFailure(c.env.DB, jwt, 500, msg);
        await applyCooldown(c.env.DB, jwt, 500);
        if (attempt < totalAttempts - 1) {
          const delayMs = computeRetryDelayMs({
            attempt: attempt + 1,
            status: 500,
            retryAfterMs: null,
            policy: retryPolicy,
          });
          if (retryDelaySpentMs + delayMs <= retryPolicy.retryBudgetMs) {
            retryDelaySpentMs += delayMs;
            await sleep(delayMs);
            continue;
          }
        }
      }
    }

    const duration = (Date.now() - start) / 1000;
    await addRequestLog(c.env.DB, {
      ip,
      model: requestedModel,
      duration: Number(duration.toFixed(2)),
      status: 500,
      key_name: keyName,
      token_suffix: "",
      error: lastErr ?? "unknown_error",
    });

    return c.json(openAiError(lastErr ?? "Upstream error", "upstream_error"), 500);
  } catch (e) {
    const duration = (Date.now() - start) / 1000;
    await addRequestLog(c.env.DB, {
      ip,
      model: requestedModel || "unknown",
      duration: Number(duration.toFixed(2)),
      status: 500,
      key_name: keyName,
      token_suffix: "",
      error: e instanceof Error ? e.message : String(e),
    });
    return c.json(openAiError("Internal error", "internal_error"), 500);
  }
}

openAiRoutes.post("/chat/completions", async (c) =>
  handleChatCompletionsRequest({ request: c.req.raw, env: c.env, apiAuth: c.get("apiAuth") }),
);

export async function handleImageGenerationsRequest(args: OpenAiHandlerArgs): Promise<Response> {
  const c = createOpenAiHandlerContext(args);
  const start = Date.now();
  const ip = getClientIp(c.req.raw);
  const keyName = c.get("apiAuth").name ?? "Unknown";
  const origin = new URL(c.req.url).origin;

  let requestedModel = IMAGE_GENERATION_MODEL_ID;
  try {
    const body = (await c.req.json()) as {
      prompt?: unknown;
      model?: unknown;
      n?: unknown;
      size?: unknown;
      concurrency?: unknown;
      stream?: unknown;
      response_format?: unknown;
      aspect_ratio?: unknown;
    };
    const prompt = parseImagePrompt(body.prompt);
    const promptErr = nonEmptyPromptOrError(prompt);
    if (promptErr) return c.json(openAiError(promptErr.message, promptErr.code), 400);

    requestedModel = parseImageModel(body.model, IMAGE_GENERATION_MODEL_ID);
    const modelErr = invalidGenerationModelOrError(requestedModel);
    if (modelErr) return c.json(openAiError(modelErr.message, modelErr.code), 400);

    const n = parseImageCount(body.n);
    const size = parseImageSize(body.size);
    const aspectRatio = body.aspect_ratio ? String(body.aspect_ratio).trim() : resolveAspectRatio(size);
    const concurrencyParsed = parseImageConcurrencyOrError(body.concurrency);
    if ("error" in concurrencyParsed) {
      return c.json(
        openAiError(concurrencyParsed.error.message, concurrencyParsed.error.code),
        400,
      );
    }
    const concurrency = concurrencyParsed.value;
    const stream = parseImageStream(body.stream);

    const settingsBundle = await getSettings(c.env);
    const downloadConcurrency = resolveConcurrencyLimit(settingsBundle.current.asset?.download_concurrent, 2);
    const downloadTimeoutMs = resolveTimeoutMs(settingsBundle.current.asset?.download_timeout, 60);
    const imageConfig = settingsBundle.current.image ?? {};
    const imageTimeoutMs = resolveTimeoutMs(imageConfig.timeout, 60);
    const imageStreamTimeoutMs = resolveIdleTimeoutMs(imageConfig.stream_timeout);
    const imageFinalTimeoutMs = resolveIdleTimeoutMs(imageConfig.final_timeout);
    const imageBlockedGraceMs = resolveIdleTimeoutMs(imageConfig.blocked_grace_seconds);
    const imageEnableNsfw = imageConfig.nsfw !== false;
    const imageFinalMinBytes = Math.max(1, Math.floor(Number(imageConfig.final_min_bytes ?? 100_000) || 100_000));
    const imageMediumMinBytes = Math.max(1, Math.floor(Number(imageConfig.medium_min_bytes ?? 30_000) || 30_000));
    const blockedParallelAttempts = Math.max(0, Math.floor(Number(imageConfig.blocked_parallel_attempts ?? 0) || 0));
    const blockedParallelEnabled = imageConfig.blocked_parallel_enabled !== false;
    const imageMethod = imageGenerationMethod(settingsBundle);
    if (stream && imageMethod !== IMAGE_METHOD_IMAGINE_WS_EXPERIMENTAL && ![1, 2].includes(n)) {
      return c.json(openAiError(invalidStreamNMessage(), "invalid_stream_n"), 400);
    }
    const parsedResponseFormat = resolveImageResponseFormatByMethodOrError(
      body.response_format,
      imageFormatDefault(settingsBundle),
      imageMethod,
    );
    if ("error" in parsedResponseFormat) {
      const formatError = parsedResponseFormat.error;
      return c.json(
        openAiError(formatError?.message ?? "Invalid response format", formatError?.code ?? "invalid_response_format"),
        400,
      );
    }
    const responseFormat = parsedResponseFormat.value;
    const responseField = responseFieldName(responseFormat);
    const baseUrl = baseUrlFromSettings(settingsBundle, origin);
    const quota = await enforceQuota({
      env: c.env,
      apiAuth: c.get("apiAuth"),
      model: requestedModel,
      kind: "image",
      imageCount: n,
    });
    if (!quota.ok) return quota.resp;

    if (stream) {
      if (imageMethod === IMAGE_METHOD_IMAGINE_WS_EXPERIMENTAL) {
        const experimentalToken = await selectBestToken(c.env.DB, requestedModel);
        if (experimentalToken) {
          const experimentalCookie = buildCookie(experimentalToken.token, settingsBundle.grok);
          const streamBody = createExperimentalImageEventStream({
            prompt: imageCallPrompt("generation", prompt),
            n,
            cookie: experimentalCookie,
            settings: settingsBundle.grok,
            responseFormat,
            responseField,
            baseUrl,
            aspectRatio,
            concurrency,
            timeoutMs: imageTimeoutMs,
            streamTimeoutMs: imageStreamTimeoutMs,
            finalTimeoutMs: imageFinalTimeoutMs,
            blockedGraceMs: imageBlockedGraceMs,
            enableNsfw: imageEnableNsfw,
            finalMinBytes: imageFinalMinBytes,
            mediumMinBytes: imageMediumMinBytes,
            blockedParallelAttempts,
            blockedParallelEnabled,
            downloadTimeoutMs,
            onFinish: async ({ status, duration }) => {
              await addRequestLog(c.env.DB, {
                ip,
                model: requestedModel,
                duration: Number(duration.toFixed(2)),
                status,
                key_name: keyName,
                token_suffix: getTokenSuffix(experimentalToken.token),
                error: status === 200 ? "" : "stream_error",
              });
            },
          });
          return new Response(streamBody, { status: 200, headers: streamHeaders() });
        }
      }

      const chosen = await selectBestToken(c.env.DB, requestedModel);
      if (!chosen) {
        await recordImageLog({
          env: c.env,
          ip,
          model: requestedModel,
          start,
          keyName,
          status: 503,
          error: "NO_AVAILABLE_TOKEN",
        });
        return new Response(
          createStreamErrorImageEventStream({
            message: "No available token",
            responseField,
          }),
          { status: 200, headers: streamHeaders() },
        );
      }
      const cookie = buildCookie(chosen.token, settingsBundle.grok);

      const upstream = await runImageStreamCall({
        requestModel: requestedModel,
        prompt: imageCallPrompt("generation", prompt),
        fileIds: [],
        cookie,
        settings: settingsBundle.grok,
        timeoutMs: imageTimeoutMs,
      });
      if (!upstream.ok) {
        const txt = await upstream.text().catch(() => "");
        await recordTokenFailure(c.env.DB, chosen.token, upstream.status, txt.slice(0, 200));
        await applyCooldown(c.env.DB, chosen.token, upstream.status);
        await recordImageLog({
          env: c.env,
          ip,
          model: requestedModel,
          start,
          keyName,
          status: upstream.status,
          tokenSuffix: getTokenSuffix(chosen.token),
          error: txt.slice(0, 200),
        });
        return new Response(
          createStreamErrorImageEventStream({
            message: isContentModerationMessage(txt)
              ? txt.slice(0, 500)
              : `Upstream ${upstream.status}`,
            responseField,
          }),
          { status: 200, headers: streamHeaders() },
        );
      }

        const streamBody = createImageEventStream({
          upstream,
          responseFormat,
          baseUrl,
          cookie,
          settings: settingsBundle.grok,
          n,
          streamTimeoutMs: imageStreamTimeoutMs,
          downloadTimeoutMs,
          onFinish: async ({ status, duration }) => {
          await addRequestLog(c.env.DB, {
            ip,
            model: requestedModel,
            duration: Number(duration.toFixed(2)),
            status,
            key_name: keyName,
            token_suffix: getTokenSuffix(chosen.token),
            error: status === 200 ? "" : "stream_error",
          });
        },
      });
      return new Response(streamBody, { status: 200, headers: streamHeaders() });
    }

    if (imageMethod === IMAGE_METHOD_IMAGINE_WS_EXPERIMENTAL) {
      const experimentalToken = await selectBestToken(c.env.DB, requestedModel);
      if (experimentalToken) {
        const experimentalCookie = buildCookie(experimentalToken.token, settingsBundle.grok);
        try {
          const urls = await collectExperimentalGenerationImages({
            prompt: imageCallPrompt("generation", prompt),
            n,
            cookie: experimentalCookie,
            settings: settingsBundle.grok,
            responseFormat,
            baseUrl,
            aspectRatio,
            concurrency,
            timeoutMs: imageTimeoutMs,
            streamTimeoutMs: imageStreamTimeoutMs,
            finalTimeoutMs: imageFinalTimeoutMs,
            blockedGraceMs: imageBlockedGraceMs,
            enableNsfw: imageEnableNsfw,
            finalMinBytes: imageFinalMinBytes,
            mediumMinBytes: imageMediumMinBytes,
            blockedParallelAttempts,
            blockedParallelEnabled,
            downloadConcurrency,
            downloadTimeoutMs,
          });
          const selected = pickImageResults(urls, n);
          await recordImageLog({
            env: c.env,
            ip,
            model: requestedModel,
            start,
            keyName,
            status: 200,
            tokenSuffix: getTokenSuffix(experimentalToken.token),
            error: "",
          });
          return c.json(buildImageJsonPayload(responseField, selected));
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const status = errorStatusCode(e);
          await recordTokenFailure(c.env.DB, experimentalToken.token, status, msg.slice(0, 200));
          await applyCooldown(c.env.DB, experimentalToken.token, status);
          console.warn("Experimental image generation failed, fallback to legacy:", msg);
        }
      }
    }

    const calls = Math.ceil(n / 2);
    const urlsNested = await mapLimit(
      Array.from({ length: calls }),
      Math.min(calls, Math.max(1, concurrency)),
      async () => {
        const chosen = await selectBestToken(c.env.DB, requestedModel);
        if (!chosen) throw new Error("No available token");
        const cookie = buildCookie(chosen.token, settingsBundle.grok);
        try {
          return await runImageCall({
            requestModel: requestedModel,
            prompt: imageCallPrompt("generation", prompt),
            fileIds: [],
            cookie,
            settings: settingsBundle.grok,
            responseFormat,
            baseUrl,
            timeoutMs: imageTimeoutMs,
            streamTimeoutMs: imageStreamTimeoutMs,
            downloadConcurrency,
            downloadTimeoutMs,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await recordTokenFailure(c.env.DB, chosen.token, 500, msg.slice(0, 200));
          await applyCooldown(c.env.DB, chosen.token, 500);
          throw e;
        }
      },
    );
    const urls = dedupeImages(urlsNested.flat().filter(Boolean));
    const selected = pickImageResults(urls, n);

    await recordImageLog({
      env: c.env,
      ip,
      model: requestedModel,
      start,
      keyName,
      status: 200,
      error: "",
    });

    return c.json(buildImageJsonPayload(responseField, selected));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (isContentModerationMessage(message)) {
      await recordImageLog({
        env: c.env,
        ip,
        model: requestedModel || "image",
        start,
        keyName,
        status: 400,
        error: message,
      });
      return c.json(openAiError(message, "content_policy_violation"), 400);
    }
    await recordImageLog({
      env: c.env,
      ip,
      model: requestedModel || "image",
      start,
      keyName,
      status: 500,
      error: message,
    });
    return c.json(openAiError(message || "Internal error", "internal_error"), 500);
  }
}

openAiRoutes.post("/images/generations", async (c) =>
  handleImageGenerationsRequest({ request: c.req.raw, env: c.env, apiAuth: c.get("apiAuth") }),
);

export async function handleImageEditsRequest(args: OpenAiHandlerArgs): Promise<Response> {
  const c = createOpenAiHandlerContext(args);
  const start = Date.now();
  const ip = getClientIp(c.req.raw);
  const keyName = c.get("apiAuth").name ?? "Unknown";
  const origin = new URL(c.req.url).origin;
  const maxImageBytes = 50 * 1024 * 1024;

  let requestedModel = IMAGE_EDIT_MODEL_ID;
  try {
    const form = await c.req.formData();
    const prompt = parseImagePrompt(form.get("prompt"));
    const promptErr = nonEmptyPromptOrError(prompt);
    if (promptErr) return c.json(openAiError(promptErr.message, promptErr.code), 400);

    requestedModel = parseImageModel(form.get("model"), IMAGE_EDIT_MODEL_ID);
    const modelErr = invalidEditModelOrError(requestedModel);
    if (modelErr) return c.json(openAiError(modelErr.message, modelErr.code), 400);

    const n = parseImageCount(form.get("n"));
    const stream = parseImageStream(form.get("stream"));
    if (stream && ![1, 2].includes(n)) {
      return c.json(openAiError(invalidStreamNMessage(), "invalid_stream_n"), 400);
    }

    const files = listImageFiles(form);
    if (!files.length) return c.json(openAiError("Image is required", "missing_image"), 400);
    if (files.length > 16) {
      return c.json(openAiError("Too many images. Maximum is 16.", "invalid_image_count"), 400);
    }

    const settingsBundle = await getSettings(c.env);
    const assetTransferConfig = buildAssetTransferConfig(settingsBundle.current);
    const uploadConcurrency = resolveConcurrencyLimit(settingsBundle.current.asset?.upload_concurrent, 5);
    const downloadConcurrency = resolveConcurrencyLimit(settingsBundle.current.asset?.download_concurrent, 2);
    const downloadTimeoutMs = resolveTimeoutMs(settingsBundle.current.asset?.download_timeout, 60);
    const imageTimeoutMs = resolveTimeoutMs(settingsBundle.current.image?.timeout, 60);
    const imageStreamTimeoutMs = resolveIdleTimeoutMs(settingsBundle.current.image?.stream_timeout);
    const imageMethod = imageGenerationMethod(settingsBundle);
    const parsedResponseFormat = resolveImageResponseFormatByMethodOrError(
      form.get("response_format"),
      imageFormatDefault(settingsBundle),
      imageMethod,
    );
    if ("error" in parsedResponseFormat) {
      const formatError = parsedResponseFormat.error;
      return c.json(
        openAiError(formatError?.message ?? "Invalid response format", formatError?.code ?? "invalid_response_format"),
        400,
      );
    }
    const responseFormat = parsedResponseFormat.value;
    const responseField = responseFieldName(responseFormat);
    const baseUrl = baseUrlFromSettings(settingsBundle, origin);

    const quota = await enforceQuota({
      env: c.env,
      apiAuth: c.get("apiAuth"),
      model: requestedModel,
      kind: "image",
      imageCount: n,
    });
    if (!quota.ok) return quota.resp;

    const chosen = await selectBestToken(c.env.DB, requestedModel);
    if (!chosen) {
      if (stream) {
        await recordImageLog({
          env: c.env,
          ip,
          model: requestedModel,
          start,
          keyName,
          status: 503,
          error: "NO_AVAILABLE_TOKEN",
        });
        return new Response(
          createStreamErrorImageEventStream({
            message: "No available token",
            responseField,
          }),
          { status: 200, headers: streamHeaders() },
        );
      }
      return c.json(openAiError("No available token", "NO_AVAILABLE_TOKEN"), 503);
    }
    const cookie = buildCookie(chosen.token, settingsBundle.grok);

    const uploads = await mapLimit(Array.from(files), uploadConcurrency, async (file) => {
      const bytes = await file.arrayBuffer();
      if (bytes.byteLength <= 0) {
        throw new Error("EMPTY_FILE");
      }
      if (bytes.byteLength > maxImageBytes) {
        throw new Error("FILE_TOO_LARGE");
      }

      const mime = parseAllowedImageMime(file);
      if (!mime) {
        throw new Error("INVALID_IMAGE_TYPE");
      }

      const dataUrl = `data:${mime};base64,${arrayBufferToBase64(bytes)}`;
      return uploadImage(dataUrl, cookie, settingsBundle.grok, c.env.KV_CACHE, assetTransferConfig);
    }).catch((error) => {
      const code = error instanceof Error ? error.message : String(error);
      if (code === "EMPTY_FILE") return "EMPTY_FILE" as const;
      if (code === "FILE_TOO_LARGE") return "FILE_TOO_LARGE" as const;
      if (code === "INVALID_IMAGE_TYPE") return "INVALID_IMAGE_TYPE" as const;
      throw error;
    });

    if (uploads === "EMPTY_FILE") {
      return c.json(openAiError("File content is empty", "empty_file"), 400);
    }
    if (uploads === "FILE_TOO_LARGE") {
      return c.json(openAiError("Image file too large. Maximum is 50MB.", "file_too_large"), 400);
    }
    if (uploads === "INVALID_IMAGE_TYPE") {
      return c.json(openAiError("Unsupported image type. Supported: png, jpg, webp.", "invalid_image_type"), 400);
    }

    const fileIds = uploads.map((uploaded) => uploaded.fileId).filter(Boolean);
    const fileUris = uploads.map((uploaded) => uploaded.fileUri).filter(Boolean);

    if (stream) {
      if (imageMethod === IMAGE_METHOD_IMAGINE_WS_EXPERIMENTAL) {
        try {
          const upstream = await sendExperimentalImageEditRequest({
            prompt: imageCallPrompt("edit", prompt),
            fileUris,
            cookie,
            settings: settingsBundle.grok,
            timeoutMs: imageTimeoutMs,
          });

          const streamBody = createImageEventStream({
            upstream,
            responseFormat,
            baseUrl,
            cookie,
            settings: settingsBundle.grok,
            n,
            streamTimeoutMs: imageStreamTimeoutMs,
            downloadTimeoutMs,
            onFinish: async ({ status, duration }) => {
              await addRequestLog(c.env.DB, {
                ip,
                model: requestedModel,
                duration: Number(duration.toFixed(2)),
                status,
                key_name: keyName,
                token_suffix: getTokenSuffix(chosen.token),
                error: status === 200 ? "" : "stream_error",
              });
            },
          });
          return new Response(streamBody, { status: 200, headers: streamHeaders() });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const status = errorStatusCode(e);
          await recordTokenFailure(c.env.DB, chosen.token, status, msg.slice(0, 200));
          await applyCooldown(c.env.DB, chosen.token, status);
          console.warn("Experimental image edit stream failed, fallback to legacy:", msg);
        }
      }

      const upstream = await runImageStreamCall({
        requestModel: requestedModel,
        prompt: imageCallPrompt("edit", prompt),
        fileIds,
        cookie,
        settings: settingsBundle.grok,
        timeoutMs: imageTimeoutMs,
      });
      if (!upstream.ok) {
        const txt = await upstream.text().catch(() => "");
        await recordTokenFailure(c.env.DB, chosen.token, upstream.status, txt.slice(0, 200));
        await applyCooldown(c.env.DB, chosen.token, upstream.status);
        await recordImageLog({
          env: c.env,
          ip,
          model: requestedModel,
          start,
          keyName,
          status: upstream.status,
          tokenSuffix: getTokenSuffix(chosen.token),
          error: txt.slice(0, 200),
        });
        return new Response(
          createStreamErrorImageEventStream({
            message: isContentModerationMessage(txt)
              ? txt.slice(0, 500)
              : `Upstream ${upstream.status}`,
            responseField,
          }),
          { status: 200, headers: streamHeaders() },
        );
      }

      const streamBody = createImageEventStream({
        upstream,
        responseFormat,
        baseUrl,
        cookie,
        settings: settingsBundle.grok,
        n,
        streamTimeoutMs: imageStreamTimeoutMs,
        downloadTimeoutMs,
        onFinish: async ({ status, duration }) => {
          await addRequestLog(c.env.DB, {
            ip,
            model: requestedModel,
            duration: Number(duration.toFixed(2)),
            status,
            key_name: keyName,
            token_suffix: getTokenSuffix(chosen.token),
            error: status === 200 ? "" : "stream_error",
          });
        },
      });
      return new Response(streamBody, { status: 200, headers: streamHeaders() });
    }

    if (imageMethod === IMAGE_METHOD_IMAGINE_WS_EXPERIMENTAL) {
      try {
        const calls = Math.ceil(n / 2);
        const urlsNested = await mapLimit(Array.from({ length: calls }), 3, async () =>
          runExperimentalImageEditCall({
            prompt: imageCallPrompt("edit", prompt),
            fileUris,
            cookie,
            settings: settingsBundle.grok,
            responseFormat,
            baseUrl,
            timeoutMs: imageTimeoutMs,
            streamTimeoutMs: imageStreamTimeoutMs,
            downloadConcurrency,
            downloadTimeoutMs,
          }),
        );
        const urls = dedupeImages(urlsNested.flat().filter(Boolean));
        if (!urls.length) throw new Error("Experimental image edit returned no images");
        const selected = pickImageResults(urls, n);

        await recordImageLog({
          env: c.env,
          ip,
          model: requestedModel,
          start,
          keyName,
          status: 200,
          tokenSuffix: getTokenSuffix(chosen.token),
          error: "",
        });
        return c.json(buildImageJsonPayload(responseField, selected));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const status = errorStatusCode(e);
        await recordTokenFailure(c.env.DB, chosen.token, status, msg.slice(0, 200));
        await applyCooldown(c.env.DB, chosen.token, status);
        console.warn("Experimental image edit failed, fallback to legacy:", msg);
      }
    }

    const calls = Math.ceil(n / 2);
    const urlsNested = await mapLimit(Array.from({ length: calls }), 3, async () => {
      return runImageCall({
        requestModel: requestedModel,
        prompt: imageCallPrompt("edit", prompt),
        fileIds,
        cookie,
        settings: settingsBundle.grok,
        responseFormat,
        baseUrl,
        timeoutMs: imageTimeoutMs,
        streamTimeoutMs: imageStreamTimeoutMs,
        downloadConcurrency,
        downloadTimeoutMs,
      });
    });
    const urls = dedupeImages(urlsNested.flat().filter(Boolean));
    const selected = pickImageResults(urls, n);

    await recordImageLog({
      env: c.env,
      ip,
      model: requestedModel,
      start,
      keyName,
      status: 200,
      tokenSuffix: getTokenSuffix(chosen.token),
      error: "",
    });

    return c.json(buildImageJsonPayload(responseField, selected));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (isContentModerationMessage(message)) {
      await recordImageLog({
        env: c.env,
        ip,
        model: requestedModel || "image",
        start,
        keyName,
        status: 400,
        error: message,
      });
      return c.json(openAiError(message, "content_policy_violation"), 400);
    }
    await recordImageLog({
      env: c.env,
      ip,
      model: requestedModel || "image",
      start,
      keyName,
      status: 500,
      error: message,
    });
    return c.json(openAiError(message || "Internal error", "internal_error"), 500);
  }
}

openAiRoutes.post("/images/edits", async (c) =>
  handleImageEditsRequest({ request: c.req.raw, env: c.env, apiAuth: c.get("apiAuth") }),
);

export async function handleUploadImageRequest(args: OpenAiHandlerArgs): Promise<Response> {
  const c = createOpenAiHandlerContext(args);
  try {
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return c.json(openAiError("Missing file", "missing_file"), 400);

    const mime = String(file.type || "application/octet-stream");
    if (!mime.toLowerCase().startsWith("image/"))
      return c.json(openAiError(`Unsupported mime: ${mime}`, "unsupported_file"), 400);

    const bytes = await file.arrayBuffer();
    const size = bytes.byteLength;
    const maxBytes = Math.min(25 * 1024 * 1024, Math.max(1, parseIntSafe(c.env.KV_CACHE_MAX_BYTES, 25 * 1024 * 1024)));
    if (size > maxBytes) return c.json(openAiError(`File too large (${size} > ${maxBytes})`, "file_too_large"), 413);

    const ext = (() => {
      const m = mime.toLowerCase();
      if (m === "image/png") return "png";
      if (m === "image/webp") return "webp";
      if (m === "image/gif") return "gif";
      if (m === "image/jpeg" || m === "image/jpg") return "jpg";
      return "jpg";
    })();

    const name = `upload-${crypto.randomUUID()}.${ext}`;
    const kvKey = `image/${name}`;

    const tz = parseIntSafe(c.env.CACHE_RESET_TZ_OFFSET_MINUTES, 480);
    const expiresAt = nextLocalMidnightExpirationSeconds(nowMs(), tz);

    await c.env.KV_CACHE.put(kvKey, bytes, {
      expiration: expiresAt,
      metadata: { contentType: mime, size },
    });

    const now = nowMs();
    await upsertCacheRow(c.env.DB, {
      key: kvKey,
      type: "image",
      size,
      content_type: mime,
      created_at: now,
      last_access_at: now,
      expires_at: expiresAt * 1000,
    });

    return c.json({
      url: `/images/${encodeURIComponent(name)}`,
      name,
      size_bytes: size,
    });
  } catch (e) {
    return c.json(openAiError(e instanceof Error ? e.message : "Internal error", "internal_error"), 500);
  }
}

openAiRoutes.post("/uploads/image", async (c) =>
  handleUploadImageRequest({ request: c.req.raw, env: c.env, apiAuth: c.get("apiAuth") }),
);

openAiRoutes.options("/*", (c) => c.body(null, 204));
