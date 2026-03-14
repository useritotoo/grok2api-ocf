import assert from "node:assert/strict";
import test from "node:test";

import { buildConversationPayload } from "../src/grok/conversation";

test("buildConversationPayload keeps resolutionName for initial 720p video generation", () => {
  const { payload, referer, isVideoModel } = buildConversationPayload({
    requestModel: "grok-imagine-1.0-video",
    content: "Create a cinematic tracking shot",
    fileIds: [],
    imgIds: [],
    imgUris: [],
    postId: "abcd1234abcd1234abcd1234abcd1234",
    videoConfig: {
      aspect_ratio: "16:9",
      video_length: 6,
      resolution: "HD",
      resolution_name: "720p",
      preset: "normal",
      is_video_extension: false,
    },
    settings: {} as any,
  });

  assert.equal(isVideoModel, true);
  assert.equal(referer, "https://grok.com/imagine");
  assert.deepEqual((payload as any).responseMetadata.modelConfigOverride.modelMap.videoGenModelConfig, {
    parentPostId: "abcd1234abcd1234abcd1234abcd1234",
    aspectRatio: "16:9",
    videoLength: 6,
    resolutionName: "720p",
  });
});

test("buildConversationPayload maps video extension config to Grok videoGenModelConfig", () => {
  const { payload, referer, isVideoModel } = buildConversationPayload({
    requestModel: "grok-imagine-1.0-video",
    content: "Continue the camera move",
    fileIds: [],
    imgIds: [],
    imgUris: [],
    postId: "abcd1234abcd1234abcd1234abcd1234",
    videoConfig: {
      aspect_ratio: "16:9",
      video_length: 10,
      resolution: "HD",
      preset: "spicy",
      is_video_extension: true,
      extend_post_id: "abcd1234abcd1234abcd1234abcd1234",
      video_extension_start_time: 4.25,
      original_post_id: "orig1234orig1234orig1234orig1234",
      file_attachment_id: "file1234file1234file1234file1234",
      stitch_with_extend: true,
    },
    settings: {} as any,
  });

  assert.equal(isVideoModel, true);
  assert.equal(referer, "https://grok.com/imagine");
  assert.deepEqual((payload as any).fileAttachments, ["file1234file1234file1234file1234"]);
  assert.deepEqual((payload as any).responseMetadata.modelConfigOverride.modelMap.videoGenModelConfig, {
    parentPostId: "abcd1234abcd1234abcd1234abcd1234",
    aspectRatio: "16:9",
    videoLength: 10,
    isVideoExtension: true,
    videoExtensionStartTime: 4.25,
    extendPostId: "abcd1234abcd1234abcd1234abcd1234",
    stitchWithExtendPostId: true,
    originalPostId: "orig1234orig1234orig1234orig1234",
    originalRefType: "ORIGINAL_REF_TYPE_VIDEO_EXTENSION",
    mode: "extremely-spicy-or-crazy",
    resolutionName: "720p",
    isVideoEdit: false,
    originalPrompt: "Continue the camera move",
  });
});

test("buildConversationPayload maps @Image aliases to uploaded references for video generation", () => {
  const firstImageId = "11111111-1111-1111-1111-111111111111";
  const secondImageId = "22222222-2222-2222-2222-222222222222";
  const { payload, isVideoModel } = buildConversationPayload({
    requestModel: "grok-imagine-1.0-video",
    content: "Character enters from @Image 1 and sits beside @Image 2",
    fileIds: [],
    imgIds: [firstImageId, secondImageId],
    imgUris: [
      "/users/demo/generated/ref-one.png",
      "/users/demo/generated/ref-two.png",
    ],
    postId: "abcd1234abcd1234abcd1234abcd1234",
    videoConfig: {
      aspect_ratio: "16:9",
      video_length: 6,
      resolution: "HD",
      resolution_name: "720p",
      preset: "normal",
      is_video_extension: false,
    },
    settings: {} as any,
  });

  assert.equal(isVideoModel, true);
  assert.equal(
    (payload as any).message,
    `Character enters from @${firstImageId} and sits beside @${secondImageId} --mode=normal`,
  );
  assert.deepEqual((payload as any).fileAttachments, [firstImageId, secondImageId]);
  assert.deepEqual((payload as any).responseMetadata.modelConfigOverride.modelMap.videoGenModelConfig, {
    parentPostId: "abcd1234abcd1234abcd1234abcd1234",
    aspectRatio: "16:9",
    videoLength: 6,
    resolutionName: "720p",
    isReferenceToVideo: true,
    imageReferences: [
      "https://assets.grok.com/users/demo/generated/ref-one.png",
      "https://assets.grok.com/users/demo/generated/ref-two.png",
    ],
  });
});

test("buildConversationPayload prefixes uploaded references when the prompt has no explicit aliases", () => {
  const firstImageId = "33333333-3333-3333-3333-333333333333";
  const secondImageId = "44444444-4444-4444-4444-444444444444";
  const { payload } = buildConversationPayload({
    requestModel: "grok-imagine-1.0-video",
    content: "Keep the same character and scene continuity",
    fileIds: [],
    imgIds: [firstImageId, secondImageId],
    imgUris: [
      "/users/demo/generated/ref-three.png",
      "/users/demo/generated/ref-four.png",
    ],
    postId: "abcd1234abcd1234abcd1234abcd1234",
    videoConfig: {
      aspect_ratio: "9:16",
      video_length: 6,
      resolution: "SD",
      resolution_name: "480p",
      preset: "normal",
      is_video_extension: false,
    },
    settings: {} as any,
  });

  assert.equal(
    (payload as any).message,
    `@${firstImageId} @${secondImageId} Keep the same character and scene continuity --mode=normal`,
  );
});
