// src/js-runtime/worker-loader.ts
globalThis.addEventListener("message", function initHandler(event) {
  if (event.data?.type === "load-code") {
    globalThis.removeEventListener("message", initHandler);
    const code = event.data.code;
    try {
      const fn = new Function(code);
      fn();
    } catch (e) {
      postMessage({
        type: "error",
        message: e instanceof Error ? e.message : String(e)
      });
    }
  }
});
postMessage({ type: "loader-ready" });
//# sourceMappingURL=worker-loader.js.map
