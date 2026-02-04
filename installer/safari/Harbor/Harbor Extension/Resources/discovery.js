// src/browser-compat.ts
var browserAPI = typeof browser !== "undefined" ? browser : chrome;

// src/discovery.ts
function injectDiscoveryInfo() {
  document.documentElement.setAttribute("data-harbor-extension-id", browserAPI.runtime.id);
  const script = document.createElement("script");
  script.src = browserAPI.runtime.getURL("discovery-injected.js");
  script.async = false;
  script.onload = () => script.remove();
  script.onerror = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
}
injectDiscoveryInfo();
//# sourceMappingURL=discovery.js.map
