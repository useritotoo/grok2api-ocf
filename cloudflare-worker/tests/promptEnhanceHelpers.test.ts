import assert from "node:assert/strict";
import test from "node:test";

import {
  PROMPT_ENHANCE_MODEL,
  buildPromptEnhanceChatBody,
  extractChatMessageText,
} from "../src/function/promptEnhance.ts";

test("buildPromptEnhanceChatBody keeps image tag placeholders in the user prompt", () => {
  const prompt = "Use [[IMAGE_TAG_1]] as the lead and [[IMAGE_TAG_2]] as the background.";
  const body = buildPromptEnhanceChatBody(prompt, 0.7) as {
    model: string;
    stream: boolean;
    messages: Array<{ role: string; content: string }>;
    temperature: number;
  };

  assert.equal(body.model, PROMPT_ENHANCE_MODEL);
  assert.equal(body.stream, false);
  assert.equal(body.temperature, 0.7);
  assert.equal(body.messages.length, 2);
  assert.match(body.messages[1]?.content || "", /\[\[IMAGE_TAG_1\]\]/);
  assert.match(body.messages[1]?.content || "", /\[\[IMAGE_TAG_2\]\]/);
  assert.match(body.messages[1]?.content || "", /RAW_PROMPT:/);
});

test("extractChatMessageText joins structured text content", () => {
  const text = extractChatMessageText({
    choices: [
      {
        message: {
          content: [
            { type: "output_text", text: "## Final Prompt\nA cinematic scene" },
            { type: "output_text", text: "## 中文参考版\n电影感场景" },
          ],
        },
      },
    ],
  });

  assert.equal(text, "## Final Prompt\nA cinematic scene\n## 中文参考版\n电影感场景");
});

test("extractChatMessageText returns an empty string for missing choices", () => {
  assert.equal(extractChatMessageText({ choices: [] }), "");
  assert.equal(extractChatMessageText(null), "");
});
