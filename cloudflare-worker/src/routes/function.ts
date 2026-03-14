import { Hono } from "hono";
import { getDynamicHeaders } from "../grok/headers";
import { getCurrentConfig } from "../currentConfig";
import type { Env } from "../env";
import {
  chooseImageSizeFromAspectRatio,
  FUNCTION_SESSION_TTL_MS,
  normalizeImagineAspectRatio,
  normalizeVideoAspectRatio,
} from "../function/taskHelpers";
import {
  buildPromptEnhanceChatBody,
  extractChatMessageText,
  PROMPT_ENHANCE_MODEL,
} from "../function/promptEnhance";
import {
  getInternalMasterToken,
  requireFunctionAuth,
} from "../auth";
import { openAiRoutes } from "./openai";
import {
  deleteFunctionSessions,
  getFunctionSession,
  upsertFunctionSession,
} from "../repo/functionSessions";
import { listCacheRowsByType } from "../repo/cache";
import { applyCooldown, recordTokenFailure, selectBestToken } from "../repo/tokens";
import { getSettings, normalizeCfCookie } from "../settings";
import { buildInternalRequestUrl } from "./functionHelpers";
import { ImagineWsError, collectImagineWsImages } from "../grok/imagineExperimental";
import { extractVideoId, upscaleVideoById } from "../grok/video";

interface ImagineSessionPayload {
  prompt: string;
  aspect_ratio: string;
  nsfw: boolean | null;
  image_reference: string[];
  n: number;
  infinite_mode: boolean;
}

interface VideoSessionPayload {
  prompt: string;
  aspect_ratio: string;
  video_length: number;
  resolution_name: "480p" | "720p";
  preset: "fun" | "normal" | "spicy" | "custom";
  image_reference: string[];
  reasoning_effort: string | null;
  is_video_extension: boolean;
  extend_post_id: string | null;
  video_extension_start_time: number | null;
  original_post_id: string | null;
  file_attachment_id: string | null;
  stitch_with_extend: boolean;
}

interface PromptEnhanceRequestPayload {
  prompt: string;
  temperature: number;
  request_id: string;
}

const promptEnhanceControllers = new Map<string, AbortController>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSseHeaders(): Headers {
  return new Headers({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store, must-revalidate",
    connection: "keep-alive",
  });
}

function enqueueSse(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  payload: Record<string, unknown>,
): void {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
}

function parseWebSocketJson(data: unknown): Record<string, unknown> | null {
  let raw = "";
  if (typeof data === "string") raw = data;
  else if (data instanceof ArrayBuffer) raw = new TextDecoder().decode(data);
  else if (ArrayBuffer.isView(data)) {
    raw = new TextDecoder().decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function parseBoolean(input: unknown): boolean | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "boolean") return input;
  if (typeof input === "number") return input === 1;
  const value = String(input).trim().toLowerCase();
  if (!value) return null;
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function normalizeVideoLength(input: unknown): number {
  const value = Math.floor(Number(input ?? 6));
  if (!Number.isFinite(value)) return 6;
  return Math.min(15, Math.max(6, value));
}

function normalizePromptEnhanceTemperature(input: unknown): number {
  const value = Number(input ?? 0.7);
  if (!Number.isFinite(value)) return 0.7;
  return Math.min(2, Math.max(0, value));
}

const DEFAULT_IMAGINE_BATCH_SIZE = 6;
const MAX_IMAGINE_BATCH_SIZE = 6;
export const MAX_IMAGINE_INFINITE_BATCHES = 10;

function normalizeImagineCount(input: unknown): number {
  const value = Math.floor(Number(input ?? DEFAULT_IMAGINE_BATCH_SIZE));
  if (!Number.isFinite(value)) return DEFAULT_IMAGINE_BATCH_SIZE;
  return Math.min(MAX_IMAGINE_BATCH_SIZE, Math.max(1, value));
}

function normalizeImagineInfiniteMode(input: unknown): boolean {
  return parseBoolean(input) === true;
}

function buildImagineSessionPayload(input: {
  prompt: unknown;
  aspect_ratio: unknown;
  nsfw: unknown;
  image_reference: unknown;
  n: unknown;
  infinite_mode: unknown;
}): ImagineSessionPayload {
  return {
    prompt: String(input.prompt ?? "").trim(),
    aspect_ratio: normalizeImagineAspectRatio(String(input.aspect_ratio ?? "2:3")),
    nsfw: parseBoolean(input.nsfw),
    image_reference: extractImageReferences(input.image_reference),
    n: normalizeImagineCount(input.n),
    infinite_mode: normalizeImagineInfiniteMode(input.infinite_mode),
  };
}

function normalizeResolution(input: unknown): "480p" | "720p" {
  return String(input ?? "480p").trim() === "720p" ? "720p" : "480p";
}

function normalizePreset(input: unknown): "fun" | "normal" | "spicy" | "custom" {
  const preset = String(input ?? "normal").trim();
  if (preset === "fun" || preset === "spicy" || preset === "custom") return preset;
  return "normal";
}

function normalizeReasoningEffort(input: unknown): string | null {
  const value = String(input ?? "").trim().toLowerCase();
  if (!value) return null;
  return value;
}

function buildPromptEnhancePayload(input: Record<string, unknown>): PromptEnhanceRequestPayload {
  const prompt = String(input.prompt ?? "").trim();
  const requestId =
    String(input.request_id ?? input.requestId ?? crypto.randomUUID().replaceAll("-", "")).trim()
      || crypto.randomUUID().replaceAll("-", "");
  return {
    prompt,
    temperature: normalizePromptEnhanceTemperature(input.temperature),
    request_id: requestId,
  };
}

function extractPostIdFromAssetName(input: unknown): string {
  const raw = String(input ?? "").trim();
  if (!raw) return "";
  const generatedMatch = raw.match(/generated-([0-9a-fA-F-]{32,36})-/);
  if (generatedMatch?.[1]) {
    return generatedMatch[1];
  }
  const allMatches = raw.match(/[0-9a-fA-F-]{32,36}/g);
  return allMatches && allMatches.length ? allMatches[allMatches.length - 1] : "";
}

function deepGet(input: unknown, path: string[]): unknown {
  let current = input;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function firstNonEmptyString(input: unknown, paths: string[][]): string {
  for (const path of paths) {
    const value = deepGet(input, path);
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function base64UrlEncodeString(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function encodeAssetPath(raw: string): string {
  try {
    const url = new URL(raw);
    return `u_${base64UrlEncodeString(url.toString())}`;
  } catch {
    const pathname = raw.startsWith("/") ? raw : `/${raw}`;
    return `p_${base64UrlEncodeString(pathname)}`;
  }
}

function toProxyAssetUrl(raw: string): string {
  return `/images/${encodeURIComponent(encodeAssetPath(raw))}`;
}

function normalizeWebSocketUrl(input: unknown): string {
  if (typeof input !== "string") return "";
  let value = input.trim();
  if (!value) return "";
  if (!value.includes("://")) {
    value = `wss://${value}`;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return "";
    const pathname = (parsed.pathname || "").replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.host}${pathname}`;
  } catch {
    return "";
  }
}

function normalizeWebSocketUrlList(input: unknown): string[] {
  const values = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.replaceAll("\n", ",").split(",")
      : [];
  const urls: string[] = [];
  for (const item of values) {
    const normalized = normalizeWebSocketUrl(item);
    if (!normalized || urls.includes(normalized)) continue;
    urls.push(normalized);
  }
  return urls;
}

function normalizeIceServers(input: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(input)) return [];
  const normalized: Array<Record<string, unknown>> = [];
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const rawUrls = record.urls ?? record.url;
    const urls = Array.isArray(rawUrls)
      ? rawUrls.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim())
      : typeof rawUrls === "string" && rawUrls.trim()
        ? [rawUrls.trim()]
        : [];
    if (!urls.length) continue;
    const entry: Record<string, unknown> = { urls };
    if (typeof record.username === "string" && record.username.trim()) {
      entry.username = record.username.trim();
    }
    if (record.credential !== undefined && record.credential !== null) {
      entry.credential = record.credential;
    }
    normalized.push(entry);
  }
  return normalized;
}

function extractVoiceConnectionInfo(input: unknown): {
  url: string;
  urls: string[];
  iceServers: Array<Record<string, unknown>>;
} {
  const primary = normalizeWebSocketUrl(
    firstNonEmptyString(input, [
      ["url"],
      ["livekitUrl"],
      ["livekit_url"],
      ["livekitServerUrl"],
      ["ws_url"],
      ["serverUrl"],
      ["livekit", "url"],
      ["connection", "url"],
      ["connectionDetails", "url"],
      ["connection_details", "url"],
    ]),
  );

  const candidates: string[] = [];
  for (const value of [
    primary,
    ...normalizeWebSocketUrlList(deepGet(input, ["urls"])),
    ...normalizeWebSocketUrlList(deepGet(input, ["livekitUrls"])),
    ...normalizeWebSocketUrlList(deepGet(input, ["livekit_urls"])),
    ...normalizeWebSocketUrlList(deepGet(input, ["connection", "urls"])),
    ...normalizeWebSocketUrlList(deepGet(input, ["connectionDetails", "urls"])),
    ...normalizeWebSocketUrlList(deepGet(input, ["connection_details", "urls"])),
    "wss://livekit.grok.com",
  ]) {
    if (!value || candidates.includes(value)) continue;
    candidates.push(value);
  }

  let iceServers: Array<Record<string, unknown>> = [];
  for (const path of [
    ["iceServers"],
    ["ice_servers"],
    ["rtcConfig", "iceServers"],
    ["rtcConfig", "ice_servers"],
    ["rtc_config", "iceServers"],
    ["rtc_config", "ice_servers"],
    ["connectionDetails", "rtcConfig", "iceServers"],
    ["connectionDetails", "rtc_config", "ice_servers"],
    ["connection_details", "rtcConfig", "iceServers"],
  ]) {
    iceServers = normalizeIceServers(deepGet(input, path));
    if (iceServers.length) break;
  }

  return {
    url: candidates[0] ?? "wss://livekit.grok.com",
    urls: candidates.length ? candidates : ["wss://livekit.grok.com"],
    iceServers,
  };
}

function appendImageReference(target: string[], input: unknown): void {
  if (typeof input === "string") {
    const value = input.trim();
    if (value && !target.includes(value)) {
      target.push(value);
    }
    return;
  }
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    if (Array.isArray(input)) {
      for (const item of input) {
        appendImageReference(target, item);
      }
      return;
    }
    const url = String(record.image_url ?? "").trim();
    if (url && !target.includes(url)) {
      target.push(url);
    }
  }
}

function extractImageReferences(input: unknown): string[] {
  const references: string[] = [];
  appendImageReference(references, input);
  return references;
}

function extractOptionalString(input: unknown): string | null {
  const value = String(input ?? "").trim();
  return value || null;
}

function normalizeVideoExtensionStartTime(input: unknown): number | null {
  if (input === null || input === undefined || input === "") return null;
  const value = Number(input);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

function buildVideoChatBody(payload: VideoSessionPayload): Record<string, unknown> {
  const content = payload.image_reference.length
    ? [
        { type: "text", text: payload.prompt },
        ...payload.image_reference.map((url) => ({ type: "image_url", image_url: { url } })),
      ]
    : payload.prompt;

  return {
    model: "grok-imagine-1.0-video",
    stream: true,
    messages: [{ role: "user", content }],
    ...(payload.reasoning_effort ? { reasoning_effort: payload.reasoning_effort } : {}),
    video_config: {
      aspect_ratio: payload.aspect_ratio,
      video_length: payload.video_length,
      resolution: payload.resolution_name === "720p" ? "HD" : "SD",
      resolution_name: payload.resolution_name,
      preset: payload.preset,
      is_video_extension: payload.is_video_extension,
      extend_post_id: payload.extend_post_id,
      video_extension_start_time: payload.video_extension_start_time,
      original_post_id: payload.original_post_id,
      file_attachment_id: payload.file_attachment_id,
      stitch_with_extend: payload.stitch_with_extend,
    },
  };
}

async function buildInternalRequest(
  c: any,
  pathname: string,
  init: RequestInit,
): Promise<Request> {
  const url = new URL(buildInternalRequestUrl(c.req.url, pathname));
  const headers = new Headers(init.headers);
  const masterToken = await getInternalMasterToken(c.env);
  if (masterToken) {
    headers.set("Authorization", `Bearer ${masterToken}`);
  }
  return new Request(url.toString(), { ...init, headers });
}

async function runPromptEnhanceRequest(
  c: any,
  payload: PromptEnhanceRequestPayload,
  signal: AbortSignal,
): Promise<Response> {
  const request = await buildInternalRequest(c, "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildPromptEnhanceChatBody(payload.prompt, payload.temperature)),
    signal,
  });
  return openAiRoutes.fetch(request, c.env, c.executionCtx);
}

interface ImagineImageResultItem {
  url?: unknown;
  b64_json?: unknown;
  base64?: unknown;
}

interface ImagineOutputItem {
  field: "url" | "b64_json";
  value: string;
}

export function resolveImagineGenerationTarget(imageReference: unknown): {
  path: "/images/generations" | "/images/edits";
  model: "grok-imagine-1.0" | "grok-imagine-1.0-edit";
} {
  const references = extractImageReferences(imageReference);
  if (references.length) {
    return {
      path: "/images/edits",
      model: "grok-imagine-1.0-edit",
    };
  }
  return {
    path: "/images/generations",
    model: "grok-imagine-1.0",
  };
}

export function buildImagineGenerationBody(payload: ImagineSessionPayload): Record<string, unknown> {
  return {
    model: resolveImagineGenerationTarget(payload.image_reference).model,
    prompt: payload.prompt,
    n: payload.n,
    stream: false,
    response_format: "b64_json",
    size: chooseImageSizeFromAspectRatio(payload.aspect_ratio),
    concurrency: 1,
  };
}

export function resolveImagineBatchLimit(payload: Pick<ImagineSessionPayload, "infinite_mode">): number {
  return payload.infinite_mode ? MAX_IMAGINE_INFINITE_BATCHES : 1;
}

function normalizeImagineReferenceMime(input: unknown): string {
  const mime = String(input ?? "image/png").split(";")[0]?.trim() || "image/png";
  if (!mime.startsWith("image/")) {
    throw new Error("Imagine reference must be an image.");
  }
  return mime;
}

function imagineReferenceExtFromMime(mime: string): string {
  if (mime === "image/jpeg") return "jpg";
  return mime.split("/")[1] || "png";
}

function extractUploadedImagineReferenceName(reference: string): string | null {
  const match =
    reference.match(/\/images\/(upload-[^/?#]+)/i) ||
    reference.match(/\/v1\/files\/image\/(upload-[^/?#]+)/i);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

async function readUploadedImagineReferenceFromKv(
  c: any,
  reference: string,
): Promise<{ bytes: ArrayBuffer; mime: string } | null> {
  const name = extractUploadedImagineReferenceName(reference);
  if (!name || !c.env?.KV_CACHE) return null;

  const cached = await c.env.KV_CACHE.getWithMetadata(`image/${name}`, {
    type: "arrayBuffer",
  }) as { value?: ArrayBuffer | null; metadata?: { contentType?: string } | null } | null;
  if (!cached?.value) return null;

  return {
    bytes: cached.value,
    mime: normalizeImagineReferenceMime(cached.metadata?.contentType),
  };
}

export async function buildImagineEditFormData(
  c: any,
  payload: ImagineSessionPayload,
): Promise<FormData> {
  const references = extractImageReferences(payload.image_reference);
  if (!references.length) {
    throw new Error("Missing image reference for imagine edit.");
  }

  const form = new FormData();
  form.set("model", resolveImagineGenerationTarget(payload.image_reference).model);
  form.set("prompt", payload.prompt);
  form.set("n", String(payload.n));
  form.set("response_format", "b64_json");
  form.set("size", chooseImageSizeFromAspectRatio(payload.aspect_ratio));
  for (const [index, reference] of references.entries()) {
    const cachedReference = await readUploadedImagineReferenceFromKv(c, reference);
    const fetchedReference = cachedReference
      ? null
      : await (async () => {
          const referenceUrl = reference.startsWith("data:")
            ? reference
            : new URL(reference, c.req.url).toString();
          const response = await fetch(referenceUrl, { redirect: "follow" });
          if (!response.ok) {
            throw new Error(`Failed to fetch imagine reference image (${response.status}).`);
          }
          return {
            bytes: await response.arrayBuffer(),
            mime: normalizeImagineReferenceMime(response.headers.get("content-type")),
          };
        })();

    const mime = cachedReference?.mime ?? fetchedReference!.mime;
    const ext = imagineReferenceExtFromMime(mime);
    const bytes = cachedReference?.bytes ?? fetchedReference!.bytes;
    const fileName = references.length === 1 ? `reference.${ext}` : `reference-${index + 1}.${ext}`;
    const file = new File([bytes], fileName, { type: mime });
    form.append("image", file, file.name);
  }
  return form;
}

async function runImagineBatch(
  c: any,
  payload: ImagineSessionPayload,
): Promise<ImagineOutputItem[]> {
  const target = resolveImagineGenerationTarget(payload.image_reference);
  const request = target.path === "/images/edits"
    ? await buildInternalRequest(c, target.path, {
        method: "POST",
        body: await buildImagineEditFormData(c, payload),
      })
    : await buildInternalRequest(c, target.path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildImagineGenerationBody(payload)),
      });

  const response = await openAiRoutes.fetch(request, c.env, c.executionCtx);
  const bodyText = await response.text();
  let parsed: Record<string, unknown> | null = null;
  if (bodyText) {
    try {
      parsed = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const errorRecord =
      parsed && parsed.error && typeof parsed.error === "object"
        ? (parsed.error as Record<string, unknown>)
        : null;
    const message =
      String(errorRecord?.message ?? parsed?.message ?? bodyText ?? "").trim() ||
      `Image generation failed (${response.status})`;
    throw new Error(message);
  }

  const data = Array.isArray(parsed?.data) ? (parsed?.data as ImagineImageResultItem[]) : [];
  const images = data
    .map((item) => {
      const b64 = String(item.b64_json ?? item.base64 ?? "").trim();
      if (b64) return { field: "b64_json" as const, value: b64 };
      const url = String(item.url ?? "").trim();
      if (url) return { field: "url" as const, value: url };
      return null;
    })
    .filter(Boolean);

  if (!images.length) {
    throw new Error("Image generation returned empty data.");
  }

  return images as ImagineOutputItem[];
}

function imagineStageProgress(stage?: string): number {
  if (stage === "final") return 100;
  if (stage === "medium") return 70;
  return 35;
}

function imagineErrorStatus(error: unknown): number {
  if (error instanceof ImagineWsError && typeof error.status === "number") {
    return error.status;
  }
  return 500;
}

async function runImagineWsBatch(args: {
  c: any;
  payload: ImagineSessionPayload;
  runId: string;
  safeSend: (payload: Record<string, unknown>) => Promise<boolean>;
  batchStart: number;
  nextSequence: () => number;
}): Promise<void> {
  const settingsBundle = await getSettings(args.c.env);
  const current = await getCurrentConfig(args.c.env);
  const imageConfig = current.image ?? {};
  const chosen = await selectBestToken(args.c.env.DB, "grok-imagine-1.0");
  if (!chosen) {
    throw new Error("No available token");
  }

  const cf = normalizeCfCookie(settingsBundle.grok.cf_clearance ?? "");
  const cookie = cf
    ? `sso-rw=${chosen.token};sso=${chosen.token};${cf}`
    : `sso-rw=${chosen.token};sso=${chosen.token}`;
  const emittedPartialKeys = new Set<string>();
  const emittedCompletedIds = new Set<string>();

  try {
    await collectImagineWsImages({
      prompt: args.payload.prompt,
      n: args.payload.n,
      cookie,
      settings: settingsBundle.grok,
      aspectRatio: args.payload.aspect_ratio,
      enableNsfw: args.payload.nsfw !== false,
      finalMinBytes: Number(imageConfig.final_min_bytes ?? 100000),
      mediumMinBytes: Number(imageConfig.medium_min_bytes ?? 30000),
      imageCb: async (image) => {
        if (image.isFinal) return;
        const key = `${image.imageId}:${image.stage}:${image.blobSize}`;
        if (emittedPartialKeys.has(key)) return;
        emittedPartialKeys.add(key);
        await args.safeSend({
          type: "image_generation.partial_image",
          image_id: image.imageId,
          b64_json: image.blob,
          stage: image.stage,
          progress: image.progress || imagineStageProgress(image.stage),
          elapsed_ms: Date.now() - args.batchStart,
          aspect_ratio: args.payload.aspect_ratio,
          run_id: args.runId,
        });
      },
      completedCb: async (image) => {
        if (emittedCompletedIds.has(image.imageId)) return;
        emittedCompletedIds.add(image.imageId);
        await args.safeSend({
          type: "image_generation.completed",
          image_id: image.imageId,
          b64_json: image.blob ?? "",
          sequence: args.nextSequence(),
          stage: "final",
          elapsed_ms: Date.now() - args.batchStart,
          aspect_ratio: args.payload.aspect_ratio,
          run_id: args.runId,
        });
      },
    });
  } catch (error) {
    const status = imagineErrorStatus(error);
    const message = error instanceof Error ? error.message : String(error);
    await recordTokenFailure(args.c.env.DB, chosen.token, status, message.slice(0, 200));
    await applyCooldown(args.c.env.DB, chosen.token, status);
    throw error;
  }
}

const MAX_IMAGINE_CONSECUTIVE_FAILURES = 3;

async function runImagineLoop(args: {
  c: any;
  payload: ImagineSessionPayload;
  isActive: () => boolean | Promise<boolean>;
  send: (payload: Record<string, unknown>) => boolean | Promise<boolean>;
}): Promise<void> {
  const runId = crypto.randomUUID().replaceAll("-", "");
  let sequence = 0;
  let failures = 0;
  let batchesCompleted = 0;
  const batchLimit = resolveImagineBatchLimit(args.payload);

  const safeSend = async (payload: Record<string, unknown>): Promise<boolean> => {
    try {
      return (await args.send(payload)) !== false;
    } catch {
      return false;
    }
  };

  if (
    !(await safeSend({
      type: "status",
      status: "running",
      prompt: args.payload.prompt,
      aspect_ratio: args.payload.aspect_ratio,
      run_id: runId,
    }))
  ) {
    return;
  }

  while (batchesCompleted < batchLimit && await args.isActive()) {
    const batchStart = Date.now();
    batchesCompleted += 1;
    try {
      if (!args.payload.image_reference.length) {
        await runImagineWsBatch({
          c: args.c,
          payload: args.payload,
          runId,
          safeSend,
          batchStart,
          nextSequence: () => {
            sequence += 1;
            return sequence;
          },
        });
        failures = 0;
        continue;
      }

      const images = await runImagineBatch(args.c, args.payload);
      failures = 0;

      for (const image of images) {
        if (!(await args.isActive())) break;
        sequence += 1;
        const delivered = await safeSend({
          type: "image_generation.completed",
          image_id: `${runId}-${sequence - 1}`,
          [image.field]: image.value,
          sequence,
          elapsed_ms: Date.now() - batchStart,
          aspect_ratio: args.payload.aspect_ratio,
          run_id: runId,
        });
        if (!delivered) return;
      }
    } catch (error) {
      failures += 1;
      const message = error instanceof Error ? error.message : String(error);
      const delivered = await safeSend({
        type: "error",
        message,
        code: "internal_error",
        run_id: runId,
      });
      if (!delivered) return;
      if (failures >= MAX_IMAGINE_CONSECUTIVE_FAILURES) {
        await safeSend({
          type: "error",
          message: "Image generation stopped after repeated failures.",
          code: "stopped_after_failures",
          run_id: runId,
        });
        break;
      }
      await sleep(1500);
    }
  }

  await safeSend({
    type: "status",
    status: "stopped",
    run_id: runId,
  });
}

async function buildVoiceTokenResponse(
  env: Env,
  args: { voice: string; personality: string; speed: number },
): Promise<Response> {
  const settings = await getSettings(env);
  const chosen = await selectBestToken(env.DB, "grok-4");
  if (!chosen) {
    return Response.json(
      { error: "No available tokens for voice mode", code: "no_token" },
      { status: 503 },
    );
  }

  const cf = normalizeCfCookie(settings.grok.cf_clearance ?? "");
  const cookie = cf
    ? `sso-rw=${chosen.token};sso=${chosen.token};${cf}`
    : `sso-rw=${chosen.token};sso=${chosen.token}`;

  const headers = getDynamicHeaders(settings.grok, "/rest/livekit/tokens");
  headers.Cookie = cookie;
  headers.Origin = "https://grok.com";
  headers.Referer = "https://grok.com/";
  headers["Content-Type"] = "application/json";

  const payload = {
    sessionPayload: JSON.stringify({
      voice: args.voice,
      personality: args.personality,
      playback_speed: args.speed,
      enable_vision: false,
      turn_detection: { type: "server_vad" },
    }),
    requestAgentDispatch: false,
    livekitUrl: "wss://livekit.grok.com",
    params: { enable_markdown_transcript: "true" },
  };

  const upstream = await fetch("https://grok.com/rest/livekit/tokens", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!upstream.ok) {
    const body = await upstream.text().catch(() => "");
    await recordTokenFailure(env.DB, chosen.token, upstream.status, body.slice(0, 200));
    await applyCooldown(env.DB, chosen.token, upstream.status);
    return Response.json(
      { error: body || `Voice token request failed (${upstream.status})`, code: "voice_error" },
      { status: upstream.status },
    );
  }

  const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
  if (!data?.token) {
    return Response.json(
      { error: "Upstream returned no voice token", code: "upstream_error" },
      { status: 502 },
    );
  }

  const connection = extractVoiceConnectionInfo(data);
  const participantName = firstNonEmptyString(data, [["participant_name"], ["participantName"], ["identity"]]);
  const roomName = firstNonEmptyString(data, [["room_name"], ["roomName"], ["room"]]);

  return Response.json({
    token: String(data.token),
    url: connection.url,
    urls: connection.urls,
    participant_name: participantName,
    room_name: roomName,
    ice_servers: connection.iceServers.length ? connection.iceServers : undefined,
  });
}

export const functionRoutes = new Hono<{ Bindings: Env }>();

functionRoutes.use("/v1/function/*", requireFunctionAuth);

functionRoutes.post("/v1/function/uploads/image", async (c) => {
  const form = await c.req.formData();
  const request = await buildInternalRequest(c, "/uploads/image", {
    method: "POST",
    body: form,
  });
  return openAiRoutes.fetch(request, c.env, c.executionCtx);
});

functionRoutes.get("/v1/function/verify", () => {
  return Response.json({ status: "success", success: true });
});

functionRoutes.post("/v1/function/chat/completions", async (c) => {
  const body = await c.req.text();
  const request = await buildInternalRequest(c, "/chat/completions", {
    method: "POST",
    headers: {
      "content-type": c.req.header("content-type") ?? "application/json",
    },
    body,
  });
  return openAiRoutes.fetch(request, c.env, c.executionCtx);
});

functionRoutes.post("/v1/function/prompt/enhance", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const payload = buildPromptEnhancePayload(body);
  if (!payload.prompt) {
    return c.json({ error: "Prompt cannot be empty", code: "invalid_prompt" }, 400);
  }

  const controller = new AbortController();
  promptEnhanceControllers.set(payload.request_id, controller);
  const abortHandler = () => controller.abort("client_aborted");
  c.req.raw.signal.addEventListener("abort", abortHandler, { once: true });

  try {
    const response = await runPromptEnhanceRequest(c, payload, controller.signal);
    const rawText = await response.text();
    let parsed: Record<string, unknown> | null = null;
    if (rawText) {
      try {
        parsed = JSON.parse(rawText) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }

    if (!response.ok) {
      const errorRecord =
        parsed && parsed.error && typeof parsed.error === "object"
          ? (parsed.error as Record<string, unknown>)
          : null;
      const message =
        String(errorRecord?.message ?? parsed?.message ?? rawText ?? "").trim()
          || `Prompt enhance failed (${response.status})`;
      return new Response(
        JSON.stringify({ error: message, code: "prompt_enhance_failed" }),
        {
          status: response.status,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      );
    }

    const enhancedPrompt = extractChatMessageText(parsed);
    if (!enhancedPrompt) {
      return c.json({ error: "Prompt enhance returned empty content", code: "empty_prompt_enhance" }, 502);
    }

    return c.json({
      enhanced_prompt: enhancedPrompt,
      model: PROMPT_ENHANCE_MODEL,
      request_id: payload.request_id,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      return new Response(
        JSON.stringify({ error: "Prompt enhance cancelled", code: "prompt_enhance_cancelled" }),
        {
          status: 499,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      );
    }
    return c.json(
      {
        error: error instanceof Error ? error.message : String(error),
        code: "prompt_enhance_failed",
      },
      500,
    );
  } finally {
    c.req.raw.signal.removeEventListener("abort", abortHandler);
    if (promptEnhanceControllers.get(payload.request_id) === controller) {
      promptEnhanceControllers.delete(payload.request_id);
    }
  }
});

functionRoutes.post("/v1/function/prompt/enhance/stop", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const requestId = String(body.request_id ?? body.requestId ?? "").trim();
  if (!requestId) {
    return c.json({ error: "request_id is required", code: "invalid_request_id" }, 400);
  }

  const controller = promptEnhanceControllers.get(requestId);
  if (!controller) {
    return c.json({ status: "not_found", request_id: requestId });
  }

  promptEnhanceControllers.delete(requestId);
  controller.abort("cancelled_by_user");
  return c.json({ status: "cancelling", request_id: requestId });
});

functionRoutes.get("/v1/function/imagine/config", async (c) => {
  const current = await getCurrentConfig(c.env);
  const imageConfig = current.image ?? {};
  return c.json({
    final_min_bytes: Number(imageConfig.final_min_bytes ?? 100000),
    medium_min_bytes: Number(imageConfig.medium_min_bytes ?? 30000),
    nsfw: Boolean(imageConfig.nsfw ?? true),
  });
});

functionRoutes.post("/v1/function/imagine/start", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) {
    return c.json({ error: "Prompt cannot be empty", code: "invalid_prompt" }, 400);
  }

  const imaginePayload = buildImagineSessionPayload({
    prompt,
    aspect_ratio: body.aspect_ratio,
    nsfw: body.nsfw,
    image_reference: body.image_reference,
    n: body.n,
    infinite_mode: body.infinite_mode,
  });
  const now = Date.now();
  const taskId = crypto.randomUUID().replaceAll("-", "");

  await upsertFunctionSession<ImagineSessionPayload>(c.env.DB, {
    task_id: taskId,
    kind: "imagine",
    payload: imaginePayload,
    created_at: now,
    expires_at: now + FUNCTION_SESSION_TTL_MS,
  });

  return c.json({ task_id: taskId, aspect_ratio: imaginePayload.aspect_ratio });
});

functionRoutes.post("/v1/function/imagine/stop", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { task_ids?: string[] };
  const removed = await deleteFunctionSessions(c.env.DB, body.task_ids ?? [], "imagine");
  return c.json({ status: "success", removed });
});

functionRoutes.get("/v1/function/imagine/sse", async (c) => {
  const taskId = String(c.req.query("task_id") ?? "").trim();
  const session = await getFunctionSession<ImagineSessionPayload>(c.env.DB, taskId, "imagine");
  if (!session) {
    return new Response(null, { status: 204 });
  }
  const sessionPayload = buildImagineSessionPayload(session.payload);

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let active = true;
      const rawSignal = c.req.raw.signal;

      const stop = async () => {
        if (!active) return;
        active = false;
        await deleteFunctionSessions(c.env.DB, [taskId], "imagine");
        try {
          controller.close();
        } catch {
          // ignore close failure
        }
      };

      try {
        await runImagineLoop({
          c,
          payload: sessionPayload,
          isActive: async () => {
            if (!active || rawSignal.aborted) return false;
            const stillExists = await getFunctionSession<ImagineSessionPayload>(
              c.env.DB,
              taskId,
              "imagine",
            );
            return Boolean(stillExists);
          },
          send: (payload) => {
            if (!active || rawSignal.aborted) return false;
            enqueueSse(controller, encoder, payload);
            return true;
          },
        });
      } catch (error) {
        enqueueSse(controller, encoder, {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
          code: "internal_error",
        });
      } finally {
        await stop();
      }
    },
  });

  return new Response(stream, { headers: createSseHeaders() });
});

functionRoutes.get("/v1/function/imagine/ws", async (c) => {
  const upgrade = c.req.header("upgrade") ?? c.req.header("Upgrade");
  if (String(upgrade ?? "").toLowerCase() !== "websocket") {
    return c.text("Expected websocket upgrade", 426);
  }

  const taskId = String(c.req.query("task_id") ?? "").trim();
  const sessionRecord = taskId
    ? await getFunctionSession<ImagineSessionPayload>(c.env.DB, taskId, "imagine")
    : null;
  const sessionPayload = sessionRecord ? buildImagineSessionPayload(sessionRecord.payload) : null;
  if (taskId && !sessionPayload) {
    return c.json({ error: "Task not found", code: "TASK_NOT_FOUND" }, 404);
  }

  const wsPair = new WebSocketPair();
  const client = wsPair[0];
  const server = wsPair[1];
  server.accept();

  let closed = false;
  let running = false;
  let runVersion = 0;

  const closeSocket = async () => {
    if (closed) return;
    closed = true;
    if (taskId) {
      await deleteFunctionSessions(c.env.DB, [taskId], "imagine");
    }
    try {
      server.close(1000, "done");
    } catch {
      // ignore close failures
    }
  };

  const send = (payload: Record<string, unknown>): boolean => {
    if (closed) return false;
    try {
      server.send(JSON.stringify(payload));
      return true;
    } catch {
      closed = true;
      return false;
    }
  };

  const startLoop = (payload: ImagineSessionPayload): void => {
    runVersion += 1;
    const localRunVersion = runVersion;
    running = true;

    void (async () => {
      await runImagineLoop({
        c,
        payload,
        isActive: () => !closed && running && localRunVersion === runVersion,
        send,
      });
    })();
  };

  server.addEventListener("message", (event) => {
    const payload = parseWebSocketJson(event.data);
    if (!payload) {
      send({ type: "error", message: "Invalid message format.", code: "invalid_payload" });
      return;
    }

    const action = String(payload.type ?? "");
    if (action === "stop") {
      running = false;
      runVersion += 1;
      return;
    }

    if (action !== "start") {
      send({ type: "error", message: "Unknown action.", code: "invalid_action" });
      return;
    }

    const prompt = String(payload.prompt ?? sessionPayload?.prompt ?? "").trim();
    if (!prompt) {
      send({ type: "error", message: "Prompt cannot be empty.", code: "invalid_prompt" });
      return;
    }

    const imaginePayload = buildImagineSessionPayload({
      prompt,
      aspect_ratio: payload.aspect_ratio ?? sessionPayload?.aspect_ratio ?? "2:3",
      nsfw: payload.nsfw ?? sessionPayload?.nsfw,
      image_reference: payload.image_reference ?? sessionPayload?.image_reference ?? [],
      n: payload.n ?? sessionPayload?.n,
      infinite_mode: payload.infinite_mode ?? sessionPayload?.infinite_mode,
    });
    startLoop(imaginePayload);
  });

  server.addEventListener("close", () => {
    running = false;
    runVersion += 1;
    void closeSocket();
  });

  server.addEventListener("error", () => {
    running = false;
    runVersion += 1;
    void closeSocket();
  });

  return new Response(null, { status: 101, webSocket: client });
});

functionRoutes.post("/v1/function/video/start", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const prompt = String(body.prompt ?? "").trim();
  const imageReference = extractImageReferences(body.image_reference);
  const legacyImageUrl = String(body.image_url ?? "").trim();
  if (!imageReference.length && legacyImageUrl) {
    imageReference.push(legacyImageUrl);
  }
  const isVideoExtension = parseBoolean(body.is_video_extension) === true;
  const extendPostId = extractOptionalString(body.extend_post_id);
  const videoExtensionStartTime = normalizeVideoExtensionStartTime(body.video_extension_start_time);
  if (isVideoExtension) {
    if (!extendPostId) {
      return c.json({ error: "extend_post_id is required", code: "invalid_extend_post_id" }, 400);
    }
    if (videoExtensionStartTime === null) {
      return c.json(
        {
          error: "video_extension_start_time must be a non-negative number",
          code: "invalid_video_extension_start_time",
        },
        400,
      );
    }
  } else if (!prompt && !imageReference.length) {
    return c.json({ error: "Prompt cannot be empty", code: "invalid_prompt" }, 400);
  }

  const taskId = crypto.randomUUID().replaceAll("-", "");
  const now = Date.now();
  const payload: VideoSessionPayload = {
    prompt,
    aspect_ratio: normalizeVideoAspectRatio(String(body.aspect_ratio ?? "3:2")),
    video_length: normalizeVideoLength(body.video_length),
    resolution_name: normalizeResolution(body.resolution_name),
    preset: normalizePreset(body.preset),
    image_reference: imageReference,
    reasoning_effort: normalizeReasoningEffort(body.reasoning_effort),
    is_video_extension: isVideoExtension,
    extend_post_id: isVideoExtension ? extendPostId : null,
    video_extension_start_time: isVideoExtension ? videoExtensionStartTime : null,
    original_post_id: isVideoExtension ? extractOptionalString(body.original_post_id) : null,
    file_attachment_id: isVideoExtension ? extractOptionalString(body.file_attachment_id) : null,
    stitch_with_extend: isVideoExtension ? (parseBoolean(body.stitch_with_extend) ?? true) : true,
  };

  await upsertFunctionSession<VideoSessionPayload>(c.env.DB, {
    task_id: taskId,
    kind: "video",
    payload,
    created_at: now,
    expires_at: now + FUNCTION_SESSION_TTL_MS,
  });

  return c.json({ task_id: taskId, aspect_ratio: payload.aspect_ratio });
});

functionRoutes.get("/v1/function/video/cache/list", async (c) => {
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const pageSize = Math.max(1, Math.min(200, Number(c.req.query("page_size") ?? 100)));
  const offset = (page - 1) * pageSize;
  const { total, items } = await listCacheRowsByType(c.env.DB, "video", pageSize, offset);
  return c.json({
    total,
    page,
    page_size: pageSize,
    items: items.map((item) => {
      const name = item.key.startsWith("video/") ? item.key.slice("video/".length) : item.key;
      const postId = extractPostIdFromAssetName(name);
      const viewUrl = `/images/${encodeURIComponent(name)}`;
      return {
        name,
        size_bytes: item.size,
        mtime_ms: item.last_access_at || item.created_at,
        preview_url: viewUrl,
        view_url: viewUrl,
        post_id: postId || undefined,
        root_attachment_id: postId || undefined,
      };
    }),
  });
});

functionRoutes.post("/v1/function/video/upscale", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const videoUrl = extractOptionalString(body.video_url);
  const videoId =
    extractOptionalString(body.video_id) ||
    (videoUrl ? extractVideoId(videoUrl) : "") ||
    "";

  if (!videoId) {
    return c.json({ error: "video_id is required", code: "invalid_video_id" }, 400);
  }

  const settings = await getSettings(c.env);
  const chosen = await selectBestToken(c.env.DB, "grok-imagine-1.0-video");
  if (!chosen) {
    return c.json({ error: "No available tokens for video upscale", code: "no_token" }, 503);
  }

  const cf = normalizeCfCookie(settings.grok.cf_clearance ?? "");
  const cookie = cf
    ? `sso-rw=${chosen.token};sso=${chosen.token};${cf}`
    : `sso-rw=${chosen.token};sso=${chosen.token}`;
  const result = await upscaleVideoById({
    videoId,
    cookie,
    settings: settings.grok,
  });

  if (!result.upscaled || !result.videoUrl) {
    return c.json({ error: "Video upscale failed", code: "video_upscale_failed" }, 502);
  }

  return c.json({
    video_id: videoId,
    hd_media_url: result.videoUrl,
    video_url: toProxyAssetUrl(result.videoUrl),
    upscaled: true,
  });
});

functionRoutes.get("/v1/function/video/sse", async (c) => {
  const taskId = String(c.req.query("task_id") ?? "").trim();
  const session = await getFunctionSession<VideoSessionPayload>(c.env.DB, taskId, "video");
  if (!session) {
    return c.json({ error: "Task not found", code: "TASK_NOT_FOUND" }, 404);
  }

  const request = await buildInternalRequest(c, "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildVideoChatBody(session.payload)),
  });

  const response = await openAiRoutes.fetch(request, c.env, c.executionCtx);
  c.executionCtx.waitUntil(deleteFunctionSessions(c.env.DB, [taskId], "video").then(() => undefined));
  return response;
});

functionRoutes.post("/v1/function/video/stop", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { task_ids?: string[] };
  const removed = await deleteFunctionSessions(c.env.DB, body.task_ids ?? [], "video");
  return c.json({ status: "success", removed });
});

functionRoutes.get("/v1/function/voice/token", async (c) => {
  const voice = String(c.req.query("voice") ?? "ara").trim() || "ara";
  const personality = String(c.req.query("personality") ?? "assistant").trim() || "assistant";
  const speed = Number(c.req.query("speed") ?? 1);
  return buildVoiceTokenResponse(c.env, { voice, personality, speed });
});
