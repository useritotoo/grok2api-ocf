(() => {
  const enhanceStateMap = new WeakMap();
  const enhanceRequestMap = new WeakMap();

  const ICONS = {
    enhance:
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.75 5.25L19 10l-5.25 1.75L12 17l-1.75-5.25L5 10l5.25-1.75L12 3z"></path><path d="M19 4v4"></path><path d="M21 6h-4"></path></svg>',
    clear:
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6L6 18"></path><path d="M6 6l12 12"></path></svg>',
    stop:
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>',
  };

  function toast(message, type) {
    if (typeof window.showToast === "function") {
      window.showToast(message, type);
    }
  }

  function injectStyles() {
    if (document.getElementById("promptEnhancerStyle")) return;
    const style = document.createElement("style");
    style.id = "promptEnhancerStyle";
    style.textContent = `
      .prompt-enhance-wrap {
        position: relative;
        width: 100%;
      }
      .prompt-enhance-wrap > textarea {
        padding-bottom: 52px;
      }
      .prompt-enhance-actions {
        position: absolute;
        right: 10px;
        bottom: 10px;
        z-index: 5;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        pointer-events: auto;
      }
      .prompt-enhance-actions.has-toggle {
        gap: 0;
        border: 1px solid rgba(95, 112, 135, 0.85);
        border-radius: 10px;
        overflow: hidden;
        background: var(--bg);
        box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08);
      }
      .prompt-enhance-btn,
      .prompt-lang-toggle-btn {
        border: 1px solid rgba(95, 112, 135, 0.85);
        background: rgba(255, 255, 255, 0.96);
        color: var(--fg);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: border-color .15s ease, background .15s ease, transform .15s ease;
      }
      .prompt-enhance-btn {
        width: 36px;
        height: 36px;
        border-radius: 10px;
        padding: 0;
      }
      .prompt-enhance-btn svg {
        width: 20px;
        height: 20px;
      }

      .prompt-lang-toggle-btn {
        display: none;
        width: 34px;
        height: 36px;
        border-radius: 0;
        border: 0;
        border-right: 1px solid rgba(95, 112, 135, 0.65);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: .04em;
      }
      .prompt-enhance-actions.has-toggle > .prompt-enhance-btn {
        border: 0;
        border-radius: 0;
      }
      .prompt-lang-toggle-btn.is-visible {
        display: inline-flex;
      }
      .prompt-enhance-btn:hover,
      .prompt-lang-toggle-btn:hover {
        background: #e7eef8;
      }
      .prompt-enhance-btn:active,
      .prompt-lang-toggle-btn:active {
        transform: translateY(1px);
        background: #dce7f6;
      }
      .prompt-enhance-btn:disabled,
      .prompt-lang-toggle-btn:disabled {
        opacity: .5;
        cursor: not-allowed;
        transform: none;
      }
      html[data-theme='dark'] .prompt-enhance-actions.has-toggle {
        background: #111821;
        border-color: #607286;
        box-shadow: 0 10px 30px rgba(2, 6, 23, 0.3);
      }
      html[data-theme='dark'] .prompt-enhance-btn,
      html[data-theme='dark'] .prompt-lang-toggle-btn {
        background: rgba(17, 24, 33, 0.96);
        border-color: #607286;
        color: var(--fg);
      }
      html[data-theme='dark'] .prompt-lang-toggle-btn {
        border-right-color: #46566a;
      }
      html[data-theme='dark'] .prompt-enhance-btn:hover,
      html[data-theme='dark'] .prompt-lang-toggle-btn:hover {
        background: #1a2330;
      }
      html[data-theme='dark'] .prompt-enhance-btn:active,
      html[data-theme='dark'] .prompt-lang-toggle-btn:active {
        background: #233041;
      }
    `;
    document.head.appendChild(style);
  }

  function isPromptTextarea(element) {
    if (!(element instanceof HTMLTextAreaElement)) return false;
    if (element.readOnly) return false;
    if (String(element.dataset.promptEnhancer || "").toLowerCase() === "off") return false;
    const id = String(element.id || "").toLowerCase();
    return id.includes("prompt");
  }

  function newRequestId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return `enh_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  }

  function extractMentionTokens(text) {
    const tokens = String(text || "").match(/@Image\s+\d+|@[0-9a-fA-F-]{32,36}/g) || [];
    const unique = [];
    const seen = new Set();
    tokens.forEach((token) => {
      const value = String(token || "").trim();
      if (!value || seen.has(value)) return;
      seen.add(value);
      unique.push(value);
    });
    return unique;
  }

  function encodePromptMentions(text) {
    const raw = String(text || "");
    const tokens = extractMentionTokens(raw);
    if (!tokens.length) {
      return { text: raw, tokens: [], placeholders: [] };
    }
    let encoded = raw;
    const placeholders = [];
    tokens.forEach((token, index) => {
      const placeholder = `[[IMAGE_TAG_${index + 1}]]`;
      placeholders.push(placeholder);
      encoded = encoded.replaceAll(token, placeholder);
    });
    return { text: encoded, tokens, placeholders };
  }

  function restorePromptMentions(text, mentionState) {
    const raw = String(text || "");
    const tokens = Array.isArray(mentionState && mentionState.tokens) ? mentionState.tokens : [];
    const placeholders = Array.isArray(mentionState && mentionState.placeholders) ? mentionState.placeholders : [];
    if (!tokens.length || !placeholders.length) return raw;
    let restored = raw;
    placeholders.forEach((placeholder, index) => {
      const token = tokens[index] || "";
      if (!placeholder || !token) return;
      restored = restored.replaceAll(placeholder, token);
    });
    return restored;
  }

  function parseEnhancedPrompt(text) {
    const raw = String(text || "").trim();
    if (!raw) {
      return { en: "", zh: "", tail: "", raw: "" };
    }

    const finalLabelRe = /(?:^|\n)\s{0,3}(?:#{1,6}\s*)?(?:Final Prompt(?:\s*[\(\uff08]EN[\)\uff09])?|最终提示词(?:\s*[\(\uff08]EN[\)\uff09])?)\s*:?\s*/i;
    const zhLabelRe = /(?:^|\n)\s{0,3}(?:#{1,6}\s*)?(?:中文参考版(?:\s*[\(\uff08]CN[\)\uff09])?|Chinese Reference(?: Version)?)\s*:?\s*/i;
    const tailLabelRe = /(?:^|\n)\s{0,3}(?:#{1,6}\s*)?(?:可调参数|Tunable Parameters?)\s*:?\s*/i;

    const finalMatch = finalLabelRe.exec(raw);
    const zhMatch = zhLabelRe.exec(raw);
    const tailMatch = tailLabelRe.exec(raw);

    if (!finalMatch) {
      return { en: "", zh: "", tail: "", raw };
    }

    const finalStart = finalMatch.index + finalMatch[0].length;
    const zhStart = zhMatch ? zhMatch.index + zhMatch[0].length : -1;
    const tailStart = tailMatch ? tailMatch.index + tailMatch[0].length : -1;

    const enEnd = zhMatch ? zhMatch.index : tailMatch ? tailMatch.index : raw.length;
    const zhEnd = tailMatch ? tailMatch.index : raw.length;

    return {
      en: raw.slice(finalStart, enEnd).trim(),
      zh: zhStart >= 0 ? raw.slice(zhStart, zhEnd).trim() : "",
      tail: tailStart >= 0 ? raw.slice(tailStart).trim() : "",
      raw,
    };
  }

  function applyPromptToTextarea(textarea, value) {
    textarea.value = value;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function callEnhanceApi(rawPrompt, signal, authHeader, requestId) {
    const response = await fetch("/v1/function/prompt/enhance", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...window.buildAuthHeaders(authHeader),
      },
      body: JSON.stringify({
        prompt: rawPrompt,
        temperature: 0.7,
        request_id: requestId,
      }),
      signal,
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      payload = null;
    }

    if (!response.ok) {
      const message = String((payload && (payload.error || payload.message)) || "").trim();
      throw new Error(message || `enhance_failed_${response.status}`);
    }

    const text = String((payload && payload.enhanced_prompt) || "").trim();
    if (!text) {
      throw new Error("enhance_empty_response");
    }
    return text;
  }

  function requestEnhanceStop(meta) {
    if (!meta || !meta.requestId || !meta.authHeader) return;
    fetch("/v1/function/prompt/enhance/stop", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...window.buildAuthHeaders(meta.authHeader),
      },
      body: JSON.stringify({ request_id: meta.requestId }),
    }).catch(() => {});
  }

  function setToggleButtonText(toggleButton, mode) {
    toggleButton.textContent = mode === "en" ? "CN" : "EN";
    toggleButton.title = mode === "en" ? "切换到中文参考版" : "Switch to English prompt";
  }

  function setToggleButtonVisible(toggleButton, visible) {
    toggleButton.classList.toggle("is-visible", Boolean(visible));
  }

  function syncActionGroupState(actionWrap, toggleButton) {
    actionWrap.classList.toggle("has-toggle", toggleButton.classList.contains("is-visible"));
  }

  function setEnhanceButtonMode(button, mode) {
    button.dataset.mode = mode;
    if (mode === "clear") {
      button.innerHTML = ICONS.clear;
      button.setAttribute("aria-label", "清空增强结果");
      button.title = "清空增强结果";
      return;
    }
    button.innerHTML = ICONS.enhance;
    button.setAttribute("aria-label", "增强提示词");
    button.title = "增强提示词";
  }

  function setEnhanceRunning(textarea, button, toggleButton, actionWrap, running) {
    button.dataset.running = running ? "1" : "0";
    if (running) {
      button.innerHTML = ICONS.stop;
      button.setAttribute("aria-label", "中止增强");
      button.title = "中止增强";
      toggleButton.disabled = true;
      syncActionGroupState(actionWrap, toggleButton);
      return;
    }
    toggleButton.disabled = false;
    setEnhanceButtonMode(button, String(button.dataset.mode || "enhance"));
    enhanceRequestMap.delete(textarea);
    syncActionGroupState(actionWrap, toggleButton);
  }

  function resetEnhancerState(textarea, button, toggleButton, actionWrap) {
    enhanceStateMap.delete(textarea);
    setToggleButtonVisible(toggleButton, false);
    setToggleButtonText(toggleButton, "en");
    setEnhanceButtonMode(button, "enhance");
    syncActionGroupState(actionWrap, toggleButton);
  }

  function applyEnhancedByMode(textarea, toggleButton, mode) {
    const state = enhanceStateMap.get(textarea);
    if (!state) return;
    const nextMode = mode === "zh" && state.zh ? "zh" : "en";
    const nextValue = nextMode === "zh" ? (state.zh || state.raw) : (state.en || state.raw);
    state.mode = nextMode;
    enhanceStateMap.set(textarea, state);
    setToggleButtonText(toggleButton, nextMode);
    applyPromptToTextarea(textarea, nextValue);
  }

  function cancelEnhance(textarea) {
    const requestMeta = enhanceRequestMap.get(textarea);
    if (!requestMeta) return;
    if (requestMeta.controller) {
      requestMeta.controller.abort();
    }
    requestEnhanceStop(requestMeta);
  }

  async function onEnhanceClick(textarea, button, toggleButton, actionWrap) {
    if (String(button.dataset.running || "0") === "1") {
      cancelEnhance(textarea);
      toast("已取消提示词增强", "warning");
      return;
    }

    if (String(button.dataset.mode || "enhance") === "clear") {
      applyPromptToTextarea(textarea, "");
      resetEnhancerState(textarea, button, toggleButton, actionWrap);
      toast("已清空提示词", "success");
      return;
    }

    const raw = String(textarea.value || "").trim();
    if (!raw) {
      toast("请先输入提示词", "warning");
      return;
    }

    if (typeof window.ensureFunctionKey !== "function" || typeof window.buildAuthHeaders !== "function") {
      toast("鉴权脚本未加载", "error");
      return;
    }

    const authHeader = await window.ensureFunctionKey();
    if (authHeader === null) {
      toast("请先配置 Function Key", "error");
      return;
    }

    const mentionState = encodePromptMentions(raw);
    const controller = new AbortController();
    const requestId = newRequestId();
    enhanceRequestMap.set(textarea, {
      controller,
      authHeader,
      requestId,
    });
    setEnhanceRunning(textarea, button, toggleButton, actionWrap, true);

    try {
      const enhanced = await callEnhanceApi(mentionState.text, controller.signal, authHeader, requestId);
      const parsed = parseEnhancedPrompt(enhanced);
      const restored = {
        en: restorePromptMentions(parsed.en, mentionState),
        zh: restorePromptMentions(parsed.zh, mentionState),
        tail: restorePromptMentions(parsed.tail, mentionState),
        raw: restorePromptMentions(parsed.raw, mentionState),
      };
      const hasDualLanguage = Boolean(restored.en && restored.zh);
      const nextState = {
        ...restored,
        mode: "en",
      };
      enhanceStateMap.set(textarea, nextState);

      if (hasDualLanguage) {
        setToggleButtonVisible(toggleButton, true);
        applyEnhancedByMode(textarea, toggleButton, "en");
      } else {
        setToggleButtonVisible(toggleButton, false);
        applyPromptToTextarea(textarea, restored.raw);
      }

      setEnhanceButtonMode(button, "clear");
      syncActionGroupState(actionWrap, toggleButton);
      toast("提示词已增强", "success");
    } catch (error) {
      if (error && error.name === "AbortError") {
        toast("已取消提示词增强", "warning");
        return;
      }
      const message = String((error && error.message) || error || "enhance_failed");
      toast(`提示词增强失败：${message}`, "error");
    } finally {
      setEnhanceRunning(textarea, button, toggleButton, actionWrap, false);
    }
  }

  function mountEnhancer(textarea) {
    if (!isPromptTextarea(textarea)) return;
    if (textarea.dataset.promptEnhancerMounted === "1") return;
    const parent = textarea.parentElement;
    if (!parent) return;

    const wrapper = document.createElement("div");
    wrapper.className = "prompt-enhance-wrap";
    parent.insertBefore(wrapper, textarea);
    wrapper.appendChild(textarea);

    const actionWrap = document.createElement("div");
    actionWrap.className = "prompt-enhance-actions";
    wrapper.appendChild(actionWrap);

    const toggleButton = document.createElement("button");
    toggleButton.type = "button";
    toggleButton.className = "prompt-lang-toggle-btn";
    setToggleButtonText(toggleButton, "en");
    setToggleButtonVisible(toggleButton, false);
    toggleButton.addEventListener("click", () => {
      const state = enhanceStateMap.get(textarea);
      if (!state) {
        toast("请先增强提示词", "warning");
        return;
      }
      const nextMode = (state.mode || "en") === "en" ? "zh" : "en";
      applyEnhancedByMode(textarea, toggleButton, nextMode);
    });
    actionWrap.appendChild(toggleButton);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "prompt-enhance-btn";
    setEnhanceButtonMode(button, "enhance");
    button.addEventListener("click", () => onEnhanceClick(textarea, button, toggleButton, actionWrap));
    actionWrap.appendChild(button);

    textarea.dataset.promptEnhancerMounted = "1";
  }

  function init() {
    injectStyles();
    Array.from(document.querySelectorAll("textarea")).forEach((textarea) => mountEnhancer(textarea));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
