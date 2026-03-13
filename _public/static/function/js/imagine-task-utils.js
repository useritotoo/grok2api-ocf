(function (globalScope, factory) {
  const exported = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = exported;
  }
  globalScope.ImagineTaskUtils = exported;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function normalizeInt(value, fallback) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return parsed;
  }

  function buildImagineTaskPlan(args) {
    const totalImages = Math.min(6, Math.max(1, normalizeInt(args && args.totalImages, 1)));
    const requestedConcurrent = Math.min(3, Math.max(1, normalizeInt(args && args.requestedConcurrent, 1)));
    const infiniteMode = Boolean(args && args.infiniteMode);
    const effectiveConcurrent = infiniteMode ? Math.min(requestedConcurrent, totalImages) : 1;
    const counts = [];
    const baseCount = Math.floor(totalImages / effectiveConcurrent);
    let remainder = totalImages % effectiveConcurrent;

    for (let index = 0; index < effectiveConcurrent; index += 1) {
      const count = baseCount + (remainder > 0 ? 1 : 0);
      if (remainder > 0) {
        remainder -= 1;
      }
      if (count > 0) {
        counts.push(count);
      }
    }

    return {
      totalImages: totalImages,
      requestedConcurrent: requestedConcurrent,
      effectiveConcurrent: counts.length || 1,
      counts: counts.length ? counts : [totalImages],
    };
  }

  function isTerminalTaskStatus(status) {
    return status === "stopped" || status === "error";
  }

  function summarizeImagineTaskStates(states) {
    const items = Array.isArray(states) ? states : [];
    let terminalCount = 0;
    for (const item of items) {
      if (item && isTerminalTaskStatus(item.status)) {
        terminalCount += 1;
      }
    }
    const total = items.length;
    const activeCount = Math.max(0, total - terminalCount);
    return {
      total: total,
      activeCount: activeCount,
      terminalCount: terminalCount,
      allTerminal: total > 0 && terminalCount === total,
    };
  }

  return {
    buildImagineTaskPlan: buildImagineTaskPlan,
    summarizeImagineTaskStates: summarizeImagineTaskStates,
    isTerminalTaskStatus: isTerminalTaskStatus,
  };
});
