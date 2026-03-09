export const FUNCTION_SESSION_TTL_SECONDS = 10 * 60;
export const FUNCTION_SESSION_TTL_MS = FUNCTION_SESSION_TTL_SECONDS * 1000;

const IMAGE_SIZE_BY_ASPECT_RATIO: Record<string, string> = {
  "16:9": "1280x720",
  "9:16": "720x1280",
  "3:2": "1792x1024",
  "2:3": "1024x1792",
  "1:1": "1024x1024",
};

const VIDEO_ASPECT_RATIO_MAP: Record<string, string> = {
  "1280x720": "16:9",
  "720x1280": "9:16",
  "1792x1024": "3:2",
  "1024x1792": "2:3",
  "1024x1024": "1:1",
  "16:9": "16:9",
  "9:16": "9:16",
  "3:2": "3:2",
  "2:3": "2:3",
  "1:1": "1:1",
};

export function chooseImageSizeFromAspectRatio(aspectRatio: string): string {
  return IMAGE_SIZE_BY_ASPECT_RATIO[String(aspectRatio ?? "").trim()] ?? "1024x1792";
}

export function normalizeImagineAspectRatio(aspectRatio: string): string {
  const normalized = String(aspectRatio ?? "").trim();
  return IMAGE_SIZE_BY_ASPECT_RATIO[normalized] ? normalized : "2:3";
}

export function normalizeVideoAspectRatio(aspectRatio: string): string {
  return VIDEO_ASPECT_RATIO_MAP[String(aspectRatio ?? "").trim()] ?? "3:2";
}

export function isFunctionSessionExpired(createdAtMs: number, nowMs: number): boolean {
  return nowMs - createdAtMs > FUNCTION_SESSION_TTL_SECONDS;
}
