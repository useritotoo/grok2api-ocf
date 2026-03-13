import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildImagineTaskPlan,
  summarizeImagineTaskStates,
} = require("../../_public/static/function/js/imagine-task-utils.js");

test("buildImagineTaskPlan falls back to a single task when infinite mode is disabled", () => {
  assert.deepEqual(
    buildImagineTaskPlan({
      totalImages: 6,
      requestedConcurrent: 3,
      infiniteMode: false,
    }),
    {
      totalImages: 6,
      requestedConcurrent: 3,
      effectiveConcurrent: 1,
      counts: [6],
    },
  );
});

test("buildImagineTaskPlan splits total images evenly across concurrent tasks in infinite mode", () => {
  assert.deepEqual(
    buildImagineTaskPlan({
      totalImages: 6,
      requestedConcurrent: 2,
      infiniteMode: true,
    }),
    {
      totalImages: 6,
      requestedConcurrent: 2,
      effectiveConcurrent: 2,
      counts: [3, 3],
    },
  );
});

test("buildImagineTaskPlan distributes remainder and skips zero-count tasks", () => {
  assert.deepEqual(
    buildImagineTaskPlan({
      totalImages: 2,
      requestedConcurrent: 3,
      infiniteMode: true,
    }),
    {
      totalImages: 2,
      requestedConcurrent: 3,
      effectiveConcurrent: 2,
      counts: [1, 1],
    },
  );
});

test("summarizeImagineTaskStates reports completion only after every task reaches a terminal status", () => {
  assert.deepEqual(
    summarizeImagineTaskStates([
      { status: "running" },
      { status: "stopped" },
      { status: "error" },
    ]),
    {
      total: 3,
      activeCount: 1,
      terminalCount: 2,
      allTerminal: false,
    },
  );

  assert.deepEqual(
    summarizeImagineTaskStates([
      { status: "stopped" },
      { status: "error" },
    ]),
    {
      total: 2,
      activeCount: 0,
      terminalCount: 2,
      allTerminal: true,
    },
  );
});
