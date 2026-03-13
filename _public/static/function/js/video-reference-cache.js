(function (globalScope, factory) {
  const exported = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = exported;
  }
  globalScope.VideoReferenceCache = exported;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function buildReferenceUploadKey(file) {
    if (!file || typeof file !== "object") return "";
    return [
      String(file.name || "").trim(),
      Number(file.size) || 0,
      Number(file.lastModified) || 0,
      String(file.type || "").trim(),
    ].join("::");
  }

  function hasPendingReferenceUploads(referenceItems) {
    if (!Array.isArray(referenceItems) || !referenceItems.length) {
      return false;
    }
    return referenceItems.some((item) => item && item.status === "uploading");
  }

  function extractReferenceRemoveId(target) {
    if (!target || typeof target.closest !== "function") {
      return "";
    }
    const removeButton = target.closest("[data-reference-remove]");
    if (!removeButton || typeof removeButton.getAttribute !== "function") {
      return "";
    }
    return String(removeButton.getAttribute("data-reference-remove") || "").trim();
  }

  function abortReferenceUpload(item) {
    if (!item || typeof item.abortUpload !== "function") {
      return false;
    }
    item.abortUpload();
    return true;
  }

  function syncReferenceStartButtonState(button, options) {
    const isRunning = Boolean(options && options.isRunning);
    const hasPendingUploads = hasPendingReferenceUploads(options && options.referenceItems);
    const disabled = isRunning || hasPendingUploads;
    if (button && typeof button === "object" && "disabled" in button) {
      button.disabled = disabled;
    }
    return disabled;
  }

  function createReferenceUploadCache() {
    const cache = new Map();

    return {
      reset() {
        cache.clear();
      },
      peek(file) {
        const key = buildReferenceUploadKey(file);
        return key ? (cache.get(key) || "") : "";
      },
      async getOrUpload(file, uploadFn) {
        const key = buildReferenceUploadKey(file);
        if (!key) return "";
        const cachedUrl = cache.get(key);
        if (cachedUrl) {
          return cachedUrl;
        }
        const nextUrl = String(await uploadFn(file) || "").trim();
        if (!nextUrl) {
          cache.delete(key);
          return "";
        }
        cache.set(key, nextUrl);
        return nextUrl;
      },
    };
  }

  return {
    abortReferenceUpload: abortReferenceUpload,
    buildReferenceUploadKey: buildReferenceUploadKey,
    extractReferenceRemoveId: extractReferenceRemoveId,
    hasPendingReferenceUploads: hasPendingReferenceUploads,
    syncReferenceStartButtonState: syncReferenceStartButtonState,
    createReferenceUploadCache: createReferenceUploadCache,
  };
});
