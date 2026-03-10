(() => {
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const clearBtn = document.getElementById('clearBtn');
  const promptInput = document.getElementById('promptInput');
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
  const editVideo = document.getElementById('editVideo');
  const editTimeline = document.getElementById('editTimeline');
  const editTimeText = document.getElementById('editTimeText');
  const editDurationText = document.getElementById('editDurationText');
  const editFrameIndex = document.getElementById('editFrameIndex');
  const editTimestampMs = document.getElementById('editTimestampMs');
  const editExtendPostId = document.getElementById('editExtendPostId');
  const editPromptInput = document.getElementById('editPromptInput');
  const spliceBtn = document.getElementById('spliceBtn');

  let currentSource = null;
  let currentTaskId = '';
  let currentRunKind = 'generate';
  let isRunning = false;
  let progressBuffer = '';
  let contentBuffer = '';
  let collectingContent = false;
  let startAt = 0;
  let selectedFile = null;
  let elapsedTimer = null;
  let lastProgress = 0;
  let currentPreviewItem = null;
  let previewCount = 0;
  let generatedCount = 0;
  let extendedCount = 0;
  let selectedVideoItemId = '';
  let selectedVideoUrl = '';
  let lockedFrameIndex = -1;
  let lockedTimestampMs = 0;
  let currentExtendPostId = '';
  let originalFileAttachmentId = '';
  let workVideoObjectUrl = '';
  const DEFAULT_REASONING_EFFORT = 'low';
  const EDIT_TIMELINE_MAX = 100000;
  const DEFAULT_EXTEND_SECONDS = 10;
  const MAX_EXTENSION_START_SECONDS = 20;
  const TAIL_FRAME_GUARD_MS = 80;
  const APPROX_VIDEO_FPS = 30;
  const referenceUploadCache = (window.VideoReferenceCache && typeof VideoReferenceCache.createReferenceUploadCache === 'function')
    ? VideoReferenceCache.createReferenceUploadCache()
    : {
        reset() {},
        peek() { return ''; },
        async getOrUpload(file, uploadFn) {
          return uploadFn(file);
        }
      };

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
    const raw = String(name || '').trim();
    if (!raw) return '';
    const generatedMatch = raw.match(/generated-([0-9a-fA-F-]{32,36})-/);
    if (generatedMatch && generatedMatch[1]) {
      return generatedMatch[1];
    }
    const allMatches = raw.match(/[0-9a-fA-F-]{32,36}/g);
    return allMatches && allMatches.length ? allMatches[allMatches.length - 1] : '';
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
      startBtn.disabled = false;
    }
  }

  function setSpliceButtonState(state) {
    if (!spliceBtn) return;
    const label = spliceBtn.querySelector('span');
    if (label) {
      if (state === 'running') {
        label.textContent = 'Stop Extend';
      } else if (state === 'stopping') {
        label.textContent = 'Stopping...';
      } else {
        label.textContent = 'Extend Video';
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

  function updateMeta() {
    if (aspectValue && ratioSelect) {
      aspectValue.textContent = ratioSelect.value;
    }
    if (lengthValue && lengthSelect) {
      lengthValue.textContent = `${lengthSelect.value}s`;
    }
    if (resolutionValue && resolutionSelect) {
      resolutionValue.textContent = resolutionSelect.value;
    }
    if (presetValue && presetSelect) {
      presetValue.textContent = presetSelect.value;
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
    if (!editTimeline) return;
    const disabled = !selectedVideoUrl || (isRunning && currentRunKind === 'splice');
    editTimeline.disabled = disabled;
    editTimeline.classList.toggle('is-disabled', disabled);
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
      durationValue.textContent = tSafe('video.elapsedTimeNone', 'Elapsed -');
    }
    updateHistoryCount();
    refreshVideoSelectionUi();
  }

  function nextHistoryTitle(kind) {
    if (kind === 'splice') {
      extendedCount += 1;
      return `Extended Video ${extendedCount}`;
    }
    generatedCount += 1;
    return tSafe('video.videoTitle', `Generated Video ${generatedCount}`, { n: generatedCount });
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
    openBtn.textContent = t('video.open');

    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'geist-button-outline text-xs px-3 video-download';
    downloadBtn.type = 'button';
    downloadBtn.textContent = t('imagine.download');
    downloadBtn.disabled = true;

    actions.appendChild(openBtn);
    actions.appendChild(downloadBtn);
    header.appendChild(title);
    header.appendChild(actions);

    const body = document.createElement('div');
    body.className = 'video-item-body';
    body.innerHTML = '<div class="video-item-placeholder">' + t('video.generatingPlaceholder') + '</div>';

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
    const postId = extractPostIdFromFileName(safeUrl || opts.name || '');
    const rootAttachmentId = String(opts.rootAttachmentId ?? item.dataset.rootAttachmentId ?? '').trim();
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
      durationValue.textContent = tSafe('video.elapsedTime', `Elapsed ${seconds}s`, { sec: seconds });
    }, 1000);
  }

  function stopElapsedTimer() {
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  }

  function clearFileSelection() {
    selectedFile = null;
    referenceUploadCache.reset();
    if (imageFileInput) {
      imageFileInput.value = '';
    }
    if (imageFileName) {
      imageFileName.textContent = tSafe('common.noFileSelected', 'No file selected');
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
      editDurationText.textContent = 'Duration -';
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
    selectedVideoUrl = safeUrl;
    currentExtendPostId = postId;
    if (Object.prototype.hasOwnProperty.call(opts, 'rootAttachmentId')) {
      originalFileAttachmentId = rootAttachmentId || postId || '';
    } else if (postId && !originalFileAttachmentId) {
      originalFileAttachmentId = postId;
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
        editVideo.src = safeUrl;
      } else {
        editVideo.removeAttribute('src');
      }
      editVideo.load();
    }
    lockedFrameIndex = -1;
    lockedTimestampMs = 0;
    setEditMeta();
    syncTimelineAvailability();
  }

  function selectHistoryItem(item) {
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
    });
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
    if (selectedFile && rawUrl) {
      toast(t('video.referenceConflict'), 'error');
      throw new Error('invalid_reference');
    }
    if (selectedFile) {
      return referenceUploadCache.getOrUpload(selectedFile, (file) => uploadReferenceImage(authHeader, file));
    }
    referenceUploadCache.reset();
    return rawUrl || '';
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

  async function loadCachedVideos() {
    const authHeader = await ensureFunctionKey();
    if (authHeader === null) {
      toast(tSafe('common.configurePublicKey', 'Please configure Function Key first.'), 'error');
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
      cacheVideoList.innerHTML = '<div class="video-empty">No cached videos found.</div>';
      return;
    }
    const html = items.map((item, idx) => {
      const name = String(item.name || '');
      const url = String(item.view_url || '');
      const size = formatBytes(item.size_bytes);
      const mtime = formatMtime(item.mtime_ms);
      return `<div class="cache-video-item" data-url="${escapeHtml(url)}" data-name="${escapeHtml(name)}">
        <div class="cache-video-thumb-wrap">
          <video class="cache-video-thumb" src="${escapeHtml(url)}" preload="metadata" muted playsinline></video>
        </div>
        <div class="cache-video-meta">
          <div class="cache-video-name">${escapeHtml(name || `video_${idx + 1}.mp4`)}</div>
          <div class="cache-video-sub">${escapeHtml(size)} · ${escapeHtml(mtime)}</div>
        </div>
        <button class="geist-button-outline text-xs px-3 cache-video-use" type="button">Use</button>
      </div>`;
    }).join('');
    cacheVideoList.innerHTML = html;
  }

  function useCachedVideo(url, name) {
    const safeUrl = String(url || '').trim();
    if (!safeUrl) return;
    const postId = extractPostIdFromFileName(String(name || '')) || extractPostIdFromFileName(safeUrl);
    selectedVideoItemId = `cache-${Date.now()}`;
    refreshVideoSelectionUi();
    applyWorkspaceVideo(safeUrl, {
      name,
      extendPostId: postId,
      rootAttachmentId: postId || '',
      label: basename(name) || basename(safeUrl)
    });
    closeCacheVideoModal();
    toast('Cached video loaded into workspace.', 'success');
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

  function renderVideoFromHtml(html, options) {
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
      } else if (videoEl.getAttribute('src')) {
        videoUrl = videoEl.getAttribute('src');
      }
    }
    updateItemLinks(container, videoUrl, options);
    if (videoUrl) {
      selectHistoryItem(container);
    }
  }

  function renderVideoFromUrl(url, options) {
    const container = ensurePreviewSlot(currentRunKind);
    if (!container) return;
    const safeUrl = url || '';
    const body = container.querySelector('.video-item-body');
    if (!body) return;
    body.innerHTML = `\n      <video controls preload="metadata">\n        <source src="${safeUrl}" type="video/mp4">\n      </video>\n    `;
    updateItemLinks(container, safeUrl, options);
    if (safeUrl) {
      selectHistoryItem(container);
    }
  }

  function getSafeEditMaxTimestampMs() {
    if (!editVideo) return MAX_EXTENSION_START_SECONDS * 1000;
    const durationMs = Math.floor(Math.max(0, Number(editVideo.duration || 0) * 1000));
    if (!durationMs) return MAX_EXTENSION_START_SECONDS * 1000;
    return Math.max(0, Math.min(durationMs - TAIL_FRAME_GUARD_MS, MAX_EXTENSION_START_SECONDS * 1000));
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
      let label = formatMs(lockedTimestampMs);
      if (lockedTimestampMs >= MAX_EXTENSION_START_SECONDS * 1000 && duration > MAX_EXTENSION_START_SECONDS) {
        label += ' (20s max)';
      }
      editTimeText.textContent = label;
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
      let label = formatMs(lockedTimestampMs);
      if (lockedTimestampMs >= MAX_EXTENSION_START_SECONDS * 1000 && Number(editVideo.duration || 0) > MAX_EXTENSION_START_SECONDS) {
        label += ' (20s max)';
      }
      editTimeText.textContent = label;
    }
  }

  function handleDelta(text) {
    if (!text) return;
    if (text.includes('<think>') || text.includes('</think>')) {
      return;
    }
    if (text.includes('超分辨率') || text.includes('super resolution')) {
      setStatus('connecting', tSafe('video.superResolutionInProgress', 'Super resolution'));
      setIndeterminate(true);
      if (progressText) {
        progressText.textContent = tSafe('video.superResolutionInProgress', 'Super resolution');
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
          renderVideoFromHtml(info.html, {
            rootAttachmentId: currentRunKind === 'splice'
              ? (originalFileAttachmentId || currentExtendPostId)
              : undefined
          });
        } else if (info.url) {
          renderVideoFromUrl(info.url, {
            rootAttachmentId: currentRunKind === 'splice'
              ? (originalFileAttachmentId || currentExtendPostId)
              : undefined
          });
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

  async function startConnection() {
    if (isRunning) {
      toast(tSafe('video.alreadyGenerating', 'A task is already running.'), 'warning');
      return;
    }

    const authHeader = await ensureFunctionKey();
    if (authHeader === null) {
      toast(tSafe('common.configurePublicKey', 'Please configure Function Key first.'), 'error');
      window.location.href = '/login';
      return;
    }

    const prompt = promptInput ? promptInput.value.trim() : '';
    let imageUrl = '';
    try {
      imageUrl = await resolveReferenceImage(authHeader);
    } catch (e) {
      return;
    }
    if (!prompt && !imageUrl) {
      toast(tSafe('common.enterPrompt', 'Enter a prompt or provide a reference image.'), 'error');
      return;
    }

    isRunning = true;
    currentRunKind = 'generate';
    startBtn.disabled = true;
    updateMeta();
    resetOutput(true);
    initPreviewSlot(currentRunKind);
    setStatus('connecting', tSafe('common.connecting', 'Connecting'));

    const payload = (window.FunctionPayloads && typeof FunctionPayloads.buildVideoStartPayload === 'function')
      ? FunctionPayloads.buildVideoStartPayload({
          prompt,
          aspectRatio: ratioSelect ? ratioSelect.value : '3:2',
          videoLength: lengthSelect ? parseInt(lengthSelect.value, 10) : 6,
          resolutionName: resolutionSelect ? resolutionSelect.value : '480p',
          preset: presetSelect ? presetSelect.value : 'normal',
          reasoningEffort: DEFAULT_REASONING_EFFORT,
          referenceUrl: imageUrl
        })
      : {
          prompt,
          image_reference: imageUrl ? { image_url: imageUrl } : undefined,
          reasoning_effort: DEFAULT_REASONING_EFFORT,
          aspect_ratio: ratioSelect ? ratioSelect.value : '3:2',
          video_length: lengthSelect ? parseInt(lengthSelect.value, 10) : 6,
          resolution_name: resolutionSelect ? resolutionSelect.value : '480p',
          preset: presetSelect ? presetSelect.value : 'normal'
        };

    let taskId = '';
    try {
      taskId = await createVideoTask(authHeader, payload);
    } catch (e) {
      setStatus('error', tSafe('common.createTaskFailed', 'Create task failed'));
      startBtn.disabled = false;
      isRunning = false;
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
      let payload = null;
      try {
        payload = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      if (payload && payload.error) {
        toast(payload.error, 'error');
        setStatus('error', tSafe('common.generationFailed', 'Generation failed'));
        finishRun(true);
        return;
      }
      const choice = payload.choices && payload.choices[0];
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
      setStatus('error', tSafe('common.connectionError', 'Connection error'));
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
      toast(tSafe('video.alreadyGenerating', 'A task is already running.'), 'warning');
      return;
    }
    if (!selectedVideoUrl) {
      toast('Select a video before extending.', 'error');
      return;
    }
    if (!currentExtendPostId) {
      toast('Current video has no extend_post_id. Select a generated or cached video.', 'error');
      return;
    }

    const authHeader = await ensureFunctionKey();
    if (authHeader === null) {
      toast(tSafe('common.configurePublicKey', 'Please configure Function Key first.'), 'error');
      window.location.href = '/login';
      return;
    }

    const prompt = editPromptInput ? editPromptInput.value.trim() : '';
    const payload = (window.FunctionPayloads && typeof FunctionPayloads.buildVideoStartPayload === 'function')
      ? FunctionPayloads.buildVideoStartPayload({
          prompt,
          aspectRatio: ratioSelect ? ratioSelect.value : '3:2',
          videoLength: DEFAULT_EXTEND_SECONDS,
          resolutionName: resolutionSelect ? resolutionSelect.value : '480p',
          preset: prompt ? (presetSelect ? presetSelect.value : 'normal') : 'spicy',
          reasoningEffort: DEFAULT_REASONING_EFFORT,
          extension: {
            extendPostId: currentExtendPostId,
            startTime: Math.max(0, lockedTimestampMs / 1000),
            originalPostId: currentExtendPostId,
            fileAttachmentId: originalFileAttachmentId || currentExtendPostId,
            stitchWithExtend: true
          }
        })
      : {
          prompt,
          reasoning_effort: DEFAULT_REASONING_EFFORT,
          aspect_ratio: ratioSelect ? ratioSelect.value : '3:2',
          video_length: DEFAULT_EXTEND_SECONDS,
          resolution_name: resolutionSelect ? resolutionSelect.value : '480p',
          preset: prompt ? (presetSelect ? presetSelect.value : 'normal') : 'spicy',
          is_video_extension: true,
          extend_post_id: currentExtendPostId,
          video_extension_start_time: Math.max(0, lockedTimestampMs / 1000),
          original_post_id: currentExtendPostId,
          file_attachment_id: originalFileAttachmentId || currentExtendPostId,
          stitch_with_extend: true
        };

    isRunning = true;
    currentRunKind = 'splice';
    startBtn.disabled = true;
    updateMeta();
    resetOutput(true);
    initPreviewSlot(currentRunKind);
    setSpliceButtonState('running');
    setStatus('connecting', 'Preparing extend task');

    let taskId = '';
    try {
      taskId = await createVideoTask(authHeader, payload);
    } catch (e) {
      setStatus('error', tSafe('common.createTaskFailed', 'Create task failed'));
      startBtn.disabled = false;
      isRunning = false;
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

    es.onopen = () => {
      setStatus('connected', 'Extending');
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
        setStatus('error', 'Extend failed');
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
      setStatus('error', 'Connection error');
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
    setStatus('', tSafe('common.notConnected', 'Disconnected'));
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
      setStatus('connected', currentRunKind === 'splice' ? 'Extend complete' : tSafe('common.done', 'Done'));
      setIndeterminate(false);
      updateProgress(100);
    } else if (currentRunKind === 'splice') {
      setStatus('error', 'Extend failed');
    }
    if (durationValue && startAt) {
      const seconds = Math.max(0, Math.round((Date.now() - startAt) / 1000));
      durationValue.textContent = tSafe('video.elapsedTime', `Elapsed ${seconds}s`, { sec: seconds });
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
        toast('Stop the current task before clearing.', 'warning');
        return;
      }
      resetOutput();
      resetWorkspaceVideo();
      revokeWorkVideoObjectUrl();
      if (workVideoFileInput) {
        workVideoFileInput.value = '';
      }
    });
  }

  if (pickCachedVideoBtn) {
    pickCachedVideoBtn.addEventListener('click', async () => {
      if (!cacheVideoList) return;
      openCacheVideoModal();
      cacheVideoList.innerHTML = '<div class="video-empty">Loading cached videos...</div>';
      try {
        const items = await loadCachedVideos();
        renderCachedVideoList(items);
      } catch (e) {
        cacheVideoList.innerHTML = '<div class="video-empty">Failed to load cached videos.</div>';
        toast('Failed to load cached videos.', 'error');
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
      useCachedVideo(row.getAttribute('data-url') || '', row.getAttribute('data-name') || '');
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
      toast('Local video loaded into workspace.', 'success');
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
        try {
          const response = await fetch(url);
          if (!response.ok) {
            throw new Error('download_failed');
          }
          const blob = await response.blob();
          const blobUrl = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          const postId = extractPostIdFromFileName(url);
          const parts = ['grok_video'];
          if (postId) {
            parts.push(postId);
          }
          if (index) {
            parts.push(index);
          }
          anchor.href = blobUrl;
          anchor.download = `${parts.join('_')}.mp4`;
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          URL.revokeObjectURL(blobUrl);
        } catch (e) {
          toast(tSafe('video.downloadFailed', 'Download failed.'), 'error');
        }
        return;
      }
      if (target.classList.contains('video-open')) return;
      selectHistoryItem(item);
    });
  }

  if (imageFileInput) {
    imageFileInput.addEventListener('change', () => {
      const file = imageFileInput.files && imageFileInput.files[0];
      if (!file) {
        clearFileSelection();
        return;
      }
      if (imageUrlInput && imageUrlInput.value.trim()) {
        imageUrlInput.value = '';
      }
      selectedFile = file;
      if (!referenceUploadCache.peek(file)) {
        referenceUploadCache.reset();
      }
      if (imageFileName) {
        imageFileName.textContent = file.name;
      }
    });
  }

  if (selectImageFileBtn && imageFileInput) {
    selectImageFileBtn.addEventListener('click', () => {
      imageFileInput.click();
    });
  }

  if (clearImageFileBtn) {
    clearImageFileBtn.addEventListener('click', () => {
      clearFileSelection();
    });
  }

  if (imageUrlInput) {
    imageUrlInput.addEventListener('input', () => {
      if (imageUrlInput.value.trim() && selectedFile) {
        clearFileSelection();
        return;
      }
      if (imageUrlInput.value.trim()) {
        referenceUploadCache.reset();
      }
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

  if (editTimeline) {
    editTimeline.addEventListener('input', () => {
      if (!editVideo) return;
      const duration = Number(editVideo.duration || 0);
      if (!Number.isFinite(duration) || duration <= 0) return;
      const ratio = Number(editTimeline.value || 0) / EDIT_TIMELINE_MAX;
      const nextTime = Math.min(duration * ratio, MAX_EXTENSION_START_SECONDS);
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
        editDurationText.textContent = duration > 0 ? `Duration ${formatMs(duration * 1000)}` : 'Duration -';
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

  updateMeta();
  updateHistoryCount();
  setSpliceButtonState('idle');
  setEditMeta();
  updateCurrentVideoLabel('-');
  syncTimelineAvailability();
})();
