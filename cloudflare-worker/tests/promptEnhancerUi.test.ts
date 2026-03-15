import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

test("prompt enhancer icons keep a 20px footprint in the function pages", () => {
  const scriptPath = path.resolve(import.meta.dirname, "../../_public/static/common/js/prompt-enhancer.js");
  const source = fs.readFileSync(scriptPath, "utf8");

  assert.match(source, /<svg width="20" height="20"/);
  assert.match(source, /\.prompt-enhance-btn svg\s*\{\s*width:\s*20px;\s*height:\s*20px;\s*\}/);
});

test("prompt enhancer strips formatting html tags from enhanced prompt results", () => {
  const scriptPath = path.resolve(import.meta.dirname, "../../_public/static/common/js/prompt-enhancer.js");
  const source = fs.readFileSync(scriptPath, "utf8");
  const instrumented = source.replace(
    /\}\)\(\);\s*$/,
    `
window.__promptEnhancerTestHooks = {
  sanitizeEnhancedPromptText,
};
})();
`,
  );

  const documentStub = {
    readyState: "loading",
    head: { appendChild() {} },
    getElementById() {
      return null;
    },
    createElement() {
      return {
        id: "",
        textContent: "",
        style: {},
        appendChild() {},
        setAttribute() {},
        addEventListener() {},
        classList: { toggle() {}, contains() { return false; } },
      };
    },
    querySelectorAll() {
      return [];
    },
    addEventListener() {},
  };
  const context = vm.createContext({
    window: {},
    document: documentStub,
    console,
    WeakMap,
    Event,
  });
  context.window = context;

  vm.runInContext(instrumented, context);

  const hooks = (context.window as any).__promptEnhancerTestHooks;
  const sanitized = hooks.sanitizeEnhancedPromptText(
    "<pre>Shot 1</pre><div>Shot 2</div><br><strong>Shot 3</strong>",
  );

  assert.equal(String(sanitized).includes("<pre>"), false);
  assert.equal(String(sanitized).includes("<div>"), false);
  assert.equal(String(sanitized).includes("<strong>"), false);
  assert.match(String(sanitized), /Shot 1/);
  assert.match(String(sanitized), /Shot 2/);
  assert.match(String(sanitized), /Shot 3/);
});
