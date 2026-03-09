(function (globalScope, factory) {
  const exported = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = exported;
  }
  globalScope.CachePageState = exported;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function toSafeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function truncateMiddle(value, maxLength) {
    const text = String(value || "");
    const safeMax = Math.max(8, Math.floor(Number(maxLength) || 0));
    if (!text || text.length <= safeMax) return text;

    const dotIndex = text.lastIndexOf(".");
    const hasExtension = dotIndex > 0 && dotIndex < text.length - 1;
    const extension = hasExtension ? text.slice(dotIndex) : "";
    const endLength = hasExtension
      ? Math.min(safeMax - 7, Math.max(extension.length + 4, Math.ceil(safeMax * 0.42)))
      : Math.min(safeMax - 7, Math.max(6, Math.ceil(safeMax * 0.35)));
    const startLength = Math.max(4, safeMax - endLength - 3);

    const suffix = text.slice(-endLength).replace(/^[-_.\s]+/, "") || text.slice(-endLength);
    return `${text.slice(0, startLength)}...${suffix}`;
  }

  function paginateItems(items, currentPage, pageSize) {
    const safeItems = toSafeArray(items);
    const safePageSize = Math.max(1, Math.floor(Number(pageSize) || 1));
    const totalCount = safeItems.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / safePageSize));
    const safePage = Math.min(Math.max(1, Math.floor(Number(currentPage) || 1)), totalPages);
    const startIndex = (safePage - 1) * safePageSize;

    return {
      totalCount,
      totalPages,
      currentPage: safePage,
      visibleItems: safeItems.slice(startIndex, startIndex + safePageSize),
    };
  }

  function buildOnlineRows(args) {
    const accounts = toSafeArray(args && args.accounts);
    const details = toSafeArray(args && args.details);
    const online = args && args.online && typeof args.online === "object" ? args.online : {};
    const accountStates = args && args.accountStates instanceof Map ? args.accountStates : new Map();
    const detailsMap = new Map(details.map(function (item) {
      return [item && item.token, item];
    }));

    return accounts.map(function (account) {
      const detail = detailsMap.get(account.token);
      const state = accountStates.get(account.token);
      let count = "-";
      let status = "not_loaded";
      let lastAssetClearAt = account.last_asset_clear_at;

      if (detail) {
        count = detail.count;
        status = detail.status;
        lastAssetClearAt = detail.last_asset_clear_at != null ? detail.last_asset_clear_at : lastAssetClearAt;
      } else if (account.token === online.token) {
        count = online.count;
        status = online.status;
        lastAssetClearAt = online.last_asset_clear_at != null ? online.last_asset_clear_at : lastAssetClearAt;
      } else if (state) {
        count = state.count;
        status = state.status;
        lastAssetClearAt = state.last_asset_clear_at != null ? state.last_asset_clear_at : lastAssetClearAt;
      }

      return {
        token: account.token,
        token_masked: account.token_masked || account.token,
        pool: account.pool || "-",
        count: count,
        status: status,
        last_asset_clear_at: lastAssetClearAt != null ? lastAssetClearAt : null,
      };
    });
  }

  return {
    truncateMiddle: truncateMiddle,
    paginateItems: paginateItems,
    buildOnlineRows: buildOnlineRows,
  };
});