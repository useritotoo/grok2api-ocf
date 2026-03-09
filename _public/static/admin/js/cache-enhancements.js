(() => {
  const LOCAL_PAGE_SIZES = [24, 48, 96];
  const ONLINE_PAGE_SIZES = [24, 48, 96];
  const DEFAULT_LOCAL_PAGE_SIZE = 24;
  const DEFAULT_ONLINE_PAGE_SIZE = 24;
  const onlineListState = { loaded: false, loading: false, page: 1, pageSize: DEFAULT_ONLINE_PAGE_SIZE, total: 0, totalPages: 1, items: [], allItems: [], serverPaginated: true };
  let lazyMediaObserver = null;
  let lightboxBound = false;

  function cacheStateLib() {
    return typeof CachePageState !== 'undefined' ? CachePageState : {
      truncateMiddle(value, maxLength) {
        const text = String(value || '');
        if (text.length <= maxLength) return text;
        return `${text.slice(0, 12)}...${text.slice(-10)}`;
      },
      paginateItems(items, currentPage, pageSize) {
        const safeItems = Array.isArray(items) ? items : [];
        const safePageSize = Math.max(1, Math.floor(Number(pageSize) || 1));
        const totalCount = safeItems.length;
        const totalPages = Math.max(1, Math.ceil(totalCount / safePageSize));
        const safePage = Math.min(Math.max(1, Math.floor(Number(currentPage) || 1)), totalPages);
        const startIndex = (safePage - 1) * safePageSize;
        return { totalCount, totalPages, currentPage: safePage, visibleItems: safeItems.slice(startIndex, startIndex + safePageSize) };
      },
      buildOnlineRows(args) {
        const accounts = Array.isArray(args && args.accounts) ? args.accounts : [];
        const details = Array.isArray(args && args.details) ? args.details : [];
        const online = args && args.online ? args.online : {};
        const states = args && args.accountStates instanceof Map ? args.accountStates : new Map();
        const detailMap = new Map(details.map((item) => [item.token, item]));
        return accounts.map((account) => {
          const detail = detailMap.get(account.token);
          const state = states.get(account.token);
          let count = '-';
          let status = 'not_loaded';
          let last_asset_clear_at = account.last_asset_clear_at;
          if (detail) {
            count = detail.count;
            status = detail.status;
            last_asset_clear_at = detail.last_asset_clear_at ?? last_asset_clear_at;
          } else if (account.token === online.token) {
            count = online.count;
            status = online.status;
            last_asset_clear_at = online.last_asset_clear_at ?? last_asset_clear_at;
          } else if (state) {
            count = state.count;
            status = state.status;
            last_asset_clear_at = state.last_asset_clear_at ?? last_asset_clear_at;
          }
          return { token: account.token, token_masked: account.token_masked || account.token, pool: account.pool || '-', count, status, last_asset_clear_at: last_asset_clear_at ?? null };
        });
      },
    };
  }

  function ensureEnhancedUI() {
    ui.localImageEmpty = ui.localImageEmpty || byId('local-image-empty');
    ui.localVideoEmpty = ui.localVideoEmpty || byId('local-video-empty');
    ui.onlinePrev = ui.onlinePrev || byId('online-prev');
    ui.onlineNext = ui.onlineNext || byId('online-next');
    ui.onlinePageInfo = ui.onlinePageInfo || byId('online-page-info');
    ui.onlinePageSize = ui.onlinePageSize || byId('online-page-size');
    ui.onlineSelectWrap = ui.onlineSelectWrap || byId('online-select-wrap');
    ui.onlineSelectTrigger = ui.onlineSelectTrigger || byId('online-select-trigger');
    ui.onlineSelectLabel = ui.onlineSelectLabel || byId('online-select-label');
    ui.onlineSelectCaret = ui.onlineSelectCaret || byId('online-select-caret');
    ui.onlineSelectPopover = ui.onlineSelectPopover || byId('online-select-popover');
    ui.onlineSelectPage = ui.onlineSelectPage || byId('online-select-page');
    ui.onlineSelectAllBtn = ui.onlineSelectAllBtn || byId('online-select-all');
    ui.cacheLightbox = ui.cacheLightbox || byId('cache-lightbox');
    ui.cacheLightboxBody = ui.cacheLightboxBody || byId('cache-lightbox-body');
    ui.cacheLightboxCaption = ui.cacheLightboxCaption || byId('cache-lightbox-caption');
    ui.cacheLightboxClose = ui.cacheLightboxClose || byId('cache-lightbox-close');
  }

  const originalCacheUI = cacheUI;
  cacheUI = function cacheUIEnhanced() {
    originalCacheUI();
    ensureEnhancedUI();
  };

  function setPageSizeOptions(select, values, selectedValue) {
    if (!select) return;
    const currentValue = Number(selectedValue) || values[0];
    select.innerHTML = '';
    values.forEach((size) => {
      const option = document.createElement('option');
      option.value = String(size);
      option.textContent = t('cache.perPage', { size });
      option.selected = size === currentValue;
      select.appendChild(option);
    });
  }

  setupPageSizeOptions = function setupPageSizeOptionsEnhanced(select, selectedValue) {
    if (!select) return;
    setPageSizeOptions(select, String(select.id || '').includes('online') ? ONLINE_PAGE_SIZES : LOCAL_PAGE_SIZES, selectedValue);
  };

  function getOnlinePaginationRefs() {
    ensureEnhancedUI();
    return { prev: ui.onlinePrev, next: ui.onlineNext, info: ui.onlinePageInfo, size: ui.onlinePageSize, wrap: ui.onlineSelectWrap, trigger: ui.onlineSelectTrigger, label: ui.onlineSelectLabel, caret: ui.onlineSelectCaret, popover: ui.onlineSelectPopover, selectPage: ui.onlineSelectPage, selectAll: ui.onlineSelectAllBtn };
  }

  function closeOnlineSelectMenu() {
    const refs = getOnlinePaginationRefs();
    if (refs.popover) refs.popover.classList.add('hidden');
  }

  function refreshOnlineSelectControl() {
    const refs = getOnlinePaginationRefs();
    const selectedCount = selectedTokens.size;
    if (refs.label) refs.label.textContent = selectedCount > 0 ? t('cache.clearSelection') : t('common.selectAll');
    if (refs.trigger) refs.trigger.classList.toggle('is-active', selectedCount > 0);
    if (refs.caret) refs.caret.style.display = selectedCount > 0 ? 'none' : 'inline';
  }

  function updateOnlinePaginationUI() {
    const refs = getOnlinePaginationRefs();
    const total = Math.max(0, Number(onlineListState.total) || 0);
    const totalPages = Math.max(1, Number(onlineListState.totalPages) || Math.ceil(total / Math.max(1, onlineListState.pageSize)) || 1);
    const page = Math.min(Math.max(1, Number(onlineListState.page) || 1), totalPages);
    onlineListState.page = page;
    onlineListState.totalPages = totalPages;
    if (refs.info) refs.info.textContent = t('cache.pagination', { current: page, total: totalPages, count: total });
    if (refs.prev) refs.prev.disabled = onlineListState.loading || page <= 1;
    if (refs.next) refs.next.disabled = onlineListState.loading || page >= totalPages;
    if (refs.size && String(refs.size.value) !== String(onlineListState.pageSize)) setPageSizeOptions(refs.size, ONLINE_PAGE_SIZES, onlineListState.pageSize);
    refreshOnlineSelectControl();
  }

  function getCurrentOnlinePageTokens() {
    return (Array.isArray(onlineListState.items) ? onlineListState.items : []).map((item) => item.token).filter(Boolean);
  }

  function ensureLazyObserver() {
    if (lazyMediaObserver || typeof IntersectionObserver === 'undefined') return lazyMediaObserver;
    lazyMediaObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const src = entry.target.getAttribute('data-src');
        if (src) entry.target.setAttribute('src', src);
        entry.target.removeAttribute('data-src');
        lazyMediaObserver.unobserve(entry.target);
      });
    }, { rootMargin: '160px 0px', threshold: 0.01 });
    return lazyMediaObserver;
  }

  function mountLazyImage(img, src) {
    if (!img || !src) return;
    img.loading = 'lazy';
    img.decoding = 'async';
    const observer = ensureLazyObserver();
    if (!observer) {
      img.src = src;
      return;
    }
    img.setAttribute('data-src', src);
    observer.observe(img);
  }

  function statusClassName(status) {
    const text = String(status || '').toLowerCase();
    if (text === 'ok' || text === 'active') return 'is-ok';
    if (text === 'not_loaded' || text === 'loading') return 'is-muted';
    if (text.includes('error') || text === 'expired' || text === 'disabled') return 'is-error';
    return 'is-muted';
  }

  function formatAssetName(name) {
    return cacheStateLib().truncateMiddle(name, 30);
  }

  function createBadge(text, className = '') {
    const badge = document.createElement('span');
    badge.className = `cache-entry-badge ${className}`.trim();
    badge.textContent = String(text || '-');
    return badge;
  }

  function buildCardShell(selected) {
    const card = document.createElement('article');
    card.className = 'cache-entry-card';
    if (selected) card.classList.add('row-selected');
    return card;
  }

  function createCheckbox(name, checked, onChange, dataKey) {
    const wrap = document.createElement('label');
    wrap.className = 'cache-card-checkbox';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'checkbox';
    checkbox.checked = checked;
    checkbox.setAttribute(dataKey, name);
    checkbox.addEventListener('change', onChange);
    wrap.appendChild(checkbox);
    return { wrap, checkbox };
  }
  function openCacheLightbox(type, src, label) {
    ensureEnhancedUI();
    if (!ui.cacheLightbox || !ui.cacheLightboxBody) return;
    ui.cacheLightboxBody.innerHTML = '';
    if (type === 'video') {
      const video = document.createElement('video');
      video.controls = true;
      video.autoplay = true;
      video.preload = 'metadata';
      video.src = src;
      ui.cacheLightboxBody.appendChild(video);
    } else {
      const img = document.createElement('img');
      img.src = src;
      img.alt = label || '';
      ui.cacheLightboxBody.appendChild(img);
    }
    if (ui.cacheLightboxCaption) {
      ui.cacheLightboxCaption.textContent = label || '';
      ui.cacheLightboxCaption.title = label || '';
    }
    ui.cacheLightbox.classList.add('active');
  }

  function closeCacheLightbox() {
    ensureEnhancedUI();
    if (!ui.cacheLightbox || !ui.cacheLightboxBody) return;
    ui.cacheLightbox.classList.remove('active');
    ui.cacheLightboxBody.innerHTML = '';
  }

  function setupCacheLightbox() {
    ensureEnhancedUI();
    if (lightboxBound || !ui.cacheLightbox) return;
    lightboxBound = true;
    if (ui.cacheLightboxClose) ui.cacheLightboxClose.addEventListener('click', closeCacheLightbox);
    ui.cacheLightbox.addEventListener('click', (event) => {
      if (event.target === ui.cacheLightbox) closeCacheLightbox();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && ui.cacheLightbox.classList.contains('active')) closeCacheLightbox();
    });
  }

  function buildLocalMediaPreview(type, item) {
    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = `cache-entry-preview cache-entry-preview--${type}`;
    const name = String((item && item.name) || '');
    const mediaUrl = type === 'image' ? (item.preview_url || `/v1/files/image/${encodeURIComponent(name)}`) : `/v1/files/video/${encodeURIComponent(name)}`;
    preview.addEventListener('click', () => openCacheLightbox(type, mediaUrl, name));
    if (type === 'image') {
      const img = document.createElement('img');
      img.alt = name;
      mountLazyImage(img, mediaUrl);
      preview.appendChild(img);
    } else {
      const icon = document.createElement('div');
      icon.className = 'cache-preview-icon';
      icon.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
      const label = document.createElement('span');
      label.className = 'cache-preview-label';
      label.textContent = 'Video';
      preview.appendChild(icon);
      preview.appendChild(label);
    }
    return preview;
  }

  function buildOnlinePreview(pool) {
    const preview = document.createElement('div');
    preview.className = 'cache-entry-preview cache-entry-preview--online';
    const label = document.createElement('span');
    label.className = 'cache-preview-label';
    label.textContent = String(pool || '-').slice(0, 2).toUpperCase();
    preview.appendChild(label);
    return preview;
  }

  function createActionButton(title, svg, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cache-icon-button';
    button.title = title;
    button.innerHTML = svg;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  function createLocalCard(type, item) {
    const selected = selectedLocal[type] && selectedLocal[type].has(item.name);
    const card = buildCardShell(selected);
    const checkboxData = createCheckbox(item.name, selected, (event) => toggleLocalSelect(type, item.name, event.target), 'data-name');
    const content = document.createElement('div');
    content.className = 'cache-entry-content';
    content.appendChild(buildLocalMediaPreview(type, item));

    const details = document.createElement('div');
    details.className = 'cache-entry-details';
    const title = document.createElement('div');
    title.className = 'cache-entry-title';
    title.textContent = formatAssetName(item.name);
    title.title = item.name;
    const meta = document.createElement('div');
    meta.className = 'cache-entry-meta';
    meta.appendChild(createBadge(type === 'image' ? 'Image' : 'Video', 'cache-entry-badge--subtle'));
    meta.appendChild(createBadge(formatSize(item.size_bytes), 'cache-entry-badge--plain'));
    meta.appendChild(createBadge(formatTime(item.mtime_ms) || '-', 'cache-entry-badge--plain'));
    details.appendChild(title);
    details.appendChild(meta);
    content.appendChild(details);

    const actions = document.createElement('div');
    actions.className = 'cache-list-actions';
    actions.appendChild(createActionButton(t('common.view'), '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"></path><circle cx="12" cy="12" r="3"></circle></svg>', () => viewLocalFile(type, item.name)));
    actions.appendChild(createActionButton(t('common.delete'), '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>', () => deleteLocalFile(type, item.name)));

    card.appendChild(checkboxData.wrap);
    card.appendChild(content);
    card.appendChild(actions);
    return card;
  }

  function createOnlineCard(row) {
    const selected = selectedTokens.has(row.token);
    const card = buildCardShell(selected);
    const checkboxData = createCheckbox(row.token, selected, (event) => toggleSelect(row.token, event.target), 'data-token');
    const content = document.createElement('div');
    content.className = 'cache-entry-content';
    content.appendChild(buildOnlinePreview(row.pool));

    const details = document.createElement('div');
    details.className = 'cache-entry-details';
    const title = document.createElement('div');
    title.className = 'cache-entry-title';
    title.textContent = cacheStateLib().truncateMiddle(row.token_masked || row.token, 26);
    title.title = row.token;
    const meta = document.createElement('div');
    meta.className = 'cache-entry-meta';
    meta.appendChild(createBadge(row.pool || '-', 'cache-entry-badge--subtle'));
    meta.appendChild(createBadge(row.count === '-' ? t('cache.notLoaded') : row.count, 'cache-entry-badge--plain'));
    meta.appendChild(createBadge(formatTime(row.last_asset_clear_at) || '-', 'cache-entry-badge--plain'));
    meta.appendChild(createBadge(row.status || t('cache.notLoaded'), `cache-entry-badge--status ${statusClassName(row.status)}`));
    details.appendChild(title);
    details.appendChild(meta);
    content.appendChild(details);

    const actions = document.createElement('div');
    actions.className = 'cache-list-actions';
    actions.appendChild(createActionButton(t('cache.clear'), '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>', () => clearOnlineCache(row.token)));

    card.appendChild(checkboxData.wrap);
    card.appendChild(content);
    card.appendChild(actions);
    return card;
  }

  function renderEmptyState(container, empty, text) {
    if (container) container.replaceChildren();
    if (empty) {
      empty.textContent = text;
      empty.classList.remove('hidden');
    }
  }

  loadStats = async function loadStatsEnhanced(options = {}) {
    try {
      ensureUI();
      ensureEnhancedUI();
      const merge = options.merge === true;
      const includeAccounts = options.includeAccounts === true || (options.includeAccounts !== false && currentSection === 'online');
      const includeDetails = options.includeDetails === true;
      const applyToView = options.applyToView !== false;
      const params = new URLSearchParams();
      params.set('include_accounts', includeAccounts ? '1' : '0');
      params.set('include_details', includeDetails ? '1' : '0');
      if (includeAccounts) {
        params.set('accounts_page', String(options.accountsPage ?? onlineListState.page));
        params.set('accounts_page_size', String(options.accountsPageSize ?? onlineListState.pageSize));
      }
      if (options.tokens && options.tokens.length) {
        params.set('tokens', options.tokens.join(','));
        currentScope = 'selected';
      } else if (options.scope === 'all') {
        params.set('scope', 'all');
        currentScope = 'all';
      } else if (options.token) {
        params.set('token', options.token);
        currentScope = 'single';
      }
      const res = await fetch(`/v1/admin/cache?${params.toString()}`, { headers: buildAuthHeaders(apiKey) });
      if (res.status === 401) {
        logout();
        return null;
      }
      const data = await res.json();
      if (applyToView) applyStatsData(data, merge);
      return data;
    } catch (error) {
      if (!options.silent) showToast(t('cache.loadStatsFailed'), 'error');
      return null;
    }
  };

  updateAccountSelect = function updateAccountSelectEnhanced(accounts) {
    (Array.isArray(accounts) ? accounts : []).forEach((account) => {
      if (account && account.token) accountMap.set(account.token, account);
    });
  };

  applyStatsData = function applyStatsDataEnhanced(data, merge = false) {
    ensureEnhancedUI();
    setText(ui.imgCount, data.local_image.count);
    setText(ui.imgSize, `${data.local_image.size_mb} MB`);
    setText(ui.videoCount, data.local_video.count);
    setText(ui.videoSize, `${data.local_video.size_mb} MB`);
    setText(ui.onlineCount, data.online.count);
    const online = data.online || {};
    const status = resolveOnlineStatus(online.status);
    setOnlineStatus(status.text, status.className);
    updateAccountSelect(data.online_accounts || []);
    const details = Array.isArray(data.online_details) ? data.online_details : [];
    details.forEach((detail) => {
      accountStates.set(detail.token, { count: detail.count, status: detail.status, last_asset_clear_at: detail.last_asset_clear_at });
    });
    if (online && online.token) {
      accountStates.set(online.token, { count: online.count, status: online.status, last_asset_clear_at: online.last_asset_clear_at });
    }
    const accounts = Array.isArray(data.online_accounts) ? data.online_accounts : [];
    const hasServerPage = Number(data.online_accounts_page_size) > 0;
    if (hasServerPage) {
      onlineListState.serverPaginated = true;
      onlineListState.items = accounts;
      onlineListState.allItems = [];
      onlineListState.total = Math.max(0, Number(data.online_accounts_total) || accounts.length);
      onlineListState.page = Math.max(1, Number(data.online_accounts_page) || 1);
      onlineListState.pageSize = Math.max(1, Number(data.online_accounts_page_size) || DEFAULT_ONLINE_PAGE_SIZE);
      onlineListState.totalPages = Math.max(1, Number(data.online_accounts_total_pages) || Math.ceil(onlineListState.total / onlineListState.pageSize) || 1);
      onlineListState.loaded = true;
      onlineListState.loading = false;
    } else if (accounts.length) {
      const pageData = cacheStateLib().paginateItems(accounts, onlineListState.page, onlineListState.pageSize);
      onlineListState.serverPaginated = false;
      onlineListState.allItems = accounts;
      onlineListState.items = pageData.visibleItems;
      onlineListState.total = pageData.totalCount;
      onlineListState.page = pageData.currentPage;
      onlineListState.totalPages = pageData.totalPages;
      onlineListState.loaded = true;
      onlineListState.loading = false;
    }
    const timeText = formatTime(online.last_asset_clear_at);
    setText(ui.onlineLastClear, timeText ? t('cache.lastClear', { time: timeText }) : '');
    updateOnlinePaginationUI();
    if (currentSection === 'online') renderAccountTable({ online_accounts: onlineListState.items, online_details: details, online });
  };
  renderAccountTable = function renderAccountTableEnhanced(data) {
    ensureEnhancedUI();
    const body = ui.accountTableBody;
    const empty = ui.accountEmpty;
    if (!body || !empty) return;
    const rows = cacheStateLib().buildOnlineRows({ accounts: Array.isArray(data.online_accounts) && data.online_accounts.length ? data.online_accounts : onlineListState.items, details: Array.isArray(data.online_details) ? data.online_details : [], online: data.online || {}, accountStates });
    if (!rows.length) {
      renderEmptyState(body, empty, t('cache.noAccounts'));
      updateSelectedCount();
      return;
    }
    empty.classList.add('hidden');
    const fragment = document.createDocumentFragment();
    rows.forEach((row) => fragment.appendChild(createOnlineCard(row)));
    body.replaceChildren(fragment);
    updateSelectedCount();
  };

  syncRowCheckboxes = function syncRowCheckboxesEnhanced() {
    const body = ui.accountTableBody;
    if (!body) return;
    body.querySelectorAll('input[type="checkbox"].checkbox').forEach((checkbox) => {
      const token = checkbox.getAttribute('data-token');
      if (!token) return;
      checkbox.checked = selectedTokens.has(token);
      const card = checkbox.closest('.cache-entry-card');
      if (card) card.classList.toggle('row-selected', checkbox.checked);
    });
    refreshOnlineSelectControl();
  };

  syncSelectAllState = function syncSelectAllStateEnhanced() {
    refreshOnlineSelectControl();
  };

  toggleSelect = function toggleSelectEnhanced(token, checkbox) {
    if (checkbox && checkbox.checked) selectedTokens.add(token);
    else selectedTokens.delete(token);
    if (checkbox) {
      const card = checkbox.closest('.cache-entry-card');
      if (card) card.classList.toggle('row-selected', checkbox.checked);
    }
    refreshOnlineSelectControl();
    updateSelectedCount();
  };

  toggleLocalSelect = function toggleLocalSelectEnhanced(type, name, checkbox) {
    const set = selectedLocal[type];
    if (!set) return;
    if (checkbox && checkbox.checked) set.add(name);
    else set.delete(name);
    if (checkbox) {
      const card = checkbox.closest('.cache-entry-card');
      if (card) card.classList.toggle('row-selected', checkbox.checked);
    }
    syncLocalSelectAllState(type);
    updateSelectedCount();
  };

  syncLocalRowCheckboxes = function syncLocalRowCheckboxesEnhanced(type) {
    const body = type === 'image' ? ui.localImageBody : ui.localVideoBody;
    if (!body) return;
    const set = selectedLocal[type];
    body.querySelectorAll('input[type="checkbox"].checkbox').forEach((checkbox) => {
      const name = checkbox.getAttribute('data-name');
      if (!name) return;
      checkbox.checked = set.has(name);
      const card = checkbox.closest('.cache-entry-card');
      if (card) card.classList.toggle('row-selected', checkbox.checked);
    });
    syncLocalSelectAllState(type);
  };

  updateSelectedCount = function updateSelectedCountEnhanced() {
    const el = ui.selectedCount;
    const selected = getActiveSelectedSet().size;
    if (el) el.textContent = String(selected);
    refreshLocalSelectControl('image');
    refreshLocalSelectControl('video');
    refreshOnlineSelectControl();
    setActionButtonsState();
    updateBatchActionsVisibility();
  };

  async function fetchAllOnlineTokens() {
    const tokens = [];
    let page = 1;
    while (true) {
      const data = await loadStats({ includeAccounts: true, includeDetails: false, accountsPage: page, accountsPageSize: 200, silent: true, applyToView: false });
      if (!data) break;
      const accounts = Array.isArray(data.online_accounts) ? data.online_accounts : [];
      accounts.forEach((account) => { if (account && account.token) tokens.push(account.token); });
      const totalPages = Math.max(1, Number(data.online_accounts_total_pages) || 1);
      if (page >= totalPages || accounts.length === 0) break;
      page += 1;
    }
    return [...new Set(tokens)];
  }

  async function loadOnlineAccountsPage(options = {}) {
    ensureEnhancedUI();
    if (!options.forceRemote && !onlineListState.serverPaginated && onlineListState.allItems.length) {
      const pageData = cacheStateLib().paginateItems(onlineListState.allItems, options.page ?? onlineListState.page, options.pageSize ?? onlineListState.pageSize);
      onlineListState.items = pageData.visibleItems;
      onlineListState.total = pageData.totalCount;
      onlineListState.totalPages = pageData.totalPages;
      onlineListState.page = pageData.currentPage;
      onlineListState.pageSize = Math.max(1, Number(options.pageSize ?? onlineListState.pageSize));
      renderAccountTable({ online_accounts: onlineListState.items, online_details: [], online: {} });
      updateOnlinePaginationUI();
      return;
    }
    onlineListState.loading = true;
    onlineListState.page = Math.max(1, Number(options.page ?? onlineListState.page));
    onlineListState.pageSize = Math.max(1, Number(options.pageSize ?? onlineListState.pageSize));
    updateOnlinePaginationUI();
    await loadStats({ includeAccounts: true, includeDetails: false, accountsPage: onlineListState.page, accountsPageSize: onlineListState.pageSize, silent: options.silent === true });
  }

  showCacheSection = async function showCacheSectionEnhanced(type) {
    ensureUI();
    ensureEnhancedUI();
    currentSection = type;
    if (ui.cacheCards) {
      ui.cacheCards.forEach((card) => {
        const cardType = card.getAttribute('data-type');
        card.classList.toggle('selected', cardType === type);
      });
    }
    if (type === 'image') {
      cacheListState.image.visible = true;
      cacheListState.video.visible = false;
      if (cacheListState.image.loaded) renderLocalCacheList('image', cacheListState.image.items);
      else await loadLocalCacheList('image');
      if (ui.localCacheLists) ui.localCacheLists.classList.remove('hidden');
      if (ui.localImageList) ui.localImageList.classList.remove('hidden');
      if (ui.localVideoList) ui.localVideoList.classList.add('hidden');
      if (ui.onlineAssetsTable) ui.onlineAssetsTable.classList.add('hidden');
      updateToolbarForSection();
      return;
    }
    if (type === 'video') {
      cacheListState.video.visible = true;
      cacheListState.image.visible = false;
      if (cacheListState.video.loaded) renderLocalCacheList('video', cacheListState.video.items);
      else await loadLocalCacheList('video');
      if (ui.localCacheLists) ui.localCacheLists.classList.remove('hidden');
      if (ui.localVideoList) ui.localVideoList.classList.remove('hidden');
      if (ui.localImageList) ui.localImageList.classList.add('hidden');
      if (ui.onlineAssetsTable) ui.onlineAssetsTable.classList.add('hidden');
      updateToolbarForSection();
      return;
    }
    if (type === 'online') {
      cacheListState.image.visible = false;
      cacheListState.video.visible = false;
      if (ui.localCacheLists) ui.localCacheLists.classList.add('hidden');
      if (ui.localImageList) ui.localImageList.classList.add('hidden');
      if (ui.localVideoList) ui.localVideoList.classList.add('hidden');
      if (ui.onlineAssetsTable) ui.onlineAssetsTable.classList.remove('hidden');
      if (!onlineListState.loaded) await loadOnlineAccountsPage({ silent: true });
      else {
        renderAccountTable({ online_accounts: onlineListState.items, online_details: [], online: {} });
        updateOnlinePaginationUI();
      }
      updateToolbarForSection();
    }
  };

  loadLocalCacheList = async function loadLocalCacheListEnhanced(type, options = {}) {
    const body = type === 'image' ? ui.localImageBody : ui.localVideoBody;
    const empty = type === 'image' ? ui.localImageEmpty : ui.localVideoEmpty;
    if (!body) return;
    const state = getLocalState(type);
    if (!state) return;
    const pageSize = Math.max(1, parseInt(options.pageSize ?? state.pageSize ?? DEFAULT_LOCAL_PAGE_SIZE, 10) || DEFAULT_LOCAL_PAGE_SIZE);
    const targetPage = Math.max(1, parseInt(options.page ?? state.page ?? 1, 10) || 1);
    state.loading = true;
    state.pageSize = pageSize;
    state.page = targetPage;
    updateLocalPaginationUI(type);
    renderEmptyState(body, empty, t('common.loading'));
    try {
      const params = new URLSearchParams({ type, page: String(targetPage), page_size: String(pageSize) });
      const res = await fetch(`/v1/admin/cache/list?${params.toString()}`, { headers: buildAuthHeaders(apiKey) });
      if (!res.ok) {
        renderEmptyState(body, empty, t('common.loadFailed'));
        state.loading = false;
        updateLocalPaginationUI(type);
        return;
      }
      const data = await res.json();
      const items = Array.isArray(data.items) ? data.items : [];
      const total = Math.max(0, Number(data.total) || 0);
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      if (total > 0 && targetPage > totalPages) {
        state.loading = false;
        await loadLocalCacheList(type, { page: totalPages, pageSize });
        return;
      }
      state.items = items;
      state.total = total;
      state.page = Math.min(targetPage, totalPages);
      state.pageSize = pageSize;
      state.loaded = true;
      state.loading = false;
      renderLocalCacheList(type, items);
    } catch (error) {
      renderEmptyState(body, empty, t('common.loadFailed'));
      state.loading = false;
      updateLocalPaginationUI(type);
    }
  };

  renderLocalCacheList = function renderLocalCacheListEnhanced(type, items) {
    const body = type === 'image' ? ui.localImageBody : ui.localVideoBody;
    const empty = type === 'image' ? ui.localImageEmpty : ui.localVideoEmpty;
    if (!body) return;
    if (!items || items.length === 0) {
      renderEmptyState(body, empty, t('cache.noFiles'));
      syncLocalSelectAllState(type);
      updateLocalPaginationUI(type);
      updateSelectedCount();
      return;
    }
    if (empty) empty.classList.add('hidden');
    const fragment = document.createDocumentFragment();
    items.forEach((item) => fragment.appendChild(createLocalCard(type, item)));
    body.replaceChildren(fragment);
    syncLocalSelectAllState(type);
    updateLocalPaginationUI(type);
    updateSelectedCount();
  };

  viewLocalFile = function viewLocalFileEnhanced(type, name) {
    const safeName = encodeURIComponent(name);
    openCacheLightbox(type, type === 'image' ? `/v1/files/image/${safeName}` : `/v1/files/video/${safeName}`, name);
  };

  function setupOnlinePaginationControls() {
    ensureEnhancedUI();
    setPageSizeOptions(ui.onlinePageSize, ONLINE_PAGE_SIZES, onlineListState.pageSize);
    if (ui.onlinePrev) ui.onlinePrev.addEventListener('click', () => { if (!onlineListState.loading && onlineListState.page > 1) { closeOnlineSelectMenu(); loadOnlineAccountsPage({ page: onlineListState.page - 1, forceRemote: onlineListState.serverPaginated }); } });
    if (ui.onlineNext) ui.onlineNext.addEventListener('click', () => { if (!onlineListState.loading && onlineListState.page < onlineListState.totalPages) { closeOnlineSelectMenu(); loadOnlineAccountsPage({ page: onlineListState.page + 1, forceRemote: onlineListState.serverPaginated }); } });
    if (ui.onlinePageSize) ui.onlinePageSize.addEventListener('change', () => { const size = Math.max(1, parseInt(ui.onlinePageSize.value, 10) || DEFAULT_ONLINE_PAGE_SIZE); onlineListState.pageSize = size; onlineListState.page = 1; closeOnlineSelectMenu(); loadOnlineAccountsPage({ page: 1, pageSize: size, forceRemote: onlineListState.serverPaginated }); });
    if (ui.onlineSelectTrigger) ui.onlineSelectTrigger.addEventListener('click', () => { if (selectedTokens.size > 0) { selectedTokens.clear(); syncRowCheckboxes(); updateSelectedCount(); closeOnlineSelectMenu(); return; } if (ui.onlineSelectPopover) ui.onlineSelectPopover.classList.toggle('hidden'); });
    if (ui.onlineSelectPage) ui.onlineSelectPage.addEventListener('click', () => { getCurrentOnlinePageTokens().forEach((token) => selectedTokens.add(token)); syncRowCheckboxes(); updateSelectedCount(); closeOnlineSelectMenu(); });
    if (ui.onlineSelectAllBtn) ui.onlineSelectAllBtn.addEventListener('click', async () => { try { const tokens = await fetchAllOnlineTokens(); selectedTokens.clear(); tokens.forEach((token) => selectedTokens.add(token)); syncRowCheckboxes(); updateSelectedCount(); } catch (error) { showToast(t('common.requestFailed'), 'error'); } finally { closeOnlineSelectMenu(); } });
    document.addEventListener('click', (event) => { const refs = getOnlinePaginationRefs(); if (refs.wrap && refs.wrap.contains(event.target)) return; closeOnlineSelectMenu(); });
  }

  init = async function initEnhanced() {
    apiKey = await ensureAdminKey();
    if (apiKey === null) return;
    cacheUI();
    setupLocalPaginationControls();
    setupOnlinePaginationControls();
    setupCacheCards();
    setupConfirmDialog();
    setupFailureDialog();
    setupBatchControls();
    setupCacheLightbox();
    await loadStats({ includeAccounts: false, includeDetails: false });
    await showCacheSection('image');
  };

  window.onload = init;
})();