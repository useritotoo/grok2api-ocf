import type { GrokSettings } from "../settings";
import { getDynamicHeaders } from "./headers";
import { arrayBufferToBase64 } from "../utils/base64";
import type { Env } from "../env";

const UPLOAD_API = "https://grok.com/rest/app-chat/upload-file";

const IMAGE_MIME_DEFAULT = "image/jpeg";
const FILE_MIME_DEFAULT = "application/octet-stream";

function isUrl(input: string): boolean {
  try {
    const u = new URL(input);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function guessExtFromMime(mime: string): string {
  const m = mime.split(";")[0]?.trim() ?? "";
  if (m === "text/plain") return "txt";
  if (m === "application/json") return "json";
  if (m === "text/markdown") return "md";
  if (m === "text/html") return "html";
  if (m === "text/css") return "css";
  if (m === "text/javascript" || m === "application/javascript") return "js";
  if (m === "application/typescript" || m === "text/typescript") return "ts";
  if (m === "text/csv") return "csv";
  if (m === "application/pdf") return "pdf";
  const parts = m.split("/");
  return parts.length === 2 && parts[1] ? parts[1] : "bin";
}

function parseDataUrl(dataUrl: string): { base64: string; mime: string } {
  const trimmed = dataUrl.trim();
  const comma = trimmed.indexOf(",");
  if (comma === -1) return { base64: trimmed, mime: FILE_MIME_DEFAULT };
  const header = trimmed.slice(0, comma);
  const base64 = trimmed.slice(comma + 1);
  const match = header.match(/^data:([^;,]+)(?:;[^,]*)?;base64$/i);
  return { base64, mime: match?.[1] ?? FILE_MIME_DEFAULT };
}

function sanitizeBaseName(baseName: string): string {
  const safe = String(baseName || "attachment")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe || "attachment";
}

export function prepareUploadAttachment(
  input: string,
  baseName = "attachment",
): { base64: string; mime: string; filename: string } {
  const trimmed = String(input || "").trim();
  if (trimmed.startsWith("data:")) {
    const parsed = parseDataUrl(trimmed);
    const mime = parsed.mime || FILE_MIME_DEFAULT;
    return {
      base64: parsed.base64,
      mime,
      filename: `${sanitizeBaseName(baseName)}.${guessExtFromMime(mime)}`,
    };
  }

  return {
    base64: trimmed,
    mime: FILE_MIME_DEFAULT,
    filename: `${sanitizeBaseName(baseName)}.${guessExtFromMime(FILE_MIME_DEFAULT)}`,
  };
}

export async function uploadAttachment(
  attachmentInput: string,
  cookie: string,
  settings: GrokSettings,
  kvCache?: Env["KV_CACHE"],
  baseName = "attachment",
): Promise<{ fileId: string; fileUri: string }> {
  let base64 = "";
  let mime = FILE_MIME_DEFAULT;
  let filename = `${sanitizeBaseName(baseName)}.${guessExtFromMime(FILE_MIME_DEFAULT)}`;

  const selfUrlMatch = attachmentInput.match(/\/images\/(upload-[^?#]+)/)
    || attachmentInput.match(/\/v1\/files\/image\/(upload-[^?#]+)/);
  if (selfUrlMatch && kvCache) {
    const internalKey = `image/${decodeURIComponent(selfUrlMatch[1]!)}`;
    const cached = await kvCache.getWithMetadata<{ contentType?: string }>(internalKey, { type: "arrayBuffer" });
    if (cached?.value) {
      base64 = arrayBufferToBase64(cached.value);
      mime = cached.metadata?.contentType || IMAGE_MIME_DEFAULT;
      filename = `${sanitizeBaseName(baseName)}.${guessExtFromMime(mime)}`;
    } else {
      throw new Error(`鏃犳硶鑾峰彇鏈湴涓婁紶鐨勫弬鑰冨浘(鍙兘宸茶繃鏈熸垨璺ㄨ妭鐐瑰悓姝ュ欢杩?锛岃閲嶆柊涓婁紶`);
    }
  } else if (isUrl(attachmentInput)) {
    const r = await fetch(attachmentInput, { redirect: "follow" });
    if (!r.ok) throw new Error(`涓嬭浇鍥剧墖澶辫触: ${r.status}`);
    mime = r.headers.get("content-type")?.split(";")[0] ?? FILE_MIME_DEFAULT;
    base64 = arrayBufferToBase64(await r.arrayBuffer());
    filename = `${sanitizeBaseName(baseName)}.${guessExtFromMime(mime)}`;
  } else {
    const prepared = prepareUploadAttachment(attachmentInput, baseName);
    base64 = prepared.base64;
    mime = prepared.mime;
    filename = prepared.filename;
  }

  const body = JSON.stringify({
    fileName: filename,
    fileMimeType: mime,
    content: base64,
  });

  const headers = getDynamicHeaders(settings, "/rest/app-chat/upload-file");
  headers.Cookie = cookie;

  const resp = await fetch(UPLOAD_API, { method: "POST", headers, body });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`涓婁紶澶辫触: ${resp.status} ${text.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { fileMetadataId?: string; fileUri?: string };
  return { fileId: data.fileMetadataId ?? "", fileUri: data.fileUri ?? "" };
}

export async function uploadImage(
  imageInput: string,
  cookie: string,
  settings: GrokSettings,
  kvCache?: Env["KV_CACHE"],
): Promise<{ fileId: string; fileUri: string }> {
  return uploadAttachment(imageInput, cookie, settings, kvCache, "image");
}
