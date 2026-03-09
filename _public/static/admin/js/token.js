let apiKey = '';
let allTokens = {};
let flatTokens = [];
let tokenLookup = new Set();
let tokenPageState = TokenPageState.createState();
let selectedCount = 0;
let isBatchProcessing = false;
let isBatchPaused = false;
let batchQueue = [];
let batchTotal = 0;
let batchProcessed = 0;
let currentBatchAction = null;
let currentFilter = 'all';
let currentBatchTaskId = null;
let batchEventSource = null;
let currentPage = 1;
let pageSize = 50;

const byId = (id) => document.getElementById(id);
const qsa = (selector) => document.querySelectorAll(selector);
const DEFAULT_QUOTA_BASIC = 80;
const DEFAULT_QUOTA_SUPER = 140;
const TOKEN_PROCESS_CHUNK_SIZE = 400;

function getDefaultQuotaForPool(pool) {
  return pool === 'ssoSuper' ? DEFAULT_QUOTA_SUPER : DEFAULT_QUOTA_BASIC;
}

function showLoadingText(text) {
  const loading = byId('loading');
  if (!loading) return;
  loading.textContent = text;
  loading.classList.remove('hidden');
}

function hideLoadingText() {
  const loading = byId('loading');
  if (loading) loading.classList.add('hidden');
}

function yieldToMainThread() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });
}

function getSelectedTokenKeys() {
  if (selectedCount === 0) return [];
  return flatTokens.filter(t => t._selected).map(t => t.token);
}

function getCurrentFilterIndices() {
  return TokenPageState.getFilterIndices(tokenPageState, currentFilter);
}

function applyTokenPageState(nextState) {
  tokenPageState = nextState;
  flatTokens = nextState.flatTokens;
  tokenLookup = nextState.tokenSet;
  selectedCount = nextState.selectedCount;
}

function rebuildTokenPageState() {
  const nextState = TokenPageState.createState(getSelectedTokenKeys());
  flatTokens.forEach((item) => {
    TokenPageState.appendPoolTokens(nextState, item.pool || 'ssoBasic', [item]);
  });
  applyTokenPageState(nextState);
}

function setText(id, text) {
  const el = byId(id);
  if (el) el.innerText = text;
}

function openModal(id) {
  const modal = byId(id);
  if (!modal) return null;
  modal.classList.remove('hidden');
  requestAnimationFrame(() => {
    modal.classList.add('is-open');
  });
  return modal;
}

function closeModal(id, onClose) {
  const modal = byId(id);
  if (!modal) return;
  modal.classList.remove('is-open');
  setTimeout(() => {
    modal.classList.add('hidden');
    if (onClose) onClose();
  }, 200);
}

function downloadTextFile(content, filename) {
  const blob = new Blob([content], { type: 'text/plain' });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  window.URL.revokeObjectURL(url);
  document.body.removeChild(a);
}

async function readJsonResponse(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(t('token.notValidJson', { status: res.status }));
  }
}

function getSelectedTokens() {
  if (selectedCount === 0) return [];
  return flatTokens.filter(t => t._selected);
}

function countSelected(tokens) {
  let count = 0;
  for (const t of tokens) {
    if (t._selected) count++;
  }
  return count;
}

function setSelectedForTokens(tokens, selected) {
  tokens.forEach(t => {
    if (t._selected === selected) return;
    t._selected = selected;
    selectedCount += selected ? 1 : -1;
  });
}

function syncVisibleSelectionUI(selected) {
  qsa('#token-table-body input[type="checkbox"]').forEach(input => {
    input.checked = selected;
  });
  qsa('#token-table-body tr').forEach(row => {
    row.classList.toggle('row-selected', selected);
  });
}

function getPaginationData() {
  const page = TokenPageState.getPaginationData(tokenPageState, currentFilter, currentPage, pageSize);
  currentPage = page.currentPage;
  return page;
}

async function init() {
  apiKey = await ensureAdminKey();
  if (apiKey === null) return;
  setupEditPoolDefaults();
  setupConfirmDialog();
  setupSelectAllMenu();
  refreshPageSizeOptionsI18n();
  loadData();
}

async function loadData() {
  try {
    showLoadingText(t('common.loading'));
    const res = await fetch('/v1/admin/tokens', {
      headers: buildAuthHeaders(apiKey)
    });
    if (res.ok) {
      const data = await res.json();
      allTokens = data;
      await processTokens(data);
      updateStats();
      renderTable();
    } else if (res.status === 401) {
      logout();
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (e) {
    showToast(t('common.loadError', { msg: e.message }), 'error');
  }
}

// Convert pool dict to flattened array
async function processTokens(data) {
  const nextState = TokenPageState.createState(getSelectedTokenKeys());
  const pools = Object.keys(data);
  const totalCount = pools.reduce((count, pool) => {
    const tokens = data[pool];
    return count + (Array.isArray(tokens) ? tokens.length : 0);
  }, 0);
  let processedCount = 0;

  for (const pool of pools) {
    const tokens = Array.isArray(data[pool]) ? data[pool] : [];
    for (let i = 0; i < tokens.length; i += TOKEN_PROCESS_CHUNK_SIZE) {
      const chunk = tokens.slice(i, i + TOKEN_PROCESS_CHUNK_SIZE);
      TokenPageState.appendPoolTokens(nextState, pool, chunk);
      processedCount += chunk.length;
      if (totalCount > TOKEN_PROCESS_CHUNK_SIZE) {
        showLoadingText(`${t('common.loading')} ${processedCount}/${totalCount}`);
        await yieldToMainThread();
      }
    }
  }

  applyTokenPageState(nextState);
}

function updateStats() {
  const stats = tokenPageState.stats || TokenPageState.createEmptyStats();
  const imageQuota = Math.floor(stats.chatQuota / 2);

  setText('stat-total', stats.totalTokens.toLocaleString());
  setText('stat-active', stats.activeTokens.toLocaleString());
  setText('stat-cooling', stats.coolingTokens.toLocaleString());
  setText('stat-invalid', stats.invalidTokens.toLocaleString());

  setText('stat-chat-quota', stats.chatQuota.toLocaleString());
  setText('stat-image-quota', imageQuota.toLocaleString());
  setText('stat-total-calls', stats.totalCalls.toLocaleString());

  updateTabCounts({
    all: stats.totalTokens,
    active: stats.activeTokens,
    cooling: stats.coolingTokens,
    expired: stats.invalidTokens,
    nsfw: stats.nsfwTokens,
    'no-nsfw': stats.noNsfwTokens
  });
}

function renderTable() {
  const tbody = byId('token-table-body');
  const emptyState = byId('empty-state');
  hideLoadingText();

  // 获取筛选后的列表
  const { totalCount, totalPages, visibleTokens } = getPaginationData();

  updatePaginationControls(totalCount, totalPages);

  if (visibleTokens.length === 0) {
    tbody.replaceChildren();
    if (emptyState) {
      emptyState.textContent = currentFilter === 'all'
        ? t('token.emptyState')
        : t('token.emptyFilterState');
    }
    emptyState.classList.remove('hidden');
    updateSelectionState();
    return;
  }
  emptyState.classList.add('hidden');

  const fragment = document.createDocumentFragment();
  visibleTokens.forEach((item) => {
    // 获取原始索引用于操作
    const originalIndex = item._index;
    const tr = document.createElement('tr');
    tr.dataset.index = originalIndex;
    if (item._selected) tr.classList.add('row-selected');

    // Checkbox (Center)
    const tdCheck = document.createElement('td');
    tdCheck.className = 'text-center';
    tdCheck.innerHTML = `<input type="checkbox" class="checkbox" ${item._selected ? 'checked' : ''} onchange="toggleSelect(${originalIndex})">`;

    // Token (Left)
    const tdToken = document.createElement('td');
    tdToken.className = 'text-left';
    const tokenShort = item.token.length > 24
      ? item.token.substring(0, 8) + '...' + item.token.substring(item.token.length - 16)
      : item.token;
    tdToken.innerHTML = `
                <div class="flex items-center gap-2">
                    <span class="font-mono text-xs text-gray-500" title="${item.token}">${tokenShort}</span>
                    <button class="text-gray-400 hover:text-black transition-colors" onclick="copyToClipboard('${item.token}', this)">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                    </button>
                </div>
             `;

    // Type (Center)
    const tdType = document.createElement('td');
    tdType.className = 'text-center';
    tdType.innerHTML = `<span class="badge badge-gray">${escapeHtml(item.pool)}</span>`;

    // Status (Center) - 显示状态和 nsfw 标签
    const tdStatus = document.createElement('td');
    let statusClass = 'badge-gray';
    if (item.status === 'active') statusClass = 'badge-green';
    else if (item.status === 'cooling') statusClass = 'badge-orange';
    else if (item.status === 'expired') statusClass = 'badge-red';
    else statusClass = 'badge-gray';
    tdStatus.className = 'text-center';
    let statusHtml = `<span class="badge ${statusClass}">${item.status}</span>`;
    if (item.tags && item.tags.includes('nsfw')) {
      statusHtml += ` <span class="badge badge-purple">nsfw</span>`;
    }
    tdStatus.innerHTML = statusHtml;

    // Quota (Center)
    const tdQuota = document.createElement('td');
    tdQuota.className = 'text-center font-mono text-xs';
    tdQuota.innerText = item.quota;

    // Note (Left)
    const tdNote = document.createElement('td');
    tdNote.className = 'text-left text-gray-500 text-xs truncate max-w-[150px]';
    tdNote.innerText = item.note || '-';

    // Actions (Center)
    const tdActions = document.createElement('td');
    tdActions.className = 'text-center';
    const isDisabled = item.status === 'disabled';
    const toggleTitle = isDisabled ? t('token.enableToken') : t('token.disableToken');
    const toggleIcon = isDisabled
      ? '<polyline points="20 6 9 17 4 12"></polyline>'
      : '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>';
    const toggleClass = isDisabled
      ? 'p-1 text-gray-400 hover:text-green-600 rounded'
      : 'p-1 text-gray-400 hover:text-orange-600 rounded';
    tdActions.innerHTML = `
                <div class="flex items-center justify-center gap-2">
                     <button onclick="refreshStatus('${item.token}')" class="p-1 text-gray-400 hover:text-black rounded" title="${t('token.refreshStatus')}">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
                     </button>
                     <button onclick="toggleTokenEnabled(${originalIndex})" class="${toggleClass}" title="${toggleTitle}">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${toggleIcon}</svg>
                     </button>
                     <button onclick="openEditModal(${originalIndex})" class="p-1 text-gray-400 hover:text-black rounded" title="${t('common.edit')}">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                     </button>
                     <button onclick="deleteToken(${originalIndex})" class="p-1 text-gray-400 hover:text-red-600 rounded" title="${t('common.delete')}">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                     </button>
                </div>
             `;

    tr.appendChild(tdCheck);
    tr.appendChild(tdToken);
    tr.appendChild(tdType);
    tr.appendChild(tdStatus);
    tr.appendChild(tdQuota);
    tr.appendChild(tdNote);
    tr.appendChild(tdActions);

    fragment.appendChild(tr);
  });

  tbody.replaceChildren(fragment);
  updateSelectionState();
}

// Selection Logic
function toggleSelectAll() {
  const checkbox = byId('select-all');
  const checked = !!(checkbox && checkbox.checked);
  // 只选择当前页可见的 Token
  setSelectedForTokens(getVisibleTokens(), checked);
  syncVisibleSelectionUI(checked);
  updateSelectionState();
}

function closeSelectAllMenu() {
  const popover = byId('select-all-popover');
  if (popover) popover.classList.add('hidden');
}

function openSelectAllMenu() {
  const popover = byId('select-all-popover');
  if (popover) popover.classList.remove('hidden');
}

function isSelectAllMenuOpen() {
  const popover = byId('select-all-popover');
  return !!(popover && !popover.classList.contains('hidden'));
}

function setupSelectAllMenu() {
  document.addEventListener('click', (event) => {
    const wrap = byId('select-all-wrap');
    if (!wrap) return;
    if (wrap.contains(event.target)) return;
    closeSelectAllMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeSelectAllMenu();
    }
  });
}

function handleSelectAllPrimary(event) {
  if (event) event.stopPropagation();
  const selected = selectedCount;
  if (selected > 0) {
    clearAllSelection();
    return;
  }
  if (isSelectAllMenuOpen()) {
    closeSelectAllMenu();
  } else {
    openSelectAllMenu();
  }
}

function selectVisibleAllFromMenu() {
  selectVisibleAll();
  closeSelectAllMenu();
}

function selectAllFilteredFromMenu() {
  selectAllFiltered();
  closeSelectAllMenu();
}

function selectAllFiltered() {
  const filteredIndices = getCurrentFilterIndices();
  if (filteredIndices.length === 0) return;
  setSelectedForTokens(filteredIndices.map(index => flatTokens[index]), true);
  syncVisibleSelectionUI(true);
  updateSelectionState();
  closeSelectAllMenu();
}

function selectVisibleAll() {
  const visible = getVisibleTokens();
  if (visible.length === 0) return;
  setSelectedForTokens(visible, true);
  syncVisibleSelectionUI(true);
  updateSelectionState();
  closeSelectAllMenu();
}

function clearAllSelection() {
  if (flatTokens.length === 0) return;
  setSelectedForTokens(flatTokens, false);
  syncVisibleSelectionUI(false);
  updateSelectionState();
  closeSelectAllMenu();
}

function toggleSelect(index) {
  const item = flatTokens[index];
  if (!item) return;
  item._selected = !item._selected;
  selectedCount += item._selected ? 1 : -1;
  const row = document.querySelector(`#token-table-body tr[data-index="${index}"]`);
  if (row) row.classList.toggle('row-selected', item._selected);
  updateSelectionState();
}

function updateSelectionState() {
  const visible = getVisibleTokens();
  const visibleSelected = countSelected(visible);
  const selectAll = byId('select-all');
  if (selectAll) {
    const hasVisible = visible.length > 0;
    selectAll.disabled = !hasVisible;
    selectAll.checked = hasVisible && visibleSelected === visible.length;
    selectAll.indeterminate = visibleSelected > 0 && visibleSelected < visible.length;
  }
  const selectedCountEl = byId('selected-count');
  if (selectedCountEl) selectedCountEl.innerText = selectedCount;
  const selectAllLabel = byId('select-all-label');
  const selectAllTrigger = byId('select-all-trigger');
  const selectAllCaret = byId('select-all-caret');
  if (selectAllLabel) {
    selectAllLabel.textContent = selectedCount > 0
      ? t('token.clearSelection')
      : t('common.selectAll');
  }
  if (selectAllTrigger) {
    selectAllTrigger.classList.toggle('is-active', selectedCount > 0);
  }
  if (selectAllCaret) {
    selectAllCaret.style.display = selectedCount > 0 ? 'none' : 'inline';
  }
  if (selectedCount > 0) {
    closeSelectAllMenu();
  }
  setActionButtonsState(selectedCount);
}

// Actions
function addToken() {
  openEditModal(-1);
}

// Batch export (Selected only)
function batchExport() {
  const selected = getSelectedTokens();
  if (selected.length === 0) return showToast(t('common.noTokenSelected'), 'error');
  const content = selected.map(t => t.token).join('\n') + '\n';
  downloadTextFile(content, `tokens_export_selected_${new Date().toISOString().slice(0, 10)}.txt`);
}


// Modal Logic
let currentEditIndex = -1;
function openEditModal(index) {
  const modal = byId('edit-modal');
  if (!modal) return;

  currentEditIndex = index;

  if (index >= 0) {
    // Edit existing
    const item = flatTokens[index];
    byId('edit-token-display').value = item.token;
    byId('edit-original-token').value = item.token;
    byId('edit-original-pool').value = item.pool;
    byId('edit-pool').value = item.pool;
    byId('edit-quota').value = item.quota;
    byId('edit-note').value = item.note;
    document.querySelector('#edit-modal h3').innerText = t('token.editTitle');
  } else {
    // New Token
    const tokenInput = byId('edit-token-display');
    tokenInput.value = '';
    tokenInput.disabled = false;
    tokenInput.placeholder = 'sk-...';
    tokenInput.classList.remove('bg-gray-50', 'text-gray-500');

    byId('edit-original-token').value = '';
    byId('edit-original-pool').value = '';
    byId('edit-pool').value = 'ssoBasic';
    byId('edit-quota').value = getDefaultQuotaForPool('ssoBasic');
    byId('edit-note').value = '';
    document.querySelector('#edit-modal h3').innerText = t('token.addTitle');
  }

  openModal('edit-modal');
}

function setupEditPoolDefaults() {
  const poolSelect = byId('edit-pool');
  const quotaInput = byId('edit-quota');
  if (!poolSelect || !quotaInput) return;
  poolSelect.addEventListener('change', () => {
    if (currentEditIndex >= 0) return;
    quotaInput.value = getDefaultQuotaForPool(poolSelect.value);
  });
}

function closeEditModal() {
  closeModal('edit-modal', () => {
    // reset styles for token input
    const input = byId('edit-token-display');
    if (input) {
      input.disabled = true;
      input.classList.add('bg-gray-50', 'text-gray-500');
    }
  });
}

async function saveEdit() {
  // Collect data
  let token;
  const newPool = byId('edit-pool').value.trim();
  const newQuota = parseInt(byId('edit-quota').value) || 0;
  const newNote = byId('edit-note').value.trim().slice(0, 50);

  if (currentEditIndex >= 0) {
    // Updating existing
    const item = flatTokens[currentEditIndex];
    token = item.token;

    // Update flatTokens first to reflect UI
    item.pool = newPool || 'ssoBasic';
    item.quota = newQuota;
    item.note = newNote;
  } else {
    // Creating new
    token = byId('edit-token-display').value.trim();
    if (!token) return showToast(t('token.tokenEmpty'), 'error');

    // Check if exists
    if (tokenLookup.has(token)) {
      return showToast(t('token.tokenExists'), 'error');
    }

    flatTokens.push({
      token: token,
      pool: newPool || 'ssoBasic',
      quota: newQuota,
      note: newNote,
      status: 'active', // default
      use_count: 0,
      _selected: false
    });
    tokenLookup.add(token);
  }

  await syncToServer();
  closeEditModal();
  // Reload to ensure consistent state/grouping
  // Or simpler: just re-render but syncToServer does the hard work
  loadData();
}

async function deleteToken(index) {
  const ok = await confirmAction(t('token.confirmDelete'), { okText: t('common.delete') });
  if (!ok) return;
  const removed = flatTokens[index];
  if (removed && removed._selected) selectedCount -= 1;
  if (removed) tokenLookup.delete(removed.token);
  flatTokens.splice(index, 1);
  syncToServer().then(loadData);
}

async function toggleTokenEnabled(index) {
  const item = flatTokens[index];
  if (!item) return;
  const toDisabled = item.status !== 'disabled';
  const targetStatus = toDisabled ? 'disabled' : 'active';
  const confirmKey = toDisabled ? 'token.confirmDisable' : 'token.confirmEnable';
  const okText = toDisabled ? t('token.disableToken') : t('token.enableToken');
  const tokenLabel = item.token.length > 24
    ? `${item.token.substring(0, 8)}...${item.token.substring(item.token.length - 16)}`
    : item.token;
  const ok = await confirmAction(t(confirmKey, { token: tokenLabel }), { okText });
  if (!ok) return;
  item.status = targetStatus;
  await syncToServer();
  await loadData();
  showToast(toDisabled ? t('token.disableDone') : t('token.enableDone'), 'success');
}

function batchDelete() {
  startBatchDelete();
}

function _getBatchStatusTargets(targetStatus) {
  const selected = getSelectedTokens();
  if (selected.length === 0) return { selected, targets: [] };
  const targets = selected.filter(item => item.status !== targetStatus);
  return { selected, targets };
}

async function batchSetStatus(targetStatus) {
  if (isBatchProcessing) {
    showToast(t('common.taskInProgress'), 'info');
    return;
  }
  const { selected, targets } = _getBatchStatusTargets(targetStatus);
  if (selected.length === 0) {
    showToast(t('common.noTokenSelected'), 'error');
    return;
  }
  const toDisabled = targetStatus === 'disabled';
  if (targets.length === 0) {
    showToast(toDisabled ? t('token.noTokenToDisable') : t('token.noTokenToEnable'), 'info');
    return;
  }
  const confirmKey = toDisabled ? 'token.confirmBatchDisable' : 'token.confirmBatchEnable';
  const okText = toDisabled ? t('token.batchDisable') : t('token.batchEnable');
  const ok = await confirmAction(t(confirmKey, { count: targets.length }), { okText });
  if (!ok) return;
  targets.forEach(item => {
    item.status = targetStatus;
  });
  await syncToServer();
  await loadData();
  showToast(toDisabled ? t('token.batchDisableDone') : t('token.batchEnableDone'), 'success');
}

async function batchDisableTokens() {
  await batchSetStatus('disabled');
}

async function batchEnableTokens() {
  await batchSetStatus('active');
}

// Reconstruct object structure and save
async function syncToServer() {
  rebuildTokenPageState();
  updateStats();
  updateSelectionState();

  const newTokens = {};
  flatTokens.forEach(t => {
    if (!newTokens[t.pool]) newTokens[t.pool] = [];
    const payload = {
      token: t.token,
      status: t.status,
      quota: t.quota,
      note: t.note,
      fail_count: t.fail_count,
      use_count: t.use_count || 0,
      tags: Array.isArray(t.tags) ? t.tags : []
    };
    if (typeof t.created_at === 'number') payload.created_at = t.created_at;
    if (typeof t.last_used_at === 'number') payload.last_used_at = t.last_used_at;
    if (typeof t.last_fail_at === 'number') payload.last_fail_at = t.last_fail_at;
    if (typeof t.last_sync_at === 'number') payload.last_sync_at = t.last_sync_at;
    if (typeof t.last_asset_clear_at === 'number') payload.last_asset_clear_at = t.last_asset_clear_at;
    if (typeof t.last_fail_reason === 'string' && t.last_fail_reason) payload.last_fail_reason = t.last_fail_reason;
    newTokens[t.pool].push(payload);
  });

  try {
    const res = await fetch('/v1/admin/tokens', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildAuthHeaders(apiKey)
      },
      body: JSON.stringify(newTokens)
    });
    if (!res.ok) showToast(t('common.saveFailed'), 'error');
  } catch (e) {
    showToast(t('common.saveError', { msg: e.message }), 'error');
  }
}

// Import Logic
function openImportModal() {
  openModal('import-modal');
}

function closeImportModal() {
  closeModal('import-modal', () => {
    const input = byId('import-text');
    if (input) input.value = '';
  });
}

async function submitImport() {
  const pool = byId('import-pool').value.trim() || 'ssoBasic';
  const text = byId('import-text').value;
  const lines = text.split('\n');
  const defaultQuota = getDefaultQuotaForPool(pool);

  lines.forEach(line => {
    const t = line.trim();
    if (t && !tokenLookup.has(t)) {
      flatTokens.push({
        token: t,
        pool: pool,
        status: 'active',
        quota: defaultQuota,
        note: '',
        tags: [],
        fail_count: 0,
        use_count: 0,
        _selected: false
      });
      tokenLookup.add(t);
    }
  });

  await syncToServer();
  closeImportModal();
  loadData();
}

// Export Logic
function exportTokens() {
  if (flatTokens.length === 0) return showToast(t('token.listEmpty'), 'error');
  const content = flatTokens.map(t => t.token).join('\n') + '\n';
  downloadTextFile(content, `tokens_export_${new Date().toISOString().slice(0, 10)}.txt`);
}

async function copyToClipboard(text, btn) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    const originalHtml = btn.innerHTML;
    btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    btn.classList.remove('text-gray-400');
    btn.classList.add('text-green-500');
    setTimeout(() => {
      btn.innerHTML = originalHtml;
      btn.classList.add('text-gray-400');
      btn.classList.remove('text-green-500');
    }, 2000);
  } catch (err) {
    console.error('Copy failed', err);
  }
}

async function refreshStatus(token) {
  try {
    const btn = event.currentTarget; // Get button element if triggered by click
    if (btn) {
      btn.innerHTML = `<svg class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`;
    }

    const res = await fetch('/v1/admin/tokens/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildAuthHeaders(apiKey)
      },
      body: JSON.stringify({ token: token })
    });

    const data = await res.json();

    if (res.ok && data.status === 'success') {
      const isSuccess = data.results && data.results[token];
      loadData();

      if (isSuccess) {
        showToast(t('token.refreshSuccess'), 'success');
      } else {
        showToast(t('token.refreshFailed'), 'error');
      }
    } else {
      showToast(t('token.refreshFailed'), 'error');
    }
  } catch (e) {
    console.error(e);
    showToast(t('token.requestError'), 'error');
  }
}


async function startBatchRefresh() {
  if (isBatchProcessing) {
    showToast(t('common.taskInProgress'), 'info');
    return;
  }

  const selected = getSelectedTokens();
  if (selected.length === 0) return showToast(t('common.noTokenSelected'), 'error');

  // Init state
  isBatchProcessing = true;
  isBatchPaused = false;
  currentBatchAction = 'refresh';
  batchQueue = selected.map(t => t.token);
  batchTotal = batchQueue.length;
  batchProcessed = 0;

  updateBatchProgress();
  setActionButtonsState();

  try {
    const res = await fetch('/v1/admin/tokens/refresh/async', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildAuthHeaders(apiKey)
      },
      body: JSON.stringify({ tokens: batchQueue })
    });
    const data = await res.json();
    if (!res.ok || data.status !== 'success') {
      throw new Error(data.detail || t('common.requestFailed'));
    }

    currentBatchTaskId = data.task_id;
    BatchSSE.close(batchEventSource);
    batchEventSource = BatchSSE.open(currentBatchTaskId, apiKey, {
      onMessage: (msg) => {
        if (msg.type === 'snapshot' || msg.type === 'progress') {
          if (typeof msg.total === 'number') batchTotal = msg.total;
          if (typeof msg.processed === 'number') batchProcessed = msg.processed;
          updateBatchProgress();
        } else if (msg.type === 'done') {
          if (typeof msg.total === 'number') batchTotal = msg.total;
          batchProcessed = batchTotal;
          updateBatchProgress();
          finishBatchProcess(false, { silent: true });
          if (msg.warning) {
            showToast(t('token.refreshDone') + '\n⚠️ ' + msg.warning, 'warning');
          } else {
            showToast(t('token.refreshDone'), 'success');
          }
          currentBatchTaskId = null;
          BatchSSE.close(batchEventSource);
          batchEventSource = null;
        } else if (msg.type === 'cancelled') {
          finishBatchProcess(true, { silent: true });
          showToast(t('token.stopRefresh'), 'info');
          currentBatchTaskId = null;
          BatchSSE.close(batchEventSource);
          batchEventSource = null;
        } else if (msg.type === 'error') {
          finishBatchProcess(true, { silent: true });
          showToast(t('token.refreshError', { msg: msg.error || t('common.unknownError') }), 'error');
          currentBatchTaskId = null;
          BatchSSE.close(batchEventSource);
          batchEventSource = null;
        }
      },
      onError: () => {
        finishBatchProcess(true, { silent: true });
        showToast(t('common.connectionInterrupted'), 'error');
        currentBatchTaskId = null;
        BatchSSE.close(batchEventSource);
        batchEventSource = null;
      }
    });
  } catch (e) {
    finishBatchProcess(true, { silent: true });
    showToast(e.message || t('common.requestFailed'), 'error');
    currentBatchTaskId = null;
  }
}

function toggleBatchPause() {
  if (!isBatchProcessing) return;
  showToast(t('common.taskNoPause'), 'info');
}

function stopBatchRefresh() {
  if (!isBatchProcessing) return;
  if (currentBatchTaskId) {
    BatchSSE.cancel(currentBatchTaskId, apiKey);
    BatchSSE.close(batchEventSource);
    batchEventSource = null;
    currentBatchTaskId = null;
  }
  finishBatchProcess(true);
}

function finishBatchProcess(aborted = false, options = {}) {
  const action = currentBatchAction;
  isBatchProcessing = false;
  isBatchPaused = false;
  batchQueue = [];
  currentBatchAction = null;

  updateBatchProgress();
  setActionButtonsState();
  updateSelectionState();
  loadData(); // Final data refresh

  if (options.silent) return;
  if (aborted) {
    if (action === 'delete') {
      showToast(t('token.stopDelete'), 'info');
    } else if (action === 'nsfw') {
      showToast(t('token.stopNsfw'), 'info');
    } else {
      showToast(t('token.stopRefresh'), 'info');
    }
  } else {
    if (action === 'delete') {
      showToast(t('token.deleteDone'), 'success');
    } else if (action === 'nsfw') {
      showToast(t('token.nsfwDone'), 'success');
    } else {
      showToast(t('token.refreshDone'), 'success');
    }
  }
}

async function batchUpdate() {
  startBatchRefresh();
}

function updateBatchProgress() {
  const container = byId('batch-progress');
  const text = byId('batch-progress-text');
  const pauseBtn = byId('btn-pause-action');
  const stopBtn = byId('btn-stop-action');
  if (!container || !text) return;
  if (!isBatchProcessing) {
    container.classList.add('hidden');
    if (pauseBtn) pauseBtn.classList.add('hidden');
    if (stopBtn) stopBtn.classList.add('hidden');
    return;
  }
  const pct = batchTotal ? Math.floor((batchProcessed / batchTotal) * 100) : 0;
  text.textContent = `${pct}%`;
  container.classList.remove('hidden');
  if (pauseBtn) {
    pauseBtn.classList.add('hidden');
  }
  if (stopBtn) stopBtn.classList.remove('hidden');
}

function setActionButtonsState(selectedCountValue = null) {
  let count = selectedCountValue;
  if (count === null) {
    count = selectedCount;
  }
  const disabled = isBatchProcessing;
  const exportBtn = byId('btn-batch-export');
  const updateBtn = byId('btn-batch-update');
  const disableBtn = byId('btn-batch-disable');
  const enableBtn = byId('btn-batch-enable');
  const nsfwBtn = byId('btn-batch-nsfw');
  const deleteBtn = byId('btn-batch-delete');
  if (exportBtn) exportBtn.disabled = disabled || count === 0;
  if (updateBtn) updateBtn.disabled = disabled || count === 0;
  if (disableBtn) disableBtn.disabled = disabled || count === 0;
  if (enableBtn) enableBtn.disabled = disabled || count === 0;
  if (nsfwBtn) nsfwBtn.disabled = disabled || count === 0;
  if (deleteBtn) deleteBtn.disabled = disabled || count === 0;
}

async function startBatchDelete() {
  if (isBatchProcessing) {
    showToast(t('common.taskInProgress'), 'info');
    return;
  }
  const selected = getSelectedTokens();
  if (selected.length === 0) return showToast(t('common.noTokenSelected'), 'error');
  const ok = await confirmAction(t('token.confirmBatchDelete', { count: selected.length }), { okText: t('common.delete') });
  if (!ok) return;

  isBatchProcessing = true;
  isBatchPaused = false;
  currentBatchAction = 'delete';
  batchQueue = selected.map(t => t.token);
  batchTotal = batchQueue.length;
  batchProcessed = 0;

  updateBatchProgress();
  setActionButtonsState();

  try {
    const toRemove = new Set(batchQueue);
    flatTokens = flatTokens.filter(t => !toRemove.has(t.token));
    tokenLookup = new Set(flatTokens.map(t => t.token));
    selectedCount = 0;
    await syncToServer();
    batchProcessed = batchTotal;
    updateBatchProgress();
    finishBatchProcess(false, { silent: true });
    showToast(t('token.deleteDone'), 'success');
  } catch (e) {
    finishBatchProcess(true, { silent: true });
    showToast(t('common.deleteFailed'), 'error');
  }
}

let confirmResolver = null;

function setupConfirmDialog() {
  const dialog = byId('confirm-dialog');
  if (!dialog) return;
  const okBtn = byId('confirm-ok');
  const cancelBtn = byId('confirm-cancel');
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      closeConfirm(false);
    }
  });
  if (okBtn) okBtn.addEventListener('click', () => closeConfirm(true));
  if (cancelBtn) cancelBtn.addEventListener('click', () => closeConfirm(false));
}

function confirmAction(message, options = {}) {
  const dialog = byId('confirm-dialog');
  if (!dialog) {
    return Promise.resolve(false);
  }
  const messageEl = byId('confirm-message');
  const okBtn = byId('confirm-ok');
  const cancelBtn = byId('confirm-cancel');
  if (messageEl) messageEl.textContent = message;
  if (okBtn) okBtn.textContent = options.okText || t('common.ok');
  if (cancelBtn) cancelBtn.textContent = options.cancelText || t('common.cancel');
  return new Promise(resolve => {
    confirmResolver = resolve;
    dialog.classList.remove('hidden');
    requestAnimationFrame(() => {
      dialog.classList.add('is-open');
    });
  });
}

function closeConfirm(ok) {
  const dialog = byId('confirm-dialog');
  if (!dialog) return;
  dialog.classList.remove('is-open');
  setTimeout(() => {
    dialog.classList.add('hidden');
    if (confirmResolver) {
      confirmResolver(ok);
      confirmResolver = null;
    }
  }, 200);
}

function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ========== Tab 筛选功能 ==========

function filterByStatus(status) {
  currentFilter = status;
  currentPage = 1;
  closeSelectAllMenu();

  // 更新 Tab 样式和 ARIA
  document.querySelectorAll('.tab-item').forEach(tab => {
    const isActive = tab.dataset.filter === status;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  renderTable();
}

function getFilteredTokens() {
  return getCurrentFilterIndices().map(index => flatTokens[index]);
}

function updateTabCounts(counts) {
  const stats = tokenPageState.stats || TokenPageState.createEmptyStats();
  const safeCounts = counts || {
    all: stats.totalTokens,
    active: stats.activeTokens,
    cooling: stats.coolingTokens,
    expired: stats.invalidTokens,
    nsfw: stats.nsfwTokens,
    'no-nsfw': stats.noNsfwTokens
  };

  Object.entries(safeCounts).forEach(([key, count]) => {
    const el = byId(`tab-count-${key}`);
    if (el) el.textContent = count;
  });
}

function getVisibleTokens() {
  return getPaginationData().visibleTokens;
}

function refreshPageSizeOptionsI18n() {
  const sizeSelect = byId('page-size');
  if (!sizeSelect) return;
  Array.from(sizeSelect.options).forEach((opt) => {
    const size = parseInt(opt.value, 10);
    if (!Number.isFinite(size)) return;
    opt.textContent = t('token.perPage', { size });
  });
}

function updatePaginationControls(totalCount, totalPages) {
  const info = byId('pagination-info');
  const prevBtn = byId('page-prev');
  const nextBtn = byId('page-next');
  const sizeSelect = byId('page-size');

  refreshPageSizeOptionsI18n();

  if (sizeSelect && String(sizeSelect.value) !== String(pageSize)) {
    sizeSelect.value = String(pageSize);
  }

  if (info) {
    info.textContent = t('token.pagination', { current: totalCount === 0 ? 0 : currentPage, total: totalPages, count: totalCount });
  }
  if (prevBtn) prevBtn.disabled = totalCount === 0 || currentPage <= 1;
  if (nextBtn) nextBtn.disabled = totalCount === 0 || currentPage >= totalPages;
}

function goPrevPage() {
  if (currentPage <= 1) return;
  currentPage -= 1;
  closeSelectAllMenu();
  renderTable();
}

function goNextPage() {
  const totalCount = getCurrentFilterIndices().length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  if (currentPage >= totalPages) return;
  currentPage += 1;
  closeSelectAllMenu();
  renderTable();
}

function changePageSize() {
  const sizeSelect = byId('page-size');
  const value = sizeSelect ? parseInt(sizeSelect.value, 10) : 0;
  if (!value || value === pageSize) return;
  pageSize = value;
  currentPage = 1;
  closeSelectAllMenu();
  renderTable();
}

// ========== NSFW 批量开启 ==========

async function batchEnableNSFW() {
  if (isBatchProcessing) {
    showToast(t('common.taskInProgress'), 'info');
    return;
  }

  const selected = getSelectedTokens();
  const targetCount = selected.length;
  if (targetCount === 0) {
    showToast(t('common.noTokenSelected'), 'error');
    return;
  }
  const msg = t('token.nsfwConfirm', { count: targetCount });

  const ok = await confirmAction(msg, { okText: t('token.nsfwEnable') });
  if (!ok) return;

  // 禁用按钮
  const btn = byId('btn-batch-nsfw');
  if (btn) btn.disabled = true;

  isBatchProcessing = true;
  currentBatchAction = 'nsfw';
  batchTotal = targetCount;
  batchProcessed = 0;
  updateBatchProgress();
  setActionButtonsState();

  try {
    const tokens = selected.length > 0 ? selected.map(t => t.token) : null;
    const res = await fetch('/v1/admin/tokens/nsfw/enable/async', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildAuthHeaders(apiKey)
      },
      body: JSON.stringify({ tokens })
    });

    const data = await readJsonResponse(res);
    if (!res.ok) {
      const detail = data && (data.detail || data.message);
      throw new Error(detail || `HTTP ${res.status}`);
    }
    if (!data) {
      throw new Error(t('token.emptyResponse', { status: res.status }));
    }
    if (data.status !== 'success') {
      throw new Error(data.detail || t('common.requestFailed'));
    }

    currentBatchTaskId = data.task_id;
    BatchSSE.close(batchEventSource);
    batchEventSource = BatchSSE.open(currentBatchTaskId, apiKey, {
      onMessage: (msg) => {
        if (msg.type === 'snapshot' || msg.type === 'progress') {
          if (typeof msg.total === 'number') batchTotal = msg.total;
          if (typeof msg.processed === 'number') batchProcessed = msg.processed;
          updateBatchProgress();
        } else if (msg.type === 'done') {
          if (typeof msg.total === 'number') batchTotal = msg.total;
          batchProcessed = batchTotal;
          updateBatchProgress();
          finishBatchProcess(false, { silent: true });
          const summary = msg.result && msg.result.summary ? msg.result.summary : null;
          const okCount = summary ? summary.ok : 0;
          const failCount = summary ? summary.fail : 0;
          let text = t('token.nsfwResult', { ok: okCount, fail: failCount });
          if (msg.warning) text += `\n⚠️ ${msg.warning}`;
          showToast(text, failCount > 0 || msg.warning ? 'warning' : 'success');
          currentBatchTaskId = null;
          BatchSSE.close(batchEventSource);
          batchEventSource = null;
          if (btn) btn.disabled = false;
          setActionButtonsState();
        } else if (msg.type === 'cancelled') {
          finishBatchProcess(true, { silent: true });
          showToast(t('token.stopNsfw'), 'info');
          currentBatchTaskId = null;
          BatchSSE.close(batchEventSource);
          batchEventSource = null;
          if (btn) btn.disabled = false;
          setActionButtonsState();
        } else if (msg.type === 'error') {
          finishBatchProcess(true, { silent: true });
          showToast(t('token.nsfwFailed', { msg: msg.error || t('common.unknownError') }), 'error');
          currentBatchTaskId = null;
          BatchSSE.close(batchEventSource);
          batchEventSource = null;
          if (btn) btn.disabled = false;
          setActionButtonsState();
        }
      },
      onError: () => {
        finishBatchProcess(true, { silent: true });
        showToast(t('common.connectionInterrupted'), 'error');
        currentBatchTaskId = null;
        BatchSSE.close(batchEventSource);
        batchEventSource = null;
        if (btn) btn.disabled = false;
        setActionButtonsState();
      }
    });
  } catch (e) {
    finishBatchProcess(true, { silent: true });
    showToast(t('token.requestError') + ': ' + e.message, 'error');
    if (btn) btn.disabled = false;
    setActionButtonsState();
  }
}



window.onload = init;
