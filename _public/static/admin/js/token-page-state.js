(function (globalScope, factory) {
  const exported = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = exported;
  }
  globalScope.TokenPageState = exported;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function createEmptyStats() {
    return {
      totalTokens: 0,
      activeTokens: 0,
      coolingTokens: 0,
      invalidTokens: 0,
      nsfwTokens: 0,
      noNsfwTokens: 0,
      chatQuota: 0,
      totalCalls: 0,
    };
  }

  function createEmptyFilterIndices() {
    return {
      all: [],
      active: [],
      cooling: [],
      expired: [],
      nsfw: [],
      "no-nsfw": [],
    };
  }

  function normalizeQuota(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function normalizeCount(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function normalizeTags(value) {
    return Array.isArray(value) ? value : [];
  }

  function normalizeTokenEntry(pool, entry, index, selectedTokenSet) {
    const normalized = typeof entry === "string"
      ? { token: entry, status: "active", quota: 0, note: "", use_count: 0, tags: [] }
      : {
          token: entry && entry.token,
          status: entry && entry.status ? entry.status : "active",
          quota: entry && entry.quota,
          note: entry && entry.note ? entry.note : "",
          fail_count: entry && entry.fail_count,
          use_count: entry && entry.use_count,
          tags: entry && entry.tags,
          created_at: entry && entry.created_at,
          last_used_at: entry && entry.last_used_at,
          last_fail_at: entry && entry.last_fail_at,
          last_fail_reason: entry && entry.last_fail_reason,
          last_sync_at: entry && entry.last_sync_at,
          last_asset_clear_at: entry && entry.last_asset_clear_at,
        };

    const token = String(normalized.token || "");

    return {
      token: token,
      status: normalized.status || "active",
      quota: normalizeQuota(normalized.quota),
      note: normalized.note || "",
      fail_count: normalizeCount(normalized.fail_count),
      use_count: normalizeCount(normalized.use_count),
      tags: normalizeTags(normalized.tags),
      created_at: normalized.created_at,
      last_used_at: normalized.last_used_at,
      last_fail_at: normalized.last_fail_at,
      last_fail_reason: normalized.last_fail_reason,
      last_sync_at: normalized.last_sync_at,
      last_asset_clear_at: normalized.last_asset_clear_at,
      pool: pool,
      _selected: selectedTokenSet.has(token),
      _index: index,
    };
  }

  function appendFilterIndex(filterIndices, item, index) {
    filterIndices.all.push(index);

    if (item.status === "active") {
      filterIndices.active.push(index);
    } else if (item.status === "cooling") {
      filterIndices.cooling.push(index);
    } else {
      filterIndices.expired.push(index);
    }

    if (item.tags && item.tags.includes("nsfw")) {
      filterIndices.nsfw.push(index);
    } else {
      filterIndices["no-nsfw"].push(index);
    }
  }

  function appendStats(stats, item) {
    stats.totalTokens += 1;
    if (item.status === "active") {
      stats.activeTokens += 1;
      stats.chatQuota += item.quota;
    } else if (item.status === "cooling") {
      stats.coolingTokens += 1;
    } else {
      stats.invalidTokens += 1;
    }

    if (item.tags && item.tags.includes("nsfw")) {
      stats.nsfwTokens += 1;
    } else {
      stats.noNsfwTokens += 1;
    }

    stats.totalCalls += normalizeCount(item.use_count);
  }

  function createState(selectedTokens) {
    return {
      flatTokens: [],
      tokenSet: new Set(),
      selectedTokenSet: new Set(selectedTokens || []),
      selectedCount: 0,
      stats: createEmptyStats(),
      filterIndices: createEmptyFilterIndices(),
    };
  }

  function appendPoolTokens(state, pool, tokens) {
    if (!Array.isArray(tokens) || !tokens.length) return state;

    for (let i = 0; i < tokens.length; i += 1) {
      const item = normalizeTokenEntry(
        pool,
        tokens[i],
        state.flatTokens.length,
        state.selectedTokenSet,
      );

      state.flatTokens.push(item);
      state.tokenSet.add(item.token);
      if (item._selected) state.selectedCount += 1;
      appendStats(state.stats, item);
      appendFilterIndex(state.filterIndices, item, item._index);
    }

    return state;
  }

  function getFilterIndices(state, filter) {
    const filterIndices = state && state.filterIndices ? state.filterIndices : createEmptyFilterIndices();
    return filterIndices[filter] || filterIndices.all;
  }

  function getPaginationData(state, filter, currentPage, pageSize) {
    const indices = getFilterIndices(state, filter);
    const totalCount = indices.length;
    const safePageSize = Math.max(1, Math.floor(Number(pageSize) || 1));
    const totalPages = Math.max(1, Math.ceil(totalCount / safePageSize));
    const safeCurrentPage = Math.min(Math.max(1, Math.floor(Number(currentPage) || 1)), totalPages);
    const startIndex = (safeCurrentPage - 1) * safePageSize;
    const visibleIndices = indices.slice(startIndex, startIndex + safePageSize);

    return {
      totalCount: totalCount,
      totalPages: totalPages,
      currentPage: safeCurrentPage,
      visibleIndices: visibleIndices,
      visibleTokens: visibleIndices.map(function (index) {
        return state.flatTokens[index];
      }),
    };
  }

  return {
    createEmptyStats: createEmptyStats,
    createEmptyFilterIndices: createEmptyFilterIndices,
    createState: createState,
    appendPoolTokens: appendPoolTokens,
    getFilterIndices: getFilterIndices,
    getPaginationData: getPaginationData,
  };
});
