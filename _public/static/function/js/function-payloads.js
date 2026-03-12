(function (globalScope, factory) {
  const exported = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = exported;
  }
  globalScope.FunctionPayloads = exported;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function buildImageReference(referenceUrl) {
    const value = String(referenceUrl || "").trim();
    if (!value) return null;
    return { image_url: value };
  }

  function buildImagineStartPayload(args) {
    const payload = {
      prompt: String((args && args.prompt) || "").trim(),
      aspect_ratio: String((args && args.aspectRatio) || "2:3").trim() || "2:3",
      nsfw: Boolean(args && args.nsfw),
    };
    const n = args && args.n;
    if (n != null) {
      const nVal = parseInt(n, 10);
      if (Number.isFinite(nVal) && nVal >= 1) {
        payload.n = nVal;
      }
    }
    if (args && typeof args.infiniteMode !== "undefined") {
      payload.infinite_mode = Boolean(args.infiniteMode);
    }
    const imageReference = buildImageReference(args && args.referenceUrl);
    if (imageReference) {
      payload.image_reference = imageReference;
    }
    return payload;
  }

  function buildVideoStartPayload(args) {
    const payload = {
      prompt: String((args && args.prompt) || "").trim(),
      aspect_ratio: String((args && args.aspectRatio) || "3:2").trim() || "3:2",
      video_length: Number((args && args.videoLength) || 6),
      resolution_name: String((args && args.resolutionName) || "480p").trim() || "480p",
      preset: String((args && args.preset) || "normal").trim() || "normal",
      reasoning_effort: (args && args.reasoningEffort) == null ? null : String(args.reasoningEffort).trim() || null,
    };
    const imageReference = buildImageReference(args && args.referenceUrl);
    if (imageReference) {
      payload.image_reference = imageReference;
    }
    const extension = args && args.extension;
    if (extension && extension.extendPostId) {
      payload.is_video_extension = true;
      payload.extend_post_id = String(extension.extendPostId).trim();
      payload.video_extension_start_time = Number(extension.startTime || 0);
      payload.original_post_id =
        extension.originalPostId == null ? null : String(extension.originalPostId).trim() || null;
      payload.file_attachment_id =
        extension.fileAttachmentId == null ? null : String(extension.fileAttachmentId).trim() || null;
      payload.stitch_with_extend = extension.stitchWithExtend !== false;
    }
    return payload;
  }

  return {
    buildImageReference: buildImageReference,
    buildImagineStartPayload: buildImagineStartPayload,
    buildVideoStartPayload: buildVideoStartPayload,
  };
});
