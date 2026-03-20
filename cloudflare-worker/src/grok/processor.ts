import type { GrokSettings, GlobalSettings } from "../settings";
import { consumeNdjsonObjects } from "../utils/ndjson";

type GrokNdjson = Record<string, unknown>;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function resolveStreamReadTimeoutMs(value: unknown): number | null {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.max(1, Math.floor(seconds * 1000));
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms: number,
): Promise<ReadableStreamReadResult<Uint8Array> | { timeout: true }> {
  if (ms <= 0) return { timeout: true };
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ timeout: true } as const), ms);
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

function makeChunk(
  id: string,
  created: number,
  model: string,
  content: string,
  finish_reason?: "stop" | "error" | null,
): string {
  const payload: Record<string, unknown> = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: content ? { role: "assistant", content } : {},
        finish_reason: finish_reason ?? null,
      },
    ],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function makeDone(): string {
  return "data: [DONE]\n\n";
}

function toImgProxyUrl(globalCfg: GlobalSettings, origin: string, path: string): string {
  const baseUrl = (globalCfg.base_url ?? "").trim() || origin;
  return `${baseUrl}/images/${path}`;
}

function buildVideoTag(src: string): string {
  return `<video src="${src}" controls="controls" width="500" height="300"></video>\n`;
}

function buildVideoPosterPreview(videoUrl: string, posterUrl?: string): string {
  const href = String(videoUrl || "").replace(/"/g, "&quot;");
  const poster = String(posterUrl || "").replace(/"/g, "&quot;");
  if (!href) return "";
  if (!poster) return `<a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>\n`;
  return `<a href="${href}" target="_blank" rel="noopener noreferrer" style="display:inline-block;position:relative;max-width:100%;text-decoration:none;">
  <img src="${poster}" alt="video" style="max-width:100%;height:auto;border-radius:12px;display:block;" />
  <span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;">
    <span style="width:64px;height:64px;border-radius:9999px;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;">
      <span style="width:0;height:0;border-top:12px solid transparent;border-bottom:12px solid transparent;border-left:18px solid #fff;margin-left:4px;"></span>
    </span>
  </span>
</a>\n`;
}

function buildVideoHtml(args: { videoUrl: string; posterUrl?: string; posterPreview: boolean }): string {
  if (args.posterPreview) return buildVideoPosterPreview(args.videoUrl, args.posterUrl);
  return buildVideoTag(args.videoUrl);
}

function normalizeVideoFormat(value: unknown): "url" | "markdown" | "html" {
  const normalized = String(value ?? "html").trim().toLowerCase();
  if (normalized === "url") return "url";
  if (normalized === "markdown") return "markdown";
  return "html";
}

function buildVideoContent(args: {
  videoUrl: string;
  posterUrl?: string;
  posterPreview: boolean;
  format?: unknown;
}): string {
  const format = normalizeVideoFormat(args.format);
  if (format === "url") return `${args.videoUrl}\n`;
  if (format === "markdown") return `[video](${args.videoUrl})`;
  return buildVideoHtml(args);
}

type VideoAssetPayload = {
  videoUrl: string;
  thumbnailUrl?: string;
};

type VideoAssetRender = {
  videoUrl: string;
  posterUrl?: string;
};

type VideoAssetTransformer = (
  asset: VideoAssetPayload,
) => Promise<VideoAssetPayload | null | undefined> | VideoAssetPayload | null | undefined;

async function resolveVideoRender(args: {
  global: GlobalSettings;
  origin: string;
  asset: VideoAssetPayload;
  transformVideoAsset?: VideoAssetTransformer;
}): Promise<VideoAssetRender | null> {
  const transformed = args.transformVideoAsset ? await args.transformVideoAsset(args.asset) : args.asset;
  const resolvedAsset = transformed ?? args.asset;
  const videoUrl = String(resolvedAsset.videoUrl ?? "").trim();
  if (!videoUrl) return null;

  const videoPath = encodeAssetPath(videoUrl);
  const render: VideoAssetRender = {
    videoUrl: toImgProxyUrl(args.global, args.origin, videoPath),
  };

  const thumbnailUrl = String(resolvedAsset.thumbnailUrl ?? "").trim();
  if (thumbnailUrl) {
    const thumbPath = encodeAssetPath(thumbnailUrl);
    render.posterUrl = toImgProxyUrl(args.global, args.origin, thumbPath);
  }

  return render;
}

function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function encodeAssetPath(raw: string): string {
  try {
    const u = new URL(raw);
    // Keep full URL (query etc.) to avoid lossy pathname-only encoding (some URLs may encode the real path in query).
    return `u_${base64UrlEncode(u.toString())}`;
  } catch {
    const p = raw.startsWith("/") ? raw : `/${raw}`;
    return `p_${base64UrlEncode(p)}`;
  }
}

function normalizeGeneratedAssetUrls(input: unknown): string[] {
  if (!Array.isArray(input)) return [];

  const out: string[] = [];
  for (const v of input) {
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (!s) continue;
    if (s === "/") continue;

    try {
      const u = new URL(s);
      if (u.pathname === "/" && !u.search && !u.hash) continue;
    } catch {
      // ignore (path-style strings are allowed)
    }

    out.push(s);
  }

  return out;
}

function buildMarkdownImage(title: string, url: string): string {
  const normalizedTitle = title.replace(/\n/g, " ").trim() || "image";
  return `![${normalizedTitle}](${url})`;
}

function parseJsonLike(input: unknown): unknown {
  if (typeof input !== "string") return input;
  const raw = input.trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeCardPayload(input: unknown): Record<string, unknown> | null {
  const parsed = parseJsonLike(input);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  const nested = parseJsonLike(record.jsonData);
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return record;

  const nestedRecord = nested as Record<string, unknown>;
  const mergedId = String(nestedRecord.id ?? record.id ?? "").trim();
  return {
    ...record,
    ...nestedRecord,
    ...(mergedId ? { id: mergedId } : {}),
  };
}

function extractCardImageInfo(input: unknown): { id: string; title: string; original: string } | null {
  const record = normalizeCardPayload(input);
  if (!record) return null;
  const image = record.image;
  if (!image || typeof image !== "object" || Array.isArray(image)) return null;

  const original = String((image as Record<string, unknown>).original ?? "").trim();
  if (!original) return null;

  return {
    id: String(record.id ?? "").trim(),
    title: String((image as Record<string, unknown>).title ?? ""),
    original,
  };
}

function extractCardAttachmentMarkdown(cardAttachment: unknown): string | null {
  const info = extractCardImageInfo(cardAttachment);
  if (!info) return null;
  return buildMarkdownImage(info.title, info.original);
}

function replaceRenderCardsWithMarkdown(content: string, cardAttachmentsJson: unknown): string {
  if (!content || !Array.isArray(cardAttachmentsJson) || !cardAttachmentsJson.length) return content;

  const cardMap = new Map<string, { title: string; original: string }>();
  for (const raw of cardAttachmentsJson) {
    const info = extractCardImageInfo(raw);
    if (!info?.id) continue;
    cardMap.set(info.id, { title: info.title, original: info.original });
  }

  if (!cardMap.size) return content;

  return content.replace(
    /<grok:render[^>]*card_id="([^"]+)"[^>]*>.*?<\/grok:render>/g,
    (match, cardId: string, offset: number) => {
      const item = cardMap.get(cardId);
      if (!item) return "";
      const prefix = offset > 0 && content[offset - 1] !== "\n" && content[offset - 1] !== "\r" ? "\n" : "";
      return `${prefix}${buildMarkdownImage(item.title, item.original)}`;
    },
  );
}

function stripThinkMarkup(content: string): string {
  return String(content ?? "").replace(/<\/?think>/g, "");
}

function normalizeLooseWhitespace(content: string): string {
  return String(content ?? "").replace(/\s+/g, " ").trim();
}

function findFlexiblePrefixEnd(finalMessage: string, streamedText: string): number {
  if (!streamedText) return 0;

  let finalIndex = 0;
  let streamedIndex = 0;
  while (finalIndex < finalMessage.length && streamedIndex < streamedText.length) {
    const finalChar = finalMessage[finalIndex];
    const streamedChar = streamedText[streamedIndex];
    if (finalChar === streamedChar) {
      finalIndex += 1;
      streamedIndex += 1;
      continue;
    }
    if (/\s/.test(finalChar) && /\s/.test(streamedChar)) {
      while (finalIndex < finalMessage.length && /\s/.test(finalMessage[finalIndex])) finalIndex += 1;
      while (streamedIndex < streamedText.length && /\s/.test(streamedText[streamedIndex])) streamedIndex += 1;
      continue;
    }
    return -1;
  }
  return streamedIndex === streamedText.length ? finalIndex : -1;
}

function buildFinalMessageSuffix(finalMessage: string, streamedAnswerText: string): string {
  const streamedText = stripThinkMarkup(streamedAnswerText);
  if (!streamedText) return finalMessage;
  if (normalizeLooseWhitespace(finalMessage) === normalizeLooseWhitespace(streamedText)) {
    return "";
  }
  if (finalMessage.startsWith(streamedText)) {
    return finalMessage.slice(streamedText.length);
  }

  const overlapEnd = findFlexiblePrefixEnd(finalMessage, streamedText);
  if (overlapEnd >= 0) {
    return finalMessage.slice(overlapEnd);
  }

  const streamedOverlapEnd = findFlexiblePrefixEnd(streamedText, finalMessage);
  if (streamedOverlapEnd >= 0 && !streamedText.slice(streamedOverlapEnd).trim()) {
    return "";
  }

  return finalMessage;
}

export function createOpenAiStreamFromGrokNdjson(
  grokResp: Response,
  opts: {
    cookie: string;
    settings: GrokSettings;
    global: GlobalSettings;
    origin: string;
    requestedModel: string;
    videoMode?: "eager" | "finalize";
    videoFormat?: unknown;
    transformVideoAsset?: VideoAssetTransformer;
    onFinish?: (result: { status: number; duration: number }) => Promise<void> | void;
  },
): ReadableStream<Uint8Array> {
  const { settings, global, origin } = opts;
  const fallbackModel =
    typeof opts.requestedModel === "string" && opts.requestedModel.trim()
      ? opts.requestedModel.trim()
      : "grok-4";
  const videoMode = opts.videoMode ?? "eager";
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  const filteredTags = (settings.filtered_tags ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const showThinking = settings.show_thinking !== false;

  const firstTimeoutMs = Math.max(0, (settings.stream_first_response_timeout ?? 30) * 1000);
  const chunkTimeoutMs = Math.max(0, (settings.stream_chunk_timeout ?? 120) * 1000);
  const totalTimeoutMs = Math.max(0, (settings.stream_total_timeout ?? 600) * 1000);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const body = grokResp.body;
      if (!body) {
        controller.enqueue(encoder.encode(makeChunk(id, created, fallbackModel, "Empty response", "error")));
        controller.enqueue(encoder.encode(makeDone()));
        controller.close();
        return;
      }

      const reader = body.getReader();
      const startTime = Date.now();
      let finalStatus = 200;
      let lastChunkTime = startTime;
      let firstReceived = false;

      let currentModel = fallbackModel;
      let isImage = false;
      let isThinking = false;
      let thinkingFinished = false;
      let streamedAnswerText = "";
      let videoProgressStarted = false;
      let lastVideoProgress = -1;
      let pendingVideoAsset: VideoAssetPayload | null = null;
      let finalVideoEmitted = false;

      let buffer = "";

      const closeThinkingPrefix = () => {
        if (!isThinking) return "";
        thinkingFinished = true;
        isThinking = false;
        return showThinking ? "\n</think>\n" : "";
      };

      const emitVideoAsset = async (asset: VideoAssetPayload) => {
        const render = await resolveVideoRender({
          global,
          origin,
          asset,
          transformVideoAsset: opts.transformVideoAsset,
        });
        if (!render) return;
        finalVideoEmitted = true;
        controller.enqueue(
          encoder.encode(
            makeChunk(
              id,
              created,
              currentModel,
              buildVideoContent({
                videoUrl: render.videoUrl,
                posterPreview: settings.video_poster_preview === true,
                ...(render.posterUrl ? { posterUrl: render.posterUrl } : {}),
                format: opts.videoFormat,
              }),
            ),
          ),
        );
      };

      const flushPendingVideoAsset = async () => {
        if (!pendingVideoAsset || finalVideoEmitted) return;
        const asset = pendingVideoAsset;
        pendingVideoAsset = null;
        await emitVideoAsset(asset);
      };

      const flushStop = async () => {
        await flushPendingVideoAsset();
        const closing = closeThinkingPrefix();
        if (closing) {
          controller.enqueue(encoder.encode(makeChunk(id, created, currentModel, closing)));
        }
        controller.enqueue(encoder.encode(makeChunk(id, created, currentModel, "", "stop")));
        controller.enqueue(encoder.encode(makeDone()));
      };

      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const now = Date.now();
          const elapsed = now - startTime;
          if (!firstReceived && elapsed > firstTimeoutMs) {
            await flushStop();
            if (opts.onFinish) await opts.onFinish({ status: finalStatus, duration: (Date.now() - startTime) / 1000 });
            controller.close();
            return;
          }
          if (totalTimeoutMs > 0 && elapsed > totalTimeoutMs) {
            await flushStop();
            if (opts.onFinish) await opts.onFinish({ status: finalStatus, duration: (Date.now() - startTime) / 1000 });
            controller.close();
            return;
          }
          const idle = now - lastChunkTime;
          if (firstReceived && idle > chunkTimeoutMs) {
            await flushStop();
            if (opts.onFinish) await opts.onFinish({ status: finalStatus, duration: (Date.now() - startTime) / 1000 });
            controller.close();
            return;
          }

          const perReadTimeout = Math.min(
            firstReceived ? chunkTimeoutMs : firstTimeoutMs,
            totalTimeoutMs > 0 ? Math.max(0, totalTimeoutMs - elapsed) : Number.POSITIVE_INFINITY,
          );

          const res = await readWithTimeout(reader, perReadTimeout);
          if ("timeout" in res) {
            await flushStop();
            if (opts.onFinish) await opts.onFinish({ status: finalStatus, duration: (Date.now() - startTime) / 1000 });
            controller.close();
            return;
          }

          const { value, done } = res;
          if (done) break;
          if (!value) continue;
          buffer += decoder.decode(value, { stream: true });

          let idx: number;
          while ((idx = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line) continue;

            let data: GrokNdjson;
            try {
              data = JSON.parse(line) as GrokNdjson;
            } catch {
              continue;
            }

            firstReceived = true;
            lastChunkTime = Date.now();

            const err = (data as any).error;
            if (err?.message) {
              finalStatus = 500;
              controller.enqueue(
                encoder.encode(makeChunk(id, created, currentModel, `Error: ${String(err.message)}`, "stop")),
              );
              controller.enqueue(encoder.encode(makeDone()));
              if (opts.onFinish) await opts.onFinish({ status: finalStatus, duration: (Date.now() - startTime) / 1000 });
              controller.close();
              return;
            }

            const grok = (data as any).result?.response;
            if (!grok) continue;

            const userRespModel = grok.userResponse?.model;
            if (typeof userRespModel === "string" && userRespModel.trim()) currentModel = userRespModel.trim();
            const modelResp = grok.modelResponse;
            if (typeof modelResp?.model === "string" && modelResp.model.trim()) {
              currentModel = modelResp.model.trim();
            }

            // Video generation stream
            const videoResp = grok.streamingVideoGenerationResponse;
            if (videoResp) {
              const progress = typeof videoResp.progress === "number" ? videoResp.progress : 0;
              const videoUrl = typeof videoResp.videoUrl === "string" ? videoResp.videoUrl : "";
              const thumbUrl = typeof videoResp.thumbnailImageUrl === "string" ? videoResp.thumbnailImageUrl : "";

              if (progress > lastVideoProgress) {
                lastVideoProgress = progress;
                if (showThinking) {
                  let msg = "";
                  if (!videoProgressStarted) {
                    msg = `<think>视频已生成${progress}%\n`;
                    videoProgressStarted = true;
                  } else if (progress < 100) {
                    msg = `视频已生成${progress}%\n`;
                  } else {
                    msg = `视频已生成${progress}%</think>\n`;
                  }
                  controller.enqueue(encoder.encode(makeChunk(id, created, currentModel, msg)));
                }
              }

              if (videoUrl) {
                const asset: VideoAssetPayload = {
                  videoUrl,
                  ...(thumbUrl ? { thumbnailUrl: thumbUrl } : {}),
                };
                if (videoMode === "finalize") {
                  pendingVideoAsset = asset;
                } else {
                  await emitVideoAsset(asset);
                }
              }
              continue;
            }

            if (grok.imageAttachmentInfo) isImage = true;
            const rawToken = grok.token;
            const cardMarkdown = extractCardAttachmentMarkdown(grok.cardAttachment);

            if (isImage) {
              if (modelResp) {
                const urls = normalizeGeneratedAssetUrls(modelResp.generatedImageUrls);
                if (urls.length) {
                  const linesOut: string[] = [];
                  for (const u of urls) {
                    const imgPath = encodeAssetPath(u);
                    const imgUrl = toImgProxyUrl(global, origin, imgPath);
                    linesOut.push(`![Generated Image](${imgUrl})`);
                  }
                  controller.enqueue(
                    encoder.encode(
                      makeChunk(id, created, currentModel, `${closeThinkingPrefix()}${linesOut.join("\n")}`, "stop"),
                    ),
                  );
                  controller.enqueue(encoder.encode(makeDone()));
                  if (opts.onFinish) await opts.onFinish({ status: finalStatus, duration: (Date.now() - startTime) / 1000 });
                  controller.close();
                  return;
                }
              } else if (typeof rawToken === "string" && rawToken) {
                controller.enqueue(encoder.encode(makeChunk(id, created, currentModel, rawToken)));
              }
              continue;
            }

            if (cardMarkdown) {
              const closing = closeThinkingPrefix();
              const separator = closing || !streamedAnswerText || /[\r\n]$/.test(streamedAnswerText) ? "" : "\n";
              const emitted = `${closing}${separator}${cardMarkdown}\n`;
              controller.enqueue(
                encoder.encode(makeChunk(id, created, currentModel, emitted)),
              );
              streamedAnswerText += stripThinkMarkup(emitted);
              continue;
            }

            if (modelResp && !isImage && typeof modelResp.message === "string" && modelResp.message) {
              let finalMessage = replaceRenderCardsWithMarkdown(modelResp.message, modelResp.cardAttachmentsJson);
              let messageSuffix = buildFinalMessageSuffix(finalMessage, streamedAnswerText);

              let emitted = closeThinkingPrefix();
              if (messageSuffix) {
                emitted += messageSuffix;
                streamedAnswerText = finalMessage;
              }

              if (emitted) {
                controller.enqueue(encoder.encode(makeChunk(id, created, currentModel, emitted)));
              }
              continue;
            }

            // Text chat stream
            if (Array.isArray(rawToken)) continue;
            if (typeof rawToken !== "string" || !rawToken) continue;
            let token = rawToken;

            if (filteredTags.some((t) => token.includes(t))) continue;

            const currentIsThinking = Boolean(grok.isThinking);
            const messageTag = grok.messageTag;

            if (thinkingFinished && currentIsThinking) continue;

            if (grok.toolUsageCardId && grok.webSearchResults?.results && Array.isArray(grok.webSearchResults.results)) {
              if (currentIsThinking) {
                if (showThinking) {
                  let appended = "";
                  for (const r of grok.webSearchResults.results) {
                    const title = typeof r.title === "string" ? r.title : "";
                    const url = typeof r.url === "string" ? r.url : "";
                    const preview = typeof r.preview === "string" ? r.preview.replace(/\n/g, "") : "";
                    appended += `\n- [${title}](${url} \"${preview}\")`;
                  }
                  token += `${appended}\n`;
                } else {
                  continue;
                }
              } else {
                continue;
              }
            }

            let content = token;
            if (messageTag === "header") content = `\n\n${token}\n\n`;

            let shouldSkip = false;
            if (!isThinking && currentIsThinking) {
              if (showThinking) content = `<think>\n${content}`;
              else shouldSkip = true;
            } else if (isThinking && !currentIsThinking) {
              if (showThinking) content = `\n</think>\n${content}`;
              thinkingFinished = true;
            } else if (currentIsThinking && !showThinking) {
              shouldSkip = true;
            }

            if (!shouldSkip) controller.enqueue(encoder.encode(makeChunk(id, created, currentModel, content)));
            if (!shouldSkip && !currentIsThinking) streamedAnswerText += stripThinkMarkup(content);
            isThinking = currentIsThinking;
          }
        }

        await flushStop();
        if (opts.onFinish) await opts.onFinish({ status: finalStatus, duration: (Date.now() - startTime) / 1000 });
        controller.close();
      } catch (e) {
        finalStatus = 500;
        controller.enqueue(
          encoder.encode(
            makeChunk(id, created, currentModel, `处理错误: ${e instanceof Error ? e.message : String(e)}`, "error"),
          ),
        );
        controller.enqueue(encoder.encode(makeDone()));
        if (opts.onFinish) await opts.onFinish({ status: finalStatus, duration: (Date.now() - startTime) / 1000 });
        controller.close();
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // ignore
        }
      }
    },
  });
}

export async function parseOpenAiFromGrokNdjson(
  grokResp: Response,
  opts: {
    cookie: string;
    settings: GrokSettings;
    global: GlobalSettings;
    origin: string;
    requestedModel: string;
    videoFormat?: unknown;
    transformVideoAsset?: VideoAssetTransformer;
  },
): Promise<Record<string, unknown>> {
  const { global, origin, requestedModel, settings } = opts;
  const readTimeoutMs = resolveStreamReadTimeoutMs(settings.stream_chunk_timeout);

  let content = "";
  let model = requestedModel;
  await consumeNdjsonObjects(grokResp, async (data) => {
    const err = (data as any).error;
    if (err?.message) throw new Error(String(err.message));

    const grok = (data as any).result?.response;
    if (!grok) return false;

    const videoResp = grok.streamingVideoGenerationResponse;
    if (videoResp?.videoUrl && typeof videoResp.videoUrl === "string") {
      const render = await resolveVideoRender({
        global,
        origin,
        asset: {
          videoUrl: videoResp.videoUrl,
          ...(typeof videoResp.thumbnailImageUrl === "string" && videoResp.thumbnailImageUrl
            ? { thumbnailUrl: videoResp.thumbnailImageUrl }
            : {}),
        },
        transformVideoAsset: opts.transformVideoAsset,
      });
      if (!render) return false;
      content = buildVideoContent({
        videoUrl: render.videoUrl,
        posterPreview: settings.video_poster_preview === true,
        ...(render.posterUrl ? { posterUrl: render.posterUrl } : {}),
        format: opts.videoFormat,
      });
      model = requestedModel;
      return true;
    }

    const modelResp = grok.modelResponse;
    if (!modelResp) return false;
    if (typeof modelResp.error === "string" && modelResp.error) throw new Error(modelResp.error);

    if (typeof modelResp.model === "string" && modelResp.model) model = modelResp.model;
    if (typeof modelResp.message === "string") content = modelResp.message;
    content = replaceRenderCardsWithMarkdown(content, modelResp.cardAttachmentsJson);

    const rawUrls = modelResp.generatedImageUrls;
    const urls = normalizeGeneratedAssetUrls(rawUrls);
    if (urls.length) {
      for (const u of urls) {
        const imgPath = encodeAssetPath(u);
        const imgUrl = toImgProxyUrl(global, origin, imgPath);
        content += `\n![Generated Image](${imgUrl})`;
      }
      return true;
    }

    if (Array.isArray(rawUrls)) return false;
    return true;
  }, { readTimeoutMs });

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
