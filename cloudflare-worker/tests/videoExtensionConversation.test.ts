import assert from "node:assert/strict";
import test from "node:test";

import { buildConversationPayload } from "../src/grok/conversation";

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
    videoResolution: "HD",
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
