(function (globalScope, factory) {
  const exported = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = exported;
  }
  globalScope.FunctionPayloads = exported;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function normalizeReferenceUrls(referenceUrl) {
    const values = Array.isArray(referenceUrl) ? referenceUrl : [referenceUrl];
    const result = [];
    for (const item of values) {
      const value = String(item || "").trim();
      if (!value) continue;
      if (!result.includes(value)) {
        result.push(value);
      }
    }
    return result;
  }

  function buildImageReference(referenceUrl) {
    const urls = normalizeReferenceUrls(referenceUrl);
    if (!urls.length) return null;
    if (urls.length === 1) {
      return { image_url: urls[0] };
    }
    return urls.map((url) => ({ image_url: url }));
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

  function normalizeVideoLength(value) {
    const parsed = Math.floor(Number(value ?? 6));
    if (!Number.isFinite(parsed)) return 6;
    return Math.min(15, Math.max(6, parsed));
  }

  function buildVideoStartPayload(args) {
    const payload = {
      prompt: String((args && args.prompt) || "").trim(),
      aspect_ratio: String((args && args.aspectRatio) || "3:2").trim() || "3:2",
      video_length: normalizeVideoLength(args && args.videoLength),
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
    normalizeReferenceUrls: normalizeReferenceUrls,
    buildImageReference: buildImageReference,
    buildImagineStartPayload: buildImagineStartPayload,
    buildVideoStartPayload: buildVideoStartPayload,
  };
});
