// src/discovery-injected.ts
(function() {
  if (typeof window.__harbor !== "undefined") return;
  const extensionId = document.documentElement.getAttribute("data-harbor-extension-id") || "unknown";
  Object.defineProperty(window, "__harbor", {
    value: Object.freeze({
      version: "0.1.0",
      extensionId,
      installed: true
    }),
    writable: false,
    configurable: false,
    enumerable: true
  });
  window.dispatchEvent(new CustomEvent("harbor-discovered", {
    detail: { version: "0.1.0", extensionId }
  }));
})();
//# sourceMappingURL=discovery-injected.js.map
