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
  const nSelect = document.getElementById('nSelect');
  const infiniteModeToggle = document.getElementById('infiniteModeToggle');
  const autoScrollToggle = document.getElementById('autoScrollToggle');
  const autoDownloadToggle = document.getElementById('autoDownloadToggle');
  const reverseInsertToggle = document.getElementById('reverseInsertToggle');
  const autoFilterToggle = document.getElementById('autoFilterToggle');
  const nsfwSelect = document.getElementById('nsfwSelect');
  const selectFolderBtn = document.getElementById('selectFolderBtn');
  const folderPath = document.getElementById('folderPath');
  const statusText = document.getElementById('statusText');
  const countValue = document.getElementById('countValue');
  const activeValue = document.getElementById('activeValue');
  const latencyValue = document.getElementById('latencyValue');
  const modeButtons = document.querySelectorAll('.mode-btn');
  const waterfall = document.getElementById('waterfall');
  const emptyState = document.getElementById('emptyState');
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightboxImg');
  const closeLightbox = document.getElementById('closeLightbox');

  let wsConnections = [];
  let sseConnections = [];
  let imageCount = 0;
  let totalLatency = 0;
  let latencyCount = 0;
  let lastRunId = '';
  let isRunning = false;
  let isStopping = false;
  let connectionMode = 'ws';
  let modePreference = 'auto';
  const MODE_STORAGE_KEY = 'imagine_mode';
  let pendingFallbackTimer = null;
  let currentTaskIds = [];
  let currentReferenceUrls = [];
  let referenceItems = [];
  let referenceUploadSeq = 0;
  let directoryHandle = null;
  let selectedReferenceFile = null;
  let useFileSystemAPI = false;
  let isSelectionMode = false;
  let selectedImages = new Set();
  let streamSequence = 0;
  const streamImageMap = new Map();
  let finalMinBytesDefault = 100000;
  const MAX_REFERENCE_FILES = 3;
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

  function setStatus(state, text) {
    if (!statusText) return;
    statusText.textContent = text || t('common.notConnected');
    statusText.classList.remove('connected', 'connecting', 'error');
    if (state) {
      statusText.classList.add(state);
    }
  }

  function setButtons(connected) {
    if (!startBtn || !stopBtn) return;
    if (connected) {
      startBtn.classList.add('hidden');
      stopBtn.classList.remove('hidden');
    } else {
      startBtn.classList.remove('hidden');
      stopBtn.classList.add('hidden');
      syncStartButtonAvailability();
    }
  }

  function updateCount(value) {
    if (countValue) {
      countValue.textContent = String(value);
    }
  }

  function updateActive() {
    if (!activeValue) return;
    if (connectionMode === 'sse') {
      const active = sseConnections.filter(es => es && es.readyState === EventSource.OPEN).length;
      activeValue.textContent = String(active);
      return;
    }
    const active = wsConnections.filter(ws => ws && ws.readyState === WebSocket.OPEN).length;
    activeValue.textContent = String(active);
  }

  function setModePreference(mode, persist = true) {
    if (!['auto', 'ws', 'sse'].includes(mode)) return;
    modePreference = mode;
    modeButtons.forEach(btn => {
      if (btn.dataset.mode === mode) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
    if (persist) {
      try {
        localStorage.setItem(MODE_STORAGE_KEY, mode);
      } catch (e) {
        // ignore
      }
    }
    updateModeValue();
  }

  function updateModeValue() {}

  async function loadFilterDefaults() {
    try {
      const res = await fetch('/v1/function/imagine/config', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const value = parseInt(data && data.final_min_bytes, 10);
      if (Number.isFinite(value) && value >= 0) {
        finalMinBytesDefault = value;
      }
      if (nsfwSelect && typeof data.nsfw === 'boolean') {
        nsfwSelect.value = data.nsfw ? 'true' : 'false';
      }
    } catch (e) {
      // ignore
    }
  }


  function updateLatency(value) {
    if (value) {
      totalLatency += value;
      latencyCount += 1;
      const avg = Math.round(totalLatency / latencyCount);
      if (latencyValue) {
        latencyValue.textContent = `${avg} ms`;
      }
    } else {
      if (latencyValue) {
        latencyValue.textContent = '-';
      }
    }
  }

  function updateError(value) {}

  function setImageStatus(item, state, label) {
    if (!item) return;
    const statusEl = item.querySelector('.image-status');
    if (!statusEl) return;
    statusEl.textContent = label;
    statusEl.classList.remove('running', 'done', 'error');
    if (state) {
      statusEl.classList.add(state);
    }
  }

  function isLikelyBase64(raw) {
    if (!raw) return false;
    if (raw.startsWith('data:')) return true;
    if (raw.startsWith('http://') || raw.startsWith('https://')) return false;
    const head = raw.slice(0, 16);
    if (head.startsWith('/9j/') || head.startsWith('iVBOR') || head.startsWith('R0lGOD')) return true;
    return /^[A-Za-z0-9+/=\s]+$/.test(raw);
  }

  function inferMime(base64) {
    if (!base64) return 'image/jpeg';
    if (base64.startsWith('iVBOR')) return 'image/png';
    if (base64.startsWith('/9j/')) return 'image/jpeg';
    if (base64.startsWith('R0lGOD')) return 'image/gif';
    return 'image/jpeg';
  }

  function estimateBase64Bytes(raw) {
    if (!raw) return null;
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      return null;
    }
    if (raw.startsWith('/') && !isLikelyBase64(raw)) {
      return null;
    }
    let base64 = raw;
    if (raw.startsWith('data:')) {
      const comma = raw.indexOf(',');
      base64 = comma >= 0 ? raw.slice(comma + 1) : '';
    }
    base64 = base64.replace(/\s/g, '');
    if (!base64) return 0;
    let padding = 0;
    if (base64.endsWith('==')) padding = 2;
    else if (base64.endsWith('=')) padding = 1;
    return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
  }

  function getFinalMinBytes() {
    return Number.isFinite(finalMinBytesDefault) && finalMinBytesDefault >= 0 ? finalMinBytesDefault : 100000;
  }

  function dataUrlToBlob(dataUrl) {
    const parts = (dataUrl || '').split(',');
    if (parts.length < 2) return null;
    const header = parts[0];
    const b64 = parts.slice(1).join(',');
    const match = header.match(/data:(.*?);base64/);
    const mime = match ? match[1] : 'application/octet-stream';
    try {
      const byteString = atob(b64);
      const ab = new ArrayBuffer(byteString.length);
      const ia = new Uint8Array(ab);
      for (let i = 0; i < byteString.length; i++) {
        ia[i] = byteString.charCodeAt(i);
      }
      return new Blob([ab], { type: mime });
    } catch (e) {
      return null;
    }
  }

  function clearReferenceSelection() {
    const previousFileName = selectedReferenceFile && selectedReferenceFile.name ? selectedReferenceFile.name : '';
    selectedReferenceFile = null;
    referenceUploadCache.reset();
    if (imageUrlInput && imageUrlInput.value.trim() === previousFileName) {
      imageUrlInput.value = '';
    }
    currentReferenceUrls = [];
    if (imageFileInput) {
      imageFileInput.value = '';
    }
    if (imageFileName) {
      imageFileName.textContent = t('common.noFileSelected');
    }
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
      throw new Error(t('imagine.uploadFailed') || 'Upload failed');
    }
    return url;
  }

  async function resolveReferenceImage(authHeader) {
    const rawUrl = imageUrlInput ? imageUrlInput.value.trim() : '';
    const fileName = selectedReferenceFile && selectedReferenceFile.name ? selectedReferenceFile.name.trim() : '';
    const manualUrl = selectedReferenceFile && rawUrl === fileName ? '' : rawUrl;
    if (selectedReferenceFile && manualUrl) {
      toast(t('imagine.referenceConflict'), 'error');
      throw new Error('invalid_reference');
    }
    if (selectedReferenceFile) {
      return referenceUploadCache.getOrUpload(selectedReferenceFile, (file) => uploadReferenceImage(authHeader, file));
    }
    referenceUploadCache.reset();
    return manualUrl || '';
  }

  function nextReferenceItemId() {
    referenceUploadSeq += 1;
    return `imagine-ref-${Date.now()}-${referenceUploadSeq}`;
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
          : (item.error || tSafe('imagine.uploadFailed', '上传失败'));
        overlay.appendChild(label);
        card.appendChild(overlay);
      }

      const removeBtn = document.createElement('button');
      removeBtn.className = 'reference-card-remove';
      removeBtn.type = 'button';
      removeBtn.setAttribute('aria-label', tSafe('imagine.clearImage', '移除参考图'));
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
          reject(new Error(tSafe('imagine.uploadFailed', '上传失败')));
          return;
        }
        resolve(url);
      };
      xhr.onerror = () => {
        reject(new Error(tSafe('imagine.uploadFailed', '上传失败')));
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
          error: error && error.message ? error.message : tSafe('imagine.uploadFailed', '上传失败'),
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

  async function createImagineTask(prompt, ratio, authHeader, nsfwEnabled, referenceUrls, n, infiniteMode) {
    const payload = (window.FunctionPayloads && typeof FunctionPayloads.buildImagineStartPayload === 'function')
      ? FunctionPayloads.buildImagineStartPayload({
          prompt,
          aspectRatio: ratio,
          nsfw: nsfwEnabled,
          referenceUrl: referenceUrls,
          n,
          infiniteMode
        })
      : {
          prompt,
          aspect_ratio: ratio,
          nsfw: nsfwEnabled,
          n,
          infinite_mode: !!infiniteMode,
          image_reference: buildImageReferencePayload(referenceUrls)
        };
    const res = await fetch('/v1/function/imagine/start', {
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

  async function createImagineTasks(prompt, ratio, n, authHeader, nsfwEnabled, referenceUrls, infiniteMode) {
    const taskId = await createImagineTask(prompt, ratio, authHeader, nsfwEnabled, referenceUrls, n, infiniteMode);
    if (!taskId) {
      throw new Error('Missing task id');
    }
    return [taskId];
  }

  async function stopImagineTasks(taskIds, authHeader) {
    if (!taskIds || taskIds.length === 0) return;
    try {
      await fetch('/v1/function/imagine/stop', {
        method: 'POST',
        headers: {
          ...buildAuthHeaders(authHeader),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ task_ids: taskIds })
      });
    } catch (e) {
      // ignore
    }
  }

  async function saveToFileSystem(base64, filename) {
    try {
      if (!directoryHandle) {
        return false;
      }
      
      const mime = inferMime(base64);
      const ext = mime === 'image/png' ? 'png' : 'jpg';
      const finalFilename = filename.endsWith(`.${ext}`) ? filename : `${filename}.${ext}`;
      
      const fileHandle = await directoryHandle.getFileHandle(finalFilename, { create: true });
      const writable = await fileHandle.createWritable();
      
      // Convert base64 to blob
      const byteString = atob(base64);
      const ab = new ArrayBuffer(byteString.length);
      const ia = new Uint8Array(ab);
      for (let i = 0; i < byteString.length; i++) {
        ia[i] = byteString.charCodeAt(i);
      }
      const blob = new Blob([ab], { type: mime });
      
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (e) {
      console.error('File System API save failed:', e);
      return false;
    }
  }

  function downloadImage(base64, filename) {
    const mime = inferMime(base64);
    const dataUrl = `data:${mime};base64,${base64}`;
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  function appendImage(base64, meta) {
    if (!waterfall) return;
    if (autoFilterToggle && autoFilterToggle.checked) {
      const bytes = estimateBase64Bytes(base64 || '');
      const minBytes = getFinalMinBytes();
      if (bytes !== null && bytes < minBytes) {
        return;
      }
    }
    if (emptyState) {
      emptyState.style.display = 'none';
    }

    const item = document.createElement('div');
    item.className = 'waterfall-item';

    const checkbox = document.createElement('div');
    checkbox.className = 'image-checkbox';

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = meta && meta.sequence ? `image-${meta.sequence}` : 'image';
    const mime = inferMime(base64);
    const dataUrl = `data:${mime};base64,${base64}`;
    img.src = dataUrl;

    const metaBar = document.createElement('div');
    metaBar.className = 'waterfall-meta';
    const left = document.createElement('div');
    left.textContent = meta && meta.sequence ? `#${meta.sequence}` : '#';
    const rightWrap = document.createElement('div');
    rightWrap.className = 'meta-right';
    const status = document.createElement('span');
    status.className = 'image-status done';
    status.textContent = t('common.done');
    const right = document.createElement('span');
    if (meta && meta.elapsed_ms) {
      right.textContent = `${meta.elapsed_ms}ms`;
    } else {
      right.textContent = '';
    }

    rightWrap.appendChild(status);
    rightWrap.appendChild(right);
    metaBar.appendChild(left);
    metaBar.appendChild(rightWrap);

    item.appendChild(checkbox);
    item.appendChild(img);
    item.appendChild(metaBar);

    const prompt = (meta && meta.prompt) ? String(meta.prompt) : (promptInput ? promptInput.value.trim() : '');
    item.dataset.imageUrl = dataUrl;
    item.dataset.prompt = prompt || 'image';
    if (isSelectionMode) {
      item.classList.add('selection-mode');
    }

    if (reverseInsertToggle && reverseInsertToggle.checked) {
      waterfall.prepend(item);
    } else {
      waterfall.appendChild(item);
    }

    if (autoScrollToggle && autoScrollToggle.checked) {
      if (reverseInsertToggle && reverseInsertToggle.checked) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      }
    }

    if (autoDownloadToggle && autoDownloadToggle.checked) {
      const timestamp = Date.now();
      const seq = meta && meta.sequence ? meta.sequence : 'unknown';
      const ext = mime === 'image/png' ? 'png' : 'jpg';
      const filename = `imagine_${timestamp}_${seq}.${ext}`;
      
      if (useFileSystemAPI && directoryHandle) {
        saveToFileSystem(base64, filename).catch(() => {
          downloadImage(base64, filename);
        });
      } else {
        downloadImage(base64, filename);
      }
    }
  }

  function upsertStreamImage(raw, meta, imageId, isFinal) {
    if (!waterfall || !raw) return;
    if (emptyState) {
      emptyState.style.display = 'none';
    }

    if (isFinal && autoFilterToggle && autoFilterToggle.checked) {
      const bytes = estimateBase64Bytes(raw);
      const minBytes = getFinalMinBytes();
      if (bytes !== null && bytes < minBytes) {
        const existing = imageId ? streamImageMap.get(imageId) : null;
        if (existing) {
          if (selectedImages.has(existing)) {
            selectedImages.delete(existing);
            updateSelectedCount();
          }
          existing.remove();
          streamImageMap.delete(imageId);
          if (imageCount > 0) {
            imageCount -= 1;
            updateCount(imageCount);
          }
        }
        return;
      }
    }

    const isDataUrl = typeof raw === 'string' && raw.startsWith('data:');
    const looksLikeBase64 = typeof raw === 'string' && isLikelyBase64(raw);
    const isHttpUrl = typeof raw === 'string' && (raw.startsWith('http://') || raw.startsWith('https://') || (raw.startsWith('/') && !looksLikeBase64));
    const mime = isDataUrl || isHttpUrl ? '' : inferMime(raw);
    const dataUrl = isDataUrl || isHttpUrl ? raw : `data:${mime};base64,${raw}`;

    let item = imageId ? streamImageMap.get(imageId) : null;
    let isNew = false;
    if (!item) {
      isNew = true;
      streamSequence += 1;
      const sequence = streamSequence;

      item = document.createElement('div');
      item.className = 'waterfall-item';

      const checkbox = document.createElement('div');
      checkbox.className = 'image-checkbox';

      const img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = imageId ? `image-${imageId}` : 'image';
      img.src = dataUrl;

      const metaBar = document.createElement('div');
      metaBar.className = 'waterfall-meta';
      const left = document.createElement('div');
      left.textContent = `#${sequence}`;
      const rightWrap = document.createElement('div');
      rightWrap.className = 'meta-right';
      const status = document.createElement('span');
      status.className = `image-status ${isFinal ? 'done' : 'running'}`;
      status.textContent = isFinal ? t('common.done') : t('common.generating');
      const right = document.createElement('span');
      right.textContent = '';
      if (meta && meta.elapsed_ms) {
        right.textContent = `${meta.elapsed_ms}ms`;
      }

      rightWrap.appendChild(status);
      rightWrap.appendChild(right);
      metaBar.appendChild(left);
      metaBar.appendChild(rightWrap);

      item.appendChild(checkbox);
      item.appendChild(img);
      item.appendChild(metaBar);

      const prompt = (meta && meta.prompt) ? String(meta.prompt) : (promptInput ? promptInput.value.trim() : '');
      item.dataset.imageUrl = dataUrl;
      item.dataset.prompt = prompt || 'image';

      if (isSelectionMode) {
        item.classList.add('selection-mode');
      }

      if (reverseInsertToggle && reverseInsertToggle.checked) {
        waterfall.prepend(item);
      } else {
        waterfall.appendChild(item);
      }

      if (imageId) {
        streamImageMap.set(imageId, item);
      }

      imageCount += 1;
      updateCount(imageCount);
    } else {
      const img = item.querySelector('img');
      if (img) {
        img.src = dataUrl;
      }
      item.dataset.imageUrl = dataUrl;
      const right = item.querySelector('.waterfall-meta .meta-right span:last-child');
      if (right && meta && meta.elapsed_ms) {
        right.textContent = `${meta.elapsed_ms}ms`;
      }
    }

    setImageStatus(item, isFinal ? 'done' : 'running', isFinal ? t('common.done') : t('common.generating'));
    updateError('');

    if (isNew && autoScrollToggle && autoScrollToggle.checked) {
      if (reverseInsertToggle && reverseInsertToggle.checked) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      }
    }

    if (isFinal && autoDownloadToggle && autoDownloadToggle.checked) {
      const timestamp = Date.now();
      const ext = mime === 'image/png' ? 'png' : 'jpg';
      const filename = `imagine_${timestamp}_${imageId || streamSequence}.${ext}`;

      if (useFileSystemAPI && directoryHandle) {
        saveToFileSystem(raw, filename).catch(() => {
          downloadImage(raw, filename);
        });
      } else {
        downloadImage(raw, filename);
      }
    }
  }

  function handleMessage(raw) {
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (!data || typeof data !== 'object') return;

    if (data.type === 'image_generation.partial_image' || data.type === 'image_generation.completed') {
      const imageId = data.image_id || data.imageId;
      const payload = data.b64_json || data.url || data.image;
      if (!payload || !imageId) {
        return;
      }
      const isFinal = data.type === 'image_generation.completed' || data.stage === 'final';
      upsertStreamImage(payload, data, imageId, isFinal);
    } else if (data.type === 'image') {
      imageCount += 1;
      updateCount(imageCount);
      updateLatency(data.elapsed_ms);
      updateError('');
      appendImage(data.b64_json, data);
    } else if (data.type === 'status') {
      if (data.status === 'running') {
        setStatus('connected', t('common.generating'));
        lastRunId = data.run_id || '';
      } else if (data.status === 'stopped') {
        if (data.run_id && lastRunId && data.run_id !== lastRunId) {
          return;
        }
        setStatus('', t('common.stopped'));
        setButtons(false);
        isRunning = false;
        syncStartButtonAvailability();
        currentTaskIds = [];
        currentReferenceUrls = [];
        updateModeValue();
      }
    } else if (data.type === 'error' || data.error) {
      const message = data.message || (data.error && data.error.message) || t('common.generationFailed');
      const errorImageId = data.image_id || data.imageId;
      if (errorImageId && streamImageMap.has(errorImageId)) {
        setImageStatus(streamImageMap.get(errorImageId), 'error', t('common.failed'));
      }
      updateError(message);
      toast(message, 'error');
    }
  }

  function stopAllConnections() {
    wsConnections.forEach(ws => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'stop' }));
        } catch (e) {
          // ignore
        }
      }
      try {
        ws.close(1000, 'client stop');
      } catch (e) {
        // ignore
      }
    });
    wsConnections = [];

    sseConnections.forEach(es => {
      try {
        es.close();
      } catch (e) {
        // ignore
      }
    });
    sseConnections = [];
    updateActive();
    updateModeValue();
  }

  function normalizeAuthHeader(authHeader) {
    if (!authHeader) return '';
    if (authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7).trim();
    }
    return authHeader;
  }

  function buildSseUrl(taskId, index, rawPublicKey) {
    const httpProtocol = window.location.protocol === 'https:' ? 'https' : 'http';
    const base = `${httpProtocol}://${window.location.host}/v1/function/imagine/sse`;
    const params = new URLSearchParams();
    params.set('task_id', taskId);
    params.set('t', String(Date.now()));
    if (typeof index === 'number') {
      params.set('conn', String(index));
    }
    if (rawPublicKey) {
      params.set('function_key', rawPublicKey);
    }
    return `${base}?${params.toString()}`;
  }

  function startSSE(taskIds, rawPublicKey) {
    connectionMode = 'sse';
    stopAllConnections();
    updateModeValue();

    setStatus('connected', t('imagine.generatingSSE'));
    setButtons(true);
    toast(t('imagine.startedTasksSSE', { count: taskIds.length }), 'success');

    for (let i = 0; i < taskIds.length; i++) {
      const url = buildSseUrl(taskIds[i], i, rawPublicKey);
      const es = new EventSource(url);

      es.onopen = () => {
        updateActive();
      };

      es.onmessage = (event) => {
        handleMessage(event.data);
      };

      es.onerror = () => {
        updateActive();
        if (!isRunning) {
          setButtons(false);
          syncStartButtonAvailability();
          updateModeValue();
          return;
        }
        const remaining = sseConnections.filter(e => e && e.readyState === EventSource.OPEN).length;
        if (remaining === 0) {
          setStatus('error', t('common.connectionError'));
          setButtons(false);
          isRunning = false;
          syncStartButtonAvailability();
          updateModeValue();
        }
      };

      sseConnections.push(es);
    }
  }

  async function startConnection() {
    const prompt = promptInput ? promptInput.value.trim() : '';
    if (!prompt) {
      toast(t('common.enterPrompt'), 'error');
      return;
    }

    const authHeader = await ensureFunctionKey();
    if (authHeader === null) {
      toast(t('common.configurePublicKey'), 'error');
      window.location.href = '/login';
      return;
    }
    const rawPublicKey = normalizeAuthHeader(authHeader);

    const n = nSelect ? (parseInt(nSelect.value, 10) || 4) : 4;
    const ratio = ratioSelect ? ratioSelect.value : '2:3';
    const nsfwEnabled = nsfwSelect ? nsfwSelect.value === 'true' : true;
    const infiniteModeEnabled = infiniteModeToggle ? infiniteModeToggle.checked : false;
    
    if (isRunning) {
      toast(t('common.alreadyRunning'), 'warning');
      return;
    }

    isRunning = true;
    setStatus('connecting', t('common.connecting'));
    syncStartButtonAvailability();

    if (pendingFallbackTimer) {
      clearTimeout(pendingFallbackTimer);
      pendingFallbackTimer = null;
    }

    let taskIds = [];
    let referenceUrls = [];
    try {
      referenceUrls = await resolveReferenceImage();
      currentReferenceUrls = referenceUrls;
      taskIds = await createImagineTasks(prompt, ratio, n, authHeader, nsfwEnabled, referenceUrls, infiniteModeEnabled);
    } catch (e) {
      setStatus('error', t('common.createTaskFailed'));
      isRunning = false;
      syncStartButtonAvailability();
      currentReferenceUrls = [];
      return;
    }
    currentTaskIds = taskIds;

    if (modePreference === 'sse') {
      startSSE(taskIds, rawPublicKey);
      return;
    }

    connectionMode = 'ws';
    stopAllConnections();
    updateModeValue();

    let opened = 0;
    let fallbackDone = false;
    let fallbackTimer = null;
    if (modePreference === 'auto') {
      fallbackTimer = setTimeout(() => {
        if (!fallbackDone && opened === 0) {
          fallbackDone = true;
          startSSE(taskIds, rawPublicKey);
        }
      }, 1500);
    }
    pendingFallbackTimer = fallbackTimer;

    wsConnections = [];

    for (let i = 0; i < taskIds.length; i++) {
      const wsUrl = (window.FunctionTransport && typeof FunctionTransport.buildImagineWsUrl === 'function')
        ? FunctionTransport.buildImagineWsUrl({
            protocol: window.location.protocol,
            host: window.location.host,
            taskId: taskIds[i],
            functionKey: rawPublicKey
          })
        : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/v1/function/imagine/ws?${new URLSearchParams({
            task_id: taskIds[i],
            ...(rawPublicKey ? { function_key: rawPublicKey } : {})
          }).toString()}`;
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        opened += 1;
        updateActive();
        if (i === 0) {
          setStatus('connected', t('common.generating'));
          setButtons(true);
          toast(t('imagine.startedTasks', { count: concurrent }), 'success');
        }
        sendStart(prompt, ws);
      };

      ws.onmessage = (event) => {
        handleMessage(event.data);
      };

      ws.onclose = () => {
        updateActive();
        if (connectionMode !== 'ws') {
          return;
        }
        const remaining = wsConnections.filter(w => w && w.readyState === WebSocket.OPEN).length;
        if (remaining === 0 && !fallbackDone) {
          if (!isRunning) {
            setButtons(false);
            syncStartButtonAvailability();
            updateModeValue();
            return;
          }
          setStatus('', t('common.notConnected'));
          setButtons(false);
          isRunning = false;
          updateModeValue();
        }
      };

      ws.onerror = () => {
        updateActive();
        if (modePreference === 'auto' && opened === 0 && !fallbackDone) {
          fallbackDone = true;
          if (fallbackTimer) {
            clearTimeout(fallbackTimer);
          }
          startSSE(taskIds, rawPublicKey);
          return;
        }
        if (i === 0 && wsConnections.filter(w => w && w.readyState === WebSocket.OPEN).length === 0) {
          setStatus('error', t('common.connectionError'));
          isRunning = false;
          syncStartButtonAvailability();
          updateModeValue();
        }
      };

      wsConnections.push(ws);
    }
  }

  function sendStart(promptOverride, targetWs) {
    const ws = targetWs || wsConnections[0];
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const prompt = promptOverride || (promptInput ? promptInput.value.trim() : '');
    const ratio = ratioSelect ? ratioSelect.value : '2:3';
    const nsfwEnabled = nsfwSelect ? nsfwSelect.value === 'true' : true;
    const nVal = nSelect ? (parseInt(nSelect.value, 10) || 4) : 4;
    const infiniteModeEnabled = infiniteModeToggle ? infiniteModeToggle.checked : false;
    const payload = {
      type: 'start',
      prompt,
      aspect_ratio: ratio,
      nsfw: nsfwEnabled,
      n: nVal,
      infinite_mode: infiniteModeEnabled,
      ...(currentReferenceUrls.length ? { image_reference: buildImageReferencePayload(currentReferenceUrls) } : {})
    };
    ws.send(JSON.stringify(payload));
    updateError('');
  }

  async function stopConnection() {
    if (isStopping) return;
    isStopping = true;

    if (pendingFallbackTimer) {
      clearTimeout(pendingFallbackTimer);
      pendingFallbackTimer = null;
    }

    // 向后端发送停止信号，不立即断开连接
    // 等待所有正在生成的图片通过 onmessage 自然完成
    const authHeader = await ensureFunctionKey();
    if (authHeader !== null && currentTaskIds.length > 0) {
      stopImagineTasks(currentTaskIds, authHeader).catch(() => {});
    }

    // 立即更新 UI 状态，屏蔽后续新消息触发任何新建动作
    setStatus('', t('common.stopped'));
    setButtons(false);

    // 将仍处于 running 的卡片标记为 stopped，避免永久卡圈
    streamImageMap.forEach((item) => {
      const statusEl = item && item.querySelector('.image-status');
      if (statusEl && statusEl.classList.contains('running')) {
        setImageStatus(item, 'error', t('common.stopped'));
      }
    });

    // 稍作等待后再断开连接，给最后几帧数据留出到达时间
    setTimeout(() => {
      stopAllConnections();
      currentTaskIds = [];
      currentReferenceUrls = [];
      isRunning = false;
      isStopping = false;
      updateActive();
      updateModeValue();
    }, 1500);
  }

  function clearImages() {
    if (waterfall) {
      waterfall.innerHTML = '';
    }
    streamImageMap.clear();
    streamSequence = 0;
    imageCount = 0;
    totalLatency = 0;
    latencyCount = 0;
    updateCount(imageCount);
    updateLatency('');
    updateError('');
    if (emptyState) {
      emptyState.style.display = 'block';
    }
  }

  if (startBtn) {
    startBtn.addEventListener('click', () => startConnection());
  }

  if (stopBtn) {
    stopBtn.addEventListener('click', () => {
      stopConnection();
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', () => clearImages());
  }

  if (promptInput) {
    promptInput.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        startConnection();
      }
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

  loadFilterDefaults();

  if (ratioSelect) {
    ratioSelect.addEventListener('change', () => {
      if (isRunning) {
        if (connectionMode === 'sse') {
          stopConnection().then(() => {
            setTimeout(() => startConnection(), 50);
          });
          return;
        }
        wsConnections.forEach(ws => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            sendStart(null, ws);
          }
        });
      }
    });
  }

  if (modeButtons.length > 0) {
    const saved = (() => {
      try {
        return localStorage.getItem(MODE_STORAGE_KEY);
      } catch (e) {
        return null;
      }
    })();
    if (saved) {
      setModePreference(saved, false);
    } else {
      setModePreference('auto', false);
    }

    modeButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        if (!mode) return;
        setModePreference(mode);
        if (isRunning) {
          stopConnection().then(() => {
            setTimeout(() => startConnection(), 50);
          });
        }
      });
    });
  }

  // File System API support check
  if ('showDirectoryPicker' in window) {
    if (selectFolderBtn) {
      selectFolderBtn.disabled = false;
      selectFolderBtn.addEventListener('click', async () => {
        try {
          directoryHandle = await window.showDirectoryPicker({
            mode: 'readwrite'
          });
          useFileSystemAPI = true;
          if (folderPath) {
            folderPath.textContent = directoryHandle.name;
            selectFolderBtn.style.color = '#059669';
          }
          toast(t('imagine.selectFolder', { name: directoryHandle.name }), 'success');
        } catch (e) {
          if (e.name !== 'AbortError') {
            toast(t('imagine.selectFolderFailed'), 'error');
          }
        }
      });
    }
  }

  // Enable/disable folder selection based on auto-download
  if (autoDownloadToggle && selectFolderBtn) {
    autoDownloadToggle.addEventListener('change', () => {
      if (autoDownloadToggle.checked && 'showDirectoryPicker' in window) {
        selectFolderBtn.disabled = false;
      } else {
        selectFolderBtn.disabled = true;
      }
    });
  }

  // Collapsible cards - 点击"连接状态"标题控制所有卡片
  const statusToggle = document.getElementById('statusToggle');

  if (statusToggle) {
    statusToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const cards = document.querySelectorAll('.imagine-card-collapsible');
      const allCollapsed = Array.from(cards).every(card => card.classList.contains('collapsed'));
      
      cards.forEach(card => {
        if (allCollapsed) {
          card.classList.remove('collapsed');
        } else {
          card.classList.add('collapsed');
        }
      });
    });
  }

  // Batch download functionality
  const batchDownloadBtn = document.getElementById('batchDownloadBtn');
  const selectionToolbar = document.getElementById('selectionToolbar');
  const toggleSelectAllBtn = document.getElementById('toggleSelectAllBtn');
  const downloadSelectedBtn = document.getElementById('downloadSelectedBtn');
  
  function enterSelectionMode() {
    isSelectionMode = true;
    selectedImages.clear();
    selectionToolbar.classList.remove('hidden');
    
    const items = document.querySelectorAll('.waterfall-item');
    items.forEach(item => {
      item.classList.add('selection-mode');
    });
    
    updateSelectedCount();
  }
  
  function exitSelectionMode() {
    isSelectionMode = false;
    selectedImages.clear();
    selectionToolbar.classList.add('hidden');
    
    const items = document.querySelectorAll('.waterfall-item');
    items.forEach(item => {
      item.classList.remove('selection-mode', 'selected');
    });
  }
  
  function toggleSelectionMode() {
    if (isSelectionMode) {
      exitSelectionMode();
    } else {
      enterSelectionMode();
    }
  }
  
  function toggleImageSelection(item) {
    if (!isSelectionMode) return;
    
    if (item.classList.contains('selected')) {
      item.classList.remove('selected');
      selectedImages.delete(item);
    } else {
      item.classList.add('selected');
      selectedImages.add(item);
    }
    
    updateSelectedCount();
  }
  
  function updateSelectedCount() {
    const countSpan = document.getElementById('selectedCount');
    if (countSpan) {
      countSpan.textContent = selectedImages.size;
    }
    if (downloadSelectedBtn) {
      downloadSelectedBtn.disabled = selectedImages.size === 0;
    }
    
    // Update toggle select all button text
    if (toggleSelectAllBtn) {
      const items = document.querySelectorAll('.waterfall-item');
      const allSelected = items.length > 0 && selectedImages.size === items.length;
      toggleSelectAllBtn.textContent = allSelected ? t('imagine.deselectAll') : t('imagine.selectAll');
    }
  }
  
  function toggleSelectAll() {
    const items = document.querySelectorAll('.waterfall-item');
    const allSelected = items.length > 0 && selectedImages.size === items.length;
    
    if (allSelected) {
      // Deselect all
      items.forEach(item => {
        item.classList.remove('selected');
      });
      selectedImages.clear();
    } else {
      // Select all
      items.forEach(item => {
        item.classList.add('selected');
        selectedImages.add(item);
      });
    }
    
    updateSelectedCount();
  }
  
  async function downloadSelectedImages() {
    if (selectedImages.size === 0) {
      toast(t('imagine.noImagesSelected'), 'warning');
      return;
    }
    
    if (typeof JSZip === 'undefined') {
      toast(t('imagine.jszipFailed'), 'error');
      return;
    }
    
    toast(t('imagine.packing', { count: selectedImages.size }), 'info');
    downloadSelectedBtn.disabled = true;
    downloadSelectedBtn.textContent = t('imagine.packingBtn');
    
    const zip = new JSZip();
    const imgFolder = zip.folder('images');
    let processed = 0;
    
    try {
      for (const item of selectedImages) {
        const url = item.dataset.imageUrl;
        const prompt = item.dataset.prompt || 'image';
        
        try {
          let blob = null;
          if (url && url.startsWith('data:')) {
            blob = dataUrlToBlob(url);
          } else if (url) {
            const response = await fetch(url);
            blob = await response.blob();
          }
          if (!blob) {
            throw new Error('empty blob');
          }
          const filename = `${prompt.substring(0, 30).replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_')}_${processed + 1}.png`;
          imgFolder.file(filename, blob);
          processed++;
          
          // Update progress
          downloadSelectedBtn.innerHTML = t('imagine.packingProgress', { done: processed, total: selectedImages.size });
        } catch (error) {
          console.error('Failed to fetch image:', error);
        }
      }
      
      if (processed === 0) {
        toast(t('imagine.noImagesDownloaded'), 'error');
        return;
      }
      
      // Generate zip file
      downloadSelectedBtn.textContent = t('imagine.generatingZip');
      const content = await zip.generateAsync({ type: 'blob' });
      
      // Download zip
      const link = document.createElement('a');
      link.href = URL.createObjectURL(content);
      link.download = `imagine_${new Date().toISOString().slice(0, 10)}_${Date.now()}.zip`;
      link.click();
      URL.revokeObjectURL(link.href);
      
      toast(t('imagine.packSuccess', { count: processed }), 'success');
      exitSelectionMode();
    } catch (error) {
      console.error('Download failed:', error);
      toast(t('imagine.packFailed'), 'error');
    } finally {
    downloadSelectedBtn.disabled = false;
    downloadSelectedBtn.innerHTML = `${t('imagine.download')} <span id="selectedCount" class="selected-count">${selectedImages.size}</span>`;
    }
  }
  
  if (batchDownloadBtn) {
    batchDownloadBtn.addEventListener('click', toggleSelectionMode);
  }
  
  if (toggleSelectAllBtn) {
    toggleSelectAllBtn.addEventListener('click', toggleSelectAll);
  }
  
  if (downloadSelectedBtn) {
    downloadSelectedBtn.addEventListener('click', downloadSelectedImages);
  }
  
  
  // Handle image/checkbox clicks in waterfall
  if (waterfall) {
    waterfall.addEventListener('click', (e) => {
      const item = e.target.closest('.waterfall-item');
      if (!item) return;
      
      if (isSelectionMode) {
        // In selection mode, clicking anywhere on the item toggles selection
        toggleImageSelection(item);
      } else {
        // In normal mode, only clicking the image opens lightbox
        if (e.target.closest('.waterfall-item img')) {
          const img = e.target.closest('.waterfall-item img');
          const images = getAllImages();
          const index = images.indexOf(img);
          
          if (index !== -1) {
            updateLightbox(index);
            lightbox.classList.add('active');
          }
        }
      }
    });
  }

  // Lightbox for image preview with navigation
  const lightboxPrev = document.getElementById('lightboxPrev');
  const lightboxNext = document.getElementById('lightboxNext');
  let currentImageIndex = -1;
  
  function getAllImages() {
    return Array.from(document.querySelectorAll('.waterfall-item img'));
  }
  
  function updateLightbox(index) {
    const images = getAllImages();
    if (index < 0 || index >= images.length) return;
    
    currentImageIndex = index;
    lightboxImg.src = images[index].src;
    
    // Update navigation buttons state
    if (lightboxPrev) lightboxPrev.disabled = (index === 0);
    if (lightboxNext) lightboxNext.disabled = (index === images.length - 1);
  }
  
  function showPrevImage() {
    if (currentImageIndex > 0) {
      updateLightbox(currentImageIndex - 1);
    }
  }
  
  function showNextImage() {
    const images = getAllImages();
    if (currentImageIndex < images.length - 1) {
      updateLightbox(currentImageIndex + 1);
    }
  }
  
  if (lightbox && closeLightbox) {
    closeLightbox.addEventListener('click', (e) => {
      e.stopPropagation();
      lightbox.classList.remove('active');
      currentImageIndex = -1;
    });

    lightbox.addEventListener('click', () => {
      lightbox.classList.remove('active');
      currentImageIndex = -1;
    });

    // Prevent closing when clicking on the image
    if (lightboxImg) {
      lightboxImg.addEventListener('click', (e) => {
        e.stopPropagation();
      });
    }
    
    // Navigation buttons
    if (lightboxPrev) {
      lightboxPrev.addEventListener('click', (e) => {
        e.stopPropagation();
        showPrevImage();
      });
    }
    
    if (lightboxNext) {
      lightboxNext.addEventListener('click', (e) => {
        e.stopPropagation();
        showNextImage();
      });
    }

    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
      if (!lightbox.classList.contains('active')) return;
      
      if (e.key === 'Escape') {
        lightbox.classList.remove('active');
        currentImageIndex = -1;
      } else if (e.key === 'ArrowLeft') {
        showPrevImage();
      } else if (e.key === 'ArrowRight') {
        showNextImage();
      }
    });
  }
  renderReferenceItems();
})();
