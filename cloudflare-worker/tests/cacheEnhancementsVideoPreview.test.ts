import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

class FakeElement {
  tagName: string;
  ownerDocument: FakeDocument | null;
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  attributes = new Map<string, string>();
  className = "";
  textContent = "";
  style: Record<string, string> = {};
  title = "";
  src = "";
  alt = "";
  autoplay = false;
  controls = false;
  muted = false;
  playsInline = false;
  tabIndex = 0;
  loading = "";
  decoding = "";
  preload = "";
  type = "";
  private _id = "";
  private _innerHTML = "";
  private listeners = new Map<string, Array<(event?: any) => void>>();
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
    this.attributes.set("id", this._id);
    this.ownerDocument?.registerElement(this);
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value: string) {
    this._innerHTML = String(value);
    this.children = [];
  }

  setAttribute(name: string, value: string) {
    const normalized = String(value);
    this.attributes.set(name, normalized);
    if (name === "id") this.id = normalized;
    if (name === "class") this.className = normalized;
    if (name === "src") this.src = normalized;
  }

  getAttribute(name: string) {
    if (name === "id") return this.id;
    if (name === "class") return this.className;
    if (name === "src") return this.src || this.attributes.get(name) || null;
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
    if (name === "class") this.className = "";
    if (name === "src") this.src = "";
  }

  appendChild(child: FakeElement) {
    if (child.parentNode) child.parentNode.removeChild(child);
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

  replaceChildren(...nodes: FakeElement[]) {
    this.children = [];
    nodes.forEach((node) => this.appendChild(node));
  }

  addEventListener(type: string, handler: (event?: any) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  click() {
    const handlers = this.listeners.get("click") ?? [];
    handlers.forEach((handler) =>
      handler({
        target: this,
        currentTarget: this,
        stopPropagation() {
          // no-op
        },
      }),
    );
  }

  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string) {
    const results: FakeElement[] = [];
    const matches = (element: FakeElement) => {
      if (selector.startsWith(".")) return element.classList.contains(selector.slice(1));
      if (selector.startsWith("#")) return element.id === selector.slice(1);
      return element.tagName.toLowerCase() === selector.toLowerCase();
    };
    const visit = (element: FakeElement) => {
      element.children.forEach((child) => {
        if (matches(child)) results.push(child);
        visit(child);
      });
    };
    visit(this);
    return results;
  }
}

class FakeDocument {
  private elementsById = new Map<string, FakeElement>();
  body: FakeElement;
  private listeners = new Map<string, Array<(event?: any) => void>>();

  constructor() {
    this.body = new FakeElement("body", this);
  }

  registerElement(element: FakeElement) {
    if (element.id) this.elementsById.set(element.id, element);
  }

  createElement(tagName: string) {
    return new FakeElement(tagName, this);
  }

  createDocumentFragment() {
    return new FakeElement("#fragment", this);
  }

  getElementById(id: string) {
    return this.elementsById.get(id) ?? null;
  }

  addEventListener(type: string, handler: (event?: any) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }
}

function createUiShell(document: FakeDocument) {
  ["cache-lightbox", "cache-lightbox-body", "cache-lightbox-caption", "cache-lightbox-close"].forEach((id) => {
    const element = document.createElement(id === "cache-lightbox-caption" ? "div" : "button");
    element.id = id;
    document.body.appendChild(element);
  });
}

test("video cache cards stay unloaded until the user opens a specific preview", () => {
  const document = new FakeDocument();
  createUiShell(document);

  const windowObject: Record<string, any> = { document };
  const context = vm.createContext({
    window: windowObject,
    document,
    console,
    ui: {},
    cacheUI: () => {},
    byId: (id: string) => document.getElementById(id),
    t: (key: string) => key,
    selectedLocal: { image: new Set<string>(), video: new Set<string>() },
    selectedTokens: new Set<string>(),
    accountMap: new Map<string, unknown>(),
    accountStates: new Map<string, unknown>(),
    cacheListState: {
      image: { visible: false, loaded: false, items: [], total: 0, page: 1, pageSize: 24, loading: false },
      video: { visible: true, loaded: false, items: [], total: 0, page: 1, pageSize: 24, loading: false },
    },
    currentSection: "video",
    formatSize: () => "1 MB",
    formatTime: () => "2026-03-15 00:00:00",
    toggleLocalSelect: () => {},
    deleteLocalFile: () => {},
    syncLocalSelectAllState: () => {},
    updateLocalPaginationUI: () => {},
    updateSelectedCount: () => {},
    getLocalState: () => ({ page: 1, pageSize: 24, total: 0, items: [], loaded: false, loading: false }),
    getLocalPaginationRefs: () => ({ size: null }),
    buildAuthHeaders: () => ({}),
    ensureUI: () => {},
    showToast: () => {},
    logout: () => {},
    setText: () => {},
    setOnlineStatus: () => {},
    resolveOnlineStatus: () => ({ text: "", className: "" }),
    ensureAdminKey: async () => "admin",
    loadStats: async () => null,
    renderAccountTable: () => {},
    syncRowCheckboxes: () => {},
    syncSelectAllState: () => {},
    toggleSelect: () => {},
    syncLocalRowCheckboxes: () => {},
    clearOnlineCache: async () => {},
    clearCache: async () => {},
    loadLocalCacheList: async () => {},
    showCacheSection: async () => {},
    setupLocalPaginationControls: () => {},
    setupOnlinePaginationControls: () => {},
    setupCacheCards: () => {},
    updateToolbarForSection: () => {},
    setActionButtonsState: () => {},
    updateBatchActionsVisibility: () => {},
    confirmAction: async () => true,
    fetch: async () => new Response("{}"),
    URLSearchParams,
    Response,
    Request,
    Headers,
    setTimeout,
    clearTimeout,
  });

  const scriptPath = path.resolve(import.meta.dirname, "../../_public/static/admin/js/cache-enhancements.js");
  const source = fs.readFileSync(scriptPath, "utf8");
  const instrumented = source.replace(
    /  window\.onload = init;\r?\n\}\)\(\);/,
    "  window.__cacheEnhancementHooks = { buildLocalMediaPreview, openCacheLightbox, getLocalMediaUrl };\n  window.onload = init;\n})();",
  );
  vm.runInContext(instrumented, context);

  const hooks = windowObject.__cacheEnhancementHooks as {
    buildLocalMediaPreview: (type: string, item: { name: string }) => FakeElement;
    getLocalMediaUrl: (type: string, item: { name: string }) => string;
  };

  assert.equal(typeof hooks.buildLocalMediaPreview, "function");
  assert.equal(hooks.getLocalMediaUrl("video", { name: "clip.mp4" }), "/images/clip.mp4");

  const preview = hooks.buildLocalMediaPreview("video", { name: "clip.mp4" });
  assert.equal(preview.querySelector("video"), null);
  assert.ok(preview.querySelector(".cache-preview-icon"));
  assert.equal(preview.querySelector(".cache-preview-label")?.textContent, "VIDEO");

  preview.click();

  const lightbox = document.getElementById("cache-lightbox");
  const lightboxBody = document.getElementById("cache-lightbox-body");
  const lightboxVideo = lightboxBody?.querySelector("video");
  assert.ok(lightbox?.classList.contains("active"));
  assert.ok(lightboxVideo);
  assert.equal(lightboxVideo?.src, "/images/clip.mp4");
});
