(() => {
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const clearBtn = document.getElementById('clearBtn');
  const promptInput = document.getElementById('promptInput');
  const referenceList = document.getElementById('referenceList');
  const imageUrlInput = document.getElementById('imageUrlInput');
  const imageFileInput = document.getElementById('imageFileInput');
  const imageFileName = document.getElementById('imageFileName');
  const clearImageFileBtn = document.getElementById('clearImageFileBtn');
  const selectImageFileBtn = document.getElementById('selectImageFileBtn');
  const ratioSelect = document.getElementById('ratioSelect');
  const lengthSelect = document.getElementById('lengthSelect');
  const resolutionSelect = document.getElementById('resolutionSelect');
  const presetSelect = document.getElementById('presetSelect');
  const statusText = document.getElementById('statusText');
  const progressBar = document.getElementById('progressBar');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  const durationValue = document.getElementById('durationValue');
  const aspectValue = document.getElementById('aspectValue');
  const lengthValue = document.getElementById('lengthValue');
  const resolutionValue = document.getElementById('resolutionValue');
  const presetValue = document.getElementById('presetValue');
  const videoEmpty = document.getElementById('videoEmpty');
  const videoStage = document.getElementById('videoStage');
  const pickCachedVideoBtn = document.getElementById('pickCachedVideoBtn');
  const uploadWorkVideoBtn = document.getElementById('uploadWorkVideoBtn');
  const workVideoFileInput = document.getElementById('workVideoFileInput');
  const cacheVideoModal = document.getElementById('cacheVideoModal');
  const closeCacheVideoModalBtn = document.getElementById('closeCacheVideoModalBtn');
  const cacheVideoList = document.getElementById('cacheVideoList');
  const editHint = document.getElementById('editHint');
  const editCurrentVideo = document.getElementById('editCurrentVideo');
  const historyCount = document.getElementById('historyCount');
  const clearHistoryBtn = document.getElementById('clearHistoryBtn');
  const editVideo = document.getElementById('editVideo');
  const editTimeline = document.getElementById('editTimeline');
  const editTimeText = document.getElementById('editTimeText');
  const editDurationText = document.getElementById('editDurationText');
  const editFrameIndex = document.getElementById('editFrameIndex');
  const editTimestampMs = document.getElementById('editTimestampMs');
  const editExtendPostId = document.getElementById('editExtendPostId');
  const editPromptInput = document.getElementById('editPromptInput');
  const spliceBtn = document.getElementById('spliceBtn');
  const upscaleBtn = document.getElementById('upscaleBtn');
  let promptRichInput = null;
  let referenceMentionMenu = null;

  let currentSource = null;
  let currentTaskId = '';
  let currentRunKind = 'generate';
  let isRunning = false;
  let progressBuffer = '';
  let contentBuffer = '';
  let collectingContent = false;
  let startAt = 0;
  let selectedFile = null;
  let referenceItems = [];
  let referenceUploadSeq = 0;
  let elapsedTimer = null;
  let lastProgress = 0;
  let currentPreviewItem = null;
  let previewCount = 0;
  let generatedCount = 0;
  let extendedCount = 0;
  let activeMentionIndex = -1;
  let isSyncingPromptEditor = false;
  let lastMentionRange = null;
  let lastMentionContext = null;
  let selectedVideoItemId = '';
  let selectedVideoUrl = '';
  let lockedFrameIndex = -1;
  let lockedTimestampMs = 0;
  let currentExtendPostId = '';
  let originalFileAttachmentId = '';
  let workVideoObjectUrl = '';
  let lastRenderedVideoUrl = '';
  const DEFAULT_REASONING_EFFORT = 'low';
  const EDIT_TIMELINE_MAX = 100000;
  const DEFAULT_EXTEND_SECONDS = 10;
  const MIN_VIDEO_SECONDS = 6;
  const MAX_VIDEO_SECONDS = 15;
  const TAIL_FRAME_GUARD_MS = 80;
  const APPROX_VIDEO_FPS = 30;
  const MAX_REFERENCE_FILES = 7;
  const DOM_TEXT_NODE = 3;
  const DOM_ELEMENT_NODE = 1;
  const referenceUploadCache = (window.VideoReferenceCache && typeof VideoReferenceCache.createReferenceUploadCache === 'function')
    ? VideoReferenceCache.createReferenceUploadCache()
    : {
        reset() {},
        peek() { return ''; },
        async getOrUpload(file, uploadFn) {
          return uploadFn(file);
        }
      };

  // Blob 缓存管理器：多路复用单点内存，所有 <video> 标签共享同一份 Blob 数据
  const blobCache = new Map();

  function loadVideoToBlob(originalUrl) {
    const key = String(originalUrl || '').trim();
    if (!key || key.startsWith('blob:')) return Promise.resolve(key);
    const cached = blobCache.get(key);
    if (cached && cached.blobUrl) return Promise.resolve(cached.blobUrl);
    if (cached && cached.promise) return cached.promise;
    const entry = { blobUrl: '', promise: null };
    entry.promise = fetch(key)
      .then((res) => {
        if (!res.ok) throw new Error('blob_fetch_failed');
        return res.blob();
      })
      .then((blob) => {
        entry.blobUrl = URL.createObjectURL(blob);
        entry.promise = null;
        return entry.blobUrl;
      })
      .catch((err) => {
        blobCache.delete(key);
        throw err;
      });
    blobCache.set(key, entry);
    return entry.promise;
  }

  function getBlobUrlSync(originalUrl) {
    const entry = blobCache.get(String(originalUrl || '').trim());
    return entry && entry.blobUrl ? entry.blobUrl : '';
  }

  function revokeAllBlobCache() {
    blobCache.forEach((entry) => {
      if (entry.blobUrl) {
        try { URL.revokeObjectURL(entry.blobUrl); } catch (e) { /* ignore */ }
      }
    });
    blobCache.clear();
  }

  function toast(message, type) {
    if (typeof showToast === 'function') {
      showToast(message, type);
    }
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function tSafe(key, fallback, params) {
    try {
      if (typeof t === 'function') {
        const value = t(key, params);
        if (value && value !== key) {
          return value;
        }
      }
    } catch (e) {
      // ignore
    }
    return fallback;
  }

  function syncStartButtonAvailability() {
    if (!startBtn) return false;
    if (window.VideoReferenceCache && typeof VideoReferenceCache.syncReferenceStartButtonState === 'function') {
      return VideoReferenceCache.syncReferenceStartButtonState(startBtn, {
        isRunning,
        referenceItems,
      });
    }
    const disabled = Boolean(
      isRunning || referenceItems.some((item) => item && item.status === 'uploading')
    );
    startBtn.disabled = disabled;
    return disabled;
  }

  function buildImageReferencePayload(referenceUrls) {
    if (window.FunctionPayloads && typeof FunctionPayloads.buildImageReference === 'function') {
      return FunctionPayloads.buildImageReference(referenceUrls);
    }
    const values = (Array.isArray(referenceUrls) ? referenceUrls : [referenceUrls])
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    if (!values.length) return undefined;
    if (values.length === 1) {
      return { image_url: values[0] };
    }
    return values.map((url) => ({ image_url: url }));
  }

  function basename(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const withoutQuery = raw.split('#')[0].split('?')[0];
    const name = withoutQuery.split('/').pop() || withoutQuery;
    try {
      return decodeURIComponent(name);
    } catch (e) {
      return name;
    }
  }

  function shortHash(value) {
    const raw = String(value || '').trim();
    if (!raw) return '-';
    if (raw.length <= 18) return raw;
    return `${raw.slice(0, 8)}...${raw.slice(-6)}`;
  }

  function base64UrlDecode(value) {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    if (!normalized) return '';
    const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    try {
      return decodeURIComponent(escape(atob(normalized + padding)));
    } catch (e) {
      try {
        return atob(normalized + padding);
      } catch (inner) {
        return '';
      }
    }
  }

  function decodeAssetSource(rawValue) {
    const raw = String(rawValue || '').trim();
    if (!raw) return '';
    let token = raw;
    try {
      const parsed = new URL(raw, window.location.origin);
      token = parsed.pathname.split('/').pop() || raw;
    } catch (e) {
      token = raw.split('/').pop() || raw;
    }
    if (token.startsWith('u_')) {
      return base64UrlDecode(token.slice(2));
    }
    if (token.startsWith('p_')) {
      return base64UrlDecode(token.slice(2));
    }
    return '';
  }

  function formatMs(ms) {
    const safe = Math.max(0, Number(ms) || 0);
    const totalSeconds = Math.floor(safe / 1000);
    const milli = Math.floor(safe % 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milli).padStart(3, '0')}`;
  }

  function formatBytes(bytes) {
    const value = Math.max(0, Number(bytes) || 0);
    if (value >= 1024 * 1024) {
      return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    }
    if (value >= 1024) {
      return `${(value / 1024).toFixed(1)} KB`;
    }
    return `${value} B`;
  }

  function formatMtime(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value <= 0) return '-';
    const date = new Date(value);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  }

  function extractPostIdFromFileName(name) {
    const pending = [String(name || '').trim()];
    const visited = new Set();
    while (pending.length) {
      const raw = pending.shift();
      if (!raw || visited.has(raw)) continue;
      visited.add(raw);
      const generatedMatch = raw.match(/generated-([0-9a-fA-F-]{32,36})-/);
      if (generatedMatch && generatedMatch[1]) {
        return generatedMatch[1];
      }
      const allMatches = raw.match(/[0-9a-fA-F-]{32,36}/g);
      if (allMatches && allMatches.length) {
        return allMatches[allMatches.length - 1];
      }
      const decoded = decodeAssetSource(raw);
      if (decoded && !visited.has(decoded)) {
        pending.push(decoded);
      }
      const base = basename(raw);
      if (base && !visited.has(base)) {
        pending.push(base);
      }
    }
    return '';
  }

  function setStatus(state, text) {
    if (!statusText) return;
    statusText.textContent = text;
    statusText.classList.remove('connected', 'connecting', 'error');
    if (state) {
      statusText.classList.add(state);
    }
  }

  function setButtons(running) {
    if (!startBtn || !stopBtn) return;
    if (running) {
      startBtn.classList.add('hidden');
      stopBtn.classList.remove('hidden');
    } else {
      startBtn.classList.remove('hidden');
      stopBtn.classList.add('hidden');
      syncStartButtonAvailability();
    }
  }

  function setSpliceButtonState(state) {
    if (!spliceBtn) return;
    const label = spliceBtn.querySelector('span');
    if (label) {
      if (state === 'running') {
        label.textContent = '中止延长';
      } else if (state === 'stopping') {
        label.textContent = '停止中...';
      } else {
        label.textContent = '开始延长';
      }
    }
    spliceBtn.disabled = state === 'stopping';
  }

  function updateProgress(value) {
    const safe = Math.max(0, Math.min(100, Number(value) || 0));
    lastProgress = safe;
    if (progressFill) {
      progressFill.style.width = `${safe}%`;
    }
    if (progressText) {
      progressText.textContent = `${safe}%`;
    }
  }

  function clampVideoLength(value, fallback) {
    const parsed = Math.floor(Number(value ?? fallback));
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.max(MIN_VIDEO_SECONDS, Math.min(MAX_VIDEO_SECONDS, parsed));
  }

  function getRequestedAspectRatio() {
    return ratioSelect ? String(ratioSelect.value || '').trim() || '3:2' : '3:2';
  }

  function getRequestedVideoLength() {
    const safe = clampVideoLength(lengthSelect ? lengthSelect.value : MAX_VIDEO_SECONDS, MAX_VIDEO_SECONDS);
    if (lengthSelect && String(lengthSelect.value) !== String(safe)) {
      lengthSelect.value = String(safe);
    }
    return safe;
  }

  function getRequestedResolutionName() {
    return resolutionSelect ? String(resolutionSelect.value || '').trim() || '480p' : '480p';
  }

  function getRequestedPreset() {
    return presetSelect ? String(presetSelect.value || '').trim() || 'normal' : 'normal';
  }

  function updateMeta() {
    if (aspectValue) {
      aspectValue.textContent = getRequestedAspectRatio();
    }
    if (lengthValue) {
      lengthValue.textContent = `${getRequestedVideoLength()}s`;
    }
    if (resolutionValue) {
      resolutionValue.textContent = getRequestedResolutionName();
    }
    if (presetValue) {
      presetValue.textContent = getRequestedPreset();
    }
  }

  function updateHistoryCount() {
    if (!historyCount || !videoStage) return;
    historyCount.textContent = String(videoStage.querySelectorAll('.video-item').length);
  }

  function refreshVideoSelectionUi() {
    if (!videoStage) return;
    videoStage.querySelectorAll('.video-item').forEach((item) => {
      item.classList.toggle('is-selected', item.dataset.index === selectedVideoItemId);
    });
  }

  function updateCurrentVideoLabel(value) {
    if (!editCurrentVideo) return;
    editCurrentVideo.textContent = value || '-';
  }

  function setEditMeta() {
    if (editFrameIndex) {
      editFrameIndex.textContent = lockedFrameIndex >= 0 ? String(lockedFrameIndex) : '-';
    }
    if (editTimestampMs) {
      editTimestampMs.textContent = String(Math.max(0, Math.round(lockedTimestampMs)));
    }
    if (editExtendPostId) {
      editExtendPostId.textContent = shortHash(currentExtendPostId);
    }
  }

  function syncTimelineAvailability() {
    const disabled = !selectedVideoUrl || (isRunning && currentRunKind === 'splice');
    if (editTimeline) {
      editTimeline.disabled = disabled;
      editTimeline.classList.toggle('is-disabled', disabled);
    }
    if (upscaleBtn) {
      const hasUpscaleTarget = Boolean(currentExtendPostId || extractPostIdFromFileName(selectedVideoUrl));
      upscaleBtn.disabled = disabled || !hasUpscaleTarget;
    }
  }

  function updateDeleteZoneTrack(inputEl) {
    if (!inputEl) return;
    const maxRaw = Number(inputEl.max || EDIT_TIMELINE_MAX);
    const max = Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : EDIT_TIMELINE_MAX;
    const valueRaw = Number(inputEl.value || 0);
    const value = Math.max(0, Math.min(max, Number.isFinite(valueRaw) ? valueRaw : 0));
    const pct = (value / max) * 100;
    inputEl.style.setProperty('--cut-pct', `${pct}%`);
  }

  function resetOutput(keepPreview) {
    progressBuffer = '';
    contentBuffer = '';
    collectingContent = false;
    lastRenderedVideoUrl = '';
    lastProgress = 0;
    currentPreviewItem = null;
    updateProgress(0);
    setIndeterminate(false);
    if (!keepPreview) {
      if (videoStage) {
        videoStage.innerHTML = '';
        videoStage.classList.add('hidden');
      }
      if (videoEmpty) {
        videoEmpty.classList.remove('hidden');
      }
      previewCount = 0;
      generatedCount = 0;
      extendedCount = 0;
      selectedVideoItemId = '';
    }
    if (durationValue) {
      durationValue.textContent = tSafe('video.elapsedTimeNone', '耗时 -');
    }
    updateHistoryCount();
    refreshVideoSelectionUi();
  }

  function nextHistoryTitle(kind) {
    if (kind === 'splice') {
      extendedCount += 1;
      return `延长视频 ${extendedCount}`;
    }
    generatedCount += 1;
    return tSafe('video.videoTitle', `生成视频 ${generatedCount}`, { n: generatedCount });
  }

  function initPreviewSlot(kind) {
    if (!videoStage) return;
    previewCount += 1;
    currentPreviewItem = document.createElement('div');
    currentPreviewItem.className = 'video-item';
    currentPreviewItem.dataset.index = String(previewCount);
    currentPreviewItem.dataset.kind = kind || 'generate';
    currentPreviewItem.classList.add('is-pending');

    const header = document.createElement('div');
    header.className = 'video-item-bar';

    const title = document.createElement('div');
    title.className = 'video-item-title';
    title.textContent = nextHistoryTitle(kind || 'generate');

    const actions = document.createElement('div');
    actions.className = 'video-item-actions';

    const openBtn = document.createElement('a');
    openBtn.className = 'geist-button-outline text-xs px-3 video-open hidden';
    openBtn.target = '_blank';
    openBtn.rel = 'noopener';
    openBtn.textContent = tSafe('video.open', '打开');

    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'geist-button-outline text-xs px-3 video-download';
    downloadBtn.type = 'button';
    downloadBtn.textContent = tSafe('imagine.download', '下载');
    downloadBtn.disabled = true;

    actions.appendChild(openBtn);
    actions.appendChild(downloadBtn);
    header.appendChild(title);
    header.appendChild(actions);

    const body = document.createElement('div');
    body.className = 'video-item-body';
    body.innerHTML = '<div class="video-item-placeholder">' + tSafe('video.generatingPlaceholder', '等待视频输出...') + '</div>';

    const link = document.createElement('div');
    link.className = 'video-item-link';

    currentPreviewItem.appendChild(header);
    currentPreviewItem.appendChild(body);
    currentPreviewItem.appendChild(link);
    videoStage.appendChild(currentPreviewItem);
    videoStage.classList.remove('hidden');
    if (videoEmpty) {
      videoEmpty.classList.add('hidden');
    }
    updateHistoryCount();
    return currentPreviewItem;
  }

  function ensurePreviewSlot(kind) {
    if (!currentPreviewItem) {
      initPreviewSlot(kind);
    }
    return currentPreviewItem;
  }

  function updateItemLinks(item, url, options) {
    if (!item) return;
    const openBtn = item.querySelector('.video-open');
    const downloadBtn = item.querySelector('.video-download');
    const link = item.querySelector('.video-item-link');
    const safeUrl = url || '';
    const opts = options || {};
    const parsedPostId = extractPostIdFromFileName(safeUrl || opts.name || '');
    const fallbackPostId = String(opts.extendPostId ?? item.dataset.postId ?? '').trim();
    const postId = parsedPostId || fallbackPostId;
    const rootAttachmentId = String(opts.rootAttachmentId ?? item.dataset.rootAttachmentId ?? postId ?? '').trim();
    item.dataset.url = safeUrl;
    item.dataset.name = String(opts.name || item.dataset.name || basename(safeUrl));
    if (postId) {
      item.dataset.postId = postId;
    }
    if (rootAttachmentId) {
      item.dataset.rootAttachmentId = rootAttachmentId;
    } else if (postId) {
      item.dataset.rootAttachmentId = postId;
    }
    if (link) {
      link.textContent = safeUrl;
      link.classList.toggle('has-url', Boolean(safeUrl));
    }
    if (openBtn) {
      if (safeUrl) {
        openBtn.href = safeUrl;
        openBtn.classList.remove('hidden');
      } else {
        openBtn.classList.add('hidden');
        openBtn.removeAttribute('href');
      }
    }
    if (downloadBtn) {
      downloadBtn.dataset.url = safeUrl;
      downloadBtn.disabled = !safeUrl;
    }
    if (safeUrl) {
      item.classList.remove('is-pending');
    }
  }

  function setIndeterminate(active) {
    if (!progressBar) return;
    if (active) {
      progressBar.classList.add('indeterminate');
    } else {
      progressBar.classList.remove('indeterminate');
    }
  }

  function startElapsedTimer() {
    stopElapsedTimer();
    if (!durationValue) return;
    elapsedTimer = setInterval(() => {
      if (!startAt) return;
      const seconds = Math.max(0, Math.round((Date.now() - startAt) / 1000));
      durationValue.textContent = tSafe('video.elapsedTime', `耗时 ${seconds}s`, { sec: seconds });
    }, 1000);
  }

  function stopElapsedTimer() {
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  }

  function clearFileSelection() {
    const previousFileName = selectedFile && selectedFile.name ? selectedFile.name : '';
    selectedFile = null;
    referenceUploadCache.reset();
    if (imageUrlInput && imageUrlInput.value.trim() === previousFileName) {
      imageUrlInput.value = '';
    }
    if (imageFileInput) {
      imageFileInput.value = '';
    }
    if (imageFileName) {
      imageFileName.textContent = tSafe('common.noFileSelected', '未选择文件');
    }
  }

  function revokeWorkVideoObjectUrl() {
    if (!workVideoObjectUrl) return;
    try {
      URL.revokeObjectURL(workVideoObjectUrl);
    } catch (e) {
      // ignore
    }
    workVideoObjectUrl = '';
  }

  function resetWorkspaceVideo() {
    selectedVideoItemId = '';
    selectedVideoUrl = '';
    currentExtendPostId = '';
    originalFileAttachmentId = '';
    lockedFrameIndex = -1;
    lockedTimestampMs = 0;
    if (editVideo) {
      try {
        editVideo.pause();
      } catch (e) {
        // ignore
      }
      editVideo.removeAttribute('src');
      editVideo.load();
    }
    if (editPromptInput) {
      editPromptInput.value = '';
    }
    if (editTimeText) {
      editTimeText.textContent = '00:00.000';
    }
    if (editDurationText) {
      editDurationText.textContent = '总时长 -';
    }
    if (editHint) {
      editHint.classList.remove('hidden');
    }
    updateCurrentVideoLabel('-');
    setEditMeta();
    refreshVideoSelectionUi();
    syncTimelineAvailability();
  }

  function normalizeAuthHeader(authHeader) {
    if (!authHeader) return '';
    if (authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7).trim();
    }
    return authHeader;
  }

  function normalizeMediaUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      return new URL(raw, window.location.href).toString();
    } catch (e) {
      return raw;
    }
  }

  function buildSseUrl(taskId, rawPublicKey) {
    const httpProtocol = window.location.protocol === 'https:' ? 'https' : 'http';
    const base = `${httpProtocol}://${window.location.host}/v1/function/video/sse`;
    const params = new URLSearchParams();
    params.set('task_id', taskId);
    params.set('t', String(Date.now()));
    if (rawPublicKey) {
      params.set('function_key', rawPublicKey);
    }
    return `${base}?${params.toString()}`;
  }

  function applyWorkspaceVideo(url, options) {
    const opts = options || {};
    const safeUrl = String(url || '').trim();
    const postId = String(opts.extendPostId || extractPostIdFromFileName(opts.name || safeUrl)).trim();
    const rootAttachmentId = String(opts.rootAttachmentId ?? '').trim();
    const nextRootAttachmentId = Object.prototype.hasOwnProperty.call(opts, 'rootAttachmentId')
      ? (rootAttachmentId || postId || '')
      : (originalFileAttachmentId || postId || '');
    const forceReload = opts.forceReload !== false;
    const currentWorkspaceUrl = editVideo ? normalizeMediaUrl(editVideo.currentSrc || editVideo.getAttribute('src') || '') : '';
    const nextWorkspaceUrl = normalizeMediaUrl(safeUrl);
    const shouldReload = forceReload || currentWorkspaceUrl !== nextWorkspaceUrl;
    selectedVideoUrl = safeUrl;
    currentExtendPostId = postId;
    if (Object.prototype.hasOwnProperty.call(opts, 'rootAttachmentId')) {
      originalFileAttachmentId = nextRootAttachmentId;
    } else if (postId && !originalFileAttachmentId) {
      originalFileAttachmentId = nextRootAttachmentId;
    }
    if (editHint) {
      editHint.classList.toggle('hidden', Boolean(safeUrl));
    }
    updateCurrentVideoLabel(postId ? shortHash(postId) : (opts.label || basename(opts.name || safeUrl) || '-'));
    if (editVideo) {
      try {
        editVideo.pause();
      } catch (e) {
        // ignore
      }
      if (safeUrl) {
        if (shouldReload) {
          // 多路复用：优先使用 Blob 缓存，避免重复网络请求
          const cachedBlobUrl = getBlobUrlSync(safeUrl);
          if (cachedBlobUrl) {
            editVideo.src = cachedBlobUrl;
            editVideo.load();
          } else {
            loadVideoToBlob(safeUrl).then((blobUrl) => {
              if (selectedVideoUrl === safeUrl) {
                editVideo.src = blobUrl;
                editVideo.load();
              }
            }).catch(() => {
              editVideo.src = safeUrl;
              editVideo.load();
            });
          }
        }
      } else {
        if (currentWorkspaceUrl) {
          editVideo.removeAttribute('src');
          editVideo.load();
        }
      }
    }
    if (!shouldReload) {
      setEditMeta();
      syncTimelineAvailability();
      return;
    }
    lockedFrameIndex = -1;
    lockedTimestampMs = 0;
    setEditMeta();
    syncTimelineAvailability();
  }

  function selectHistoryItem(item, options) {
    if (!item) return;
    const safeUrl = String(item.dataset.url || '').trim();
    if (!safeUrl) return;
    selectedVideoItemId = String(item.dataset.index || '');
    refreshVideoSelectionUi();
    const titleEl = item.querySelector('.video-item-title');
    applyWorkspaceVideo(safeUrl, {
      name: item.dataset.name || basename(safeUrl),
      extendPostId: item.dataset.postId || '',
      rootAttachmentId: item.dataset.rootAttachmentId || item.dataset.postId || '',
      label: titleEl ? titleEl.textContent.trim() : '',
      forceReload: options && Object.prototype.hasOwnProperty.call(options, 'forceReload') ? options.forceReload : true,
    });
  }

  function syncWorkspaceFromPreview(item) {
    if (!item) return;
    const safeUrl = String(item.dataset.url || '').trim();
    if (!safeUrl) return;
    const syncedUrl = String(item.dataset.workspaceSyncedUrl || '').trim();
    if (syncedUrl === safeUrl) return;
    item.dataset.workspaceSyncedUrl = safeUrl;
    selectHistoryItem(item, { forceReload: false });
  }

  async function uploadReferenceImage(authHeader, file) {
    const form = new FormData();
    form.append('file', file, file.name || 'reference.png');
    const res = await fetch('/v1/function/uploads/image', {
      method: 'POST',
      headers: buildAuthHeaders(authHeader),
      body: form,
    });
    const text = await res.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch (e) {
      payload = null;
    }
    if (!res.ok) {
      const message = (payload && payload.error && payload.error.message) || text || t('common.requestFailed');
      throw new Error(message);
    }
    const url = payload && payload.url ? String(payload.url) : '';
    if (!url) {
      throw new Error(t('video.uploadFailed') || 'Upload failed');
    }
    return url;
  }

  async function resolveReferenceImage(authHeader) {
    const rawUrl = imageUrlInput ? imageUrlInput.value.trim() : '';
    const fileName = selectedFile && selectedFile.name ? selectedFile.name.trim() : '';
    const manualUrl = selectedFile && rawUrl === fileName ? '' : rawUrl;
    if (selectedFile && manualUrl) {
      toast(t('video.referenceConflict'), 'error');
      throw new Error('invalid_reference');
    }
    if (selectedFile) {
      return referenceUploadCache.getOrUpload(selectedFile, (file) => uploadReferenceImage(authHeader, file));
    }
    referenceUploadCache.reset();
    return manualUrl || '';
  }

  function nextReferenceItemId() {
    referenceUploadSeq += 1;
    return `video-ref-${Date.now()}-${referenceUploadSeq}`;
  }

  function revokeReferencePreview(item) {
    if (!item || !item.previewUrl || !String(item.previewUrl).startsWith('blob:')) return;
    try {
      URL.revokeObjectURL(item.previewUrl);
    } catch (e) {
      // ignore
    }
  }

  function getReferenceItemIndex(referenceId) {
    return referenceItems.findIndex((item) => item.id === referenceId);
  }

  function setReferenceItemState(referenceId, patch) {
    const index = getReferenceItemIndex(referenceId);
    if (index < 0) return null;
    referenceItems[index] = { ...referenceItems[index], ...patch };
    return referenceItems[index];
  }

  function getReadyReferenceUrls() {
    return referenceItems
      .filter((item) => item.status === 'ready' && item.remoteUrl)
      .map((item) => item.remoteUrl);
  }

  function getReferenceMentionLabel(index) {
    return `Image ${index + 1}`;
  }

  function getPromptMentionCandidates() {
    return referenceItems.map((item, index) => ({
      id: item.id,
      label: getReferenceMentionLabel(index),
      token: `@${getReferenceMentionLabel(index)}`,
      imageUrl: String(item.previewUrl || item.remoteUrl || '').trim(),
    }));
  }

  function supportsRichPromptEditor() {
    return Boolean(
      promptInput
      && typeof document.createElement === 'function'
      && typeof document.createTextNode === 'function'
      && typeof document.createRange === 'function'
      && typeof window.getSelection === 'function'
    );
  }

  function updatePromptEditorEmptyState() {
    if (!promptRichInput) return;
    const hasContent = Array.from(promptRichInput.childNodes).some((node) => {
      if (node.nodeType === DOM_TEXT_NODE) return String(node.textContent || '').length > 0;
      return node.nodeType === DOM_ELEMENT_NODE;
    });
    promptRichInput.classList.toggle('is-empty', !hasContent);
  }

  function createMentionChip(candidate) {
    const chip = document.createElement('span');
    chip.className = 'prompt-mention-chip';
    chip.contentEditable = 'false';
    chip.dataset.mentionToken = candidate.token;
    chip.dataset.mentionLabel = candidate.label;
    chip.tabIndex = 0;

    const wrapper = document.createElement('div');
    wrapper.className = 'prompt-mention-chip-inner';

    if (candidate.imageUrl) {
      const thumbWrap = document.createElement('div');
      thumbWrap.className = 'prompt-mention-chip-thumb-wrap';
      const thumb = document.createElement('img');
      thumb.className = 'prompt-mention-chip-thumb';
      thumb.src = candidate.imageUrl;
      thumb.alt = candidate.label;
      thumbWrap.appendChild(thumb);
      wrapper.appendChild(thumbWrap);
    }

    const label = document.createElement('span');
    label.className = 'prompt-mention-chip-label';
    label.textContent = candidate.token;
    wrapper.appendChild(label);
    chip.appendChild(wrapper);
    return chip;
  }

  function clearActivePromptChip() {
    if (!promptRichInput) return;
    promptRichInput.querySelectorAll('.prompt-mention-chip.is-active').forEach((node) => {
      node.classList.remove('is-active');
    });
  }

  function getSelectedPromptChip() {
    if (!promptRichInput) return null;
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    const startNode = range.startContainer;
    if (startNode && startNode.nodeType === DOM_ELEMENT_NODE && startNode.classList && startNode.classList.contains('prompt-mention-chip')) {
      return startNode;
    }
    const parent = startNode && startNode.parentElement ? startNode.parentElement.closest('.prompt-mention-chip') : null;
    return parent && promptRichInput.contains(parent) ? parent : null;
  }

  function selectPromptChip(chip) {
    if (!chip || !promptRichInput) return;
    clearActivePromptChip();
    chip.classList.add('is-active');
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNode(chip);
    selection.removeAllRanges();
    selection.addRange(range);
    promptRichInput.focus();
  }

  function getChipAdjacentToSelection(direction = 'backward') {
    if (!promptRichInput) return null;
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    const startNode = range.startContainer;
    const offset = range.startOffset;

    if (!range.collapsed) {
      if (startNode && startNode.nodeType === DOM_ELEMENT_NODE && startNode.classList && startNode.classList.contains('prompt-mention-chip')) {
        return startNode;
      }
      return null;
    }

    if (startNode.nodeType === DOM_TEXT_NODE) {
      const textLength = String(startNode.textContent || '').length;
      if (direction === 'backward' && offset !== 0) return null;
      if (direction === 'forward' && offset !== textLength) return null;
      const sibling = direction === 'backward' ? startNode.previousSibling : startNode.nextSibling;
      if (sibling && sibling.nodeType === DOM_ELEMENT_NODE && sibling.classList && sibling.classList.contains('prompt-mention-chip')) {
        return sibling;
      }
      return null;
    }

    if (startNode.nodeType !== DOM_ELEMENT_NODE) return null;
    const index = direction === 'backward' ? offset - 1 : offset;
    const candidate = startNode.childNodes[index];
    if (candidate && candidate.nodeType === DOM_ELEMENT_NODE && candidate.classList && candidate.classList.contains('prompt-mention-chip')) {
      return candidate;
    }
    return null;
  }

  function hasEditableTextNearSelection(direction = 'backward') {
    if (!promptRichInput) return false;
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return false;
    const range = selection.getRangeAt(0);
    if (!range.collapsed) return false;
    const startNode = range.startContainer;
    const offset = range.startOffset;

    if (startNode.nodeType === DOM_TEXT_NODE) {
      const text = String(startNode.textContent || '');
      return direction === 'backward' ? offset > 0 : offset < text.length;
    }

    if (startNode.nodeType !== DOM_ELEMENT_NODE) return false;
    const neighbour = direction === 'backward' ? startNode.childNodes[offset - 1] : startNode.childNodes[offset];
    return Boolean(neighbour && neighbour.nodeType === DOM_TEXT_NODE && String(neighbour.textContent || '').length > 0);
  }

  function serializePromptRichInput() {
    if (!promptRichInput) return '';
    const parts = [];
    promptRichInput.childNodes.forEach((node) => {
      if (node.nodeType === DOM_TEXT_NODE) {
        parts.push(node.textContent || '');
        return;
      }
      if (node.nodeType === DOM_ELEMENT_NODE) {
        const element = node;
        if (element.classList && element.classList.contains('prompt-mention-chip')) {
          parts.push(element.dataset.mentionToken || element.textContent || '');
        } else {
          parts.push(element.textContent || '');
        }
      }
    });
    return parts.join('');
  }

  function setPromptTextareaValue(value) {
    if (!promptInput) return;
    if (promptInput.value === value) return;
    isSyncingPromptEditor = true;
    promptInput.value = value;
    promptInput.dispatchEvent(new Event('input', { bubbles: true }));
    isSyncingPromptEditor = false;
  }

  function resolvePromptMentionContext(range) {
    if (!promptRichInput || !range || !promptRichInput.contains(range.startContainer)) return null;
    if (range.startContainer.nodeType !== DOM_TEXT_NODE) return null;
    const textNode = range.startContainer;
    const before = String(textNode.textContent || '').slice(0, range.startOffset);
    const match = before.match(/@([^\s@]*)$/);
    if (!match) return null;
    return {
      textNode,
      startOffset: before.length - match[1].length - 1,
      endOffset: range.startOffset,
      query: match[1] || '',
    };
  }

  function getMentionContext() {
    if (!promptRichInput) return null;
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return null;
    return resolvePromptMentionContext(selection.getRangeAt(0));
  }

  function setCaretAfterNode(node) {
    if (!promptRichInput || !node) return;
    const range = document.createRange();
    range.setStartAfter(node);
    range.collapse(true);
    const selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(range);
    promptRichInput.focus();
  }

  function syncPromptTextareaFromRichInput() {
    if (!promptRichInput) return;
    setPromptTextareaValue(serializePromptRichInput());
    clearActivePromptChip();
    updatePromptEditorEmptyState();
  }

  function rebuildPromptRichInputFromText(value) {
    if (!promptRichInput) return;
    const raw = String(value || '');
    const tokenMap = new Map();
    getPromptMentionCandidates().forEach((item) => {
      tokenMap.set(item.token, item);
    });

    promptRichInput.innerHTML = '';
    const tokenPattern = /@Image\s+\d+|@[0-9a-fA-F-]{32,36}/g;
    let lastIndex = 0;
    let match;
    while ((match = tokenPattern.exec(raw)) !== null) {
      const token = match[0];
      if (match.index > lastIndex) {
        promptRichInput.appendChild(document.createTextNode(raw.slice(lastIndex, match.index)));
      }
      const candidate = tokenMap.get(token);
      if (candidate) {
        promptRichInput.appendChild(createMentionChip(candidate));
      } else {
        promptRichInput.appendChild(document.createTextNode(token));
      }
      lastIndex = match.index + token.length;
    }
    if (lastIndex < raw.length) {
      promptRichInput.appendChild(document.createTextNode(raw.slice(lastIndex)));
    }
    updatePromptEditorEmptyState();
  }

  function syncPromptRichInputFromTextarea() {
    if (!promptInput || !promptRichInput || isSyncingPromptEditor) return;
    rebuildPromptRichInputFromText(promptInput.value || '');
  }

  function normalizePromptRichInputTokens(moveCaretToEnd = true) {
    if (!promptRichInput) return;
    rebuildPromptRichInputFromText(serializePromptRichInput());
    if (!moveCaretToEnd) {
      syncPromptTextareaFromRichInput();
      return;
    }
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(promptRichInput);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    syncPromptTextareaFromRichInput();
  }

  function insertMentionLabel(candidate) {
    if (!promptRichInput || !candidate) return;
    const selection = window.getSelection();
    let range = null;
    if (selection && selection.rangeCount) {
      const currentRange = selection.getRangeAt(0);
      if (promptRichInput.contains(currentRange.startContainer)) {
        range = currentRange.cloneRange();
      }
    }
    if (!range && lastMentionRange) {
      range = lastMentionRange.cloneRange();
    }
    const context = resolvePromptMentionContext(range) || lastMentionContext;
    if (!context) {
      const chip = createMentionChip(candidate);
      promptRichInput.appendChild(chip);
      promptRichInput.appendChild(document.createTextNode(' '));
      normalizePromptRichInputTokens(true);
      hideReferenceMentionMenu();
      return;
    }

    const raw = String(context.textNode.textContent || '');
    context.textNode.textContent = `${raw.slice(0, context.startOffset)}${raw.slice(context.endOffset)}`;
    const workingRange = document.createRange();
    workingRange.setStart(context.textNode, context.startOffset);
    workingRange.collapse(true);
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(workingRange);
    }
    range = workingRange;

    const chip = createMentionChip(candidate);
    range.insertNode(chip);
    const trailingSpace = document.createTextNode(' ');
    if (chip.parentNode) {
      chip.parentNode.insertBefore(trailingSpace, chip.nextSibling);
    }
    setCaretAfterNode(trailingSpace);
    syncPromptTextareaFromRichInput();
    hideReferenceMentionMenu();
  }

  function hideReferenceMentionMenu() {
    activeMentionIndex = -1;
    if (!referenceMentionMenu) return;
    referenceMentionMenu.classList.add('hidden');
    referenceMentionMenu.innerHTML = '';
    lastMentionContext = null;
  }

  function renderReferenceMentionMenu() {
    if (!referenceMentionMenu || !promptRichInput) return;
    const context = getMentionContext();
    if (!context || !referenceItems.length) {
      hideReferenceMentionMenu();
      return;
    }

    const query = String(context.query || '').trim().toLowerCase();
    lastMentionContext = context;
    const selection = window.getSelection();
    if (selection && selection.rangeCount) {
      lastMentionRange = selection.getRangeAt(0).cloneRange();
    }
    const candidates = getPromptMentionCandidates().filter((item) => {
      return !query || item.label.toLowerCase().includes(query) || item.token.toLowerCase().includes(query);
    });
    if (!candidates.length) {
      hideReferenceMentionMenu();
      return;
    }
    if (activeMentionIndex < 0 || activeMentionIndex >= candidates.length) {
      activeMentionIndex = 0;
    }

    referenceMentionMenu.innerHTML = '';
    candidates.forEach((item, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'reference-mention-item';
      if (index === activeMentionIndex) {
        button.classList.add('is-active');
      }
      button.addEventListener('mousedown', (event) => {
        event.preventDefault();
        insertMentionLabel(item);
      });
      button.addEventListener('click', (event) => {
        event.preventDefault();
        insertMentionLabel(item);
      });

      if (item.imageUrl) {
        const thumb = document.createElement('img');
        thumb.className = 'reference-mention-thumb';
        thumb.src = item.imageUrl;
        thumb.alt = item.label;
        button.appendChild(thumb);
      }

      const label = document.createElement('div');
      label.className = 'reference-mention-label';
      label.textContent = item.label;
      button.appendChild(label);
      referenceMentionMenu.appendChild(button);
    });
    referenceMentionMenu.classList.remove('hidden');
  }

  function ensurePromptRichEditor() {
    if (!supportsRichPromptEditor() || !promptInput) return;
    if (promptInput.dataset.richPromptMounted === '1') return;

    const host = promptInput.parentElement;
    if (!host) return;

    const wrap = document.createElement('div');
    wrap.className = 'video-prompt-wrap';
    host.insertBefore(wrap, promptInput);

    promptRichInput = document.createElement('div');
    promptRichInput.id = 'promptRichInput';
    promptRichInput.className = 'prompt-rich-input is-empty';
    promptRichInput.contentEditable = 'true';
    promptRichInput.setAttribute('spellcheck', 'false');
    promptRichInput.setAttribute('role', 'textbox');
    promptRichInput.dataset.placeholder = promptInput.getAttribute('placeholder') || '';

    referenceMentionMenu = document.createElement('div');
    referenceMentionMenu.id = 'referenceMentionMenu';
    referenceMentionMenu.className = 'reference-mention-menu hidden';

    wrap.appendChild(promptRichInput);
    wrap.appendChild(referenceMentionMenu);
    wrap.appendChild(promptInput);

    promptInput.classList.add('prompt-textarea-proxy');
    promptInput.setAttribute('aria-hidden', 'true');
    promptInput.tabIndex = -1;
    promptInput.dataset.richPromptMounted = '1';

    promptRichInput.addEventListener('input', () => {
      syncPromptTextareaFromRichInput();
      renderReferenceMentionMenu();
    });
    promptRichInput.addEventListener('click', (event) => {
      const chip = event.target instanceof Element ? event.target.closest('.prompt-mention-chip') : null;
      if (chip) {
        event.preventDefault();
        selectPromptChip(chip);
        hideReferenceMentionMenu();
        return;
      }
      clearActivePromptChip();
      renderReferenceMentionMenu();
    });
    promptRichInput.addEventListener('focus', () => {
      renderReferenceMentionMenu();
    });
    promptRichInput.addEventListener('blur', () => {
      window.setTimeout(() => hideReferenceMentionMenu(), 120);
    });
    promptRichInput.addEventListener('keydown', (event) => {
      const hasOpenMenu = referenceMentionMenu && !referenceMentionMenu.classList.contains('hidden');
      if (hasOpenMenu && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        const total = referenceMentionMenu.querySelectorAll('.reference-mention-item').length;
        if (total > 0) {
          event.preventDefault();
          if (event.key === 'ArrowDown') {
            activeMentionIndex = (activeMentionIndex + 1 + total) % total;
          } else {
            activeMentionIndex = (activeMentionIndex - 1 + total) % total;
          }
          renderReferenceMentionMenu();
          return;
        }
      }
      if (hasOpenMenu && event.key === 'Enter') {
        const activeLabel = referenceMentionMenu.querySelector('.reference-mention-item.is-active .reference-mention-label');
        if (activeLabel) {
          event.preventDefault();
          const candidate = getPromptMentionCandidates().find((item) => item.label === (activeLabel.textContent || ''));
          if (candidate) {
            insertMentionLabel(candidate);
          }
          return;
        }
      }
      if (hasOpenMenu && event.key === 'Escape') {
        hideReferenceMentionMenu();
        return;
      }
      const selectedChip = getSelectedPromptChip();
      if ((event.key === 'Backspace' || event.key === 'Delete') && selectedChip) {
        event.preventDefault();
        selectedChip.remove();
        syncPromptTextareaFromRichInput();
        return;
      }
      if (event.key === 'Backspace' && hasEditableTextNearSelection('backward')) {
        return;
      }
      if (event.key === 'Delete' && hasEditableTextNearSelection('forward')) {
        return;
      }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        const adjacentChip = getChipAdjacentToSelection(event.key === 'Backspace' ? 'backward' : 'forward');
        if (adjacentChip) {
          event.preventDefault();
          if (adjacentChip.classList.contains('is-active')) {
            adjacentChip.remove();
            syncPromptTextareaFromRichInput();
          } else {
            selectPromptChip(adjacentChip);
          }
          return;
        }
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const adjacentChip = getChipAdjacentToSelection(event.key === 'ArrowLeft' ? 'backward' : 'forward');
        if (adjacentChip) {
          event.preventDefault();
          selectPromptChip(adjacentChip);
          return;
        }
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        startConnection();
      }
    });

    promptInput.addEventListener('input', () => {
      syncPromptRichInputFromTextarea();
      renderReferenceMentionMenu();
    });

    document.addEventListener('click', (event) => {
      if (!referenceMentionMenu || referenceMentionMenu.classList.contains('hidden')) return;
      if (promptRichInput && promptRichInput.contains(event.target)) return;
      if (referenceMentionMenu.contains(event.target)) return;
      hideReferenceMentionMenu();
    });

    syncPromptRichInputFromTextarea();
  }

  function removeReferenceItem(referenceId) {
    const index = getReferenceItemIndex(referenceId);
    if (index < 0) return;
    const [item] = referenceItems.splice(index, 1);
    if (window.VideoReferenceCache && typeof VideoReferenceCache.abortReferenceUpload === 'function') {
      try {
        VideoReferenceCache.abortReferenceUpload(item);
      } catch (e) {
        // ignore
      }
    } else if (item && typeof item.abortUpload === 'function') {
      try {
        item.abortUpload();
      } catch (e) {
        // ignore
      }
    }
    revokeReferencePreview(item);
    if (imageFileInput) {
      imageFileInput.value = '';
    }
    renderReferenceItems();
  }

  function renderReferenceItems() {
    if (!referenceList || !selectImageFileBtn) return;
    referenceList.innerHTML = '';
    referenceItems.forEach((item, index) => {
      const card = document.createElement('div');
      card.className = 'reference-card';
      if (item.status === 'uploading') {
        card.classList.add('is-uploading');
      } else if (item.status === 'error') {
        card.classList.add('is-error');
      }

      const image = document.createElement('img');
      image.className = 'reference-card-image';
      image.src = item.previewUrl;
      image.alt = item.name || `reference-${index + 1}`;
      card.appendChild(image);

      const badge = document.createElement('div');
      badge.className = 'reference-badge';
      badge.textContent = getReferenceMentionLabel(index);
      card.appendChild(badge);

      if (item.status === 'uploading' || item.status === 'error') {
        const overlay = document.createElement('div');
        overlay.className = 'reference-card-overlay';
        if (item.status === 'uploading') {
          const progressBar = document.createElement('span');
          progressBar.className = 'reference-card-progress';
          progressBar.style.setProperty('--upload-progress', `${Math.max(0, Math.min(100, Number(item.progress) || 0))}%`);
          overlay.appendChild(progressBar);
        }
        const label = document.createElement('span');
        label.className = 'reference-card-status';
        label.textContent = item.status === 'uploading'
          ? `${Math.max(0, Math.min(100, Math.round(Number(item.progress) || 0)))}%`
          : (item.error || tSafe('video.uploadFailed', '上传失败'));
        overlay.appendChild(label);
        card.appendChild(overlay);
      }

      const removeBtn = document.createElement('button');
      removeBtn.className = 'reference-card-remove';
      removeBtn.type = 'button';
      removeBtn.setAttribute('aria-label', tSafe('video.clearImage', '移除参考图'));
      removeBtn.dataset.referenceRemove = item.id;
      removeBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
      card.appendChild(removeBtn);
      referenceList.appendChild(card);
    });

    if (referenceItems.length < MAX_REFERENCE_FILES) {
      selectImageFileBtn.className = 'reference-card reference-card-add';
      selectImageFileBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg>';
      selectImageFileBtn.removeAttribute('data-i18n');
      selectImageFileBtn.setAttribute('aria-label', '添加参考图');
      selectImageFileBtn.classList.remove('hidden');
      selectImageFileBtn.disabled = false;
      referenceList.appendChild(selectImageFileBtn);
    } else {
      selectImageFileBtn.classList.add('hidden');
      selectImageFileBtn.disabled = true;
    }

    if (imageFileName) {
      imageFileName.textContent = referenceItems.length
        ? `${referenceItems.length}/${MAX_REFERENCE_FILES}`
        : tSafe('common.noFileSelected', '未选择文件');
    }
    syncStartButtonAvailability();
    syncPromptRichInputFromTextarea();
    renderReferenceMentionMenu();
  }

  function uploadReferenceItem(referenceItem, authHeader) {
    const uploadTask = (file) => new Promise((resolve, reject) => {
      const form = new FormData();
      form.append('file', file, file.name || 'reference.png');
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/v1/function/uploads/image');
      const headers = buildAuthHeaders(authHeader);
      Object.entries(headers || {}).forEach(([key, value]) => {
        if (value == null || value === '') return;
        xhr.setRequestHeader(key, String(value));
      });
      setReferenceItemState(referenceItem.id, {
        status: 'uploading',
        progress: 0,
        error: '',
        abortUpload: () => xhr.abort(),
      });
      renderReferenceItems();
      xhr.upload.onprogress = (event) => {
        const nextProgress = event.lengthComputable && event.total > 0
          ? Math.max(1, Math.min(99, Math.round((event.loaded / event.total) * 100)))
          : 50;
        if (setReferenceItemState(referenceItem.id, { progress: nextProgress })) {
          renderReferenceItems();
        }
      };
      xhr.onload = () => {
        const text = typeof xhr.responseText === 'string' ? xhr.responseText : '';
        let payload = null;
        try {
          payload = text ? JSON.parse(text) : null;
        } catch (e) {
          payload = null;
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          const message = (payload && payload.error && payload.error.message) || text || tSafe('common.requestFailed', '请求失败');
          reject(new Error(message));
          return;
        }
        const url = payload && payload.url ? String(payload.url) : '';
        if (!url) {
          reject(new Error(tSafe('video.uploadFailed', '上传失败')));
          return;
        }
        resolve(url);
      };
      xhr.onerror = () => {
        reject(new Error(tSafe('video.uploadFailed', '上传失败')));
      };
      xhr.onabort = () => {
        reject(new Error('upload_aborted'));
      };
      xhr.send(form);
    });

    referenceUploadCache.getOrUpload(referenceItem.file, uploadTask)
      .then((remoteUrl) => {
        if (!setReferenceItemState(referenceItem.id, {
          remoteUrl,
          status: 'ready',
          progress: 100,
          error: '',
          abortUpload: null,
        })) {
          return;
        }
        renderReferenceItems();
      })
      .catch((error) => {
        if (String(error && error.message || '') === 'upload_aborted') {
          return;
        }
        const liveItem = setReferenceItemState(referenceItem.id, {
          status: 'error',
          error: error && error.message ? error.message : tSafe('video.uploadFailed', '上传失败'),
          abortUpload: null,
        });
        if (!liveItem) return;
        renderReferenceItems();
        toast(liveItem.error, 'error');
      });
  }

  async function queueReferenceFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const authHeader = await ensureFunctionKey();
    if (authHeader === null) {
      toast(tSafe('common.configurePublicKey', '请先配置 Function Key。'), 'error');
      window.location.href = '/login';
      return;
    }
    const imageFiles = [];
    let invalidCount = 0;
    files.forEach((file) => {
      if (file && String(file.type || '').toLowerCase().startsWith('image/')) {
        imageFiles.push(file);
      } else {
        invalidCount += 1;
      }
    });
    if (invalidCount) {
      toast('仅支持上传图片文件。', 'error');
    }

    const remaining = MAX_REFERENCE_FILES - referenceItems.length;
    if (remaining <= 0) {
      toast(`最多上传 ${MAX_REFERENCE_FILES} 张参考图。`, 'warning');
      if (imageFileInput) {
        imageFileInput.value = '';
      }
      return;
    }
    if (imageFiles.length > remaining) {
      toast(`最多上传 ${MAX_REFERENCE_FILES} 张参考图。`, 'warning');
    }

    imageFiles.slice(0, remaining).forEach((file) => {
      const cachedUrl = referenceUploadCache.peek(file);
      const referenceItem = {
        id: nextReferenceItemId(),
        file,
        name: file.name || 'reference',
        previewUrl: URL.createObjectURL(file),
        progress: cachedUrl ? 100 : 0,
        status: cachedUrl ? 'ready' : 'uploading',
        remoteUrl: cachedUrl || '',
        error: '',
        abortUpload: null,
      };
      referenceItems.push(referenceItem);
      renderReferenceItems();
      if (!cachedUrl) {
        uploadReferenceItem(referenceItem, authHeader);
      }
    });

    if (imageFileInput) {
      imageFileInput.value = '';
    }
  }

  async function resolveReferenceImage() {
    if (referenceItems.some((item) => item.status === 'uploading')) {
      toast('参考图上传中，请稍候。', 'warning');
      throw new Error('reference_uploading');
    }
    if (referenceItems.some((item) => item.status === 'error')) {
      toast('请移除上传失败的参考图后再试。', 'error');
      throw new Error('reference_invalid');
    }
    return getReadyReferenceUrls();
  }

  async function createVideoTask(authHeader, payload) {
    const res = await fetch('/v1/function/video/start', {
      method: 'POST',
      headers: {
        ...buildAuthHeaders(authHeader),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || 'Failed to create task');
    }
    const data = await res.json();
    return data && data.task_id ? String(data.task_id) : '';
  }

  async function requestVideoUpscale(authHeader, payload) {
    const res = await fetch('/v1/function/video/upscale', {
      method: 'POST',
      headers: {
        ...buildAuthHeaders(authHeader),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      data = null;
    }
    if (!res.ok) {
      const message = (data && data.error) || text || 'Failed to upscale video';
      throw new Error(String(message));
    }
    return data || {};
  }

  async function loadCachedVideos() {
    const authHeader = await ensureFunctionKey();
    if (authHeader === null) {
      toast(tSafe('common.configurePublicKey', '请先配置 Function Key。'), 'error');
      window.location.href = '/login';
      return [];
    }
    const res = await fetch('/v1/function/video/cache/list?page=1&page_size=100', {
      headers: buildAuthHeaders(authHeader),
    });
    if (!res.ok) {
      throw new Error(`load_cache_failed_${res.status}`);
    }
    const data = await res.json();
    return Array.isArray(data.items) ? data.items : [];
  }

  function openCacheVideoModal() {
    if (!cacheVideoModal) return;
    cacheVideoModal.classList.remove('hidden');
  }

  function closeCacheVideoModal() {
    if (!cacheVideoModal) return;
    cacheVideoModal.classList.add('hidden');
  }

  function renderCachedVideoList(items) {
    if (!cacheVideoList) return;
    if (!items.length) {
      cacheVideoList.innerHTML = '<div class="video-empty">暂无缓存视频。</div>';
      return;
    }
    const html = items.map((item, idx) => {
      const name = String(item.name || '');
      const url = String(item.view_url || '');
      const postId = String(item.post_id || '');
      const rootAttachmentId = String(item.root_attachment_id || postId);
      const size = formatBytes(item.size_bytes);
      const mtime = formatMtime(item.mtime_ms);
      return `<div class="cache-video-item" data-url="${escapeHtml(url)}" data-name="${escapeHtml(name)}" data-post-id="${escapeHtml(postId)}" data-root-attachment-id="${escapeHtml(rootAttachmentId)}">
        <div class="cache-video-thumb-wrap">
          <video class="cache-video-thumb" src="${escapeHtml(url)}" preload="metadata" muted playsinline></video>
        </div>
        <div class="cache-video-meta">
          <div class="cache-video-name">${escapeHtml(name || `video_${idx + 1}.mp4`)}</div>
          <div class="cache-video-sub">${escapeHtml(size)} · ${escapeHtml(mtime)}</div>
        </div>
        <button class="geist-button-outline text-xs px-3 cache-video-use" type="button">使用</button>
      </div>`;
    }).join('');
    cacheVideoList.innerHTML = html;
  }

  function useCachedVideo(url, name, postIdValue, rootAttachmentValue) {
    const safeUrl = String(url || '').trim();
    if (!safeUrl) return;
    const postId = String(postIdValue || '').trim() || extractPostIdFromFileName(String(name || '')) || extractPostIdFromFileName(safeUrl);
    const rootAttachmentId = String(rootAttachmentValue || '').trim() || postId;
    selectedVideoItemId = `cache-${Date.now()}`;
    refreshVideoSelectionUi();
    applyWorkspaceVideo(safeUrl, {
      name,
      extendPostId: postId,
      rootAttachmentId,
      label: basename(name) || basename(safeUrl)
    });
    closeCacheVideoModal();
    toast('已将缓存视频载入工作区。', 'success');
  }

  async function stopVideoTask(taskId, authHeader) {
    if (!taskId) return;
    try {
      await fetch('/v1/function/video/stop', {
        method: 'POST',
        headers: {
          ...buildAuthHeaders(authHeader),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ task_ids: [taskId] })
      });
    } catch (e) {
      // ignore
    }
  }

  function extractVideoInfo(buffer) {
    if (!buffer) return null;
    if (buffer.includes('<video')) {
      const matches = buffer.match(/<video[\s\S]*?<\/video>/gi);
      if (matches && matches.length) {
        return { html: matches[matches.length - 1] };
      }
    }
    const mdMatches = buffer.match(/\[video\]\(([^)]+)\)/g);
    if (mdMatches && mdMatches.length) {
      const last = mdMatches[mdMatches.length - 1];
      const urlMatch = last.match(/\[video\]\(([^)]+)\)/);
      if (urlMatch) {
        return { url: urlMatch[1] };
      }
    }
    const urlMatches = buffer.match(/https?:\/\/[^\s<)]+/g);
    if (urlMatches && urlMatches.length) {
      return { url: urlMatches[urlMatches.length - 1] };
    }
    return null;
  }

  function extractVideoUrlFromAnyText(text) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    const sourceMatch = raw.match(/<source[^>]*\ssrc=["']([^"']+)["']/i);
    if (sourceMatch && sourceMatch[1]) {
      return normalizeMediaUrl(sourceMatch[1]);
    }
    const videoMatch = raw.match(/<video[^>]*\ssrc=["']([^"']+)["']/i);
    if (videoMatch && videoMatch[1]) {
      return normalizeMediaUrl(videoMatch[1]);
    }
    const anchorMatch = raw.match(/<a[^>]*\shref=["']([^"']+)["']/i);
    if (anchorMatch && anchorMatch[1]) {
      return normalizeMediaUrl(anchorMatch[1]);
    }
    const info = extractVideoInfo(raw);
    if (info && info.url) {
      return normalizeMediaUrl(info.url);
    }
    const directMatch = raw.match(/https?:\/\/[^\s"'<>]+/i);
    if (directMatch && directMatch[0]) {
      return normalizeMediaUrl(directMatch[0]);
    }
    const localMatch = raw.match(/\/images\/[^\s"'<>]+/i);
    if (localMatch && localMatch[0]) {
      return normalizeMediaUrl(localMatch[0]);
    }
    return '';
  }

  function buildCurrentVideoRenderOptions() {
    return {
      extendPostId: currentExtendPostId,
      rootAttachmentId: currentRunKind === 'splice'
        ? (originalFileAttachmentId || currentExtendPostId)
        : undefined
    };
  }

  function getCurrentPreviewUrl() {
    if (!currentPreviewItem) return '';
    return String(currentPreviewItem.dataset.url || '').trim();
  }

  function tryFinalizeSpliceResult(rawText) {
    if (currentRunKind !== 'splice') {
      return Boolean(getCurrentPreviewUrl());
    }
    if (getCurrentPreviewUrl()) {
      return true;
    }
    const combined = [contentBuffer, String(rawText || '').trim()]
      .filter(Boolean)
      .join('\n');
    if (!combined) {
      return false;
    }
    const info = extractVideoInfo(combined);
    if (info && info.html) {
      renderVideoFromHtml(info.html, buildCurrentVideoRenderOptions());
    } else {
      const resolvedUrl = extractVideoUrlFromAnyText(combined);
      if (resolvedUrl) {
        renderVideoFromUrl(resolvedUrl, buildCurrentVideoRenderOptions());
      }
    }
    return Boolean(getCurrentPreviewUrl());
  }

  function renderVideoFromHtml(html, options) {
    // SSE 流去重：预提取 URL，相同则跳过渲染
    const srcMatch = html.match(/src=["']([^"']+)["']/);
    const preExtractUrl = srcMatch ? srcMatch[1] : '';
    if (preExtractUrl && preExtractUrl === lastRenderedVideoUrl) return;
    const container = ensurePreviewSlot(currentRunKind);
    if (!container) return;
    const body = container.querySelector('.video-item-body');
    if (!body) return;
    body.innerHTML = html;
    const videoEl = body.querySelector('video');
    let videoUrl = '';
    if (videoEl) {
      videoEl.controls = true;
      videoEl.preload = 'metadata';
      const source = videoEl.querySelector('source');
      if (source && source.getAttribute('src')) {
        videoUrl = source.getAttribute('src');
        source.removeAttribute('src'); // 阻止浏览器自动发起原始 URL 请求
      } else if (videoEl.getAttribute('src')) {
        videoUrl = videoEl.getAttribute('src');
        videoEl.removeAttribute('src');
      }
    }
    if (videoUrl) lastRenderedVideoUrl = videoUrl;
    updateItemLinks(container, videoUrl, options);
    if (videoUrl) {
      // 多路复用：通过 Blob 缓存加载，避免重复网络请求
      loadVideoToBlob(videoUrl).then((blobUrl) => {
        if (videoEl) {
          videoEl.src = blobUrl;
          videoEl.load();
        }
        syncWorkspaceFromPreview(container);
      }).catch(() => {
        // 降级：使用原始 URL
        if (videoEl) {
          videoEl.src = videoUrl;
          videoEl.load();
        }
        syncWorkspaceFromPreview(container);
      });
    }
  }

  function renderVideoFromUrl(url, options) {
    const safeUrl = url || '';
    // SSE 流去重：相同 URL 不重复渲染，避免高频 DOM 撕裂导致视频反复请求
    if (safeUrl && safeUrl === lastRenderedVideoUrl) return;
    if (safeUrl) lastRenderedVideoUrl = safeUrl;
    const container = ensurePreviewSlot(currentRunKind);
    if (!container) return;
    const body = container.querySelector('.video-item-body');
    if (!body) return;
    // 先挂占位 video 元素，不设置 src 避免浏览器发起原始 URL 请求
    body.innerHTML = `\n      <video controls preload="metadata">\n        <source src="" type="video/mp4">\n      </video>\n    `;
    updateItemLinks(container, safeUrl, options);
    if (safeUrl) {
      // 多路复用：通过 Blob 缓存加载
      loadVideoToBlob(safeUrl).then((blobUrl) => {
        const sourceEl = body.querySelector('source');
        const videoEl = body.querySelector('video');
        if (sourceEl) sourceEl.src = blobUrl;
        if (videoEl) videoEl.load();
        syncWorkspaceFromPreview(container);
      }).catch(() => {
        // 降级：使用原始 URL
        const sourceEl = body.querySelector('source');
        const videoEl = body.querySelector('video');
        if (sourceEl) sourceEl.src = safeUrl;
        if (videoEl) videoEl.load();
        syncWorkspaceFromPreview(container);
      });
    }
  }

  function getSafeEditMaxTimestampMs() {
    if (!editVideo) return Number.POSITIVE_INFINITY;
    const durationMs = Math.floor(Math.max(0, Number(editVideo.duration || 0) * 1000));
    if (!durationMs) return Number.POSITIVE_INFINITY;
    return Math.max(0, durationMs - TAIL_FRAME_GUARD_MS);
  }

  function clampEditTimestampMs(ms) {
    const safe = Math.max(0, Math.round(Number(ms) || 0));
    return Math.max(0, Math.min(safe, getSafeEditMaxTimestampMs()));
  }

  function updateTimelineByVideoTime() {
    if (!editVideo || !editTimeline) return;
    const duration = Number(editVideo.duration || 0);
    if (!Number.isFinite(duration) || duration <= 0) return;
    lockedTimestampMs = clampEditTimestampMs(Math.round(Number(editVideo.currentTime || 0) * 1000));
    const ratio = Math.max(0, Math.min(1, lockedTimestampMs / Math.max(duration * 1000, 1)));
    editTimeline.value = String(Math.round(ratio * EDIT_TIMELINE_MAX));
    updateDeleteZoneTrack(editTimeline);
    if (editTimeText) {
      editTimeText.textContent = formatMs(lockedTimestampMs);
    }
  }

  function lockFrameByCurrentTime() {
    if (!editVideo) return;
    const safeTimestampMs = clampEditTimestampMs(Math.round(Number(editVideo.currentTime || 0) * 1000));
    const safeSeconds = safeTimestampMs / 1000;
    if (Math.abs(safeSeconds - Number(editVideo.currentTime || 0)) > 0.08) {
      editVideo.currentTime = safeSeconds;
    }
    lockedTimestampMs = safeTimestampMs;
    lockedFrameIndex = Math.max(0, Math.round(safeSeconds * APPROX_VIDEO_FPS));
    setEditMeta();
    if (editTimeText) {
      editTimeText.textContent = formatMs(lockedTimestampMs);
    }
  }

  function handleDelta(text) {
    if (!text) return;
    if (text.includes('<think>') || text.includes('</think>')) {
      return;
    }
    if (text.includes('超分辨率') || text.includes('super resolution')) {
      setStatus('connecting', tSafe('video.superResolutionInProgress', '超分处理中'));
      setIndeterminate(true);
      if (progressText) {
        progressText.textContent = tSafe('video.superResolutionInProgress', '超分处理中');
      }
      return;
    }

    if (!collectingContent) {
      const maybeVideo = text.includes('<video') || text.includes('[video](') || text.includes('http://') || text.includes('https://');
      if (maybeVideo) {
        collectingContent = true;
      }
    }

    if (collectingContent) {
      contentBuffer += text;
      const info = extractVideoInfo(contentBuffer);
      if (info) {
        if (info.html) {
          renderVideoFromHtml(info.html, buildCurrentVideoRenderOptions());
        } else if (info.url) {
          renderVideoFromUrl(info.url, buildCurrentVideoRenderOptions());
        }
      }
      return;
    }

    progressBuffer += text;
    const roundMatches = [...progressBuffer.matchAll(/\[round=(\d+)\/(\d+)\]\s*progress=([0-9]+(?:\.[0-9]+)?)%/g)];
    if (roundMatches.length) {
      const last = roundMatches[roundMatches.length - 1];
      const round = parseInt(last[1], 10);
      const total = parseInt(last[2], 10);
      const value = parseFloat(last[3]);
      setIndeterminate(false);
      updateProgress(value);
      if (progressText && Number.isFinite(round) && Number.isFinite(total) && total > 0) {
        progressText.textContent = `${Math.round(value)}% · ${round}/${total}`;
      }
      progressBuffer = progressBuffer.slice(Math.max(0, progressBuffer.length - 300));
      return;
    }

    const genericProgressMatches = [...progressBuffer.matchAll(/progress=([0-9]+(?:\.[0-9]+)?)%/g)];
    if (genericProgressMatches.length) {
      const last = genericProgressMatches[genericProgressMatches.length - 1];
      const value = parseFloat(last[1]);
      setIndeterminate(false);
      updateProgress(value);
      progressBuffer = progressBuffer.slice(Math.max(0, progressBuffer.length - 240));
      return;
    }

    const matches = [...progressBuffer.matchAll(/进度\s*(\d+)%/g)];
    if (matches.length) {
      const last = matches[matches.length - 1];
      const value = parseInt(last[1], 10);
      setIndeterminate(false);
      updateProgress(value);
      progressBuffer = progressBuffer.slice(Math.max(0, progressBuffer.length - 200));
    }
  }

  function closeSource() {
    if (currentSource) {
      try {
        currentSource.close();
      } catch (e) {
        // ignore
      }
      currentSource = null;
    }
  }

  function buildGenerationPayload(prompt, imageUrls) {
    const aspectRatio = getRequestedAspectRatio();
    const videoLength = getRequestedVideoLength();
    const resolutionName = getRequestedResolutionName();
    const preset = getRequestedPreset();
    if (window.FunctionPayloads && typeof FunctionPayloads.buildVideoStartPayload === 'function') {
      return FunctionPayloads.buildVideoStartPayload({
        prompt,
        aspectRatio,
        videoLength,
        resolutionName,
        preset,
        reasoningEffort: DEFAULT_REASONING_EFFORT,
        referenceUrl: imageUrls
      });
    }
    return {
      prompt,
      image_reference: buildImageReferencePayload(imageUrls),
      reasoning_effort: DEFAULT_REASONING_EFFORT,
      aspect_ratio: aspectRatio,
      video_length: videoLength,
      resolution_name: resolutionName,
      preset
    };
  }

  function buildExtensionPayload(prompt) {
    const aspectRatio = getRequestedAspectRatio();
    const resolutionName = getRequestedResolutionName();
    const preset = getRequestedPreset();
    if (window.FunctionPayloads && typeof FunctionPayloads.buildVideoStartPayload === 'function') {
      return FunctionPayloads.buildVideoStartPayload({
        prompt,
        aspectRatio,
        videoLength: DEFAULT_EXTEND_SECONDS,
        resolutionName,
        preset,
        reasoningEffort: DEFAULT_REASONING_EFFORT,
        extension: {
          extendPostId: currentExtendPostId,
          startTime: Math.max(0, lockedTimestampMs / 1000),
          originalPostId: currentExtendPostId,
          fileAttachmentId: originalFileAttachmentId || currentExtendPostId,
          stitchWithExtend: true
        }
      });
    }
    return {
      prompt,
      reasoning_effort: DEFAULT_REASONING_EFFORT,
      aspect_ratio: aspectRatio,
      video_length: DEFAULT_EXTEND_SECONDS,
      resolution_name: resolutionName,
      preset,
      is_video_extension: true,
      extend_post_id: currentExtendPostId,
      video_extension_start_time: Math.max(0, lockedTimestampMs / 1000),
      original_post_id: currentExtendPostId,
      file_attachment_id: originalFileAttachmentId || currentExtendPostId,
      stitch_with_extend: true
    };
  }

  function getSelectedHistoryItem() {
    if (!videoStage || !selectedVideoItemId) return null;
    return videoStage.querySelector(`.video-item[data-index="${selectedVideoItemId}"]`);
  }

  async function runUpscaleSelectedVideo() {
    if (isRunning) {
      toast('请先停止当前任务，再执行 AI超分。', 'warning');
      return;
    }
    if (!selectedVideoUrl) {
      toast('请先选择一个视频。', 'error');
      return;
    }
    const videoId = String(currentExtendPostId || extractPostIdFromFileName(selectedVideoUrl)).trim();
    if (!videoId) {
      toast('当前视频缺少可用于超分的 ID。', 'error');
      return;
    }

    const authHeader = await ensureFunctionKey();
    if (authHeader === null) {
      toast(tSafe('common.configurePublicKey', 'Configure Function Key first.'), 'error');
      window.location.href = '/login';
      return;
    }

    if (upscaleBtn) {
      upscaleBtn.disabled = true;
    }

    try {
      const payload = await requestVideoUpscale(authHeader, {
        video_id: videoId,
        video_url: selectedVideoUrl
      });
      const nextUrl = String((payload && payload.video_url) || '').trim();
      if (!nextUrl) {
        throw new Error('Missing upscaled video url');
      }
      const selectedItem = getSelectedHistoryItem();
      if (selectedItem) {
        updateItemLinks(selectedItem, nextUrl, {
          name: selectedItem.dataset.name || basename(nextUrl),
          extendPostId: selectedItem.dataset.postId || videoId,
          rootAttachmentId: selectedItem.dataset.rootAttachmentId || selectedItem.dataset.postId || videoId
        });
        selectedItem.dataset.workspaceSyncedUrl = '';
      }
      applyWorkspaceVideo(nextUrl, {
        name: basename(nextUrl),
        extendPostId: videoId,
        rootAttachmentId: originalFileAttachmentId || videoId,
        forceReload: true
      });
      toast('AI超分完成。', 'success');
    } catch (e) {
      toast(e && e.message ? e.message : 'AI超分失败。', 'error');
    } finally {
      syncTimelineAvailability();
    }
  }

  async function startConnection() {
    if (isRunning) {
      toast(tSafe('video.alreadyGenerating', 'Task already running.'), 'warning');
      return;
    }

    const authHeader = await ensureFunctionKey();
    if (authHeader === null) {
      toast(tSafe('common.configurePublicKey', 'Configure Function Key first.'), 'error');
      window.location.href = '/login';
      return;
    }

    const prompt = promptInput ? promptInput.value.trim() : '';
    let imageUrls = [];
    try {
      imageUrls = await resolveReferenceImage();
    } catch (e) {
      return;
    }
    if (!prompt && !imageUrls.length) {
      toast(tSafe('common.enterPrompt', 'Enter a prompt or add a reference image.'), 'error');
      return;
    }

    isRunning = true;
    currentRunKind = 'generate';
    syncStartButtonAvailability();
    updateMeta();
    resetOutput(true);
    initPreviewSlot(currentRunKind);
    setStatus('connecting', tSafe('common.connecting', 'Connecting'));

    const payload = buildGenerationPayload(prompt, imageUrls);

    let taskId = '';
    try {
      taskId = await createVideoTask(authHeader, payload);
    } catch (e) {
      setStatus('error', tSafe('common.createTaskFailed', 'Failed to create task.'));
      isRunning = false;
      syncStartButtonAvailability();
      return;
    }

    currentTaskId = taskId;
    startAt = Date.now();
    setStatus('connected', tSafe('common.generating', 'Generating'));
    setButtons(true);
    setIndeterminate(true);
    syncTimelineAvailability();
    startElapsedTimer();

    const rawPublicKey = normalizeAuthHeader(authHeader);
    const url = buildSseUrl(taskId, rawPublicKey);
    closeSource();
    const es = new EventSource(url);
    currentSource = es;

    es.onopen = () => {
      setStatus('connected', tSafe('common.generating', 'Generating'));
    };

    es.onmessage = (event) => {
      if (!event || !event.data) return;
      if (event.data === '[DONE]') {
        finishRun();
        return;
      }
      let payloadObject = null;
      try {
        payloadObject = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      if (payloadObject && payloadObject.error) {
        toast(payloadObject.error, 'error');
        setStatus('error', tSafe('common.generationFailed', 'Generation failed.'));
        finishRun(true);
        return;
      }
      const choice = payloadObject && payloadObject.choices ? payloadObject.choices[0] : null;
      const delta = choice && choice.delta ? choice.delta : null;
      if (delta && delta.content) {
        handleDelta(delta.content);
      }
      if (choice && choice.finish_reason === 'stop') {
        finishRun();
      }
    };

    es.onerror = () => {
      if (!isRunning) return;
      setStatus('error', tSafe('common.connectionError', 'Connection error.'));
      finishRun(true);
    };
  }

  async function runExtendVideo() {
    if (isRunning && currentRunKind === 'splice') {
      setSpliceButtonState('stopping');
      await stopConnection();
      return;
    }
    if (isRunning) {
      toast(tSafe('video.alreadyGenerating', 'Task already running.'), 'warning');
      return;
    }
    if (!selectedVideoUrl) {
      toast('Select a video before extending.', 'error');
      return;
    }
    if (!currentExtendPostId) {
      toast('Missing extend post id for current video.', 'error');
      return;
    }

    const authHeader = await ensureFunctionKey();
    if (authHeader === null) {
      toast(tSafe('common.configurePublicKey', 'Configure Function Key first.'), 'error');
      window.location.href = '/login';
      return;
    }

    const prompt = editPromptInput ? editPromptInput.value.trim() : '';
    const payload = buildExtensionPayload(prompt);

    isRunning = true;
    currentRunKind = 'splice';
    syncStartButtonAvailability();
    updateMeta();
    resetOutput(true);
    initPreviewSlot(currentRunKind);
    setSpliceButtonState('running');
    setStatus('connecting', 'Preparing extension');

    let taskId = '';
    try {
      taskId = await createVideoTask(authHeader, payload);
    } catch (e) {
      setStatus('error', tSafe('common.createTaskFailed', 'Failed to create task.'));
      isRunning = false;
      syncStartButtonAvailability();
      setSpliceButtonState('idle');
      return;
    }

    currentTaskId = taskId;
    startAt = Date.now();
    setStatus('connected', 'Extending');
    setButtons(true);
    setIndeterminate(true);
    syncTimelineAvailability();
    startElapsedTimer();

    const rawPublicKey = normalizeAuthHeader(authHeader);
    const url = buildSseUrl(taskId, rawPublicKey);
    closeSource();
    const es = new EventSource(url);
    currentSource = es;
    let rawEventBuffer = '';

    es.onopen = () => {
      setStatus('connected', 'Extending');
    };

    es.onmessage = (event) => {
      if (!event || !event.data) return;
      rawEventBuffer += `${String(event.data)}\n`;
      if (event.data === '[DONE]') {
        if (tryFinalizeSpliceResult(rawEventBuffer)) {
          finishRun();
        } else {
          setStatus('error', 'Extension failed');
          finishRun(true);
        }
        return;
      }
      let payloadObject = null;
      try {
        payloadObject = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      if (payloadObject && payloadObject.error) {
        toast(payloadObject.error, 'error');
        setStatus('error', 'Extension failed');
        finishRun(true);
        return;
      }
      const choice = payloadObject && payloadObject.choices ? payloadObject.choices[0] : null;
      const delta = choice && choice.delta ? choice.delta : null;
      if (delta && delta.content) {
        handleDelta(delta.content);
      }
      if (choice && choice.finish_reason === 'stop') {
        if (!tryFinalizeSpliceResult(rawEventBuffer)) {
          return;
        }
        finishRun();
      }
    };

    es.onerror = () => {
      if (!isRunning) return;
      setStatus('error', 'Connection error.');
      finishRun(true);
    };
  }

  async function stopConnection() {
    const authHeader = await ensureFunctionKey();
    if (authHeader !== null) {
      await stopVideoTask(currentTaskId, authHeader);
    }
    closeSource();
    isRunning = false;
    currentTaskId = '';
    stopElapsedTimer();
    setButtons(false);
    setSpliceButtonState('idle');
    syncTimelineAvailability();
    setStatus('', tSafe('common.notConnected', '未连接'));
  }

  function finishRun(hasError) {
    if (!isRunning) return;
    closeSource();
    isRunning = false;
    setButtons(false);
    setSpliceButtonState('idle');
    syncTimelineAvailability();
    stopElapsedTimer();
    if (!hasError) {
      setStatus('connected', currentRunKind === 'splice' ? '延长完成' : tSafe('common.done', '已完成'));
      setIndeterminate(false);
      updateProgress(100);
    } else if (currentRunKind === 'splice') {
      setStatus('error', '延长失败');
    }
    if (durationValue && startAt) {
      const seconds = Math.max(0, Math.round((Date.now() - startAt) / 1000));
      durationValue.textContent = tSafe('video.elapsedTime', `耗时 ${seconds}s`, { sec: seconds });
    }
  }

  if (startBtn) {
    startBtn.addEventListener('click', () => startConnection());
  }

  if (stopBtn) {
    stopBtn.addEventListener('click', () => stopConnection());
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (isRunning) {
        toast('请先停止当前任务，再清空工作区。', 'warning');
        return;
      }
      closeSource();
      currentTaskId = '';
      currentRunKind = 'generate';
      startAt = 0;
      progressBuffer = '';
      contentBuffer = '';
      collectingContent = false;
      currentPreviewItem = null;
      updateProgress(0);
      setIndeterminate(false);
      /*
      if (durationValue) {
        durationValue.textContent = tSafe('video.elapsedTimeNone', '鑰楁椂 -');
      }
      setStatus('', tSafe('common.notConnected', '鏈繛鎺?));
      */
      if (durationValue) {
        durationValue.textContent = tSafe('video.elapsedTimeNone', '耗时 -');
      }
      setStatus('', tSafe('common.notConnected', '未连接'));
      resetWorkspaceVideo();
      revokeWorkVideoObjectUrl();
      if (workVideoFileInput) {
        workVideoFileInput.value = '';
      }
    });
  }

  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener('click', () => {
      if (isRunning) {
        toast('请先停止当前任务，再清空历史视频。', 'warning');
        return;
      }
      revokeAllBlobCache();
      lastRenderedVideoUrl = '';
      currentPreviewItem = null;
      previewCount = 0;
      generatedCount = 0;
      extendedCount = 0;
      if (videoStage) {
        videoStage.innerHTML = '';
        videoStage.classList.add('hidden');
      }
      if (videoEmpty) {
        videoEmpty.classList.remove('hidden');
      }
      updateHistoryCount();
      refreshVideoSelectionUi();
    });
  }

  if (pickCachedVideoBtn) {
    pickCachedVideoBtn.addEventListener('click', async () => {
      if (!cacheVideoList) return;
      openCacheVideoModal();
      cacheVideoList.innerHTML = '<div class="video-empty">正在读取缓存视频...</div>';
      try {
        const items = await loadCachedVideos();
        renderCachedVideoList(items);
      } catch (e) {
        cacheVideoList.innerHTML = '<div class="video-empty">读取缓存视频失败，请稍后重试。</div>';
        toast('读取缓存视频失败。', 'error');
      }
    });
  }

  if (closeCacheVideoModalBtn) {
    closeCacheVideoModalBtn.addEventListener('click', () => {
      closeCacheVideoModal();
    });
  }

  if (cacheVideoModal) {
    cacheVideoModal.addEventListener('click', (event) => {
      if (event.target === cacheVideoModal) {
        closeCacheVideoModal();
      }
    });
  }

  if (cacheVideoList) {
    cacheVideoList.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const row = target.closest('.cache-video-item');
      if (!row) return;
      useCachedVideo(
        row.getAttribute('data-url') || '',
        row.getAttribute('data-name') || '',
        row.getAttribute('data-post-id') || '',
        row.getAttribute('data-root-attachment-id') || '',
      );
    });
  }

  if (uploadWorkVideoBtn && workVideoFileInput) {
    uploadWorkVideoBtn.addEventListener('click', () => {
      workVideoFileInput.click();
    });
    workVideoFileInput.addEventListener('change', () => {
      const file = workVideoFileInput.files && workVideoFileInput.files[0];
      if (!file) return;
      revokeWorkVideoObjectUrl();
      workVideoObjectUrl = URL.createObjectURL(file);
      selectedVideoItemId = `upload-${Date.now()}`;
      refreshVideoSelectionUi();
      applyWorkspaceVideo(workVideoObjectUrl, {
        name: file.name,
        extendPostId: '',
        rootAttachmentId: '',
        label: file.name
      });
      toast('已将本地视频载入工作区。', 'success');
    });
  }

  if (videoStage) {
    videoStage.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const item = target.closest('.video-item');
      if (!item) return;
      if (target.classList.contains('video-download')) {
        event.preventDefault();
        const url = item.dataset.url || target.dataset.url || '';
        const index = item.dataset.index || '';
        if (!url) return;
        // 防连击：立刻禁用并切换状态
        target.disabled = true;
        const originalText = target.textContent;
        target.textContent = '准备中...';
        try {
          // 优先使用已有的 Blob 缓存，避免重复网络请求
          let downloadBlobUrl = getBlobUrlSync(url);
          if (!downloadBlobUrl) {
            downloadBlobUrl = await loadVideoToBlob(url);
          }
          const anchor = document.createElement('a');
          const postId = extractPostIdFromFileName(url);
          const parts = ['grok_video'];
          if (postId) {
            parts.push(postId);
          }
          if (index) {
            parts.push(index);
          }
          anchor.href = downloadBlobUrl;
          anchor.download = `${parts.join('_')}.mp4`;
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          // 不 revoke Blob URL：它被多路复用中
          target.textContent = '\u2714 已下载';
          setTimeout(() => {
            target.textContent = originalText;
            target.disabled = false;
          }, 1500);
        } catch (e) {
          toast(tSafe('video.downloadFailed', '下载失败。'), 'error');
          target.textContent = originalText;
          target.disabled = false;
        }
        return;
      }
      if (target.classList.contains('video-open')) return;
      if (target.closest('video')) return;
      selectHistoryItem(item);
    });
  }

  if (imageFileInput) {
    imageFileInput.addEventListener('change', () => {
      queueReferenceFiles(imageFileInput.files);
    });
  }

  if (selectImageFileBtn && imageFileInput) {
    selectImageFileBtn.addEventListener('click', () => {
      imageFileInput.click();
    });
  }

  if (referenceList) {
    referenceList.addEventListener('click', (event) => {
      const target = event.target;
      const referenceId = (window.VideoReferenceCache && typeof VideoReferenceCache.extractReferenceRemoveId === 'function')
        ? VideoReferenceCache.extractReferenceRemoveId(target)
        : (
            target && typeof target.closest === 'function'
              ? String((target.closest('[data-reference-remove]')?.getAttribute('data-reference-remove')) || '')
              : ''
          );
      if (!referenceId) return;
      removeReferenceItem(referenceId);
    });
  }

  if (promptInput) {
    promptInput.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        startConnection();
      }
    });
  }

  if (ratioSelect) {
    ratioSelect.addEventListener('change', () => {
      updateMeta();
    });
  }

  if (lengthSelect) {
    const syncLengthMeta = () => {
      getRequestedVideoLength();
      updateMeta();
    };
    lengthSelect.addEventListener('input', syncLengthMeta);
    lengthSelect.addEventListener('change', syncLengthMeta);
  }

  if (resolutionSelect) {
    resolutionSelect.addEventListener('change', () => {
      updateMeta();
    });
  }

  if (presetSelect) {
    presetSelect.addEventListener('change', () => {
      updateMeta();
    });
  }

  if (editTimeline) {
    editTimeline.addEventListener('input', () => {
      if (!editVideo) return;
      const duration = Number(editVideo.duration || 0);
      if (!Number.isFinite(duration) || duration <= 0) return;
      const ratio = Number(editTimeline.value || 0) / EDIT_TIMELINE_MAX;
      const nextTime = duration * ratio;
      editVideo.currentTime = nextTime;
      updateDeleteZoneTrack(editTimeline);
      lockFrameByCurrentTime();
    });
    updateDeleteZoneTrack(editTimeline);
  }

  if (editVideo) {
    editVideo.addEventListener('loadedmetadata', () => {
      const duration = Number(editVideo.duration || 0);
      if (editDurationText) {
        editDurationText.textContent = duration > 0 ? `总时长 ${formatMs(duration * 1000)}` : '总时长 -';
      }
      lockedFrameIndex = 0;
      lockedTimestampMs = 0;
      updateTimelineByVideoTime();
      setEditMeta();
    });
    editVideo.addEventListener('timeupdate', () => {
      updateTimelineByVideoTime();
      lockFrameByCurrentTime();
    });
    editVideo.addEventListener('seeked', () => {
      updateTimelineByVideoTime();
      lockFrameByCurrentTime();
    });
  }

  if (spliceBtn) {
    spliceBtn.addEventListener('click', () => {
      runExtendVideo();
    });
  }

  if (upscaleBtn) {
    upscaleBtn.addEventListener('click', () => {
      runUpscaleSelectedVideo();
    });
  }

  updateMeta();
  updateHistoryCount();
  setSpliceButtonState('idle');
  setEditMeta();
  updateCurrentVideoLabel('-');
  ensurePromptRichEditor();
  renderReferenceItems();
  syncTimelineAvailability();
})();
