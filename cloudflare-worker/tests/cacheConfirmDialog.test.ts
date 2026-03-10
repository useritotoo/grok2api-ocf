import assert from "node:assert/strict";
import fs from "node:fs";
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
  returnValue = "";
  style: Record<string, string> = {};
  private _id = "";
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  classList: {
    add: (name: string) => void;
    remove: (name: string) => void;
    contains: (name: string) => boolean;
    toggle: (name: string, force?: boolean) => void;
  };

  constructor(tagName: string, ownerDocument: FakeDocument | null) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.classList = {
      add: (name: string) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean));
        set.add(name);
        this.className = Array.from(set).join(" ");
      },
      remove: (name: string) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean));
        set.delete(name);
        this.className = Array.from(set).join(" ");
      },
      contains: (name: string) => {
        return this.className.split(/\s+/).includes(name);
      },
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

  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
    if (name === "id") this.id = String(value);
    if (name === "class") this.className = String(value);
  }

  getAttribute(name: string) {
    if (name === "id") return this.id;
    if (name === "class") return this.className;
    return this.attributes.get(name) ?? null;
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
    const idx = this.children.indexOf(child);
    if (idx >= 0) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  addEventListener(type: string, handler: (...args: unknown[]) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  close(value?: string) {
    this.returnValue = value ?? "";
  }

  showModal() {
    // noop for tests
  }

  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string) {
    const results: FakeElement[] = [];
    const matches = (el: FakeElement) => {
      if (selector.startsWith("#")) return el.id === selector.slice(1);
      if (selector.startsWith(".")) {
        return el.className.split(/\s+/).includes(selector.slice(1));
      }
      return el.tagName.toLowerCase() === selector.toLowerCase();
    };
    const walk = (el: FakeElement) => {
      for (const child of el.children) {
        if (matches(child)) results.push(child);
        walk(child);
      }
    };
    walk(this);
    return results;
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

function buildDialog(document: FakeDocument) {
  const dialog = document.createElement("dialog");
  dialog.id = "confirm-dialog";
  const body = document.createElement("div");
  body.className = "confirm-dialog-body";
  const actions = document.createElement("div");
  actions.className = "confirm-dialog-actions";
  const cancel = document.createElement("button");
  cancel.id = "confirm-cancel";
  actions.appendChild(cancel);
  body.appendChild(actions);
  dialog.appendChild(body);
  document.body.appendChild(dialog);
  return dialog;
}

test("setupConfirmDialog recreates confirm button when missing", () => {
  const document = new FakeDocument();
  buildDialog(document);
  const window = { document } as Record<string, unknown>;
  const context = vm.createContext({
    document,
    window,
    console,
    t: (key: string) => (key === "common.ok" ? "OK" : "Cancel"),
  });

  const scriptUrl = new URL(
    "../../_public/static/admin/js/cache.js",
    import.meta.url,
  );
  const code = fs.readFileSync(scriptUrl, "utf8");
  vm.runInContext(code, context);

  const cacheUI = context.cacheUI as (() => void) | undefined;
  const setupConfirmDialog = context.setupConfirmDialog as (() => void) | undefined;
  assert.equal(typeof cacheUI, "function");
  assert.equal(typeof setupConfirmDialog, "function");
  cacheUI?.();
  setupConfirmDialog?.();

  const okButton = document.getElementById("confirm-ok");
  assert.ok(okButton, "Expected confirm-ok button to exist");
  assert.equal(okButton?.textContent, "OK");
});
