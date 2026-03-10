import { Hono } from "hono";
import { requireApiAuth, requireModelAuth } from "../auth";
import type { Env } from "../env";
import { openAiRoutes } from "./openai";

function normalizeResponseInput(input: unknown): Array<Record<string, unknown>> {
  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }

  if (Array.isArray(input)) {
    const messages: Array<Record<string, unknown>> = [];
    const pendingBlocks: Array<Record<string, unknown>> = [];

    const flushPending = () => {
      if (!pendingBlocks.length) return;
      messages.push({ role: "user", content: pendingBlocks.splice(0) });
    };

    for (const item of input) {
      if (typeof item === "string") {
        pendingBlocks.push({ type: "text", text: item });
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const itemType = String(record.type ?? "");
      if (itemType === "message" || ("role" in record && "content" in record)) {
        flushPending();
        messages.push({
          role: String(record.role ?? "user"),
          content: record.content ?? "",
        });
        continue;
      }
      if (itemType === "input_text" || itemType === "text" || itemType === "output_text") {
        pendingBlocks.push({ type: "text", text: String(record.text ?? record.content ?? "") });
        continue;
      }
      if (itemType === "input_image" || itemType === "image" || itemType === "image_url") {
        const imageUrl = record.image_url;
        let url = "";
        if (typeof imageUrl === "string") url = imageUrl;
        else if (imageUrl && typeof imageUrl === "object") {
          url = String((imageUrl as Record<string, unknown>).url ?? "");
        } else {
          url = String(record.url ?? "");
        }
        if (url) {
          pendingBlocks.push({ type: "image_url", image_url: { url } });
        }
      }
    }

    flushPending();
    return messages;
  }

  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    if ("role" in record && "content" in record) {
      return [{ role: String(record.role ?? "user"), content: record.content ?? "" }];
    }
  }

  return [{ role: "user", content: String(input ?? "") }];
}

function createResponseObject(args: {
  model: string;
  outputText: string;
  responseId?: string;
  usage?: Record<string, unknown>;
}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  const responseId = args.responseId ?? `resp_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
  return {
    id: responseId,
    object: "response",
    created_at: now,
    completed_at: now,
    status: "completed",
    error: null,
    incomplete_details: null,
    model: args.model,
    output: [
      {
        id: `msg_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: args.outputText,
            annotations: [],
          },
        ],
      },
    ],
    text: { format: { type: "text" } },
    usage:
      args.usage ??
      ({
        total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
      } satisfies Record<string, unknown>),
  };
}

function toDataUri(file: File): Promise<string> {
  return file.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return `data:${file.type || "application/octet-stream"};base64,${btoa(binary)}`;
  });
}

function extractVideoUrl(content: string): string {
  const markdown = content.match(/\[video\]\(([^)\s]+)\)/);
  if (markdown?.[1]) return markdown[1];

  const source = content.match(/<source[^>]+src=["']([^"']+)["']/i);
  if (source?.[1]) return source[1];

  const url = content.match(/https?:\/\/[^\s"'<>]+/i);
  return url?.[0] ?? "";
}

function mapVideoSizeToAspectRatio(size: string): string | null {
  return (
    {
      "1280x720": "16:9",
      "720x1280": "9:16",
      "1792x1024": "3:2",
      "1024x1792": "2:3",
      "1024x1024": "1:1",
    }[size] ?? null
  );
}

function mapQualityToResolution(quality: string): "SD" | "HD" | null {
  if (quality === "standard") return "SD";
  if (quality === "high") return "HD";
  return null;
}

async function forwardChatRequest(c: any, body: Record<string, unknown>): Promise<Response> {
  const headers = new Headers();
  const auth = c.req.header("Authorization");
  if (auth) headers.set("Authorization", auth);
  headers.set("content-type", "application/json");

  const request = new Request("https://internal.grok2api.local/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return openAiRoutes.fetch(request, c.env, c.executionCtx);
}

export const currentOpenAiRoutes = new Hono<{ Bindings: Env }>();

currentOpenAiRoutes.get("/models", requireModelAuth, (c) => {
  const headers = new Headers();
  const auth = c.req.header("Authorization");
  if (auth) headers.set("Authorization", auth);
  return openAiRoutes.fetch(
    new Request("https://internal.grok2api.local/models", { headers }),
    c.env,
    c.executionCtx,
  );
});

currentOpenAiRoutes.get("/models/:modelId", requireModelAuth, (c) => {
  const headers = new Headers();
  const auth = c.req.header("Authorization");
  if (auth) headers.set("Authorization", auth);
  const modelId = encodeURIComponent(c.req.param("modelId"));
  return openAiRoutes.fetch(
    new Request(`https://internal.grok2api.local/models/${modelId}`, { headers }),
    c.env,
    c.executionCtx,
  );
});

currentOpenAiRoutes.use("/*", requireApiAuth);

currentOpenAiRoutes.post("/responses", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const model = String(body.model ?? "").trim();
  if (!model) return c.json({ error: { message: "model is required", code: "invalid_request_error" } }, 400);
  if (body.input === undefined || body.input === null) {
    return c.json({ error: { message: "input is required", code: "invalid_request_error" } }, 400);
  }

  const messages = normalizeResponseInput(body.input);
  const instructions = String(body.instructions ?? "").trim();
  const stream = Boolean(body.stream);
  const reasoning = body.reasoning && typeof body.reasoning === "object"
    ? (body.reasoning as Record<string, unknown>)
    : null;

  if (instructions) {
    messages.unshift({ role: "system", content: instructions });
  }

  const chatBody: Record<string, unknown> = {
    model,
    messages,
    stream,
  };
  if (body.temperature !== undefined) chatBody.temperature = body.temperature;
  if (body.top_p !== undefined) chatBody.top_p = body.top_p;
  if (body.tools !== undefined) chatBody.tools = body.tools;
  if (body.tool_choice !== undefined) chatBody.tool_choice = body.tool_choice;
  if (body.parallel_tool_calls !== undefined) chatBody.parallel_tool_calls = body.parallel_tool_calls;
  if (reasoning?.effort !== undefined) chatBody.reasoning_effort = reasoning.effort;

  const upstream = await forwardChatRequest(c, chatBody);
  if (!stream) {
    const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
    const choices = Array.isArray(data.choices) ? (data.choices as Array<Record<string, unknown>>) : [];
    const firstChoice = choices[0] ?? {};
    const message = (firstChoice.message ?? {}) as Record<string, unknown>;
    const content = String(message.content ?? "");
    return c.json(createResponseObject({
      model,
      outputText: content,
      usage: (data.usage as Record<string, unknown> | undefined) ?? undefined,
    }));
  }

  const responseId = `resp_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const messageId = `msg_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const streamBody = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sendEvent = (eventType: string, payload: Record<string, unknown>) => {
        controller.enqueue(
          encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`),
        );
      };

      let fullText = "";
      sendEvent("response.created", {
        type: "response.created",
        response: {
          id: responseId,
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          status: "in_progress",
          model,
          output: [],
        },
      });
      sendEvent("response.in_progress", {
        type: "response.in_progress",
        response: {
          id: responseId,
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          status: "in_progress",
          model,
          output: [],
        },
      });

      const reader = upstream.body?.getReader();
      if (!reader) {
        controller.close();
        return;
      }

      let buffer = "";
      let addedOutput = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          const lines = part.split("\n");
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload) continue;
            if (payload === "[DONE]") {
              sendEvent("response.output_text.done", {
                type: "response.output_text.done",
                response_id: responseId,
                item_id: messageId,
                output_index: 0,
                content_index: 0,
                text: fullText,
              });
              sendEvent("response.completed", {
                type: "response.completed",
                response: createResponseObject({ model, outputText: fullText, responseId }),
              });
              controller.close();
              return;
            }

            let json: Record<string, unknown>;
            try {
              json = JSON.parse(payload) as Record<string, unknown>;
            } catch {
              continue;
            }

            const choices = Array.isArray(json.choices)
              ? (json.choices as Array<Record<string, unknown>>)
              : [];
            const delta = (choices[0]?.delta ?? {}) as Record<string, unknown>;
            const content = String(delta.content ?? "");
            if (!content) continue;

            if (!addedOutput) {
              addedOutput = true;
              sendEvent("response.output_item.added", {
                type: "response.output_item.added",
                response_id: responseId,
                output_index: 0,
                item: {
                  id: messageId,
                  type: "message",
                  role: "assistant",
                  status: "in_progress",
                  content: [],
                },
              });
            }

            fullText += content;
            sendEvent("response.output_text.delta", {
              type: "response.output_text.delta",
              response_id: responseId,
              item_id: messageId,
              output_index: 0,
              content_index: 0,
              delta: content,
            });
          }
        }
      }

      sendEvent("response.completed", {
        type: "response.completed",
        response: createResponseObject({ model, outputText: fullText, responseId }),
      });
      controller.close();
    },
  });

  return new Response(streamBody, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-store, must-revalidate",
      connection: "keep-alive",
    },
  });
});

currentOpenAiRoutes.post("/videos", async (c) => {
  const contentType = String(c.req.header("content-type") ?? "").toLowerCase();
  let prompt = "";
  let model = "grok-imagine-1.0-video";
  let size = "1792x1024";
  let seconds = 6;
  let quality = "standard";
  let references: string[] = [];

  if (contentType.includes("multipart/form-data")) {
    const form = await c.req.formData();
    prompt = String(form.get("prompt") ?? "").trim();
    model = String(form.get("model") ?? model).trim() || model;
    size = String(form.get("size") ?? size).trim() || size;
    seconds = Math.floor(Number(form.get("seconds") ?? seconds)) || 6;
    quality = String(form.get("quality") ?? quality).trim().toLowerCase() || quality;

    const imageReference = form.get("image_reference");
    if (typeof imageReference === "string" && imageReference.trim()) {
      try {
        const parsed = JSON.parse(imageReference) as Record<string, unknown>;
        const url = String(parsed.image_url ?? "").trim();
        if (url) references.push(url);
      } catch {
        references.push(imageReference.trim());
      }
    }

    const inputReference = form.get("input_reference");
    if (inputReference instanceof File) {
      references.push(await toDataUri(inputReference));
    }
  } else {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    prompt = String(body.prompt ?? "").trim();
    model = String(body.model ?? model).trim() || model;
    size = String(body.size ?? size).trim() || size;
    seconds = Math.floor(Number(body.seconds ?? seconds)) || 6;
    quality = String(body.quality ?? quality).trim().toLowerCase() || quality;

    const imageReference = body.image_reference;
    if (typeof imageReference === "string" && imageReference.trim()) {
      references.push(imageReference.trim());
    } else if (imageReference && typeof imageReference === "object") {
      const url = String((imageReference as Record<string, unknown>).image_url ?? "").trim();
      if (url) references.push(url);
    }
  }

  if (!prompt) {
    return c.json({ error: { message: "prompt is required", code: "invalid_request_error" } }, 400);
  }
  if (model !== "grok-imagine-1.0-video") {
    return c.json({ error: { message: "The model `grok-imagine-1.0-video` is required.", code: "model_not_supported" } }, 400);
  }

  const aspectRatio = mapVideoSizeToAspectRatio(size);
  if (!aspectRatio) {
    return c.json({ error: { message: "size is invalid", code: "invalid_size" } }, 400);
  }
  if (seconds < 6 || seconds > 30) {
    return c.json({ error: { message: "seconds must be between 6 and 30", code: "invalid_seconds" } }, 400);
  }

  const resolution = mapQualityToResolution(quality);
  if (!resolution) {
    return c.json({ error: { message: "quality must be standard or high", code: "invalid_quality" } }, 400);
  }

  const content = references.length
    ? [
        { type: "text", text: prompt },
        ...references.map((url) => ({ type: "image_url", image_url: { url } })),
      ]
    : prompt;

  const upstream = await forwardChatRequest(c, {
    model: "grok-imagine-1.0-video",
    stream: false,
    messages: [{ role: "user", content }],
    video_config: {
      aspect_ratio: aspectRatio,
      video_length: seconds,
      resolution,
      preset: "custom",
    },
  });

  const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
  const choices = Array.isArray(data.choices) ? (data.choices as Array<Record<string, unknown>>) : [];
  const message = (choices[0]?.message ?? {}) as Record<string, unknown>;
  const videoUrl = extractVideoUrl(String(message.content ?? ""));
  if (!videoUrl) {
    return c.json({ error: { message: "Video generation failed: missing video URL", code: "upstream_error" } }, 502);
  }

  const ts = Math.floor(Date.now() / 1000);
  return c.json({
    id: `video_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
    object: "video",
    created_at: ts,
    completed_at: ts,
    status: "completed",
    model: "grok-imagine-1.0-video",
    prompt,
    size,
    seconds: String(seconds),
    quality,
    url: videoUrl,
  });
});
