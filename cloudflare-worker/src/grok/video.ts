import type { GrokSettings } from "../settings";
import { getDynamicHeaders } from "./headers";

const VIDEO_UPSCALE_API = "https://grok.com/rest/media/video/upscale";
const POST_ID_URL_PATTERNS = [
  /\/generated\/([0-9a-fA-F-]{32,36})\//,
  /\/([0-9a-fA-F-]{32,36})\/generated_video/,
] as const;

export type VideoResolution = "SD" | "HD";
export type VideoResolutionName = "480p" | "720p";
export type WorkerVideoTokenType = "sso" | "ssoSuper";

export interface VideoConfigInput {
  resolution?: string;
  resolution_name?: string;
  video_length?: number;
}

export interface NormalizedVideoRequest {
  resolution: VideoResolution;
  resolutionName: VideoResolutionName;
  videoLength: number;
}

export interface VideoGenerationPlan extends NormalizedVideoRequest {
  requestedResolution: VideoResolution;
  requestedResolutionName: VideoResolutionName;
  generationResolution: VideoResolution;
  generationResolutionName: VideoResolutionName;
  shouldUpscale: boolean;
  upscaleTiming: "single" | "complete";
}

function normalizeVideoResolutionName(value: unknown): VideoResolutionName | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "720p") return "720p";
  if (normalized === "480p") return "480p";
  return null;
}

function normalizeVideoResolution(value: unknown): VideoResolution | null {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (normalized === "HD") return "HD";
  if (normalized === "SD") return "SD";
  return null;
}

function normalizeVideoLength(value: unknown): number {
  const parsed = Number(value ?? 6);
  if (!Number.isFinite(parsed)) return 6;
  return Math.max(1, Math.floor(parsed));
}

export function normalizeVideoRequest(input?: VideoConfigInput | null): NormalizedVideoRequest {
  const resolutionName = normalizeVideoResolutionName(input?.resolution_name);
  const resolution = normalizeVideoResolution(input?.resolution);
  const resolvedResolutionName =
    resolutionName ?? (resolution === "HD" ? "720p" : "480p");
  const resolvedResolution =
    resolution ?? (resolvedResolutionName === "720p" ? "HD" : "SD");

  return {
    resolution: resolvedResolution,
    resolutionName: resolvedResolutionName,
    videoLength: normalizeVideoLength(input?.video_length),
  };
}

export function requiresSuperVideoToken(input?: VideoConfigInput | null): boolean {
  const normalized = normalizeVideoRequest(input);
  return normalized.resolutionName === "720p" || normalized.videoLength > 6;
}

export function resolveVideoUpscaleTiming(value: unknown): "single" | "complete" {
  const normalized = String(value ?? "complete").trim().toLowerCase();
  return normalized === "single" ? "single" : "complete";
}

export function buildVideoGenerationPlan(args: {
  videoConfig?: VideoConfigInput | null;
  tokenType: WorkerVideoTokenType;
  upscaleTiming?: unknown;
}): VideoGenerationPlan {
  const normalized = normalizeVideoRequest(args.videoConfig);
  const shouldUpscale =
    normalized.resolutionName === "720p" && args.tokenType !== "ssoSuper";
  const generationResolutionName = shouldUpscale ? "480p" : normalized.resolutionName;
  const generationResolution =
    generationResolutionName === "720p" ? "HD" : "SD";

  return {
    ...normalized,
    requestedResolution: normalized.resolution,
    requestedResolutionName: normalized.resolutionName,
    generationResolution,
    generationResolutionName,
    shouldUpscale,
    upscaleTiming: shouldUpscale
      ? resolveVideoUpscaleTiming(args.upscaleTiming)
      : "complete",
  };
}

export function extractVideoId(videoUrl: string): string {
  const candidate = String(videoUrl ?? "").trim();
  if (!candidate) return "";

  for (const pattern of POST_ID_URL_PATTERNS) {
    const match = pattern.exec(candidate);
    if (match?.[1]) return match[1];
  }

  return "";
}

async function requestVideoUpscale(args: {
  videoId: string;
  cookie: string;
  settings: GrokSettings;
}): Promise<{ videoUrl: string; upscaled: boolean }> {
  try {
    const headers = getDynamicHeaders(args.settings, "/rest/media/video/upscale");
    headers.Cookie = args.cookie;
    headers.Referer = `https://grok.com/imagine/post/${args.videoId}`;

    const response = await fetch(VIDEO_UPSCALE_API, {
      method: "POST",
      headers,
      body: JSON.stringify({ videoId: args.videoId }),
    });
    if (!response.ok) {
      console.warn(`Video upscale failed with status ${response.status}`);
      return { videoUrl: "", upscaled: false };
    }

    const payload = (await response.json().catch(() => ({}))) as {
      hdMediaUrl?: unknown;
    };
    const hdMediaUrl = String(payload.hdMediaUrl ?? "").trim();
    if (!hdMediaUrl) {
      return { videoUrl: "", upscaled: false };
    }

    return { videoUrl: hdMediaUrl, upscaled: true };
  } catch (error) {
    console.warn(
      `Video upscale request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { videoUrl: "", upscaled: false };
  }
}

export async function upscaleVideoById(args: {
  videoId: string;
  cookie: string;
  settings: GrokSettings;
}): Promise<{ videoUrl: string; upscaled: boolean }> {
  const videoId = String(args.videoId ?? "").trim();
  if (!videoId) {
    return { videoUrl: "", upscaled: false };
  }
  return requestVideoUpscale({
    videoId,
    cookie: args.cookie,
    settings: args.settings,
  });
}

export async function upscaleVideoUrl(args: {
  videoUrl: string;
  cookie: string;
  settings: GrokSettings;
}): Promise<{ videoUrl: string; upscaled: boolean }> {
  const videoId = extractVideoId(args.videoUrl);
  if (!videoId) {
    return { videoUrl: args.videoUrl, upscaled: false };
  }

  const result = await requestVideoUpscale({
    videoId,
    cookie: args.cookie,
    settings: args.settings,
  });
  if (!result.upscaled || !result.videoUrl) {
    return { videoUrl: args.videoUrl, upscaled: false };
  }

  return result;
}
