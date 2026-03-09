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

  function createReferenceUploadCache() {
    let cachedKey = "";
    let cachedUrl = "";

    return {
      reset() {
        cachedKey = "";
        cachedUrl = "";
      },
      peek(file) {
        const key = buildReferenceUploadKey(file);
        return key && key === cachedKey ? cachedUrl : "";
      },
      async getOrUpload(file, uploadFn) {
        const key = buildReferenceUploadKey(file);
        if (!key) return "";
        if (cachedUrl && key === cachedKey) {
          return cachedUrl;
        }
        const nextUrl = String(await uploadFn(file) || "").trim();
        if (!nextUrl) {
          cachedKey = "";
          cachedUrl = "";
          return "";
        }
        cachedKey = key;
        cachedUrl = nextUrl;
        return nextUrl;
      },
    };
  }

  return {
    buildReferenceUploadKey: buildReferenceUploadKey,
    createReferenceUploadCache: createReferenceUploadCache,
  };
});
