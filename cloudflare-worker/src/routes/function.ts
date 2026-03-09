import { Hono } from "hono";
import { getDynamicHeaders } from "../grok/headers";
import { generateImagineWs } from "../grok/imagineExperimental";
import { getCurrentConfig } from "../currentConfig";
import type { Env } from "../env";
import {
  chooseImageSizeFromAspectRatio,
  FUNCTION_SESSION_TTL_MS,
  normalizeImagineAspectRatio,
  normalizeVideoAspectRatio,
} from "../function/taskHelpers";
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
import { applyCooldown, recordTokenFailure, selectBestToken } from "../repo/tokens";
import { getSettings, normalizeCfCookie } from "../settings";

interface ImagineSessionPayload {
  prompt: string;
  aspect_ratio: string;
  nsfw: boolean | null;
}

interface VideoSessionPayload {
  prompt: string;
  aspect_ratio: string;
  video_length: number;
  resolution_name: "480p" | "720p";
  preset: "fun" | "normal" | "spicy" | "custom";
  image_url: string | null;
  reasoning_effort: string | null;
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

function buildProxyImageUrl(origin: string, rawUrl: string): string {
  return `${origin}/images/${encodeURIComponent(encodeAssetPath(rawUrl))}`;
}

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
  return Math.min(30, Math.max(6, value));
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

function buildVideoChatBody(payload: VideoSessionPayload): Record<string, unknown> {
  const content = payload.image_url
    ? [
        { type: "text", text: payload.prompt },
        { type: "image_url", image_url: { url: payload.image_url } },
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
      preset: payload.preset,
    },
  };
}

async function buildInternalRequest(
  c: any,
  pathname: string,
  init: RequestInit,
): Promise<Request> {
  const url = new URL(pathname, "https://internal.grok2api.local");
  const headers = new Headers(init.headers);
  const masterToken = await getInternalMasterToken(c.env);
  if (masterToken) {
    headers.set("Authorization", `Bearer ${masterToken}`);
  }
  return new Request(url.toString(), { ...init, headers });
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

  const data = (await upstream.json().catch(() => ({}))) as { token?: string };
  if (!data?.token) {
    return Response.json(
      { error: "Upstream returned no voice token", code: "upstream_error" },
      { status: 502 },
    );
  }

  return Response.json({
    token: data.token,
    url: "wss://livekit.grok.com",
    participant_name: "",
    room_name: "",
  });
}

export const functionRoutes = new Hono<{ Bindings: Env }>();

functionRoutes.use("/v1/function/*", requireFunctionAuth);

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

  const aspectRatio = normalizeImagineAspectRatio(String(body.aspect_ratio ?? "2:3"));
  const nsfw = parseBoolean(body.nsfw);
  const now = Date.now();
  const taskId = crypto.randomUUID().replaceAll("-", "");

  await upsertFunctionSession<ImagineSessionPayload>(c.env.DB, {
    task_id: taskId,
    kind: "imagine",
    payload: { prompt, aspect_ratio: aspectRatio, nsfw },
    created_at: now,
    expires_at: now + FUNCTION_SESSION_TTL_MS,
  });

  return c.json({ task_id: taskId, aspect_ratio: aspectRatio });
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
    return c.json({ error: "Task not found", code: "TASK_NOT_FOUND" }, 404);
  }

  const settings = await getSettings(c.env);
  const origin = new URL(c.req.url).origin;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let active = true;
      let sequence = 0;
      const runId = crypto.randomUUID().replaceAll("-", "");
      const rawSignal = c.req.raw.signal;

      const stop = async () => {
        if (!active) return;
        active = false;
        await deleteFunctionSessions(c.env.DB, [taskId], "imagine");
        enqueueSse(controller, encoder, {
          type: "status",
          status: "stopped",
          run_id: runId,
        });
        controller.close();
      };

      try {
        enqueueSse(controller, encoder, {
          type: "status",
          status: "running",
          prompt: session.payload.prompt,
          aspect_ratio: session.payload.aspect_ratio,
          run_id: runId,
        });

        while (active && !rawSignal.aborted) {
          const stillExists = await getFunctionSession<ImagineSessionPayload>(
            c.env.DB,
            taskId,
            "imagine",
          );
          if (!stillExists) break;

          const chosen = await selectBestToken(c.env.DB, "grok-imagine-1.0");
          if (!chosen) {
            enqueueSse(controller, encoder, {
              type: "error",
              message: "No available tokens. Please try again later.",
              code: "rate_limit_exceeded",
            });
            await sleep(2000);
            continue;
          }

          const cf = normalizeCfCookie(settings.grok.cf_clearance ?? "");
          const cookie = cf
            ? `sso-rw=${chosen.token};sso=${chosen.token};${cf}`
            : `sso-rw=${chosen.token};sso=${chosen.token}`;
          const batchStart = Date.now();

          try {
            await generateImagineWs({
              prompt: session.payload.prompt,
              n: 6,
              cookie,
              settings: settings.grok,
              aspectRatio: session.payload.aspect_ratio,
              progressCb: async ({ index, progress }) => {
                if (!active || rawSignal.aborted) return;
                enqueueSse(controller, encoder, {
                  type: "image_generation.partial_image",
                  image_id: `${runId}-${index}`,
                  progress,
                  run_id: runId,
                });
              },
              completedCb: async ({ index, url }) => {
                if (!active || rawSignal.aborted) return;
                sequence += 1;
                enqueueSse(controller, encoder, {
                  type: "image_generation.completed",
                  image_id: `${runId}-${index}`,
                  url: buildProxyImageUrl(origin, url),
                  sequence,
                  elapsed_ms: Date.now() - batchStart,
                  aspect_ratio: session.payload.aspect_ratio,
                  run_id: runId,
                });
              },
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await recordTokenFailure(c.env.DB, chosen.token, 500, message.slice(0, 200));
            await applyCooldown(c.env.DB, chosen.token, 500);
            enqueueSse(controller, encoder, {
              type: "error",
              message,
              code: "internal_error",
            });
            await sleep(1500);
          }
        }
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
  const session = taskId
    ? await getFunctionSession<ImagineSessionPayload>(c.env.DB, taskId, "imagine")
    : null;
  if (taskId && !session) {
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
    const settingsPromise = getSettings(c.env);
    const origin = new URL(c.req.url).origin;
    const runId = crypto.randomUUID().replaceAll("-", "");
    let sequence = 0;
    running = true;

    send({
      type: "status",
      status: "running",
      prompt: payload.prompt,
      aspect_ratio: payload.aspect_ratio,
      run_id: runId,
    });

    void (async () => {
      const settings = await settingsPromise;
      while (!closed && running && localRunVersion === runVersion) {
        const chosen = await selectBestToken(c.env.DB, "grok-imagine-1.0");
        if (!chosen) {
          send({
            type: "error",
            message: "No available tokens. Please try again later.",
            code: "rate_limit_exceeded",
          });
          await sleep(2000);
          continue;
        }

        const cf = normalizeCfCookie(settings.grok.cf_clearance ?? "");
        const cookie = cf
          ? `sso-rw=${chosen.token};sso=${chosen.token};${cf}`
          : `sso-rw=${chosen.token};sso=${chosen.token}`;
        const batchStart = Date.now();

        try {
          await generateImagineWs({
            prompt: payload.prompt,
            n: 6,
            cookie,
            settings: settings.grok,
            aspectRatio: payload.aspect_ratio,
            progressCb: async ({ index, progress }) => {
              if (closed || !running || localRunVersion !== runVersion) return;
              send({
                type: "image_generation.partial_image",
                image_id: `${runId}-${index}`,
                progress,
                run_id: runId,
              });
            },
            completedCb: async ({ index, url }) => {
              if (closed || !running || localRunVersion !== runVersion) return;
              sequence += 1;
              send({
                type: "image_generation.completed",
                image_id: `${runId}-${index}`,
                url: buildProxyImageUrl(origin, url),
                sequence,
                elapsed_ms: Date.now() - batchStart,
                aspect_ratio: payload.aspect_ratio,
                run_id: runId,
              });
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await recordTokenFailure(c.env.DB, chosen.token, 500, message.slice(0, 200));
          await applyCooldown(c.env.DB, chosen.token, 500);
          send({ type: "error", message, code: "internal_error" });
          await sleep(1500);
        }
      }

      send({ type: "status", status: "stopped", run_id: runId });
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

    const prompt = String(payload.prompt ?? session?.payload.prompt ?? "").trim();
    if (!prompt) {
      send({ type: "error", message: "Prompt cannot be empty.", code: "invalid_prompt" });
      return;
    }

    const imaginePayload: ImagineSessionPayload = {
      prompt,
      aspect_ratio: normalizeImagineAspectRatio(
        String(payload.aspect_ratio ?? session?.payload.aspect_ratio ?? "2:3"),
      ),
      nsfw: parseBoolean(payload.nsfw ?? session?.payload.nsfw),
    };
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
  if (!prompt) {
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
    image_url: String(body.image_url ?? "").trim() || null,
    reasoning_effort: normalizeReasoningEffort(body.reasoning_effort),
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
