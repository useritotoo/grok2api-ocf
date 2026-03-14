import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

type FakeStyle = {
  width?: string;
  setProperty: (name: string, value: string) => void;
  [key: string]: unknown;
};

class FakeElement {
  tagName: string;
  ownerDocument: FakeDocument | null;
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  className = "";
  textContent = "";
  value = "";
  disabled = false;
  hidden = false;
  href = "";
  download = "";
  files: unknown[] = [];
  currentTime = 0;
  duration = 12;
  currentSrc = "";
  listeners = new Map<string, Array<(...args: any[]) => void>>();
  style: FakeStyle = {
    setProperty: (name: string, value: string) => {
      this.style[name] = value;
    },
  };
  private _id = "";
  private _innerHTML = "";
  classList: {
    add: (...names: string[]) => void;
    remove: (...names: string[]) => void;
    contains: (name: string) => boolean;
    toggle: (name: string, force?: boolean) => void;
  };

  constructor(tagName: string, ownerDocument: FakeDocument | null) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.classList = {
      add: (...names: string[]) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean));
        names.forEach((name) => set.add(name));
        this.className = Array.from(set).join(" ");
      },
      remove: (...names: string[]) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean));
        names.forEach((name) => set.delete(name));
        this.className = Array.from(set).join(" ");
      },
      contains: (name: string) => this.className.split(/\s+/).includes(name),
      toggle: (name: string, force?: boolean) => {
        const has = this.className.split(/\s+/).includes(name);
        const shouldAdd = force ?? !has;
        if (shouldAdd) this.classList.add(name);
        else this.classList.remove(name);
      },
    };
  }

  get id() {
    return this._id;
  }

  set id(value: string) {
    this._id = String(value);
    if (this.ownerDocument) {
      this.ownerDocument.registerElement(this);
    }
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value: string) {
    this._innerHTML = String(value);
    this.children = [];
    const html = this._innerHTML;
    if (!html) return;

    if (/<video/i.test(html)) {
      const video = this.ownerDocument?.createElement("video") ?? new FakeElement("video", this.ownerDocument);
      const videoSrcMatch = html.match(/<video[^>]*\ssrc=["']([^"']+)["']/i);
      const sourceSrcMatch = html.match(/<source[^>]*\ssrc=["']([^"']+)["']/i);
      if (videoSrcMatch?.[1]) {
        video.setAttribute("src", videoSrcMatch[1]);
        video.currentSrc = videoSrcMatch[1];
      }
      if (sourceSrcMatch?.[1]) {
        const source = this.ownerDocument?.createElement("source") ?? new FakeElement("source", this.ownerDocument);
        source.setAttribute("src", sourceSrcMatch[1]);
        video.appendChild(source);
      }
      this.appendChild(video);
      return;
    }

    if (/<a/i.test(html)) {
      const anchor = this.ownerDocument?.createElement("a") ?? new FakeElement("a", this.ownerDocument);
      const hrefMatch = html.match(/<a[^>]*\shref=["']([^"']+)["']/i);
      if (hrefMatch?.[1]) {
        anchor.setAttribute("href", hrefMatch[1]);
      }
      this.appendChild(anchor);
      return;
    }
  }

  setAttribute(name: string, value: string) {
    const normalized = String(value);
    this.attributes.set(name, normalized);
    if (name === "id") this.id = normalized;
    if (name === "class") this.className = normalized;
    if (name === "href") this.href = normalized;
    if (name === "src") this.currentSrc = normalized;
    if (name.startsWith("data-")) {
      const key = name
        .slice(5)
        .split("-")
        .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
        .join("");
      this.dataset[key] = normalized;
    }
  }

  getAttribute(name: string) {
    if (name === "id") return this.id;
    if (name === "class") return this.className;
    if (name === "href") return this.href || null;
    if (name === "src") return this.currentSrc || null;
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
    if (name === "src") {
      this.currentSrc = "";
    }
    if (name.startsWith("data-")) {
      const key = name
        .slice(5)
        .split("-")
        .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
        .join("");
      delete this.dataset[key];
    }
  }

  appendChild(child: FakeElement) {
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: FakeElement) {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
      child.parentNode = null;
    }
    return child;
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }

  addEventListener(type: string, handler: (...args: any[]) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  dispatchEvent(event: { type: string; target?: unknown }) {
    const list = this.listeners.get(event.type) ?? [];
    list.forEach((handler) => handler(event));
  }

  click() {
    this.dispatchEvent({ type: "click", target: this });
  }

  load() {
    // no-op
  }

  pause() {
    // no-op
  }

  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string) {
    const results: FakeElement[] = [];
    const matches = (element: FakeElement) => {
      if (selector.startsWith("#")) return element.id === selector.slice(1);
      if (selector.startsWith(".")) {
        return element.className.split(/\s+/).includes(selector.slice(1));
      }
      return element.tagName.toLowerCase() === selector.toLowerCase();
    };
    const walk = (element: FakeElement) => {
      for (const child of element.children) {
        if (matches(child)) results.push(child);
        walk(child);
      }
    };
    walk(this);
    return results;
  }

  closest(selector: string) {
    let cursor: FakeElement | null = this;
    while (cursor) {
      if (selector.startsWith("#") && cursor.id === selector.slice(1)) return cursor;
      if (selector.startsWith(".") && cursor.classList.contains(selector.slice(1))) return cursor;
      cursor = cursor.parentNode;
    }
    return null;
  }
}

class FakeDocument {
  private elementsById = new Map<string, FakeElement>();
  body: FakeElement;

  constructor() {
    this.body = new FakeElement("body", this);
  }

  registerElement(element: FakeElement) {
    if (element.id) {
      this.elementsById.set(element.id, element);
    }
  }

  createElement(tagName: string) {
    return new FakeElement(tagName, this);
  }

  getElementById(id: string) {
    return this.elementsById.get(id) ?? null;
  }

  querySelectorAll(selector: string) {
    return this.body.querySelectorAll(selector);
  }
}

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];

  url: string;
  readyState = FakeEventSource.OPEN;
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close() {
    this.readyState = FakeEventSource.CLOSED;
  }

  emitOpen() {
    this.onopen?.({});
  }

  emitMessage(data: string) {
    this.onmessage?.({ data });
  }

  emitError(error?: unknown) {
    this.onerror?.(error);
  }

  static reset() {
    FakeEventSource.instances.length = 0;
  }
}

function createPageElement(document: FakeDocument, tagName: string, id: string, parent?: FakeElement) {
  const element = document.createElement(tagName);
  element.id = id;
  (parent ?? document.body).appendChild(element);
  return element;
}

function buildVideoPage(document: FakeDocument) {
  const ids: Array<[string, string]> = [
    ["button", "startBtn"],
    ["button", "stopBtn"],
    ["button", "clearBtn"],
    ["textarea", "promptInput"],
    ["div", "referenceList"],
    ["input", "imageUrlInput"],
    ["input", "imageFileInput"],
    ["div", "imageFileName"],
    ["button", "clearImageFileBtn"],
    ["button", "selectImageFileBtn"],
    ["select", "ratioSelect"],
    ["input", "lengthSelect"],
    ["select", "resolutionSelect"],
    ["select", "presetSelect"],
    ["div", "statusText"],
    ["div", "progressBar"],
    ["div", "progressFill"],
    ["div", "progressText"],
    ["div", "durationValue"],
    ["div", "aspectValue"],
    ["div", "lengthValue"],
    ["div", "resolutionValue"],
    ["div", "presetValue"],
    ["div", "videoEmpty"],
    ["div", "videoStage"],
    ["button", "pickCachedVideoBtn"],
    ["button", "uploadWorkVideoBtn"],
    ["input", "workVideoFileInput"],
    ["div", "cacheVideoModal"],
    ["button", "closeCacheVideoModalBtn"],
    ["div", "cacheVideoList"],
    ["div", "editHint"],
    ["div", "editCurrentVideo"],
    ["div", "historyCount"],
    ["button", "clearHistoryBtn"],
    ["video", "editVideo"],
    ["input", "editTimeline"],
    ["div", "editTimeText"],
    ["div", "editDurationText"],
    ["div", "editFrameIndex"],
    ["div", "editTimestampMs"],
    ["div", "editExtendPostId"],
    ["textarea", "editPromptInput"],
    ["button", "spliceBtn"],
    ["button", "upscaleBtn"],
  ];

  ids.forEach(([tag, id]) => {
    createPageElement(document, tag, id);
  });

  const stopBtn = document.getElementById("stopBtn");
  stopBtn?.classList.add("hidden");

  const ratioSelect = document.getElementById("ratioSelect");
  if (ratioSelect) ratioSelect.value = "16:9";
  const lengthSelect = document.getElementById("lengthSelect");
  if (lengthSelect) lengthSelect.value = "15";
  const resolutionSelect = document.getElementById("resolutionSelect");
  if (resolutionSelect) resolutionSelect.value = "720p";
  const presetSelect = document.getElementById("presetSelect");
  if (presetSelect) presetSelect.value = "normal";
  const editTimeline = document.getElementById("editTimeline");
  if (editTimeline) {
    editTimeline.value = "0";
    editTimeline.setAttribute("max", "100000");
  }

  const spliceBtn = document.getElementById("spliceBtn");
  if (spliceBtn) {
    const span = document.createElement("span");
    span.textContent = "开始延长";
    spliceBtn.appendChild(span);
  }
}

function loadVideoHooks() {
  FakeEventSource.reset();
  const document = new FakeDocument();
  buildVideoPage(document);

  const origin = "https://example.com";
  const windowObject: Record<string, any> = {
    document,
    location: {
      protocol: "https:",
      host: "example.com",
      href: `${origin}/function/pages/video`,
      origin,
    },
  };
  const videoReferenceCache = {
    createReferenceUploadCache() {
      return {
        reset() {},
        peek() {
          return "";
        },
        async getOrUpload(file: unknown, uploadFn: (value: unknown) => Promise<unknown>) {
          return uploadFn(file);
        },
      };
    },
    syncReferenceStartButtonState(button: FakeElement, options: { isRunning: boolean }) {
      button.disabled = Boolean(options.isRunning);
      return button.disabled;
    },
  };

  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push({ url, init });
    if (url === "/v1/function/video/start") {
      return new Response(JSON.stringify({ task_id: "task-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "/v1/function/video/upscale") {
      return new Response(JSON.stringify({ video_url: "/images/u_upscaled-video", upscaled: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("", { status: 200 });
  };

  const urlCtor = URL as typeof URL & {
    createObjectURL: (value: unknown) => string;
    revokeObjectURL: (value: string) => void;
  };
  urlCtor.createObjectURL = () => "blob:test";
  urlCtor.revokeObjectURL = () => {};

  const context = vm.createContext({
    window: windowObject,
    document,
    console,
    fetch: fetchMock,
    Request,
    Response,
    Headers,
    URL: urlCtor,
    URLSearchParams,
    EventSource: FakeEventSource,
    FormData: class FakeFormData {
      append() {}
    },
    XMLHttpRequest: class FakeXhr {},
    showToast() {},
    t: (key: string) => key,
    ensureFunctionKey: async () => "Bearer function-secret",
    buildAuthHeaders: (authHeader: string) => ({ Authorization: authHeader }),
    VideoReferenceCache: videoReferenceCache,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    Promise,
    atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
  });

  windowObject.VideoReferenceCache = videoReferenceCache;

  const scriptPath = path.resolve(import.meta.dirname, "../../_public/static/function/js/video.js");
  const source = fs.readFileSync(scriptPath, "utf8");
  const instrumented = source.replace(
    /\}\)\(\);\s*$/,
    `
  window.__videoTestHooks = {
    startConnection,
    runExtendVideo,
    setState(patch) {
      if (Object.prototype.hasOwnProperty.call(patch, 'selectedVideoUrl')) selectedVideoUrl = String(patch.selectedVideoUrl || '');
      if (Object.prototype.hasOwnProperty.call(patch, 'currentExtendPostId')) currentExtendPostId = String(patch.currentExtendPostId || '');
      if (Object.prototype.hasOwnProperty.call(patch, 'originalFileAttachmentId')) originalFileAttachmentId = String(patch.originalFileAttachmentId || '');
      if (Object.prototype.hasOwnProperty.call(patch, 'lockedTimestampMs')) lockedTimestampMs = Number(patch.lockedTimestampMs || 0);
      setEditMeta();
      syncTimelineAvailability();
    },
    getState() {
      return {
        isRunning,
        currentRunKind,
        currentTaskId,
        statusText: statusText ? statusText.textContent : '',
        progressText: progressText ? progressText.textContent : '',
        aspectValue: aspectValue ? aspectValue.textContent : '',
        presetValue: presetValue ? presetValue.textContent : '',
        previewUrl: currentPreviewItem ? String(currentPreviewItem.dataset.url || '') : '',
        selectedVideoUrl,
        currentExtendPostId,
      };
    }
  };
})();
`,
  );

  vm.runInContext(instrumented, context);

  return {
    hooks: (windowObject.__videoTestHooks || {}) as {
      startConnection: () => Promise<void>;
      runExtendVideo: () => Promise<void>;
      setState: (patch: Record<string, unknown>) => void;
      getState: () => Record<string, unknown>;
    },
    eventSources: FakeEventSource.instances,
    fetchCalls,
    document,
  };
}

test("video extension does not mark success when stop and done arrive before any video url", async () => {
  const { hooks, eventSources } = loadVideoHooks();
  hooks.setState({
    selectedVideoUrl: "https://example.com/images/source-video",
    currentExtendPostId: "abcd1234abcd1234abcd1234abcd1234",
    originalFileAttachmentId: "orig1234orig1234orig1234orig1234",
    lockedTimestampMs: 2500,
  });

  await hooks.runExtendVideo();

  assert.equal(eventSources.length, 1);
  const source = eventSources[0];
  source.emitMessage(JSON.stringify({
    choices: [
      {
        delta: {
          content: "progress=35%",
        },
        finish_reason: null,
      },
    ],
  }));
  source.emitMessage(JSON.stringify({
    choices: [
      {
        delta: {},
        finish_reason: "stop",
      },
    ],
  }));

  let state = hooks.getState();
  assert.equal(state.isRunning, true, JSON.stringify(state));
  assert.notEqual(state.statusText, "延长完成");

  source.emitMessage("[DONE]");

  state = hooks.getState();
  assert.equal(state.isRunning, false);
  assert.notEqual(state.statusText, "延长完成");
  assert.notEqual(state.progressText, "100%");
  assert.equal(state.previewUrl, "");
});

test("video extension completes once a streamed video url has been rendered", async () => {
  const { hooks, eventSources } = loadVideoHooks();
  hooks.setState({
    selectedVideoUrl: "https://example.com/images/source-video",
    currentExtendPostId: "abcd1234abcd1234abcd1234abcd1234",
    originalFileAttachmentId: "orig1234orig1234orig1234orig1234",
    lockedTimestampMs: 2500,
  });

  await hooks.runExtendVideo();

  assert.equal(eventSources.length, 1);
  const source = eventSources[0];
  const renderedUrl = "https://example.com/images/generated-video.mp4";

  source.emitMessage(JSON.stringify({
    choices: [
      {
        delta: {
          content: renderedUrl,
        },
        finish_reason: null,
      },
    ],
  }));
  source.emitMessage(JSON.stringify({
    choices: [
      {
        delta: {},
        finish_reason: "stop",
      },
    ],
  }));

  const state = hooks.getState();
  assert.equal(state.isRunning, false, JSON.stringify(state));
  assert.equal(state.statusText, "延长完成");
  assert.equal(state.progressText, "100%");
  assert.equal(state.previewUrl, renderedUrl);
});

test("video settings panel updates aspect ratio and preset immediately when selections change", () => {
  const { hooks, document } = loadVideoHooks();
  const ratioSelect = document.getElementById("ratioSelect");
  const presetSelect = document.getElementById("presetSelect");

  if (ratioSelect) {
    ratioSelect.value = "9:16";
    ratioSelect.dispatchEvent({ type: "change", target: ratioSelect });
  }
  if (presetSelect) {
    presetSelect.value = "spicy";
    presetSelect.dispatchEvent({ type: "change", target: presetSelect });
  }

  const state = hooks.getState();
  assert.equal(state.aspectValue, "9:16");
  assert.equal(state.presetValue, "spicy");
});

test("video generation request payload keeps the selected aspect ratio and preset", async () => {
  const { hooks, fetchCalls, eventSources, document } = loadVideoHooks();
  const promptInput = document.getElementById("promptInput");
  const ratioSelect = document.getElementById("ratioSelect");
  const presetSelect = document.getElementById("presetSelect");
  const resolutionSelect = document.getElementById("resolutionSelect");

  if (promptInput) promptInput.value = "Animate the neon rain";
  if (ratioSelect) ratioSelect.value = "1:1";
  if (presetSelect) presetSelect.value = "fun";
  if (resolutionSelect) resolutionSelect.value = "480p";

  await hooks.startConnection();

  try {
    const startCall = fetchCalls.find((entry) => entry.url === "/v1/function/video/start");
    assert.ok(startCall?.init?.body);
    const payload = JSON.parse(String(startCall.init.body)) as Record<string, unknown>;
    assert.equal(payload.aspect_ratio, "1:1");
    assert.equal(payload.preset, "fun");
    assert.equal(payload.resolution_name, "480p");
  } finally {
    eventSources[0]?.emitMessage("[DONE]");
  }
});

test("video extension keeps the selected preset even when prompt is empty", async () => {
  const { hooks, fetchCalls, eventSources, document } = loadVideoHooks();
  const presetSelect = document.getElementById("presetSelect");
  const editPromptInput = document.getElementById("editPromptInput");

  if (presetSelect) presetSelect.value = "custom";
  if (editPromptInput) editPromptInput.value = "";

  hooks.setState({
    selectedVideoUrl: "https://example.com/images/source-video",
    currentExtendPostId: "abcd1234abcd1234abcd1234abcd1234",
    originalFileAttachmentId: "orig1234orig1234orig1234orig1234",
    lockedTimestampMs: 2500,
  });

  await hooks.runExtendVideo();

  try {
    const startCall = fetchCalls.filter((entry) => entry.url === "/v1/function/video/start").at(-1);
    assert.ok(startCall?.init?.body);
    const payload = JSON.parse(String(startCall.init.body)) as Record<string, unknown>;
    assert.equal(payload.preset, "custom");
  } finally {
    eventSources[0]?.emitMessage("[DONE]");
  }
});

test("video workspace AI upscale replaces the selected source with the upscaled video url", async () => {
  const { hooks, document } = loadVideoHooks();
  const upscaleBtn = document.getElementById("upscaleBtn");

  hooks.setState({
    selectedVideoUrl: "https://example.com/images/source-video",
    currentExtendPostId: "abcd1234abcd1234abcd1234abcd1234",
    originalFileAttachmentId: "orig1234orig1234orig1234orig1234",
    lockedTimestampMs: 2500,
  });

  upscaleBtn?.click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const state = hooks.getState();
  assert.equal(state.selectedVideoUrl, "/images/u_upscaled-video");
});
