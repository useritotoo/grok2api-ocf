import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildImagineWsUrl } = require("../../_public/static/function/js/function-transport.js");

test("buildImagineWsUrl prefers wss for deployed hosts", () => {
  const url = buildImagineWsUrl({
    protocol: "http:",
    host: "demo.example",
    taskId: "task-1",
    functionKey: "public-key",
  });

  assert.equal(
    url,
    "wss://demo.example/v1/function/imagine/ws?task_id=task-1&function_key=public-key",
  );
});

test("buildImagineWsUrl keeps ws for localhost development", () => {
  const url = buildImagineWsUrl({
    protocol: "http:",
    host: "localhost:8787",
    taskId: "task-2",
  });

  assert.equal(url, "ws://localhost:8787/v1/function/imagine/ws?task_id=task-2");
});
