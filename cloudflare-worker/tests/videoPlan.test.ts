import assert from "node:assert/strict";
import test from "node:test";

import { buildVideoGenerationPlan } from "../src/grok/video.ts";

test("buildVideoGenerationPlan downgrades 720p requests on basic tokens and enables upscale", () => {
  const plan = buildVideoGenerationPlan({
    videoConfig: {
      resolution: "HD",
      resolution_name: "720p",
      video_length: 6,
    },
    tokenType: "sso",
    upscaleTiming: "complete",
  });

  assert.equal(plan.requestedResolution, "HD");
  assert.equal(plan.requestedResolutionName, "720p");
  assert.equal(plan.generationResolution, "SD");
  assert.equal(plan.generationResolutionName, "480p");
  assert.equal(plan.shouldUpscale, true);
  assert.equal(plan.upscaleTiming, "complete");
});

test("buildVideoGenerationPlan keeps 720p requests unchanged on super tokens", () => {
  const plan = buildVideoGenerationPlan({
    videoConfig: {
      resolution: "HD",
      resolution_name: "720p",
      video_length: 10,
    },
    tokenType: "ssoSuper",
    upscaleTiming: "single",
  });

  assert.equal(plan.generationResolution, "HD");
  assert.equal(plan.generationResolutionName, "720p");
  assert.equal(plan.shouldUpscale, false);
  assert.equal(plan.upscaleTiming, "complete");
});
