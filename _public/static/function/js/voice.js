(() => {
  let Room;
  let createLocalTracks;
  let RoomEvent;
  let Track;
  let room = null;
  let localTracks = [];
  let isConnecting = false;
  let suppressDisconnectLog = false;
  let visualizerTimer = null;

  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const statusText = document.getElementById('statusText');
  const logContainer = document.getElementById('log');
  const voiceSelect = document.getElementById('voiceSelect');
  const personalitySelect = document.getElementById('personalitySelect');
  const speedRange = document.getElementById('speedRange');
  const speedValue = document.getElementById('speedValue');
  const statusVoice = document.getElementById('statusVoice');
  const statusPersonality = document.getElementById('statusPersonality');
  const statusSpeed = document.getElementById('statusSpeed');
  const audioRoot = document.getElementById('audioRoot');
  const copyLogBtn = document.getElementById('copyLogBtn');
  const clearLogBtn = document.getElementById('clearLogBtn');
  const visualizer = document.getElementById('visualizer');

  function log(message, level = 'info') {
    if (!logContainer) {
      return;
    }
    const p = document.createElement('p');
    const time = new Date().toLocaleTimeString();
    p.textContent = `[${time}] ${message}`;
    if (level === 'error') {
      p.classList.add('log-error');
    } else if (level === 'warn') {
      p.classList.add('log-warn');
    }
    logContainer.prepend(p);
    if (typeof console !== 'undefined') {
      console.log(message);
    }
  }

  function toast(message, type) {
    if (typeof showToast === 'function') {
      showToast(message, type);
    } else {
      log(message, type === 'error' ? 'error' : 'info');
    }
  }

  function setStatus(state, text) {
    if (!statusText) {
      return;
    }
    statusText.textContent = text;
    statusText.classList.remove('connected', 'connecting', 'error');
    if (state) {
      statusText.classList.add(state);
    }
  }

  function setButtons(connected) {
    if (!startBtn || !stopBtn) {
      return;
    }
    if (connected) {
      startBtn.classList.add('hidden');
      stopBtn.classList.remove('hidden');
    } else {
      startBtn.classList.remove('hidden');
      stopBtn.classList.add('hidden');
      startBtn.disabled = false;
    }
  }

  function updateMeta() {
    if (statusVoice) {
      statusVoice.textContent = voiceSelect.value;
    }
    if (statusPersonality) {
      statusPersonality.textContent = personalitySelect.value;
    }
    if (statusSpeed) {
      statusSpeed.textContent = `${speedRange.value}x`;
    }
  }

  function initLiveKit() {
    const lk = window.LiveKitClient || window.LivekitClient;
    if (!lk) {
      return false;
    }
    Room = lk.Room;
    createLocalTracks = lk.createLocalTracks;
    RoomEvent = lk.RoomEvent;
    Track = lk.Track;
    return true;
  }

  function ensureLiveKit() {
    if (Room) {
      return true;
    }
    if (!initLiveKit()) {
      log(t('voice.livekitSDKError'), 'error');
      toast(t('voice.livekitLoadFailed'), 'error');
      return false;
    }
    return true;
  }

  function ensureMicSupport() {
    const hasMediaDevices = typeof navigator !== 'undefined' && navigator.mediaDevices;
    const hasGetUserMedia = hasMediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function';
    if (hasGetUserMedia) {
      return true;
    }
    const isLocalhost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
    const secureHint = window.isSecureContext || isLocalhost
      ? t('voice.secureContextBrowser')
      : t('voice.secureContextHTTPS');
    throw new Error(t('voice.secureContextError', { hint: secureHint }));
  }

  function cleanupLocalTracks() {
    if (!Array.isArray(localTracks)) {
      localTracks = [];
      return;
    }
    localTracks.forEach((track) => {
      try {
        track.stop();
      } catch (e) {
        // ignore
      }
    });
    localTracks = [];
  }

  function normalizeLivekitUrl(rawUrl, fallbackUrl = 'wss://livekit.grok.com') {
    if (typeof rawUrl !== 'string') {
      return fallbackUrl;
    }
    const value = rawUrl.trim();
    if (!value) {
      return fallbackUrl;
    }
    const withProtocol = value.includes('://') ? value : `wss://${value}`;
    try {
      const parsed = new URL(withProtocol);
      if (!parsed.protocol.startsWith('ws')) {
        return fallbackUrl;
      }
      const path = (parsed.pathname || '').replace(/\/+$/, '');
      return `${parsed.protocol}//${parsed.host}${path}`;
    } catch (e) {
      return fallbackUrl;
    }
  }

  function normalizeLivekitUrls(rawUrls, fallbackUrl = 'wss://livekit.grok.com') {
    const result = [];
    const push = (value) => {
      const normalized = normalizeLivekitUrl(value, '');
      if (!normalized || result.includes(normalized)) {
        return;
      }
      result.push(normalized);
    };

    if (Array.isArray(rawUrls)) {
      rawUrls.forEach(push);
    } else {
      push(rawUrls);
    }

    push(fallbackUrl);
    if (!result.length) {
      result.push('wss://livekit.grok.com');
    }
    return result;
  }

  function normalizeIceServers(raw) {
    if (!Array.isArray(raw)) {
      return [];
    }
    const normalized = [];
    raw.forEach((item) => {
      if (!item || typeof item !== 'object') {
        return;
      }
      const urlsRaw = item.urls || item.url;
      let urls = [];
      if (typeof urlsRaw === 'string' && urlsRaw.trim()) {
        urls = [urlsRaw.trim()];
      } else if (Array.isArray(urlsRaw)) {
        urls = urlsRaw
          .filter((value) => typeof value === 'string' && value.trim())
          .map((value) => value.trim());
      }
      if (!urls.length) {
        return;
      }
      const entry = { urls };
      if (typeof item.username === 'string' && item.username.trim()) {
        entry.username = item.username.trim();
      }
      if (item.credential !== undefined && item.credential !== null) {
        entry.credential = item.credential;
      }
      normalized.push(entry);
    });
    return normalized;
  }

  function buildConnectOptions(iceServers, forceRelay = false) {
    const options = {
      autoSubscribe: true,
      maxRetries: 1,
      websocketTimeout: 30000,
      peerConnectionTimeout: 20000
    };
    const rtcConfig = {};
    if (Array.isArray(iceServers) && iceServers.length > 0) {
      rtcConfig.iceServers = iceServers;
    }
    if (forceRelay) {
      rtcConfig.iceTransportPolicy = 'relay';
    }
    if (Object.keys(rtcConfig).length > 0) {
      options.rtcConfig = rtcConfig;
    }
    return options;
  }

  function buildCandidateUrls(rawUrls) {
    const seeds = Array.isArray(rawUrls) ? rawUrls : [rawUrls];
    const candidates = [];
    const push = (value) => {
      if (!value || candidates.includes(value)) {
        return;
      }
      candidates.push(value);
    };

    seeds.forEach((rawUrl) => {
      const main = normalizeLivekitUrl(rawUrl, '').replace(/\/+$/, '');
      if (!main) {
        return;
      }
      push(main);
      if (main.endsWith('/rtc')) {
        push(main.slice(0, -4));
      } else {
        push(`${main}/rtc`);
      }
      try {
        const parsed = new URL(main);
        if (parsed.protocol === 'wss:' && !parsed.port) {
          const base443 = `${parsed.protocol}//${parsed.hostname}:443`;
          const path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '';
          push(`${base443}${path}`);
          if (path.endsWith('/rtc')) {
            push(base443);
          } else {
            push(`${base443}/rtc`);
          }
        }
      } catch (e) {
        // ignore
      }
    });

    if (!candidates.length) {
      push('wss://livekit.grok.com');
      push('wss://livekit.grok.com/rtc');
    }
    return candidates;
  }

  function bindRoomEvents(targetRoom) {
    targetRoom.on(RoomEvent.ParticipantConnected, (participant) => log(t('voice.participantConnected', { identity: participant.identity })));
    targetRoom.on(RoomEvent.ParticipantDisconnected, (participant) => log(t('voice.participantDisconnected', { identity: participant.identity })));
    targetRoom.on(RoomEvent.TrackSubscribed, (track) => {
      log(t('voice.trackSubscribed', { kind: track.kind }));
      if (track.kind === Track.Kind.Audio) {
        const element = track.attach();
        element.autoplay = true;
        element.playsInline = true;
        if (audioRoot) {
          audioRoot.appendChild(element);
        } else {
          document.body.appendChild(element);
        }
      }
    });
    targetRoom.on(RoomEvent.Disconnected, () => {
      if (!suppressDisconnectLog) {
        log(t('voice.disconnected'));
      }
      if (!isConnecting) {
        resetUI();
      }
    });
  }

  function createRoomInstance() {
    const targetRoom = new Room({
      adaptiveStream: true,
      dynacast: true
    });
    bindRoomEvents(targetRoom);
    return targetRoom;
  }

  async function connectWithFallbacks(rawUrls, token, iceServers) {
    const urlCandidates = buildCandidateUrls(rawUrls);
    const strategies = [{ forceRelay: false, label: 'direct' }];
    if (Array.isArray(iceServers) && iceServers.length > 0) {
      strategies.push({ forceRelay: true, label: 'relay' });
    }

    let lastError = null;
    let attempt = 0;
    suppressDisconnectLog = true;

    for (const candidateUrl of urlCandidates) {
      for (const strategy of strategies) {
        attempt += 1;
        log(`尝试连接 #${attempt}: ${candidateUrl}${strategy.forceRelay ? ' (relay)' : ''}`);
        room = createRoomInstance();
        try {
          await room.connect(candidateUrl, token, buildConnectOptions(iceServers, strategy.forceRelay));
          suppressDisconnectLog = false;
          return {
            usedUrl: candidateUrl,
            usedRelay: strategy.forceRelay,
            attempts: attempt
          };
        } catch (error) {
          lastError = error;
          const message = error && error.message ? error.message : String(error || '');
          log(`连接失败: ${message}`, 'warn');
          try {
            await room.disconnect();
          } catch (disconnectError) {
            // ignore
          }
          room = null;
        }
      }
    }

    suppressDisconnectLog = false;
    throw lastError || new Error(t('common.connectionFailed'));
  }

  async function startSession() {
    if (!ensureLiveKit()) {
      return;
    }

    if (isConnecting) {
      return;
    }

    try {
      isConnecting = true;
      const authHeader = await ensureFunctionKey();
      if (authHeader === null) {
        toast(t('common.configurePublicKey'), 'error');
        window.location.href = '/login';
        return;
      }

      startBtn.disabled = true;
      updateMeta();
      setStatus('connecting', t('voice.connectingStatus'));
      log(t('voice.fetchingToken'));

      const params = new URLSearchParams({
        voice: voiceSelect.value,
        personality: personalitySelect.value,
        speed: speedRange.value
      });

      const headers = buildAuthHeaders(authHeader);

      const response = await fetch(`/v1/function/voice/token?${params.toString()}`, {
        headers
      });

      if (!response.ok) {
        throw new Error(t('voice.fetchTokenFailed', { status: response.status }));
      }

      const payload = await response.json();
      const token = typeof payload.token === 'string' ? payload.token.trim() : '';
      const url = typeof payload.url === 'string' && payload.url.trim()
        ? payload.url.trim()
        : 'wss://livekit.grok.com';
      const urls = normalizeLivekitUrls(payload.urls, url);
      const iceServers = normalizeIceServers(payload.ice_servers);
      if (!token) {
        throw new Error(t('common.connectionFailed'));
      }
      log(`${t('voice.fetchTokenSuccess')} (${voiceSelect.value}, ${personalitySelect.value}, ${speedRange.value}x)`);
      log(`连接地址候选 ${urls.length} 个${iceServers.length ? `，ICE ${iceServers.length} 组` : ''}`);

      const connectResult = await connectWithFallbacks(urls, token, iceServers);
      log(`${t('voice.connectedToServer')} (${connectResult.usedUrl})`);
      if (connectResult.usedRelay) {
        log('已切换 relay 模式完成连接', 'warn');
      }

      setStatus('connected', t('voice.inCall'));
      setButtons(true);

      log(t('voice.openingMic'));
      ensureMicSupport();
      cleanupLocalTracks();
      localTracks = await createLocalTracks({ audio: true, video: false });
      for (const track of localTracks) {
        await room.localParticipant.publishTrack(track);
      }
      log(t('voice.voiceEnabled'));
      toast(t('voice.voiceConnected'), 'success');
    } catch (err) {
      const message = err && err.message ? err.message : t('common.connectionFailed');
      cleanupLocalTracks();
      if (room) {
        try {
          await room.disconnect();
        } catch (disconnectError) {
          // ignore
        }
        room = null;
      }
      log(t('voice.errorPrefix', { msg: message }), 'error');
      toast(message, 'error');
      setStatus('error', t('common.connectionError'));
      startBtn.disabled = false;
    } finally {
      isConnecting = false;
    }
  }

  async function stopSession() {
    if (room) {
      await room.disconnect();
      room = null;
    }
    resetUI();
  }

  function resetUI() {
    cleanupLocalTracks();
    room = null;
    setStatus('', t('common.notConnected'));
    setButtons(false);
    if (audioRoot) {
      audioRoot.innerHTML = '';
    }
  }

  function clearLog() {
    if (logContainer) {
      logContainer.innerHTML = '';
    }
  }

  async function copyLog() {
    if (!logContainer) {
      return;
    }
    const lines = Array.from(logContainer.querySelectorAll('p'))
      .map((p) => p.textContent)
      .join('\n');
    try {
      await navigator.clipboard.writeText(lines);
      toast(t('voice.logCopied'), 'success');
    } catch (err) {
      toast(t('voice.copyLogFailed'), 'error');
    }
  }

  speedRange.addEventListener('input', (e) => {
    speedValue.textContent = Number(e.target.value).toFixed(1);
    const min = Number(speedRange.min || 0);
    const max = Number(speedRange.max || 100);
    const val = Number(speedRange.value || 0);
    const pct = ((val - min) / (max - min)) * 100;
    speedRange.style.setProperty('--range-progress', `${pct}%`);
    updateMeta();
  });

  voiceSelect.addEventListener('change', updateMeta);
  personalitySelect.addEventListener('change', updateMeta);

  startBtn.addEventListener('click', startSession);
  stopBtn.addEventListener('click', stopSession);
  if (copyLogBtn) {
    copyLogBtn.addEventListener('click', copyLog);
  }
  if (clearLogBtn) {
    clearLogBtn.addEventListener('click', clearLog);
  }

  speedValue.textContent = Number(speedRange.value).toFixed(1);
  {
    const min = Number(speedRange.min || 0);
    const max = Number(speedRange.max || 100);
    const val = Number(speedRange.value || 0);
    const pct = ((val - min) / (max - min)) * 100;
    speedRange.style.setProperty('--range-progress', `${pct}%`);
  }
  function buildVisualizerBars() {
    if (!visualizer) return;
    visualizer.innerHTML = '';
    const targetCount = Math.max(36, Math.floor(visualizer.offsetWidth / 7));
    for (let i = 0; i < targetCount; i += 1) {
      const bar = document.createElement('div');
      bar.className = 'bar';
      visualizer.appendChild(bar);
    }
  }

  window.addEventListener('resize', buildVisualizerBars);
  buildVisualizerBars();
  updateMeta();
  setStatus('', t('common.notConnected'));

  if (!visualizerTimer) {
    visualizerTimer = setInterval(() => {
      const bars = document.querySelectorAll('.visualizer .bar');
      bars.forEach((bar) => {
        if (statusText && statusText.classList.contains('connected')) {
          bar.style.height = `${Math.random() * 32 + 6}px`;
        } else {
          bar.style.height = '6px';
        }
      });
    }, 150);
  }
})();
