export const PROMPT_ENHANCE_MODEL = "grok-4.1-fast";

export const PROMPT_ENHANCE_SYSTEM_PROMPT = `You are a cinematic prompt enhancer for image generation and image-to-video generation.

Your job:
1. Rewrite the user's raw prompt into a higher quality prompt for Grok image/video generation.
2. Preserve the user's intent, subject, composition, and all explicit constraints.
3. If the raw prompt contains placeholders like [[IMAGE_TAG_1]], [[IMAGE_TAG_2]], you must keep them exactly as-is, in the same order, without translating, deleting, or inventing new placeholders.
4. If the raw prompt implies reference-image-driven video generation, keep the language compatible with multi-image video prompting and preserve every image tag reference.
5. Provide a bilingual result with concise, copyable markdown sections only.

Required output format:
## Final Prompt
<enhanced English prompt>

## 中文参考版
<Chinese reference version>

## 可调参数
- Camera:
- Motion:
- Lighting:

Rules:
- Output only the three markdown sections above.
- Do not add prefaces, warnings, or explanations.
- Keep all placeholder tags exactly unchanged.
- Keep every @Image n mention or placeholder semantically aligned with the original prompt.
- If the user prompt is already concise action-only control language, keep it tight instead of over-expanding.
`;

function clampPromptEnhanceTemperature(input: number): number {
  if (!Number.isFinite(input)) return 0.7;
  return Math.min(2, Math.max(0, input));
}

export function buildPromptEnhanceChatBody(
  rawPrompt: string,
  temperature = 0.7,
): Record<string, unknown> {
  const safePrompt = String(rawPrompt || "").trim();
  return {
    model: PROMPT_ENHANCE_MODEL,
    stream: false,
    temperature: clampPromptEnhanceTemperature(Number(temperature)),
    top_p: 0.95,
    messages: [
      {
        role: "system",
        content: PROMPT_ENHANCE_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: [
          "Rewrite the raw prompt using the required markdown format.",
          "If RAW_PROMPT contains [[IMAGE_TAG_n]] placeholders, keep them exactly unchanged in the final output.",
          "RAW_PROMPT:",
          "<RAW_PROMPT>",
          safePrompt,
          "</RAW_PROMPT>",
        ].join("\n"),
      },
    ],
  };
}

export function extractChatMessageText(result: unknown): string {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return "";
  }

  const choices = (result as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices.length) {
    return "";
  }

  const message = choices[0] && typeof choices[0] === "object"
    ? (choices[0] as { message?: unknown }).message
    : null;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return "";
  }

  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      const text = item.trim();
      if (text) parts.push(text);
      continue;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const text = typeof (item as { text?: unknown }).text === "string"
      ? String((item as { text?: unknown }).text).trim()
      : "";
    if (text) parts.push(text);
  }

  return parts.join("\n").trim();
}
