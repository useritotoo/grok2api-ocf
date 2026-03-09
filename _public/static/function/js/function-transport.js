(function (globalScope, factory) {
  const exported = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = exported;
  }
  globalScope.FunctionTransport = exported;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function isLocalDevelopmentHost(host) {
    const value = String(host || "").trim().toLowerCase();
    if (!value) return false;
    return (
      value === "localhost" ||
      value.startsWith("localhost:") ||
      value === "127.0.0.1" ||
      value.startsWith("127.0.0.1:") ||
      value === "[::1]" ||
      value.startsWith("[::1]:")
    );
  }

  function getWebSocketProtocol(protocol, host) {
    if (String(protocol || "").toLowerCase() === "https:") return "wss";
    return isLocalDevelopmentHost(host) ? "ws" : "wss";
  }

  function buildImagineWsUrl(args) {
    const protocol = getWebSocketProtocol(args && args.protocol, args && args.host);
    const params = new URLSearchParams();
    params.set("task_id", String((args && args.taskId) || "").trim());
    const functionKey = String((args && args.functionKey) || "").trim();
    if (functionKey) {
      params.set("function_key", functionKey);
    }
    return `${protocol}://${String((args && args.host) || "").trim()}/v1/function/imagine/ws?${params.toString()}`;
  }

  return {
    isLocalDevelopmentHost: isLocalDevelopmentHost,
    getWebSocketProtocol: getWebSocketProtocol,
    buildImagineWsUrl: buildImagineWsUrl,
  };
});
