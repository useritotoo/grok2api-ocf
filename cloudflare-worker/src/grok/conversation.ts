import type { GrokSettings } from "../settings";
import { getDynamicHeaders } from "./headers";
import { getModelInfo, toGrokModel } from "./models";

export interface OpenAIChatContentPart {
  type: string;
  text?: string;
  image_url?: { url?: string };
  input_audio?: { data?: string };
  file?: { url?: string; data?: string; file_data?: string } | string;
}

export interface OpenAIChatMessage {
  role: string;
  content: string | OpenAIChatContentPart[];
}

export interface ConversationAttachment {
  kind: "image" | "file" | "audio";
  value: string;
}

export interface OpenAIChatRequestBody {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  video_config?: {
    aspect_ratio?: string;
    video_length?: number;
    resolution?: string;
    preset?: string;
  };
}

export const CONVERSATION_API = "https://grok.com/rest/app-chat/conversations/new";

function extractFileValue(item: OpenAIChatContentPart): string {
  if (!item) return "";
  if (typeof item.file === "string") return String(item.file).trim();
  if (item.file && typeof item.file === "object") {
    return String(item.file.file_data ?? item.file.data ?? item.file.url ?? "").trim();
  }
  return "";
}

function isLikelyImageAttachment(value: string): boolean {
  const candidate = String(value || "").trim().toLowerCase();
  if (!candidate) return false;
  if (candidate.startsWith("data:image/")) return true;
  if (candidate.startsWith("/images/") || candidate.startsWith("/v1/files/image/")) return true;
  return /\.(png|jpe?g|gif|webp|bmp|svg)(?:[?#].*)?$/.test(candidate);
}

export function extractContent(messages: OpenAIChatMessage[]): {
  content: string;
  attachments: ConversationAttachment[];
} {
  const attachments: ConversationAttachment[] = [];
  const extracted: Array<{ role: string; text: string }> = [];

  for (const msg of messages) {
    const role = msg.role ?? "user";
    const content = msg.content ?? "";

    const parts: string[] = [];
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item?.type === "text") {
          const t = item.text ?? "";
          if (t.trim()) parts.push(t);
        }
        if (item?.type === "image_url") {
          const url = item.image_url?.url;
          if (url) attachments.push({ kind: "image", value: url });
        }
        if (item?.type === "input_audio") {
          const data = String(item.input_audio?.data ?? "").trim();
          if (data) attachments.push({ kind: "audio", value: data });
        }
        if (item?.type === "file") {
          const value = extractFileValue(item);
          if (value) {
            attachments.push({
              kind: isLikelyImageAttachment(value) ? "image" : "file",
              value,
            });
          }
        }
      }
    } else {
      const t = String(content);
      if (t.trim()) parts.push(t);
    }

    if (parts.length) extracted.push({ role, text: parts.join("\n") });
  }

  let lastUserIndex: number | null = null;
  for (let i = extracted.length - 1; i >= 0; i--) {
    if (extracted[i]!.role === "user") {
      lastUserIndex = i;
      break;
    }
  }

  const out: string[] = [];
  for (let i = 0; i < extracted.length; i++) {
    const role = extracted[i]!.role || "user";
    const text = extracted[i]!.text;
    if (i === lastUserIndex) out.push(text);
    else out.push(`${role}: ${text}`);
  }

  return { content: out.join("\n\n"), attachments };
}

export function buildConversationPayload(args: {
  requestModel: string;
  content: string;
  fileIds: string[];
  imgIds: string[];
  imgUris: string[];
  postId?: string;
  videoConfig?: {
    aspect_ratio?: string;
    video_length?: number;
    resolution?: string;
    preset?: string;
  };
  settings: GrokSettings;
}): { payload: Record<string, unknown>; referer?: string; isVideoModel: boolean } {
  const { requestModel, content, fileIds, imgIds, imgUris, postId, settings } = args;
  const cfg = getModelInfo(requestModel);
  const { grokModel, mode, isVideoModel } = toGrokModel(requestModel);

  if (cfg?.is_video_model) {
    if (!postId) throw new Error("Video model requires a media post id.");

    const aspectRatio = (args.videoConfig?.aspect_ratio ?? "").trim() || "3:2";
    const videoLengthRaw = Number(args.videoConfig?.video_length ?? 6);
    const videoLength = Number.isFinite(videoLengthRaw) ? Math.max(1, Math.floor(videoLengthRaw)) : 6;
    const resolution = (args.videoConfig?.resolution ?? "SD") === "HD" ? "HD" : "SD";
    const preset = (args.videoConfig?.preset ?? "normal").trim();

    let modeFlag = "--mode=custom";
    if (preset === "fun") modeFlag = "--mode=extremely-crazy";
    else if (preset === "normal") modeFlag = "--mode=normal";
    else if (preset === "spicy") modeFlag = "--mode=extremely-spicy-or-crazy";

    const prompt = `${String(content || "").trim()} ${modeFlag}`.trim();

    return {
      isVideoModel: true,
      referer: "https://grok.com/imagine",
      payload: {
        temporary: true,
        modelName: "grok-3",
        message: prompt,
        fileAttachments: [...fileIds, ...imgIds],
        toolOverrides: { videoGen: true },
        enableSideBySide: true,
        responseMetadata: {
          experiments: [],
          modelConfigOverride: {
            modelMap: {
              videoGenModelConfig: {
                parentPostId: postId,
                aspectRatio,
                videoLength,
                videoResolution: resolution,
              },
            },
          },
        },
      },
    };
  }

  return {
    isVideoModel,
    payload: {
      temporary: settings.temporary ?? true,
      modelName: grokModel,
      message: content,
      fileAttachments: [...fileIds, ...imgIds],
      imageAttachments: [],
      disableSearch: false,
      enableImageGeneration: true,
      returnImageBytes: false,
      returnRawGrokInXaiRequest: false,
      enableImageStreaming: true,
      imageGenerationCount: 2,
      forceConcise: false,
      toolOverrides: {},
      enableSideBySide: true,
      sendFinalMetadata: true,
      isReasoning: false,
      webpageUrls: [],
      disableTextFollowUps: true,
      responseMetadata: { requestModelDetails: { modelId: grokModel } },
      disableMemory: false,
      forceSideBySide: false,
      modelMode: mode,
      isAsyncChat: false,
    },
  };
}

export async function sendConversationRequest(args: {
  payload: Record<string, unknown>;
  cookie: string;
  settings: GrokSettings;
  referer?: string;
}): Promise<Response> {
  const { payload, cookie, settings, referer } = args;
  const headers = getDynamicHeaders(settings, "/rest/app-chat/conversations/new");
  headers.Cookie = cookie;
  if (referer) headers.Referer = referer;
  const body = JSON.stringify(payload);

  return fetch(CONVERSATION_API, { method: "POST", headers, body });
}
