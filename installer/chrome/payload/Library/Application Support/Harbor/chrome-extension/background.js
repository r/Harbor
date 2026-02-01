var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/browser-compat.ts
function getExtensionURL(path) {
  if (browserAPI.runtime?.getURL) {
    return browserAPI.runtime.getURL(path);
  }
  return path;
}
function isFirefox() {
  return typeof browser !== "undefined" && navigator.userAgent.includes("Firefox");
}
function isChrome() {
  return typeof browser === "undefined" && typeof chrome !== "undefined";
}
function isSafari() {
  return typeof browser !== "undefined" && navigator.userAgent.includes("Safari") && !navigator.userAgent.includes("Chrome");
}
function hasFirefoxML() {
  if (typeof browser === "undefined") return false;
  const trial = browser.trial;
  return !!trial && !!trial.ml;
}
function hasFirefoxWllama() {
  if (typeof browser === "undefined") return false;
  const trial = browser.trial;
  return !!trial?.ml?.wllama;
}
function hasSidebar() {
  return typeof browser !== "undefined" && "sidebarAction" in browser;
}
function isServiceWorker() {
  return typeof ServiceWorkerGlobalScope !== "undefined" && self instanceof ServiceWorkerGlobalScope;
}
function hasScriptingAPI() {
  return "scripting" in browserAPI;
}
function getBrowserName() {
  if (isFirefox()) return "firefox";
  if (isSafari()) return "safari";
  if (isChrome()) return "chrome";
  return "unknown";
}
function hasOmnibox() {
  return "omnibox" in browserAPI;
}
function hasExternalMessaging() {
  return "onMessageExternal" in browserAPI.runtime;
}
function hasWebNavigation() {
  return "webNavigation" in browserAPI;
}
function isManifestV3() {
  return browserAPI.runtime.getManifest().manifest_version === 3;
}
function getFeatureSummary() {
  return {
    browser: getBrowserName(),
    isServiceWorker: isServiceWorker(),
    isManifestV3: isManifestV3(),
    hasSidebar: hasSidebar(),
    hasOmnibox: hasOmnibox(),
    hasFirefoxML: hasFirefoxML(),
    hasFirefoxWllama: hasFirefoxWllama(),
    hasScriptingAPI: hasScriptingAPI(),
    hasExternalMessaging: hasExternalMessaging(),
    hasWebNavigation: hasWebNavigation()
  };
}
var browserAPI, serviceWorkerLifecycle;
var init_browser_compat = __esm({
  "src/browser-compat.ts"() {
    "use strict";
    browserAPI = typeof browser !== "undefined" ? browser : chrome;
    serviceWorkerLifecycle = {
      /**
       * Register a startup handler that runs when the service worker starts.
       * This is useful for restoring state in Chrome MV3.
       */
      onStartup(handler) {
        if (browserAPI.runtime.onStartup) {
          browserAPI.runtime.onStartup.addListener(handler);
        }
      },
      /**
       * Register an install/update handler.
       * Runs on first install or extension update.
       */
      onInstalled(handler) {
        if (browserAPI.runtime.onInstalled) {
          browserAPI.runtime.onInstalled.addListener(handler);
        }
      },
      /**
       * Register a suspend handler (Chrome MV3 only).
       * Called when the service worker is about to be terminated.
       */
      onSuspend(handler) {
        if (isServiceWorker() && "onSuspend" in browserAPI.runtime) {
          browserAPI.runtime.onSuspend.addListener(handler);
        }
      },
      /**
       * Keep the service worker alive (Chrome MV3).
       * Use sparingly - Chrome will still terminate after 5 minutes.
       */
      keepAlive() {
        if (isServiceWorker()) {
          setInterval(() => {
            browserAPI.storage.local.get(null);
          }, 2e4);
        }
      }
    };
  }
});

// src/llm/native-bridge.ts
async function safariHttpRequest(method, params = {}) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  console.log("[Harbor:Safari] HTTP RPC request:", method, id);
  try {
    const response = await fetch(`${SAFARI_HTTP_BASE}/rpc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        id,
        method,
        params
      })
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${response.statusText} - ${text}`);
    }
    const data = await response.json();
    console.log("[Harbor:Safari] HTTP RPC response:", JSON.stringify(data).slice(0, 200));
    if (data && data.error) {
      const errorMsg = data.error.message || (typeof data.error === "string" ? data.error : JSON.stringify(data.error));
      throw new Error(errorMsg);
    }
    return data?.result ?? null;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("[Harbor:Safari] HTTP RPC error:", errorMsg);
    throw err instanceof Error ? err : new Error(errorMsg);
  }
}
async function safariCheckHttpServer() {
  try {
    console.log("[Harbor:Safari] Checking HTTP server at", SAFARI_HTTP_BASE);
    const response = await fetch(`${SAFARI_HTTP_BASE}/health`, {
      method: "GET"
    });
    console.log("[Harbor:Safari] Health check response:", response.ok, response.status);
    return response.ok;
  } catch (err) {
    console.error("[Harbor:Safari] Health check failed:", err);
    return false;
  }
}
async function checkSafariConnection() {
  try {
    const available = await safariCheckHttpServer();
    if (!available) {
      console.log("[Harbor:Safari] Bridge not available");
      updateState({
        connected: false,
        bridgeReady: false,
        error: "Harbor.app not running"
      });
      return;
    }
    if (connectionState.connected && connectionState.bridgeReady) {
      return;
    }
    console.log("[Harbor:Safari] HTTP server available, testing RPC...");
    const response = await safariHttpRequest("system.health", {});
    console.log("[Harbor:Safari] Health check response:", response);
    const wasDisconnected = !connectionState.connected;
    updateState({ connected: true, bridgeReady: true, error: null });
    if (wasDisconnected) {
      console.log("[Harbor:Safari] Bridge connected!");
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("[Harbor:Safari] Connection check failed:", errorMsg);
    updateState({
      connected: false,
      bridgeReady: false,
      error: `Safari: ${errorMsg}`
    });
  }
}
function getConnectionState() {
  return { ...connectionState };
}
function onConnectionStateChange(listener) {
  connectionListeners.push(listener);
  listener(connectionState);
  return () => {
    const idx = connectionListeners.indexOf(listener);
    if (idx >= 0) connectionListeners.splice(idx, 1);
  };
}
function notifyConnectionListeners() {
  for (const listener of connectionListeners) {
    listener(connectionState);
  }
}
function updateState(update) {
  connectionState = { ...connectionState, ...update };
  notifyConnectionListeners();
}
function handleMessage(message) {
  switch (message.type) {
    case "status":
      if (message.status === "ready" || message.status === "pong") {
        updateState({ connected: true, bridgeReady: true, error: null });
        connectionAttempts = 0;
      } else if (message.status === "error") {
        updateState({ connected: true, bridgeReady: false, error: message.message });
      }
      break;
    case "rpc_response": {
      const pending = pendingRequests.get(message.id);
      if (pending) {
        pendingRequests.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }
      break;
    }
    case "stream": {
      const stream = pendingStreams.get(message.id);
      if (stream) {
        stream.onEvent(message.event);
        if (message.event.type === "done" || message.event.type === "error") {
          pendingStreams.delete(message.id);
          if (message.event.type === "error" && message.event.error) {
            stream.onError(new Error(message.event.error.message));
          } else {
            stream.onComplete();
          }
        }
      }
      break;
    }
    case "console": {
      const level = message.level;
      console[level]?.(`[JS:${message.server_id}]`, message.message);
      for (const listener of consoleLogListeners) {
        try {
          listener(message.server_id, message.level, message.message);
        } catch (e) {
          console.error("[Harbor] Console log listener error:", e);
        }
      }
      break;
    }
  }
}
function connectNativeBridge() {
  if (useSafariMode) {
    console.log("[Harbor:Safari] Testing HTTP connection to harbor-bridge...");
    if (!safariPollInterval) {
      safariPollInterval = setInterval(checkSafariConnection, SAFARI_POLL_INTERVAL);
    }
    checkSafariConnection();
    return;
  }
  if (nativePort) {
    console.log("[Harbor] Native bridge already connected");
    return;
  }
  console.log("[Harbor] Connecting to native bridge...");
  connectionAttempts++;
  try {
    nativePort = browserAPI.runtime.connectNative(NATIVE_APP_ID);
    nativePort.onMessage.addListener((message) => {
      console.debug("[Harbor] Native message:", message.type);
      handleMessage(message);
    });
    nativePort.onDisconnect.addListener(() => {
      const error2 = browserAPI.runtime.lastError;
      const errorMessage = error2?.message || "Native bridge disconnected";
      console.log("[Harbor] Native bridge disconnected:", errorMessage);
      nativePort = null;
      for (const [id, pending] of pendingRequests) {
        pending.reject(new Error("Bridge disconnected"));
        pendingRequests.delete(id);
      }
      for (const [id, stream] of pendingStreams) {
        stream.onError(new Error("Bridge disconnected"));
        pendingStreams.delete(id);
      }
      updateState({
        connected: false,
        bridgeReady: false,
        error: errorMessage
      });
      if (connectionAttempts < MAX_CONNECTION_ATTEMPTS) {
        console.log(`[Harbor] Reconnecting in ${RECONNECT_DELAY}ms (attempt ${connectionAttempts}/${MAX_CONNECTION_ATTEMPTS})...`);
        setTimeout(connectNativeBridge, RECONNECT_DELAY);
      } else {
        console.log("[Harbor] Max reconnection attempts reached.");
        updateState({
          error: "Native bridge not installed. Run: cd bridge-rs && ./install.sh"
        });
      }
    });
    sendMessage({ type: "ping" });
    updateState({ connected: true, error: null });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Failed to connect to native bridge";
    console.error("[Harbor] Failed to connect to native bridge:", errorMessage);
    updateState({
      connected: false,
      bridgeReady: false,
      error: errorMessage
    });
  }
}
function sendMessage(message) {
  if (!nativePort) {
    console.warn("[Harbor] Cannot send message: not connected");
    return;
  }
  try {
    nativePort.postMessage(message);
  } catch (err) {
    console.error("[Harbor] Failed to send message:", err);
  }
}
async function rpcRequest(method, params) {
  if (useSafariMode) {
    if (!connectionState.bridgeReady) {
      throw new Error("Bridge not connected. Make sure Harbor.app is running.");
    }
    return safariHttpRequest(method, params ?? {});
  }
  if (!nativePort || !connectionState.bridgeReady) {
    throw new Error("Bridge not connected");
  }
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error("RPC request timed out"));
    }, 12e4);
    pendingRequests.set(id, {
      resolve: (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
      reject: (error2) => {
        clearTimeout(timeout);
        reject(error2);
      }
    });
    sendMessage({
      type: "rpc",
      id,
      method,
      params: params ?? {}
    });
  });
}
function rpcStreamRequest(method, params, onEvent) {
  if (useSafariMode) {
    if (!connectionState.bridgeReady) {
      const error2 = new Error("Bridge not connected. Make sure Harbor.app is running.");
      return {
        cancel: () => {
        },
        done: Promise.reject(error2)
      };
    }
    const id2 = crypto.randomUUID();
    let cancelled = false;
    const done2 = (async () => {
      try {
        const response = await safariHttpRequest(method, { ...params, safari_no_stream: true });
        if (cancelled) return;
        if (response?.content) {
          onEvent({
            id: id2,
            type: "token",
            token: response.content
          });
        }
        onEvent({
          id: id2,
          type: "done",
          finish_reason: response?.finish_reason || "stop",
          model: response?.model
        });
      } catch (err) {
        if (!cancelled) {
          onEvent({
            id: id2,
            type: "error",
            error: { code: -1, message: err instanceof Error ? err.message : String(err) }
          });
          throw err;
        }
      }
    })();
    return {
      cancel: () => {
        cancelled = true;
      },
      done: done2
    };
  }
  if (!nativePort || !connectionState.bridgeReady) {
    const error2 = new Error("Bridge not connected");
    return {
      cancel: () => {
      },
      done: Promise.reject(error2)
    };
  }
  const id = crypto.randomUUID();
  const done = new Promise((resolve, reject) => {
    pendingStreams.set(id, {
      onEvent,
      onComplete: resolve,
      onError: reject
    });
  });
  sendMessage({
    type: "rpc",
    id,
    method,
    params: params ?? {}
  });
  return {
    cancel: () => {
      pendingStreams.delete(id);
    },
    done
  };
}
function isNativeBridgeReady() {
  return connectionState.connected && connectionState.bridgeReady;
}
var NATIVE_APP_ID_DEFAULT, NATIVE_APP_ID_SAFARI, useSafariMode, NATIVE_APP_ID, SAFARI_HTTP_PORT, SAFARI_HTTP_BASE, nativePort, connectionAttempts, MAX_CONNECTION_ATTEMPTS, RECONNECT_DELAY, pendingRequests, pendingStreams, consoleLogListeners, connectionState, connectionListeners, safariPollInterval, SAFARI_POLL_INTERVAL;
var init_native_bridge = __esm({
  "src/llm/native-bridge.ts"() {
    "use strict";
    init_browser_compat();
    NATIVE_APP_ID_DEFAULT = "harbor_bridge";
    NATIVE_APP_ID_SAFARI = "org.harbor";
    useSafariMode = isSafari();
    NATIVE_APP_ID = useSafariMode ? NATIVE_APP_ID_SAFARI : NATIVE_APP_ID_DEFAULT;
    SAFARI_HTTP_PORT = 8766;
    SAFARI_HTTP_BASE = `http://127.0.0.1:${SAFARI_HTTP_PORT}`;
    nativePort = null;
    connectionAttempts = 0;
    MAX_CONNECTION_ATTEMPTS = 3;
    RECONNECT_DELAY = 2e3;
    pendingRequests = /* @__PURE__ */ new Map();
    pendingStreams = /* @__PURE__ */ new Map();
    consoleLogListeners = [];
    connectionState = {
      connected: false,
      bridgeReady: false,
      error: null
    };
    connectionListeners = [];
    safariPollInterval = null;
    SAFARI_POLL_INTERVAL = 3e3;
  }
});

// src/llm/bridge-client.ts
function getBridgeConnectionState() {
  return getConnectionState();
}
async function checkBridgeHealth() {
  try {
    const result = await bridgeRequest("system.health");
    return result.status === "ok";
  } catch {
    return false;
  }
}
function initializeBridgeClient() {
  console.log("[Harbor] Initializing bridge client via native messaging");
  connectNativeBridge();
  onConnectionStateChange((state) => {
    console.log("[Harbor] Bridge connection state:", state.bridgeReady ? "ready" : "not ready");
  });
}
async function bridgeRequest(method, params) {
  if (!isNativeBridgeReady()) {
    throw new Error("Bridge not connected. Ensure native bridge is installed and running.");
  }
  return rpcRequest(method, params);
}
async function* bridgeStreamRequest(method, params) {
  if (!isNativeBridgeReady()) {
    throw new Error("Bridge not connected. Ensure native bridge is installed and running.");
  }
  const eventQueue = [];
  let resolveWaiting = null;
  let done = false;
  let error2 = null;
  const { cancel, done: streamDone } = rpcStreamRequest(
    method,
    params,
    (event) => {
      if (resolveWaiting) {
        resolveWaiting(event);
        resolveWaiting = null;
      } else {
        eventQueue.push(event);
      }
    }
  );
  streamDone.then(() => {
    done = true;
    if (resolveWaiting) {
      resolveWaiting(null);
      resolveWaiting = null;
    }
  }).catch((e) => {
    error2 = e;
    done = true;
    if (resolveWaiting) {
      resolveWaiting(null);
      resolveWaiting = null;
    }
  });
  try {
    while (true) {
      if (eventQueue.length > 0) {
        const event2 = eventQueue.shift();
        yield event2;
        if (event2.type === "done" || event2.type === "error") {
          break;
        }
        continue;
      }
      if (done) {
        if (error2) {
          throw error2;
        }
        break;
      }
      const event = await new Promise((resolve) => {
        resolveWaiting = resolve;
      });
      if (event === null) {
        if (error2) {
          throw error2;
        }
        break;
      }
      yield event;
      if (event.type === "done" || event.type === "error") {
        break;
      }
    }
  } finally {
    cancel();
  }
}
var init_bridge_client = __esm({
  "src/llm/bridge-client.ts"() {
    "use strict";
    init_native_bridge();
  }
});

// src/mcp/stdio-transport.ts
var McpStdioTransport;
var init_stdio_transport = __esm({
  "src/mcp/stdio-transport.ts"() {
    "use strict";
    McpStdioTransport = class {
      constructor(endpoint) {
        this.endpoint = endpoint;
        this.endpoint.onData((data) => this.handleData(data));
      }
      encoder = new TextEncoder();
      decoder = new TextDecoder();
      buffer = "";
      pending = /* @__PURE__ */ new Map();
      async send(request) {
        const payload = JSON.stringify(request) + "\n";
        const data = this.encoder.encode(payload);
        return new Promise((resolve, reject) => {
          this.pending.set(request.id, { resolve, reject });
          this.endpoint.write(data);
        });
      }
      handleData(data) {
        this.buffer += this.decoder.decode(data, { stream: true });
        let newlineIndex = this.buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = this.buffer.slice(0, newlineIndex).trim();
          this.buffer = this.buffer.slice(newlineIndex + 1);
          if (line.length > 0) {
            this.handleLine(line);
          }
          newlineIndex = this.buffer.indexOf("\n");
        }
      }
      handleLine(line) {
        let message = null;
        try {
          message = JSON.parse(line);
        } catch (error2) {
          return;
        }
        if (!message?.id) {
          return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) {
          return;
        }
        this.pending.delete(message.id);
        pending.resolve(message);
      }
    };
  }
});

// node_modules/@wasmer/wasi/dist/Library.esm.min.js
function A(A2, I2, g2, B2) {
  return new (g2 || (g2 = Promise))(function(Q2, C2) {
    function E2(A3) {
      try {
        i2(B2.next(A3));
      } catch (A4) {
        C2(A4);
      }
    }
    function D2(A3) {
      try {
        i2(B2.throw(A3));
      } catch (A4) {
        C2(A4);
      }
    }
    function i2(A3) {
      var I3;
      A3.done ? Q2(A3.value) : (I3 = A3.value, I3 instanceof g2 ? I3 : new g2(function(A4) {
        A4(I3);
      })).then(E2, D2);
    }
    i2((B2 = B2.apply(A2, I2 || [])).next());
  });
}
function I(A2, I2) {
  var g2, B2, Q2, C2, E2 = { label: 0, sent: function() {
    if (1 & Q2[0]) throw Q2[1];
    return Q2[1];
  }, trys: [], ops: [] };
  return C2 = { next: D2(0), throw: D2(1), return: D2(2) }, "function" == typeof Symbol && (C2[Symbol.iterator] = function() {
    return this;
  }), C2;
  function D2(D3) {
    return function(i2) {
      return function(D4) {
        if (g2) throw new TypeError("Generator is already executing.");
        for (; C2 && (C2 = 0, D4[0] && (E2 = 0)), E2; ) try {
          if (g2 = 1, B2 && (Q2 = 2 & D4[0] ? B2.return : D4[0] ? B2.throw || ((Q2 = B2.return) && Q2.call(B2), 0) : B2.next) && !(Q2 = Q2.call(B2, D4[1])).done) return Q2;
          switch (B2 = 0, Q2 && (D4 = [2 & D4[0], Q2.value]), D4[0]) {
            case 0:
            case 1:
              Q2 = D4;
              break;
            case 4:
              return E2.label++, { value: D4[1], done: false };
            case 5:
              E2.label++, B2 = D4[1], D4 = [0];
              continue;
            case 7:
              D4 = E2.ops.pop(), E2.trys.pop();
              continue;
            default:
              if (!(Q2 = E2.trys, (Q2 = Q2.length > 0 && Q2[Q2.length - 1]) || 6 !== D4[0] && 2 !== D4[0])) {
                E2 = 0;
                continue;
              }
              if (3 === D4[0] && (!Q2 || D4[1] > Q2[0] && D4[1] < Q2[3])) {
                E2.label = D4[1];
                break;
              }
              if (6 === D4[0] && E2.label < Q2[1]) {
                E2.label = Q2[1], Q2 = D4;
                break;
              }
              if (Q2 && E2.label < Q2[2]) {
                E2.label = Q2[2], E2.ops.push(D4);
                break;
              }
              Q2[2] && E2.ops.pop(), E2.trys.pop();
              continue;
          }
          D4 = I2.call(A2, E2);
        } catch (A3) {
          D4 = [6, A3], B2 = 0;
        } finally {
          g2 = Q2 = 0;
        }
        if (5 & D4[0]) throw D4[1];
        return { value: D4[0] ? D4[1] : void 0, done: true };
      }([D3, i2]);
    };
  }
}
function Q(A2) {
  return B[A2];
}
function E(A2) {
  C === B.length && B.push(B.length + 1);
  const I2 = C;
  return C = B[I2], B[I2] = A2, I2;
}
function w() {
  return 0 === i.byteLength && (i = new Uint8Array(g.memory.buffer)), i;
}
function o(A2, I2) {
  return D.decode(w().subarray(A2, A2 + I2));
}
function G(A2) {
  const I2 = Q(A2);
  return function(A3) {
    A3 < 36 || (B[A3] = C, C = A3);
  }(A2), I2;
}
function N(A2) {
  const I2 = typeof A2;
  if ("number" == I2 || "boolean" == I2 || null == A2) return `${A2}`;
  if ("string" == I2) return `"${A2}"`;
  if ("symbol" == I2) {
    const I3 = A2.description;
    return null == I3 ? "Symbol" : `Symbol(${I3})`;
  }
  if ("function" == I2) {
    const I3 = A2.name;
    return "string" == typeof I3 && I3.length > 0 ? `Function(${I3})` : "Function";
  }
  if (Array.isArray(A2)) {
    const I3 = A2.length;
    let g3 = "[";
    I3 > 0 && (g3 += N(A2[0]));
    for (let B3 = 1; B3 < I3; B3++) g3 += ", " + N(A2[B3]);
    return g3 += "]", g3;
  }
  const g2 = /\[object ([^\]]+)\]/.exec(toString.call(A2));
  let B2;
  if (!(g2.length > 1)) return toString.call(A2);
  if (B2 = g2[1], "Object" == B2) try {
    return "Object(" + JSON.stringify(A2) + ")";
  } catch (A3) {
    return "Object";
  }
  return A2 instanceof Error ? `${A2.name}: ${A2.message}
${A2.stack}` : B2;
}
function Y(A2, I2, g2) {
  if (void 0 === g2) {
    const g3 = k.encode(A2), B3 = I2(g3.length);
    return w().subarray(B3, B3 + g3.length).set(g3), M = g3.length, B3;
  }
  let B2 = A2.length, Q2 = I2(B2);
  const C2 = w();
  let E2 = 0;
  for (; E2 < B2; E2++) {
    const I3 = A2.charCodeAt(E2);
    if (I3 > 127) break;
    C2[Q2 + E2] = I3;
  }
  if (E2 !== B2) {
    0 !== E2 && (A2 = A2.slice(E2)), Q2 = g2(Q2, B2, B2 = E2 + 3 * A2.length);
    const I3 = w().subarray(Q2 + E2, Q2 + B2);
    E2 += y(A2, I3).written;
  }
  return M = E2, Q2;
}
function h() {
  return 0 === a.byteLength && (a = new Int32Array(g.memory.buffer)), a;
}
function F(A2) {
  return null == A2;
}
function R(A2, I2) {
  try {
    return A2.apply(this, I2);
  } catch (A3) {
    g.__wbindgen_exn_store(E(A3));
  }
}
function c(A2, I2) {
  return w().subarray(A2 / 1, A2 / 1 + I2);
}
function K(A2, I2) {
  const g2 = I2(1 * A2.length);
  return w().set(A2, g2 / 1), M = A2.length, g2;
}
function H() {
  const A2 = { wbg: {} };
  return A2.wbg.__wbindgen_object_clone_ref = function(A3) {
    return E(Q(A3));
  }, A2.wbg.__wbg_crypto_e1d53a1d73fb10b8 = function(A3) {
    return E(Q(A3).crypto);
  }, A2.wbg.__wbg_process_038c26bf42b093f8 = function(A3) {
    return E(Q(A3).process);
  }, A2.wbg.__wbg_versions_ab37218d2f0b24a8 = function(A3) {
    return E(Q(A3).versions);
  }, A2.wbg.__wbg_node_080f4b19d15bc1fe = function(A3) {
    return E(Q(A3).node);
  }, A2.wbg.__wbindgen_is_string = function(A3) {
    return "string" == typeof Q(A3);
  }, A2.wbg.__wbg_require_78a3dcfbdba9cbce = function() {
    return R(function() {
      return E(module.require);
    }, arguments);
  }, A2.wbg.__wbindgen_string_new = function(A3, I2) {
    return E(o(A3, I2));
  }, A2.wbg.__wbg_call_168da88779e35f61 = function() {
    return R(function(A3, I2, g2) {
      return E(Q(A3).call(Q(I2), Q(g2)));
    }, arguments);
  }, A2.wbg.__wbg_msCrypto_6e7d3e1f92610cbb = function(A3) {
    return E(Q(A3).msCrypto);
  }, A2.wbg.__wbg_newwithlength_f5933855e4f48a19 = function(A3) {
    return E(new Uint8Array(A3 >>> 0));
  }, A2.wbg.__wbindgen_is_object = function(A3) {
    const I2 = Q(A3);
    return "object" == typeof I2 && null !== I2;
  }, A2.wbg.__wbg_get_57245cc7d7c7619d = function(A3, I2) {
    return E(Q(A3)[I2 >>> 0]);
  }, A2.wbg.__wbg_call_97ae9d8645dc388b = function() {
    return R(function(A3, I2) {
      return E(Q(A3).call(Q(I2)));
    }, arguments);
  }, A2.wbg.__wbg_self_6d479506f72c6a71 = function() {
    return R(function() {
      return E(self.self);
    }, arguments);
  }, A2.wbg.__wbg_window_f2557cc78490aceb = function() {
    return R(function() {
      return E(window.window);
    }, arguments);
  }, A2.wbg.__wbg_globalThis_7f206bda628d5286 = function() {
    return R(function() {
      return E(globalThis.globalThis);
    }, arguments);
  }, A2.wbg.__wbg_global_ba75c50d1cf384f4 = function() {
    return R(function() {
      return E(global.global);
    }, arguments);
  }, A2.wbg.__wbindgen_is_undefined = function(A3) {
    return void 0 === Q(A3);
  }, A2.wbg.__wbg_newnoargs_b5b063fc6c2f0376 = function(A3, I2) {
    return E(new Function(o(A3, I2)));
  }, A2.wbg.__wbg_instanceof_Function_056d5b3aef8aaa85 = function(A3) {
    let I2;
    try {
      I2 = Q(A3) instanceof Function;
    } catch {
      I2 = false;
    }
    return I2;
  }, A2.wbg.__wbindgen_memory = function() {
    return E(g.memory);
  }, A2.wbg.__wbg_buffer_3f3d764d4747d564 = function(A3) {
    return E(Q(A3).buffer);
  }, A2.wbg.__wbg_new_8c3f0052272a457a = function(A3) {
    return E(new Uint8Array(Q(A3)));
  }, A2.wbg.__wbg_set_83db9690f9353e79 = function(A3, I2, g2) {
    Q(A3).set(Q(I2), g2 >>> 0);
  }, A2.wbg.__wbg_length_9e1ae1900cb0fbd5 = function(A3) {
    return Q(A3).length;
  }, A2.wbg.__wbg_subarray_58ad4efbb5bcb886 = function(A3, I2, g2) {
    return E(Q(A3).subarray(I2 >>> 0, g2 >>> 0));
  }, A2.wbg.__wbindgen_is_function = function(A3) {
    return "function" == typeof Q(A3);
  }, A2.wbg.__wbindgen_object_drop_ref = function(A3) {
    G(A3);
  }, A2.wbg.__wbg_instanceof_Module_09da91721979648d = function(A3) {
    let I2;
    try {
      I2 = Q(A3) instanceof WebAssembly.Module;
    } catch {
      I2 = false;
    }
    return I2;
  }, A2.wbg.__wbg_instanceof_Table_aab62205c7444b79 = function(A3) {
    let I2;
    try {
      I2 = Q(A3) instanceof WebAssembly.Table;
    } catch {
      I2 = false;
    }
    return I2;
  }, A2.wbg.__wbg_get_19328b9e516e0330 = function() {
    return R(function(A3, I2) {
      return E(Q(A3).get(I2 >>> 0));
    }, arguments);
  }, A2.wbg.__wbg_instanceof_Memory_f1dc0d9a83a9c8ea = function(A3) {
    let I2;
    try {
      I2 = Q(A3) instanceof WebAssembly.Memory;
    } catch {
      I2 = false;
    }
    return I2;
  }, A2.wbg.__wbg_get_765201544a2b6869 = function() {
    return R(function(A3, I2) {
      return E(Reflect.get(Q(A3), Q(I2)));
    }, arguments);
  }, A2.wbg.__wbg_getPrototypeOf_c046822345b14263 = function() {
    return R(function(A3) {
      return E(Reflect.getPrototypeOf(Q(A3)));
    }, arguments);
  }, A2.wbg.__wbg_set_bf3f89b92d5a34bf = function() {
    return R(function(A3, I2, g2) {
      return Reflect.set(Q(A3), Q(I2), Q(g2));
    }, arguments);
  }, A2.wbg.__wbindgen_debug_string = function(A3, I2) {
    const B2 = Y(N(Q(I2)), g.__wbindgen_malloc, g.__wbindgen_realloc), C2 = M;
    h()[A3 / 4 + 1] = C2, h()[A3 / 4 + 0] = B2;
  }, A2.wbg.__wbindgen_throw = function(A3, I2) {
    throw new Error(o(A3, I2));
  }, A2.wbg.__wbindgen_rethrow = function(A3) {
    throw G(A3);
  }, A2.wbg.__wbindgen_is_symbol = function(A3) {
    return "symbol" == typeof Q(A3);
  }, A2.wbg.__wbg_static_accessor_SYMBOL_45d4d15e3c4aeb33 = function() {
    return E(Symbol);
  }, A2.wbg.__wbindgen_jsval_eq = function(A3, I2) {
    return Q(A3) === Q(I2);
  }, A2.wbg.__wbg_newwithbyteoffsetandlength_d9aa266703cb98be = function(A3, I2, g2) {
    return E(new Uint8Array(Q(A3), I2 >>> 0, g2 >>> 0));
  }, A2.wbg.__wbindgen_string_get = function(A3, I2) {
    const B2 = Q(I2), C2 = "string" == typeof B2 ? B2 : void 0;
    var E2 = F(C2) ? 0 : Y(C2, g.__wbindgen_malloc, g.__wbindgen_realloc), D2 = M;
    h()[A3 / 4 + 1] = D2, h()[A3 / 4 + 0] = E2;
  }, A2.wbg.__wbg_imports_5d97b92618ae2b69 = function(A3) {
    return E(WebAssembly.Module.imports(Q(A3)));
  }, A2.wbg.__wbg_length_6e3bbe7c8bd4dbd8 = function(A3) {
    return Q(A3).length;
  }, A2.wbg.__wbg_instanceof_Global_6ae38baa556a9042 = function(A3) {
    let I2;
    try {
      I2 = Q(A3) instanceof WebAssembly.Global;
    } catch {
      I2 = false;
    }
    return I2;
  }, A2.wbg.__wbg_wasmerruntimeerror_new = function(A3) {
    return E(L.__wrap(A3));
  }, A2.wbg.__wbg_constructor_20fd216941fe9866 = function(A3) {
    return E(Q(A3).constructor);
  }, A2.wbg.__wbindgen_number_get = function(A3, I2) {
    const B2 = Q(I2), C2 = "number" == typeof B2 ? B2 : void 0;
    (0 === J.byteLength && (J = new Float64Array(g.memory.buffer)), J)[A3 / 8 + 1] = F(C2) ? 0 : C2, h()[A3 / 4 + 0] = !F(C2);
  }, A2.wbg.__wbg_new0_a57059d72c5b7aee = function() {
    return E(/* @__PURE__ */ new Date());
  }, A2.wbg.__wbg_getTime_cb82adb2556ed13e = function(A3) {
    return Q(A3).getTime();
  }, A2.wbg.__wbg_getTimezoneOffset_89bd4275e1ca8341 = function(A3) {
    return Q(A3).getTimezoneOffset();
  }, A2.wbg.__wbg_new_0b9bfdd97583284e = function() {
    return E(new Object());
  }, A2.wbg.__wbindgen_bigint_from_u64 = function(A3) {
    return E(BigInt.asUintN(64, A3));
  }, A2.wbg.__wbg_new_1d9a920c6bfc44a8 = function() {
    return E(new Array());
  }, A2.wbg.__wbg_new_8d2af00bc1e329ee = function(A3, I2) {
    return E(new Error(o(A3, I2)));
  }, A2.wbg.__wbg_push_740e4b286702d964 = function(A3, I2) {
    return Q(A3).push(Q(I2));
  }, A2.wbg.__wbindgen_boolean_get = function(A3) {
    const I2 = Q(A3);
    return "boolean" == typeof I2 ? I2 ? 1 : 0 : 2;
  }, A2.wbg.__wbg_instanceof_Object_595a1007518cbea3 = function(A3) {
    let I2;
    try {
      I2 = Q(A3) instanceof Object;
    } catch {
      I2 = false;
    }
    return I2;
  }, A2.wbg.__wbg_exports_1f32da4bc6734cea = function(A3) {
    return E(Q(A3).exports);
  }, A2.wbg.__wbg_exports_4db28c393be16bc5 = function(A3) {
    return E(WebAssembly.Module.exports(Q(A3)));
  }, A2.wbg.__wbindgen_typeof = function(A3) {
    return E(typeof Q(A3));
  }, A2.wbg.__wbg_isArray_27c46c67f498e15d = function(A3) {
    return Array.isArray(Q(A3));
  }, A2.wbg.__wbg_entries_65a76a413fc91037 = function(A3) {
    return E(Object.entries(Q(A3)));
  }, A2.wbg.__wbg_instanceof_Instance_b0fc12339921a27e = function(A3) {
    let I2;
    try {
      I2 = Q(A3) instanceof WebAssembly.Instance;
    } catch {
      I2 = false;
    }
    return I2;
  }, A2.wbg.__wbg_new_1c5d2ff1edfe6d73 = function() {
    return R(function(A3, I2) {
      return E(new WebAssembly.Instance(Q(A3), Q(I2)));
    }, arguments);
  }, A2.wbg.__wbg_newwithlength_7c42f7e738a9d5d3 = function(A3) {
    return E(new Array(A3 >>> 0));
  }, A2.wbg.__wbg_apply_75f7334893eef4ad = function() {
    return R(function(A3, I2, g2) {
      return E(Reflect.apply(Q(A3), Q(I2), Q(g2)));
    }, arguments);
  }, A2.wbg.__wbindgen_function_table = function() {
    return E(g.__wbindgen_export_2);
  }, A2.wbg.__wbindgen_number_new = function(A3) {
    return E(A3);
  }, A2.wbg.__wbg_bind_10dfe70e95d2a480 = function(A3, I2, g2, B2) {
    return E(Q(A3).bind(Q(I2), Q(g2), Q(B2)));
  }, A2.wbg.__wbg_randomFillSync_6894564c2c334c42 = function() {
    return R(function(A3, I2, g2) {
      Q(A3).randomFillSync(c(I2, g2));
    }, arguments);
  }, A2.wbg.__wbg_getRandomValues_805f1c3d65988a5a = function() {
    return R(function(A3, I2) {
      Q(A3).getRandomValues(Q(I2));
    }, arguments);
  }, A2;
}
function q(A2, I2) {
  return g = A2.exports, d.__wbindgen_wasm_module = I2, J = new Float64Array(), a = new Int32Array(), i = new Uint8Array(), g;
}
async function d(A2) {
  void 0 === A2 && (A2 = new URL("wasmer_wasi_js_bg.wasm", import.meta.url));
  const I2 = H();
  ("string" == typeof A2 || "function" == typeof Request && A2 instanceof Request || "function" == typeof URL && A2 instanceof URL) && (A2 = fetch(A2));
  const { instance: g2, module: B2 } = await async function(A3, I3) {
    if ("function" == typeof Response && A3 instanceof Response) {
      if ("function" == typeof WebAssembly.instantiateStreaming) try {
        return await WebAssembly.instantiateStreaming(A3, I3);
      } catch (I4) {
        if ("application/wasm" == A3.headers.get("Content-Type")) throw I4;
        console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", I4);
      }
      const g3 = await A3.arrayBuffer();
      return await WebAssembly.instantiate(g3, I3);
    }
    {
      const g3 = await WebAssembly.instantiate(A3, I3);
      return g3 instanceof WebAssembly.Instance ? { instance: g3, module: A3 } : g3;
    }
  }(await A2, I2);
  return q(g2, B2);
}
function Z(A2) {
  if (!/^data:/i.test(A2)) throw new TypeError('`uri` does not appear to be a Data URI (must begin with "data:")');
  var I2 = (A2 = A2.replace(/\r?\n/g, "")).indexOf(",");
  if (-1 === I2 || I2 <= 4) throw new TypeError("malformed data: URI");
  for (var g2 = A2.substring(5, I2).split(";"), B2 = "", Q2 = false, C2 = g2[0] || "text/plain", E2 = C2, D2 = 1; D2 < g2.length; D2++) "base64" === g2[D2] ? Q2 = true : (E2 += ";".concat(g2[D2]), 0 === g2[D2].indexOf("charset=") && (B2 = g2[D2].substring(8)));
  g2[0] || B2.length || (E2 += ";charset=US-ASCII", B2 = "US-ASCII");
  var i2 = Q2 ? "base64" : "ascii", w2 = unescape(A2.substring(I2 + 1)), o2 = Buffer.from(w2, i2);
  return o2.type = C2, o2.typeFull = E2, o2.charset = B2, o2;
}
var g, B, C, D, i, M, k, y, a, J, U, S, s, L, b, n;
var init_Library_esm_min = __esm({
  "node_modules/@wasmer/wasi/dist/Library.esm.min.js"() {
    B = new Array(32).fill(void 0);
    B.push(void 0, null, true, false);
    C = B.length;
    D = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
    D.decode();
    i = new Uint8Array();
    M = 0;
    k = new TextEncoder("utf-8");
    y = "function" == typeof k.encodeInto ? function(A2, I2) {
      return k.encodeInto(A2, I2);
    } : function(A2, I2) {
      const g2 = k.encode(A2);
      return I2.set(g2), { read: A2.length, written: g2.length };
    };
    a = new Int32Array();
    J = new Float64Array();
    U = class _U {
      static __wrap(A2) {
        const I2 = Object.create(_U.prototype);
        return I2.ptr = A2, I2;
      }
      __destroy_into_raw() {
        const A2 = this.ptr;
        return this.ptr = 0, A2;
      }
      free() {
        const A2 = this.__destroy_into_raw();
        g.__wbg_jsvirtualfile_free(A2);
      }
      lastAccessed() {
        const A2 = g.jsvirtualfile_lastAccessed(this.ptr);
        return BigInt.asUintN(64, A2);
      }
      lastModified() {
        const A2 = g.jsvirtualfile_lastModified(this.ptr);
        return BigInt.asUintN(64, A2);
      }
      createdTime() {
        const A2 = g.jsvirtualfile_createdTime(this.ptr);
        return BigInt.asUintN(64, A2);
      }
      size() {
        const A2 = g.jsvirtualfile_size(this.ptr);
        return BigInt.asUintN(64, A2);
      }
      setLength(A2) {
        try {
          const B2 = g.__wbindgen_add_to_stack_pointer(-16);
          g.jsvirtualfile_setLength(B2, this.ptr, A2);
          var I2 = h()[B2 / 4 + 0];
          if (h()[B2 / 4 + 1]) throw G(I2);
        } finally {
          g.__wbindgen_add_to_stack_pointer(16);
        }
      }
      read() {
        try {
          const C2 = g.__wbindgen_add_to_stack_pointer(-16);
          g.jsvirtualfile_read(C2, this.ptr);
          var A2 = h()[C2 / 4 + 0], I2 = h()[C2 / 4 + 1], B2 = h()[C2 / 4 + 2];
          if (h()[C2 / 4 + 3]) throw G(B2);
          var Q2 = c(A2, I2).slice();
          return g.__wbindgen_free(A2, 1 * I2), Q2;
        } finally {
          g.__wbindgen_add_to_stack_pointer(16);
        }
      }
      readString() {
        try {
          const D2 = g.__wbindgen_add_to_stack_pointer(-16);
          g.jsvirtualfile_readString(D2, this.ptr);
          var A2 = h()[D2 / 4 + 0], I2 = h()[D2 / 4 + 1], B2 = h()[D2 / 4 + 2], Q2 = h()[D2 / 4 + 3], C2 = A2, E2 = I2;
          if (Q2) throw C2 = 0, E2 = 0, G(B2);
          return o(C2, E2);
        } finally {
          g.__wbindgen_add_to_stack_pointer(16), g.__wbindgen_free(C2, E2);
        }
      }
      write(A2) {
        try {
          const E2 = g.__wbindgen_add_to_stack_pointer(-16);
          var I2 = K(A2, g.__wbindgen_malloc), B2 = M;
          g.jsvirtualfile_write(E2, this.ptr, I2, B2);
          var Q2 = h()[E2 / 4 + 0], C2 = h()[E2 / 4 + 1];
          if (h()[E2 / 4 + 2]) throw G(C2);
          return Q2 >>> 0;
        } finally {
          g.__wbindgen_add_to_stack_pointer(16), A2.set(w().subarray(I2 / 1, I2 / 1 + B2)), g.__wbindgen_free(I2, 1 * B2);
        }
      }
      writeString(A2) {
        try {
          const Q2 = g.__wbindgen_add_to_stack_pointer(-16), C2 = Y(A2, g.__wbindgen_malloc, g.__wbindgen_realloc), E2 = M;
          g.jsvirtualfile_writeString(Q2, this.ptr, C2, E2);
          var I2 = h()[Q2 / 4 + 0], B2 = h()[Q2 / 4 + 1];
          if (h()[Q2 / 4 + 2]) throw G(B2);
          return I2 >>> 0;
        } finally {
          g.__wbindgen_add_to_stack_pointer(16);
        }
      }
      flush() {
        try {
          const I2 = g.__wbindgen_add_to_stack_pointer(-16);
          g.jsvirtualfile_flush(I2, this.ptr);
          var A2 = h()[I2 / 4 + 0];
          if (h()[I2 / 4 + 1]) throw G(A2);
        } finally {
          g.__wbindgen_add_to_stack_pointer(16);
        }
      }
      seek(A2) {
        try {
          const Q2 = g.__wbindgen_add_to_stack_pointer(-16);
          g.jsvirtualfile_seek(Q2, this.ptr, A2);
          var I2 = h()[Q2 / 4 + 0], B2 = h()[Q2 / 4 + 1];
          if (h()[Q2 / 4 + 2]) throw G(B2);
          return I2 >>> 0;
        } finally {
          g.__wbindgen_add_to_stack_pointer(16);
        }
      }
    };
    S = class _S {
      static __wrap(A2) {
        const I2 = Object.create(_S.prototype);
        return I2.ptr = A2, I2;
      }
      __destroy_into_raw() {
        const A2 = this.ptr;
        return this.ptr = 0, A2;
      }
      free() {
        const A2 = this.__destroy_into_raw();
        g.__wbg_memfs_free(A2);
      }
      static __wbgd_downcast_token() {
        return G(g.memfs___wbgd_downcast_token());
      }
      constructor() {
        try {
          const B2 = g.__wbindgen_add_to_stack_pointer(-16);
          g.memfs_new(B2);
          var A2 = h()[B2 / 4 + 0], I2 = h()[B2 / 4 + 1];
          if (h()[B2 / 4 + 2]) throw G(I2);
          return _S.__wrap(A2);
        } finally {
          g.__wbindgen_add_to_stack_pointer(16);
        }
      }
      static from_js(A2) {
        try {
          const Q2 = g.__wbindgen_add_to_stack_pointer(-16);
          g.memfs_from_js(Q2, E(A2));
          var I2 = h()[Q2 / 4 + 0], B2 = h()[Q2 / 4 + 1];
          if (h()[Q2 / 4 + 2]) throw G(B2);
          return _S.__wrap(I2);
        } finally {
          g.__wbindgen_add_to_stack_pointer(16);
        }
      }
      readDir(A2) {
        try {
          const Q2 = g.__wbindgen_add_to_stack_pointer(-16), C2 = Y(A2, g.__wbindgen_malloc, g.__wbindgen_realloc), E2 = M;
          g.memfs_readDir(Q2, this.ptr, C2, E2);
          var I2 = h()[Q2 / 4 + 0], B2 = h()[Q2 / 4 + 1];
          if (h()[Q2 / 4 + 2]) throw G(B2);
          return G(I2);
        } finally {
          g.__wbindgen_add_to_stack_pointer(16);
        }
      }
      createDir(A2) {
        try {
          const B2 = g.__wbindgen_add_to_stack_pointer(-16), Q2 = Y(A2, g.__wbindgen_malloc, g.__wbindgen_realloc), C2 = M;
          g.memfs_createDir(B2, this.ptr, Q2, C2);
          var I2 = h()[B2 / 4 + 0];
          if (h()[B2 / 4 + 1]) throw G(I2);
        } finally {
          g.__wbindgen_add_to_stack_pointer(16);
        }
      }
      removeDir(A2) {
        try {
          const B2 = g.__wbindgen_add_to_stack_pointer(-16), Q2 = Y(A2, g.__wbindgen_malloc, g.__wbindgen_realloc), C2 = M;
          g.memfs_removeDir(B2, this.ptr, Q2, C2);
          var I2 = h()[B2 / 4 + 0];
          if (h()[B2 / 4 + 1]) throw G(I2);
        } finally {
          g.__wbindgen_add_to_stack_pointer(16);
        }
      }
      removeFile(A2) {
        try {
          const B2 = g.__wbindgen_add_to_stack_pointer(-16), Q2 = Y(A2, g.__wbindgen_malloc, g.__wbindgen_realloc), C2 = M;
          g.memfs_removeFile(B2, this.ptr, Q2, C2);
          var I2 = h()[B2 / 4 + 0];
          if (h()[B2 / 4 + 1]) throw G(I2);
        } finally {
          g.__wbindgen_add_to_stack_pointer(16);
        }
      }
      rename(A2, I2) {
        try {
          const Q2 = g.__wbindgen_add_to_stack_pointer(-16), C2 = Y(A2, g.__wbindgen_malloc, g.__wbindgen_realloc), E2 = M, D2 = Y(I2, g.__wbindgen_malloc, g.__wbindgen_realloc), i2 = M;
          g.memfs_rename(Q2, this.ptr, C2, E2, D2, i2);
          var B2 = h()[Q2 / 4 + 0];
          if (h()[Q2 / 4 + 1]) throw G(B2);
        } finally {
          g.__wbindgen_add_to_stack_pointer(16);
        }
      }
      metadata(A2) {
        try {
          const Q2 = g.__wbindgen_add_to_stack_pointer(-16), C2 = Y(A2, g.__wbindgen_malloc, g.__wbindgen_realloc), E2 = M;
          g.memfs_metadata(Q2, this.ptr, C2, E2);
          var I2 = h()[Q2 / 4 + 0], B2 = h()[Q2 / 4 + 1];
          if (h()[Q2 / 4 + 2]) throw G(B2);
          return G(I2);
        } finally {
          g.__wbindgen_add_to_stack_pointer(16);
        }
      }
      open(A2, I2) {
        try {
          const C2 = g.__wbindgen_add_to_stack_pointer(-16), D2 = Y(A2, g.__wbindgen_malloc, g.__wbindgen_realloc), i2 = M;
          g.memfs_open(C2, this.ptr, D2, i2, E(I2));
          var B2 = h()[C2 / 4 + 0], Q2 = h()[C2 / 4 + 1];
          if (h()[C2 / 4 + 2]) throw G(Q2);
          return U.__wrap(B2);
        } finally {
          g.__wbindgen_add_to_stack_pointer(16);
        }
      }
    };
    s = class _s {
      static __wrap(A2) {
        const I2 = Object.create(_s.prototype);
        return I2.ptr = A2, I2;
      }
      __destroy_into_raw() {
        const A2 = this.ptr;
        return this.ptr = 0, A2;
      }
      free() {
        const A2 = this.__destroy_into_raw();
        g.__wbg_wasi_free(A2);
      }
      constructor(A2) {
        try {
          const Q2 = g.__wbindgen_add_to_stack_pointer(-16);
          g.wasi_new(Q2, E(A2));
          var I2 = h()[Q2 / 4 + 0], B2 = h()[Q2 / 4 + 1];
          if (h()[Q2 / 4 + 2]) throw G(B2);
          return _s.__wrap(I2);
        } finally {
          g.__wbindgen_add_to_stack_pointer(16);
        }
      }
      get fs() {
        try {
          const B2 = g.__wbindgen_add_to_stack_pointer(-16);
          g.wasi_fs(B2, this.ptr);
          var A2 = h()[B2 / 4 + 0], I2 = h()[B2 / 4 + 1];
          if (h()[B2 / 4 + 2]) throw G(I2);
          return S.__wrap(A2);
        } finally {
          g.__wbindgen_add_to_stack_pointer(16);
        }
      }
      getImports(A2) {
        try {
          const Q2 = g.__wbindgen_add_to_stack_pointer(-16);
          g.wasi_getImports(Q2, this.ptr, E(A2));
          var I2 = h()[Q2 / 4 + 0], B2 = h()[Q2 / 4 + 1];
          if (h()[Q2 / 4 + 2]) throw G(B2);
          return G(I2);
        } finally {
          g.__wbindgen_add_to_stack_pointer(16);
        }
      }
      instantiate(A2, I2) {
        try {
          const C2 = g.__wbindgen_add_to_stack_pointer(-16);
          g.wasi_instantiate(C2, this.ptr, E(A2), F(I2) ? 0 : E(I2));
          var B2 = h()[C2 / 4 + 0], Q2 = h()[C2 / 4 + 1];
          if (h()[C2 / 4 + 2]) throw G(Q2);
          return G(B2);
        } finally {
          g.__wbindgen_add_to_stack_pointer(16);
        }
      }
      start(A2) {
        try {
          const Q2 = g.__wbindgen_add_to_stack_pointer(-16);
          g.wasi_start(Q2, this.ptr, F(A2) ? 0 : E(A2));
          var I2 = h()[Q2 / 4 + 0], B2 = h()[Q2 / 4 + 1];
          if (h()[Q2 / 4 + 2]) throw G(B2);
          return I2 >>> 0;
        } finally {
          g.__wbindgen_add_to_stack_pointer(16);
        }
      }
      getStdoutBuffer() {
        try {
          const C2 = g.__wbindgen_add_to_stack_pointer(-16);
          g.wasi_getStdoutBuffer(C2, this.ptr);
          var A2 = h()[C2 / 4 + 0], I2 = h()[C2 / 4 + 1], B2 = h()[C2 / 4 + 2];
          if (h()[C2 / 4 + 3]) throw G(B2);
          var Q2 = c(A2, I2).slice();
          return g.__wbindgen_free(A2, 1 * I2), Q2;
        } finally {
          g.__wbindgen_add_to_stack_pointer(16);
        }
      }
      getStdoutString() {
        try {
          const D2 = g.__wbindgen_add_to_stack_pointer(-16);
          g.wasi_getStdoutString(D2, this.ptr);
          var A2 = h()[D2 / 4 + 0], I2 = h()[D2 / 4 + 1], B2 = h()[D2 / 4 + 2], Q2 = h()[D2 / 4 + 3], C2 = A2, E2 = I2;
          if (Q2) throw C2 = 0, E2 = 0, G(B2);
          return o(C2, E2);
        } finally {
          g.__wbindgen_add_to_stack_pointer(16), g.__wbindgen_free(C2, E2);
        }
      }
      getStderrBuffer() {
        try {
          const C2 = g.__wbindgen_add_to_stack_pointer(-16);
          g.wasi_getStderrBuffer(C2, this.ptr);
          var A2 = h()[C2 / 4 + 0], I2 = h()[C2 / 4 + 1], B2 = h()[C2 / 4 + 2];
          if (h()[C2 / 4 + 3]) throw G(B2);
          var Q2 = c(A2, I2).slice();
          return g.__wbindgen_free(A2, 1 * I2), Q2;
        } finally {
          g.__wbindgen_add_to_stack_pointer(16);
        }
      }
      getStderrString() {
        try {
          const D2 = g.__wbindgen_add_to_stack_pointer(-16);
          g.wasi_getStderrString(D2, this.ptr);
          var A2 = h()[D2 / 4 + 0], I2 = h()[D2 / 4 + 1], B2 = h()[D2 / 4 + 2], Q2 = h()[D2 / 4 + 3], C2 = A2, E2 = I2;
          if (Q2) throw C2 = 0, E2 = 0, G(B2);
          return o(C2, E2);
        } finally {
          g.__wbindgen_add_to_stack_pointer(16), g.__wbindgen_free(C2, E2);
        }
      }
      setStdinBuffer(A2) {
        try {
          const B2 = g.__wbindgen_add_to_stack_pointer(-16), Q2 = K(A2, g.__wbindgen_malloc), C2 = M;
          g.wasi_setStdinBuffer(B2, this.ptr, Q2, C2);
          var I2 = h()[B2 / 4 + 0];
          if (h()[B2 / 4 + 1]) throw G(I2);
        } finally {
          g.__wbindgen_add_to_stack_pointer(16);
        }
      }
      setStdinString(A2) {
        try {
          const B2 = g.__wbindgen_add_to_stack_pointer(-16), Q2 = Y(A2, g.__wbindgen_malloc, g.__wbindgen_realloc), C2 = M;
          g.wasi_setStdinString(B2, this.ptr, Q2, C2);
          var I2 = h()[B2 / 4 + 0];
          if (h()[B2 / 4 + 1]) throw G(I2);
        } finally {
          g.__wbindgen_add_to_stack_pointer(16);
        }
      }
    };
    L = class _L {
      static __wrap(A2) {
        const I2 = Object.create(_L.prototype);
        return I2.ptr = A2, I2;
      }
      __destroy_into_raw() {
        const A2 = this.ptr;
        return this.ptr = 0, A2;
      }
      free() {
        const A2 = this.__destroy_into_raw();
        g.__wbg_wasmerruntimeerror_free(A2);
      }
      static __wbgd_downcast_token() {
        return G(g.wasmerruntimeerror___wbgd_downcast_token());
      }
    };
    b = null;
    n = function(g2, B2) {
      return A(void 0, void 0, void 0, function() {
        return I(this, function(A2) {
          switch (A2.label) {
            case 0:
              return null !== b && true !== B2 ? [3, 3] : g2 ? [3, 2] : [4, WebAssembly.compile(Z("data:application/wasm;base64,AGFzbQEAAAABowRDYAJ/fwBgAX8AYAJ/fwF/YAN/f38AYAN/f38Bf2AEf39/fwBgAX8Bf2ABfwF+YAV/f39/fwBgBH9/f38Bf2AAAX9gBX9/f39/AX9gBn9/f39/fwBgA39/fwF+YAAAYAZ/f39/f38Bf2AHf39/f39/fwF/YAJ/fgF/YAN+f38Bf2AHf39/f39/fwBgA39/fgF/YAN/fn8AYAd/f39/f35/AX9gCH9/f39/f39/AX9gBn9/f35/fwBgAn5/AX9gA39/fgBgAX8BfGABfgF/YAV/f39+fgF/YAN+fn8BfmAEfn5/fwF+YAZ/f39+fn8Bf2AGf39/fn9/AX9gBH9+f38Bf2ACf34AYAN/fn8Bf2AFf39/fn8AYAV/f35/fwBgAn9/AX5gBH9/f34AYAF8AX9gCX9/f35/f39/fwBgC39/f39/f39+fn9/AX9gCX9/f39/f39/fwF/YAl/f39/f39+fn8Bf2AEf39/fgF/YAl/f39/f39/fn8AYAV/f39+fwF/YA9/f39/f39/f39/f39/f38Bf2AEf39+fgBgC39/f39/f39/f39/AX9gCH9/fn5/f35/AGAEfn5+fwF+YAR/f35/AX9gA35/fgF/YAV/f31/fwBgBH99f38AYAV/f3x/fwBgBH98f38AYAR/fn9/AGAFf39+f38Bf2ABfgBgAn5/AGAJf39/f39/f39/AGAGf39/f35/AGAHf39/fn9+fwF/AuAUSgN3YmcbX193YmluZGdlbl9vYmplY3RfY2xvbmVfcmVmAAYDd2JnHV9fd2JnX2NyeXB0b19lMWQ1M2ExZDczZmIxMGI4AAYDd2JnHl9fd2JnX3Byb2Nlc3NfMDM4YzI2YmY0MmIwOTNmOAAGA3diZx9fX3diZ192ZXJzaW9uc19hYjM3MjE4ZDJmMGIyNGE4AAYDd2JnG19fd2JnX25vZGVfMDgwZjRiMTlkMTViYzFmZQAGA3diZxRfX3diaW5kZ2VuX2lzX3N0cmluZwAGA3diZx5fX3diZ19yZXF1aXJlXzc4YTNkY2ZiZGJhOWNiY2UACgN3YmcVX193YmluZGdlbl9zdHJpbmdfbmV3AAIDd2JnG19fd2JnX2NhbGxfMTY4ZGE4ODc3OWUzNWY2MQAEA3diZx9fX3diZ19tc0NyeXB0b182ZTdkM2UxZjkyNjEwY2JiAAYDd2JnJF9fd2JnX25ld3dpdGhsZW5ndGhfZjU5MzM4NTVlNGY0OGExOQAGA3diZxRfX3diaW5kZ2VuX2lzX29iamVjdAAGA3diZxpfX3diZ19nZXRfNTcyNDVjYzdkN2M3NjE5ZAACA3diZxtfX3diZ19jYWxsXzk3YWU5ZDg2NDVkYzM4OGIAAgN3YmcbX193Ymdfc2VsZl82ZDQ3OTUwNmY3MmM2YTcxAAoDd2JnHV9fd2JnX3dpbmRvd19mMjU1N2NjNzg0OTBhY2ViAAoDd2JnIV9fd2JnX2dsb2JhbFRoaXNfN2YyMDZiZGE2MjhkNTI4NgAKA3diZx1fX3diZ19nbG9iYWxfYmE3NWM1MGQxY2YzODRmNAAKA3diZxdfX3diaW5kZ2VuX2lzX3VuZGVmaW5lZAAGA3diZyBfX3diZ19uZXdub2FyZ3NfYjViMDYzZmM2YzJmMDM3NgACA3diZypfX3diZ19pbnN0YW5jZW9mX0Z1bmN0aW9uXzA1NmQ1YjNhZWY4YWFhODUABgN3YmcRX193YmluZGdlbl9tZW1vcnkACgN3YmcdX193YmdfYnVmZmVyXzNmM2Q3NjRkNDc0N2Q1NjQABgN3YmcaX193YmdfbmV3XzhjM2YwMDUyMjcyYTQ1N2EABgN3YmcaX193Ymdfc2V0XzgzZGI5NjkwZjkzNTNlNzkAAwN3YmcdX193YmdfbGVuZ3RoXzllMWFlMTkwMGNiMGZiZDUABgN3YmcfX193Ymdfc3ViYXJyYXlfNThhZDRlZmJiNWJjYjg4NgAEA3diZxZfX3diaW5kZ2VuX2lzX2Z1bmN0aW9uAAYDd2JnGl9fd2JpbmRnZW5fb2JqZWN0X2Ryb3BfcmVmAAEDd2JnKF9fd2JnX2luc3RhbmNlb2ZfTW9kdWxlXzA5ZGE5MTcyMTk3OTY0OGQABgN3YmcnX193YmdfaW5zdGFuY2VvZl9UYWJsZV9hYWI2MjIwNWM3NDQ0Yjc5AAYDd2JnGl9fd2JnX2dldF8xOTMyOGI5ZTUxNmUwMzMwAAIDd2JnKF9fd2JnX2luc3RhbmNlb2ZfTWVtb3J5X2YxZGMwZDlhODNhOWM4ZWEABgN3YmcaX193YmdfZ2V0Xzc2NTIwMTU0NGEyYjY4NjkAAgN3YmclX193YmdfZ2V0UHJvdG90eXBlT2ZfYzA0NjgyMjM0NWIxNDI2MwAGA3diZxpfX3diZ19zZXRfYmYzZjg5YjkyZDVhMzRiZgAEA3diZxdfX3diaW5kZ2VuX2RlYnVnX3N0cmluZwAAA3diZxBfX3diaW5kZ2VuX3Rocm93AAADd2JnEl9fd2JpbmRnZW5fcmV0aHJvdwABA3diZxRfX3diaW5kZ2VuX2lzX3N5bWJvbAAGA3diZy1fX3diZ19zdGF0aWNfYWNjZXNzb3JfU1lNQk9MXzQ1ZDRkMTVlM2M0YWViMzMACgN3YmcTX193YmluZGdlbl9qc3ZhbF9lcQACA3diZzFfX3diZ19uZXd3aXRoYnl0ZW9mZnNldGFuZGxlbmd0aF9kOWFhMjY2NzAzY2I5OGJlAAQDd2JnFV9fd2JpbmRnZW5fc3RyaW5nX2dldAAAA3diZx5fX3diZ19pbXBvcnRzXzVkOTdiOTI2MThhZTJiNjkABgN3YmcdX193YmdfbGVuZ3RoXzZlM2JiZTdjOGJkNGRiZDgABgN3YmcoX193YmdfaW5zdGFuY2VvZl9HbG9iYWxfNmFlMzhiYWE1NTZhOTA0MgAGA3diZxxfX3diZ193YXNtZXJydW50aW1lZXJyb3JfbmV3AAYDd2JnIl9fd2JnX2NvbnN0cnVjdG9yXzIwZmQyMTY5NDFmZTk4NjYABgN3YmcVX193YmluZGdlbl9udW1iZXJfZ2V0AAADd2JnG19fd2JnX25ldzBfYTU3MDU5ZDcyYzViN2FlZQAKA3diZx5fX3diZ19nZXRUaW1lX2NiODJhZGIyNTU2ZWQxM2UAGwN3YmcoX193YmdfZ2V0VGltZXpvbmVPZmZzZXRfODliZDQyNzVlMWNhODM0MQAbA3diZxpfX3diZ19uZXdfMGI5YmZkZDk3NTgzMjg0ZQAKA3diZxpfX3diaW5kZ2VuX2JpZ2ludF9mcm9tX3U2NAAcA3diZxpfX3diZ19uZXdfMWQ5YTkyMGM2YmZjNDRhOAAKA3diZxpfX3diZ19uZXdfOGQyYWYwMGJjMWUzMjllZQACA3diZxtfX3diZ19wdXNoXzc0MGU0YjI4NjcwMmQ5NjQAAgN3YmcWX193YmluZGdlbl9ib29sZWFuX2dldAAGA3diZyhfX3diZ19pbnN0YW5jZW9mX09iamVjdF81OTVhMTAwNzUxOGNiZWEz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ZW1mc19fX3diZ2RfZG93bmNhc3RfdG9rZW4AoAkJbWVtZnNfbmV3ALUFDW1lbWZzX2Zyb21fanMArwUNbWVtZnNfcmVhZERpcgBrD21lbWZzX2NyZWF0ZURpcgCKAg9tZW1mc19yZW1vdmVEaXIAiwIQbWVtZnNfcmVtb3ZlRmlsZQCMAgxtZW1mc19yZW5hbWUA6wEObWVtZnNfbWV0YWRhdGEAwgEKbWVtZnNfb3BlbgB9GF9fd2JnX2pzdmlydHVhbGZpbGVfZnJlZQD8BBpqc3ZpcnR1YWxmaWxlX2xhc3RBY2Nlc3NlZACwBRpqc3ZpcnR1YWxmaWxlX2xhc3RNb2RpZmllZACxBRlqc3ZpcnR1YWxmaWxlX2NyZWF0ZWRUaW1lALIFEmpzdmlydHVhbGZpbGVfc2l6ZQCzBRdqc3ZpcnR1YWxmaWxlX3NldExlbmd0aACGAxJqc3ZpcnR1YWxmaWxlX3JlYWQApgMYanN2aXJ0dWFsZmlsZV9yZWFkU3RyaW5nAOEBE2pzdmlydHVhbGZpbGVfd3JpdGUAngIZanN2aXJ0dWFsZmlsZV93cml0ZVN0cmluZwCPAhNqc3ZpcnR1YWxmaWxlX2ZsdXNoAOICEmpzdmlydHVhbGZpbGVfc2VlawCUAg9fX3diZ193YXNpX2ZyZWUA/gMId2FzaV9uZXcASgd3YXNpX2ZzAIgDD3dhc2lfZ2V0SW1wb3J0cwBiEHdhc2lfaW5zdGFudGlhdGUA4QMKd2FzaV9zdGFydABdFHdhc2lfZ2V0U3Rkb3V0QnVmZmVyAP4BFHdhc2lfZ2V0U3Rkb3V0U3RyaW5nAP8BFHdhc2lfZ2V0U3RkZXJyQnVmZmVyAIACFHdhc2lfZ2V0U3RkZXJyU3RyaW5nAIECE3dhc2lfc2V0U3RkaW5CdWZmZXIA+wMTd2FzaV9zZXRTdGRpblN0cmluZwCFBBVjYW5vbmljYWxfYWJpX3JlYWxsb2MAqwYSY2Fub25pY2FsX2FiaV9mcmVlAMcIEV9fd2JpbmRnZW5fbWFsbG9jAKEGEl9fd2JpbmRnZW5fcmVhbGxvYwCPBxNfX3diaW5kZ2VuX2V4cG9ydF8yAQAUX193YmluZGdlbl9leG5fc3RvcmUApggfX193YmluZGdlbl9hZGRfdG9fc3RhY2tfcG9pbnRlcgDrCA9f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mMzBADYCrAMgAiAFNgKoAyACKAKAAyEDIAIoAvgCIQUgAiACKAL8AiIENgL8DSACIAQ2AvQNIAIgBTYC8A0gAiAEIANBGGxqIgM2AvgNIAJBkA9qQQFyIQsgAkGUBmohDCACQaAGaiITQQJqIQ4CQAJAA0ACQCADIARHBEAgAiAEQRhqNgL0DSAEKAIEIgcNAQsgAkHwDWoQxAQgAigCzAMiBCACKALQA0EMbGohCUEAIQUCQANAIAQgCUYEQCACKALYAyIFIAIoAtwDQRhsaiEHAkACQAJAAkACQAJAAkADQCAFIAdGBEAgAigCuAMhAyACQQA2ArgDAn8gAwRAIAIoArwDDAELEIYCIQVBBBDXByIDIAU2AgBB3I/BAAshBSACQcgPakIINwMAIAJBwA9qQgA3AwAgAkG4D2pBADYCACACQgA3A7APIAJBsA9qQQQQmAEgAkHgAWoQ8wQgAkGsD2pBkNnBADYCACACQagPakEANgIAIAJCADcDoA8gAiACKQPoATcDmA8gAiACKQPgATcDkA8gAkGoCGogAkGQD2oiBEHAABCSCRogAkEAOgCkCCACQX82AqAIIAQgAkGgCGoQhAUgAigCkA8NAyACQZgPai0AACEMIAIoApQPIQYgAkHwA2ooAgAhBCACQfQDaigCACERIAIoAuQDIQ8gAigC6AMhEyACQdABahDzBCACKQPQASEcIAIpA9gBIR0gAkHAAWoQ8wQgAikDwAEhHiACKQPIASEfIAJB+A5qQZzbwQBBARCbBCACQZoPaiACQYAPaigCADYBACACQeAOakKAgICAwAA3AwAgAkHcDmpBADoAACACQegOakKAgICAMDcDACACQcQOakGQ2cEANgIAIAJBwA5qQQA2AgAgAkG4DmpCADcDACACQbAOaiAfNwMAIAJBqA5qIB43AwAgAkGkDmpBADoAACACIAIpA/gONwGSDyACQQA2AtgOIAJBADYCoA4gAkGQ2cEANgKMDiACQQA2AogOIAJCADcDgA4gAiAdNwP4DSACIBw3A/ANIAJB1A5qIAU2AgAgAkGSDmogAikBkA83AQAgAkGYDmogAkGWD2opAQA3AQAgAkEAOwGQDiACQoAINwPIDiACQQA6APAOIAIgAzYC0A5BDBDXByIFQQA2AgggBUKAgICAEDcCACACQfANaiIDIAZBCGoi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wBEgAkECNgKcDyACQdySwQA2ApgPIAJBAjYCpA8gAkEANgKQDyACQTY2ApQNIAJBNzYCjA0gAiACQYgNajYCoA8gAiACQcARajYCkA0gAiACQaARajYCiA0gAkGgDGogAkGQD2oQzAMgAigCoAwhByACKAKkDCIEDQQLIAJB4ABqIA4oAgAgEygCACAcIAlB+JDBABClBxCoBCACLQBkIQ0gAigCYCIEQaABaigCAEEORgRAIARBCGohFQJAIBsoAgAiFgRAIAJBoAxqIBYgBUEIaigCABCUBQwBCyACQZAPaiIFIAIoAqARIhYoAgQgFigCCBCfASACQaAMaiAFEIkGCyACQZAPaiIFIAIoAqQMIAIoAqgMEJQFIAJBiA1qIBUgBSAdIBQQ5QUgAikDiA1CAVEEQCACQZwPakECNgIAIAJBpA9qQQE2AgAgAkHYkMEANgKYDyACQQA2ApAPIAJBGDYCrBEgAiACQagRajYCoA8gAiACQaAMajYCqBEgAkGYC2ogAkGQD2oQzAMgAkEANgK0CyACKAKgDCACKAKkDBCGCCAEIA0QhwgMDgsgAigCoAwgAigCpAwQhggLIAQgDRCHCCACQZAPaiIFIBEQ+QQgAkHYAGogBUGIkcEAENkEIAItAFwhBSACKAJYIgRBCGogBxDkBSAEIAUQhwggA0EcaiEDDAELCyACQZgLaiACQfANakGIARCSCRogAigCtAsiA0UNCyACQYgKaiACQbALaigCADYCACACIAIpAJkLNwOICyACIAIpA6gLNwOACiACIAJBoAtqKQAANwCPCyACLQCYCyEFIAJBkApqIAJBuAtqQegAEJIJGiACIAIpAI8LNwD/CiACIAIpA4gLNwP4CiACQfgJaiACKQD/CjcAACACIAM2AowKIAIgBToA8AkgAiACKQP4CjcA8QkgAigCsAMhAyACQQA2ArADIAMNAgwDCyACIAItAIkNOgDAESACQZwPakEBNgIAIAJBpA9qQQE2AgAgAkHYk8EANgKYDyACQQA2ApAPIAJBNjYCrBEgAiACQagRajYCoA8gAiACQcARajYCqBEgAkGgDGpBBHIgAkGQD2oQzAMgAkEANgK0CyACIAIpA6gMNwKcCyACIAIoAqQMNgKYCwwJCyACQQA2ArQLIAIgAigCqAw2AqALIAIgBDYCnAsgAiAHNgKYCwwICyACQZAPaiACQfAJaiAGQUBrKAIAIAZBxABqKAIAQQAgAyACKAK0AxCBASACLQCQD0UEQCACIAIpApQPNwPwDSACQfANahDYBgwBCyACQQA2ApQHIAIgAi0AkQ86AIkGIAJBBzoAiAYMAQsgAigCoAMhAyACQQA2AqADAkACQCADBEAgAkGQD2ogAkHwCWogBkFAaygCACAGQcQAaigCAEEBIAMgAigCpAMQgQEgAi0AkA8NASACIAIpApQPNwPwDSACQfANahDYBgsgAigCqAMhAyACQQA2AqgDIAMEQCACQZAPaiACQfAJaiAGQUBrKAIAIAZBxABqKAIAQQIgAyACKAKsAxCBASACLQCQDw0CIAIgAikClA83A/ANIAJB8A1qENgGCwJAIAIoApgDIgMEQCACQfANaiADIAggAkHwCWogAigCnAMoAhQRBQAgAigC9A0NAQsgAkHoCGoiAyACQfAJakGIARCSCRogBiAMEIcIIAJBkA9qIANBiAEQkgkaIAJB8A1qIgMgAkGgCGpByAAQkgkaQdAAQQgQxwciDUKBgICAEDcDACANQQhqIANByAAQkgkaIAIoAswDIQMgAkHQAGogAigC0AMiERCMBSARQQxsIQVBACEEIAIoAlQhCiACKAJQIg8hBgNAIAZFIAQgBUZyRQRAIAJB8A1qIANBBGooAgAgA0EIaigCABCmBSACKQPwDSEcIAQgCmoiCEEIaiACQfgNaigCADYCACAIIBw3AgAgBEEMaiEEIANBDGohAyAGQQFrIQYMAQsLIAJBQGsQswYgAikDSCEcIAIpA0AhHSACQTBqELMGIAIpAzghHiACKQMwIR8gAkEgahCzBiACKQMoISAgAikDICEhIAIoAtgDIQQgAkEYaiACKALcAyIDEIwFIAJBADYCmAggAiACKAIcIgY2ApQIIAIgAigCGCIINgKQCEEAIQUgA0EYbCEHIAMgCEsEQCACQRBqIAJBkAhqQQAgAxD1AiACKAIQIAIoAhQQqQcgAigClAghBiACKAKYCCEFCyAGIAVBDGxqIQMDQCAHBEAgAkEIaiAEKAIIIgYgBEEUaigCACITakEBakEAEJEEIAJBADYC+A0gAiACKQMINwPwDSACQfANaiAEKAIEIAYQ3gYgAigC+A0iBiACKALwDUYEQCACQfANaiELIwBBIGsi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ACAHQcABakEAIAogAyAOQQV0aiAKQQV0IgNrIApB5OvBABC3BSAHKALAASADakEgayEDIAcoAsQBIRACQANAIAYgCmoiDUUNAyAGIAxqRQ0BIBAgDUEBa0sEQCAHQZgEaiINIABBGGoiDykDADcDACAHQZAEaiIRIABBEGoiEykDADcDACAHQYgEaiIWIABBCGoiFSkDADcDACAHIAApAwA3A4AEIA8gA0EYaiIPKQMANwMAIBMgA0EQaiITKQMANwMAIBUgA0EIaiIVKQMANwMAIAAgAykDADcDACAPIA0pAwA3AwAgEyARKQMANwMAIBUgFikDADcDACADIAcpA4AENwMAIANBIGshAyAGQQFrIQYgAEEgaiEADAELCyAOQQF2IAZqQQFrIBBBhOzBABD/AwALIAwgDEH068EAEP8DAAtBACEBCyACIAFrIQADQCABQQAgAEEKSRsEQCAHQagBaiABQQFrIgEgAiAJIAhB8OzBABC3BSAHKAKoASAHKAKsARDLASAAQQFqIQAMAQUgB0GwA2ogASAAEMMFA0AgB0G4AWogBygCtAMiACAHKAK4AyICEMACIAcoArwBIQwgBygCuAFBAUcEQCABIQIMBAsCQAJAAkAgAiAMQQFqIhBLBEAgAiAMSwRAIAAgEEEDdGoiAigCBCEOIAdBsAFqIAIoAgAiFiAAIAxBA3QiFWoiACgCBCIaIAAoAgBqIAkgCEGg7cEAELcFIAcoArABIgMgDkEFdCICaiEAIAMgBygCtAEiBkEFdGohDSAGIA5rIgYgDk8NAiASIAAgBkEFdCICEJIJIgogAmohBiANQSBrIQIDQCAAIANNIAYgCk1yDQQgAiAAQSBrIg0gBkEgayIPIA9BBGooAgAgD0EIaigCACANQQRqKAIAIA1BCGooAgAQqQZB/wFxQf8BRiITGyIRKQMANwMAIAJBGGogEUEYaikDADcDACACQRBqIBFBEGopAwA3AwAgAkEIaiARQQhqKQMANwMAIAYgDyATGyEGIA0gACATGyEAIAJBIGshAgwACwALIAwgAkGQ7cEAEP8DAAsgECACQYDtwQAQ/wMACyACIBIgAyACEJIJIgJqIQYDQCACIAZPIAAgDU9yDQIgAyAAIAIgAEEEaigCACAAQQhqKAIAIAJBBGooAgAgAkEIaigCABCpBkH/AXEiD0H/AUYiERsiCikDADcDACADQRhqIApBGGopAwA3AwAgA0EQaiAKQRBqKQMANwMAIANBCGogCkEIaikDADcDACACIA9B/wFHQQV0aiECIAAgEUEFdGohACADQSBqIQMMAAsACyAAIQMgCiECCyADIAIgBiACaxCSCRogBygCuAMiACAMSwRAIAcoArQDIBVqIgAgDiAaajYCBCAAIBY2AgAgB0GwA2ogEBCHBQwBCwsgDCAAQbDtwQAQ/wMACwALAAsACyAIQQJJDQAgCEEFdCAJakFAaiEDQQEhAANAIAAgCEYNASADIABBAWoiABDLASADQSBrIQMMAAsACwwFCyADIAlqIgAgBykDgAQ3AwAgAEEYaiAGKQMANwMAIABBEGogDCkDADcDACAAQQhqIA4pAwA3AwAgA0EgaiEDIAhBAWohCAwACwALIAdBgARqIAFB0AFqKAIAIAFB1AFqKAIAIAhBPGooAgAgCEFAaygCABC6BCAHKAKIBEUEQCAHLQCABCEADAELQQghAyAHQegCaiAHQYgEaikDACIbNwMAIAcgBykDgAQiHDcD4AIgB0EZOgCgAyAHQYgDaiIAIBs3AwAgByAcNwOAAyAHIAdBoANqNgKQAyAHQYAEaiAHQYADahC5AQJAIActAKAEQQNGBEAgB0GAA2oQ/AZBACEAQQAhBkEAIQkMAQsgB0GYAWoQuAQgBygCmAEhASAHKAKcASICIAdBgARqQTgQlAkhAyAHQQE2AtgEIAcgAzYC1AQgByABNgLQBCAHQcADaiAHQZADaigCADYCACAHQbgDaiAAKQMANwMAIAcgBykDgAM3A7ADQTghA0EBIQADQCAHQYAEaiAHQbADahC5AQJAIActAKAEQQNHBEAgACAHKALQBEcNASAHQdAEahDaAiAHKALUBCECDAELIAdBsANqEPwGIAcoAtAEIgZBCHYhCSACIQMMAgsgAiADaiAHQYAEakE4EJIJGiAHIABBAWoiADYC2AQgA0E4aiEDDAALAAsCQAJAIActAKADIgJBGUcEQCADIAAQ6QUgBkH/AXEgCUEIdHIgAxDjBwwBCyADDQEgBiECCyACEO4HQf8BcSEADAELIAdBzQA6AKADIAcgAzYCjAMgByADIABBOGxqNgKIAyAHIAM2AoQDQQghASAHIAZB/wFxIAlBCHRyNgKAAyAHIAdB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IAstALgBIQAMCwsgCygC0AEhACALKALIASEGIAtBEGogAUFAaygCACABQcQAaigCACALKQO4ASIaIAsoAsABIhhB2I3AABClBxDrBCALKAIUIQMCQAJAAkACQAJAQQEgCygCECIMKAKYASIOQQprIA5BCU0bQQNrDgIAAQMLIAtBuAFqIg4gDEE8aigCACAMQUBrKAIAEIIGIA4gAiAAEI0JDAELIAtBADYCwAEgC0KAgICAEDcDuAEgC0G4AWogAiAAEI0JCyALKALAASEOIAsoArwBIQwgCygCuAEhEiADIAMoAgBBAWs2AgAgC0GcAWogCToAACALQZoBaiAEOgAAIAtBmQFqIA06AAAgCyAKOgCYASALQbgBaiALKAKQASAMIA4gFiALKAKUASgCDBEIACALKAK4ASIDDQEgCy0AvAEQ7gchACASIAwQhgggAEH/AXEhAAwLCyADIAMoAgBBAWs2AgBBHCEADAoLIAsoArwBIQkgC0EKNgLQAiALIA42AtABIAsgDDYCzAEgCyASNgLIASALQQA2AsABIAsgCTYCvAEgCyADNgK4ASALQeACaiIDIAIgABCUBSALQaABaiAPIBAgC0G4AWpBACADEKIBIAstAKABBEAgCy0AoQEhAAwKCyAKQQJyIAogDRsiA0EQciADIAQbIgNBCHIgAyAFGyEMIAtBsAFqKAIAIQQgCykDqAEhByALQQhqIAFBQGsoAgAgAUHEAGooAgAgGiAYQeiNwAAQpQcQqAQgCy0ADCEFIAsoAggiA0GgAWooAgBBDUcNBCALIAA2AqgBIAsgAjYCpAEgCyAGNgKgASALQbgBaiADQQhqIAtBoAFqIAcgBBDlBSADIAUQhwgMCAtBzAAhACAGQQJxRQ0FDAYLIAtBrAFqQQE2AgAgC0G0AWpBATYCACALQcQBakEBNgIAIAtBzAFqQQA2AgAgC0HM48EANgKoASALQQA2AqABIAtBCTYC5AIgC0HgjsAANgLAASALQaiVwgA2AsgBIAtBADYCuAEgCyALQeACajYCsAEgCyALQbgBajYC4AIgC0GgAWpB6I7AABCBBgALIAtBrAFqQQE2AgAgC0G0AWpBATYCACALQcQBakEBNgIAIAtBzAFqQQA2AgAgC0HM48EANgKoASALQQA2AqABIAtBCTYC5AIgC0GwjsAANgLAASAL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IgZBBHRqIgUoAgAiBEcEQCABIARHDQIgASACKAJAIgEgAigC0AEiBEF/c3FHDQIgASAEcUUNASADQgA3AzgMCAsgAiACKALIASAGQQFqTQR/IAIoAswBIAFBACACKALMAWtxagUgBAsgAigCACIEIAEgBEYiBBs2AgAgBEUNASADIAU2AjggAyACKALMASABaiIBNgI8IAUgATYCACAFQQxqKAIAIQEgBUEIaigCACEEIAUoAgQhBSACQYABahDpASAERQ0HIAMgATYCCCADIAQ2AgQgAyAFNgIADAgLIAMoAihBgJTr3ANHDQIgAyACNgIUIAMgA0EgajYCGCADIANBOGo2AhAQgwQiAQRAIAEoAgAhBCABQQA2AgAgBEUEQCADENcFNgJQIANBEGogA0HQAGoiARCbAiABEPgGDAILIARCADcCCCADIAQ2AgAgA0EQaiADEJsCIAEoAgAhBSABIAQ2AgAgAyAFNgJQIANB0ABqEJMIBSADENcFNgJQIANBEGogA0HQAGoiARCbAiABEPgGCwwACwALIANBgJTr3AM2AiggA0HIAGpBADYCACADQUBrQgA3AwAgA0IANwM4A0AgAigCACIBQQF2IghBH3EiBkEfRg0AIAIoAgQhBSABQQJqIQQCQCABQQFxRQRAIAggAigCQCIHQQF2Rg0BIAQgASAHc0E/S3IhBAsgBUUNASACIAQgAigCACIHIAEgB0YbNgIAIAEgB0cNASAGQR5GBEAgBRCUCCIBKALwAyEHIAIgATYCBCACIARBAmpBfnEgB0EAR3I2AgALIANBxABqIgEgBjYCACADIAU2AkAgBUUNBSAFIAEoAgAiAUEEdGoiBhCVCCAGKAIIIQcgBigCBCEEIAYoAgAhCEEAIQIgAUEBaiIBQR9HBEAgBiAGKAIMIgZBAnI2AgwgASECIAZBBHFFDQULQR4gAmsiAUEAIAFBHk0bIQEgAkEEdCAFakEMaiECA0AgAUUEQCAFEH4MBgsgAi0AAEECcUUEQCACIAIoAgAiBkEEcjYCACAGQQJxRQ0GCyABQQFrIQEgAkEQaiECDAALAAsgB0EBcQRAIANBADYCQAwFCyADKAIoQYCU69wDRw0BIAMgAjYCFCADIANBIGo2AhggAyADQThqNgIQEIMEIgEEQCABKAIAIQQgAUEANgIAIARFBEAgAxDX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AgQgABCoCAALQZ62wQBBGSAGQZABakGstcEAQbi2wQAQ6QMACxDGBQALAAsgABCLCCAFRQ0BCyAPIAkQ3wcLIAYoAlghAAsgABCLCAsgBkGwAmokACAHQf8BcQudDgIJfwJ+IwBBsAFrIgMkACADQShqIAEQ+wUgAygCLCEJIAMoAighAQJ/AkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkAgAgRAIANBIGogASACQQAgAxBMQQEhBCADKAIkIQIgAygCIEUNAQwQCyABKQMQQgBSDQFBASEEQYzSwQBB+wAQOCECDA8LIAIQiwggASkDEFANAQsCQAJAIAFBIGpBmNPBABD4ASICRQRAIANB+ABqQQRyQZjTwQBBBhCbBAwBCyACKQMAUA0BIANBgAFqQQA2AgALIANB6ABqIANBhAFqKAIANgIAIAMgAykCfDcDYEGI1MEAQSIQOCECIANB4ABqELQHQQEhBAwOCyADQQAQQyIENgIwQQghBSACQQhqIgYgASgCeBCXBCECIANBITYCeCACKAIQQSEgBBBEIQIgA0EYahDgBiADKAIcIAIgAygCGCIEGyECIAQNASADIAI2AjQgA0H4AGoQ1QcgAyAGIAEoAngQlwQiASgCCCIENgI4IAMgAUEMaigCACIBNgI8AkAgAQ4CBAMACyADIAI2AkQgAyACEC02AlAgA0IANwNIIAMgA0E4ajYCWCADIANBxABqNgJUIANB+ABqIANByABqEPoDIAMoAnhBBkYEQCADQQA2AqgBIANCgICAgIABNwOgAQwFCyADQQhqQQQgA0HQAGoiASgCACICIAMoAkxrIgVBACACIAVPG0EBaiICQX8gAhsiAiACQQRNGxClBCADQYABaiIKKQMAIQwgA0GIAWoiCykDACENIAMoAgghBSADKAIMIgYgAykDeDcDACAGQRBqIA03AwAgBkEIaiAMNwMAIANB8ABqIANB2ABqKAIANgIAIANB6ABqIAEpAwA3AwAgAyADKQNINwNgQRghAUEBIQIDQCADQfgAaiADQeAAahD6AwJAIAMoAnhBBkcEQCACIAVHDQECf0EAIAUgAygCaCIEIAMoAmRrIgdBACAEIAdPG0EBaiIEQX8gBBtqIgQgBUkNABpBBCAFQQF0IgcgBCAEIAdJGyIEIARBBE0bIgdBGGwhCCAHQdaq1SpJQQN0IQQgAyAFBH8gAyAGNgKgASADIAVBGGw2AqQBQQgFQQALNgKoASADQZABaiAIIAQgA0GgAWoQ4AIgAygClAEhBCADKAKQAQRAIAMoApgBDAELIAchBSAEIQZBgYCAgHgLIQggBCAIEKkHDAELIAMgAjYCqAEgAyAGNgKkASADIAU2AqABDAYLIAEgBmoiBCADKQN4NwMAIARBEGogCykDADcDACAEQQhqIAopAwA3AwAgAUEYaiEBIAJBAWohAgwACwALQff4wQBBK0GI08EAEJEFAAsgAhDQASEBIANB+ABqENUHIANBMGoQ1QcMBAsgA0H4AGogBCACEMMBQRgQUCIBRQ0EIAEgAykDeDcDACABQRBqIANBiAFqKQMANwMAIAFBCGogA0GAAWopAwA3AwAgA0EBNgJoIAMgATYCZCADQQE2AmAgA0EQaiADQeAAahCEBCADKAIUIQEgAygCECEFCyADQTRqENUHDAELIAMgA0GgAWoQhAQgAygCBCEBIAMoAgAhBSADQcQAahDVBwsgA0EwahDVByAFRQ0AQQAhAiABRQ0GIAUQfgwGC0EBIQQgASABKAIAIgJBACACQQFHIgIbNgIAIAINAyADIAE2AnggASgCCCEGIAFBDGooAgAhBSABQRBqKAIAIQIgAUEUaigCACEHIANB+ABqELwGIAUhAQJAAkAgBkEBaw4DAAEFAQsgBSACKAIcIgERBwBC0OOG7bzIqJoQUQ0CC0EYEFAiAQ0CCwALIAUgAREHAELQ44btvMiomhBRDQIgAyACNgJ8IAMgBTYCeEGw+8EAQSsgA0H4AGpBtNbBAEGg18EAEOkDAAsgASAHNgIUIAEgAjYCECABIAU2AgwgASAGNgIIIAFCgYCAgBA3AgALIAMgATYCoAEgA0GEAWpBATYCACADQYwBakEBNgIAIANBxNPBADYCgAEgA0EANgJ4IANByQA2AkwgAyADQcgAajYCiAEgAyADQaABaiIFNgJIIANB4ABqIANB+ABqEMwDIAMoAmQiASADKAJoEDghAiADKAJgIAEQhgggBRDvBgwCCyAFKAIEIQIgBSgCACEBIAUQfiABRQ0AIAMgAjYCpAEgAyABNgKgASADQYQBakEBNgIAIANBjAFqQQE2AgAgA0GA1MEANgKAASADQQA2AnggA0E6NgJMIAMgA0HIAGo2AogBIAMgA0GgAWo2AkggA0HgAGogA0H4AGoQzAMgAygCZCIBIAMoAmgQOCECIAMoAmAgARCGCAwBC0EAIQRBAAwBCyACCyEBIAlBADYCACAAIAQ2AgggACABNgIEIAAgAjYCACADQbABaiQAC90OAQF/IwBBIGsiAiQAAn8CQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQCAALQAAQQFrDhgBAgMEBQYHCAkKCwwNDg8QERITFBUWFxgACyACQRRqQQE2AgAgAkEcakEANgIAIAJB5PjAADYCECACQaiVwgA2AhggAkEANgIIIAEoAgAgAUEEaigCACACQQhqEOYEDBgLIAJBFGpBATYCACACQRxqQQA2AgAgAkHI+MAANgIQIAJBqJXCADYCGCACQQA2AgggASgCACABQQRqKAIAIAJBCGoQ5gQMFwsgAkEUakEBNgIAIAJBHGpBADYCACACQbD4wAA2AhAgAkGolcIANgIYIAJBADYCCCABKAIAIAFBBGooAgAgAkEIahDmBAwWCyACQRRqQQE2AgAgAkEcakEANgIAIAJBnPjAADYCECACQaiVwgA2AhggAkEANgIIIAEoAgAgAUEEaigCACACQQhqEOYEDBULIAJBFGpBATYCACACQRxqQQA2AgAgAkGI+MAANgIQIAJBqJXCADYCGCACQQA2AgggASgCACABQQRqKAIAIAJBCGoQ5gQMFAsgAkEUakEBNgIAIAJBHGpBADYCACACQfT3wAA2AhAgAkGolcIANgIYIAJBADYCCCABKAIAIAFBBGooAgAgAkEIahDmBAwTCyACQRRqQQE2AgAgAkEcakEANgIAIAJB5PfAADYCECACQaiVwgA2AhggAkEANgIIIAEoAgAgAUEEaigCACACQQhqEOYEDBILIAJBFGpBATYCACACQRxqQQA2AgAgAkHI98AANgIQIAJBqJXCADYCGCACQQA2AgggASgCACABQQRqKAIAIAJBCGoQ5gQMEQsgAkEUakEBNgIAIAJBHGpBADYCACACQaT3wAA2AhAgAkGolcIANgIYIAJBADYCCCABKAIAIAFBBGooAgAgAkEIahDmBAwQCyACQRRqQQE2AgAgAkEcakEANgIAIAJBhPfAADYCECACQaiVwgA2AhggAkEANgIIIAEoAgAgAUEEaigCACACQQhqEOYEDA8LIAJBFGpBATYCACACQRxqQQA2AgAgAkHo9sAANgIQIAJBqJXCADYCGCACQQA2AgggASgCACABQQRqKAIAIAJBCGoQ5gQMDgsgAkEUakEBNgIAIAJBHGpBADYCACACQcz2wAA2AhAgAkGolcIANgIYIAJBADYCCCABKAIAIAFBBGooAgAgAkEIahDmBAwNCyACQRRqQQE2AgAgAkEcakEANgIAIAJBtPbAADYCECACQaiVwgA2AhggAkEANgIIIAEoAgAgAUEEaigCACACQQhqEOYEDAwLIAJBFGpBATYCACACQRxqQQA2AgAgAkGU9sAANgIQIAJBqJXCADYCGCACQQA2AgggASgCACABQQRqKAIAIAJBCGoQ5gQMCwsgAkEUakEBNgIAIAJBHGpBADYCACACQfT1wAA2AhAgAkGolcIANgIYIAJBADYCCCABKAIAIAFBBGooAgAgAkEIahDmBAwKCyACQRRqQQE2AgAgAkEcakEANgIAIAJB3PXAADYCECACQaiVwgA2AhggAkEANgIIIAEoAgAgAUEEaigCACACQQhqEOYEDAkLIAJBFGpBATYCACACQRxqQQA2AgAgAkG89cAANgIQIAJBqJXCADYCGCACQQA2AgggASgCACABQQRqKAIAIAJBCGoQ5gQMCAsgAkEUakEBNgIAIAJBHGpBADYCACACQaT1wAA2AhAgAkGolcIANgIYIAJBADYCCCABKAIAIAFBBGooAgAgAkEIahDmBAwHCyACQRRqQQE2AgAgAkEcakEANgIAIAJBiPXAADYCECACQaiVwgA2AhggAkEANgIIIAEoAgAgAUEEaigCACACQQhqEOYEDAYLIAJBFGpBATYCACACQRxqQQA2AgAgAkHs9MAANgIQIAJBqJXCADYCGCACQQA2AgggASgCACABQQRqKAIAIAJBCGoQ5gQMBQsgAkEUakEBNgIAIAJBHGpBADYCACACQdz0wAA2AhAgAkGolcIANgIYIAJBADYCCCABKAIAIAFBBGooAgAgAkEIahDmBAwECyACQRRqQQE2AgAgAkEcakEANgIAIAJBxPTAADYCECACQaiVwgA2AhggAkEANgIIIAEoAgAgAUEEaigCACACQQhqEOYEDAMLIAJBFGpBATYCACACQRxqQQA2AgAg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aw4ECQkBAAELIAEQ8AENBwsgAiAFTw0ACwwDCyAERQ0BIAFBHWohCANAAkAgAkH/AXEiBEECRwRAIARBAWsNBgwBCyAFAn8gASgCBCICRQRAIAhBAToAAEEBDAELIANBIGogARCnASADKAIgIQQgA0EQaiAJQQhqKQAANwMAIANBF2ogCUEPaigAADYAACADIAkpAAA3AwggAiAEayEGIAIgBEkNDCADKQIkIQ8gAy0ALCECIAEgBjYCBCACQf8BcUEKRw0NQQILIgJNDQEMBAsLIAFBHWpBADoAAAsgASgCBCIGQQFrIQQgBgRAIABBBjoACCABIAQ2AgQMDQsgBEEAQazJwAAQzQgACyABQR1qIQQDQAJAAkACQCACQf8BcUEBaw4CAQAFCyABKAIEIgJFBEBBASECIARBAToAAAwCCyADQSBqIAEQpwEgAygCICEIIANBEGogCUEIaikAADcDACADQRdqIAlBD2ooAAA2AAAgAyAJKQAANwMIIAIgCGshBiACIAhJDQogAykCJCEPIAMtACwhAiABIAY2AgQgAkH/AXFBCkcNC0ECIQIMAQtBACECIARBADoAACAKQQdxIgZBB0YNBQJAIAZBA2sOBAYGAQABCyABEPABDQQLIAIgBU8NAAsLIABBCjoACAwKCyAKQQZGDQgCQAJAIActAABBAWsOBQQGAAEGBQsgBygCCEF8Rg0JDAULIAcoAgggBygCECIEQQFqQQAgBBtqQX5GDQgMBAsgASgCBCIGQQFrIQQgBkUNBiAAQQc6AAggASAENgIEDAgLIABBBjoACAwHCyAHKAIIIAcoAhAiBEEBakEAIAQbakEIag0BDAULIAcoAghBfEYNBAsgACAKOgAIIAFBHWpBAzoAACAAIAEpAgA3AgAgACABQQlqKQAANwAJIABBEWogAUERaikAADcAACAAQRhqIAFBGGooAAA2AAAMBAsgBiACQZzJwAAQzQgACyAAIAI6AAggACAPNwIAIAAgAykDCDcACSAAQRFqIANBEGopAwA3AAAgAEEYaiADQRdqKAAANgAADAILIARBAEG8ycAAEM0IAAsgAEEKOgAIIAFBHWpBAzoAAAsgA0FAayQAC/oNAgp/AX4jAEHAA2siAyQAIAApAwAhDSABQdjmwQAQzwchASADIAI2AlAgAyAANgJIIAMgATYCQCADIA03AzggA0GIAmoiACADQThqEKMDIAMoAkgQjwQgA0GgAmooAgAhCyADKAKcAiEBIAMoApgCIQUgAygCkAIQiwggACAFQfAAaiIAIAIQlQMCQAJAIAMtAIgCDQAgAyACNgJcIANBiAJqIAAgAhDvAyADLQCIAg0AIAMpA5ACIQ0gAyADQZgCaigCACIANgKQAiADIA03A4gCAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkAgAUE4aigCACABQTxqKAIAIA0gABCsBSICRQRAIAFBGGooAgBFDQEgASkDACABQQhqKQMAIA0gABDeAyENIAMgA0GIAmo2ArgDIAMgAUEQaiIANgJkIAAoAgAhACADIANBuANqNgJgIANBMGogACABQRxqIgAoAgAgDSADQeAAakHtABCYAyADKAIwRQ0BIAAoAgAiAEUNASAAIAMoAjRB6H1sakGIAmshAgsgAi0AhAIhCCADQShqIAIQqAQgAygCKCIAQQhqIQRBAiECIAMtACwhB0EBIABBoAFqKAIAIgZBCmsgBkEJTRtBAWsOBwECAw8ODgUEC0EIIQIMEAsgA0GMAWpBADYCACADQfgBakEJNgIAIANBAjsBYCADQYgCaiICIARBqAEQkgkaIAQgA0HgAGoiAUGoARCSCRogASACQagBEJIJGiABENUBDAMLIANBiAJqIgEQ5AQgAyADKAKMAiIFNgK0AyADIAMoAogCIgg2ArADIANBkAJqEMkBIAEQ5AQgA0GUAmooAgAhBiADKAKQAiEJIAEQhwIgASAAQSRqEOYIIAMoAogCDQMgA0GQAmoiAS0AACEKIAMoAowCIgIpAgQhDSACQQhqIAY2AgAgAiAJNgIEIAMgDTcDuAMgAiAKEP8HIANBiAJqIABBGGoQ5gggAygCiAINBCABLQAAIQYgAygCjAIiAikCBCENIAJBCGogBTYCACACIAg2AgQgAyANNwOwAyACIAYQ/wcgASAEQQhqKQIANwMAIABBFGpBADYCACADIAQpAgA3A4gCIAMoApQCIgEEQCADQZACaiADKAKIAiADKAKMAiABKAIIEQMACyADQbgDahDJASADQbADahCHAgwCCyADQSBqIABBxABqKAIAIABByABqKAIAEOsDIAMoAiAiBEUNCiADQYgCaiICIAQgAygCJBCfASADQeAAaiACENIGIAIQmQcgAEEoaikDAEIBUg0JIABBOGooAgAhAiAAQTBqKQMAIQ0gACAHQQBHEJUJIANBGGogAUE4aigCACABQTxqKAIAIA0gAkHQoMEAEKUHEKgEIAMoAhgiB0GgAWooAgBBDWtBAk8NBCADLQAcIQYgA0GIAmoiACAFQaABahDICCADQRBqIABBvKHBABDYBCADLQAUIQEgACADKAIQIgBBCGogA0HcAGoQ5QIgAykDiAJQDQUgACABEIcIIAhFDQcgB0EIaiEEIANBiAJqIgAgBUHYAWoiBRDjBiADQQhqIQIjAEEQayIBJAACQCAAKAIARQRAIAIgACkCBDcDACABQRBqJAAMAQsgASAAKQIENwMIQbD7wQBBKyABQQhqQYiNwQBB3KHBABDpAwALIAMoAgwhACADKAIIIgEoAghBAnQhCCABKAIEIQlBACECIAMoAlwhCkEAIQECQANAIAIgCEYNASACIAlqIQwgAkEEaiECIAFBAWohASAMKAIAIApHDQALIAAgACgCAEEBazYCACADQYgCaiIAIAQgA0HgAGoQvgIgACAFEPkEIAMgAEHsocEAENkEIAMoAgAiAEEQaigCACIEIAFBAWsiBU0NByADLQAEIQUgAEEMaigCACACaiICQQRrIAIgBCABa0ECdBCUCRogACAEQQFrNgIQIAAgBRCHCAwICyAAIAAoAgBBAWs2AgAMBwsgACkDCCENIABBADYCCCADIA03A4gCIANBiAJqENgGCyAAIAcQhwgMBgsgAyADKAKMAjYCYCADIANBkAJqLQAAOgBkQbD7wQBBKyADQeAAakHEt8EAQZC5wQAQ6QMACyADIAMoAowCNgJgIAMgAS0AADoAZEGw+8EAQSsgA0HgAGpB1LfBAEGgucEAEOkDAAtBpKHBAEGsocEAEJIFAAtB9/jBAEErQcyhwQAQkQUACyAFIARB/KHBABCABAALIAcgBhCHCCADKAJgIAMoAmQQhggLQQAhAgwECyADKAJgIAMoAmQQhggLQRwhAgsgACAHEIcIDAELIAMtAIkCIQILIAsgCygCAEEBazYCACADQcADaiQAIAJB/wFxC8sOAg1/A34jAEHwAWsiAyQAIANBOGogARD7BSADKAI8IQ0gAygCOCELAn8CQAJAIAIQ8ggEQCADQeAAakEANgIAIAMgAjYCWCADQQA2AkQgA0GoAWogCyACEJoCIAMoAqgBIQogAygCxAEiAUUNASADQfwAaiADQbwBaikCADcCACADQfQAaiADQbQBaikCADcCACADIAMpAqwBNwJsIAMgATYChAEgAyAKNgJoIAtBiAFqEOwHIAtBATYCiAEgC0GMAWogA0FAa0EoEJIJGhA1IQogA0GIAWogA0HoAGoQngUgA0EoahDzBCADQbgBaiEBQZDZwQAhAiADKQMwIRAgAykDKCERA0AgA0EgaiADQYgBahCABwJAAkAgAygCICIGBEAgAygCJCEMIAMgAjYCxAEgAyAHNgLAASADIAU2ArwBIAMgBDYCuAEgAyAQNwOwASADIBE3A6gBIAMgDDYCzAEgAyAGNgLIASAGKAIEIQIgAyAGKAIIIgQ2AtwBIAMgAjYC2AEgESAQIAIgBBC6ASEQIAMgA0HYAWo2AuQBIAMgATYC7AEgAyADQeQBajYC6AEgA0EYaiADKAK4ASADKALEASAQIANB6AFqQTkQmAMgAygCGEEAIAMoAsQBIgIbDQEgAygCvAFFBEAjAEHQAGsiAiQAIAIgA0GoAWo2AgggAUEIaigCACEFIAIgAkEIajYCDAJAAkAgBUEBaiIEBEAgASgCACIHIAdBAWoiDkEDdkEHbCAHQQhJGyIHQQF2IARJBEAgAkEoaiAFQRQgBCAHQQFqIgUgBCAFSxsQ+wIgAigCNCIFRQ0CIAIgAikDODcDICACIAU2AhwgAiACKQIsNwIUIAIgAigCKCIPNgIQQWwhB0EAIQQDQCAEIA5GBEAgASkCACERIAEgAikDEDcCACACQRhqIgQpAwAhEiAEIAFBCGoiBCkCADcDACAEIBI3AgAgAiARNwMQIAJBEGoQ5gYMBQsgASgCDCIIIARqLAAAQQBOBEAgAiAPIAUgAkEMaiABIAQQ/wUQ1QYgBSACKAIAQX9zQRRsaiIJIAcgCGoiCCkAADcAACAJQRBqIAhBEGooAAA2AAAgCUEIaiAIQQhqKQAANwAACyAEQQFqIQQgB0EUayEHDAALAAsgASACQQxqQTtBFBCgAQwCCxDIBQALIAIoAiwaCyACQdAAaiQAIAMoAsQBIQILIAMpA9gBIREgA0EQaiADKAK4ASACIBAQ1QYgAy0AFCEFIAMoAsQBIAMoAhBBbGxqIgJBFGsiBEEANgIQIARCgICAgMAANwIIIAQgETcCACADIAMoAsABQQFqNgLAASADIAMoArwBIAVBAXFrNgK8AQwCCyAEQQFqIQEgAikDACEQIAMgBAR/IAIgAUEUbEEHakF4cSIGayEFIAQgBmpBCWohBEEIBUEACzYC0AEgAyAENgLMASADIAU2AsgBIAMgBzYCwAEgAyACNgK4ASADIAEgAmo2ArQBIAMgAkEIajYCsAEgAyAQQn+FQoCBgoSIkKDAgH+DNwOoAQNAAkAgA0GoAWoQ1QMiAgRAIAJBFGsiASgCACIHDQELAkAgAygCwAFFDQADQCADQagBahDVAyIBRQ0BIAFBFGsiAUEIaigCACABQQxqKAIAEM4HDAALAAsCQCADKALQAUUNACADKALMAUUNACADKALIARB+CyADQfgAahDWA0EAIQJBAAwICyABQQxqKAIAIQQgAUEIaigCACEMIAFBBGooAgAhCSACQQRrKAIAQQxsIQEQNSEGIAQhAgNAAkAgAQRAIAIoAgAiCA0BCyAMIAQQzgcgAyAHIAkQByIBNgLYASADIAY2AugBIANBiAFqIAogASAGEPAEIAMtAIgBIAMoAowBQdTxwQBBLkGE8sEAEOoFIANB6AFqENUHIANB2AFqENUHDAILIAIoAgghBSADIAggAigCBBAHIgg2AtgBIANBCGogBSkDACAFQRBqKAIAELEHIAMgAygCCCADKAIMIAsoAngQkAQoAgAQACIFNgLoASADQYgBaiAGIAggBRDwBCADLQCIASADKAKMAUG08MEAQTBBxPHBABDqBSABQQxrIQEgAkEMaiECIANB6AFqENUHIANB2AFqENUHDAALAAsACyACIAMoAhxBbGxqIQILIAZBFGooAgAhBSAGQRBqKAIAIQcgAkEUayIJQRBqIgYoAgAiBCAJQQhqIgkoAgBGBEAgCSAEEP4CIAYoAgAhBAsgAkEIaygCACAEQQxsaiICIAw2AgggAiAFNgIEIAIgBzYCACAGIAYoAgBBAWo2AgAgAygCxAEhAiADKALAASEHIAMoArwBIQUgAygCuAEhBCADKQOwASEQIAMpA6gBIREMAAsAC0G3zsEAQc8AEDghCiACEIsIDAELIANBQGsQ+gULIAohAkEBCyEBIA1BADYCACAAIAE2AgggACACNgIEIAAgCjYCACADQfABaiQAC8ML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IAcgBSACIARBGGoQiQEgBC0AMEUEQCAEIAU2AhQgASgCBCICIAVJDQMgASACIAVrNgIEIAEgASgCACAFajYCACAAQQA6AAAgACAFNgIEDAQLIAQtADEhASAAQQE6AAAgACABOgABDAMLIABBgTo7AQAgBSAKENwGDAILIAQgBC0AIDoANCAEIAQoAhw2AjBBsPvBAEErIARBMGpB8N/BAEH42cEAEOkDAAsgBEE8akE1NgIAIARBJGpBAjYCACAEQSxqQQI2AgAgBEHY4MEANgIgIARBADYCGCAEQTU2AjQgBCACNgIIIAQgBEEwajYCKCAEIARBCGo2AjggBCAEQRRqNgIwIARBGGpBxOHBABCBBgALIARBQGskAAvBBQEHfyMAQdAAayIDJAAgAS0ABCEFIAFBAjoABAJAAkACQAJAIAVBAkcEQCABKAIAIQQgASgAECEGIAEoAAwhByABKAAIIQEgA0GAAjsBICADQQA2AgwgAigCACIIIAgoAgAiCUEBajYCACAJQQBIDQEgAyAINgJAIAMgATYCOCADIANBCGo2AjwgBEEcaiADQThqEI0FIARBBGoQnQIgBCAFEPkHAkACQAJAAkACQCACIAcpAwAgBygCCBCXBkEBaw4DAwIBAAtBhPrBAEEoQcywwQAQkQUACyADQQhqIgEQ5QggA0EANgI8IAEgA0E4ahDRBSADKAI8RQ0FIAAgAykDODcCACAAQRBqIANByABqKQMANwIAIABBCGogA0FAaykDADcCAAwCCyADQThqIAYQ+gQgAygCOARAIAMgAygCPDYCKCADIANBQGstAAA6ACxBsPvBAEErIANBKGpBzK/BAEGssMEAEOkDAAsgA0FAayICLQAAIQQgA0E4aiADKAI8IgVBHGogARDfBCADKAJARQ0GIANBMGoiASACKAIANgIAIAMgAykDODcDKCABEPgGIAUgBBD5ByAAQQA2AgQgAEEBOgAADAELIANBOGogBhD6BCADKAI4BEAgAyADKAI8NgIoIAMgA0FAay0AADoALEGw+8EAQSsgA0EoakHMr8EAQbywwQAQ6QMACyADQUBrIgItAAAhBCADQThqIAMoAjwiBUEcaiABEN8EIAMoAkBFDQQgA0EwaiIBIAIoAgA2AgAgAyADKQM4NwMoIAEQ+AYgBSAEEPkHIABBADYCBCAAQQA6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AiggAiACNgIgIAEoAgAgACACQQhqEOYEDAYLIAJBLGpBATYCACACQTRqQQE2AgAgAkH81sAANgIoIAJBADYCICACQRw2AgwgAiAANgI8IAFBBGooAgAhACACIAJBCGo2AjAgAiACQTxqNgIIIAEoAgAgACACQSBqEOYEDAULIAAgARChAwwECyACIAA2AjwgAkEsakEBNgIAIAJBNGpBATYCACACQfjawAA2AiggAkEANgIgIAJBIDYCDCABQQRqKAIAIQAgAiACQQhqNgIwIAIgAkE8ajYCCCABKAIAIAAgAkEgahDmBAwDCyACQSxqQQE2AgAgAkE0akEANgIAIAJB0NrAADYCKCACQaiVwgA2AjAgAkEANgIgIAEoAgAgAUEEaigCACACQSBqEOYEDAILIABBGGogARCuAQwBCyACQSxqQQI2AgAgAkE0akEBNgIAIAJBmNrAADYCKCACQQA2AiAgAkEcNgIMIAIgADYCPCABQQRqKAIAIQAgAiACQQhqNgIwIAIgAkE8ajYCCCABKAIAIAAgAkEgahDmBAshACACQUBrJAAgAAuiBQEHfyMAQTBrIgMkACABLQAEIQUgAUECOgAEAkACQAJAAkAgBUECRwRAIAEoAgAhBCABKAAQIQYgASgADCEHIAEoAAghASADQYACOwEMIANBADYCBCACKAIAIgggCCgCACIJQQFqNgIAIAlBAEgNASADIAg2AiggAyABNgIgIAMgAzYCJCAEQRxqIANBIGoQjQUgBEEEahCdAiAEIAUQ+QcCQAJAAkACQAJAIAIgBykDACAHKAIIEJcGQQFrDgMDAgEAC0GE+sEAQShBzLDBABCRBQALIAMQ4wggAygCBCEBIANBADYCBCABRQ0FIAMoAgAhAiAAIAMoAgg2AgggACABNgIEIAAgAjYCAAwCCyADQSBqIAYQ+gQgAygCIARAIAMgAygCJDYCECADIANBKGotAAA6ABRBsPvBAEErIANBEGpBzK/BAEGssMEAEOkDAAsgA0EoaiICLQAAIQQgA0EgaiADKAIkIgVBHGogARDfBCADKAIoRQ0GIANBGGoiASACKAIANgIAIAMgAykDIDcDECABEPgGIAUgBBD5ByAAQQA2AgQgAEEBOgAADAELIANBIGogBhD6BCADKAIgBEAgAyADKAIkNgIQIAMgA0Eoai0AADoA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aigCACIAIAAoAgBBAWs2AgAMAQsgAygCDCEHIAMgASAGEOsDIAMoAgAiBkUEQEEOIQAMAwsgA0EQaiAGIAMoAgQQhQUgA0EgaiAEIAAgBxDyAyADLQAgBEAgAy0AISEADAILIANBIGogBCADKAIkIgAgA0EQahDbAgJAIAMoAiAiBEECRwRAIAQNAUEBIQAMAwsgAy0AJCEADAILIAMoAighBCADKAIkIQcgAygCECADKAIUEIYIIAIgARCGCCAFIAUoAgBBAWs2AgAgA0EgaiAIEKcEIANBKGotAAAhAiADKAIkIQEgAygCIEUEQCADQSBqIgUgAUEIaiAEQeDqwAAQ5AIgBRDqBCABQRRqKAIAIAFBGGooAgAgACAHEO0DIQAgASACEMwEDAULIAEgAhDFBwtBBCEADAMLIAMoAhAgAygCFBCGCAsgAiABEIYICyAFIAUoAgBBAWs2AgALIANB8ABqJAAgAAvlAwEGfyMAQTBrIgQkAAJAAkACQAJAAkACQAJAAkAgAUEMaigCACICBEAgASgCCCEFIAJBAWtB/////wFxIgJBAWoiA0EHcSEGAn8gAkEHSQRAQQAhAyAFDAELIAVBPGohAiADQfj///8DcSEHQQAhAwNAIAIoAgAgAkEIaygCACACQRBrKAIAIAJBGGsoAgAgAkEgaygCACACQShrKAIAIAJBMGsoAgAgAkE4aygCACADampqampqamohAyACQUBrIQIgB0EIayIHDQALIAJBPGsLIQIgBgRAIAJBBGohAgNAIAIoAgAgA2ohAyACQQhqIQIgBkEBayIGDQALCyABQRRqKAIADQEgAyECDAQLQQAhAiABQRRqKAIARQ0BDAILIAUoAgQgA0EQT3INAQwDC0EBIQMMAwsgAyADaiICIANJDQELIAJFDQAgAkEASA0CIAIQUCIDDQEAC0EBIQNBACECCyAAQQA2AgggACADNgIEIAAgAjYCACAEIAA2AgwgBEEgaiABQRBqKQIANwMAIARBGGogAUEIaikCADcDACAEIAEpAgA3AxAgBEEMakHgkMAAIARBEGoQkwFFDQFBpJHAAEEzIARBKGpB2JHAAEGAksAAEOkDAAsQxgUACyAEQTBqJAALhAQBAn8jAEFAaiICJAACfwJAAkACQAJAQQIgACgCECIDQQJrIANBAkkbQQFrDgMBAgMA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A0E0akEBNgIAIANBlPHAADYCKCADQQA2AiAgA0EBNgI8IAMgATYCOCADIANBOGo2AjAgA0EQaiIBIANBIGoiAhDLAyACQQAgARDyBiAAIAMpAyA3AgAgBSAHEMwEDAMLIANBLGpBAjYCACADQTRqQQE2AgAgA0Hk8MAANgIoIANBADYCICADQQE2AjwgAyABNgI4IAMgA0E4ajYCMCADQRBqIgEgA0EgaiICEMsDIAJBASABEPIGIAAgAykDIDcCAAwCCyADQRBqQSdBpPHAAEEeEIsFIAUgBxDFByAAIAMpAxA3AgAMAQsgA0EIaiAGQcgAaigCACAGQcwAaigCACAGQUBrKAIAIghB2PLAABDiBSADKAIIIQkgAygCDCIBIAIoAggiBEsEQCACKAIAIgQgAUkEQCACIAEgBGsQlAMLIAIgATYCCCABIQQLIAIoAgQgBCAJIAFB6PLAABD9BiAAIAE2AgQgBiABIAhqNgJAIABBBDoAACAFIAcQzAQLIANBQGskAAv+BAEFfyMAQSBrIgAkABDdAiIBQRBqIgJBACACKAIAIgIgAkECRiICGzYCAAJAAkACQAJAAkAgAkUEQCABQRRqIgItAAAhAyACQQE6AAAgACADQQFxIgM6AAQgAw0BQQAhA0GMncIAKAIAQf////8HcQRAEJgJQQFzIQMLIAEtABUNAiABIAEoAhAiBEEBIAQbNgIQIARFDQUgBEECRw0DIAEoAhAhBCABQQA2AhAgACAENgIEIARBAkcNBAJAIAMNAEGMncIAKAIAQf////8HcUUNABCYCQ0AIAFBAToAFQsgAkEAOgAACyABIAEoAgAiAkEBazYCACACQQFGBEAgARCVBQsgAEEgaiQADwsgAEEANgIcIABBqJXCADYCGCAAQQE2AhQgAEH03cEANgIQIABBADYCCCAAQQRqIABBCGoQrQQACyAAIAM6AAwgACACNgIIQbD7wQBBKyAAQQhqQZTOwABB2M7AABDpAwALIABBFGpBATYCACAAQRxqQQA2AgAgAEGAz8AANgIQIABBqJXCADYCGCAAQQA2AgggAEEIakGIz8AAEIEGAAsgAEEANgIcIABBqJXCADYCGCAAQQE2AhQgAEG4z8AANgIQIABBADYCCCMAQSBrIgEkACABQZDOwAA2AgQgASAAQQRqNgIAIAFBGGogAEEI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IQUgAykDGEGs5cEAEO0HIAVEAAAAAAAA4MNmIQEgAEL///////////8AAn4gBZlEAAAAAAAA4ENjBEAgBbAMAQtCgICAgICAgICAfwtCgICAgICAgICAfyABGyAFRP///////99DZBtCACAFIAVhGzcDCAwCCyADQShqIAIQhwYgAysDMCEFIAMpAyhBnOXBABDtByAAIAW2OAIEDAELIANBOGogAhCHBiADKwNAIQUgAykDOEGM5cEAEO0HIAAgBTkDCAsgACAENgIAIANBkAFqJAALtwMBDX8jAEEQayIEJABBBCEIAkACQCACBEAgAkHmzJkzSw0BIAJBFGwiBkEASA0BIAYgAkHnzJkzSUECdBDUByIIRQ0CCyAAIAg2AgQgACACNgIAIAJBFGwhDSACIQYDQCAGRSAHIA1GckUEQCAHIAhqIgUCfwJAAkACQAJAIAEgB2oiAy0AAEEBaw4DAQIDAAsgBEEIaiADQQRqKAIAIANBCGooAgAQ8gQgBCgCDCEJIAQoAgghCiAEIANBDGooAgAgA0EQaigCABDyBCAEKAIEIQsgBCgCACEMQQAMAwsgA0ECai0AACEOIANBAWotAAAhD0EBDAILIANBEGooAgAhCyADQQxqKAIAIQwgA0EIaigCACEJIANBBGooAgAhCkECDAELIANBEGooAgAhCyADQQxqKAIAIQwgA0EIaigCACEJIANBBGooAgAhCkEDCzoAACAFQRBqIAs2AgAgBUEMaiAMNgIAIAVBCGogCTYCACAFQQRqIAo2AgAgBUECaiAOOgAAIAVBAWogDzoAACAGQQFrIQYgB0EUaiEHDAELCyAAIAI2AgggBEEQaiQADwsQxgUACwAL9AMCBn8BfiMAQfAAayIEJAAgACkDACEKIAFBtOfBABDPByEBIAQgAzcDMCAEIAI2AiggBCAANgIgIAQgATYCGCAEIAo3AxAgBEE4aiIGIARBEGoQowMgBCgCIBCPBCAEQdAAaiIBKAIAIQcgBCgCTCEAIAQoAkghBSAEKAJAEIsIIAYgBUHwAGogAhCVAwJAIAQtADgEQCAELQA5IQIMAQtBAiECIAEpAwBCgICAAoNQDQAgBEEIaiAAQThqKAIAIABBPGooAgAgBCkDQCIKIARByABqKAIAIghBkIjBABClBxCoBEEIIQIgBCgCCCIBQQhqIQUg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GGogAjYCACADIAo3AwggAUECayEEIABByABqIQIgAUEFdCAAakEgayEAA0ACQCAEBEAgAkEEaygCACACKAIAIAYgBxCpBkH/AXFB/wFGDQEgAkEoayEACyAAIAY2AgQgACAHNgIIIAAgCDYCACAAIAMpAwg3AgwgAEEUaiADQRBqKQMANwIAIABBHGogA0EYaigCADYCAAwCCyACQShrIgEgAkEIayIFKQMANwMAIAFBGGogBUEYaikDADcDACABQRBqIAVBEGopAwA3AwAgAUEIaiAFQQhqKQMANwMAIARBAWshBCACQSBqIQIMAAsACyADQSBqJAAL7AIBA38CQCACIANHBEAgAyACayIFIABqIgYgBSAFIAZLGyEHIAAgA2shBSAEIAAgAmsiBk0EQCAEIAVLDQIgASADaiABIAJqIAQQlAkaDwsCQCAEIAdNBEAgBCAFSw0BIAEgA2ogASACaiAGEJQJGiABIAMgBmpqIAEgBCAGaxCUCRoPCyAEIAVNBEAgASADIAZqaiABIAQgBmsQlAkaIAEgA2ogASACaiAGEJQJGg8LIAEgBiAFayIHaiABIAQgBmsQlAkaIAEgASAAIAdraiAHEJQJIgAgA2ogACACaiAFEJQJGg8LIAEgA2ogASACaiAGEJQJGiABIAMgBmpqIAEgBSAGayIAEJQJGiABIAAgAWogBCAFaxCUCRoLDwsgBCAHTQRAIAEgA2ogASACaiAFEJQJGiABIAEgAiAFamogBCAFaxCUCRoPCyABIAEgAiAFamogBCAFaxCUCSIAIANqIAAgAmogBRCUCRoLzwMBAX8jAEFAaiICJAACQAJAAkACQAJAAkAgAC0AAEEBaw4DAQIDAAsgAiAAKAIENgIEQRQQUCIARQ0EIABBEGpBzMrAACgAADYAACAAQQhqQcTKwAApAAA3AAAgAEG8ysAAKQAANwAAIAJBFDYCECACIAA2AgwgAkEUNgIIIAJBNGpBAzYCACACQTxqQQI2AgAgAkEkakEZNgIAIAJBzMfAADYCMCACQQA2AiggAkEaNgIcIAFBBGooAgAhACACIAJBGGo2AjggAiACQQRqNgIgIAIgAkEIajYCGCABKAIAIAAgAkEoahDmBCEAIAIoAghFDQMgAigCDBB+DAMLIAAtAAEhACACQTRqQQE2AgAgAkE8akEBNgIAIAJB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AEHQAGsiAyQAIAEoAgAhASADEEUiBDYCHCADQRBqIARBywAQuwUgAyADKAIQIAMoAhQQ/QUiBDYCICADQSA2AiQgAyABuBBGIgU2AiggAyACuBBGIgI2AjggBEEgIAUgAhBHIQIgA0E4aiIEENUHIANBKGoiBRDVByADQSRqENUHIAVBkPPBAEECQYTzwQBBARDUBSADQUBrIANBMGopAwA3AwAgAyADKQMoNwM4IAMgAjYCSCADIAEgBBDFBCADKQMAIQYgAygCCCEBIANBIGoQ1QcgA0EcahDVByAAIAE2AgggACAGNwMAIANB0ABqJAAL+QECA38BfiMAQdAAayIDJAAgASgCACEBIAMQRSIENgIcIANBEGogBEHMABC7BSADIAMoAhAgAygCFBD9BSIENgIgIANBIDYCJCADIAG4EEYiBTYCKCADIAK4EEYiAjYCOCAEQSAgBSACEEchAiADQThqIgQQ1QcgA0EoaiIFENUHIANBJGoQ1QcgBUHQ7cEAQQVBhPPBAEEBENQFIANBQGsgA0EwaikDADcDACADIAMpAyg3AzggAyACNgJIIAMgASAEEMUEIAMpAwAhBiADKAIIIQEgA0EgahDVByADQRxqENUHIAAgATYCCCAAIAY3AwAgA0HQAGokAAv5AQIDfwF+IwBB0ABrIgMkACABKAIAIQEgAxBFIgQ2AhwgA0EQaiAEQc0AELsFIAMgAygCECADKAIUEP0FIgQ2AiAgA0EgNgIkIAMgAbgQRiIFNgIoIAMgArgQRiICNgI4IARBICAFIAIQRyECIANBOGoiBBDVByADQShqIgUQ1QcgA0EkahDVByAFQaPzwQBBBEGE88EAQQEQ1AUgA0FAayADQTBqKQMANwMAIAMgAykDKDcDOCADIAI2AkggAyABIAQQxQQgAykDACEGIAMoAgghASADQSBqENUHIANBHGoQ1QcgACABNgIIIAAgBjcDACADQdAAaiQAC/kBAgN/AX4jAEHQAGsiAyQAIAEoAgAhASADEEUiBDYCHCADQRBqIARBzgAQuwUgAyADKAIQIAMoAhQQ/QUiBDYCICADQSA2AiQgAyABuBBGIgU2AiggAyACuBBGIgI2AjggBEEgIAUgAhBHIQIgA0E4aiIEENUHIANBKGoiBRDVByADQSRqENUHIAVB4O3BAEEHQYTzwQBBARDUBSADQUBrIANBMGopAwA3AwAgAyADKQMoNwM4IAMgAjYCSCADIAEgBBDFBCADKQMAIQYgAygCCCEBIANBIGoQ1QcgA0EcahDVByAAIAE2AgggACAGNwMAIANB0ABqJAAL+QECA38BfiMAQdAAayIDJAAgASgCACEBIAMQRSIENgIcIANBEGogBEHPABC7BSADIAMoAhAgAygCFBD9BSIENgIgIANBIDYCJCADIAG4EEYiBTYCKCADIAK4EEYiAjYCOCAEQSAgBSACEEchAiADQThqIgQQ1QcgA0EoaiIFENUHIANBJGoQ1QcgBUHQ7cEAQQVBhPPBAEEBENQFIANBQGsgA0EwaikDADcDACADIAMpAyg3AzggAyACNgJIIAMgASAEEMUEIAMpAwAhBiADKAIIIQEgA0EgahDVByADQRxqENUHIAAgATYCCCAAIAY3AwAgA0HQAGokAAv5AQIDfwF+IwBB0ABrIgMkACABKAIAIQEgAxBFIgQ2AhwgA0EQaiAEQdAAELsFIAMgAygCECADKAIUEP0FIgQ2AiAgA0EgNgIkIAMgAbgQRiIFNgIoIAMgArgQRiICNgI4IARBICAFIAIQRyECIANBOGoiBBDVByADQShqIgUQ1QcgA0EkahDVByAFQZDzwQBBAkGE88EAQQEQ1AUgA0FAayADQTBqKQMANwMAIAMgAykDKDcDOCADIAI2AkggAyABIAQQxQQgAykDACEGIAMoAgghASADQSBqENUHIANBHGoQ1QcgACABNgIIIAAgBjcDACADQdAAaiQAC/kBAgN/AX4jAEHQAGsiAyQAIAEoAgAhASADEEUiBDYCHCADQRBqIARB0QAQuwUgAyADKAIQIAMoAhQQ/QUiBDYCICADQSA2AiQgAyABuBBGIgU2AiggAyACuBBGIgI2AjggBEEgIAUgAhBHIQIgA0E4aiIEENUHIANBKGoiBRDVByADQSRqENUHIAVB7u3BAEEJQYTzwQBBARDUBSADQUBrIANBMGopAwA3AwAgAyADKQMoNwM4IAMgAjYCSCADIAEgBBDFBCADKQMAIQYgAygCCCEBIANBIGoQ1QcgA0EcahDVByAAIAE2AgggACAGNwMAIANB0ABqJAAL+QECA38BfiMAQdAAayIDJAAgASgCACEBIAMQRSIENgIcIANBEGogBEHTABC7BSADIAMoAhAgAygCFBD9BSIENgIgIANBIDYCJCADIAG4EEYiBTYCKCADIAK4EEYiAjYCOCAEQSAgBSACEEchAiADQThqIgQQ1QcgA0EoaiIFENUHIANBJGoQ1QcgBUGQ88EAQQJBhPPBAEEBENQFIANBQGsgA0EwaikDADcDACADIAMpAyg3AzggAyACNgJIIAMgASAEEMUEIAMpAwAhBiADKAIIIQEgA0EgahDVByADQRxqENUHIAAgATYCCCAAIAY3AwAgA0HQAGokAAv5AQIDfwF+IwBB0ABrIgMkACABKAIAIQEgAxBFIgQ2AhwgA0EQaiAEQdQAELsFIAMgAygCECADKAIUEP0FIgQ2AiAgA0EgNgIkIAMgAbgQRiIFNgIoIAMgArgQRiICNgI4IARBICAFIAIQRyECIANBOGoiBBDVByADQShqIgUQ1QcgA0EkahDVByAFQZvzwQBBBEGE88EAQQEQ1AUgA0FAayADQTBqKQMANwMAIAMgAykDKDcDOCADIAI2AkggAyABIAQQxQQgAykDACEGIAMoAgghASADQSBqENUHIANBHGoQ1QcgACABNgIIIAAgBjcDACADQdAAaiQAC/kBAgN/AX4jAEHQAGsiAyQAIAEoAgAhASADEEUiBDYCHCADQRBqIARB1QAQuwUgAyADKAIQIAMoAhQQ/QUiBDYCICADQSA2AiQgAyABuBBGIgU2AiggAyACuBBGIgI2AjggBEEgIAUgAhBHIQIgA0E4aiIEENUHIANBKGoiBRDVByADQSRqENUHIAVBhPPBAEEBQaiVwgBBABDUBSADQUBrIANBMGopAwA3AwAgAyADKQMoNwM4IAMgAjYCSCADIAEgBBDFBCADKQMAIQYgAygCCCEBIANBIGoQ1QcgA0EcahDVByAAIAE2AgggACAGNwMAIANB0ABqJAAL+QECA38BfiMAQdAAayIDJAAgASgCACEBIAMQRSIENgIcIANBEGogBEHWABC7BSADIAMoAhAgAygCFBD9BSIENgIgIANBIDYCJCADIAG4EEYiBTYCKCADIAK4EEYiAjYCOCAEQSAgBSACEEchAiADQThqIgQQ1QcgA0EoaiIFENUHIANBJGoQ1QcgBUGS88EAQQNBhPPBAEEBENQFIANBQGsgA0EwaikDADcDACADIAMpAyg3AzggAyACNgJIIAMgASAEEMUEIAMpAwAhBiADKAIIIQEgA0EgahDVByADQRxqENUHIAAgATYCCCAAIAY3AwAgA0HQAGokAAv5AQIDfwF+IwBB0ABrIgMkACABKAIAIQEgAxBFIgQ2AhwgA0EQaiAEQdcAELsFIAMgAygCECADKAIUEP0FIgQ2AiAgA0EgNgIkIAMgAbgQRiIFNgIoIAMgArgQRiICNgI4IARBICAFIAIQRyECIANBOGoiBBDVByADQShqIgUQ1QcgA0EkahDVByAFQdrtwQBBBkGE88EAQQEQ1AUgA0FAayADQTBqKQMANwMAIAMgAykDKDcDOCADIAI2AkggAyABIAQQxQQgAykDACEGIAMoAgghASADQSBqENUHIANBHGoQ1QcgACABNgIIIAAgBjcDACADQdAAaiQAC/kBAgN/AX4jAEHQAGsiAyQAIAEoAgAhASADEEUiBDYCHCADQRBqIARB2AAQuwUgAyADKAIQIAMoAhQQ/QUiBDYCICADQSA2AiQgAyABuBBGIgU2AiggAyACuBBGIgI2AjggBEEgIAUgAhBHIQIgA0E4aiIEENUHIANBKGoiBRDVByADQSRqENUHIAVBpOjBAEECQYTzwQBBARDUBSADQUBrIANBMGopAwA3AwAgAyADKQMoNwM4IAMgAjYCSCADIAEgBBDFBCADKQMAIQYgAygCCCEBIANBIGoQ1QcgA0EcahDVByAAIAE2AgggACAGNwMAIANB0ABqJAAL+QECA38BfiMAQdAAayIDJAAgASgCACEBIAMQRSIENgIcIANBEGogBEHdABC7BSADIAMoAhAgAygCFBD9BSIENgIgIANBIDYCJCADIAG4EEYiBTYCKCADIAK4EEYiAjYCOCAEQSAgBSACEEchAiADQThqIgQQ1QcgA0EoaiIFENUHIANBJGoQ1QcgBUGolcIAQQBBhPPBAEEBENQFIANBQGsgA0EwaikDADcDACADIAMpAyg3AzggAyACNgJIIAMgASAEEMUEIAMpAwAhBiADKAIIIQEgA0EgahDVByADQRxqENUHIAAgATYCCCAAIAY3AwAgA0HQAGokAAv5AQIDfwF+IwBB0ABrIgMkACABKAIAIQEgAxBFIgQ2AhwgA0EQaiAEQd4AELsFIAMgAygCECADKAIUEP0FIgQ2AiAgA0EgNgIkIAMgAbgQRiIFNgIoIAMgArgQRiICNgI4IARBICAFIAIQRyECIANBOGoiBBDVByADQShqIgUQ1QcgA0EkahDVByAFQZvzwQBBBEGE88EAQQEQ1AUgA0FAayADQTBqKQMANwMAIAMgAykDKDcDOCADIAI2AkggAyABIAQQxQQgAykDACEGIAMoAgghASADQSBqENUHIANBHGoQ1QcgACABNgIIIAAgBjcDACADQdAAaiQAC/kBAgN/AX4jAEHQAGsiAyQAIAEoAgAhASADEEUiBDYCHCADQRBqIARB3wAQuwUgAyADKAIQIAMoAhQQ/QUiBDYCICADQSA2AiQgAyABuBBGIgU2AiggAyACuBBGIgI2AjggBEEgIAUgAhBHIQIgA0E4aiIEENUHIANBKGoiBRDVByADQSRqENUHIAVB0O3BAEEFQYTzwQBBARDUBSADQUBrIANBMGopAwA3AwAgAyADKQMoNwM4IAMgAjYCSCADIAEgBBDFBCADKQMAIQYgAygCCCEBIANBIGoQ1QcgA0EcahDVByAAIAE2AgggACAGNwMAIANB0ABqJAAL+QECA38BfiMAQdAAayIDJAAgASgCACEBIAMQRSIENgIcIANBEGogBEHiABC7BSADIAMoAhAgAygCFBD9BSIENgIgIANBIDYCJCADIAG4EEYiBTYCKCADIAK4EEYiAjYCOCAEQSAgBSACEEchAiADQThqIgQQ1QcgA0EoaiIFENUHIANBJGoQ1QcgBUGQ88EAQQJBhPPBAEEBENQFIANBQGsgA0EwaikDADcDACADIAMpAyg3AzggAyACNgJIIAMgASAEEMUEIAMpAwAhBiADKAIIIQEgA0EgahDVByADQRxqENUHIAAgATYCCCAAIAY3AwAgA0HQAGokAAv5AQIDfwF+IwBB0ABrIgMkACABKAIAIQEgAxBFIgQ2AhwgA0EQaiAEQeQAELsFIAMgAygCECADKAIUEP0FIgQ2AiAgA0EgNgIkIAMgAbgQRiIFNgIoIAMgArgQRiICNgI4IARBICAFIAIQRyECIANBOGoiBBDVByADQShqIgUQ1QcgA0EkahDVByAFQZjzwQBBA0GE88EAQQEQ1AUgA0FAayADQTBqKQMANwMAIAMgAykDKDcDOCADIAI2AkggAyABIAQQxQQgAykDACEGIAMoAgghASADQSBqENUHIANBHGoQ1QcgACABNgIIIAAgBjcDACADQdAAaiQAC/kBAgN/AX4jAEHQAGsiAyQAIAEoAgAhASADEEUiBDYCHCADQRBqIARB5gAQuwUgAyADKAIQIAMoAhQQ/QUiBDYCICADQSA2AiQgAyABuBBGIgU2AiggAyACuBBGIgI2AjggBEEgIAUgAhBHIQIgA0E4aiIEENUHIANBKGoiBRDVByADQSRqENUHIAVB2u3BAEEGQYTzwQBBARDUBSADQUBrIANBMGopAwA3AwAgAyADKQMoNwM4IAMgAjYCSCADIAEgBBDFBCADKQMAIQYgAygCCCEBIANBIGoQ1QcgA0EcahDVByAAIAE2AgggACAGNwMAIANB0ABqJAAL+QECA38BfiMAQdAAayIDJAAgASgCACEBIAMQRSIENgIcIANBEGogBEHoABC7BSADIAMoAhAgAygCFBD9BSIENgIgIANBIDYCJCADIAG4EEYiBTYCKCADIAK4EEYiAjYCOCAEQSAgBSACEEchAiADQThqIgQQ1QcgA0EoaiIFENUHIANBJGoQ1QcgBUGS88EAQQNBhPPBAEEBENQFIANBQGsgA0EwaikDADcDACADIAMpAyg3AzggAyACNgJIIAMgASAEEMUEIAMpAwAhBiADKAIIIQEgA0EgahDVByADQRxqENUHIAAgATYCCCAAIAY3AwAgA0HQAGokAAv5AQIDfwF+IwBB0ABrIgMkACABKAIAIQEgAxBFIgQ2AhwgA0EQaiAEQekAELsFIAMgAygCECADKAIUEP0FIgQ2AiAgA0EgNgIkIAMgAbgQRiIFNgIoIAMgArgQRiICNgI4IARBICAFIAIQRyECIANBOGoiBBDVByADQShqIgUQ1QcgA0EkahDVByAFQZDzwQBBAkGE88EAQQEQ1AUgA0FAayADQTBqKQMANwMAIAMgAykDKDcDOCADIAI2AkggAyABIAQQxQQgAykDACEGIAMoAgghASADQSBqENUHIANBHGoQ1QcgACABNgIIIAAgBjcDACADQdAAaiQAC/kBAgN/AX4jAEHQAGsiAyQAIAEoAgAhASADEEUiBDYCHCADQRBqIARB6gAQuwUgAyADKAIQIAMoAhQQ/QUiBDYCICADQSA2AiQgAyABuBBGIgU2AiggAyACuBBGIgI2AjggBEEgIAUgAhBHIQIgA0E4aiIEENUHIANBKGoiBRDVByADQSRqENUHIAVB5+3BAEEHQYTzwQBBARDUBSADQUBrIANBMGopAwA3AwAgAyADKQMoNwM4IAMgAjYCSCADIAEgBBDFBCADKQMAIQYgAygCCCEBIANBIGoQ1QcgA0EcahDVByAAIAE2AgggACAGNwMAIANB0ABqJAAL+QECA38BfiMAQdAAayIDJAAgASgCACEBIAMQRSIENgIcIANBEGogBEHrABC7BSADIAMoAhAgAygCFBD9BSIENgIgIANBIDYCJCADIAG4EEYiBTYCKCADIAK4EEYiAjYCOCAEQSAgBSACEEchAiADQThqIgQQ1QcgA0EoaiIFENUHIANBJGoQ1QcgBUGj88EAQQRBhPPBAEEBENQFIANBQGsgA0EwaikDADcDACADIAMpAyg3AzggAyACNgJIIAMgASAEEMUEIAMpAwAhBiADKAIIIQEgA0EgahDVByADQRxqENUHIAAgATYCCCAAIAY3AwAgA0HQAGokAAv5AQIDfwF+IwBB0ABrIgMkACABKAIAIQEgAxBFIgQ2AhwgA0EQaiAEQe4AELsFIAMgAygCECADKAIUEP0FIgQ2AiAgA0EgNgIkIAMgAbgQRiIFNgIoIAMgArgQRiICNgI4IARBICAFIAIQRyECIANBOGoiBBDVByADQShqIgUQ1QcgA0EkahDVByAFQZDzwQBBAkGE88EAQQEQ1AUgA0FAayADQTBqKQMANwMAIAMgAykDKDcDOCADIAI2AkggAyABIAQQxQQgAykDACEGIAMoAgghASADQSBqENUHIANBHGoQ1QcgACABNgIIIAAgBjcDACADQdAAaiQAC/kBAgN/AX4jAEHQAGsiAyQAIAEoAgAhASADEEUiBDYCHCADQRBqIARB8AAQuwUgAyADKAIQIAMoAhQQ/QUiBDYCICADQSA2AiQgAyABuBBGIgU2AiggAyACuBBGIgI2AjggBEEgIAUgAhBHIQIgA0E4aiIEENUHIANBKGoiBRDVByADQSRqENUHIAVB2u3BAEEGQYTzwQBBARDUBSADQUBrIANBMGopAwA3AwAgAyADKQMoNwM4IAMgAjYCSCADIAEgBBDFBCADKQMAIQYgAygCCCEBIANBIGoQ1QcgA0EcahDVByAAIAE2AgggACAGNwMAIANB0ABqJAAL+QECA38BfiMAQdAAayIDJAAgASgCACEBIAMQRSIENgIc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KDcDOCADIAI2AkggAyABIAQQxQQgAykDACEGIAMoAgghASADQSBqENUHIANBHGoQ1QcgACABNgIIIAAgBjcDACADQdAAaiQAC+sBAgN/AX4jAEHQAGsiAyQAIAEoAgAhASADEEUiBDYCHCADQRBqIARB3AAQuwUgAyADKAIQIAMoAhQQ/QUiBDYCICADQSA2AiQgAyABuBBGIgU2AiggAyACuBBGIgI2AjggBEEgIAUgAhBHIQIgA0E4aiIEENUHIANBKGoiBRDVByADQSRqENUHIAUQwgggA0FAayADQTBqKQMANwMAIAMgAykDKDcDOCADIAI2AkggAyABIAQQxQQgAykDACEGIAMoAgghASADQSBqENUHIANBHGoQ1QcgACABNgIIIAAgBjcDACADQdAAaiQAC+sBAgN/AX4jAEHQAGsiAyQAIAEoAgAhASADEEUiBDYCHCADQRBqIARB4AAQuwUgAyADKAIQIAMoAhQQ/QUiBDYCICADQSA2AiQgAyABuBBGIgU2AiggAyACuBBGIgI2AjggBEEgIAUgAhBHIQIgA0E4aiIEENUHIANBKGoiBRDVByADQSRqENUHIAUQwwggA0FAayADQTBqKQMANwMAIAMgAykDKDcDOCADIAI2AkggAyABIAQQxQQgAykDACEGIAMoAgghASADQSBqENUHIANBHGoQ1QcgACABNgIIIAAgBjcDACADQdAAaiQAC+sBAgN/AX4jAEHQAGsiAyQAIAEoAgAhASADEEUiBDYCHCADQRBqIARB4QAQuwUgAyADKAIQIAMoAhQQ/QUiBDYCICADQSA2AiQgAyABuBBGIgU2AiggAyACuBBGIgI2AjggBEEgIAUgAhBHIQIgA0E4aiIEENUHIANBKGoiBRDVByADQSRqENUHIAUQwgggA0FAayADQTBqKQMANwMAIAMgAykDKDcDOCADIAI2AkggAyABIAQQxQQgAykDACEGIAMoAgghASADQSBqENUHIANBHGoQ1QcgACABNgIIIAAgBjcDACADQdAAaiQAC+sBAgN/AX4jAEHQAGsiAyQAIAEoAgAhASADEEUiBDYCHCADQRBqIARB4wAQuwUgAyADKAIQIAMoAhQQ/QUiBDYCICADQSA2AiQgAyABuBBGIgU2AiggAyACuBBGIgI2AjggBEEgIAUgAhBHIQIgA0E4aiIEENUHIANBKGoiBRDVByADQSRqENUHIAUQxAggA0FAayADQTBqKQMANwMAIAMgAykDKDcDOCADIAI2AkggAyABIAQQxQQgAykDACEGIAMoAgghASADQSBqENUHIANBHGoQ1QcgACABNgIIIAAgBjcDACADQdAAaiQAC+sBAgN/AX4jAEHQAGsiAyQAIAEoAgAhASADEEUiBDYCHCADQRBqIARB5QAQuwUgAyADKAIQIAMoAhQQ/QUiBDYCICADQSA2AiQgAyABuBBGIgU2AiggAyACuBBGIgI2AjggBEEgIAUgAhBHIQIgA0E4aiIEENUHIANBKGoiBRDVByADQSRqENUHIAUQxAggA0FAayADQTBqKQMANwMAIAMgAykDKDcDOCADIAI2AkggAyABIAQQxQQgAykDACEGIAMoAgghASADQSBqENUHIANBHGoQ1QcgACABNgIIIAAgBjcDACADQdAAaiQAC+sBAgN/AX4jAEHQAGsiAyQAIAEoAgAhASADEEUiBDYCHCADQRBqIARB5wAQuwUgAyADKAIQIAMoAhQQ/QUiBDYCICADQSA2AiQgAyABuBBGIgU2AiggAyACuBBGIgI2AjggBEEgIAUgAhBHIQIgA0E4aiIEENUHIANBKGoiBRDVByADQSRqENUHIAUQwgggA0FAayADQTBqKQMANwMAIAMgAykDKDcDOCADIAI2AkggAyABIAQQxQQgAykDACEGIAMoAgghASADQSBqENUHIANBHGoQ1QcgACABNgIIIAAgBjcDACADQdAAaiQAC+sBAgN/AX4jAEHQAGsiAyQAIAEoAgAhASADEEUiBDYCHCADQRBqIARB7AAQuwUgAyADKAIQIAMoAhQQ/QUiBDYCICADQSA2AiQgAyABuBBGIgU2AiggAyACuBBGIgI2AjggBEEgIAUgAhBHIQIgA0E4aiIEENUHIANBKGoiBRDVByADQSRqENUHIAUQwwggA0FAayADQTBqKQMANwMAIAMgAykDKDcDOCADIAI2AkggAyABIAQQxQQgAykDACEGIAMoAgghASADQSBqENUHIANBHGoQ1QcgACABNgIIIAAgBjcDACADQdAAaiQAC+sBAgN/AX4jAEHQAGsiAyQAIAEoAgAhASADEEUiBDYCHCADQRBqIARB7wAQuwUgAyADKAIQIAMoAhQQ/QUiBDYCICADQSA2AiQgAyABuBBGIgU2AiggAyACuBBGIgI2AjggBEEgIAUgAhBHIQIgA0E4aiIEENUHIANBKGoiBRDVByADQSRqENUHIAUQxAggA0FAayADQTBqKQMANwMAIAMgAykDKDcDOCADIAI2AkggAyABIAQQxQQgAykDACEGIAMoAgghASADQSBqENUHIANBHGoQ1QcgACABNgIIIAAgBjcDACADQdAAaiQAC+sBAgN/AX4jAEHQAGsiAyQAIAEoAgAhASADEEUiBDYCHCADQRBqIARB8wAQuwUgAyADKAIQIAMoAhQQ/QUiBDYCICADQSA2AiQgAyABuBBGIgU2AiggAyACuBBGIgI2AjggBEEgIAUgAhBHIQIgA0E4aiIEENUHIANBKGoiBRDVByADQSRqENUHIAUQwgggA0FAayADQTBqKQMANwMAIAMgAykDKDcDOCADIAI2AkggAyABIAQQxQQgAykDACEGIAMoAgghASADQSBqENUHIANBHGoQ1QcgACABNgIIIAAgBjcDACADQdAAaiQAC+kBAQV/IwBBIGsiASQAIAFBCGogABD6BAJAIAEoAghFBEAgAUEQai0AACEFIAEoAgwiA0EMaigCAEEMbCEEIANBCGooAgBBCGohAgNAIARFDQIgAigCAEECIAIQzQRBBEYEQCACKAIAQRRqKAIAEIcJCyAEQQxrIQQgAkEMaiECDAALAAsgASABKAIMNgIYIAEgAUEQai0AADoAHEGw+8EAQSsgAUEYakGAu8EAQZC7wQAQ6QMACyADQQRqEJ0CQQAhAiAAIAMoAgwEfyACBSADQRhqKAIARQs6ABwgAyAFENwGIAFBIGokAAvmAQEFfyMAQRBrIgIkACABKAIAIQMCQAJAIAFBKGooAgBBAkYEQCADDQEgAEKAgICAEDcCACAAQQhqQQA2AgAMAgsgAUEQaiEEIANFBEAgACAEENgCDAILIAIgBBDYAiACKAIAIQMgAigCBCEEIABBCGogAkEIaigCACIFIAFBCGooAgAgASgCBGsiAWoiBjYCACAAIARBAUYgBSAGTXE2AgQgAEF/IAEgA2oiACAAIANJGzYCAAwBCyAAQQE2AgQgAEEIaiABQQhqKAIAIAEoAgRrIgE2AgAgACABNgIACyACQRBqJAAL3wEBBn8jAEEgayIBJABBgYCAgHghBAJAIAAoAhAiBSAAQRhqKAIAIgJrIAAoAgQgACgCCGogAmsiA08NACACIAIgA2oiA0sEQEEAIQQgAyECDAELIANBKGwhAiADQbTmzBlJQQN0IQYCQCAFBEAgAUEINgIYIAEgBUEobDYCFCABIABBFGooAgA2AhAMAQsgAUEANgIYCyABIAIgBiABQRBqEOACIAEoAgQhAiABKAIABEAgAUEIaigCACEEDAELIAAgAzYCECAAQRRqIAI2AgALIAIgBBCpByABQSBqJAAL2QEBBX8jAEEgayIGJAAgBkEQaiIEIAEoAgBBCGoQ5gggBkEIaiAEQYS0wQAQ4AQgBi0ADCEHIAYoAggiAUEEaiADEP8CAkAgAyABKAIEIgQgAUEQaigCACIIIAFBDGooAgBqIgUgBEEAIAQgBU0bayIFayIESwRAIAUgAUEIaigCACIFaiACIAQQkgkaIAUgAiAEaiADIARrEJIJGgwBCyABQQhqKAIAIAVqIAIgAxCSCRoLIAEgAyAIajYCECAAQQQ6AAAgACADNgIEIAEgBxD5ByAGQSBqJAAL+AEBAn8jAEHQAGsiAyQAIANBADYCCCADQoCAgIAQNwMAIANBEGogASADIAIoAjwRAwACQCADLQAQQQRGBEAgACADKQMANwIAIABBCGogA0EIaigCADYCAAwBCyADIAMpAxA3AxggA0E8akECNgIAIANBxABqQQE2AgAgA0G0w8EANgI4IANBADYCMCADQTM2AkwgAyADQcgAajYCQCADIANBGGoiBDYCSCADQSBqIANBMGoQzAMgAygCJCIBIAMoAigQOCECIAMoAiAgARCGCCAEEOwFIABBADYCBCAAIAI2AgAgAygCACADKAIEEIYICyADQdAAaiQAC+MBAQV/IwBBEGsiAiQAIAEoAgAhAwJAAkAgASgCEEECRgRAIAMNASAAQoCAgIAQNwIAIABBCGpBADYCAAwCCyABQRBqIQQgA0UEQCAAIAQQ0wIMAgsgAiAEENMCIAIoAgAhAyACKAIEIQQgAEEIaiACQQhqKAIAIgUgAUEIaigCACABKAIEayIBaiIGNgIAIAAgBEEBRiAFIAZNcTYCBCAAQX8gASADaiIAIAAgA0kbNgIADAELIABBATYCBCAAQQhqIAFBCGooAgAgASgCBGsiATYCACAAIAE2AgALIAJBEGokAAviAQEF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QQE6AAFBAQwCCyADBEAgAkEIaigCACIBIAEoAgBBAWs2AgALIABBgQg7AQAMAgsgACABQcwAaigCACABKAJAazYCBEEACzoAACAEIAQoAgBBAWs2AgALIAJBEGokAAvbAQIBfwF8IwBBMGsiAyQAIAMgARC1ByACEJUEKAIQEBYiATYCJCADQaC+wQBBChAHIgI2AiwgA0EYaiABIAIQvAUgAyADKAIYIAMoAhwQ8wUiAjYCKCADQQhqIAIQhwYgAysDECEEIAMpAwgQ4QcgA0EoahDVByADQSxqENUHIAEQFyEBIANBJGoQ1QcgACABNgIIIABCfwJ+IAREAAAAAAAAAABmIgAgBEQAAAAAAADwQ2NxBEAgBLEMAQtCAAtCACAAGyAERP///////+9DZBs3AwAgA0EwaiQAC9EBAQR/IwBBQGoiAyQAIAMgARD4BSADKAIEIQVBACEBIAMoAgAiBCgCACACIAQoAgQoAogBEREAQf8BcSIEQRlHBEAgAyAEOgAPIANBLGpBAjYCACADQTRqQQE2AgAgA0GQw8EANgIoIANBADYCICADQTI2AjwgAyADQThqNgIwIAMgA0EPajYCOCADQRBqIANBIGoQzAMgAygCFCIEIAMoAhgQOCEGIAMoAhAgBBCGCEEBIQELIAVBADYCACAAIAE2AgQgACAGNgIAIANBQGskAAvSAQIDfwF+IwBBMGsiAyQAIANBCGogASACEIUDIAMoAhAhAiADKQMIIQYgASgCbCIEQYACaigCACIBKAIIIQUgAUF/NgIIAkAgBUUEQCADQRhqIAFBCGoQhAUgAygCGA0BIAMoAhwhASAAQRhqIANBIGotAAA6AAAgACABNgIUIAAgBEEIajYCECAAIAI2AgggACAGNwMAIANBMGokAA8LAAsgAyADKAIcNgIoIAMgA0Egai0AADoALEGw+8EAQSsgA0EoakGwrMEAQcSuwQAQ6QMAC9cBAQN/IwBBEGsiAiQAIAJBCGogARD7BSACKAIMIQMgAiACKAIIIgEgASgCeBCxAygCbCIBQdgBaigCACABQdwBaigCACgCGBEAAAJAIAACfyACKAIAIgEgAigCBCgCDBEHAELG5ezG+63msqd/UiABRXJFBEAgASgCACIEIAQoAgAiAUEBajYCACABQQBIDQJBACEBIANBADYCACAEEOkH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AyACIAFBDGooAgAgAUEQaigCABDyBCAAQQxqIAIpAwA3AgAgACADNwIEQQAMAwsgACABLwABOwABQQEMAgsgACABKQIENwIEIABBDGogAUEMaikCADcCAEECDAELIAAgASkCBDcCBCAAQQxqIAFBDGopAgA3AgBBAws6AAAgAkEQaiQAC8oBAQV/IwBBIGsiAiQAAkAgACgCBCIDRQRAIAFBqJXCAEEAEFchAwwBCyAAKAIAIQAgAiADNgIMIAIgADYCCCACQRBqIAJBCGoQqAEgAigCECIABEAgASgCBCEEIAEoAgAhBQNAIAIoAhQhBiACKAIcRQRAIAEgACAGEFchAwwDC0EBIQMgBSAAIAYgBCgCDBEEAA0CIAVB/f8DIAQoAhARAgANAiACQRBqIAJBCGoQqAEgAigCECIADQALC0EAIQMLIAJBIGokACADC88BAQJ/IwBBEGsiBSQAIAEhBAJAAkACQAJAAkACQCACp0EBaw4CAAECCyABQQxqIQQLIAQ1AgAgA3wiA0IAWQ0BIAVBCGpBFEG888AAQRkQiwUgAEEBNgIAIAAgBSkDCDcCBAwDCyADQgBTDQELIANC/////w9WBEAgAEEBNgIAIABCgSg3AgQMAgsgAEEANgIAIAEgAUEMaigCACIBIAOnIgQgASAESRsiATYCACAAIAGtNwMIDAELIABBATYCACAAQoEoNwIECyAFQRBqJAALuwEBBX8jAEEgayICJABBgYCAgHghBAJAIAAoAgAiBSAAKAIIIgZrIAFPDQAgBiABIAZqIgNLBEBBACEEIAMhAQwBCyADQX9zQR92IQECQCAFBEAgAkEBNgIYIAIgBTYCFCACIAAoAgQ2AhAMAQsgAkEANgIYCyACIAMgASACQRBqEOACIAIoAgQhASACKAIABEAgAkEIaigCACEEDAELIAAgAzYCACAAIAE2AgQLIAEgBBCpByACQSBqJAALvAEBAX8jAEEgayIDJAAgAyACNgIMIANBEGoiAiABQTBqEOMGIAMgAkHIlsEAEMAFIAMoAgQhASAAAn8gAygCACADQQxqEJsDIgIEQCAAQTBqIAIoAig2AgAgAEEoaiACKQMgNwMAIABBIGogAikDGDcDACAAQRhqIAIpAxA3AwAgAEEQaiACKAIINgIAIAAgAikDADcDCEEADAELIABBCDoAAUEB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ADYCBCAAQQI2AgAMAQsgACADKQMINwIADAELIANBCGoQ9QcLIANBMGokAAujAQEBfyMAQTBrIgMkACADQQQ6AAggAyABNgIQIANBKGogAkEQaikCADcDACADQSBqIAJBCGopAgA3AwAgAyACKQIANwMYAkACQCADQQhqQbCiwQAgA0EYahCTAUUEQCAAQQQ6AAAMAQsgAy0ACEEERgRAIABBuO/BADYCBCAAQQI2AgAMAQsgACADKQMINwIADAELIANBCGoQ9QcLIANBMGokAAujAQEBfyMAQTBrIgMkACADQQQ6AAggAyABNgIQIANBKGogAkEQaikCADcDACADQSBqIAJBCGopAgA3AwAgAyACKQIANwMYAkACQCADQQhqQciiwQAgA0EYahCTAUUEQCAAQQQ6AAAMAQsgAy0ACEEERgRAIABBuO/BADYCBCAAQQI2AgAMAQsgACADKQMINwIADAELIANBCGoQ9QcLIANBMGokAAuoAQICfwF+IwBBIGsiAyQAIAIoAgghBCADQQhqIAEgAhC7ASAEIAIoAggiAU0EQCADQRBqIAIoAgQgBGogASAEaxB8IAMpAwghBQJAIAMoAhBFBEAgACAFNwIADAELAkAgBUL/AYNCBFEEQCAAQfDbwQA2AgQgAEECNgIADAELIAAgBTcCAAsgBCEBCyACIAE2AgggA0EgaiQADwsgBCABQbzbwQAQyQgAC6MBAQF/IwBBMGsiAyQAIANBBDoACCADIAE2AhAgA0EoaiACQRBqKQIANwMAIANBIGogAkEIaikCADcDACADIAIpAgA3AxgCQAJAIANBCGpBkO/BACADQRhqEJMBRQRAIABBBDoAAAwBCyADLQAIQQRGBEAgAEG478EANgIEIABBAjYCAAwBCyAAIAMpAwg3AgAMAQsgA0EIahD1BwsgA0EwaiQAC6UBAQR/IwBB8ABrIggkACABIAEoAnwiCUEBajYCfCAIQQhqIgogAUEwahDICCAIIApB7JfBABDYBCAILQAEIQsgCCgCACEBIAggBDsBaCAIIAM3A1ggCCACNwNQIAggBTsBaiAIQgA3A2AgCCAHNgJIIAggBjcDQCAKIAFBCGogCSAIQUBrEOQGIAEgCxCHCCAAQQA6AAAgACAJNgIEIAhB8ABqJAALnQECAX8BfiMAQSBrIgIkACAAKQMAIQMgAUGk58EAEM8HIQEgAiAANgIYIAIgATYCECACIAM3AwggAiACQQhqEKMDEPQEAkBCAiACNQIAIgMgAjUCBEIghoQgA0ICURsiA6ciAUECRwRAQQgQUCIARQ0BIAAgATYCACAAIANCIIg+AgQgABCoCAALIAJBIGokACADQiCIp0H/AXEPCwALrgECA38BfiMAQRBrIgIkACABKQMIIgVCgICAgBBUBEAgAiAFpyIDQQAQkQQgAigCACEEIAJBCGogASgCECABKQMAIAIoAgQiASADEKMEAkAgAigCCARAIAAgAzYCCCAAIAE2AgQgACAENgIADAELIAItAAwhAyAAQQA2AgQgACADOgAAIAQgARCGCAsgAkEQaiQADwtBnrbBAEEZIAJBCGpBvI/AAEG4tsEAEOkDAAuWAQEDfyMAQYABayIDJAAgAC0AACECQQAhAANAIAAgA2pB/wBqQTBBNyACQQ9xIgRBCkkbIARqOgAAIABBAWshACACIgRBBHYhAiAEQQ9LDQALIABBgAFqIgJBgQFPBEAgAkGAAUGUoMAAEMkIAAsgAUEBQZCUwgBBAiAAIANqQYABakEAIABrEIsBIQAgA0GAAWokACAAC5sBAQJ/IwBBIGsiAiQAIAFBFGooAgAhAwJAAkAgAAJ/AkACQCABQQxqKAIADgIAAQMLIAMNAkEAIQNBqJXCAAwBCyADDQEgASgCCCIBKAIEIQMgASgCAAsgAxCmBQwBCyACQRhqIAFBEGopAgA3AwAgAkEQaiABQQhqKQIANwMAIAIgASkCADcDCCAAIAJBCGoQrQELIAJBIGokAAubAQECfyMAQSBrIgIkACABQRRqKAIAIQMCQAJAIAACfwJAAkAgAUEMaigCAA4CAAEDCyADDQJBACEDQaiVwgAMAQsgAw0BIAEoAggiASgCBCEDIAEoAgALIAMQmwQMAQsgAkEYaiABQRBqKQIANwMAIAJBEGogAUEIaikCADcDACACIAEpAgA3AwggACACQQhqEK0BCyACQSBqJAALsgEBAn8jAEEQayICJAACfwJAAkACQCAAKAIAIgAtABQiA0EDa0EAIANBA0sbQQFrDgIBAgALIAIgADYCCCACIABBFGo2AgwgAUG45cAAQRAgAkEIakGo5cAAIAJBDGpBqOXAABCCAwwCCyACIAA2AgwgAUGb5cAAQQ0g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KAIAIAJBFGxqIgAgASkCADcCACAAQQhqIAFBCGopAgA3AgAgAEEQaiABQRBqKAIANgIAIAMLdwECfyAAQRxqKAIAIgJBAWoQ6wchAyAAIAAoAhQgAkcEfyADBSAAQRRqIAIQgAMgACgCHCICQQFqCzYCHCAAQRhqKAIAIAJBFGxqIgAgASkCADcCACAAQQhqIAFBCGopAgA3AgAgAEEQaiABQRBqKAIANgIAIAMLdwECfyAAQRBqKAIAIgJBAWoQ6wchAyAAIAAoAgggAkcEfyADBSAAQQhqIAIQgAMgACgCECICQQFqCzYCECAAQQxqKAIAIAJBFGxqIgAgASkCADcCACAAQQhqIAFBCGopAgA3AgAgAEEQaiABQRBqKAIANgIAIAMLiQEBBH8jAEEQayICJAAgAiABQQRqELkFAkACQCACKAIARQRAIABBBjYCAAwBCyACKAIEIQQgASABKAIAIgNBAWo2AgAgAiAENgIMIAEoAhAiASgCBCIFIANNDQEgACABKAIAIANqIAQQwwEgAkEMahDVBwsgAkEQaiQADwsgAyAFQdzlwQAQ/wMAC4EBAQN/IwBBIGsiBCQAIARBGGogARD7BSAEKAIcIQUgBCgCGCEBIARBEGogAiADENIFIARBCGogASAEKAIQIgIgBCgCFCIDEJkDIAQoAgwhBiAEKAIIIQEgAwRAIAIQfgsgBUEANgIAIAAgATYCBCAAIAZBACABGzYCACAEQSBqJAALowEBAX8jAEHQAGsiAyQAIANBQGtCADcDACADQgA3AzggAyABNwMwIAMgAULzytHLp4zZsvQAhTcDICADIAFC7d6R85bM3LfkAIU3AxggAyAANwMoIAMgAELh5JXz1uzZvOwAhTcDECADIABC9crNg9es27fzAIU3AwggAyACNgJMIANBCGoiAiADQcwAakEEEJkCIAIQ5wEhACADQdAAaiQAIAALgAECA38BfiMAQRBrIgQkACAEQQhqIAEgAmsiA0EAEJEEIAQpAwghBiAAQQA2AgggACAGNwIAIAAgAxCkByAAKAIIIQMgACgCBCEFA0AgASACRwRAIAMgBWogAi0AADoAACADQQFqIQMgAkEBaiECDAELCyAAIAM2AgggBEEQaiQAC4YBAQF/IwBBgANrIgEkACAAEJsIIAEgABDoBiABKAIEQQA2AgAgAUHAAWogAEHAARCSCRogAUEIaiABQcgBakG4ARCSCRogABB+IAFBgAFqEMYBIAFBhAFqEPkGIAFBiAFqEPkGIAFBjAFqEPkGIAFBkAFqEOwHIAFBGGoQtAQgAUGAA2okAAt3AQF/IwBBMGsiAyQAIAMgATYCBCADIAA2AgAgA0EUakECNgIAIANBHGpBAjYCACADQSxqQQE2AgAgA0GcnsAANgIQIANBADYCCCADQQE2AiQgAyADQSBqNgIYIAMgAzYCKCADIANBBGo2AiAgA0EIaiACEIEGAAt3AQF/IwBBMGsiAyQAIAMgATYCBCADIAA2AgAgA0EUakEDNgIAIANBHGpBAjYCACADQSxqQQE2AgAgA0HwksAANgIQIANBADYCCCADQQE2AiQgAyADQSBqNgIYIAMgA0EEajYCKCADIAM2AiAgA0EIaiACEIEGAAt3AQF/IwBBMGsiAyQAIAMgATYCBCADIAA2AgAgA0EUakEDNgIAIANBHGpBAjYCACADQSxqQQE2AgAgA0HQpMAANgIQIANBADYCCCADQQE2AiQgAyADQSBqNgIYIAMgAzYCKCADIANBBGo2AiAgA0EIaiACEIEGAAt9AgF/AX4jAEEQayIDJAAgA0EIaiAAKAIIIAEgAhD4BCADLQAIIgJBBEcEQCADKQMIIQQgAC0AAEEDRgRAIAAoAgQiASgCACABKAIEKAIAEQEAIAEoAgQoAgQEQCABKAIAEH4LIAEQfgsgACAENwIACyADQRBqJAAgAkEERwuKAQEEfyMAQRBrIgEkAAJ/QYSdwgAoAgAiAARAQYidwgBBACAAGwwBCxDXBSEDQYSdwgAoAgAhAEGEncIAQQE2AgBBiJ3CACgCACECQYidwgAgAzYCACABIAI2AgwgASAANgIIIABFIAJFckUEQCABQQhqQQRyEPgGC0GIncIACyEAIAFBEGokACAAC4IBAQR/IAEoAgAiAiABKAIIIgNLBEAgAkEYbCECIAEoAgQhBAJ/AkAgA0UEQCAEIAIQpAhBCCECDAELQQggBCACQQggA0EYbCIFEHYiAkUNARoLIAEgAzYCACABIAI2AgRBgYCAgHgLIQIgBSACEKkHCyAAIAM2AgQgACABKAIENgIAC38BA38jAEEgayIEJAAgBEEYaiABEPsFIAQoAhwhBSAEKAIYIQEgBEEQaiACIAMQ0gUgBEEIaiABIAQoAhAiAiAEKAIUIgMQmQMgBCgCDCEGIAQoAgghASADIAIQhgggBUEANgIAIAAgATYCBCAAIAZBACABGzYCACAEQSBqJAALdgEBf0EYIQQCQCABIAJNDQAgACACQdAAbGoiACgCAEEBRw0AIABBHGooAgAiBCAAKAIURgRAIABBFGogBBD8AiAAKAIcIQQLIABBGGooAgAgBEECdGogAzYCACAAQgA3AzAgACAAKAIcQQFqNgIcQRkhBAsgBAvGAQEFfyAAKAIEIQEgAEGolcIANgIEIAAoAgAhAiAAQaiVwgA2AgACQCABIAJGDQAgAiABa0EMbkEMbCECIAAoAhAoAgQiAyABIANrQQxuQQxsaiEBA0AgAkUNASABQQhqEPgGIAJBDGshAiABQQxqIQEMAAsACyAAKAIMIgEEQCAAKAIIIgQgACgCECICKAIIIgNHBEAgAigCBCIFIANBDGxqIAUgBEEMbGogAUEMbBCUCRogACgCDCEBCyACIAEgA2o2AggLC9YBAgF/An4jAEEgayIDJAAgACkDCCEEIAMgAq0iBTcDACAEIAVRBEAgACgCECAAKQMAIAEgAhCgAyEAIANBIGokACAADwsgA0EANgIcIANBqJXCADYCGCADQQE2AhQgA0G4kMAANgIQIANBADYCCCMAQSBrIgEkACABIABBCGo2AgQgASADNgIAIAFBGGogA0EIaiIAQRBqKQIANwMAIAFBEGogAEEIaikCADcDACABIAApAgA3AwggAUGg4MEAIAFBBGpBoODBACABQQhqQcCQwAAQ0gEAC3QBAX9BDBBQIgYEQCAGQQI2AgggBiADNgIAIAYgBCADayAFajYCBCABIAYgASgCACIBIAEgAkYiAhs2AgAgAgRAIABBhJTAADYCDCAAIAY2AgggACAFNgIEIAAgBDYCAA8LIAAgASAEIAUQ2gUgBhB+DwsAC3oBAn8jAEEgayICJAAgAkEIaiABECsCQCACKAIIIgMEQCACKAIMIQEgAiADNgIUIAIgATYCGCACIAE2AhAgAiACQRBqEPYEIAIoAgAhASAAIAIoAgQiAzYCCCAAIAE2AgQgACADNgIADAELIABBADYCBAsgAkEgaiQAC3cCAn8BfiMAQSBrIgMkACADQRhqIgQgAUEIaigCADYCACADIAEpAgA3AxAgA0EIaiADQRBqIgEQnQUgAykDCCEFIAQgAkEIaigCADYCACADIAIpAgA3AxAgAyABEJ0FIAAgAykDADcCCCAAIAU3AgAgA0EgaiQAC3QBAn8gAqchA0EIIQQDfyABIAAgA3EiA2opAABCgIGChIiQoMCAf4MiAlAEfyADIARqIQMgBEEIaiEEDAEFIAEgAnqnQQN2IANqIABxIgRqLAAAQQBOBH8gASkDAEKAgYKEiJCgwIB/g3qnQQN2BSAECwsLC2oBAX8jAEEwayICJAAgAkEoaiABQRhqKAIANgIAIAJBIGogAUEQaikCADcDACACQRhqIAFBCGopAgA3AwAgAiABKQIANwMQIAJBCGogAkEQahDxBCAAIAIoAgggAigCDBDnAiACQTBqJAALbQECfyMAQSBrIgIkAAJ/IAEoAgQEQCACQRhqIAFBCGooAgA2AgAgAiABKQIANwMQIAJBCGogAkEQahCdBSAAIAIpAwg3AgBBAAwBC0EBIQMgASgCAAshASAAIAM2AgwgACABNgIIIAJBIGokAAt3AgJ/AX4jAEEwayIDJAAgA0EQaiABIAIQhQMgAykDECEFIAMoAhghAiADQSBqIgQgASgCbCIBQYACaigCAEEIahDQBSADQQhqIAQQwgUgACADKQMINwIUIAAgAUEIajYCECAAIAI2AgggACAFNwMAIANBMGokAAuaAQEBfwJAAkACQAJAIABBAWsOAwECAwALIAEgAkEwaigCACACQTRqKAIAEOUGQRBqDwsgASACQRhqKAIAIAJBHGooAgAQ5QZBEGoPCyABIAJBDGooAgAgAkEQaigCABDlBkEQag8LIAJBJGooAgAhAyABQQFrIgAgAkEoaigCACIBTwRAIAAgAUHc2MEAEP8DAAsgAEEDdCADagtuAQF/IwBBEGsiAyQAAkAgAUUEQEEBIQIMAQsgAUEATgRAAn8gAkUEQCADQQhqIAFBARDtBSADKAIIDAELIAMgAUEBQQEQ2QYgAygCAAsiAg0BAAsQxgUACyAAIAI2AgQgACABNgIAIANBEGokAAtyAQV/IAAoAgghAiAAKAIEIQEgACgCACEDA0ACQCABIANGBEBBACEBDAELIAAgAUEEaiIENgIEIAEoAgAiBSACKAIAIgFBEGooAgBJBEAgAUEMaigCACAFQdAAbGoiASgCAEECRw0B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AABBASEBDAELIAFBfzYCABCzByEDIAIgATYCBCACQQhqIgQgA0EBczoAACACIAEtAARBAEc2AgAgAigCACEBIAIoAgQhAyAAQQhqIAQtAAA6AAAgACADNgIECyAAIAE2AgAgAkEQaiQAC24BAn8jAEEQayICJAAgARC5ByACIAFBBGoQvAcgAi0AAUEBcSEDIAItAABBAXEEQCACIAM6AAwgAiABNgIIQbD7wQBBKyACQQhqQeiNwQBB6I7BABDpAwALIAAgAzoABCAAIAE2AgAgAkEQaiQAC3EBAX8gAEHwAGooAgAgAEH0AGooAgAQ0wcgAEEQahC5AyAAQcgAaigCACAAQdQAaigCABDdByAAQSRqKAIAIABBKGooAgAQhgggACgCYCAAQeQAaiIBKAIAKAIAEQEAIAEoAgAoAgQEQCAAKAJgEH4LC2EBAX8gAiABKAIIIgRJBEAgACABKAIEIAJBDGxqIgMpAgA3AgAgAEEIaiADQQhqKAIANgIAIAMgA0EMaiAEIAJBf3NqQQxsEJQJGiABIARBAWs2AggPCyACIAQgAxCABAALZAEBfyMAQSBrIgMkACADIAE2AgQgAyAANgIAIANBGGogAkEQaikCADcDACADQRBqIAJBCGopAgA3AwAgAyACKQIANwMIIANBxL/AACADQQRqQcS/wAAgA0EIakG0v8AAENIBAAthAQF/IwBBIGsiBCQAIAQgATYCBCAEIAA2AgAgBEEYaiACQRBqKQIANwMAIARBEGogAkEIaikCADcDACAEIAIpAgA3AwggBEGUwMAAIARBBGpBlMDAACAEQQhqIAMQ0gEAC2cBAX8jAEEgayICJAAgAkGE88EANgIEIAIgADYCACACQRhqIAFBEGopAgA3AwAgAkEQaiABQQhqKQIANwMAIAIgASkCADcDCCACQcjBwAAgAkEEakHIwcAAIAJBCGpBqM3AABDSAQALZwEBfyMAQSBrIgIkACACQYTzwQA2AgQgAiAANgIAIAJBGGogAUEQaikCADcDACACQRBqIAFBCGopAgA3AwAgAiABKQIANwMIIAJBtNTAACACQQRqQbTUwAAgAkEIakHk3sEAENIBAAt3AQF/IwBBEGsiAiQAIAIgACgCACIAQQhqNgIEIAIgADYCCCACIABBDGo2AgwgAUGU6MAAQQpB5efAAEEHIAJBBGpBoOjAAEH858AAQQcgAkEIakGw6MAAQfDlwABBBiACQQxqQcDowAAQiQMhACACQRBqJAAgAAt3AQF/IwBBEGsiAiQAIAIgACgCACIAQQxqNgIEIAIgAEEIajYCCCACIAA2AgwgAUHc58AAQQlB3LTBAEECIAJBBGpBsOfAAEHl58AAQQcgAkEIakHs58AAQfznwABBByACQQxqQYTowAAQiQMhACACQRBqJAAgAAthAQF/IwBBIGsiBCQAIAQgATYCBCAEIAA2AgAgBEEYaiACQRBqKQIANwMAIARBEGogAkEIaikCADcDACAEIAIpAgA3AwggBEGMhsEAIARBBGpBjIbBACAEQQhqIAMQ0gEAC2EBAX8jAEEgayIEJAAgBCABNgIEIAQgADYCACAEQRhqIAJBEGopAgA3AwAgBEEQaiACQQhqKQIANwMAIAQgAikCADcDCCAEQYC+wQAgBEEEakGAvsEAIARBCGogAxDSAQALXgECfyAAIAEoAggiAkEHakF4cWogASgCABEBAAJAIABBf0YNACAAIAAoAgQiA0EBazYCBCADQQFHDQBBBCACIAJBBE0bIgIgASgCBGpBB2pBACACa3FFDQAgABB+CwtfAQF/IAApAwBCAFIEQCAAQUBrEPoFIABBIGooAgAiAQRAIABBLGooAgAgAUECdEELakF4cWsQfgsgAEE0aiIBKAIAIABBOGooAgAQmQkgAEEwaigCACABKAIAENwHCwteAQF/IwBBIGsiAiQAIAIgACgCADYCBCACQRhqIAFBEGopAgA3AwAgAkEQaiABQQhqKQIANwMAIAIgASkCADcDCCACQQRqQeCQwAAgAkEIahCTASEAIAJBIGokACAAC1wBAn8jAEEgayICJAAgASgCBCEDIAEoAgAhASACQRhqIABBEGopAgA3AwAgAkEQaiAAQQhqKQIANwMAIAIgACkCADcDCCABIAMgAkEIahCTASEAIAJBIGokACAAC14BAX8jAEEgayICJAAgAiAAKAIANgIEIAJBGGogAUEQaikCADcDACACQRBqIAFBCGopAgA3AwAgAiABKQIANwMIIAJBBGpB7KHAACACQQhqEJMBIQAgAkEgaiQAIAALOwECfyMAQRBrIgEkACABQQhqQeABQQgQowcgASgCCCICBEAgACACNgIEIABBBDYCACABQRBqJAAPCwALVwEBfwJAAkACQEECIAAoAhAiAUECayABQQJJGw4DAAIBAgsgAEEEaigCACAAQQhqKAIAEIYIDwsgABCZByAAQRBqEJkHDwsgACgCACAAQQRqKAIAEIYIC2MBAX8jAEEQayIFJAAgBSABIAMgBCACKAIoEQUAAkAgBSgCCARAIAAgBSkDADcCACAAQQhqIAVBCGopAwA3AgAMAQsgBS0AACEBIABBADYCCCAAIAEQ7gc6AAALIAVBEGokAAtoAQJ/IwBBEGsiAiQAIAJBCGogARCDBwJAIAIoAggiAUUEQCAAQQA2AgQMAQsgAigCDCEDIAAgAUEEaigCACABQQhqKAIAEJQFIABBGGogAygCCDYCACAAIAMpAwA3AxALIAJBEGokAAtbAQF/IwBBIGsiAiQAIAIgADYCBCACQRhqIAFBEGopAgA3AwAgAkEQaiABQQhqKQIANwMAIAIgASkCADcDCCACQQRqQeyhwAAgAkEIahCTASEAIAJBIGokACAAC2EBAX8jAEEgayICJAAgAkEYakIANwMAIAJCADcDECACIAEgAkEQahD8AQJAIAIoAgBFBEAgAEEEOgAADAELIAIoAgQhASAAIAJBCGooAgA2AgQgACABNgIACyACQSBqJAALWwEBfyMAQSBrIgIkACACIAA2AgQgAkEYaiABQRBqKQIANwMAIAJBEGogAUEIaikCADcDACACIAEpAgA3AwggAkEEakGYgMEAIAJBCGoQkwEhACACQSBqJAAgAAtbAQF/IwBBIGsiAiQAIAIgADYCBCACQRhqIAFBEGopAgA3AwAgAkEQaiABQQhqKQIANwMAIAIgASkCADcDCCACQQRqQfCiwQAgAkEIahCTASEAIAJBIGokACAAC1sBAX8jAEEgayICJAAgAiAANgIEIAJBGGogAUEQaikCADcDACACQRBqIAFBCGopAgA3AwAgAiABKQIANwMIIAJBBGpBiKPBACACQQhqEJMBIQAgAkEgaiQAIAALWwEBfyMAQSBrIgIkACACIAA2AgQgAkEYaiABQRBqKQIANwMAIAJBEGogAUEIaikCADcDACACIAEpAgA3AwggAkEEakGgo8EAIAJBCGoQkwEhACACQSBqJAAgAAtyAQF/IwBBEGsiAiQAIAIgADYCBCACIABBCGo2AgggAiAAQRBqNgIMIAFBsLnBAEEeQc65wQBBAyACQQRqQdS5wQBB5LnBAEEKIAJBCGpB8LnBAEGAusEAQQ4gAkEMakGQusEAEIkDIQAgAkEQaiQAIAALXQECfyAAKAIIQRRsIQIgACgCBCEBA0AgAgRAIAEtAABFBEAgAUEEahCECCABQQxqEIQICyABQRRqIQEgAkEUayECDAELCyAAKAIAIgEEQCAAKAIEIAFBFGwQpAgLC2EBAn8gACgCCCAAKAIEIgFrQRhuQRhsIQIDQCACBEAgASgCACABQQRqKAIAEIYIIAFBDGooAgAgAUEQaigCABCGCCACQRhrIQIgAUEYaiEBDAELCyAAKAIAIAAoAgwQzQcLXQIBfwF+IwBBIGsiAyQAIAEpAwAhBCADQRhqIAJBEGooAgA2AgAgA0EQaiACQQhqKQIANwMAIAMgAikCADcDCCAAIAEgA0EIahD3AzYCCCAAIAQ3AwAgA0EgaiQAC1sBAX8jAEEgayICJAAgAiAANgIEIAJBGGogAUEQaikCADcDACACQRBqIAFBCGopAgA3AwAgAiABKQIANwMIIAJBBGpB2N/BACACQQhqEJMBIQAgAkEgaiQAIAALhQEBAn8gACgCCCICIAAoAgBGBEAjAEEQayIDJAAgA0EIaiAAIAJBARD2AiADKAIIIAMoAgwQqQcgA0EQaiQAIAAoAgghAgsgACACQQFqNgIIIAAoAgQgAkEYbGoiACABKQMANwMAIABBCGogAUEIaikDADcDACAAQRBqIAFBEGopAwA3AwALYgEBfyAAKAIEKAIMIAFBAnRrQQRrKAIAIgEgACgCACIAQQxqKAIAIgJPBEAgASACQezbwAAQ/wMACyAAKAIAIAAoAgQgACgCCCABQShsaiIAQSBqKAIAIABBJGooAgAQmwcLZAEBfyAAKAIEKAIMIAFBAnRrQQRrKAIAIgEgACgCACIAKAIEIgJPBEAgASACQezbwAAQ/wMACyAAKAIIIgIoAgQgAigCCCAAKAIAIAFBKGxqIgBBIGooAgAgAEEkaigCABCbBwv4AwEKfyMAQSBrIgUkACAAKAIIQQJHBEAgBSAANgIAIAUgADYCBCAFIAVBGGo2AhAgBSAFQQRqNgIMIAUgBTYCCCAFQQhqIQcjAEEgayICJAAgAEEIaiIEKAIAIQECQAJAAkACQANAAkACQAJAIAFBA3EiCA4DAAEEAwsgBw0BCyACQQhqIAhyIQkCQANAAkAQ3QIhCiAEIAkgBCgCACIDIAEgA0YiBhs2AgAgAkEAOgAQIAIgCjYCCCACIAFBfHE2AgwgBg0AIAJBCGoQjAggAyIBQQNxIAhGDQEMAgsLA0AgAi0AEEUEQBC0AQwBCwsgAkEIahCMCAsgBCgCACEBDAELIAQgAUF8cUEBciAEKAIAIgMgASADRhs2AgAgASADRyEGIAMhASAGDQALIAdBrNzAACgCABEGACEDIAQoAgAhASAEQQJBACADGzYCACACIAFBA3EiAzYCBCADQQFHDQEgAUEBayEBA0AgAUUNASABKAIEIQMgASgCACEEIAFBADYCACAERQ0DIAFBAToACCACIAQ2AgggBEEQahD5ASACQQhqEO0GIAMhAQwACwALIAJBIGokAAwCCyACQQA2AhAgAkEEakGkwMAAIAJBCGpBiMHAABCsBAALQff4wQBBK0GYwcAAEJEFAAsLIAVBIGokACAAQQRqC1kBAn8jAEEQayICJAACQCABRQRAQQEhAwwBCyABQQBOBEAgAkEIaiABIAFBf3NBH3YQowcgAigCCCIDDQEACxDGBQALIAAgAzYCBCAAIAE2AgAgAkEQaiQAC7oBAQF/IwBBIGsiAiQAAkAgAUH/AXENABCzBw0AIABBAToABAsgACgCACEBIABBADYCACACIAE2AgQgAUF/RwRAIAJBADYCECMAQSBrIgAkACAAQci2wQA2AgQgACACQQRqNgIAIABBGGogAkEIaiIBQRBqKQIANwMAIABBEGogAUEIaikCADcDACAAIAEpAgA3AwggAEGchsEAIABBBGpBnIbBACAAQQhqQbS3wQAQ0gEACyACQSBqJAALXgEBfyMAQRBrIgMkAAJAAkACQCABQQJrDgIAAQILQQIhAQwBCyACIQELIAAgACgCCCIAIAEgABs2AghBBCEBIAAEQCADQQhqIAAQvQcgAygCCCEBCyADQRBqJAAgAQtSAQJ/IABBKGooAgAiAkEBahDrByEDIAAgACgCICACRwR/IAMFIABBIGogAhD9AiAAKAIoIgJBAWoLNgIoIABBJGooAgAgAkEDdGogATcCACADC2MBAX8jAEEQayIDJAAgASgCAEUEQCAAIAEoAgQ2AgAgACABQQhqLQAAOgAEIANBEGokAA8LIAMgASgCBDYCCCADIAFBCGotAAA6AAxBsPvBAEErIANBCGpBzI/AACACEOkDAAtjAQF/IwBBEGsiAyQAIAEoAgBFBEAgACABKAIENgIAIAAgAUEIai0AADoABCADQRBqJAAPCyADIAEoAgQ2AgggAyABQQhqLQAAOgAMQbD7wQBBKyADQQhqQdyPwAAgAhDpAwALYwEBfyMAQRBrIgMkACABKAIARQRAIAAgASgCBDYCACAAIAFBCGotAAA6AAQgA0EQaiQADwsgAyABKAIENgIIIAMgAUEIai0AADoADEGw+8EAQSsgA0EIakH8j8AAIAIQ6QMAC2UAAkACQAJAIAAoAgAOAwACAQILIABBCGooAgAgAEEMaigCABCGCCAAQcQAaigCACAAQcgAaigCABCGCAsPCyAAQQhqKAIAIABBDGooAgAQhgggAEEUaigCACAAQRhqKAIAENMHC1IAIANBA3QhAyACQQRqIQIgACABAn8DQCADRQRAQQAhAEGolcIADAILIANBCGshAyACKAIAIQAgAkEIaiECIABFDQALIAJBDGsoAgALIAAQuAELUgAgA0EDdCEDIAJBBGohAiAAIAECfwNAIANFBEBBACEAQaiVwgAMAgsgA0EIayEDIAIoAgAhACACQQhqIQIgAEUNAAsgAkEMaygCAAsgABCKAQtTAQF/IwBBIGsiAiQAIAAoAgAhACACQRhqIAFBEGopAgA3AwAgAkEQaiABQQhqKQIANwMAIAIgASkCADcDCCAAIAJBCGoQvgQhACACQSBqJAAgAAtjAQF/IwBBEGsiAyQAIAEoAgBFBEAgACABKAIENgIAIAAgAUEIai0AADoABCADQRBqJAAPCyADIAEoAgQ2AgggAyABQQhqLQAAOgAMQbD7wQBBKyADQQhqQciGwQAgAhDpAwALYwEBfyMAQRBrIgMkACABKAIARQRAIAAgASgCBDYCACAAIAFBCGotAAA6AAQgA0EQaiQADwsgAyABKAIENgIIIAMgAUEIai0AADoADEGw+8EAQSsgA0EIakHYhsEAIAIQ6QMAC2MBAX8jAEEQayIDJAAgASgCAEUEQCAAIAEoAgQ2AgAgACABQQhqLQAAOgAEIANBEGokAA8LIAMgASgCBDYCCCADIAFBCGotAAA6AAxBsPvBAEErIANBCGpBmI3BACACEOkDAAtjAQF/IwBBEGsiAyQAIAEoAgBFBEAgACABKAIENgIAIAAgAUEIai0AADoABCADQRBqJAAPCyADIAEoAgQ2AgggAyABQQhqLQAAOgAMQbD7wQBBKyADQQhqQciNwQAgAhDpAwALUgAgA0EDdCEDIAJBBGohAiAAIAECfwNAIANFBEBBACEAQaiVwgAMAgsgA0EIayEDIAIoAgAhACACQQhqIQIgAEUNAAsgAkEMaygCAAsgABCaAwtSACADQQN0IQMgAkEEaiECIAAgAQJ/A0AgA0UEQEEAIQBBqJXCAAwCCyADQQhrIQMgAigCACEAIAJBCGohAiAARQ0ACyACQQxrKAIACyAAEMYHC1MBAX8jAEEgayICJAAgACgCACEAIAJBGGogAUEQaikCADcDACACQRBqIAFBCGopAgA3AwAgAiABKQIANwMIIAAgAkEIahC/BCEAIAJBIGokACAAC1MBAX8jAEEgayICJAAgACgCACEAIAJBGGogAUEQaikCADcDACACQRBqIAFBCGopAgA3AwAgAiABKQIANwMIIAAgAkEIahDABCEAIAJBIGokACAAC1MBAX8jAEEgayICJAAgACgCACEAIAJBGGogAUEQaikCADcDACACQRBqIAFBCGopAgA3AwAgAiABKQIANwMIIAAgAkEIahDBBCEAIAJBIGokACAAC10BBH8gASgCCEEMbCEDIAEoAgQhBEF/IQUCQANAIANFDQEgA0EMayEDIAVBAWohBSAEKAIAIQYgBEEMaiEEIAIgBkcNAAsgACABIAVBoPvBABCqBA8LIABBADYCCAtjAQF/IwBBEGsiAyQAIAEoAgBFBEAgACABKAIENgIAIAAgAUEIai0AADoABCADQRBqJAAPCyADIAEoAgQ2AgggAyABQQhqLQAAOgAMQbD7wQBBKyADQQhqQdywwQAgAhDpAwALUgAgA0EDdCEDIAJBBGohAiAAIAECfwNAIANFBEBBACEAQaiVwgAMAgsgA0EIayEDIAIoAgAhACACQQhqIQIgAEUNAAsgAkEMaygCAAsgABDVAgtTAQF/IwBBIGsiAiQAIAAoAgAhACACQRhqIAFBEGopAgA3AwAgAkEQaiABQQhqKQIANwMAIAIgASkCADcDCCAAIAJBCGoQxgQhACACQSBqJAAgAAtSACADQQN0IQMgAkEEaiECIAAgAQJ/A0AgA0UEQEEAIQBBqJXCAAwCCyADQQhrIQMgAigCACEAIAJBCGohAiAARQ0ACyACQQxrKAIACyAAELIBC3UBAX8QyAciAUEAOgDIASABQoGAgIAQNwPAASABQQE6AJwBIAFCBDcClAEgAUIANwKMASABQoCAgIDAADcChAEgAUEAOwGAASABQgA3A0AgAUIANwMAIABBATYCCCAAIAE2AgQgAEEBNgIAIABBDGogATYCAAtcAQJ/IwBBIGsiAiQAIAJBEGoiAyABKAIAQQhqEOYIIAJBCGogA0HMtMEAEOAEIAItAAwhASAAIAIoAggiA0EQaigCADYCBCAAQQE2AgAgAyABEPkHIAJBIGokAAtOAQF/IwBBIGsiAyQAIANBGGogAkEQaikCADcDACADQRBqIAJBCGopAgA3AwAgAyACKQIANwMIIAAgASADQQhqEJMBIQAgA0EgaiQAIAALZgECfyMAQRBrIgIkACAAKAIAIQAgASgCAEHQ4cAAQQwgASgCBCgCDBEEACEDIAJBADoADSACIAM6AAwgAiABNgIIIAJBCGpB3OHAAEEGIABB5OHAABDfARCaBCEAIAJBEGokACAAC2IBAX8jAEEQayICJAACfyAAKAIAIgAoAgBFBEAgASgCAEHot8EAQQQgASgCBCgCDBEEAAwBCyACIABBBGo2AgwgAUHkt8EAQQQgAkEMakHc4sAAEIoDCyEAIAJBEGokACAAC2IBAX8jAEEQayICJAACfyAAKAIAIgAoAgBFBEAgASgCAEHot8EAQQQgASgCBCgCDBEEAAwBCyACIABBBGo2AgwgAUHkt8EAQQQgAkEMakHM4sAAEIoDCyEAIAJBEGokACAAC1oAIAAoAgBFBEAgAEEIaigCACAAQQxqKAIAEIYIIABBxABqKAIAIABByABqKAIAEIYIDwsgAEEIaigCACAAQQxqKAIAEIYIIABBFGooAgAgAEEYaigCABDTBwteAQJ/IwBBEGsiAiQAIAEQpgcgAUEIaiEDIAEtAAQEQCACIAE2AgwgAiADNgIIQbD7wQBBKyACQQhqQeiMwQBB2I7BABDpAwALIAAgATYCBCAAIAM2AgAgAkEQaiQAC1UBAn8gACgCCEEMbCECIAAoAgRBCGohAQNAIAIEQCABKAIAQQIgARDNBEEERgRAIAEoAgBBFGooAgAQhwkLIAJBDGshAiABQQxqIQEMAQsLIAAQnQILUAEBfyAAQQRqKAIAIABBCGooAgAgAUEEaigCACABQQhqKAIAEOgIBH8gAEEQaigCACAAQRRqKAIAIAFBEGooAgAgAUEUaigCABDoCAUgAgsLUgEBfyMAQRBrIgIkACACQQhqIAEQ5QQgAAJ/IAIoAggiAUECRgRAIAAgAi0ADDoAAUEBDAELIAAgAigCDEEAIAEbNgIEQQALOgAAIAJBEGokAAtQACAAAn8gAS0AAEUEQCAAIAEpAwg3AwggAEEYaiABQRhqKQMANwMAIABBEGogAUEQaikDADcDAEEADAELIAAgAS0AARCICDoAAUEBCzoAAAtRAQF/IwBBEGsiBCQAIAEgAiADECMhASAEQQhqEOAGIAACfyAEKAIIRQRAIAAgAUEARzoAAUEADAELIAAgBCgCDDYCBEEBCzoAACAEQRBqJAALagECf0Gc28EAIQMCQAJAAkACQCABLQAIIgJBBWtBACACQQVLGyICQQFrDgMDAAECC0GeysEAIQNBASECDAILQcCVwQAhA0ECIQIMAQsgASgCBCECIAEoAgAhAwsgACACNgIEIAAgAzYCAAtZAQJ/IwBBIGsiAyQAIANBCGogAhDLBCADIAMoAgwiBDYCFCADIAMoAgg2AhAgBCABIAIQkgkaIAMgAjYCGCADIANBEGoQ9gQgACADKQMANwMAIANBIGokAAteAgJ/AX4jAEEQayICJABBAEEsEQYAIgEEQCABIAEpAwAiA0IBfDcDACAAIAEpAwg3AwggACADNwMAIAJBEGokAA8LQfiqwQBBxgAgAkEIakHI5cAAQaCswQAQ6QMAC1gBAn8jAEEQayICJAAgAkEIaiABKAJgIAFB5ABqKAIAIgMoAghBB2pBeHFqIAEoAmggAygCMBEDACACKAIMIQEgACACKAIINgIAIAAgATYCBCACQRBqJAALWwEDfwJAIAEoAgwiAiABKAIIIgNPBEAgAiABKAIEIgRLDQEgASgCACEBIAAgAiADazYCBCAAIAEgA2o2AgAPCyADIAJBtN3BABDOCAALIAIgBEG03cEAEM0IAAt/AQR/IAEoAgAiAiABKAIIIgNLBEAgASgCBCEEIwBBEGsiBSQAAn8gA0UEQCAEIAIQpAhBAQwBCyAEIAJBASADEHYLIQIgBUEQaiQAIAMgAgR/IAEgAzYCACABIAI2AgRBgYCAgHgFQQELEKkHCyAAIAM2AgQgACABKAIENgIAC14BAX8jAEEQayICJAACQCAAIAEoAhwRBwBCkNyLhtuijfvhAFEEQCAAKAIAIQEgABB+DAELIAJBCGogATYCACACIAA2AgQgAkEBNgIAIAIQ4QYhAQsgAkEQaiQAIAELVQIBfwF+IwBBEGsiBCQAIARBCGogASACIAMQigECQAJAIAQtAAhBBEcEQCAEKQMIIgVC/wGDQgRSDQELIABBBDoAAAwBCyAAIAU3AgALIARBEGokAAtSAQN/IwBBEGsiAiQAIAEQuQcgAkEIaiABQQRqELwHIAItAAghAyACLQAJIQQgACABNgIEIABBCGogBEEBcToAACAAIANBAXE2AgAgAkEQaiQAC1IBA38jAEEQayICJAAgARCkBCACQQhqIAFBAWoQvAcgAi0ACCEDIAItAAkhBCAAIAE2AgQgAEEIaiAEQQFxOgAAIAAgA0EBcTYCACACQRBqJAALXQEBfyMAQRBrIgIkAAJ/IAAoAgBFBEAgAiAAQQRqNgIMIAFBtq/BAEEEIAJBDGpBvK/BABCKAwwBCyABKAIAQaSvwQBBEiABKAIEKAIMEQQACyEAIAJBEGokACAAC1UBA38jAEEQayIBJAAgABCbCCABQQhqIAAQ5wYgASgCDEEANgIAIAAoAgQhAiAAKAIIIQMgABB+IAIgAygCABEBACADKAIEBEAgAhB+CyABQRBqJAALUAAgAS0AEEECRwRAIAAgASkCADcCACAAQRBqIAFBEGooAgA2AgAgAEEIaiABQQhqKQIANwIADwsgAS0AACEBIABBAjoAECAAIAEQ+gc6AAALUQECfyAAKAIIIAAoAgQiAWtBOG5BOGwhAgNAIAIEQCABQShqKAIAIAFBLGooAgAQhgggAkE4ayECIAFBOGohAQwBCwsgACgCACAAKAIMEOMHC10CAX8BfiMAQSBrIgQkACAAKQMAIQUgAUG058EAEM8HIQEgBCADNgIcIAQgAjYCGCAEIAA2AhAgBCABNgIIIAQgBTcDACAEIAIgAxCxASEAIARBIGokACAAQf8BcQtSAQF/IwBBEGsiAyQAAkAgAiABIANBCGpBCBCTBSICQf8BcUEDRgRAIAAgAykDCDcCBCAAQQA6AAAMAQsgAEEBOgAAIAAgAjoAAQsgA0EQaiQAC1gBAX9BjJ3CAEGMncIAKAIAIgFBAWo2AgACQCABQQBIDQBBvJzCAEG8nMIAKAIAQQFqIgE2AgAgAUECSw0AIABFQeCYwgAoAgBBAEggAUEBS3JyDQAACwALXwECfyMAQRBrIgIkACABKAIAQZzywABBCiABKAIEKAIMEQQAIQMgAkEAOgANIAIgAzoADCACIAE2AgggAkEIakGSosEAQQUgAEGo8sAAEN8BEJoEIQAgAkEQaiQAIAALTgEBfyMAQTBrIgMkAAJAIAIgASADQQhqQSgQkwUiAkH/AXFBA0YEQCAAIANBCGpBKBCSCRoMAQsgAEEEOgAIIAAgAjoAAAsgA0EwaiQAC00BA38jAEEQayICJAAgAkEIaiABQQRqELwHIAItAAghAyACLQAJIQQgACABNgIEIABBCGogBEEBcToAACAAIANBAXE2AgAgAkEQaiQAC1IBAX8CQAJAAkAgAkUEQEEBIQMMAQsgAkEASA0BIAJBARDPASIDRQ0CCyADIAEgAhCSCSEBIAAgAjYCCCAAIAE2AgQgACACNgIADwsQxgUACwALWgEBfyMAQRBrIgIkAAJ/IAAoAgRFBEAgASgCAEG45cAAQRAgASgCBCgCDBEEAAwBCyACIAA2AgwgAUGw4cAAQQcgAkEMakG44cAAEIoDCyEAIAJBEGokACAAC0oBAn8gASAAKAIIIgJJBEAgACgCBCABQQN0aiIDIANBCGogAiABQX9zakEDdBCUCRogACACQQFrNgIIDwsgASACQcDtwQAQgAQAC1wBAX8jAEEQayICJAAgAiAAKAIAIgA2AgggAiAAQQhqNgIMIAFB8ObAAEEMQfzmwABBBiACQQhqQYTnwABBlOfAAEEHIAJBDGpBhOfAABCXAyEAIAJBEGokACAAC1wBAX8jAEEQayICJAAgAiAAKAIAIgA2AgggAiAAQQFqNgIMIAFBo+fAAEEKQdy0wQBBAiACQQhqQbDnwABBwOfAAEEKIAJBDGpBzOfAABCXAyEAIAJBEGokACAAC0oBAX8gAAJ/IAEoAgAiAkEASARAIABBADYCBEEBDAELIAEgAkEBajYCACAAQQhqIAE2AgAgACABQQhqNgIEIAEtAARBAEcLNgIAC1QBA38jAEEQayIEJAAgBEEIaiADEMsEIAQoAgghBSAEKAIMIAIgAxCSCSEGENkHIgIgAzYCCCACIAY2AgQgAiAFNgIAIAAgASACEKAGIARBEGokAAtVAQF/AkAgAUUEQEEEIQIMAQsCQCABQarVqtUASw0AIAFBDGwiAkEASA0AIAIgAUGr1arVAElBAnQQ1AciAg0BAAsQxgUACyAAIAI2AgQgACABNgIAC1EBAX8gACgCCCICIAAoAgBGBEAgACACEP4CIAAoAgghAgsgACACQQFqNgIIIAAoAgQgAkEMbGoiACABKQIANwIAIABBCGogAUEIaigCADYCAAtNAQN/IwBBEGsiAiQAIAJBCGogAUEBahC8ByACLQAIIQMgAi0ACSEEIAAgATYCBCAAQQhqIARBAXE6AAAgACADQQFxNgIAIAJBEGokAAtSAgJ/AX4jAEEgayIBJAAgAUEQaiICIAAoAgBBCGoQ5gggAUEIaiACQay0wQAQ4AQgASgCCCIAQRBqNQIAIQMgACABLQAMEPkHIAFBIGokACADC08BAX8gAEEUaigCACIBIAEoAgAiAUEBazYCACABQQFGBEAgACgCFBCVBQsCQCAAQX9GDQAgACAAKAIEIgFBAWs2AgQgAUEBRw0AIAAQfgsLUgEBfyMAQSBrIgMkACADQQxqQQE2AgAgA0EUakEANgIAIANBqJXCADYCECADQQA2AgAgAyABNgIcIAMgADYCGCADIANBGGo2AgggAyACEIEGAAtSAQF/IwBBIGsiAiQAIAJBDGpBATYCACACQRRqQQE2AgAgAkG4scEANgIIIAJBADYCACACQQQ2AhwgAiAANgIYIAIgAkEYajYCECACIAEQgQYAC0UBAX4Cf0EBIAEgA618IgQgAVQNABpBACAEIAAoAgAQGa1WDQAaIAAoAgAgAacgBKcQ8AgiACACIAMQnQQgABCLCEEDCwtPAQF/AkACQAJAIAJFBEBBASEDDAELIAJBAEgNASACEFAiA0UNAgsgAyABIAIQkgkhASAAIAI2AgggACABNgIEIAAgAjYCAA8LEMYFAAsAC04BAX8CQCAAKAIIIgFFDQAgAUEAOgAAIABBDGooAgBFDQAgACgCCBB+CwJAIABBf0YNACAAIAAoAgQiAUEBazYCBCABQQFHDQAgABB+CwtUACAAIAEoAiA2AiAgACABKQMANwMAIAAgASkDCDcDCCAAIAEpAxA3AxAgACABKQMYNwMYIABBJmogAUEmai0AADoAACAAQSRqIAFBJGovAQA7AQALUwEBfyACIAEoAggiA0sEQCACIANB4KLBABDNCAALIAFBADYCCCAAIAI2AgggACABNgIQIAAgAyACazYCDCAAIAEoAgQiATYCBCAAIAEgAmo2AgALTAEBfyAAKAIIIgEgASgCACIBQQFrNgIAIAFBAUYEQCAAKAIIEOwCCwJAIABBf0YNACAAIAAoAgQiAUEBazYCBCABQQFHDQAgABB+CwtMAgF/AX4jAEEQayIDJAAgA0EIaiAAKAIIIAEgAhC8AyADLQAIIgFBBEcEQCADKQMIIQQgABD1ByAAIAQ3AgALIANBEGokACABQQRHC0YAIAEoAgAiAUEBcQRAIAEgBBEGACACIAMQlAkhASAAIAM2AgggACABNgIEIAAgAiADaiABazYCAA8LIAAgASACIAMQ4gMLSwECfyMAQRBrIgEkACABQQhqIANBABCRBCABKAIIIQQgACABKAIMIgU2AgQgACAENgIAIAUgAiADEJIJGiAAIAM2AgggAUEQaiQAC0oBAX8CQCABLQAUQQdHBEBBACEBDAELIAEoAgAiAkEMaigCAEEAIAIoAghBAUYbIQEgAkEQaigCACECCyAAIAI2AgQgACABNgIAC0UBAX8jAEEgayICJAAgAkEYaiABQQhqKAIANgIAIAIgASkCADcDECACQQhqIAJBEGoQ9gQgACACKQMINwMAIAJBIGokAAtTAQF/IAAgAUEYaigCADYCGCAAIAFBHGooAgAiAjYCECAAIAJBCGo2AgggACACIAEoAhBqQQFqNgIMIAAgAikDAEJ/hUKAgYKEiJCgwIB/gzcDAAtPAQF/IAEoAgAiASABKAIAIgJBAWo2AgAgAkEASARAAAsQ2AchAiAAQQA2AgggAEHw6sAANgIEIAAgAjYCACACIAE2AgAgAEEMakEAOwEAC00BAX8jAEEQayIBJAAgASABIAEQpQYCQCABKAIARQRAIABBBDoAAAwBCyABKAIEIQIgACABQQhqKAIANgIEIAAgAjYCAAsgAUEQaiQAC00BAX8jAEEQayIBJAAgASABIAEQpAYCQCABKAIARQRAIABBBDoAAAwBCyABKAIEIQIgACABQQhqKAIANgIEIAAgAjYCAAsgAUEQaiQAC00BAX8jAEEQayIBJAAgASABIAEQogYCQCABKAIARQRAIABBBDoAAAwBCyABKAIEIQIgACABQQhqKAIANgIEIAAgAjYCAAsgAUEQaiQAC0cBAX4jAEEQayIBJAAgAUEIaiABIAEgARDLBiABLQAIIgJBBEcEQCABKQMIIQMgABDsBSAAIAM3AgALIAFBEGokACACQQRHC0oBAX8jAEFAaiIDJAACQCACIAEgA0HAABCTBSICQf8BcUEDRgRAIAAgA0HAABCSCRoMAQsgAEEJOgAQIAAgAjoAAAsgA0FAayQAC00BAX8jAEEQayIBJAAgASABIAEQpwYCQCABKAIARQRAIABBBDoAAAwBCyABKAIEIQIgACABQQhqKAIANgIEIAAgAjYCAAsgAUEQaiQAC0kBA38jAEEQayIDJAAgA0EIaiACEMsEIAMoAgghBCAAIAMoAgwiBTYCBCAAIAQ2AgAgBSABIAIQkgkaIAAgAjYCCCADQRBqJAALSAEBfyACIAAoAgAiACgCACAAKAIIIgNrSwRAIAAgAyACEIEDIAAoAgghAwsgACgCBCADaiABIAIQkgkaIAAgAiADajYCCEEAC04BAX8jAEEQayIAJAAgASgCAEGF88EAQQsgASgCBCgCDBEEACECIABBADoADSAAIAI6AAwgACABNgIIIABBCGoQrAMhASAAQRBqJAAgAQtOAQF/IwBBEGsiACQAIAEoAgBB2MHAAEELIAEoAgQoAgwRBAAhAiAAQQA6AA0gACACOgAMIAAgATYCCCAAQQhqEJoEIQEgAEEQaiQAIAELQAAgACABaiEBIAMoAgBBAWohAANAIAIEQCADIAA2AgAgAUEAOgAAIAFBAWohASAAQQFqIQAgAkEBayECDAELCwtNAQF/IAAoAgAgACgCBCgCABEBACAAKAIEKAIEBEAgACgCABB+CyAAKAIIIABBDGoiASgCACgCABEBACABKAIAKAIEBEAgACgCCBB+Cws+AQF/AkAgASADTQ0AIAAgA0GQAmxqQQAgASADSxsiAC0AjAJBAkYNACAAQQhqQQAgACkDACACURshBAsgBAshAQF/QeAAQQQQ1AciAQRAIAAgATYCBCAAQQQ2AgAPCwALSQEBfwJAAkAgAUH///8fSw0AIAFBBXQiAkEASA0AIAIgAUGAgIAgSUEDdBDUByICRQ0BIAAgAjYC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SgEBfyMAQSBrIgAkACAAQRRqQQE2AgAgAEEcakEANgIAIABBiOPAADYCECAAQaiVwgA2AhggAEEANgIIIABBCGpBwL7AABCBBgALQQEDfyMAQRBrIgIkACABECIhASACQQhqEOAGIAIoAgwhAyAAIAIoAggiBDYCACAAIAMgASAEGzYCBCACQRBqJAALSgEBfyMAQSBrIgAkACAAQRRqQQE2AgAgAEEcakEANgIAIABB+MrAADYCECAAQaiVwgA2AhggAEEANgIIIABBCGpBsMvAABCBBgALSgEBfyMAQSBrIgAkACAAQRRqQQE2AgAgAEEcakEANgIAIABB+MrAADYCECAAQaiVwgA2AhggAEEANgIIIABBCGpBwMvAABCBBgALSgEBfyMAQSBrIgAkACAAQRRqQQE2AgAgAEEcakEANgIAIABBiOPAADYCECAAQaiVwgA2AhggAEEANgIIIABBCGpB8OPAABCBBgALPAACQCABIAJNBEAgAiAETQ0BIAIgBCAFEM0IAAsgASACIAUQzggACyAAIAIgAWs2AgQgACABIANqNgIACzoBAX8gAEEYaigCAARAIABBEGogACkDACAAQQhqKQMAIAEoAgAQ/AMgARD1AyECCyACQQhqQQAgAhsLPQAgAiADTwRAIAAgAzYCBCAAIAE2AgAgAEEMaiACIANrNgIAIAAgASADajYCCA8LQZCBwQBBIyAEEJEFAAs9AQF/IAEoAgAiAkEASARAAAsgASACQQFqNgIAIABBCGogATYCACAAIAFBCGo2AgQgACABLQAEQQBHNgIACzoBA38DQCACQRhHBEAgACACaiIDKAIAIQQgAyABIAJqIgMoAgA2AgAgAyAENgIAIAJBBGohAgwBCwsLQAEBfyMAQSBrIgMkACADIAI2AhggAyABNgIUIAMgAjYCECADQQhqIANBEGoQ9gQgACADKQMINwMAIANBIGokAAtAAQF/IAAoAgAoAgAiAkEEaigCACACQQhqKAIAIAAoAgQoAgwgAUEFdGtBIGsiAEEEaigCACAAQQhqKAIAEOgIC0MCAX8BfiMAQRBrIgUkACAFQQhqIAEgAhD8BSAFKQMIIQYgBSADIAQQ/AUgACAFKQMANwIIIAAgBjcCACAFQRBqJAALPQEBfyAAIAAoAggiAUEBazYCCCABQQFGBEAgACgCACEBIAAoAgRBf3NBH3ZB9JPAABCQBiABEH4gABB+Cws/AQF/IAAoAgAhACABKAIYIgJBEHFFBEAgAkEgcUUEQCAAIAEQyggPCyAAKAIAIAEQ3QMPCyAAKAIAIAEQ3AMLTwECfxDdAiEBQYCdwgAtAABFBEBBgJ3CAEEBOwAAC0EYEFAiAEUEQAALIAAgATYCFCAAQYGdwgA2AhAgAEIANwIIIABCgYCAgBA3AgAgAAs/AQF/IAAoAgAhACABKAIYIgJBEHFFBEAgAkEgcUUEQCAAIAEQ/wYPCyAAKAIAIAEQ3QMPCyAAKAIAIAEQ3AMLOwEBfyABLQAEIgJBAkcEQCAAIAI6AAQgACABKAIANgIADwsgAS0AACEBIABBAjoABCAAIAEQ7gc6AAALPAEBfyABIAEoAggiBEEBajYCCCAEQQBOBEAgAEGElMAANgIMIAAgATYCCCAAIAM2AgQgACACNgIADwsACzkAAkACfyACQYCAxABHBEBBASAAIAIgASgCEBECAA0BGgsgAw0BQQALDwsgACADIAQgASgCDBEEAAvBAQEDfyAAKAIAIQAgASgCGCICQRBxRQRAIAJBIHFFBEAgACABEMsIDwsgACABEMoDDwsgAC0AACEAIwBBgAFrIgQkAANAIAMgBGpB/wBqQTBB1wAgAEEPcSICQQpJGyACajoAACADQQFrIQMgACICQQR2IQAgAkEPSw0ACyADQYABaiIAQYEBTwRAIABBgAFBlKDAABDJCAALIAFBAUGQlMIAQQIgAyAEakGAAWpBACADaxCLASEAIARBgAFqJAAgAAs4AQJ/QfiZwgAoAgAiAQRAA0AgAEEBaiEAIAEoAggiAQ0ACwtBsJzCAEH/HyAAIABB/x9NGzYCAAs0ACABQShsIQEDQCABBEAgAEEcaigCACAAQSBqKAIAEIYIIAFBKGshASAAQShqIQAMAQsLCzoAIAAoAgAiACgCAEUEQCAAQQRqIAEQuwcPCyAAQQhqKAIAIABBDGooAgAgASgCACABQQRqKAIAEHQLPAEBfiAAKAIAKQMAIQIgASgCGCIAQRBxRQRAIABBIHFFBEAgAiABEOwIDwsgAiABEN8CDwsgAiABEN4CCzgAIAEgAkECdGtBBGsoAgAiASAAKAIEIgJPBEAgASACQaDhwAAQ/wMACyAAKAIAIAFBKGxqNQIYCzwBAX8jAEEQayIFJAAgBUEIaiADIAEgAiAEEL4GIAUoAgwhASAAIAUoAgg2AgAgACABNgIEIAVBEGokAAs7AQF/IAEoAgAiAkECRwRAIAAgAjYCACAAIAEoAgQ2AgQPCyABLQAEIQEgAEECNgIAIAAgARDuBzoABAs8AQF/IAAoAggiAiAAKAIARgRAIAAgAhD8AiAAKAIIIQILIAAgAkEBajYCCCAAKAIEIAJBAnRqIAE2AgAL9gYCC38DfiMAQRBrIgokACAKQQhqIg0gAkEIaigCADYCACAKIAIpAgA3AwAjAEEgayIGJAAgASkDACABQQhqKQMAIApBBGooAgAgDSgCABCgBCEQIAYgCjYCHCAGIAFBEGoiBzYCDCAHKAIAIQsgAUEcaiIIKAIAIQIgBiAGQRxqNgIIIAYgCyACIBAgBkEIakErEJgDAkAgBigCAEEAIAgoAgAiCRtFBEAgBkEQaiANKAIANgIAIAYgCikCADcDCCAJIAEoAhAiCCAJIBAQjAQiC2otAABBAXEhDSABQRRqKAIAIgIgDUVyRQRAIwBB0ABrIgUkACAFIAE2AgggB0EIaigCACEIIAUgBUEIajYCDAJAAkAgCEEBaiIMBEAgBygCACICIAJBAWoiC0EDdkEHbCACQQhJGyICQQF2IAxJBEAgBUEoaiAIQSAgDCACQQFqIgIgAiAMSRsQ+wIgBSgCNCIPRQ0CIAUgBSkDODcDICAFIA82AhwgBSAFKQIsNwIUIAUgBSgCKCIINgIQQWAhCQNAIAsgDkYEQCAHKQIAIRIgByAFKQMQNwIAIAVBGGoiAikDACERIAIgB0EIaiICKQIANwMAIAIgETcCACAFIBI3AxAgBUEQahDmBgwFCyAHKAIMIgIgDmosAABBAE4EQCAPIAggDyAFQQxqIAcgDhD0BRDKB0F/c0EFdGoiDCACIAlqIgIpAAA3AAAgDEEYaiACQRhqKQAANwAAIAxBEGogAkEQaikAADcAACAMQQhqIAJBCGopAAA3AAALIA5BAWohDiAJQSBrIQkMAAsACyAHIAVBDGpBMEEgEKABDAILEMgFAAsgBSgCLBoLIAVB0ABqJAAgASgCFCECIAEoAhAiCCABQRxqKAIAIgkgEBCMBCELCyABIAIgDWs2AhQgCCAJIAsgEBDJBiABQRhqIgIgAigCAEEBajYCACABQRxqKAIAIAtBBXRrQSBrIgEgBikDCDcDACABIAQ2AhggASADNwMQIAFBCGogBkEQaikDADcDACAAQgA3AwAMAQsgCSAGKAIEQQV0a0EgayIBKQMQIREgASADNwMQIAFBGGoiAigCACEBIAIgBDYCACAAQgE3AwAgACARNwMIIABBEGogATYCACAKKAIAIApBBGooAgAQhggLIAZBIGokACAKQRBqJAALPgECfyMAQRBrIgAkAEEAQS8RBgAiAQRAIABBEGokACABDwtB+KrBAEHGACAAQQhqQcCrwQBBoKzBABDpAwALNgEBfyAAKAIAIgFBxAFqKAIABEAgASgCwAEQfgsgAUGEAWoQvQggAUGkAWoQvQggACgCABB+CygAIAAgAyACIABBAWpsakEBa0EAIANrcSICakF3RwRAIAEgAmsQfgsLNAAgAUE4bCEBA0AgAQRAIABBKGooAgAgAEEsaigCABCGCCABQThrIQEgAEE4aiEADAELCws6AQF/IwBBEGsiBSQAIABB/wFxRQRAIAVBEGokAA8LIAUgATYCDCACIAMgBUEMakGk8MEAIAQQ6QMACz0BAX8jAEEQayIDJAAgAEH/AXFFBEAgA0EQaiQADwsgAyABNgIMQbD7wQBBKyADQQxqQaTwwQAgAhDpAwALPQEBfyAALQAAQQNGBEAgACgCBCIBKAIAIAEoAgQoAgARAQAgASgCBCgCBARAIAEoAgAQfgsgACgCBBB+Cws6AQF/IwBBEGsiAyQAIANBCGogASACQQAQ2QYgAygCDCEBIAAgAygCCDYCACAAIAE2AgQgA0EQaiQACzsBAX8jAEEQayIDJAAgAEUEQCADQRBqJAAgAQ8LIAMgATYCDEGw+8EAQSsgA0EMakGM3MAAIAIQ6QMACz0BA38gASgCBCEDIAAgASgCCCICEPQCIAAoAggiBCAAKAIEaiADIAIQkgkaIAFBADYCCCAAIAIgBGo2AggLrAIBA38jAEEQayIDJAAgA0EANgIMIANBDGohAiMAQRBrIgQkACAEQQhqAn8gAUGAAU8EQCABQYAQTwRAIAFBgIAETwRAIAIgAUE/cUGAAXI6AAMgAiABQQZ2QT9xQYABcjoAAiACIAFBDHZBP3FBgAFyOgABIAIgAUESdkEHcUHwAXI6AABBBAwDCyACIAFBP3FBgAFyOgACIAIgAUEMdkHgAXI6AAAgAiABQQZ2QT9xQYABcjoAAUEDDAILIAIgAUE/cUGAAXI6AAEgAiABQQZ2QcABcjoAAEECDAELIAIgAToAAEEBCyACQQRBgIHBABDzBiAEKAIMIQEgAyAEKAIINgIAIAMgATYCBCAEQRBqJAAgACADKAIAIAMoAgQQggQhACADQRBqJAAgAAs4AQF/IAEoAgAiAgRAIAAgAjYCACAAIAEoAgQ2AgQPCyABLQAEIQEgAEEANgIAIAAgARDuBzoABAv/AQECfyMAQRBrIgMkACADQQA2AgwgA0EMaiECIAMCfyABQYABTwRAIAFBgBBPBEAgAUGAgARPBEAgAiABQT9xQYABcjoAAyACIAFBBnZBP3FBgAFyOgACIAIgAUEMdkE/cUGAAXI6AAEgAiABQRJ2QQdxQfABcjoAAEEEDAMLIAIgAUE/cUGAAXI6AAIgAiABQQx2QeABcjoAACACIAFBBnZBP3FBgAFyOgABQQMMAgsgAiABQT9xQYABcjoAASACIAFBBnZBwAFyOgAAQQIMAQsgAiABOgAAQQELNgIEIAMgAjYCACAAIAMoAgAgAygCBBC8CCEAIANBEGokACAACz4BAX8jAEEQayICJAAgAEUEQCACQRBqJAAgAQ8LIAIgATYCDEGw+8EAQSsgAkEMakHwvcEAQZi/wQAQ6QMACzgAIAAoAgAoAgAiACkDACAAQQhqKQMAIAEoAgwgAkEFdGtBIGsiAEEEaigCACAAQQhqKAIAEKAECzoBAn8jAEEQayIBJAAgABCbCCABQQhqIAAQ5wYgASgCDEEANgIAIAAoAgQhAiAAEH4gAUEQaiQAIAILOgEBfwJ/IAEoAgBFBEAgACABKAIEEOkHNgIAQQAMAQtBASECIAEoAgQLIQEgACACNgIIIAAgATYCBAtpAQN/IwBBEGsiAiQAIAEQmwggAkEIaiEDAkAgASgCACIEQX9HBEAgASAEQQFqNgIAIAMgATYCBCADIAFBBGo2AgAMAQsQ+AgACyACKAIMIQEgACACKAIINgIAIAAgATYCBCACQRBqJAALOwEBfyMAQRBrIgIkACABEJsIIAJBCGogARDnBiACKAIMIQEgACACKAIINgIAIAAgATYCBCACQRBqJAALOwEBfyMAQRBrIgMkACAARQRAIANBEGokACABDwsgAyABNgIMQbD7wQBBKyADQQxqQaDGwQAgAhDpAwALOAEBfyAAKAIYEIsIIABBIGooAgAiAQRAIAAoAhwgARCGCAsgACgCBARAIAAQwwQgAEEMahDDBAsLOwEBfyMAQRBrIgIkACABEJsIIAJBCGogARDoBiACKAIMIQEgACACKAIINgIAIAAgATYCBCACQRBqJAALOgEBfyMAQRBrIgMkACADQQhqIAIQywQgAygCDCABIAIQkgkhASAAIAI2AgQgACABNgIAIANBEGokAAs+AQF/IwBBEGsiAiQAIABFBEAgAkEQaiQAIAEPCyACIAE2AgxBsPvBAEErIAJBDGpBqOPBAEHM5cEAEOkDAAs3ACAAKAIAKAIAIgApAwAgAEEIaikDACABKAIMIAJB6H1sakGYAmsiACkDACAAQQhqKAIAEN4DCzUAIAAoAgAoAgAiACkDACAAQQhqKQMAIAEoAgwgAkFsbGpBFGsiACgCACAAQQRqKAIAELoBCzEAIAFBGGwhAQNAIAEEQCAAKAIAIABBBGooAgAQhgggAUEYayEBIABBGGohAAwBCwsL2AEBAX8jAEEgayICJAAgAkEBOgAYIAIgATYCFCACIAA2AhAgAkGsnsAANgIMIAJBqJXCADYCCCMAQRBrIgAkACACQQhqIgEoAggiAkUEQEH3+MEAQStBrMrAABCRBQALIAAgASgCDDYCCCAAIAE2AgQgACACNgIAIwBBEGsiASQAIAFBCGogAEEIaigCADYCACABIAApAgA3AwAgASgCACIAQRRqKAIAIQICQAJAIABBDGooAgAOAgAAAQsgAg0AIAEoAgQtABAQgQUACyABKAIELQAQEIEFAAs3AQF/IwBBEGsiAyQAIAMgASACEKYFIABBCGogA0EIaigCADYCACAAIAMpAwA3AgAgA0EQaiQACzcBAX8jAEEQayIDJAAgAyABIAIQhQUgAEEIaiADQQhqKAIANgIAIAAgAykDADcCACADQRBqJAALOQEBfwJAIAEoAhgiAkEQcUUEQCACQSBxDQEgACABEMoIDwsgACgCACABENwDDwsgACgCACABEN0DCzIBAn8jAEEwayIDJAAgA0EIaiIEIAJBKBCSCRogASAAIARBKBCgAyEBIANBMGokACABCzEAIAFBDGwhAQNAIAEEQCAAKAIAIABBBGooAgAQhgggAUEMayEBIABBDGohAAwBCwsLNgEBfyMAQRBrIgIkACACIAEQMSACKAIAIQEgACACKwMIOQMIIAAgAUEAR603AwAgAkEQaiQACzIBAn8jAEFAaiIDJAAgA0EIaiIEIAJBOBCSCRogASAAIARBOBCgAyEBIANBQGskACABCzgAIAEoAgBFBEAgACABKAIEIAFBCGooAgAQmwQPCyAAIAEpAgQ3AgAgAEEIaiABQQxqKAIANgIACzgBAX8jAEEQayIDJAAgA0EIaiAAIAEQsQcgAygCCCADKAIMIAIQkAQoAgAQACEBIANBEGokACABCzYBAX8gACgCACgCACICKAIIIAAoAgQoAgwgAUHofWxqQZgCayIAKAIIRiACKQMAIAApAwBRcQs5ACABKAIERQRAIABBADYCBCAAIAI2AgAPCyAAIAEpAgA3AgAgAEEIaiABQQhqKAIANgIAIAIQiwgLOQEBfwJAIAEoAhgiAkEQcUUEQCACQSBxDQEgACABEP8GDwsgACgCACABENwDDwsgACgCACABEN0DCzAAIAACfyABLQAARQRAIAAgASkCBDcCBEEADAELIAAgAS0AARCICDoAAUEBCzoAAAsyACAAAn8gAS0AAEEERgRAIAAgASgCBDYCBEEADAELIAAgASkCABDGBjoAAUEBCzoAAAsxAQF/IwBBEGsiAiQAIAAEQCACQRBqJAAPC0Gw+8EAQSsgAkEIakHIk8AAIAEQ6QMACzwBAX8jAEEQayICJAAgAiAANgIMIAFBzPzAAEEFQdH8wABBAyACQQxqQdT8wAAQogMhACACQRBqJAAgAAs8AQF/IwBBEGsiAiQAIAIgADYCDCABQbT9wABBBkHR/MAAQQMgAkEMakHU/MAAEKIDIQAgAkEQaiQAIAALPAEBfyMAQRBrIgIkACACIAA2AgwgAUH4/cAAQQZB0fzAAEEDIAJBDGpB1PzAABCiAyEAIAJBEGokACAACzgAIAIgASkDCFQEQCAAIAEoAhA2AgggACABKQMAIAJCKH58NwMADwtBiIfBAEEXQaCHwQAQ6wYACzAAIAEtAAhBBEcEQCAAIAFBKBCSCRoPCyABLQAAIQEgAEEEOgAIIAAgARCICDoAAAswACABLQAgQQJHBEAgACABQSgQkgkaDwsgAS0AACEBIABBAjoAICAAIAEQ7gc6AAALQwEBfyACQYCU69wDRiEDA0ACQAJAAkAgACgCACgCCCICDgMCAQEAC0EDIQILIAIPCyADBEAQtAEMAQUQygUACwALAAs8AQF/IwBBEGsiAiQAIAIgADYCDCABQeK0wQBBBEHmtMEAQQYgAkEMakHstMEAEKIDIQAgAkEQaiQAIAALMQAgAS0AEEEJRwRAIAAgAUHAABCSCRoPCyABLQAAIQEgAEEJOgAQIAAgARCICDoAAAs8AQF/IwBBEGsiAiQAIAIgADYCDCABQZjAwQBBBUGdwMEAQQUgAkEMakGkwMEAEKIDIQAgAkEQaiQAIAALMAAgAAJ/IAEtAABFBEAgACABKAIENgIEQQAMAQsgACABLQABEPoHOgABQQELOgAACzYBAX8jAEEQayICJAAgAkEIaiABEJwFIAIoAgwhASAAIAIoAgg2AgAgACABNgIEIAJBEGokAAtDAQF/IAFBgJTr3ANGIQIDQAJAAkACQCAAKAIAKAIIIgEOAwIBAQALQQMhAQsgAQ8LIAIEQBC0AQwBBRDKBQALAAsACy8BAX8gASgCACIEQQFxBEAgACABIAQgBEF+cSACIAMQiQQPCyAAIAQgAiADENoFCz0BAX8gACgCACEBAkAgAEEEai0AAA0AQYydwgAoAgBB/////wdxRQ0AEJgJDQAgAUEBOgABCyABQQA6AAALNQEBf0EMEFAiA0UEQAALIAMgAToACCADQfjuwAA2AgQgAyACNgIAIAAgA61CIIZCA4Q3AgALMwACQCAAQfz///8HSw0AIABFBEBBBA8LIAAgAEH9////B0lBAnQQzwEiAEUNACAADwsACzQAIwBBEGsiASQAIAFBCGpBAUHk/MAAQRMQiwUgAEEBNgIAIAAgASkDCDcCBCABQRBqJAALLQACQCAAIAFNBEAgASACTQ0BIAEgAiADEM0IAAsgACABIAMQzggACyABIABrCzQAIwBBEGsiASQAIAFBCGpBAUG6/cAAQRQQiwUgAEEBNgIAIAAgASkDCDcCBCABQRBqJAALNAAjAEEQayIBJAAgAUEIakEBQf79wABBFBCLBSAAQQE2AgAgACABKQMINwIEIAFBEGokAAs4AQF/IwBBEGsiAiQAIAIgACgCADYCDCABQajgwABBByACQQxqQbDgwAAQigMhACACQRBqJAAgAAs0ACMAQRBrIgEkACABQQhqQSdBlLTBAEEWEIsFIABBATYCACAAIAEpAwg3AgQgAUEQaiQACzIAIAAoAgQoAgwgAUFsbGpBFGsiASgCACABKAIEIAAoAgAoAgAiACgCACAAKAIEEJsHCyoAQX8gACACIAEgAyABIANJGxCTCSIAIAEgA2sgABsiAEEARyAAQQBIGwswAQJ/IAEoAgAiAiABKAIERwRAIAEgAkEBajYCAEEBIQMLIAAgAjYCBCAAIAM2AgALLQACQAJ/IAFFBEAgA0UNAiADIAIQzwEMAQsgACABIAIgAxB2CyICDQAACyACCzAAIAACfyABKAIARQRAIAAgASkDCDcDCEEADAELIAAgASkCBBDGBjoAAUEBCzoAAAs1ACACIAEpAwhUBEAgACABKAIQNgIIIAAgASkDACACfDcDAA8LQYiHwQBBF0Ggh8EAEOsGAAsyAAJAIAFFDQAgA0UEQCABIAIQzwEhAgwBCyABIAIQugYhAgsgACABNgIEIAAgAjYCAAsxAQF/IwBBEGsiAyQAIAAgASACEJkCIANB/wE6AA8gACADQQ9qQQEQmQIgA0EQaiQACzEBAX8jAEEQayIDJAAgAiAAIAEQmQIgA0H/AToADyACIANBD2pBARCZAiADQRBqJAALMAEBfwJAIAAEQCAAKAIADQEgAEEANgIAIAAoAgQhASAAEH4gAQ8LEPcIAAsQ+AgACz0AIAAoAgAtAABFBEAgASgCAEGe58AAQQUgASgCBCgCDBEEAA8LIAEoAgBBm+fAAEEDIAEoAgQoAgwRBAALMwIBfwF+IwBBEGsiASQAIAEQ8wQgASkDACECIAAgASkDCDcDCCAAIAI3AwAgAUEQaiQACzQBAn8gACAAKAJAIgEgACgC0AEiAnI2AkAgASACcUUEQCAAQYABahDSAiAAQaABahDSAgsLMQAgAC0AAEUEQCAAQQRqKAIAIABBCGooAgAQpAggAEEMaigCACAAQRBqKAIAEKQICwstAQF/IwBBEGsiAyQAIAMgAjoADyABIAAgA0EPakEBEKADIQEgA0EQaiQAIAELLQEBfyMAQRBrIgMkACADIAI3AwggASAAIANBCGpBCBCgAyEBIANBEGokACABCy0BAX8jAEEQayIDJAAgAyACNgIMIAEgACADQQxqQQQQoAMhASADQRBqJAAgAQssAQF/IAEoAgAiBEEBcQRAIAAgASAEIAQgAiADEIkEDwsgACAEIAIgAxDaBQsrAAJAIAAgARDPASIBRQ0AIAFBBGstAABBA3FFDQAgAUEAIAAQkQkaCyABCzIAIAEoAgRFBEBB9/jBAEErIAIQkQUACyAAIAEpAgA3AgAgAEEIaiABQQhqKAIANgIACzABAX8CQCAAKAIAIgFBf0YNACABIAEoAgQiAUEBazYCBCABQQFHDQAgACgCABB+Cws9AQF/QSghAQJAAkACQAJAIAAtAABBAWsOAwABAgMLIAAtAAEPCyAAKAIELQAIDwsgACgCBC0ACCEBCyABCykAIAEgA00EQCAAIAMgAWs2AgQgACABIAJqNgIADwsgASADIAQQyQgACzQBAX8gACgCACgCACICKAIEIAIoAgggACgCBCgCDCABQQV0a0EgayIAKAIEIAAoAggQmwcLLgEBfyAAQQRqKAIAIgEEQCAAKAIAIAEQhgggAEEMaigCACAAQRBqKAIAEIYICwsrACAAKAIAKAIAIgApAwAgAEEIaikDACABKAIMIAJBSGxqQThrKAIAEPwDCzABAX8gACgCACIBIAEoAgAiAUEBazYCACABQQFGBEAgACgCACAAQQRqKAIAELMECwvjCAIHfwJ+IAAoAmwiAiACKAIAIgJBAWs2AgAgAkEBRgRAIAAoAmwiAkHoAWooAgAgAkHsAWooAgAQ0wcgAkGIAWoQuQMgAkHAAWooAgAgAkHMAWooAgAQ3QcgAkGcAWooAgAgAkGgAWooAgAQhgggAkHYAWoiASgCACACQdwBaiIEKAIAKAIAEQEAIAQoAgAoAgQEQCABKAIAEH4LIAJBgAJqKAIAIgEgASgCACIBQQFrNgIAIAFBAUYEQCACKAKAAiIBQcgAaiIEKAIAIAFBzABqKAIAEHogAUHEAGooAgAgBCgCABDeByABQSBqEHMCQCABQX9GDQAgASABKAIEIgRBAWs2AgQgBEEBRw0AIAEQfgsLIAJBIGooAgAiAQRAIAJBKGooAgAiBAR/IAJBLGooAgAiAUEIaiEFIAEpAwBCf4VCgIGChIiQoMCAf4MhCANAIAQEQANAIAhQBEAgAUGAAWshASAFKQMAQn+FQoCBgoSIkKDAgH+DIQggBUEIaiEFDAELCyABIAh6p0EDdkEEdGsiBkEIayIDKAIAIgcgBygCACIHQQFrNgIAIAdBAUYEQCADKAIAIgNBDGoiBygCAEEDRwRAIAcQiAILAkAgA0F/Rg0AIAMgAygCBCIHQQFrNgIEIAdBAUcNACADEH4LCyAEQQFrIQQgCEIBfSAIgyEIIAZBBGsiAygCACIGIAYoAgAiBkEBazYCACAGQQFHDQEgAygCACIDQQxqEMcBAkAgA0F/Rg0AIAMgAygCBCIGQQFrNgIEIAZBAUcNACADEH4LDAELCyACKAIgBSABCyACQSxqKAIAQRBBCBDoBQsgAkFAaygCACIBBEAgAkHIAGooAgAiBAR/IAJBzABqKAIAIgFBCGohBSABKQMAQn+FQoCBgoSIkKDAgH+DIQgDQCAEBEADQCAIUARAIAFB4ABrIQEgBSkDAEJ/hUKAgYKEiJCgwIB/gyEIIAVBCGohBQwBCwsgASAIeqdBA3ZBdGxqIgNBCGsiBigCACADQQRrIgMoAgAoAgARAQAgBEEBayEEIAhCAX0gCIMhCCADKAIAKAIERQ0BIAYoAgAQfgwBCwsgAigCQAUgAQsgAkHMAGooAgBBDEEIEOgFCyACQeAAaigCACIBBEAgAkHoAGooAgAiBAR/IAJB7ABqKAIAIgFBCGohBSABKQMAQn+FQoCBgoSIkKDAgH+DIQkDQCAEBEAgCSEIA0AgCFAEQCABQaABayEBIAUpAwBCf4VCgIGChIiQoMCAf4MhCCAFQQhqIQUMAQsLIARBAWshBCAIQgF9IAiDIQkgASAIeqdBA3ZBbGxqIgNBFGsoAgBFDQEgA0EQaygCACADQQxrKAIAEIYIDAELCyACKAJgBSABCyACQewAaigCAEEUQQgQ6AULIAJBhAJqEJgHIAJBkAJqEJgHAkAgAkF/Rg0AIAIgAigCBCIBQQFrNgIEIAFBAUcNACACEH4LCyAAQeAAahDCBgspACABQRRsIQEDQCABBEAgACgCEBCLCCABQRRrIQEgAEEUaiEADAELCwsqAQF/A0AgACABRwRAIAIgAUEIaigCAGpBAWohAiABQQxqIQEMAQsLIAILKwECfyMAQRBrIgEkACABIAA3AwggAUEIahCNAyECIAFBEGokACACQf8BcQsoACACIANJBEAgAyACIAQQyQgACyAAIAIgA2s2AgQgACABIANqNgIACyoAIAAoAgBFBEAgAEEEaiABEJ4IDwsgASAAQQhqKAIAIABBDGooAgAQVwsnAQF/IAEgAmogA6dBGXYiBDoAACACQQhrIABxIAFqQQhqIAQ6AAALKgACQCAAKAIABEAgACgCBEUNAQsgAEEIaigCACIAIAAoAgBBAWs2AgALCy0AIwBBEGsiASQAIAFBCGpBAUH3/MAAQRcQiwUgACABKQMINwIAIAFBEGokAAstACMAQRBrIgEkACABQQhqQQFBjv3AAEEUEIsFIAAgASkDCDcCACABQRBqJAALLQAjAEEQayIBJAAgAUEIakEBQc79wABBGRCLBSAAIAEpAwg3AgAgAUEQaiQACy0AIwBBEGsiASQAIAFBCGpBAUHO/cAAQRkQiwUgACABKQMINwIAIAFBEGokAAstACMAQRBrIgEkACABQQhqQQFBkv7AAEEZEIsFIAAgASkDCDcCACABQRBqJAALLQAjAEEQayIBJAAgAUEIakEBQZL+wABBGRCLBSAAIAEpAwg3AgAgAUEQaiQACy4BAX8jAEFAaiIDJAAgASAAIAMgAkHAABCSCSIBQcAAEKADIQIgAUFAayQAIAILVgEEfyMAQRBrIgIkACACQQhqIgMgAUEMaigCACABQQhqKAIAIgQgASgCACIFGzYCBCADIAQgASgCBCAFGzYCACAAIAIoAgggAigCDBCbBCACQRBqJAALMQEBfyAAKAIAIgIoAgAgAigCBCAAKAIEKAIMIAFBBXRrQSBrIgAoAgQgACgCCBCbBwsmACABQQN0IQEDQCABBEAgAUEIayEBIAAQiAIgAEEIaiEADAELCwswAQJ/IAIgASACIAMQjAQiBGotAAAhBSABIAIgBCADEMkGIAAgBToABCAAIAQ2AgALKAAgACgCACgCACIAKQMAIABBCGopAwAgASgCDCACQVRsakEsaxC2AQsoACAAKAIAKAIAIgApAwAgAEEIaikDACABKAIMIAJBUGxqQTBrELYBCzABAX8CQCAAKAIAIgFFDQAgASAAKAIEKAIAEQEAIAAoAgQoAgRFDQAgACgCABB+CwsrAAJ/IANFBEAgASACEM8BDAELIAEgAhC6BgshAiAAIAE2AgQgACACNgIACygAIAFB/wFxBH9BAQUgACgCAEH1n8AAQQEgAEEEaigCACgCDBEEAAsLKwEBfyMAQRBrIgIkACACQgI3AwAgAkIANwMIIAAgASACEPwBIAJBEGokAAsyAAJAIAFB/wFxDQBBjJ3CACgCAEH/////B3FFDQAQmAkNACAAQQE6AAELIABBADoAAAssACABQdjmwQAQzwcaQQgQUCIARQRAAAsgACACNgIEIABBADYCACAAEKgIAAsqAQF/IAAgAhCkByAAKAIIIgMgACgCBGogASACEJIJGiAAIAIgA2o2AggLKAEBfwJAIABBf0YNACAAIAAoAgQiAUEBazYCBCABQQFHDQAgABB+Cws6AQJ/QcCcwgAtAAAhAUHAnMIAQQA6AABBxJzCACgCACECQcScwgBBADYCACAAIAI2AgQgACABNgIACzABAX9BGBDXByIBQoGAgIAQNwIAIAEgACkCADcCCCABQRBqIABBCGopAgA3AgAgAQsqAQF/IAAgAhD0AiAAKAIIIgMgACgCBGogASACEJIJGiAAIAIgA2o2AggLKAAgARCmByAAQQhqIAE2AgAgACABQQhqNgIEIAAgAS0ABEEARzYCAAsoAQF/IwBBMGsiBCQAIAAgASACIAQgA0EwEJIJIgAQ9AEgAEEwaiQACyQAIAIgAEEBayIATQRAIAAgAkHc2MEAEP8DAAsgASAAQRRsagsoAQF/IAAoAgAiAQRAIAEgAEEMaigCACAAKAIQIABBFGooAgAQ6AULCygAIAEoAgBFBEAgAUF/NgIAIAAgATYCBCAAIAFBBGo2AgAPCxD4CAALKAAgASgCAEUEQCABQX82AgAgACABNgIEIAAgAUEIajYCAA8LEPgIAAsoAQF/IAAoAgAiASABKAIAIgFBAWs2AgAgAUEBRgRAIAAoAgAQvQMLCygBAX8gACgCACIBIAEoAgAiAUEBazYCACABQQFGBEAgACgCABDfBgsLSwEBfyMAQRBrIgMkACADIAI2AgggAyABNgIEIAMgADYCACMAQRBrIgAkACAAQQhqIANBCGooAgA2AgAgACADKQIANwMAQQEQgQUACyEAIAAoAgAiAEEBcQRAIABBfnEgASACEJoHDwsgABDVBQsoAQF/IAAoAgAiASABKAIAIgFBAWs2AgAgAUEBRgRAIAAoAgAQlQULCyEAIAEEfyACEIsIQQAFQQELIQEgACACNgIEIAAgATYCAAsoAQF/IAAoAgAiASABKAIAIgFBAWs2AgAgAUEBRgRAIAAoAgAQ8QMLCyYBAX8jAEEQayIBJAAgASAAELEGNgIM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Qf////8HcQR/EJgJBUEBCwsbAQF/IABBBGooAgAiAQRAIAAoAgAgARCGCAsLHQAgACkDAFAEQEH3+MEAQStBpK7BABCRBQALIAALLAAgAEEBOgAUIABBgICACDYCECAAQqCGgICAywA3AgggAELQgICAkAM3AgALGgAgASACKAIAEQEAIAIoAgQEQCABEH4LQQALGwAgAC0AAEUEQCAAQQRqEIQIIABBDGoQhAgLCxoBAX8gACgCACEBIABBfzYCACABRQRADwsACxsBAX8gARAbIQIgACABNgIEIAAgAkEBRzYCAAsbACAAKAIAIAAoAgQgASgCACABQQRqKAIAEHQLGgAgABCzB0EBczoAASAAIAEtAABBAEc6AAALGAAgACABNgIEIABBAyABIAFBA08bNgIACxgAIAAoAgBBCGogASACIAMgBBBkQf8BcQsVAEEBQQIgABA6IgBBAUYbQQAgABsLHAAgAEEIaiAAKAIAIAAoAgQgACgCDCgCCBEDAAsaACAAKAIAIABBBGooAgAQhgggAEEMahC1BguGAwIFfwJ+IAEgACgCBEsEQCMAQdAAayIDJAAgAyACNgIIIABBCGooAgAhAiADIANBCGo2AgwCQAJAIAIgASACaiIBTQRAIAAoAgAiBCAEQQFqIgVBA3ZBB2wgBEEISRsiBEEBdiABSQRAIANBKGogAkEsIAEgBEEBaiICIAEgAksbEPsCIAMoAjQiAkUNAiADIAMpAzg3AyAgAyACNgIcIAMgAykCLDcCFCADIAMoAigiBjYCEEFUIQRBACEBA0AgASAFRgRAIAApAgAhCCAAIAMpAxA3AgAgA0EYaiIBKQMAIQkgASAAQQhqIgApAgA3AwAgACAJNwIAIAMgCDcDECADQRBqEOYGDAULIAAoAgwiByABaiwAAEEATgRAIAMgBiACIANBDGogACABENYGENUGIAIgAygCAEF/c0EsbGogBCAHakEsEJIJGgsgAUEBaiEBIARBLGshBAwACwALIAAgA0EMakH2AEEsEKABDAILEMgFAAsgAygCLBoLIANB0ABqJAALCxYAIAEgAEEEaigCACAAQQhqKAIAEFcLEwAgAEUgAUEjTXJFBEAgARAcCwsVACABQf8BcUECRwRAIAAgARDMBAsLGQAgASACIAMQ4gYgAEEEOgAAIAAgAzYCBAsSACAAIAEQzwEiAARAIAAPCwALFgEBf0GAAkHAABDPASIABEAgAA8LAAsZAAJAIAFB/wFxDQAQswcNACAAQQE6AAALCxgAIAAgASAAIAEgAhCMBCIAIAIQyQYgAAsZAQF/IAEQOyECIAAgATYCBCAAIAJFNgIACxQAIAEEQCAAIAEQhggPCyAAEIsICxEAIAAEQCABIABBGGwQpAgLCxEAIAAEQCABIABBDGwQpAgLCxcAIABFBEBB9/jBAEErIAEQkQUACyAACxMAIACtIAFBCGogAhC4BkH/AXELEwAgAK0gAUEIaiACELcGQf8BcQsYAQF/IAEQUCECIAAgATYCBCAAIAI2AgALEQAgAARAIAEgAEECdBCkCAsLEQAgAAR/IAAgARDPAQUgAQsLEwAgACgCACIAQSRPBEAgABAcCwsZACAAKAIAIgAoAgAgASAAKAIEKAIQEQIACw8AIAAQUCIABEAgAA8LAAsRAQF/QQQQUCIABEAgAA8LAAsRAQF/QQwQUCIABEAgAA8LAAsRACAABEAgASAAQQF0EKQICwsRACAABEAgASAAQQN0EKQICwsRACAABEAgASAAQShsEKQICwsSACAABEAgACABQThBCBDoBQsLEgAgAARAIAEgAEGQAmwQpAgLCxEAIAAEQCABIABBMGwQpAgLCxIAIAAoAggEQCAAQQhqEPgGCwsZACAAp0UEQEH3+MEAQStBqL/BABCRBQALCxkAIAAoAgAiACgCACABIAAoAgQoAgwRAgALEQAgAARAIAEgAEE4bBCkCAsLEQAgAARAIAEgAEEUbBCkCAsLEQAgAARAIAEgAEEFdBCkCAsLFQAgACgCAEEIaiABIAIQjAFB/wFxCxUAIAAoAgBBCGogASACEIIBQf8BcQsVACAAKAIAQQhqIAEgAhCsAUH/AXELGQEBf0EIENcHIgEgADYCBCABQQA2AgAgAQsZACAAIAI2AgggACABKAIAKAIAKQMANwMACxoAIABFBEBB9/jBAEErQezYwQAQkQUACyAACxIAIAAoAgAEQCAAQQRqEPoFCwsWACAAp0UEQEH3+MEAQSsgARCRBQALCw4AIADAQcKXwgBqLQAACxkAIAEoAgBB3J3AAEEOIAEoAgQoAgwRBAALGQAgASgCAEHYtsAAQQUgASgCBCgCDBEEAAsZACABKAIAQcy9wABBCyABKAIEKAIMEQQACxkAIAEoAgBBzMnAAEEIIAEoAgQoAgwRBAALFQAgASAAKAIAIgAoAgQgACgCCBBXCxkAIAEoAgBB4OjAAEEVIAEoAgQoAgwRBAALEgAgAC0AAEEERwRAIAAQ7AULC18BBX8gAEGolcIANgIEIABBqJXCADYCACAAKAIMIgEEQCAAKAIIIgQgACgCECICKAIIIgNHBEAgAigCBCIFIANqIAQgBWogARCUCRogACgCDCEBCyACIAEgA2o2AggLCxkAIAEoAgBBrIbBAEEcIAEoAgQoAgwRBAALFAAgACgCBCIAIAAoAgBBAWs2AgALOwEBfyAAQQFqIQICQCABQf8BcQ0AQYydwgAoAgBB/////wdxRQ0AEJgJDQAgAkEBOgAACyAAQQA6AAALDgAgAMBBrJfCAGotAAALEgAgACgCAEEDRwRAIAAQyQELCxEAIAAoAgBBA0cEQCAAEHALCxIAIAAoAgBBA0cEQCAAEIcCCwsTACAAIAAoAhAiAEEBajYCECAACxMAIABBAWogARDJByAAQQA6AAALEgAgAEEEahC9CCAAQRxqEL0ICxMAIAAgASgCAEEIaiACIAMQiAELEwAgACABKAIAQQhqIAIgAxC9AgsSACAAKAIABEAgACgCBBCLCAsLEQAgACgCBARAIAAoAgAQfgsLFgAgACACNgIIIAAgASgCACkDADcDAAsOACAABEAgASAAEKQICwuyAQEBfyAAQQRqIAEQyQcjAEEgayIBJAAgACgCACECIABBADYCACABIAI2AgQCQCACQX9GBEAgAUEgaiQADAELIAFBADYCECMAQSBrIgAkACAAQci2wQA2AgQgACABQQRqNgIAIABBGGogAUEIaiIBQRBqKQIANwMAIABBEGogAUEIaikCADcDACAAIAEpAgA3AwggAEGk1MAAIABBBGpBpNTAACAAQQhqQbS3wQAQ0gEACwsRAEGV+vAAIABB/wFxQQN0dgsUACAAKAIAIAEgACgCBCgCDBECAAvMCAEDfyMAQfAAayIFJAAgBSADNgIMIAUgAjYCCAJAAkACQAJAIAUCfwJAAkAgAUGBAk8EQANAIAAgBmohByAGQQFrIQYgB0GAAmosAABBv39MDQALIAZBgQJqIgcgAUkNAiABQYECayAGRw0EIAUgBzYCFAwBCyAFIAE2AhQLIAUg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jMEANgIEIAAgATYCAAsTACAAQdiMwQA2AgQgACABNgIACxMAIABByIzBADYCBCAAIAE2AgALEAAgACgCCCABIAIQ4gZBAAsPACAAEJYEIABBDGoQlgQLEQAgACgCABCACCAAKAIAEH4LDwAgACABKAIAQQhqEJ8FCxMAIABB1MnBADYCBCAAIAE2AgALEwAgAEHkycEANgIEIAAgATYCAAsVACAAQZDzwQBBAkGE88EAQQEQ1AULFQAgAEGV88EAQQNBhPPBAEEBENQFCxUAIABBhPPBAEEBQYTzwQBBARDUBQsLACAABEAgABB+CwsTACAAQSg2AgQgAEGA/cEANgIACwsAIAEEQCAAEH4LCw4AIAEQuQcgACABEIQFC3cBAX8jAEEwayIDJAAgAyABNgIEIAMgADYCACADQRRqQQI2AgAgA0EcakECNgIAIANBLGpBATYCACADQayjwAA2AhAgA0EANgIIIANBATYCJCADIANBIGo2AhggAyADQQRqNgIoIAMgAzYCICADQQhqIAIQgQYACw4AIAA1AgBBASABEO0BCw4AIAAxAABBASABEO0BCw4AIAAoAgAaA0AMAAsAC3cBAX8jAEEwayIDJAAgAyABNgIEIAMgADYCACADQRRqQQI2AgAgA0EcakECNgIAIANBLGpBATYCACADQcyjwAA2AhAgA0EANgIIIANBATYCJCADIANBIGo2AhggAyADQQRqNgIoIAMgAzYCICADQQhqIAIQgQYAC3cBAX8jAEEwayIDJAAgAyABNgIEIAMgADYCACADQRRqQQI2AgAgA0EcakECNgIAIANBLGpBATYCACADQYCkwAA2AhAgA0EANgIIIANBATYCJCADIANBIGo2AhggAyADQQRqNgIoIAMgAzYCICADQQhqIAIQgQYAC2wBAX8jAEEQayIDJAAgAyABNgIMIAMgADYCCCMAQSBrIgAkACAAQQxqQQE2AgAgAEEUakEBNgIAIABByOHAADYCCCAAQQA2AgAgAEEDNgIcIAAgA0EIajYCGCAAIABBGGo2AhAgACACEIEGAAsOACAAKAIAIAEgAhCUAQsPACAAKAIALQAAIAEQnAcLCwAgACABEClBAEcLDQAgACABIAIgAxDUBAsSAEG1+MEAQQ9BvPzAABCRBQALEgBBtfjBAEEPQaT9wAAQkQUACxIAQbX4wQBBD0Ho/cAAEJEFAAsNACAAIAEgAiADEMYHCw4AIAAoAgAgASACEIIECw8AIAAoAgAgACgCDBDaBwsPACAAKAIAIAAoAgwQ3AcLDQAgACAAIAAgABDQBgsNACAAIAAgACAAEM4GCw0AIAAgASACIAMQnwMLDQAgACAAIAAgABDLBgsNACAAIAEgAiADENsECw4AIAAoAgAgACAAEKMFCw4AIAAoAgAgASACELwICw0AIAAgASACIAMQvQILDQADQCAALQAMRQ0ACwsPACAAKAIAKAIAIAEQ9QELDQADQCAALQAYRQ0ACwsOACABEKQEIAAgARCOBQsPACAAKAIAIAAoAgwQ3wcLDQAgACABIAIgAxCbBwsOACAAKAIAIAEgAhCZBQsNACAAIAEgAiADEOEECwsAIAAjAGokACMACwsAIABBASABEO0BCw0AIAFB3L3BAEECEFcLCQAgABALQQFGCwkAIAAQFEEARwsKACAAIAEgAhAaCwwAIAAoAgAgARCoAwsJACAAEB1BAEcLCQAgABAeQQBHCwkAIAAQIEEARwsJACAAIAEQJQALDAAgACgCACABEMoICw0AQcTUwABBGxD1CAALDgBB39TAAEHPABD1CAALDAAgACgCACABEMgGCwoAIAAQugMaQQELCQAgABAuQQBHCwsAIAAgASADEIMDCwwAIAAoAgAgARDwBQsLACAAIAIgAxCkAwsLACAAIAIgAxClAwsLACAAIAAgABCkBgsLACAAIAAgABCiBgsLACAAIAAgABClBgsJACAAIAIQ3ggLCwAgACAAIAAQowULDAAgACgCACABEIQJCwwAIAAoAgAgARDyBQsKACAAQRBqEPkBCwwAIAAgASkCADcDAAsMACAAIAEpAgg3AwALDAAgAC0AACABEJwHCwkAIAAQEkEBRgsMACAAKAIAIAEQlgILCwAgACABIAIQ5wILCwAgACABIAIQuwELCwAgACABIAMQ5gILCwAgACAAIAAQpwYLrwEBA38gASEFAkAgAkEPTQRAIAAhAQwBCyAAQQAgAGtBA3EiA2ohBCADBEAgACEBA0AgASAFOgAAIAFBAWoiASAESQ0ACwsgBCACIANrIgJBfHEiA2ohASADQQBKBEAgBUH/AXFBgYKECGwhAwNAIAQgAzYCACAEQQRqIgQgAUkNAAsLIAJBA3EhAgsgAgRAIAEgAmohAgNAIAEgBToAACABQQFqIgEgAkkNAAsLIAALswIBB38CQCACIgRBD00EQCAAIQIMAQsgAEEAIABrQQNxIgNqIQUgAwRAIAAhAiABIQYDQCACIAYtAAA6AAAgBkEBaiEGIAJBAWoiAiAFSQ0ACwsgBSAEIANrIghBfHEiB2ohAgJAIAEgA2oiA0EDcSIEBEAgB0EATA0BIANBfHEiBkEEaiEBQQAgBEEDdCIJa0EYcSEEIAYoAgAhBgNAIAUgBiAJdiABKAIAIgYgBHRyNgIAIAFBBGohASAFQQRqIgUgAkkNAAsMAQsgB0EATA0AIAMhAQNAIAUgASgCADYCACABQQRqIQEgBUEEaiIFIAJJDQALCyAIQQNxIQQgAyAHaiEBCyAEBEAgAiAEaiEDA0AgAiABLQAAOgAAIAFBAWohASACQQFqIgIgA0kNAAsLIAALQwEDfwJAIAJFDQADQCAALQAAIgMgAS0AACIERgRAIABBAWohACABQQFqIQEgAkEBayICDQEMAgsLIAMgBGshBQsgBQuWBQEIfwJAAkACfwJAIAIiBCAAIAFrSwRAIAEgBGohBiAAIARqIQIgBEEPSw0BIAAMAgsgBEEPTQRAIAAhAgwDCyAAQQAgAGtBA3EiBmohBSAGBEAgACECIAEhAwNAIAIgAy0AADoAACADQQFqIQMgAkEBaiICIAVJDQALCyAFIAQgBmsiBEF8cSIHaiECAkAgASAGaiIGQQNxIgMEQCAHQQBMDQEgBkF8cSIIQQRqIQFBACADQQN0IglrQRhxIQogCCgCACEDA0AgBSADIAl2IAEoAgAiAyAKdHI2AgAgAUEEaiEBIAVBBGoiBSACSQ0ACwwBCyAHQQBMDQAgBiEBA0AgBSABKAIANgIAIAFBBGohASAFQQRqIgUgAkkNAAsLIARBA3EhBCAGIAdqIQEMAgsgAkF8cSEDQQAgAkEDcSIHayEIIAcEQCABIARqQQFrIQUDQCACQQFrIgIgBS0AADoAACAFQQFrIQUgAiADSw0ACwsgAyAEIAdrIgdBfHEiBGshAkEAIARrIQQCQCAGIAhqIgZBA3EiBQRAIARBAE4NASAGQXxxIghBBGshAUEAIAVBA3QiCWtBGHEhCiAIKAIAIQUDQCADQQRrIgMgBSAKdCABKAIAIgUgCXZyNgIAIAFBBGshASACIANJDQALDAELIARBAE4NACABIAdqQQRrIQEDQCADQQRrIgMgASgCADYCACABQQRrIQEgAiADSQ0ACwsgB0EDcSIBRQ0CIAQgBmohBiACIAFrCyEDIAZBAWshAQNAIAJBAWsiAiABLQAAOgAAIAFBAWshASACIANLDQALDAELIARFDQAgAiAEaiEDA0AgAiABLQAAOgAAIAFBAWohASACQQFqIgIgA0kNAAsLIAALCQAgACABEIcICwcAIABBfnELCgAgACgCABDVBQsLAEG8nMIAKAIARQsJACAAIAEQ3gULDwBBuJjCABDKBCgCABAACwkAIABBADYCAAsKACAAQYEoOwAACwkAIABBBDoAAAsJACAAQQE7AQALCQAgAEECNgIACw8AQciYwgAQygQoAgAQAAt5AQF+An9B6JzCACkDACIBQgBSBEBBAEHwnMIAIAFQGwwBC0H4nMIAAn4CQCAARQ0AIAApAwAhASAAQgA3AwAgAUIBUg0AIAApAwghASAAKQMQDAELQgEhAUICCzcDAEHwnMIAIAE3AwBB6JzCAEIBNwMAQfCcwgALC1sBAX8Cf0GAncIALQAAIgEEQEGBncIAQQAgARsMAQtBgZ3CACAABH8gAC0AACEBIABBADoAACAALQABQQAgAUEBcWtxBUEACzoAAEGAncIAQQE6AABBgZ3CAAsLBwAgABD1BwsEACAACw0AQvzOo+XczZib5gALDQBCxZ/g9bqY1vDaAAsMAEKxzs2E6fba1SkLBABBEgsEAEEUCwQAQRQLBABBFAsEAEEUCwQAQRQLDQBCzLGl3dTr+vGifwsNAELhutTy5Jfqlah/CwwAQsDE7qfmhabrDgsEAEEACwwAQqmMr6S11eWPVgsEAEIACwQAQRkLDQBCxuXsxvut5rKnfwvMAQEDfwJ/IwBBEGsiASQAAkACQAJ/QeCcwgAoAgAiAARAQeScwgBBACAAGwwBCxAoIQBB4JzCACgCACECQeCcwgBBATYCACACQeScwgAoAgAhAkHknMIAIAA2AgAgAhDEB0HknMIACyIABEAgASAAKAIAQSEQugUgASgCAA0BIAEoAgQiABAnQQFHDQIgAUEQaiQAIAAMAwtB+KrBAEHGACABQQhqQcjVwABBoKzBABDpAwALQdjVwABBJBD1CAALQfzVwABBPBD1CAALCw0A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MjMvanMtc3lzLTAuMy42MC9zcmMvbGliLnJzcmV0dXJuIHRoaXNQHxAAWQAAAMMWAAABAAAAeAAAAAQAAAAEAAAAkwAAAHgAAAAAAAAAAQAAAJIAAABjbG9zdXJlIGludm9rZWQgcmVjdXJzaXZlbHkgb3IgZGVzdHJveWVkIGFscmVhZHl4AAAABAAAAAQAAACTAAAAAQAAAC9ob21lL2NvbnN1bHRpbmcvLmNhcmdvL3JlZ2lzdHJ5L3NyYy9naXRodWIuY29tLTFlY2M2Mjk5ZGI5ZWM4MjMvb25jZV9jZWxsLTEuMTYuMC9zcmMvaW1wX3N0ZC5ycyggEABgAAAApQAAAAkAAAAoIBAAYAAAAKsAAAA2AAAAfgAAAAAAAAABAAAAlAAAAH4AAAAEAAAABAAAAJUAAAB+AAAABAAAAAQAAACWAAAAQWNjZXNzRXJyb3JsaWJyYXJ5L3N0ZC9zcmMvdGhyZWFkL21vZC5yc2ZhaWxlZCB0byBnZW5lcmF0ZSB1bmlxdWUgdGhyZWFkIElEOiBiaXRzcGFjZSBleGhhdXN0ZWQAACEQADcAAADjIBAAHQAAAFUEAAANAAAAdW5jYXRlZ29yaXplZCBlcnJvcm90aGVyIGVycm9yb3V0IG9mIG1lbW9yeXVuZXhwZWN0ZWQgZW5kIG9mIGZpbGV1bnN1cHBvcnRlZGFyZ3VtZW50IGxpc3QgdG9vIGxvbmdpbnZhbGlkIGZpbGVuYW1ldG9vIG1hbnkgbGlua3Njcm9zcy1kZXZpY2UgbGluayBvciByZW5hbWVkZWFkbG9ja2V4ZWN1dGFibGUgZmlsZSBidXN5cmVzb3VyY2UgYnVzeWZpbGUgdG9vIGxhcmdlZmlsZXN5c3RlbSBxdW90YSBleGNlZWRlZHNlZWsgb24gdW5zZWVrYWJsZSBmaWxlbm8gc3RvcmFnZSBzcGFjZXdyaXRlIHplcm90aW1lZCBvdXRpbnZhbGlkIGRhdGFpbnZhbGlkIGlucHV0IHBhcmFtZXRlcnN0YWxlIG5ldHdvcmsgZmlsZSBoYW5kbGVmaWxlc3lzdGVtIGxvb3Agb3IgaW5kaXJlY3Rpb24gbGltaXQgKGUuZy4gc3ltbGluayBsb29wKXJlYWQtb25seSBmaWxlc3lzdGVtIG9yIHN0b3JhZ2UgbWVkaXVtaXMgYSBkaXJlY3Rvcnlub3QgYSBkaXJlY3RvcnlvcGVyYXRpb24gd291bGQgYmxvY2tlbnRpdHkgYWxyZWFkeSBleGlzdHNicm9rZW4gcGlwZW5ldHdvcmsgZG93bmFkZHJlc3Mgbm90IGF2YWlsYWJsZWFkZHJlc3MgaW4gdXNlbm90IGNvbm5lY3RlZG5ldHdvcmsgdW5yZWFjaGFibGVob3N0IHVucmVhY2hhYmxlIChvcyBlcnJvciAAqIoQAAAAAADAIxAACwAAAJ+HEAABAAAAW2xpYnJhcnkvc3RkL3NyYy9wYXRoLnJz5SMQABcAAADYAgAAGAAAAOUjEAAXAAAA/QIAACMAAADlIxAAFwAAAP8CAAAdAAAA5SMQABcAAAALAwAAHgAAAOUjEAAXAAAAFwMAAB4AAADlIxAAFwAAAJ0DAAAiAAAA5SMQABcAAACPAwAAJgAAAOUjEAAXAAAAlwMAACYAAADlIxAAFwAAAIEDAAAgAAAA5SMQABcAAACCAwAAIgAAAOUjEAAXAAAAswMAACIAAADlIxAAFwAAAL4DAAAmAAAA5SMQABcAAADFAwAAJgAAADxsb2NrZWQ+bGlicmFyeS9zdGQvc3JjL3N5c19jb21tb24vdGhyZWFkX2luZm8ucnMAAADUJBAAKQAAABYAAAAzAAAAbGlicmFyeS9zdGQvc3JjL3Bhbmlja2luZy5ycxAlEAAcAAAAPgIAAA8AAABvcGVyYXRpb24gc3VjY2Vzc2Z1bHRpbWUgbm90IGltcGxlbWVudGVkIG9uIHRoaXMgcGxhdGZvcm0AAABQJRAAJQAAAGxpYnJhcnkvc3RkL3NyYy9zeXMvd2FzbS8uLi91bnN1cHBvcnRlZC90aW1lLnJzAIAlEAAvAAAADQAAAAkAAACAJRAALwAAAB8AAAAJAAAAb3BlcmF0aW9uIG5vdCBzdXBwb3J0ZWQgb24gdGhpcyBwbGF0Zm9ybdAlEAAoAAAAJAAAAGNvbmR2YXIgd2FpdCBub3Qgc3VwcG9ydGVkAAAEJhAAGgAAAGxpYnJhcnkvc3RkL3NyYy9zeXMvd2FzbS8uLi91bnN1cHBvcnRlZC9sb2Nrcy9jb25kdmFyLnJzKCYQADgAAAAUAAAACQAAAGxpYnJhcnkvc3RkL3NyYy9zeXMvd2FzbS8uLi91bnN1cHBvcnRlZC9sb2Nrcy9tdXRleC5ycwAAcCYQADYAAAAUAAAACQAAAGNhbid0IHNsZWVwALgmEAALAAAAbGlicmFyeS9zdGQvc3JjL3N5cy93YXNtLy4uL3Vuc3VwcG9ydGVkL3RocmVhZC5ycwAAAMwmEAAxAAAAGgAAAAkAAAACAAAAlwAAAAgAAAAEAAAAmAAAAGxpYnJhcnkvc3RkL3NyYy9zeXNfY29tbW9uL3RocmVhZF9wYXJrZXIvZ2VuZXJpYy5ycwAkJxAAMwAAACcAAAAVAAAAaW5jb25zaXN0ZW50IHBhcmsgc3RhdGUAaCcQABcAAAAkJxAAMwAAADUAAAAXAAAAcGFyayBzdGF0ZSBjaGFuZ2VkIHVuZXhwZWN0ZWRseQCYJxAAHwAAACQnEAAzAAAAMgAAABEAAABpbmNvbnNpc3RlbnQgc3RhdGUgaW4gdW5wYXJr0CcQABwAAAAkJxAAMwAAAGwAAAASAAAAJCcQADMAAAB6AAAADgAAAA4AAAAQAAAAFgAAABUAAAALAAAAFgAAAA0AAAALAAAAEwAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABEAAAASAAAAEAAAABAAAAATAAAAEgAAAA0AAAAOAAAAFQAAAAwAAAALAAAAFQAAABUAAAAPAAAADgAAABMAAAAmAAAAOAAAABkAAAAXAAAADAAAAAkAAAAKAAAAEAAAABcAAAAZAAAADgAAAA0AAAAUAAAACAAAABsAAADCIRAAsiEQAJwhEAAcOxAAkSEQAHshEABuIRAAYyEQAFAhEACsOhAArDoQAKw6EACsOhAArDoQAKw6EACsOhAArDoQAKw6EACsOhAArDoQAKw6EACsOhAArDoQAKw6EACsOhAArDoQAKw6EACsOhAArDoQAKw6EACsOhAArDoQAKw6EAB0OhAAVDsQADw7EACwIxAAnSMQAHA7EACQIxAAgiMQAG0jEABhIxAAViMQAEEjEAAsIxAAHSMQAA8jEADwORAA6SIQALEiEACYIhAAgSIQAHUiEABsIhAAYiIQAFIiEAA7IhAAIiIQABQiEAAHIhAA8yEQAOshEADQIRAAYWxyZWFkeSBib3Jyb3dlZHgAAAAEAAAABAAAAJkAAAB4AAAABAAAAAQAAACaAAAAbnVsbCBwb2ludGVyIHBhc3NlZCB0byBydXN0cmVjdXJzaXZlIHVzZSBvZiBhbiBvYmplY3QgZGV0ZWN0ZWQgd2hpY2ggd291bGQgbGVhZCB0byB1bnNhZmUgYWxpYXNpbmcgaW4gcnVzdEpzVmFsdWUoAACuKhAACAAAAJ+HEAABAAAAeAAAAAAAAAABAAAAkgAAAFVuYWJsZSB0byBjYWxsIHRoZSBTeW1ib2woKSBmdW5jdGlvblVuYWJsZSB0byBjb252ZXJ0IHRoZSByZXR1cm4gdmFsdWUgb2YgU3ltYm9sKCkgaW50byBhIHN5bWJvbFJlc291cmNleAAAAAQAAAAEAAAAIAAAAFdhc214AAAABAAAAAQAAACbAAAASW5zdWZmaWNpZW50IHJlc291cmNlczogZCsQABgAAABUeXBlTWlzbWF0Y2h4AAAABAAAAAQAAACcAAAAVW5zdXBwb3J0ZWRJbnZhbGlkV2ViQXNzZW1ibHkAAAB4AAAABAAAAAQAAACTAAAAIGRvZXNuJ3QgbWF0Y2gganMgdmFsdWUgdHlwZSAAAACoihAAAAAAANArEAAdAAAAVW5zdXBwb3J0ZWQgZmVhdHVyZTogAAAAACwQABUAAABJbnZhbGlkIGlucHV0IFdlYkFzc2VtYmx5IGNvZGUgYXQgb2Zmc2V0IAAAACAsEAApAAAAqG0QAAIAAABJbXBvcnQAAHgAAAAEAAAABAAAAJ0AAABFcnJvciB3aGlsZSBpbXBvcnRpbmcgAAB0LBAAFgAAAB5lEAABAAAAqG0QAAIAAABOb3RJbkV4cG9ydHNEaWZmZXJlbnRTdG9yZXNDcHVGZWF0dXJlU3RhcnQAAHgAAAAEAAAABAAAAJ4AAABMaW5reAAAAAQAAAAEAAAAnwAAAENhbid0IGdldCAgZnJvbSB0aGUgaW5zdGFuY2UgZXhwb3J0c/QsEAAKAAAA/iwQABoAAABjYW5ub3QgbWl4IGltcG9ydHMgZnJvbSBkaWZmZXJlbnQgc3RvcmVzKC0QACgAAABtaXNzaW5nIHJlcXVpcmVkIENQVSBmZWF0dXJlczogAFgtEAAfAAAAL2hvbWUvY29uc3VsdGluZy8uY2FyZ28vcmVnaXN0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dCBiZSBmb3VuZAAArDsQABoAAABhZGRyZXNzIGlzIGluIHVzZQAAANA7EAARAAAAaW8gZXJyb3LsOxAACAAAAGxvY2sgZXJyb3IAAPw7EAAKAAAAZmlsZSBleGlzdHMAEDwQAAsAAABpbnZhbGlkIGZkAAAkPBAACgAAAGZkIG5vdCBhIGZpbGUAAAA4PBAADQAAAGZkIG5vdCBhIGRpcmVjdG9yeQAAUDwQABIAAABVbmtub3duRXJyb3JEaXJlY3RvcnlOb3RFbXB0eVdyaXRlWmVyb1dvdWxkQmxvY2tVbmV4cGVjdGVkRW9mVGltZWRPdXRQZXJtaXNzaW9uRGVuaWVkTm9EZXZpY2VFbnRpdHlOb3RGb3VuZE5vdENvbm5lY3RlZEludmFsaWRJbnB1dEludmFsaWREYXRhSW50ZXJydXB0ZWRDb25uZWN0aW9uUmVzZXRDb25uZWN0aW9uUmVmdXNlZENvbm5lY3Rpb25BYm9ydGVkQnJva2VuUGlwZUFkZHJlc3NOb3RBdmFpbGFibGVBZGRyZXNzSW5Vc2VJT0Vycm9yTG9ja0FscmVhZHlFeGlzdHNJbnZhbGlkRmROb3RBRmlsZUJhc2VOb3REaXJlY3RvcnkrPxAASwAAACABAAAbAAAAKz8QAEsAAAAoAQAAEQAAACs/EABLAAAAJgEAABYAAAArPxAASwAAAPIAAAANAAAAL2hvbWUvY29uc3VsdGluZy8uY2FyZ28vZ2l0L2NoZWNrb3V0cy93YXNtZXItZjExZjMwZTYyNzM5YWEyOS9lY2RlMmFhL2xpYi92ZnMvc3JjL21lbV9mcy9zdGRpby5ycwAAANg9EABhAAAAtQAAAAEAAABTdGRpbmJ1ZngAAAAEAAAABAAAAMAAAABjYW5ub3Qgc2VlayBgU3RkaW5gY2Fubm90IHdyaXRlIHRvIGBTdGRpbmBjYW5ub3QgZmx1c2ggYFN0ZGluYAAA2D0QAGEAAAC5AAAAAQAAAFN0ZG91dGNhbm5vdCBzZWVrIGBTdGRvdXRgY2Fubm90IHJlYWQgZnJvbSBgU3Rkb3V0YADYPRAAYQAAAL0AAAABAAAAU3RkZXJyY2Fubm90IHNlZWsgYFN0ZGVycmBjYW5ub3QgcmVhZCBmcm9tIGBTdGRlcnJgL3J1c3RjLzI1ODViY2VhMGJjMmE5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AAAAAAEAAABmAQAAoAAAAAQAAAAEAAAAoQAAAHgAAAAEAAAABAAAAGcBAABIYxAAZAAAAC8AAAAOAAAAYnl0ZUxlbmd0aC9ob21lL2NvbnN1bHRpbmcvLmNhcmdvL2dpdC9jaGVja291dHMvd2FzbWVyLWYxMWYzMGU2MjczOWFhMjkvZWNkZTJhYS9saWIvYXBpL3NyYy9qcy9leHRlcm5hbHMvbWVtb3J5X3ZpZXcucnMAKl8QAG0AAAAlAAAADgAAACpfEABtAAAAJwAAAA4AAAB4AAAABAAAAAQAAABoAQAAZmlsZXR5cGVzcmMvZnMucnNhY2Nlc3NlZGNyZWF0ZWRtb2RpZmllZGZpbGVzeW1saW5rcGF0aG1ldGFkYXRhANBfEAAJAAAANgAAADgAAABNZW1GU2lubmVyAAB4AAAABAAAAAQAAABpAQAARXJyb3Igd2hlbiByZWFkaW5nIHRoZSBkaXI6IDRgEAAcAAAA6XAQAAEAAABFcnJvciB3aGVuIGNyZWF0aW5nIHRoZSBkaXI6IAAAAGBgEAAdAAAA6XAQAAEAAABFcnJvciB3aGVuIHJlbW92aW5nIHRoZSBkaXI6IAAAAJBgEAAdAAAA6XAQAAEAAABFcnJvciB3aGVuIHJlbW92aW5nIHRoZSBmaWxlOiAAAMBgEAAeAAAA6XAQAAEAAABFcnJvciB3aGVuIHJlbmFtaW5nOiAAAADwYBAAFQAAAOlwEAABAAAAcmVhZHdyaXRlYXBwZW5kdHJ1bmNhdGVjcmVhdGVjcmVhdGVfbmV3RXJyb3Igd2hlbiBvcGVuaW5nIHRoZSBmaWxlOiA/YRAAHQAAAOlwEAABAAAARXJyb3Igd2hlbiBzZXR0aW5nIHRoZSBmaWxlIGxlbmd0aDogbGEQACQAAADpcBAAAQAAAEVycm9yIHdoZW4gcmVhZGluZzogoGEQABQAAADpcBAAAQAAAENvdWxkIG5vdCBjb252ZXJ0IHRoZSBieXRlcyB0byBhIFN0cmluZzogAAAAxGEQACkAAADpcBAAAQAAAEVycm9yIHdoZW4gd3JpdGluZzogAGIQABQAAADpcBAAAQAAAEVycm9yIHdoZW4gd3JpdGluZyBzdHJpbmc6IAAkYhAAGwAAAOlwEAABAAAARXJyb3Igd2hlbiBmbHVzaGluZzogAAAA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bWJseS5JbnN0YW5jZWAgbWFudWFsbHkACGUQAAsAAAD4AAAADgAAAF9zdGFydEVycm9yIHdoaWxlIHJ1bm5pbmcgc3RhcnQgZnVuY3Rpb246IAAAnmkQACQAAABVbmV4cGVjdGVkIFdBU0kgZXJyb3Igd2hpbGUgcnVubmluZyBzdGFydCBmdW5jdGlvbjogzGkQADQAAABUaGUgX3N0YXJ0IGZ1bmN0aW9uIGlzIG5vdCBwcmVzZW50Q291bGQgbm90IGdldCB0aGUgc3Rkb3V0IGJ5dGVzOiAAACpqEAAgAAAA6XAQAAEAAABDb3VsZCBub3QgY29udmVydCB0aGUgc3Rkb3V0IGJ5dGVzIHRvIGEgU3RyaW5nOiBcahAAMAAAAOlwEAABAAAAQ291bGQgbm90IGdldCB0aGUgc3RkZXJyIGJ5dGVzOiCcahAAIAAAAOlwEAABAAAAQ291bGQgbm90IGNvbnZlcnQgdGhlIHN0ZGVyciBieXRlcyB0byBhIFN0cmluZzogzGoQADAAAADpcBAAAQAAAEVycm9yIHdyaXRpbmcgc3RkaW46IAAAAAxrEAAVAAAA6XAQAAEAAACgAQAACAAAAAQAAAChAQAAL2hvbWUvY29uc3VsdGluZy8uY2FyZ28vZ2l0L2NoZWNrb3V0cy93YXNtZXItZjExZjMwZTYyNzM5YWEyOS9lY2RlMmFhL2xpYi9hcGkvc3JjL2pzL3RyYXAucnNEaxAAXAAAAM4AAABbAAAAb2JqZWN0IHVzZWQgd2l0aCB0aGUgd3JvbmcgY29udGV4dAAAsGsQACIAAAAvaG9tZS9jb25zdWx0aW5nLy5jYXJnby9naXQvY2hlY2tvdXRzL3dhc21lci1mMTFmMzBlNjI3MzlhYTI5L2VjZGUyYWEvbGliL2FwaS9zcmMvanMvc3RvcmUucnMAAADcaxAAXQAAAFYBAAANAAAA3GsQAF0AAABcAQAADQAAANxrEABdAAAAoQEAAA4AAADcaxAAXQAAAJcBAAA5AAAA3GsQAF0AAACmAQAAEgAAAAAAAAD//////////y9ob21lL2NvbnN1bHRpbmcvLmNhcmdvL2dpdC9jaGVja291dHMvd2FzbWVyLWYxMWYzMGU2MjczOWFhMjkvZWNkZTJhYS9saWIvd2FzaS9zcmMvc3RhdGUvcGlwZS5yc5hsEABgAAAAOgAAACUAAACYbBAAYAAAAE0AAAAhAAAAL2hvbWUvY29uc3VsdGluZy8uY2FyZ28vZ2l0L2NoZWNrb3V0cy93YXNtZXItZjExZjMwZTYyNzM5YWEyOS9lY2RlMmFhL2xpYi93YXNpL3NyYy9zeXNjYWxscy9tb2QucnMAABhtEABiAAAAQQUAACYAAAAYbRAAYgAAAEIFAAA2AAAALwAAAJxtEAABAAAAOiAAAKiKEAAAAAAAqG0QAAIAAAA0dxAASQAAAFMBAAAYAAAAc3RyZWFtIGRpZCBub3QgY29udGFpbiB2YWxpZCBVVEYtOAAAzG0QACIAAAAVAAAANHcQAEkAAADHAQAAHAAAAGZhaWxlZCB0byBmaWxsIHdob2xlIGJ1ZmZlcgAMbhAAGwAAACUAAAA0dxAASQAAAIcBAAAbAAAANHcQAEkAAACWAQAAMAAAAC9ydXN0Yy8yNTg1YmNlYTBiYzJhOWM0MmE0YmUyYzFlYmE1YzYxMTM3ZjJiMTY3L2xpYnJhcnkvc3RkL3NyYy9pby9yZWFkYnVmLnJzAAAAVG4QAE0AAAD9AAAAFgAAAFRuEABNAAAA0wAAADUAAABUbhAATQAAAMsAAAA2AAAAY2Fubm90IHJlY3Vyc2l2ZWx5IGFjcXVpcmUgbXV0ZXjUbhAAIAAAAC9ydXN0Yy8yNTg1YmNlYTBiYzJhOWM0MmE0YmUyYzFlYmE1YzYxMTM3ZjJiMTY3L2xpYnJhcnkvc3RkL3NyYy9zeXMvd2FzbS8uLi91bnN1cHBvcnRlZC9sb2Nrcy9tdXRleC5ycwAA/G4QAGYAAAAUAAAACQAAAAovcnVzdGMvMjU4NWJjZWEwYmMyYTljNDJhNGJlMmMxZWJhNWM2MTEzN2YyYjE2Ny9saWJyYXJ5L3N0ZC9zcmMvc3luYy9tcG1jL21vZC5ycwAAAHVvEABQAAAAhQAAAC0AAAB4AAAABAAAAAQAAACiAQAAowEAAKQBAAClAQAACAAAAAQAAAB7AAAApQEAAAgAAAAEAAAAewAAAHwAAAAIAAAABAAAAHsAAAB4AAAABAAAAAQAAACmAQAAY2Fubm90IGFkdmFuY2UgcGFzdCBgcmVtYWluaW5nYDogIDw9IAAAADBwEAAhAAAAUXAQAAQAAAAvaG9tZS9jb25zdWx0aW5n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AAC8AAAADAAAAAQAAACpAQAAqgEAAKsBAABmb3JtYXR0ZXIgZXJyb3IAqHcQAA8AAAAoAAAANHcQAEkAAAAkBQAAFgAAADR3EABJAAAAKAUAAA0AAABhZHZhbmNpbmcgaW8gc2xpY2VzIGJleW9uZCB0aGVpciBsZW5ndGgA5HcQACcAAAA0dxAASQAAACYFAAANAAAAoAAAAAQAAAAEAAAAoQAAAEVycm9yIHdoaWxlIHNldHRpbmcgaW50byB0aGUganMgbmFtZXNwYWNlIG9iamVjdC9ob21lL2NvbnN1bHRpbmcvLmNhcmdvL2dpdC9jaGVja291dHMvd2FzbWVyLWYxMWYzMGU2MjczOWFhMjkvZWNkZTJhYS9saWIvYXBpL3NyYy9qcy9pbXBvcnRzLnJzAGR4EABfAAAAsAAAABYAAABFcnJvciB3aGlsZSBzZXR0aW5nIGludG8gdGhlIGpzIGltcG9ydHMgb2JqZWN0AABkeBAAXwAAALMAAAASAAAAZHgQAF8AAADZAAAAPwAAAGR4EABfAAAA3QAAAEMAAABkeBAAXwAAAOAAAAA8AAAAZHgQAF8AAADvAAAAUAAAAGR4EABfAAAA9wAAABIAAABkeBAAXwAAAAABAAASAAAAZHgQAF8AAAACAQAAFgAAAABQb2lzb25FcnJvcgAAAAEBAAAAAAEAAAAAAAABAAAAAQEAL2hvbWUvY29uc3VsdGluZy8uY2FyZ28vZ2l0L2NoZWNrb3V0cy93YXNtZXItZjExZjMwZTYyNzM5YWEyOS9lY2RlMmFhL2xpYi93YXNpL3NyYy9saWIucnNhcmdzX2dldGFyZ3Nfc2l6ZXNfZ2V0Y2xvY2tfcmVzX2dldGNsb2NrX3RpbWVfZ2V0ZW52aXJvbl9nZXRlbnZpcm9uX3NpemVzX2dldGZkX2FkdmlzZWZkX2FsbG9jYXRlZmRfY2xvc2VmZF9kYXRhc3luY2ZkX2Zkc3RhdF9nZXRmZF9mZHN0YXRfc2V0X2ZsYWdzZmRfZmRzdGF0X3NldF9yaWdodHNmZF9maWxlc3RhdF9nZXRmZF9maWxlc3RhdF9zZXRfc2l6ZWZkX2ZpbGVzdGF0X3NldF90aW1lc2ZkX3ByZWFkZmRfcHJlc3RhdF9nZXRmZF9wcmVzdGF0X2Rpcl9uYW1lZmRfcHdyaXRlZmRfcmVhZGZkX3JlYWRkaXJmZF9yZW51bWJlcmZkX3NlZWtmZF9zeW5jZmRfdGVsbGZkX3dyaXRlcGF0aF9jcmVhdGVfZGlyZWN0b3J5cGF0aF9maWxlc3RhdF9nZXRwYXRoX2ZpbGVzdGF0X3NldF90aW1lc3BhdGhfbGlua3BhdGhfb3BlbnBhdGhfcmVhZGxpbmtwYXRoX3JlbW92ZV9kaXJlY3RvcnlwYXRoX3JlbmFtZXBhdGhfc3ltbGlua3BhdGhfdW5saW5rX2ZpbGVwb2xsX29uZW9mZnByb2NfZXhpdHByb2NfcmFpc2VyYW5kb21fZ2V0c2NoZWRfeWllbGRzb2NrX3JlY3Zzb2NrX3NlbmRzb2NrX3NodXRkb3dubm90IGltcGxlbWVudGVkp3kQAFkAAAC4AQAADgAAAHdhc2lfdW5zdGFibGV3YXNpX3NuYXBzaG90X3ByZXZpZXcxY2FsbGVkIGBPcHRpb246OnVud3JhcCgpYCBvbiBhIGBOb25lYCB2YWx1ZS9ydXN0Yy8yNTg1YmNlYTBiYzJhOWM0MmE0YmUyYzFlYmE1YzYxMTM3ZjJiMTY3L2xpYnJhcnkvc3RkL3NyYy9zeW5jL21wbWMvYXJyYXkucnOifBAAUgAAAGcBAAAZAAAAaW50ZXJuYWwgZXJyb3I6IGVudGVyZWQgdW5yZWFjaGFibGUgY29kZaJ8EABSAAAAZQEAACoAAAAvcnVzdGMvMjU4NWJjZWEwYmMyYTljNDJhNGJlMmMxZWJhNWM2MTEzN2YyYjE2Ny9saWJyYXJ5L3N0ZC9zcmMvc3luYy9tcG1jL3dha2VyLnJzAAA8fRAAUgAAAFgAAAAnAAAAPH0QAFIAAAA7AAAAKAAAAGNhbGxlZCBgUmVzdWx0Ojp1bndyYXAoKWAgb24gYW4gYEVycmAgdmFsdWUAfQAAAAgAAAAEAAAAewAAADx9EABSAAAAnQAAABkAAAA8fRAAUgAAAKgAAAAdAAAAPH0QAFIAAACUAAAAGQAAAC9ydXN0Yy8yNTg1YmNlYTBiYzJhOWM0MmE0YmUyYzFlYmE1YzYxMTM3ZjJiMTY3L2xpYnJhcnkvc3RkL3NyYy9zeW5jL21wbWMvY29udGV4dC5ycxx+EABUAAAAMQAAABUAAABkZXNjcmlwdGlvbigpIGlzIGRlcHJlY2F0ZWQ7IHVzZSBEaXNwbGF5bm90Y2FwYWJsZXhkZXZ0eHRic3l0aW1lZG91dHN0YWxlc3JjaHNwaXBlcm9mc3JhbmdlcHJvdG90eXBlcHJvdG9ub3N1cHBvcnRwcm90b3BpcGVwZXJtb3duZXJkZWFkb3ZlcmZsb3dueGlvbm90dHlub3RzdXBub3Rzb2Nrbm90cmVjb3ZlcmFibGVub3RlbXB0eW5vdGRpcm5vdGNvbm5ub3N5c25vc3Bjbm9wcm90b29wdG5vbXNnbm9tZW1ub2xpbmtub2xja25vZXhlY25vZW50bm9kZXZub2J1ZnNuZmlsZW5ldHVucmVhY2huZXRyZXNldG5ldGRvd25uYW1ldG9vbG9uZ211bHRpaG9wbXNnc2l6ZW1saW5rbWZpbGVsb29waXNkaXJpc2Nvbm5pb2ludmFsaW50cmlucHJvZ3Jlc3NpbHNlcWlkcm1ob3N0dW5yZWFjaGZiaWdmYXVsdGV4aXN0ZHF1b3Rkb21kZXN0YWRkcnJlcWRlYWRsa2Nvbm5yZXNldGNvbm5yZWZ1c2VkY29ubmFib3J0ZWRjaGlsZGNhbmNlbGVkYnVzeWJhZG1zZ2JhZGZhbHJlYWR5YWdhaW5hZm5vc3VwcG9ydGFkZHJub3RhdmFpbGFkZHJpbnVzZWFjY2Vzc3Rvb2JpZ3N1Y2Nlc3NFeHRlbnNpb246IENhcGFiaWxpdGllcyBpbnN1ZmZpY2llbnQuQ3Jvc3MtZGV2aWNlIGxpbmsuVGV4dCBmaWxlIGJ1c3kuQ29ubmVjdGlvbiB0aW1lZCBvdXQuUmVzZXJ2ZWQuTm8gc3VjaCBwcm9jZXNzLkludmFsaWQgc2Vlay5SZWFkLW9ubHkgZmlsZSBzeXN0ZW0uUmVzdWx0IHRvbyBsYXJnZS5Qcm90b2NvbCB3cm9uZyB0eXBlIGZvciBzb2NrZXQuUHJvdG9jb2wgbm90IHN1cHBvcnRlZC5Qcm90b2NvbCBlcnJvci5Ccm9rZW4gcGlwZS5PcGVyYXRpb24gbm90IHBlcm1pdHRlZC5QcmV2aW91cyBvd25lciBkaWVkLlZhbHVlIHRvbyBsYXJnZSB0byBiZSBzdG9yZWQgaW4gZGF0YSB0eXBlLk5vIHN1Y2ggZGV2aWNlIG9yIGFkZHJlc3MuSW5hcHByb3ByaWF0ZSBJL08gY29udHJvbCBvcGVyYXRpb24uTm90IHN1cHBvcnRlZCwgb3Igb3BlcmF0aW9uIG5vdCBzdXBwb3J0ZWQgb24gc29ja2V0Lk5vdCBhIHNvY2tldC5TdGF0ZSBub3QgcmVjb3ZlcmFibGUuRGlyZWN0b3J5IG5vdCBlbXB0eS5Ob3QgYSBkaXJlY3Rvcnkgb3IgYSBzeW1ib2xpYyBsaW5rIHRvIGEgZGlyZWN0b3J5LlRoZSBzb2NrZXQgaXMgbm90IGNvbm5lY3RlZC5GdW5jdGlvbiBub3Qgc3VwcG9ydGVkLk5vIHNwYWNlIGxlZnQgb24gZGV2aWNlLlByb3RvY29sIG5vdCBhdmFpbGFibGUuTm8gbWVzc2FnZSBvZiB0aGUgZGVzaXJlZCB0eXBlLk5vdCBlbm91Z2ggc3BhY2UuTm8gbG9ja3MgYXZhaWxhYmxlLkV4ZWN1dGFibGUgZmlsZSBmb3JtYXQgZXJyb3IuTm8gc3VjaCBmaWxlIG9yIGRpcmVjdG9yeS5ObyBzdWNoIGRldmljZS5ObyBidWZmZXIgc3BhY2UgYXZhaWxhYmxlLlRvbyBtYW55IGZpbGVzIG9wZW4gaW4gc3lzdGVtLk5ldHdvcmsgdW5yZWFjaGFibGUuQ29ubmVjdGlvbiBhYm9ydGVkIGJ5IG5ldHdvcmsuTmV0d29yayBpcyBkb3duLkZpbGVuYW1lIHRvbyBsb25nLk1lc3NhZ2UgdG9vIGxhcmdlLlRvbyBtYW55IGxpbmtzLkZpbGUgZGVzY3JpcHRvciB2YWx1ZSB0b28gbGFyZ2UuVG9vIG1hbnkgbGV2ZWxzIG9mIHN5bWJvbGljIGxpbmtzLklzIGEgZGlyZWN0b3J5LlNvY2tldCBpcyBjb25uZWN0ZWQuSS9PIGVycm9yLkludmFsaWQgYXJndW1lbnQuSW50ZXJydXB0ZWQgZnVuY3Rpb24uT3BlcmF0aW9uIGluIHByb2dyZXNzLklsbGVnYWwgYnl0ZSBzZXF1ZW5jZS5JZGVudGlmaWVyIHJlbW92ZWQuSG9zdCBpcyB1bnJlYWNoYWJsZS5GaWxlIHRvbyBsYXJnZS5CYWQgYWRkcmVzcy5GaWxlIGV4aXN0cy5NYXRoZW1hdGljcyBhcmd1bWVudCBvdXQgb2YgZG9tYWluIG9mIGZ1bmN0aW9uLkRlc3RpbmF0aW9uIGFkZHJlc3MgcmVxdWlyZWQuUmVzb3VyY2UgZGVhZGxvY2sgd291bGQgb2NjdXIuQ29ubmVjdGlvbiByZXNldC5Db25uZWN0aW9uIHJlZnVzZWQuQ29ubmVjdGlvbiBhYm9ydGVkLk5vIGNoaWxkIHByb2Nlc3Nlcy5PcGVyYXRpb24gY2FuY2VsZWQuRGV2aWNlIG9yIHJlc291cmNlIGJ1c3kuQmFkIG1lc3NhZ2UuQmFkIGZpbGUgZGVzY3JpcHRvci5Db25uZWN0aW9uIGFscmVhZHkgaW4gcHJvZ3Jlc3MuUmVzb3VyY2UgdW5hdmFpbGFibGUsIG9yIG9wZXJhdGlvbiB3b3VsZCBibG9jay5BZGRyZXNzIGZhbWlseSBub3Qgc3VwcG9ydGVkLkFkZHJlc3Mgbm90IGF2YWlsYWJsZS5BZGRyZXNzIGluIHVzZS5QZXJtaXNzaW9uIGRlbmllZC5Bcmd1bWVudCBsaXN0IHRvbyBsb25nLk5vIGVycm9yIG9jY3VycmVkLiBTeXN0ZW0gY2FsbCBjb21wbGV0ZWQgc3VjY2Vzc2Z1bGx5LkVycm5vY29kZQAAeAAAAAQAAAAEAAAArAEAAG5hbWV4AAAACAAAAAQAAACtAQAAbWVzc2FnZSAoZXJyb3IgKaiKEAAAAAAAl4cQAAgAAACfhxAAAQAAAGRhdGFkaXJub3QgeWV0IGltcGxlbWVudGVkOiC/hxAAFQAAAGNvdWxkIG5vdCBzZXJpYWxpemUgbnVtYmVyICB0byBlbnVtIFNuYXBzaG90MENsb2NraWTchxAAGwAAAPeHEAAZAAAAL2hvbWUvY29uc3VsdGluZy8uY2FyZ28vZ2l0L2NoZWNrb3V0cy93YXNtZXItZjExZjMwZTYyNzM5YWEyOS9lY2RlMmFhL2xpYi93YXNpLXR5cGVzL3NyYy93YXNpL2V4dHJhLnJzAAAgiBAAZgAAAIoKAAASAAAAIHRvIGVudW0gQWR2aWNlANyHEAAbAAAAmIgQAA8AAAAgiBAAZgAAAIsLAAASAAAAIHRvIGVudW0gU25hcHNob3QwV2hlbmNl3IcQABsAAADIiBAAGAAAACCIEABmAAAA/QwAABIAAAAgdG8gZW51bSBXaGVuY2UA3IcQABsAAAAAiRAADwAAACCIEABmAAAAGQ0AABIAAAAgdG8gZW51bSBTaWduYWwA3IcQABsAAAAwiRAADwAAACCIEABmAAAATA8AABIAAABub3QgaW1wbGVtZW50ZWQgZm9yIG5vdwBgiRAAFwAAAC9ob21lL2NvbnN1bHRpbmcvLmNhcmdvL2dpdC9jaGVja291dHMvd2FzbWVyLWYxMWYzMGU2MjczOWFhMjkvZWNkZTJhYS9saWIvd2FzaS10eXBlcy9zcmMvd2FzaS9leHRyYV9tYW51YWwucnMAAACAiRAAbQAAAGkAAAAyAAAAgIkQAG0AAABoAAAAMwAAADB4AAAYAAAAL2hvbWUvY29uc3VsdGluZy8uY2FyZ28vZ2l0L2NoZWNrb3V0cy93YXNtZXItZjExZjMwZTYyNzM5YWEyOS9lY2RlMmFhL2xpYi93YXNpLXR5cGVzL3NyYy90eXBlcy5ycwAAABiKEABhAAAAcwAAAAkAAABjYXBhY2l0eSBvdmVyZmxvdwAAAIyKEAARAAAAL3J1c3RjLzI1ODViY2VhMGJjMmE5YzQyYTRiZTJjMWViYTVjNjExMzdmMmIxNjcvbGlicmFyeS9hbGxvYy9zcmMvdmVjL3NwZWNfZnJvbV9pdGVyX25lc3RlZC5ycwAAqIoQAF4AAAA7AAAAEgAAAC9ydXN0Yy8yNTg1YmNlYTBiYzJhOWM0MmE0YmUyYzFlYmE1YzYxMTM3ZjJiMTY3L2xpYnJhcnkvYWxsb2Mvc3JjL3ZlYy9tb2QucnMYixAATAAAAE0LAAANAAAAAAAAAAMAAAABAAAAAgAAABASCgsYGAkPBgcYCAMVGBgYGBgYDg0TFhgYGBgYGBgYGBgYDBgUGAUIFB0dAwRADQ4PGx0cNSs/SUEGMzodNhwIFB0dAwRADQ4PGx0cNSwrP0lBBjM3HQAAAAAAkwAgCAAAAADRACAIAAAAANEAIAgAAAAA/////38AQZiYwgALBf////9/AEGgmMIACwEDAEGwmMIACwEBAEHEmMIACwGnAEHUmMIACwGn"))];
            case 1:
              g2 = A2.sent(), A2.label = 2;
            case 2:
              b = d(g2), A2.label = 3;
            case 3:
              return [4, b];
            case 4:
              return A2.sent(), [2];
          }
        });
      });
    };
  }
});

// node_modules/base64-js/index.js
var require_base64_js = __commonJS({
  "node_modules/base64-js/index.js"(exports) {
    "use strict";
    exports.byteLength = byteLength;
    exports.toByteArray = toByteArray;
    exports.fromByteArray = fromByteArray;
    var lookup = [];
    var revLookup = [];
    var Arr = typeof Uint8Array !== "undefined" ? Uint8Array : Array;
    var code = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (i2 = 0, len = code.length; i2 < len; ++i2) {
      lookup[i2] = code[i2];
      revLookup[code.charCodeAt(i2)] = i2;
    }
    var i2;
    var len;
    revLookup["-".charCodeAt(0)] = 62;
    revLookup["_".charCodeAt(0)] = 63;
    function getLens(b64) {
      var len2 = b64.length;
      if (len2 % 4 > 0) {
        throw new Error("Invalid string. Length must be a multiple of 4");
      }
      var validLen = b64.indexOf("=");
      if (validLen === -1) validLen = len2;
      var placeHoldersLen = validLen === len2 ? 0 : 4 - validLen % 4;
      return [validLen, placeHoldersLen];
    }
    function byteLength(b64) {
      var lens = getLens(b64);
      var validLen = lens[0];
      var placeHoldersLen = lens[1];
      return (validLen + placeHoldersLen) * 3 / 4 - placeHoldersLen;
    }
    function _byteLength(b64, validLen, placeHoldersLen) {
      return (validLen + placeHoldersLen) * 3 / 4 - placeHoldersLen;
    }
    function toByteArray(b64) {
      var tmp;
      var lens = getLens(b64);
      var validLen = lens[0];
      var placeHoldersLen = lens[1];
      var arr = new Arr(_byteLength(b64, validLen, placeHoldersLen));
      var curByte = 0;
      var len2 = placeHoldersLen > 0 ? validLen - 4 : validLen;
      var i3;
      for (i3 = 0; i3 < len2; i3 += 4) {
        tmp = revLookup[b64.charCodeAt(i3)] << 18 | revLookup[b64.charCodeAt(i3 + 1)] << 12 | revLookup[b64.charCodeAt(i3 + 2)] << 6 | revLookup[b64.charCodeAt(i3 + 3)];
        arr[curByte++] = tmp >> 16 & 255;
        arr[curByte++] = tmp >> 8 & 255;
        arr[curByte++] = tmp & 255;
      }
      if (placeHoldersLen === 2) {
        tmp = revLookup[b64.charCodeAt(i3)] << 2 | revLookup[b64.charCodeAt(i3 + 1)] >> 4;
        arr[curByte++] = tmp & 255;
      }
      if (placeHoldersLen === 1) {
        tmp = revLookup[b64.charCodeAt(i3)] << 10 | revLookup[b64.charCodeAt(i3 + 1)] << 4 | revLookup[b64.charCodeAt(i3 + 2)] >> 2;
        arr[curByte++] = tmp >> 8 & 255;
        arr[curByte++] = tmp & 255;
      }
      return arr;
    }
    function tripletToBase64(num) {
      return lookup[num >> 18 & 63] + lookup[num >> 12 & 63] + lookup[num >> 6 & 63] + lookup[num & 63];
    }
    function encodeChunk(uint8, start, end) {
      var tmp;
      var output = [];
      for (var i3 = start; i3 < end; i3 += 3) {
        tmp = (uint8[i3] << 16 & 16711680) + (uint8[i3 + 1] << 8 & 65280) + (uint8[i3 + 2] & 255);
        output.push(tripletToBase64(tmp));
      }
      return output.join("");
    }
    function fromByteArray(uint8) {
      var tmp;
      var len2 = uint8.length;
      var extraBytes = len2 % 3;
      var parts = [];
      var maxChunkLength = 16383;
      for (var i3 = 0, len22 = len2 - extraBytes; i3 < len22; i3 += maxChunkLength) {
        parts.push(encodeChunk(uint8, i3, i3 + maxChunkLength > len22 ? len22 : i3 + maxChunkLength));
      }
      if (extraBytes === 1) {
        tmp = uint8[len2 - 1];
        parts.push(
          lookup[tmp >> 2] + lookup[tmp << 4 & 63] + "=="
        );
      } else if (extraBytes === 2) {
        tmp = (uint8[len2 - 2] << 8) + uint8[len2 - 1];
        parts.push(
          lookup[tmp >> 10] + lookup[tmp >> 4 & 63] + lookup[tmp << 2 & 63] + "="
        );
      }
      return parts.join("");
    }
  }
});

// node_modules/ieee754/index.js
var require_ieee754 = __commonJS({
  "node_modules/ieee754/index.js"(exports) {
    exports.read = function(buffer, offset, isLE, mLen, nBytes) {
      var e, m;
      var eLen = nBytes * 8 - mLen - 1;
      var eMax = (1 << eLen) - 1;
      var eBias = eMax >> 1;
      var nBits = -7;
      var i2 = isLE ? nBytes - 1 : 0;
      var d2 = isLE ? -1 : 1;
      var s2 = buffer[offset + i2];
      i2 += d2;
      e = s2 & (1 << -nBits) - 1;
      s2 >>= -nBits;
      nBits += eLen;
      for (; nBits > 0; e = e * 256 + buffer[offset + i2], i2 += d2, nBits -= 8) {
      }
      m = e & (1 << -nBits) - 1;
      e >>= -nBits;
      nBits += mLen;
      for (; nBits > 0; m = m * 256 + buffer[offset + i2], i2 += d2, nBits -= 8) {
      }
      if (e === 0) {
        e = 1 - eBias;
      } else if (e === eMax) {
        return m ? NaN : (s2 ? -1 : 1) * Infinity;
      } else {
        m = m + Math.pow(2, mLen);
        e = e - eBias;
      }
      return (s2 ? -1 : 1) * m * Math.pow(2, e - mLen);
    };
    exports.write = function(buffer, value, offset, isLE, mLen, nBytes) {
      var e, m, c2;
      var eLen = nBytes * 8 - mLen - 1;
      var eMax = (1 << eLen) - 1;
      var eBias = eMax >> 1;
      var rt = mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0;
      var i2 = isLE ? 0 : nBytes - 1;
      var d2 = isLE ? 1 : -1;
      var s2 = value < 0 || value === 0 && 1 / value < 0 ? 1 : 0;
      value = Math.abs(value);
      if (isNaN(value) || value === Infinity) {
        m = isNaN(value) ? 1 : 0;
        e = eMax;
      } else {
        e = Math.floor(Math.log(value) / Math.LN2);
        if (value * (c2 = Math.pow(2, -e)) < 1) {
          e--;
          c2 *= 2;
        }
        if (e + eBias >= 1) {
          value += rt / c2;
        } else {
          value += rt * Math.pow(2, 1 - eBias);
        }
        if (value * c2 >= 2) {
          e++;
          c2 /= 2;
        }
        if (e + eBias >= eMax) {
          m = 0;
          e = eMax;
        } else if (e + eBias >= 1) {
          m = (value * c2 - 1) * Math.pow(2, mLen);
          e = e + eBias;
        } else {
          m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen);
          e = 0;
        }
      }
      for (; mLen >= 8; buffer[offset + i2] = m & 255, i2 += d2, m /= 256, mLen -= 8) {
      }
      e = e << mLen | m;
      eLen += mLen;
      for (; eLen > 0; buffer[offset + i2] = e & 255, i2 += d2, e /= 256, eLen -= 8) {
      }
      buffer[offset + i2 - d2] |= s2 * 128;
    };
  }
});

// node_modules/buffer/index.js
var require_buffer = __commonJS({
  "node_modules/buffer/index.js"(exports) {
    "use strict";
    var base64 = require_base64_js();
    var ieee754 = require_ieee754();
    var customInspectSymbol = typeof Symbol === "function" && typeof Symbol["for"] === "function" ? Symbol["for"]("nodejs.util.inspect.custom") : null;
    exports.Buffer = Buffer3;
    exports.SlowBuffer = SlowBuffer;
    exports.INSPECT_MAX_BYTES = 50;
    var K_MAX_LENGTH = 2147483647;
    exports.kMaxLength = K_MAX_LENGTH;
    Buffer3.TYPED_ARRAY_SUPPORT = typedArraySupport();
    if (!Buffer3.TYPED_ARRAY_SUPPORT && typeof console !== "undefined" && typeof console.error === "function") {
      console.error(
        "This browser lacks typed array (Uint8Array) support which is required by `buffer` v5.x. Use `buffer` v4.x if you require old browser support."
      );
    }
    function typedArraySupport() {
      try {
        var arr = new Uint8Array(1);
        var proto = { foo: function() {
          return 42;
        } };
        Object.setPrototypeOf(proto, Uint8Array.prototype);
        Object.setPrototypeOf(arr, proto);
        return arr.foo() === 42;
      } catch (e) {
        return false;
      }
    }
    Object.defineProperty(Buffer3.prototype, "parent", {
      enumerable: true,
      get: function() {
        if (!Buffer3.isBuffer(this)) return void 0;
        return this.buffer;
      }
    });
    Object.defineProperty(Buffer3.prototype, "offset", {
      enumerable: true,
      get: function() {
        if (!Buffer3.isBuffer(this)) return void 0;
        return this.byteOffset;
      }
    });
    function createBuffer(length) {
      if (length > K_MAX_LENGTH) {
        throw new RangeError('The value "' + length + '" is invalid for option "size"');
      }
      var buf = new Uint8Array(length);
      Object.setPrototypeOf(buf, Buffer3.prototype);
      return buf;
    }
    function Buffer3(arg, encodingOrOffset, length) {
      if (typeof arg === "number") {
        if (typeof encodingOrOffset === "string") {
          throw new TypeError(
            'The "string" argument must be of type string. Received type number'
          );
        }
        return allocUnsafe(arg);
      }
      return from(arg, encodingOrOffset, length);
    }
    Buffer3.poolSize = 8192;
    function from(value, encodingOrOffset, length) {
      if (typeof value === "string") {
        return fromString(value, encodingOrOffset);
      }
      if (ArrayBuffer.isView(value)) {
        return fromArrayView(value);
      }
      if (value == null) {
        throw new TypeError(
          "The first argument must be one of type string, Buffer, ArrayBuffer, Array, or Array-like Object. Received type " + typeof value
        );
      }
      if (isInstance(value, ArrayBuffer) || value && isInstance(value.buffer, ArrayBuffer)) {
        return fromArrayBuffer(value, encodingOrOffset, length);
      }
      if (typeof SharedArrayBuffer !== "undefined" && (isInstance(value, SharedArrayBuffer) || value && isInstance(value.buffer, SharedArrayBuffer))) {
        return fromArrayBuffer(value, encodingOrOffset, length);
      }
      if (typeof value === "number") {
        throw new TypeError(
          'The "value" argument must not be of type number. Received type number'
        );
      }
      var valueOf = value.valueOf && value.valueOf();
      if (valueOf != null && valueOf !== value) {
        return Buffer3.from(valueOf, encodingOrOffset, length);
      }
      var b2 = fromObject(value);
      if (b2) return b2;
      if (typeof Symbol !== "undefined" && Symbol.toPrimitive != null && typeof value[Symbol.toPrimitive] === "function") {
        return Buffer3.from(
          value[Symbol.toPrimitive]("string"),
          encodingOrOffset,
          length
        );
      }
      throw new TypeError(
        "The first argument must be one of type string, Buffer, ArrayBuffer, Array, or Array-like Object. Received type " + typeof value
      );
    }
    Buffer3.from = function(value, encodingOrOffset, length) {
      return from(value, encodingOrOffset, length);
    };
    Object.setPrototypeOf(Buffer3.prototype, Uint8Array.prototype);
    Object.setPrototypeOf(Buffer3, Uint8Array);
    function assertSize(size) {
      if (typeof size !== "number") {
        throw new TypeError('"size" argument must be of type number');
      } else if (size < 0) {
        throw new RangeError('The value "' + size + '" is invalid for option "size"');
      }
    }
    function alloc(size, fill, encoding) {
      assertSize(size);
      if (size <= 0) {
        return createBuffer(size);
      }
      if (fill !== void 0) {
        return typeof encoding === "string" ? createBuffer(size).fill(fill, encoding) : createBuffer(size).fill(fill);
      }
      return createBuffer(size);
    }
    Buffer3.alloc = function(size, fill, encoding) {
      return alloc(size, fill, encoding);
    };
    function allocUnsafe(size) {
      assertSize(size);
      return createBuffer(size < 0 ? 0 : checked(size) | 0);
    }
    Buffer3.allocUnsafe = function(size) {
      return allocUnsafe(size);
    };
    Buffer3.allocUnsafeSlow = function(size) {
      return allocUnsafe(size);
    };
    function fromString(string, encoding) {
      if (typeof encoding !== "string" || encoding === "") {
        encoding = "utf8";
      }
      if (!Buffer3.isEncoding(encoding)) {
        throw new TypeError("Unknown encoding: " + encoding);
      }
      var length = byteLength(string, encoding) | 0;
      var buf = createBuffer(length);
      var actual = buf.write(string, encoding);
      if (actual !== length) {
        buf = buf.slice(0, actual);
      }
      return buf;
    }
    function fromArrayLike(array) {
      var length = array.length < 0 ? 0 : checked(array.length) | 0;
      var buf = createBuffer(length);
      for (var i2 = 0; i2 < length; i2 += 1) {
        buf[i2] = array[i2] & 255;
      }
      return buf;
    }
    function fromArrayView(arrayView) {
      if (isInstance(arrayView, Uint8Array)) {
        var copy = new Uint8Array(arrayView);
        return fromArrayBuffer(copy.buffer, copy.byteOffset, copy.byteLength);
      }
      return fromArrayLike(arrayView);
    }
    function fromArrayBuffer(array, byteOffset, length) {
      if (byteOffset < 0 || array.byteLength < byteOffset) {
        throw new RangeError('"offset" is outside of buffer bounds');
      }
      if (array.byteLength < byteOffset + (length || 0)) {
        throw new RangeError('"length" is outside of buffer bounds');
      }
      var buf;
      if (byteOffset === void 0 && length === void 0) {
        buf = new Uint8Array(array);
      } else if (length === void 0) {
        buf = new Uint8Array(array, byteOffset);
      } else {
        buf = new Uint8Array(array, byteOffset, length);
      }
      Object.setPrototypeOf(buf, Buffer3.prototype);
      return buf;
    }
    function fromObject(obj) {
      if (Buffer3.isBuffer(obj)) {
        var len = checked(obj.length) | 0;
        var buf = createBuffer(len);
        if (buf.length === 0) {
          return buf;
        }
        obj.copy(buf, 0, 0, len);
        return buf;
      }
      if (obj.length !== void 0) {
        if (typeof obj.length !== "number" || numberIsNaN(obj.length)) {
          return createBuffer(0);
        }
        return fromArrayLike(obj);
      }
      if (obj.type === "Buffer" && Array.isArray(obj.data)) {
        return fromArrayLike(obj.data);
      }
    }
    function checked(length) {
      if (length >= K_MAX_LENGTH) {
        throw new RangeError("Attempt to allocate Buffer larger than maximum size: 0x" + K_MAX_LENGTH.toString(16) + " bytes");
      }
      return length | 0;
    }
    function SlowBuffer(length) {
      if (+length != length) {
        length = 0;
      }
      return Buffer3.alloc(+length);
    }
    Buffer3.isBuffer = function isBuffer(b2) {
      return b2 != null && b2._isBuffer === true && b2 !== Buffer3.prototype;
    };
    Buffer3.compare = function compare(a2, b2) {
      if (isInstance(a2, Uint8Array)) a2 = Buffer3.from(a2, a2.offset, a2.byteLength);
      if (isInstance(b2, Uint8Array)) b2 = Buffer3.from(b2, b2.offset, b2.byteLength);
      if (!Buffer3.isBuffer(a2) || !Buffer3.isBuffer(b2)) {
        throw new TypeError(
          'The "buf1", "buf2" arguments must be one of type Buffer or Uint8Array'
        );
      }
      if (a2 === b2) return 0;
      var x = a2.length;
      var y2 = b2.length;
      for (var i2 = 0, len = Math.min(x, y2); i2 < len; ++i2) {
        if (a2[i2] !== b2[i2]) {
          x = a2[i2];
          y2 = b2[i2];
          break;
        }
      }
      if (x < y2) return -1;
      if (y2 < x) return 1;
      return 0;
    };
    Buffer3.isEncoding = function isEncoding(encoding) {
      switch (String(encoding).toLowerCase()) {
        case "hex":
        case "utf8":
        case "utf-8":
        case "ascii":
        case "latin1":
        case "binary":
        case "base64":
        case "ucs2":
        case "ucs-2":
        case "utf16le":
        case "utf-16le":
          return true;
        default:
          return false;
      }
    };
    Buffer3.concat = function concat(list, length) {
      if (!Array.isArray(list)) {
        throw new TypeError('"list" argument must be an Array of Buffers');
      }
      if (list.length === 0) {
        return Buffer3.alloc(0);
      }
      var i2;
      if (length === void 0) {
        length = 0;
        for (i2 = 0; i2 < list.length; ++i2) {
          length += list[i2].length;
        }
      }
      var buffer = Buffer3.allocUnsafe(length);
      var pos = 0;
      for (i2 = 0; i2 < list.length; ++i2) {
        var buf = list[i2];
        if (isInstance(buf, Uint8Array)) {
          if (pos + buf.length > buffer.length) {
            Buffer3.from(buf).copy(buffer, pos);
          } else {
            Uint8Array.prototype.set.call(
              buffer,
              buf,
              pos
            );
          }
        } else if (!Buffer3.isBuffer(buf)) {
          throw new TypeError('"list" argument must be an Array of Buffers');
        } else {
          buf.copy(buffer, pos);
        }
        pos += buf.length;
      }
      return buffer;
    };
    function byteLength(string, encoding) {
      if (Buffer3.isBuffer(string)) {
        return string.length;
      }
      if (ArrayBuffer.isView(string) || isInstance(string, ArrayBuffer)) {
        return string.byteLength;
      }
      if (typeof string !== "string") {
        throw new TypeError(
          'The "string" argument must be one of type string, Buffer, or ArrayBuffer. Received type ' + typeof string
        );
      }
      var len = string.length;
      var mustMatch = arguments.length > 2 && arguments[2] === true;
      if (!mustMatch && len === 0) return 0;
      var loweredCase = false;
      for (; ; ) {
        switch (encoding) {
          case "ascii":
          case "latin1":
          case "binary":
            return len;
          case "utf8":
          case "utf-8":
            return utf8ToBytes(string).length;
          case "ucs2":
          case "ucs-2":
          case "utf16le":
          case "utf-16le":
            return len * 2;
          case "hex":
            return len >>> 1;
          case "base64":
            return base64ToBytes(string).length;
          default:
            if (loweredCase) {
              return mustMatch ? -1 : utf8ToBytes(string).length;
            }
            encoding = ("" + encoding).toLowerCase();
            loweredCase = true;
        }
      }
    }
    Buffer3.byteLength = byteLength;
    function slowToString(encoding, start, end) {
      var loweredCase = false;
      if (start === void 0 || start < 0) {
        start = 0;
      }
      if (start > this.length) {
        return "";
      }
      if (end === void 0 || end > this.length) {
        end = this.length;
      }
      if (end <= 0) {
        return "";
      }
      end >>>= 0;
      start >>>= 0;
      if (end <= start) {
        return "";
      }
      if (!encoding) encoding = "utf8";
      while (true) {
        switch (encoding) {
          case "hex":
            return hexSlice(this, start, end);
          case "utf8":
          case "utf-8":
            return utf8Slice(this, start, end);
          case "ascii":
            return asciiSlice(this, start, end);
          case "latin1":
          case "binary":
            return latin1Slice(this, start, end);
          case "base64":
            return base64Slice(this, start, end);
          case "ucs2":
          case "ucs-2":
          case "utf16le":
          case "utf-16le":
            return utf16leSlice(this, start, end);
          default:
            if (loweredCase) throw new TypeError("Unknown encoding: " + encoding);
            encoding = (encoding + "").toLowerCase();
            loweredCase = true;
        }
      }
    }
    Buffer3.prototype._isBuffer = true;
    function swap(b2, n2, m) {
      var i2 = b2[n2];
      b2[n2] = b2[m];
      b2[m] = i2;
    }
    Buffer3.prototype.swap16 = function swap16() {
      var len = this.length;
      if (len % 2 !== 0) {
        throw new RangeError("Buffer size must be a multiple of 16-bits");
      }
      for (var i2 = 0; i2 < len; i2 += 2) {
        swap(this, i2, i2 + 1);
      }
      return this;
    };
    Buffer3.prototype.swap32 = function swap32() {
      var len = this.length;
      if (len % 4 !== 0) {
        throw new RangeError("Buffer size must be a multiple of 32-bits");
      }
      for (var i2 = 0; i2 < len; i2 += 4) {
        swap(this, i2, i2 + 3);
        swap(this, i2 + 1, i2 + 2);
      }
      return this;
    };
    Buffer3.prototype.swap64 = function swap64() {
      var len = this.length;
      if (len % 8 !== 0) {
        throw new RangeError("Buffer size must be a multiple of 64-bits");
      }
      for (var i2 = 0; i2 < len; i2 += 8) {
        swap(this, i2, i2 + 7);
        swap(this, i2 + 1, i2 + 6);
        swap(this, i2 + 2, i2 + 5);
        swap(this, i2 + 3, i2 + 4);
      }
      return this;
    };
    Buffer3.prototype.toString = function toString2() {
      var length = this.length;
      if (length === 0) return "";
      if (arguments.length === 0) return utf8Slice(this, 0, length);
      return slowToString.apply(this, arguments);
    };
    Buffer3.prototype.toLocaleString = Buffer3.prototype.toString;
    Buffer3.prototype.equals = function equals(b2) {
      if (!Buffer3.isBuffer(b2)) throw new TypeError("Argument must be a Buffer");
      if (this === b2) return true;
      return Buffer3.compare(this, b2) === 0;
    };
    Buffer3.prototype.inspect = function inspect() {
      var str = "";
      var max = exports.INSPECT_MAX_BYTES;
      str = this.toString("hex", 0, max).replace(/(.{2})/g, "$1 ").trim();
      if (this.length > max) str += " ... ";
      return "<Buffer " + str + ">";
    };
    if (customInspectSymbol) {
      Buffer3.prototype[customInspectSymbol] = Buffer3.prototype.inspect;
    }
    Buffer3.prototype.compare = function compare(target, start, end, thisStart, thisEnd) {
      if (isInstance(target, Uint8Array)) {
        target = Buffer3.from(target, target.offset, target.byteLength);
      }
      if (!Buffer3.isBuffer(target)) {
        throw new TypeError(
          'The "target" argument must be one of type Buffer or Uint8Array. Received type ' + typeof target
        );
      }
      if (start === void 0) {
        start = 0;
      }
      if (end === void 0) {
        end = target ? target.length : 0;
      }
      if (thisStart === void 0) {
        thisStart = 0;
      }
      if (thisEnd === void 0) {
        thisEnd = this.length;
      }
      if (start < 0 || end > target.length || thisStart < 0 || thisEnd > this.length) {
        throw new RangeError("out of range index");
      }
      if (thisStart >= thisEnd && start >= end) {
        return 0;
      }
      if (thisStart >= thisEnd) {
        return -1;
      }
      if (start >= end) {
        return 1;
      }
      start >>>= 0;
      end >>>= 0;
      thisStart >>>= 0;
      thisEnd >>>= 0;
      if (this === target) return 0;
      var x = thisEnd - thisStart;
      var y2 = end - start;
      var len = Math.min(x, y2);
      var thisCopy = this.slice(thisStart, thisEnd);
      var targetCopy = target.slice(start, end);
      for (var i2 = 0; i2 < len; ++i2) {
        if (thisCopy[i2] !== targetCopy[i2]) {
          x = thisCopy[i2];
          y2 = targetCopy[i2];
          break;
        }
      }
      if (x < y2) return -1;
      if (y2 < x) return 1;
      return 0;
    };
    function bidirectionalIndexOf(buffer, val, byteOffset, encoding, dir) {
      if (buffer.length === 0) return -1;
      if (typeof byteOffset === "string") {
        encoding = byteOffset;
        byteOffset = 0;
      } else if (byteOffset > 2147483647) {
        byteOffset = 2147483647;
      } else if (byteOffset < -2147483648) {
        byteOffset = -2147483648;
      }
      byteOffset = +byteOffset;
      if (numberIsNaN(byteOffset)) {
        byteOffset = dir ? 0 : buffer.length - 1;
      }
      if (byteOffset < 0) byteOffset = buffer.length + byteOffset;
      if (byteOffset >= buffer.length) {
        if (dir) return -1;
        else byteOffset = buffer.length - 1;
      } else if (byteOffset < 0) {
        if (dir) byteOffset = 0;
        else return -1;
      }
      if (typeof val === "string") {
        val = Buffer3.from(val, encoding);
      }
      if (Buffer3.isBuffer(val)) {
        if (val.length === 0) {
          return -1;
        }
        return arrayIndexOf(buffer, val, byteOffset, encoding, dir);
      } else if (typeof val === "number") {
        val = val & 255;
        if (typeof Uint8Array.prototype.indexOf === "function") {
          if (dir) {
            return Uint8Array.prototype.indexOf.call(buffer, val, byteOffset);
          } else {
            return Uint8Array.prototype.lastIndexOf.call(buffer, val, byteOffset);
          }
        }
        return arrayIndexOf(buffer, [val], byteOffset, encoding, dir);
      }
      throw new TypeError("val must be string, number or Buffer");
    }
    function arrayIndexOf(arr, val, byteOffset, encoding, dir) {
      var indexSize = 1;
      var arrLength = arr.length;
      var valLength = val.length;
      if (encoding !== void 0) {
        encoding = String(encoding).toLowerCase();
        if (encoding === "ucs2" || encoding === "ucs-2" || encoding === "utf16le" || encoding === "utf-16le") {
          if (arr.length < 2 || val.length < 2) {
            return -1;
          }
          indexSize = 2;
          arrLength /= 2;
          valLength /= 2;
          byteOffset /= 2;
        }
      }
      function read(buf, i3) {
        if (indexSize === 1) {
          return buf[i3];
        } else {
          return buf.readUInt16BE(i3 * indexSize);
        }
      }
      var i2;
      if (dir) {
        var foundIndex = -1;
        for (i2 = byteOffset; i2 < arrLength; i2++) {
          if (read(arr, i2) === read(val, foundIndex === -1 ? 0 : i2 - foundIndex)) {
            if (foundIndex === -1) foundIndex = i2;
            if (i2 - foundIndex + 1 === valLength) return foundIndex * indexSize;
          } else {
            if (foundIndex !== -1) i2 -= i2 - foundIndex;
            foundIndex = -1;
          }
        }
      } else {
        if (byteOffset + valLength > arrLength) byteOffset = arrLength - valLength;
        for (i2 = byteOffset; i2 >= 0; i2--) {
          var found = true;
          for (var j = 0; j < valLength; j++) {
            if (read(arr, i2 + j) !== read(val, j)) {
              found = false;
              break;
            }
          }
          if (found) return i2;
        }
      }
      return -1;
    }
    Buffer3.prototype.includes = function includes(val, byteOffset, encoding) {
      return this.indexOf(val, byteOffset, encoding) !== -1;
    };
    Buffer3.prototype.indexOf = function indexOf(val, byteOffset, encoding) {
      return bidirectionalIndexOf(this, val, byteOffset, encoding, true);
    };
    Buffer3.prototype.lastIndexOf = function lastIndexOf(val, byteOffset, encoding) {
      return bidirectionalIndexOf(this, val, byteOffset, encoding, false);
    };
    function hexWrite(buf, string, offset, length) {
      offset = Number(offset) || 0;
      var remaining = buf.length - offset;
      if (!length) {
        length = remaining;
      } else {
        length = Number(length);
        if (length > remaining) {
          length = remaining;
        }
      }
      var strLen = string.length;
      if (length > strLen / 2) {
        length = strLen / 2;
      }
      for (var i2 = 0; i2 < length; ++i2) {
        var parsed = parseInt(string.substr(i2 * 2, 2), 16);
        if (numberIsNaN(parsed)) return i2;
        buf[offset + i2] = parsed;
      }
      return i2;
    }
    function utf8Write(buf, string, offset, length) {
      return blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length);
    }
    function asciiWrite(buf, string, offset, length) {
      return blitBuffer(asciiToBytes(string), buf, offset, length);
    }
    function base64Write(buf, string, offset, length) {
      return blitBuffer(base64ToBytes(string), buf, offset, length);
    }
    function ucs2Write(buf, string, offset, length) {
      return blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length);
    }
    Buffer3.prototype.write = function write(string, offset, length, encoding) {
      if (offset === void 0) {
        encoding = "utf8";
        length = this.length;
        offset = 0;
      } else if (length === void 0 && typeof offset === "string") {
        encoding = offset;
        length = this.length;
        offset = 0;
      } else if (isFinite(offset)) {
        offset = offset >>> 0;
        if (isFinite(length)) {
          length = length >>> 0;
          if (encoding === void 0) encoding = "utf8";
        } else {
          encoding = length;
          length = void 0;
        }
      } else {
        throw new Error(
          "Buffer.write(string, encoding, offset[, length]) is no longer supported"
        );
      }
      var remaining = this.length - offset;
      if (length === void 0 || length > remaining) length = remaining;
      if (string.length > 0 && (length < 0 || offset < 0) || offset > this.length) {
        throw new RangeError("Attempt to write outside buffer bounds");
      }
      if (!encoding) encoding = "utf8";
      var loweredCase = false;
      for (; ; ) {
        switch (encoding) {
          case "hex":
            return hexWrite(this, string, offset, length);
          case "utf8":
          case "utf-8":
            return utf8Write(this, string, offset, length);
          case "ascii":
          case "latin1":
          case "binary":
            return asciiWrite(this, string, offset, length);
          case "base64":
            return base64Write(this, string, offset, length);
          case "ucs2":
          case "ucs-2":
          case "utf16le":
          case "utf-16le":
            return ucs2Write(this, string, offset, length);
          default:
            if (loweredCase) throw new TypeError("Unknown encoding: " + encoding);
            encoding = ("" + encoding).toLowerCase();
            loweredCase = true;
        }
      }
    };
    Buffer3.prototype.toJSON = function toJSON() {
      return {
        type: "Buffer",
        data: Array.prototype.slice.call(this._arr || this, 0)
      };
    };
    function base64Slice(buf, start, end) {
      if (start === 0 && end === buf.length) {
        return base64.fromByteArray(buf);
      } else {
        return base64.fromByteArray(buf.slice(start, end));
      }
    }
    function utf8Slice(buf, start, end) {
      end = Math.min(buf.length, end);
      var res = [];
      var i2 = start;
      while (i2 < end) {
        var firstByte = buf[i2];
        var codePoint = null;
        var bytesPerSequence = firstByte > 239 ? 4 : firstByte > 223 ? 3 : firstByte > 191 ? 2 : 1;
        if (i2 + bytesPerSequence <= end) {
          var secondByte, thirdByte, fourthByte, tempCodePoint;
          switch (bytesPerSequence) {
            case 1:
              if (firstByte < 128) {
                codePoint = firstByte;
              }
              break;
            case 2:
              secondByte = buf[i2 + 1];
              if ((secondByte & 192) === 128) {
                tempCodePoint = (firstByte & 31) << 6 | secondByte & 63;
                if (tempCodePoint > 127) {
                  codePoint = tempCodePoint;
                }
              }
              break;
            case 3:
              secondByte = buf[i2 + 1];
              thirdByte = buf[i2 + 2];
              if ((secondByte & 192) === 128 && (thirdByte & 192) === 128) {
                tempCodePoint = (firstByte & 15) << 12 | (secondByte & 63) << 6 | thirdByte & 63;
                if (tempCodePoint > 2047 && (tempCodePoint < 55296 || tempCodePoint > 57343)) {
                  codePoint = tempCodePoint;
                }
              }
              break;
            case 4:
              secondByte = buf[i2 + 1];
              thirdByte = buf[i2 + 2];
              fourthByte = buf[i2 + 3];
              if ((secondByte & 192) === 128 && (thirdByte & 192) === 128 && (fourthByte & 192) === 128) {
                tempCodePoint = (firstByte & 15) << 18 | (secondByte & 63) << 12 | (thirdByte & 63) << 6 | fourthByte & 63;
                if (tempCodePoint > 65535 && tempCodePoint < 1114112) {
                  codePoint = tempCodePoint;
                }
              }
          }
        }
        if (codePoint === null) {
          codePoint = 65533;
          bytesPerSequence = 1;
        } else if (codePoint > 65535) {
          codePoint -= 65536;
          res.push(codePoint >>> 10 & 1023 | 55296);
          codePoint = 56320 | codePoint & 1023;
        }
        res.push(codePoint);
        i2 += bytesPerSequence;
      }
      return decodeCodePointsArray(res);
    }
    var MAX_ARGUMENTS_LENGTH = 4096;
    function decodeCodePointsArray(codePoints) {
      var len = codePoints.length;
      if (len <= MAX_ARGUMENTS_LENGTH) {
        return String.fromCharCode.apply(String, codePoints);
      }
      var res = "";
      var i2 = 0;
      while (i2 < len) {
        res += String.fromCharCode.apply(
          String,
          codePoints.slice(i2, i2 += MAX_ARGUMENTS_LENGTH)
        );
      }
      return res;
    }
    function asciiSlice(buf, start, end) {
      var ret = "";
      end = Math.min(buf.length, end);
      for (var i2 = start; i2 < end; ++i2) {
        ret += String.fromCharCode(buf[i2] & 127);
      }
      return ret;
    }
    function latin1Slice(buf, start, end) {
      var ret = "";
      end = Math.min(buf.length, end);
      for (var i2 = start; i2 < end; ++i2) {
        ret += String.fromCharCode(buf[i2]);
      }
      return ret;
    }
    function hexSlice(buf, start, end) {
      var len = buf.length;
      if (!start || start < 0) start = 0;
      if (!end || end < 0 || end > len) end = len;
      var out = "";
      for (var i2 = start; i2 < end; ++i2) {
        out += hexSliceLookupTable[buf[i2]];
      }
      return out;
    }
    function utf16leSlice(buf, start, end) {
      var bytes = buf.slice(start, end);
      var res = "";
      for (var i2 = 0; i2 < bytes.length - 1; i2 += 2) {
        res += String.fromCharCode(bytes[i2] + bytes[i2 + 1] * 256);
      }
      return res;
    }
    Buffer3.prototype.slice = function slice(start, end) {
      var len = this.length;
      start = ~~start;
      end = end === void 0 ? len : ~~end;
      if (start < 0) {
        start += len;
        if (start < 0) start = 0;
      } else if (start > len) {
        start = len;
      }
      if (end < 0) {
        end += len;
        if (end < 0) end = 0;
      } else if (end > len) {
        end = len;
      }
      if (end < start) end = start;
      var newBuf = this.subarray(start, end);
      Object.setPrototypeOf(newBuf, Buffer3.prototype);
      return newBuf;
    };
    function checkOffset(offset, ext, length) {
      if (offset % 1 !== 0 || offset < 0) throw new RangeError("offset is not uint");
      if (offset + ext > length) throw new RangeError("Trying to access beyond buffer length");
    }
    Buffer3.prototype.readUintLE = Buffer3.prototype.readUIntLE = function readUIntLE(offset, byteLength2, noAssert) {
      offset = offset >>> 0;
      byteLength2 = byteLength2 >>> 0;
      if (!noAssert) checkOffset(offset, byteLength2, this.length);
      var val = this[offset];
      var mul = 1;
      var i2 = 0;
      while (++i2 < byteLength2 && (mul *= 256)) {
        val += this[offset + i2] * mul;
      }
      return val;
    };
    Buffer3.prototype.readUintBE = Buffer3.prototype.readUIntBE = function readUIntBE(offset, byteLength2, noAssert) {
      offset = offset >>> 0;
      byteLength2 = byteLength2 >>> 0;
      if (!noAssert) {
        checkOffset(offset, byteLength2, this.length);
      }
      var val = this[offset + --byteLength2];
      var mul = 1;
      while (byteLength2 > 0 && (mul *= 256)) {
        val += this[offset + --byteLength2] * mul;
      }
      return val;
    };
    Buffer3.prototype.readUint8 = Buffer3.prototype.readUInt8 = function readUInt8(offset, noAssert) {
      offset = offset >>> 0;
      if (!noAssert) checkOffset(offset, 1, this.length);
      return this[offset];
    };
    Buffer3.prototype.readUint16LE = Buffer3.prototype.readUInt16LE = function readUInt16LE(offset, noAssert) {
      offset = offset >>> 0;
      if (!noAssert) checkOffset(offset, 2, this.length);
      return this[offset] | this[offset + 1] << 8;
    };
    Buffer3.prototype.readUint16BE = Buffer3.prototype.readUInt16BE = function readUInt16BE(offset, noAssert) {
      offset = offset >>> 0;
      if (!noAssert) checkOffset(offset, 2, this.length);
      return this[offset] << 8 | this[offset + 1];
    };
    Buffer3.prototype.readUint32LE = Buffer3.prototype.readUInt32LE = function readUInt32LE(offset, noAssert) {
      offset = offset >>> 0;
      if (!noAssert) checkOffset(offset, 4, this.length);
      return (this[offset] | this[offset + 1] << 8 | this[offset + 2] << 16) + this[offset + 3] * 16777216;
    };
    Buffer3.prototype.readUint32BE = Buffer3.prototype.readUInt32BE = function readUInt32BE(offset, noAssert) {
      offset = offset >>> 0;
      if (!noAssert) checkOffset(offset, 4, this.length);
      return this[offset] * 16777216 + (this[offset + 1] << 16 | this[offset + 2] << 8 | this[offset + 3]);
    };
    Buffer3.prototype.readIntLE = function readIntLE(offset, byteLength2, noAssert) {
      offset = offset >>> 0;
      byteLength2 = byteLength2 >>> 0;
      if (!noAssert) checkOffset(offset, byteLength2, this.length);
      var val = this[offset];
      var mul = 1;
      var i2 = 0;
      while (++i2 < byteLength2 && (mul *= 256)) {
        val += this[offset + i2] * mul;
      }
      mul *= 128;
      if (val >= mul) val -= Math.pow(2, 8 * byteLength2);
      return val;
    };
    Buffer3.prototype.readIntBE = function readIntBE(offset, byteLength2, noAssert) {
      offset = offset >>> 0;
      byteLength2 = byteLength2 >>> 0;
      if (!noAssert) checkOffset(offset, byteLength2, this.length);
      var i2 = byteLength2;
      var mul = 1;
      var val = this[offset + --i2];
      while (i2 > 0 && (mul *= 256)) {
        val += this[offset + --i2] * mul;
      }
      mul *= 128;
      if (val >= mul) val -= Math.pow(2, 8 * byteLength2);
      return val;
    };
    Buffer3.prototype.readInt8 = function readInt8(offset, noAssert) {
      offset = offset >>> 0;
      if (!noAssert) checkOffset(offset, 1, this.length);
      if (!(this[offset] & 128)) return this[offset];
      return (255 - this[offset] + 1) * -1;
    };
    Buffer3.prototype.readInt16LE = function readInt16LE(offset, noAssert) {
      offset = offset >>> 0;
      if (!noAssert) checkOffset(offset, 2, this.length);
      var val = this[offset] | this[offset + 1] << 8;
      return val & 32768 ? val | 4294901760 : val;
    };
    Buffer3.prototype.readInt16BE = function readInt16BE(offset, noAssert) {
      offset = offset >>> 0;
      if (!noAssert) checkOffset(offset, 2, this.length);
      var val = this[offset + 1] | this[offset] << 8;
      return val & 32768 ? val | 4294901760 : val;
    };
    Buffer3.prototype.readInt32LE = function readInt32LE(offset, noAssert) {
      offset = offset >>> 0;
      if (!noAssert) checkOffset(offset, 4, this.length);
      return this[offset] | this[offset + 1] << 8 | this[offset + 2] << 16 | this[offset + 3] << 24;
    };
    Buffer3.prototype.readInt32BE = function readInt32BE(offset, noAssert) {
      offset = offset >>> 0;
      if (!noAssert) checkOffset(offset, 4, this.length);
      return this[offset] << 24 | this[offset + 1] << 16 | this[offset + 2] << 8 | this[offset + 3];
    };
    Buffer3.prototype.readFloatLE = function readFloatLE(offset, noAssert) {
      offset = offset >>> 0;
      if (!noAssert) checkOffset(offset, 4, this.length);
      return ieee754.read(this, offset, true, 23, 4);
    };
    Buffer3.prototype.readFloatBE = function readFloatBE(offset, noAssert) {
      offset = offset >>> 0;
      if (!noAssert) checkOffset(offset, 4, this.length);
      return ieee754.read(this, offset, false, 23, 4);
    };
    Buffer3.prototype.readDoubleLE = function readDoubleLE(offset, noAssert) {
      offset = offset >>> 0;
      if (!noAssert) checkOffset(offset, 8, this.length);
      return ieee754.read(this, offset, true, 52, 8);
    };
    Buffer3.prototype.readDoubleBE = function readDoubleBE(offset, noAssert) {
      offset = offset >>> 0;
      if (!noAssert) checkOffset(offset, 8, this.length);
      return ieee754.read(this, offset, false, 52, 8);
    };
    function checkInt(buf, value, offset, ext, max, min) {
      if (!Buffer3.isBuffer(buf)) throw new TypeError('"buffer" argument must be a Buffer instance');
      if (value > max || value < min) throw new RangeError('"value" argument is out of bounds');
      if (offset + ext > buf.length) throw new RangeError("Index out of range");
    }
    Buffer3.prototype.writeUintLE = Buffer3.prototype.writeUIntLE = function writeUIntLE(value, offset, byteLength2, noAssert) {
      value = +value;
      offset = offset >>> 0;
      byteLength2 = byteLength2 >>> 0;
      if (!noAssert) {
        var maxBytes = Math.pow(2, 8 * byteLength2) - 1;
        checkInt(this, value, offset, byteLength2, maxBytes, 0);
      }
      var mul = 1;
      var i2 = 0;
      this[offset] = value & 255;
      while (++i2 < byteLength2 && (mul *= 256)) {
        this[offset + i2] = value / mul & 255;
      }
      return offset + byteLength2;
    };
    Buffer3.prototype.writeUintBE = Buffer3.prototype.writeUIntBE = function writeUIntBE(value, offset, byteLength2, noAssert) {
      value = +value;
      offset = offset >>> 0;
      byteLength2 = byteLength2 >>> 0;
      if (!noAssert) {
        var maxBytes = Math.pow(2, 8 * byteLength2) - 1;
        checkInt(this, value, offset, byteLength2, maxBytes, 0);
      }
      var i2 = byteLength2 - 1;
      var mul = 1;
      this[offset + i2] = value & 255;
      while (--i2 >= 0 && (mul *= 256)) {
        this[offset + i2] = value / mul & 255;
      }
      return offset + byteLength2;
    };
    Buffer3.prototype.writeUint8 = Buffer3.prototype.writeUInt8 = function writeUInt8(value, offset, noAssert) {
      value = +value;
      offset = offset >>> 0;
      if (!noAssert) checkInt(this, value, offset, 1, 255, 0);
      this[offset] = value & 255;
      return offset + 1;
    };
    Buffer3.prototype.writeUint16LE = Buffer3.prototype.writeUInt16LE = function writeUInt16LE(value, offset, noAssert) {
      value = +value;
      offset = offset >>> 0;
      if (!noAssert) checkInt(this, value, offset, 2, 65535, 0);
      this[offset] = value & 255;
      this[offset + 1] = value >>> 8;
      return offset + 2;
    };
    Buffer3.prototype.writeUint16BE = Buffer3.prototype.writeUInt16BE = function writeUInt16BE(value, offset, noAssert) {
      value = +value;
      offset = offset >>> 0;
      if (!noAssert) checkInt(this, value, offset, 2, 65535, 0);
      this[offset] = value >>> 8;
      this[offset + 1] = value & 255;
      return offset + 2;
    };
    Buffer3.prototype.writeUint32LE = Buffer3.prototype.writeUInt32LE = function writeUInt32LE(value, offset, noAssert) {
      value = +value;
      offset = offset >>> 0;
      if (!noAssert) checkInt(this, value, offset, 4, 4294967295, 0);
      this[offset + 3] = value >>> 24;
      this[offset + 2] = value >>> 16;
      this[offset + 1] = value >>> 8;
      this[offset] = value & 255;
      return offset + 4;
    };
    Buffer3.prototype.writeUint32BE = Buffer3.prototype.writeUInt32BE = function writeUInt32BE(value, offset, noAssert) {
      value = +value;
      offset = offset >>> 0;
      if (!noAssert) checkInt(this, value, offset, 4, 4294967295, 0);
      this[offset] = value >>> 24;
      this[offset + 1] = value >>> 16;
      this[offset + 2] = value >>> 8;
      this[offset + 3] = value & 255;
      return offset + 4;
    };
    Buffer3.prototype.writeIntLE = function writeIntLE(value, offset, byteLength2, noAssert) {
      value = +value;
      offset = offset >>> 0;
      if (!noAssert) {
        var limit = Math.pow(2, 8 * byteLength2 - 1);
        checkInt(this, value, offset, byteLength2, limit - 1, -limit);
      }
      var i2 = 0;
      var mul = 1;
      var sub = 0;
      this[offset] = value & 255;
      while (++i2 < byteLength2 && (mul *= 256)) {
        if (value < 0 && sub === 0 && this[offset + i2 - 1] !== 0) {
          sub = 1;
        }
        this[offset + i2] = (value / mul >> 0) - sub & 255;
      }
      return offset + byteLength2;
    };
    Buffer3.prototype.writeIntBE = function writeIntBE(value, offset, byteLength2, noAssert) {
      value = +value;
      offset = offset >>> 0;
      if (!noAssert) {
        var limit = Math.pow(2, 8 * byteLength2 - 1);
        checkInt(this, value, offset, byteLength2, limit - 1, -limit);
      }
      var i2 = byteLength2 - 1;
      var mul = 1;
      var sub = 0;
      this[offset + i2] = value & 255;
      while (--i2 >= 0 && (mul *= 256)) {
        if (value < 0 && sub === 0 && this[offset + i2 + 1] !== 0) {
          sub = 1;
        }
        this[offset + i2] = (value / mul >> 0) - sub & 255;
      }
      return offset + byteLength2;
    };
    Buffer3.prototype.writeInt8 = function writeInt8(value, offset, noAssert) {
      value = +value;
      offset = offset >>> 0;
      if (!noAssert) checkInt(this, value, offset, 1, 127, -128);
      if (value < 0) value = 255 + value + 1;
      this[offset] = value & 255;
      return offset + 1;
    };
    Buffer3.prototype.writeInt16LE = function writeInt16LE(value, offset, noAssert) {
      value = +value;
      offset = offset >>> 0;
      if (!noAssert) checkInt(this, value, offset, 2, 32767, -32768);
      this[offset] = value & 255;
      this[offset + 1] = value >>> 8;
      return offset + 2;
    };
    Buffer3.prototype.writeInt16BE = function writeInt16BE(value, offset, noAssert) {
      value = +value;
      offset = offset >>> 0;
      if (!noAssert) checkInt(this, value, offset, 2, 32767, -32768);
      this[offset] = value >>> 8;
      this[offset + 1] = value & 255;
      return offset + 2;
    };
    Buffer3.prototype.writeInt32LE = function writeInt32LE(value, offset, noAssert) {
      value = +value;
      offset = offset >>> 0;
      if (!noAssert) checkInt(this, value, offset, 4, 2147483647, -2147483648);
      this[offset] = value & 255;
      this[offset + 1] = value >>> 8;
      this[offset + 2] = value >>> 16;
      this[offset + 3] = value >>> 24;
      return offset + 4;
    };
    Buffer3.prototype.writeInt32BE = function writeInt32BE(value, offset, noAssert) {
      value = +value;
      offset = offset >>> 0;
      if (!noAssert) checkInt(this, value, offset, 4, 2147483647, -2147483648);
      if (value < 0) value = 4294967295 + value + 1;
      this[offset] = value >>> 24;
      this[offset + 1] = value >>> 16;
      this[offset + 2] = value >>> 8;
      this[offset + 3] = value & 255;
      return offset + 4;
    };
    function checkIEEE754(buf, value, offset, ext, max, min) {
      if (offset + ext > buf.length) throw new RangeError("Index out of range");
      if (offset < 0) throw new RangeError("Index out of range");
    }
    function writeFloat(buf, value, offset, littleEndian, noAssert) {
      value = +value;
      offset = offset >>> 0;
      if (!noAssert) {
        checkIEEE754(buf, value, offset, 4, 34028234663852886e22, -34028234663852886e22);
      }
      ieee754.write(buf, value, offset, littleEndian, 23, 4);
      return offset + 4;
    }
    Buffer3.prototype.writeFloatLE = function writeFloatLE(value, offset, noAssert) {
      return writeFloat(this, value, offset, true, noAssert);
    };
    Buffer3.prototype.writeFloatBE = function writeFloatBE(value, offset, noAssert) {
      return writeFloat(this, value, offset, false, noAssert);
    };
    function writeDouble(buf, value, offset, littleEndian, noAssert) {
      value = +value;
      offset = offset >>> 0;
      if (!noAssert) {
        checkIEEE754(buf, value, offset, 8, 17976931348623157e292, -17976931348623157e292);
      }
      ieee754.write(buf, value, offset, littleEndian, 52, 8);
      return offset + 8;
    }
    Buffer3.prototype.writeDoubleLE = function writeDoubleLE(value, offset, noAssert) {
      return writeDouble(this, value, offset, true, noAssert);
    };
    Buffer3.prototype.writeDoubleBE = function writeDoubleBE(value, offset, noAssert) {
      return writeDouble(this, value, offset, false, noAssert);
    };
    Buffer3.prototype.copy = function copy(target, targetStart, start, end) {
      if (!Buffer3.isBuffer(target)) throw new TypeError("argument should be a Buffer");
      if (!start) start = 0;
      if (!end && end !== 0) end = this.length;
      if (targetStart >= target.length) targetStart = target.length;
      if (!targetStart) targetStart = 0;
      if (end > 0 && end < start) end = start;
      if (end === start) return 0;
      if (target.length === 0 || this.length === 0) return 0;
      if (targetStart < 0) {
        throw new RangeError("targetStart out of bounds");
      }
      if (start < 0 || start >= this.length) throw new RangeError("Index out of range");
      if (end < 0) throw new RangeError("sourceEnd out of bounds");
      if (end > this.length) end = this.length;
      if (target.length - targetStart < end - start) {
        end = target.length - targetStart + start;
      }
      var len = end - start;
      if (this === target && typeof Uint8Array.prototype.copyWithin === "function") {
        this.copyWithin(targetStart, start, end);
      } else {
        Uint8Array.prototype.set.call(
          target,
          this.subarray(start, end),
          targetStart
        );
      }
      return len;
    };
    Buffer3.prototype.fill = function fill(val, start, end, encoding) {
      if (typeof val === "string") {
        if (typeof start === "string") {
          encoding = start;
          start = 0;
          end = this.length;
        } else if (typeof end === "string") {
          encoding = end;
          end = this.length;
        }
        if (encoding !== void 0 && typeof encoding !== "string") {
          throw new TypeError("encoding must be a string");
        }
        if (typeof encoding === "string" && !Buffer3.isEncoding(encoding)) {
          throw new TypeError("Unknown encoding: " + encoding);
        }
        if (val.length === 1) {
          var code = val.charCodeAt(0);
          if (encoding === "utf8" && code < 128 || encoding === "latin1") {
            val = code;
          }
        }
      } else if (typeof val === "number") {
        val = val & 255;
      } else if (typeof val === "boolean") {
        val = Number(val);
      }
      if (start < 0 || this.length < start || this.length < end) {
        throw new RangeError("Out of range index");
      }
      if (end <= start) {
        return this;
      }
      start = start >>> 0;
      end = end === void 0 ? this.length : end >>> 0;
      if (!val) val = 0;
      var i2;
      if (typeof val === "number") {
        for (i2 = start; i2 < end; ++i2) {
          this[i2] = val;
        }
      } else {
        var bytes = Buffer3.isBuffer(val) ? val : Buffer3.from(val, encoding);
        var len = bytes.length;
        if (len === 0) {
          throw new TypeError('The value "' + val + '" is invalid for argument "value"');
        }
        for (i2 = 0; i2 < end - start; ++i2) {
          this[i2 + start] = bytes[i2 % len];
        }
      }
      return this;
    };
    var INVALID_BASE64_RE = /[^+/0-9A-Za-z-_]/g;
    function base64clean(str) {
      str = str.split("=")[0];
      str = str.trim().replace(INVALID_BASE64_RE, "");
      if (str.length < 2) return "";
      while (str.length % 4 !== 0) {
        str = str + "=";
      }
      return str;
    }
    function utf8ToBytes(string, units) {
      units = units || Infinity;
      var codePoint;
      var length = string.length;
      var leadSurrogate = null;
      var bytes = [];
      for (var i2 = 0; i2 < length; ++i2) {
        codePoint = string.charCodeAt(i2);
        if (codePoint > 55295 && codePoint < 57344) {
          if (!leadSurrogate) {
            if (codePoint > 56319) {
              if ((units -= 3) > -1) bytes.push(239, 191, 189);
              continue;
            } else if (i2 + 1 === length) {
              if ((units -= 3) > -1) bytes.push(239, 191, 189);
              continue;
            }
            leadSurrogate = codePoint;
            continue;
          }
          if (codePoint < 56320) {
            if ((units -= 3) > -1) bytes.push(239, 191, 189);
            leadSurrogate = codePoint;
            continue;
          }
          codePoint = (leadSurrogate - 55296 << 10 | codePoint - 56320) + 65536;
        } else if (leadSurrogate) {
          if ((units -= 3) > -1) bytes.push(239, 191, 189);
        }
        leadSurrogate = null;
        if (codePoint < 128) {
          if ((units -= 1) < 0) break;
          bytes.push(codePoint);
        } else if (codePoint < 2048) {
          if ((units -= 2) < 0) break;
          bytes.push(
            codePoint >> 6 | 192,
            codePoint & 63 | 128
          );
        } else if (codePoint < 65536) {
          if ((units -= 3) < 0) break;
          bytes.push(
            codePoint >> 12 | 224,
            codePoint >> 6 & 63 | 128,
            codePoint & 63 | 128
          );
        } else if (codePoint < 1114112) {
          if ((units -= 4) < 0) break;
          bytes.push(
            codePoint >> 18 | 240,
            codePoint >> 12 & 63 | 128,
            codePoint >> 6 & 63 | 128,
            codePoint & 63 | 128
          );
        } else {
          throw new Error("Invalid code point");
        }
      }
      return bytes;
    }
    function asciiToBytes(str) {
      var byteArray = [];
      for (var i2 = 0; i2 < str.length; ++i2) {
        byteArray.push(str.charCodeAt(i2) & 255);
      }
      return byteArray;
    }
    function utf16leToBytes(str, units) {
      var c2, hi, lo;
      var byteArray = [];
      for (var i2 = 0; i2 < str.length; ++i2) {
        if ((units -= 2) < 0) break;
        c2 = str.charCodeAt(i2);
        hi = c2 >> 8;
        lo = c2 % 256;
        byteArray.push(lo);
        byteArray.push(hi);
      }
      return byteArray;
    }
    function base64ToBytes(str) {
      return base64.toByteArray(base64clean(str));
    }
    function blitBuffer(src, dst, offset, length) {
      for (var i2 = 0; i2 < length; ++i2) {
        if (i2 + offset >= dst.length || i2 >= src.length) break;
        dst[i2 + offset] = src[i2];
      }
      return i2;
    }
    function isInstance(obj, type) {
      return obj instanceof type || obj != null && obj.constructor != null && obj.constructor.name != null && obj.constructor.name === type.name;
    }
    function numberIsNaN(obj) {
      return obj !== obj;
    }
    var hexSliceLookupTable = function() {
      var alphabet = "0123456789abcdef";
      var table = new Array(256);
      for (var i2 = 0; i2 < 16; ++i2) {
        var i16 = i2 * 16;
        for (var j = 0; j < 16; ++j) {
          table[i16 + j] = alphabet[i2] + alphabet[j];
        }
      }
      return table;
    }();
  }
});

// src/wasm/stdio-endpoint.ts
var stdio_endpoint_exports = {};
__export(stdio_endpoint_exports, {
  createStubEndpoint: () => createStubEndpoint
});
function createStubEndpoint() {
  let handler = null;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  const flushResponse = (response) => {
    if (!handler) {
      return;
    }
    const line = JSON.stringify(response) + "\n";
    handler(encoder.encode(line));
  };
  const handleRequestLine = (line) => {
    let request = null;
    try {
      request = JSON.parse(line);
    } catch (error2) {
      return;
    }
    if (!request?.id) {
      return;
    }
    flushResponse({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32e3,
        message: "WASM stdio endpoint not wired"
      }
    });
  };
  return {
    write(data) {
      buffer += decoder.decode(data, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          handleRequestLine(line);
        }
        newlineIndex = buffer.indexOf("\n");
      }
    },
    onData(nextHandler) {
      handler = nextHandler;
    }
  };
}
var init_stdio_endpoint = __esm({
  "src/wasm/stdio-endpoint.ts"() {
    "use strict";
  }
});

// src/wasm/session.ts
function createStdioEndpoint() {
  let handler = null;
  const stdinQueue = [];
  const endpoint = {
    write(data) {
      stdinQueue.push(data);
    },
    onData(nextHandler) {
      handler = nextHandler;
    }
  };
  const pushStdout = (data) => {
    handler?.(data);
  };
  const drainStdin = () => {
    if (stdinQueue.length === 0) {
      return new Uint8Array(0);
    }
    const total = stdinQueue.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    stdinQueue.forEach((chunk) => {
      merged.set(chunk, offset);
      offset += chunk.length;
    });
    stdinQueue.length = 0;
    return merged;
  };
  return {
    endpoint,
    pushStdout,
    drainStdin,
    close: () => {
      stdinQueue.length = 0;
      handler = null;
    }
  };
}
async function createWasmSession(manifest) {
  if (!("Buffer" in globalThis)) {
    globalThis.Buffer = import_buffer.Buffer;
  }
  if (!manifest.moduleUrl && !manifest.moduleBytesBase64) {
    const { createStubEndpoint: createStubEndpoint2 } = await Promise.resolve().then(() => (init_stdio_endpoint(), stdio_endpoint_exports));
    return {
      endpoint: createStubEndpoint2(),
      close: () => {
        console.log("[Harbor] Closing WASM session (stub)", manifest.id);
      }
    };
  }
  console.log("[Harbor] Initializing WASI runtime...");
  try {
    await n();
    console.log("[Harbor] WASI runtime initialized successfully");
  } catch (initError) {
    console.error("[Harbor] WASI init failed:", initError);
    throw initError;
  }
  let wasmUrl = manifest.moduleUrl;
  if (wasmUrl && !wasmUrl.startsWith("http") && !wasmUrl.startsWith("safari-web-extension:") && !wasmUrl.startsWith("moz-extension:") && !wasmUrl.startsWith("chrome-extension:")) {
    try {
      const browser2 = globalThis.browser;
      const chrome2 = globalThis.chrome;
      const runtime = browser2?.runtime || chrome2?.runtime;
      if (runtime?.getURL) {
        wasmUrl = runtime.getURL(wasmUrl);
        console.log("[Harbor] Resolved WASM URL:", wasmUrl);
      }
    } catch (e) {
      console.warn("[Harbor] Could not resolve WASM URL:", e);
    }
  }
  console.log("[Harbor] Loading WASM module from:", wasmUrl);
  const wasmBytes = manifest.moduleBytesBase64 ? Uint8Array.from(atob(manifest.moduleBytesBase64), (char) => char.charCodeAt(0)).buffer : await fetch(wasmUrl).then((response) => {
    console.log("[Harbor] WASM fetch response:", response.status, response.ok);
    if (!response.ok) {
      throw new Error(`Failed to fetch WASM module: ${response.status} from ${wasmUrl}`);
    }
    return response.arrayBuffer();
  });
  const wasmModule = await WebAssembly.compile(wasmBytes);
  const { endpoint, pushStdout, drainStdin, close } = createStdioEndpoint();
  const runOnce = async () => {
    const wasi = new s({
      args: [],
      env: {}
    });
    const instance = await wasi.instantiate(wasmModule, {});
    const stdinBuffer = drainStdin();
    if (stdinBuffer.length > 0) {
      wasi.setStdinBuffer(stdinBuffer);
    }
    wasi.start(instance);
    const stdout = wasi.getStdoutBuffer();
    if (stdout.length > 0) {
      pushStdout(stdout);
    }
    const stderr = wasi.getStderrBuffer();
    if (stderr.length > 0) {
      pushStdout(stderr);
    }
  };
  const originalWrite = endpoint.write.bind(endpoint);
  endpoint.write = (data) => {
    originalWrite(data);
    runOnce().catch((error2) => {
      console.error("[Harbor] WASM run failed", error2);
    });
  };
  return {
    endpoint,
    close: () => {
      close();
      console.log("[Harbor] Closing WASM session", manifest.id);
    }
  };
}
var import_buffer;
var init_session = __esm({
  "src/wasm/session.ts"() {
    "use strict";
    init_Library_esm_min();
    import_buffer = __toESM(require_buffer(), 1);
  }
});

// src/js-runtime/session.ts
async function loadServerCode(manifest) {
  if (manifest.scriptBase64) {
    return atob(manifest.scriptBase64);
  }
  if (manifest.scriptUrl) {
    const response = await fetch(manifest.scriptUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch JS server: ${response.status}`);
    }
    return response.text();
  }
  throw new Error("JS server manifest must have scriptUrl or scriptBase64");
}
async function fetchOAuthTokens(manifest) {
  if (!manifest.oauth) {
    return {};
  }
  const { provider, scopes, tokenEnvVar, refreshTokenEnvVar } = manifest.oauth;
  const statusResult = await bridgeRequest("oauth.status", { server_id: manifest.id });
  if (!statusResult.authenticated) {
    throw new Error(
      `Server "${manifest.name}" requires ${provider} authentication. Please sign in first.`
    );
  }
  if (statusResult.is_expired) {
    console.log("[Harbor] OAuth token expired for", manifest.id, "- refresh should happen automatically");
  }
  const tokensResult = await bridgeRequest("oauth.get_tokens", { server_id: manifest.id });
  if (!tokensResult.has_tokens || !tokensResult.access_token) {
    throw new Error(`OAuth tokens not found for server "${manifest.name}"`);
  }
  const oauthEnv = {
    [tokenEnvVar]: tokensResult.access_token
  };
  console.log("[Harbor] Injecting OAuth token into", tokenEnvVar);
  return oauthEnv;
}
async function createBridgeSession(manifest) {
  const code = await loadServerCode(manifest);
  const env = {};
  if (manifest.oauth) {
    const oauthEnv = await fetchOAuthTokens(manifest);
    Object.assign(env, oauthEnv);
  }
  const capabilities = {
    network: {
      allowed_hosts: manifest.capabilities?.network?.hosts || []
    },
    filesystem: {
      read_paths: [],
      write_paths: []
    }
  };
  await bridgeRequest("js.start_server", {
    id: manifest.id,
    code,
    env,
    capabilities
  });
  console.log("[Harbor] Started JS MCP server via bridge:", manifest.id);
  let handler = null;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const endpoint = {
    async write(data) {
      const jsonString = decoder.decode(data).trim();
      if (!jsonString) return;
      try {
        const request = JSON.parse(jsonString);
        const response = await bridgeRequest("js.call", {
          id: manifest.id,
          request
        });
        const responseData = encoder.encode(JSON.stringify(response) + "\n");
        handler?.(responseData);
      } catch (e) {
        console.error("[Harbor] Bridge JS call error:", e);
        try {
          const request = JSON.parse(jsonString);
          const errorResponse = {
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32e3, message: e instanceof Error ? e.message : "Unknown error" }
          };
          const responseData = encoder.encode(JSON.stringify(errorResponse) + "\n");
          handler?.(responseData);
        } catch {
        }
      }
    },
    onData(nextHandler) {
      handler = nextHandler;
    }
  };
  return {
    endpoint,
    close: async () => {
      try {
        await bridgeRequest("js.stop_server", { id: manifest.id });
        console.log("[Harbor] Stopped JS MCP server via bridge:", manifest.id);
      } catch (e) {
        console.warn("[Harbor] Failed to stop JS server:", e);
      }
      handler = null;
    }
  };
}
function createWorkerStdioEndpoint() {
  let handler = null;
  let worker = null;
  const encoder = new TextEncoder();
  const endpoint = {
    write(data) {
      const decoder = new TextDecoder();
      const jsonString = decoder.decode(data);
      if (worker) {
        worker.postMessage({ type: "stdin", data: jsonString });
      }
    },
    onData(nextHandler) {
      handler = nextHandler;
    }
  };
  const attachWorker = (w2) => {
    worker = w2;
    worker.addEventListener("message", (event) => {
      const data = event.data;
      if (!data) return;
      if (data.type === "stdout") {
        const encoded = encoder.encode(data.data + "\n");
        handler?.(encoded);
      } else if (data.type === "console") {
        const level = data.level;
        const args = data.args || [];
        console[level]?.("[JS MCP]", ...args);
      }
    });
  };
  return {
    endpoint,
    attachWorker,
    close: () => {
      handler = null;
      worker = null;
    }
  };
}
async function createBuiltinWorkerSession(manifest, workerPath) {
  const workerUrl = browserAPI.runtime.getURL(workerPath);
  const worker = new Worker(workerUrl);
  const { endpoint, attachWorker, close: closeEndpoint } = createWorkerStdioEndpoint();
  attachWorker(worker);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("JS server failed to initialize within timeout"));
    }, 5e3);
    const readyHandler = (event) => {
      if (event.data?.type === "ready") {
        clearTimeout(timeout);
        worker.removeEventListener("message", readyHandler);
        resolve();
      }
    };
    worker.addEventListener("message", readyHandler);
    worker.addEventListener("error", (e) => {
      clearTimeout(timeout);
      reject(new Error(`Worker error: ${e.message}`));
    });
  });
  if (manifest.secrets && Object.keys(manifest.secrets).length > 0) {
    worker.postMessage({ type: "init-env", env: manifest.secrets });
  }
  console.log("[Harbor] JS MCP server session started (builtin worker):", manifest.id);
  return {
    endpoint,
    close: () => {
      worker.postMessage({ type: "terminate" });
      setTimeout(() => worker.terminate(), 100);
      closeEndpoint();
      console.log("[Harbor] JS MCP server session closed:", manifest.id);
    }
  };
}
async function createJsSession(manifest) {
  if (manifest.runtime !== "js") {
    throw new Error(`Expected JS server, got runtime: ${manifest.runtime}`);
  }
  const bridgeState = getBridgeConnectionState();
  const builtinWorkerPath = BUILTIN_WORKER_MAP[manifest.id];
  if (bridgeState.connected && (!builtinWorkerPath || manifest.scriptBase64 || manifest.scriptUrl)) {
    try {
      return await createBridgeSession(manifest);
    } catch (e) {
      console.warn("[Harbor] Bridge session failed, trying fallback:", e);
    }
  }
  if (builtinWorkerPath) {
    try {
      return await createBuiltinWorkerSession(manifest, builtinWorkerPath);
    } catch (e) {
      console.warn("[Harbor] Builtin worker failed:", e);
    }
  }
  console.warn("[Harbor] Using stub implementation for JS server:", manifest.id);
  return createJsStubSession(manifest);
}
function createJsStubSession(manifest) {
  let handler = null;
  const encoder = new TextEncoder();
  const endpoint = {
    write(data) {
      const decoder = new TextDecoder();
      const json = decoder.decode(data);
      try {
        const request = JSON.parse(json.trim());
        let response;
        if (request.method === "tools/list") {
          response = {
            jsonrpc: "2.0",
            id: request.id,
            result: { tools: manifest.tools || [] }
          };
        } else if (request.method === "tools/call") {
          response = {
            jsonrpc: "2.0",
            id: request.id,
            result: {
              content: [
                { type: "text", text: "Stub response from JS MCP server" }
              ]
            }
          };
        } else {
          response = {
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32601, message: "Method not found" }
          };
        }
        const responseData = encoder.encode(JSON.stringify(response) + "\n");
        setTimeout(() => handler?.(responseData), 0);
      } catch (e) {
        console.error("[Harbor] Stub session parse error:", e);
      }
    },
    onData(nextHandler) {
      handler = nextHandler;
    }
  };
  return {
    endpoint,
    close: () => {
      handler = null;
      console.log("[Harbor] Closing JS stub session:", manifest.id);
    }
  };
}
var BUILTIN_WORKER_MAP;
var init_session2 = __esm({
  "src/js-runtime/session.ts"() {
    "use strict";
    init_browser_compat();
    init_bridge_client();
    BUILTIN_WORKER_MAP = {
      "echo-js": "dist/js-runtime/builtin-echo-worker.js"
    };
  }
});

// src/mcp/remote-transport.ts
var remote_transport_exports = {};
__export(remote_transport_exports, {
  McpSseTransport: () => McpSseTransport,
  McpWebSocketTransport: () => McpWebSocketTransport,
  createRemoteTransport: () => createRemoteTransport
});
function createRemoteTransport(options) {
  if (options.transport === "websocket") {
    return new McpWebSocketTransport(options);
  }
  return new McpSseTransport(options);
}
var McpSseTransport, McpWebSocketTransport;
var init_remote_transport = __esm({
  "src/mcp/remote-transport.ts"() {
    "use strict";
    McpSseTransport = class {
      constructor(options) {
        this.options = options;
        this.timeout = options.timeout ?? 3e4;
        this.autoReconnect = options.autoReconnect ?? true;
        this.maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
      }
      pending = /* @__PURE__ */ new Map();
      timeout;
      autoReconnect;
      maxReconnectAttempts;
      eventSource = null;
      state = "disconnected";
      reconnectAttempts = 0;
      sessionEndpoint = null;
      /**
       * Connect to the remote server.
       */
      async connect() {
        if (this.state === "connected" || this.state === "connecting") {
          return;
        }
        this.state = "connecting";
        return new Promise((resolve, reject) => {
          try {
            const url = new URL(this.options.url);
            this.eventSource = new EventSource(url.toString());
            this.eventSource.onopen = () => {
              console.log("[RemoteTransport] SSE connection opened:", url.toString());
              this.state = "connected";
              this.reconnectAttempts = 0;
              resolve();
            };
            this.eventSource.onerror = (error2) => {
              console.error("[RemoteTransport] SSE error:", error2);
              if (this.state === "connecting") {
                this.state = "error";
                reject(new Error("Failed to connect to remote server"));
              } else {
                this.handleDisconnect();
              }
            };
            this.eventSource.addEventListener("endpoint", (event) => {
              const data = JSON.parse(event.data);
              this.sessionEndpoint = data.endpoint;
              console.log("[RemoteTransport] Received session endpoint:", this.sessionEndpoint);
            });
            this.eventSource.addEventListener("message", (event) => {
              this.handleMessage(event.data);
            });
            this.eventSource.addEventListener("response", (event) => {
              this.handleMessage(event.data);
            });
          } catch (error2) {
            this.state = "error";
            reject(error2);
          }
        });
      }
      /**
       * Disconnect from the remote server.
       */
      disconnect() {
        if (this.eventSource) {
          this.eventSource.close();
          this.eventSource = null;
        }
        this.state = "disconnected";
        this.sessionEndpoint = null;
        for (const [id, pending] of this.pending.entries()) {
          clearTimeout(pending.timeoutId);
          pending.reject(new Error("Connection closed"));
          this.pending.delete(id);
        }
      }
      /**
       * Check if connected.
       */
      isConnected() {
        return this.state === "connected";
      }
      /**
       * Get connection state.
       */
      getState() {
        return this.state;
      }
      /**
       * Send a request to the remote server.
       */
      async send(request) {
        if (this.state !== "connected") {
          await this.connect();
        }
        const postUrl = this.sessionEndpoint || this.options.url;
        return new Promise((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            this.pending.delete(request.id);
            reject(new Error(`Request timed out after ${this.timeout}ms`));
          }, this.timeout);
          this.pending.set(request.id, { resolve, reject, timeoutId });
          this.postRequest(postUrl, request).catch((error2) => {
            this.pending.delete(request.id);
            clearTimeout(timeoutId);
            reject(error2);
          });
        });
      }
      /**
       * POST a request to the server.
       */
      async postRequest(url, request) {
        const headers = {
          "Content-Type": "application/json"
        };
        if (this.options.authHeader) {
          headers["Authorization"] = this.options.authHeader;
        }
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(request)
        });
        if (!response.ok) {
          throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
        }
        const contentType = response.headers.get("Content-Type");
        if (contentType?.includes("application/json")) {
          const data = await response.json();
          if (data && typeof data === "object" && "jsonrpc" in data) {
            this.handleMessage(JSON.stringify(data));
          }
        }
      }
      /**
       * Handle an incoming message from the event stream.
       */
      handleMessage(data) {
        let message;
        try {
          message = JSON.parse(data);
        } catch (error2) {
          console.error("[RemoteTransport] Failed to parse message:", error2);
          return;
        }
        if (!message?.id) {
          console.log("[RemoteTransport] Received notification:", message);
          return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) {
          console.warn("[RemoteTransport] Received response for unknown request:", message.id);
          return;
        }
        clearTimeout(pending.timeoutId);
        this.pending.delete(message.id);
        pending.resolve(message);
      }
      /**
       * Handle disconnection.
       */
      handleDisconnect() {
        this.state = "disconnected";
        if (this.autoReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay2 = Math.min(1e3 * Math.pow(2, this.reconnectAttempts), 3e4);
          console.log(`[RemoteTransport] Reconnecting in ${delay2}ms (attempt ${this.reconnectAttempts})`);
          setTimeout(() => {
            this.connect().catch((error2) => {
              console.error("[RemoteTransport] Reconnect failed:", error2);
            });
          }, delay2);
        }
      }
    };
    McpWebSocketTransport = class {
      constructor(options) {
        this.options = options;
        this.timeout = options.timeout ?? 3e4;
        this.autoReconnect = options.autoReconnect ?? true;
        this.maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
      }
      pending = /* @__PURE__ */ new Map();
      timeout;
      autoReconnect;
      maxReconnectAttempts;
      ws = null;
      state = "disconnected";
      reconnectAttempts = 0;
      /**
       * Connect to the remote server.
       */
      async connect() {
        if (this.state === "connected" || this.state === "connecting") {
          return;
        }
        this.state = "connecting";
        return new Promise((resolve, reject) => {
          try {
            const url = new URL(this.options.url);
            if (url.protocol === "http:") {
              url.protocol = "ws:";
            } else if (url.protocol === "https:") {
              url.protocol = "wss:";
            }
            this.ws = new WebSocket(url.toString());
            this.ws.onopen = () => {
              console.log("[RemoteTransport] WebSocket connection opened:", url.toString());
              this.state = "connected";
              this.reconnectAttempts = 0;
              resolve();
            };
            this.ws.onerror = (error2) => {
              console.error("[RemoteTransport] WebSocket error:", error2);
              if (this.state === "connecting") {
                this.state = "error";
                reject(new Error("Failed to connect to remote server"));
              }
            };
            this.ws.onclose = () => {
              console.log("[RemoteTransport] WebSocket closed");
              this.handleDisconnect();
            };
            this.ws.onmessage = (event) => {
              this.handleMessage(event.data);
            };
          } catch (error2) {
            this.state = "error";
            reject(error2);
          }
        });
      }
      /**
       * Disconnect from the remote server.
       */
      disconnect() {
        if (this.ws) {
          this.ws.close();
          this.ws = null;
        }
        this.state = "disconnected";
        for (const [id, pending] of this.pending.entries()) {
          clearTimeout(pending.timeoutId);
          pending.reject(new Error("Connection closed"));
          this.pending.delete(id);
        }
      }
      /**
       * Check if connected.
       */
      isConnected() {
        return this.state === "connected";
      }
      /**
       * Get connection state.
       */
      getState() {
        return this.state;
      }
      /**
       * Send a request to the remote server.
       */
      async send(request) {
        if (this.state !== "connected") {
          await this.connect();
        }
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          throw new Error("WebSocket not connected");
        }
        return new Promise((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            this.pending.delete(request.id);
            reject(new Error(`Request timed out after ${this.timeout}ms`));
          }, this.timeout);
          this.pending.set(request.id, { resolve, reject, timeoutId });
          try {
            this.ws.send(JSON.stringify(request));
          } catch (error2) {
            this.pending.delete(request.id);
            clearTimeout(timeoutId);
            reject(error2);
          }
        });
      }
      /**
       * Handle an incoming message.
       */
      handleMessage(data) {
        let message;
        try {
          message = JSON.parse(data);
        } catch (error2) {
          console.error("[RemoteTransport] Failed to parse message:", error2);
          return;
        }
        if (!message?.id) {
          console.log("[RemoteTransport] Received notification:", message);
          return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) {
          console.warn("[RemoteTransport] Received response for unknown request:", message.id);
          return;
        }
        clearTimeout(pending.timeoutId);
        this.pending.delete(message.id);
        pending.resolve(message);
      }
      /**
       * Handle disconnection.
       */
      handleDisconnect() {
        this.state = "disconnected";
        if (this.autoReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay2 = Math.min(1e3 * Math.pow(2, this.reconnectAttempts), 3e4);
          console.log(`[RemoteTransport] Reconnecting in ${delay2}ms (attempt ${this.reconnectAttempts})`);
          setTimeout(() => {
            this.connect().catch((error2) => {
              console.error("[RemoteTransport] Reconnect failed:", error2);
            });
          }, delay2);
        }
      }
    };
  }
});

// src/wasm/runtime.ts
var runtime_exports = {};
__export(runtime_exports, {
  callMcpMethod: () => callMcpMethod,
  callMcpTool: () => callMcpTool,
  callWasmTool: () => callWasmTool,
  getMcpServer: () => getMcpServer,
  getRemoteServerStatus: () => getRemoteServerStatus,
  getWasmServer: () => getWasmServer,
  initializeMcpRuntime: () => initializeMcpRuntime,
  initializeWasmRuntime: () => initializeWasmRuntime,
  isRemoteServer: () => isRemoteServer,
  listMcpServers: () => listMcpServers,
  listRunningServerIds: () => listRunningServerIds,
  listWasmServers: () => listWasmServers,
  registerMcpServer: () => registerMcpServer,
  registerWasmServer: () => registerWasmServer,
  startMcpServer: () => startMcpServer,
  startWasmServer: () => startWasmServer,
  stopMcpServer: () => stopMcpServer,
  stopWasmServer: () => stopWasmServer,
  unregisterMcpServer: () => unregisterMcpServer,
  unregisterWasmServer: () => unregisterWasmServer
});
function initializeMcpRuntime() {
  console.log("[Harbor] MCP runtime initialized (WASM + JS support)");
}
function registerMcpServer(manifest) {
  const existing = runningServers.get(manifest.id);
  if (existing) {
    (existing.manifest.tools || []).forEach((tool) => {
      toolIndex.delete(`${manifest.id}:${tool.name}`);
    });
  }
  const handle = { id: manifest.id, manifest };
  runningServers.set(handle.id, handle);
  (manifest.tools || []).forEach((tool) => {
    const key = `${manifest.id}:${tool.name}`;
    toolIndex.set(key, { serverId: manifest.id, name: tool.name });
  });
  return handle;
}
function listMcpServers() {
  return Array.from(runningServers.values());
}
function getMcpServer(serverId) {
  return runningServers.get(serverId);
}
function listRunningServerIds() {
  return Array.from(activeSessions.keys());
}
function unregisterMcpServer(serverId) {
  const existing = runningServers.get(serverId);
  if (existing) {
    (existing.manifest.tools || []).forEach((tool) => {
      toolIndex.delete(`${serverId}:${tool.name}`);
    });
  }
  runningServers.delete(serverId);
  const session = activeSessions.get(serverId);
  session?.close();
  activeSessions.delete(serverId);
}
function getServerRuntime(manifest) {
  if (manifest.runtime) {
    return manifest.runtime;
  }
  if (manifest.remoteUrl) {
    return "remote";
  }
  if (manifest.scriptUrl || manifest.scriptBase64) {
    return "js";
  }
  return "wasm";
}
async function startMcpServer(serverId) {
  const handle = runningServers.get(serverId);
  if (!handle) {
    return false;
  }
  if (activeSessions.has(serverId)) {
    return true;
  }
  const runtime = getServerRuntime(handle.manifest);
  try {
    if (runtime === "remote") {
      if (!handle.manifest.remoteUrl) {
        throw new Error("Remote server missing remoteUrl");
      }
      const transport = createRemoteTransport({
        url: handle.manifest.remoteUrl,
        transport: handle.manifest.remoteTransport || "sse",
        authHeader: handle.manifest.remoteAuthHeader
      });
      await transport.connect();
      remoteTransports.set(serverId, transport);
      activeSessions.set(serverId, {
        transport,
        close: () => transport.disconnect()
      });
      console.log("[Harbor] Connected to remote MCP server:", serverId);
    } else if (runtime === "js") {
      const session = await createJsSession({
        ...handle.manifest,
        runtime: "js"
      });
      activeSessions.set(serverId, {
        transport: new McpStdioTransport(session.endpoint),
        close: session.close
      });
      console.log("[Harbor] Started JS MCP server:", serverId);
    } else {
      const session = await createWasmSession(handle.manifest);
      activeSessions.set(serverId, {
        transport: new McpStdioTransport(session.endpoint),
        close: session.close
      });
      console.log("[Harbor] Started WASM MCP server:", serverId);
    }
    await syncToolsToBridge(serverId, handle.manifest);
    return true;
  } catch (error2) {
    console.error(`[Harbor] Failed to start ${runtime} MCP server:`, error2);
    return false;
  }
}
async function syncToolsToBridge(serverId, manifest) {
  if (!isNativeBridgeReady()) {
    return;
  }
  const tools = manifest.tools || [];
  if (tools.length === 0) {
    return;
  }
  try {
    await rpcRequest("mcp.register_tools", {
      server_id: serverId,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema
      }))
    });
    console.log(`[Harbor] Synced ${tools.length} tools to bridge for ${serverId}`);
  } catch (err) {
    console.warn("[Harbor] Failed to sync tools to bridge:", err);
  }
}
function stopMcpServer(serverId) {
  if (!runningServers.has(serverId)) {
    return false;
  }
  const session = activeSessions.get(serverId);
  session?.close();
  activeSessions.delete(serverId);
  remoteTransports.delete(serverId);
  unsyncToolsFromBridge(serverId);
  console.log("[Harbor] Stopped MCP server:", serverId);
  return true;
}
function unsyncToolsFromBridge(serverId) {
  if (!isNativeBridgeReady()) {
    return;
  }
  rpcRequest("mcp.unregister_tools", { server_id: serverId }).then(() => console.log(`[Harbor] Unsynced tools from bridge for ${serverId}`)).catch(() => {
  });
}
function getRemoteServerStatus(serverId) {
  const transport = remoteTransports.get(serverId);
  if (!transport) {
    return "disconnected";
  }
  return transport.getState();
}
function isRemoteServer(serverId) {
  const handle = runningServers.get(serverId);
  if (!handle) {
    return false;
  }
  return getServerRuntime(handle.manifest) === "remote";
}
function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("MCP request timed out"));
    }, timeoutMs);
    promise.then((result) => {
      clearTimeout(timer);
      resolve(result);
    }).catch((error2) => {
      clearTimeout(timer);
      reject(error2);
    });
  });
}
async function callMcpMethod(serverId, method, params) {
  const handle = runningServers.get(serverId);
  if (!handle) {
    return {
      jsonrpc: "2.0",
      id: "missing",
      error: { code: -32e3, message: "Server not found" }
    };
  }
  const session = activeSessions.get(serverId);
  if (!session) {
    return {
      jsonrpc: "2.0",
      id: "missing",
      error: { code: -32e3, message: "Server not started" }
    };
  }
  const requestId = crypto.randomUUID();
  const request = {
    jsonrpc: "2.0",
    id: requestId,
    method,
    params
  };
  try {
    return await withTimeout(session.transport.send(request), 1e4);
  } catch (error2) {
    const message = error2 instanceof Error ? error2.message : String(error2);
    return {
      jsonrpc: "2.0",
      id: requestId,
      error: { code: -32001, message }
    };
  }
}
async function callMcpTool(serverId, toolName, args) {
  const handle = runningServers.get(serverId);
  if (!handle) {
    return { ok: false, error: "Server not found" };
  }
  const key = `${serverId}:${toolName}`;
  if (!toolIndex.has(key)) {
    return { ok: false, error: `Tool not found: ${toolName}` };
  }
  const session = activeSessions.get(serverId);
  if (!session) {
    return { ok: false, error: "Server not started" };
  }
  const requestId = crypto.randomUUID();
  const params = { name: toolName, arguments: args };
  const request = {
    jsonrpc: "2.0",
    id: requestId,
    method: "tools/call",
    params
  };
  try {
    const response = await withTimeout(
      session.transport.send(request),
      1e4
    );
    if (response.error) {
      return { ok: false, error: response.error.message };
    }
    return {
      ok: true,
      result: response.result
    };
  } catch (error2) {
    const message = error2 instanceof Error ? error2.message : String(error2);
    return { ok: false, error: message };
  }
}
var runningServers, toolIndex, activeSessions, remoteTransports, initializeWasmRuntime, registerWasmServer, listWasmServers, getWasmServer, unregisterWasmServer, startWasmServer, stopWasmServer, callWasmTool;
var init_runtime = __esm({
  "src/wasm/runtime.ts"() {
    "use strict";
    init_stdio_transport();
    init_session();
    init_session2();
    init_remote_transport();
    init_native_bridge();
    runningServers = /* @__PURE__ */ new Map();
    toolIndex = /* @__PURE__ */ new Map();
    activeSessions = /* @__PURE__ */ new Map();
    remoteTransports = /* @__PURE__ */ new Map();
    initializeWasmRuntime = initializeMcpRuntime;
    registerWasmServer = registerMcpServer;
    listWasmServers = listMcpServers;
    getWasmServer = getMcpServer;
    unregisterWasmServer = unregisterMcpServer;
    startWasmServer = startMcpServer;
    stopWasmServer = stopMcpServer;
    callWasmTool = callMcpTool;
  }
});

// src/sessions/types.ts
function getDefaultImplicitCapabilities() {
  return {
    llm: {
      allowed: true
      // provider/model inherited from user's default
    },
    tools: {
      allowed: false,
      allowedTools: []
    },
    browser: {
      readActiveTab: false,
      interact: false,
      screenshot: false
    }
  };
}
function buildCapabilitiesFromRequest(request, allowedTools = []) {
  return {
    llm: {
      allowed: request.llm !== void 0,
      provider: request.llm?.provider,
      model: request.llm?.model
    },
    tools: {
      allowed: (request.tools?.length ?? 0) > 0,
      allowedTools: request.tools?.filter((t) => allowedTools.includes(t)) ?? []
    },
    browser: {
      readActiveTab: request.browser?.includes("read") ?? false,
      interact: request.browser?.includes("interact") ?? false,
      screenshot: request.browser?.includes("screenshot") ?? false
    }
  };
}
var init_types = __esm({
  "src/sessions/types.ts"() {
    "use strict";
  }
});

// src/sessions/registry.ts
var SessionRegistryImpl, SessionRegistry;
var init_registry = __esm({
  "src/sessions/registry.ts"() {
    "use strict";
    init_types();
    SessionRegistryImpl = class {
      sessions = /* @__PURE__ */ new Map();
      listeners = /* @__PURE__ */ new Set();
      // Cleanup interval (10 minutes)
      cleanupIntervalId = null;
      SESSION_MAX_AGE_MS = 60 * 60 * 1e3;
      // 1 hour default
      constructor() {
        this.startCleanupInterval();
      }
      // ===========================================================================
      // Session Creation
      // ===========================================================================
      /**
       * Create an implicit session (from ai.createTextSession).
       * These have default capabilities (LLM only, no tools/browser).
       */
      createImplicitSession(origin, options = {}, tabId) {
        const sessionId = crypto.randomUUID();
        const now = Date.now();
        const session = {
          sessionId,
          type: "implicit",
          origin,
          tabId,
          status: "active",
          createdAt: now,
          lastActiveAt: now,
          capabilities: getDefaultImplicitCapabilities(),
          history: [],
          options,
          usage: {
            promptCount: 0,
            toolCallCount: 0
          }
        };
        this.sessions.set(sessionId, session);
        this.emit({ type: "session_created", session: this.toSummary(session) });
        console.log("[SessionRegistry] Created implicit session:", sessionId, "for", origin);
        return session;
      }
      /**
       * Create an explicit session (from agent.sessions.create).
       * Capabilities are specified by the caller and bounded by origin permissions.
       */
      createExplicitSession(origin, request, allowedTools = [], tabId) {
        const sessionId = crypto.randomUUID();
        const now = Date.now();
        const capabilities = buildCapabilitiesFromRequest(request.capabilities, allowedTools);
        if (request.limits) {
          capabilities.limits = {
            maxToolCalls: request.limits.maxToolCalls,
            expiresAt: request.limits.ttlMinutes ? now + request.limits.ttlMinutes * 60 * 1e3 : void 0
          };
        }
        const session = {
          sessionId,
          type: "explicit",
          origin,
          tabId,
          status: "active",
          createdAt: now,
          lastActiveAt: now,
          capabilities,
          name: request.name,
          reason: request.reason,
          history: [],
          options: request.options || {},
          usage: {
            promptCount: 0,
            toolCallCount: 0
          }
        };
        this.sessions.set(sessionId, session);
        this.emit({ type: "session_created", session: this.toSummary(session) });
        console.log("[SessionRegistry] Created explicit session:", sessionId, "for", origin, {
          name: request.name,
          capabilities
        });
        return {
          success: true,
          sessionId,
          capabilities
        };
      }
      // ===========================================================================
      // Session Retrieval
      // ===========================================================================
      /**
       * Get a session by ID.
       */
      getSession(sessionId) {
        return this.sessions.get(sessionId);
      }
      /**
       * Get a session by ID, validating it belongs to the origin.
       * Throws if session not found or origin mismatch.
       */
      getValidatedSession(sessionId, origin) {
        const session = this.sessions.get(sessionId);
        if (!session) {
          throw Object.assign(new Error("Session not found"), { code: "ERR_SESSION_NOT_FOUND" });
        }
        if (session.origin !== origin) {
          throw Object.assign(new Error("Session belongs to different origin"), {
            code: "ERR_PERMISSION_DENIED"
          });
        }
        if (session.status === "terminated") {
          throw Object.assign(new Error("Session has been terminated"), {
            code: "ERR_SESSION_NOT_FOUND"
          });
        }
        if (session.capabilities.limits?.expiresAt && Date.now() > session.capabilities.limits.expiresAt) {
          this.terminateSession(sessionId, origin);
          throw Object.assign(new Error("Session has expired"), { code: "ERR_SESSION_NOT_FOUND" });
        }
        return session;
      }
      /**
       * List sessions with optional filters.
       */
      listSessions(options = {}) {
        const results = [];
        for (const session of this.sessions.values()) {
          if (options.origin && session.origin !== options.origin) continue;
          if (options.status && session.status !== options.status) continue;
          if (options.type && session.type !== options.type) continue;
          if (options.activeOnly && session.status !== "active") continue;
          results.push(this.toSummary(session));
        }
        results.sort((a2, b2) => b2.lastActiveAt - a2.lastActiveAt);
        return results;
      }
      /**
       * Get all sessions for an origin.
       */
      getSessionsForOrigin(origin) {
        const results = [];
        for (const session of this.sessions.values()) {
          if (session.origin === origin && session.status === "active") {
            results.push(session);
          }
        }
        return results;
      }
      // ===========================================================================
      // Session Operations
      // ===========================================================================
      /**
       * Update session's last active time.
       */
      touchSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
          session.lastActiveAt = Date.now();
        }
      }
      /**
       * Record a prompt in the session.
       */
      recordPrompt(sessionId, userMessage, assistantMessage) {
        const session = this.sessions.get(sessionId);
        if (!session) return;
        session.history.push({ role: "user", content: userMessage });
        session.history.push({ role: "assistant", content: assistantMessage });
        session.usage.promptCount++;
        session.lastActiveAt = Date.now();
        this.emit({
          type: "session_capability_used",
          sessionId,
          capability: "llm"
        });
      }
      /**
       * Record a tool call in the session.
       */
      recordToolCall(sessionId, toolName) {
        const session = this.sessions.get(sessionId);
        if (!session) return false;
        if (session.capabilities.limits?.maxToolCalls && session.usage.toolCallCount >= session.capabilities.limits.maxToolCalls) {
          return false;
        }
        session.usage.toolCallCount++;
        session.lastActiveAt = Date.now();
        this.emit({
          type: "session_capability_used",
          sessionId,
          capability: "tool",
          detail: toolName
        });
        return true;
      }
      /**
       * Record browser API usage in the session.
       */
      recordBrowserAccess(sessionId, action) {
        const session = this.sessions.get(sessionId);
        if (!session) return;
        session.lastActiveAt = Date.now();
        this.emit({
          type: "session_capability_used",
          sessionId,
          capability: "browser",
          detail: action
        });
      }
      /**
       * Add a message to session history.
       */
      addToHistory(sessionId, message) {
        const session = this.sessions.get(sessionId);
        if (session) {
          session.history.push(message);
          session.lastActiveAt = Date.now();
        }
      }
      /**
       * Get session history.
       */
      getHistory(sessionId) {
        const session = this.sessions.get(sessionId);
        return session?.history ?? [];
      }
      // ===========================================================================
      // Session Lifecycle
      // ===========================================================================
      /**
       * Terminate a session.
       */
      terminateSession(sessionId, origin) {
        const session = this.sessions.get(sessionId);
        if (!session || session.origin !== origin) {
          return false;
        }
        session.status = "terminated";
        this.emit({ type: "session_terminated", sessionId, origin });
        console.log("[SessionRegistry] Terminated session:", sessionId);
        return true;
      }
      /**
       * Destroy a session completely (remove from registry).
       */
      destroySession(sessionId, origin) {
        const session = this.sessions.get(sessionId);
        if (!session || session.origin !== origin) {
          return false;
        }
        this.sessions.delete(sessionId);
        this.emit({ type: "session_terminated", sessionId, origin });
        console.log("[SessionRegistry] Destroyed session:", sessionId);
        return true;
      }
      /**
       * Clone a session (creates a new session with same options but fresh history).
       */
      cloneSession(sessionId, origin) {
        const session = this.sessions.get(sessionId);
        if (!session || session.origin !== origin) {
          return null;
        }
        if (session.type === "implicit") {
          const newSession = this.createImplicitSession(origin, session.options, session.tabId);
          return newSession.sessionId;
        } else {
          const result = this.createExplicitSession(
            origin,
            {
              name: session.name ? `${session.name} (copy)` : void 0,
              reason: session.reason,
              capabilities: {
                llm: session.capabilities.llm.allowed ? { provider: session.capabilities.llm.provider, model: session.capabilities.llm.model } : void 0,
                tools: session.capabilities.tools.allowedTools,
                browser: [
                  ...session.capabilities.browser.readActiveTab ? ["read"] : [],
                  ...session.capabilities.browser.interact ? ["interact"] : [],
                  ...session.capabilities.browser.screenshot ? ["screenshot"] : []
                ]
              },
              limits: session.capabilities.limits ? {
                maxToolCalls: session.capabilities.limits.maxToolCalls,
                ttlMinutes: session.capabilities.limits.expiresAt ? Math.ceil((session.capabilities.limits.expiresAt - Date.now()) / 6e4) : void 0
              } : void 0,
              options: session.options
            },
            session.capabilities.tools.allowedTools,
            session.tabId
          );
          return result.sessionId || null;
        }
      }
      // ===========================================================================
      // Capability Checking
      // ===========================================================================
      /**
       * Check if a session can use LLM.
       */
      canUseLLM(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session || session.status !== "active") return false;
        return session.capabilities.llm.allowed;
      }
      /**
       * Check if a session can call a specific tool.
       */
      canCallTool(sessionId, toolName) {
        const session = this.sessions.get(sessionId);
        if (!session || session.status !== "active") return false;
        if (!session.capabilities.tools.allowed) return false;
        return session.capabilities.tools.allowedTools.includes(toolName);
      }
      /**
       * Check if a session can use a browser API.
       */
      canUseBrowser(sessionId, action) {
        const session = this.sessions.get(sessionId);
        if (!session || session.status !== "active") return false;
        switch (action) {
          case "read":
            return session.capabilities.browser.readActiveTab;
          case "interact":
            return session.capabilities.browser.interact;
          case "screenshot":
            return session.capabilities.browser.screenshot;
          default:
            return false;
        }
      }
      /**
       * Get remaining tool call budget for a session.
       */
      getRemainingToolBudget(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return void 0;
        const limit = session.capabilities.limits?.maxToolCalls;
        if (limit === void 0) return void 0;
        return Math.max(0, limit - session.usage.toolCallCount);
      }
      // ===========================================================================
      // Event System
      // ===========================================================================
      /**
       * Subscribe to session events.
       */
      subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      }
      emit(event) {
        for (const listener of this.listeners) {
          try {
            listener(event);
          } catch (err) {
            console.error("[SessionRegistry] Event listener error:", err);
          }
        }
      }
      // ===========================================================================
      // Cleanup
      // ===========================================================================
      startCleanupInterval() {
        if (this.cleanupIntervalId) return;
        this.cleanupIntervalId = setInterval(() => {
          this.cleanupOldSessions();
        }, 10 * 60 * 1e3);
      }
      cleanupOldSessions() {
        const now = Date.now();
        const sessionsToRemove = [];
        for (const [sessionId, session] of this.sessions) {
          if (session.status === "terminated" && now - session.lastActiveAt > 5 * 60 * 1e3) {
            sessionsToRemove.push(sessionId);
            continue;
          }
          if (session.capabilities.limits?.expiresAt && now > session.capabilities.limits.expiresAt) {
            session.status = "terminated";
            this.emit({ type: "session_terminated", sessionId, origin: session.origin });
            continue;
          }
          if (now - session.lastActiveAt > this.SESSION_MAX_AGE_MS) {
            sessionsToRemove.push(sessionId);
          }
        }
        for (const sessionId of sessionsToRemove) {
          this.sessions.delete(sessionId);
        }
        if (sessionsToRemove.length > 0) {
          console.log("[SessionRegistry] Cleaned up", sessionsToRemove.length, "old sessions");
        }
      }
      // ===========================================================================
      // Utilities
      // ===========================================================================
      toSummary(session) {
        return {
          sessionId: session.sessionId,
          type: session.type,
          origin: session.origin,
          status: session.status,
          name: session.name,
          createdAt: session.createdAt,
          lastActiveAt: session.lastActiveAt,
          capabilities: {
            hasLLM: session.capabilities.llm.allowed,
            toolCount: session.capabilities.tools.allowedTools.length,
            hasBrowserAccess: session.capabilities.browser.readActiveTab || session.capabilities.browser.interact || session.capabilities.browser.screenshot
          },
          usage: session.usage
        };
      }
      /**
       * Get statistics about the registry.
       */
      getStats() {
        const stats = {
          totalSessions: this.sessions.size,
          activeSessions: 0,
          sessionsByOrigin: {},
          sessionsByType: { implicit: 0, explicit: 0 }
        };
        for (const session of this.sessions.values()) {
          if (session.status === "active") {
            stats.activeSessions++;
          }
          stats.sessionsByOrigin[session.origin] = (stats.sessionsByOrigin[session.origin] || 0) + 1;
          stats.sessionsByType[session.type]++;
        }
        return stats;
      }
    };
    SessionRegistry = new SessionRegistryImpl();
  }
});

// src/policy/permissions.ts
var permissions_exports = {};
__export(permissions_exports, {
  SCOPE_DESCRIPTIONS: () => SCOPE_DESCRIPTIONS,
  checkPermissions: () => checkPermissions,
  checkSessionCapability: () => checkSessionCapability,
  checkSessionToolAccess: () => checkSessionToolAccess,
  cleanupExpiredGrants: () => cleanupExpiredGrants,
  denyPermissions: () => denyPermissions,
  getPermissionStatus: () => getPermissionStatus,
  grantPermissions: () => grantPermissions,
  handlePermissionPromptResponse: () => handlePermissionPromptResponse,
  isToolAllowed: () => isToolAllowed,
  listAllPermissions: () => listAllPermissions,
  requestPermissions: () => requestPermissions,
  requestSessionPermissions: () => requestSessionPermissions,
  revokePermissions: () => revokePermissions,
  showPermissionPrompt: () => showPermissionPrompt,
  validateSessionCapabilities: () => validateSessionCapabilities
});
async function loadOriginPermissions(origin) {
  const result = await browserAPI.storage.local.get(PERMISSIONS_STORAGE_KEY);
  const allPermissions = result[PERMISSIONS_STORAGE_KEY] || {};
  return allPermissions[origin] || null;
}
async function saveOriginPermissions(permissions) {
  const result = await browserAPI.storage.local.get(PERMISSIONS_STORAGE_KEY);
  const allPermissions = result[PERMISSIONS_STORAGE_KEY] || {};
  allPermissions[permissions.origin] = permissions;
  await browserAPI.storage.local.set({ [PERMISSIONS_STORAGE_KEY]: allPermissions });
}
async function getAllOriginPermissions() {
  const result = await browserAPI.storage.local.get(PERMISSIONS_STORAGE_KEY);
  return result[PERMISSIONS_STORAGE_KEY] || {};
}
function isGrantValid(stored, tabId) {
  if (stored.grant === "denied" || stored.grant === "not-granted") {
    return true;
  }
  if (stored.grant === "granted-always") {
    return true;
  }
  if (stored.grant === "granted-once") {
    if (stored.expiresAt && Date.now() > stored.expiresAt) {
      return false;
    }
    if (stored.tabId !== void 0 && tabId !== void 0 && stored.tabId !== tabId) {
      return false;
    }
    return true;
  }
  return false;
}
function getEffectiveGrant(stored, tabId) {
  if (!stored) {
    return "not-granted";
  }
  if (!isGrantValid(stored, tabId)) {
    return "not-granted";
  }
  return stored.grant;
}
async function getPermissionStatus(origin, tabId) {
  const stored = await loadOriginPermissions(origin);
  const scopes = {
    // Extension 1: Core AI & MCP
    "model:prompt": "not-granted",
    "model:tools": "not-granted",
    "model:list": "not-granted",
    "mcp:tools.list": "not-granted",
    "mcp:tools.call": "not-granted",
    "mcp:servers.register": "not-granted",
    // Extension 1: Browser (same-tab)
    "browser:activeTab.read": "not-granted",
    "browser:activeTab.interact": "not-granted",
    "browser:activeTab.screenshot": "not-granted",
    // Extension 2: Navigation and Tabs
    "browser:navigate": "not-granted",
    "browser:tabs.read": "not-granted",
    "browser:tabs.create": "not-granted",
    // Extension 2: Web Fetch
    "web:fetch": "not-granted",
    // Other
    "chat:open": "not-granted",
    "addressBar:suggest": "not-granted",
    "addressBar:context": "not-granted",
    "addressBar:history": "not-granted",
    "addressBar:execute": "not-granted",
    // Extension 3: Multi-Agent (reserved)
    "agents:register": "not-granted",
    "agents:discover": "not-granted",
    "agents:invoke": "not-granted",
    "agents:message": "not-granted",
    "agents:crossOrigin": "not-granted",
    "agents:remote": "not-granted"
  };
  if (stored) {
    for (const scope of Object.keys(scopes)) {
      scopes[scope] = getEffectiveGrant(stored.scopes[scope], tabId);
    }
  }
  return {
    origin,
    scopes,
    allowedTools: stored?.allowedTools
  };
}
async function checkPermissions(origin, requiredScopes, tabId) {
  console.log("[Permissions] checkPermissions called - origin:", origin, "scopes:", requiredScopes, "tabId:", tabId);
  const status = await getPermissionStatus(origin, tabId);
  console.log("[Permissions] Status for", origin, ":", JSON.stringify(status.scopes));
  const missingScopes = [];
  const deniedScopes = [];
  for (const scope of requiredScopes) {
    const grant = status.scopes[scope];
    console.log("[Permissions] Scope", scope, "=", grant);
    if (grant === "denied") {
      deniedScopes.push(scope);
    } else if (grant === "not-granted") {
      missingScopes.push(scope);
    }
  }
  const result = {
    granted: missingScopes.length === 0 && deniedScopes.length === 0,
    missingScopes,
    deniedScopes
  };
  console.log("[Permissions] checkPermissions result:", result);
  return result;
}
async function isToolAllowed(origin, toolName) {
  const stored = await loadOriginPermissions(origin);
  if (!stored) return false;
  const toolsGrant = getEffectiveGrant(stored.scopes["mcp:tools.call"]);
  if (toolsGrant !== "granted-always" && toolsGrant !== "granted-once") {
    return false;
  }
  return stored.allowedTools.includes(toolName);
}
async function grantPermissions(origin, scopes, grantType, tabId, allowedTools) {
  console.log("[Permissions] grantPermissions:", { origin, scopes, grantType, tabId, allowedTools });
  let stored = await loadOriginPermissions(origin);
  if (!stored) {
    stored = {
      origin,
      scopes: {},
      allowedTools: []
    };
  }
  const now = Date.now();
  for (const scope of scopes) {
    stored.scopes[scope] = {
      grant: grantType,
      grantedAt: now,
      expiresAt: grantType === "granted-once" ? now + ONCE_GRANT_DURATION_MS : void 0,
      tabId: grantType === "granted-once" ? tabId : void 0
    };
  }
  if (allowedTools && allowedTools.length > 0) {
    const toolSet = /* @__PURE__ */ new Set([...stored.allowedTools, ...allowedTools]);
    stored.allowedTools = Array.from(toolSet);
  }
  await saveOriginPermissions(stored);
  console.log("[Permissions] Saved permissions for", origin);
  browserAPI.runtime.sendMessage({ type: "permissions_changed" }).catch(() => {
  });
  const resultScopes = {};
  for (const scope of Object.keys(stored.scopes)) {
    resultScopes[scope] = getEffectiveGrant(stored.scopes[scope], tabId);
  }
  return {
    granted: true,
    scopes: resultScopes,
    allowedTools: stored.allowedTools
  };
}
async function denyPermissions(origin, scopes) {
  let stored = await loadOriginPermissions(origin);
  if (!stored) {
    stored = {
      origin,
      scopes: {},
      allowedTools: []
    };
  }
  const now = Date.now();
  for (const scope of scopes) {
    stored.scopes[scope] = {
      grant: "denied",
      grantedAt: now
    };
  }
  await saveOriginPermissions(stored);
  const resultScopes = {};
  for (const scope of Object.keys(stored.scopes)) {
    resultScopes[scope] = stored.scopes[scope]?.grant || "not-granted";
  }
  return {
    granted: false,
    scopes: resultScopes
  };
}
async function revokePermissions(origin) {
  const result = await browserAPI.storage.local.get(PERMISSIONS_STORAGE_KEY);
  const allPermissions = result[PERMISSIONS_STORAGE_KEY] || {};
  delete allPermissions[origin];
  await browserAPI.storage.local.set({ [PERMISSIONS_STORAGE_KEY]: allPermissions });
}
async function cleanupExpiredGrants() {
  const allPermissions = await getAllOriginPermissions();
  const now = Date.now();
  let changed = false;
  for (const [origin, stored] of Object.entries(allPermissions)) {
    for (const [scope, permission] of Object.entries(stored.scopes)) {
      if (permission.grant === "granted-once" && permission.expiresAt && permission.expiresAt < now) {
        stored.scopes[scope] = {
          grant: "not-granted",
          grantedAt: now
        };
        changed = true;
      }
    }
  }
  if (changed) {
    await browserAPI.storage.local.set({ [PERMISSIONS_STORAGE_KEY]: allPermissions });
  }
}
async function listAllPermissions() {
  const allPermissions = await getAllOriginPermissions();
  const result = [];
  const now = Date.now();
  for (const [origin, stored] of Object.entries(allPermissions)) {
    const scopes = {
      // Extension 1: Core AI & MCP
      "model:prompt": "not-granted",
      "model:tools": "not-granted",
      "model:list": "not-granted",
      "mcp:tools.list": "not-granted",
      "mcp:tools.call": "not-granted",
      "mcp:servers.register": "not-granted",
      // Extension 1: Browser (same-tab)
      "browser:activeTab.read": "not-granted",
      "browser:activeTab.interact": "not-granted",
      "browser:activeTab.screenshot": "not-granted",
      // Extension 2: Navigation and Tabs
      "browser:navigate": "not-granted",
      "browser:tabs.read": "not-granted",
      "browser:tabs.create": "not-granted",
      // Extension 2: Web Fetch
      "web:fetch": "not-granted",
      // Other
      "chat:open": "not-granted",
      "addressBar:suggest": "not-granted",
      "addressBar:context": "not-granted",
      "addressBar:history": "not-granted",
      "addressBar:execute": "not-granted",
      // Extension 3: Multi-Agent (reserved)
      "agents:register": "not-granted",
      "agents:discover": "not-granted",
      "agents:invoke": "not-granted",
      "agents:message": "not-granted",
      "agents:crossOrigin": "not-granted",
      "agents:remote": "not-granted"
    };
    for (const scope of Object.keys(scopes)) {
      const storedPerm = stored.scopes[scope];
      if (storedPerm) {
        if (storedPerm.grant === "granted-once") {
          if (storedPerm.expiresAt && storedPerm.expiresAt < now) {
            scopes[scope] = "not-granted";
          } else {
            scopes[scope] = "granted-once";
          }
        } else {
          scopes[scope] = storedPerm.grant;
        }
      }
    }
    const hasGrants = Object.values(scopes).some((g2) => g2 !== "not-granted");
    if (hasGrants) {
      result.push({
        origin,
        scopes,
        allowedTools: stored.allowedTools
      });
    }
  }
  return result;
}
async function showPermissionPrompt(origin, scopes, reason, requestedTools, sessionContext) {
  console.log("[Permissions] showPermissionPrompt called:", { origin, scopes, reason, sessionContext });
  if (promptWindowId !== null) {
    try {
      await browserAPI.windows.remove(promptWindowId);
    } catch {
    }
    promptWindowId = null;
    if (pendingPromptResolve) {
      pendingPromptResolve({ granted: false });
      pendingPromptResolve = null;
    }
  }
  const params = new URLSearchParams({
    origin,
    scopes: scopes.join(",")
  });
  if (reason) params.set("reason", reason);
  if (requestedTools && requestedTools.length > 0) {
    params.set("tools", requestedTools.join(","));
  }
  if (sessionContext) {
    if (sessionContext.name) params.set("sessionName", sessionContext.name);
    if (sessionContext.type) params.set("sessionType", sessionContext.type);
    if (sessionContext.requestedLLM) params.set("llm", "true");
    if (sessionContext.requestedToolsCount !== void 0) {
      params.set("toolsCount", String(sessionContext.requestedToolsCount));
    }
    if (sessionContext.requestedBrowser && sessionContext.requestedBrowser.length > 0) {
      params.set("browser", sessionContext.requestedBrowser.join(","));
    }
  }
  const promptUrl = browserAPI.runtime.getURL(`dist/permission-prompt.html?${params.toString()}`);
  console.log("[Permissions] Opening prompt URL:", promptUrl);
  return new Promise((resolve) => {
    pendingPromptResolve = resolve;
    const createPromise = browserAPI.windows.create({
      url: promptUrl,
      type: "popup",
      width: 450,
      height: 550,
      // Slightly taller to accommodate session context
      focused: true
    });
    if (createPromise && typeof createPromise.then === "function") {
      createPromise.then((window2) => {
        console.log("[Permissions] Window created (promise):", window2?.id);
        if (window2?.id) {
          promptWindowId = window2.id;
        } else {
          console.error("[Permissions] Window creation failed - no window returned");
          pendingPromptResolve = null;
          resolve({ granted: false });
        }
      }).catch((err) => {
        console.error("[Permissions] Window creation failed:", err);
        pendingPromptResolve = null;
        resolve({ granted: false });
      });
    }
  });
}
function handlePermissionPromptResponse(response) {
  console.log("[Permissions] handlePermissionPromptResponse:", response);
  if (pendingPromptResolve) {
    pendingPromptResolve(response);
    pendingPromptResolve = null;
  }
  if (promptWindowId !== null) {
    browserAPI.windows.remove(promptWindowId).catch(() => {
    });
    promptWindowId = null;
  }
}
async function requestPermissions(origin, options, tabId) {
  const { scopes, reason, tools } = options;
  const check = await checkPermissions(origin, scopes, tabId);
  if (check.deniedScopes.length > 0) {
    const status = await getPermissionStatus(origin, tabId);
    return {
      granted: false,
      scopes: status.scopes
    };
  }
  if (check.granted) {
    const status = await getPermissionStatus(origin, tabId);
    if (scopes.includes("mcp:tools.call") && tools && tools.length > 0) {
      const missingTools = tools.filter((t) => !status.allowedTools?.includes(t));
      if (missingTools.length > 0) {
        const promptResult2 = await showPermissionPrompt(origin, ["mcp:tools.call"], reason, missingTools);
        if (promptResult2.granted && promptResult2.grantType) {
          return grantPermissions(origin, [], promptResult2.grantType, tabId, promptResult2.allowedTools);
        }
      }
    }
    return {
      granted: true,
      scopes: status.scopes,
      allowedTools: status.allowedTools
    };
  }
  const promptResult = await showPermissionPrompt(origin, check.missingScopes, reason, tools);
  if (promptResult.granted && promptResult.grantType) {
    return grantPermissions(origin, check.missingScopes, promptResult.grantType, tabId, promptResult.allowedTools);
  } else if (promptResult.explicitDeny) {
    return denyPermissions(origin, check.missingScopes);
  } else {
    const status = await getPermissionStatus(origin, tabId);
    return {
      granted: false,
      scopes: status.scopes
    };
  }
}
async function checkSessionCapability(session, capability, tabId) {
  const origin = session.origin;
  const scopeMap = {
    "llm": "model:prompt",
    "tools": "mcp:tools.call",
    "browser.read": "browser:activeTab.read",
    "browser.interact": "browser:activeTab.interact",
    "browser.screenshot": "browser:activeTab.screenshot"
  };
  const requiredScope = scopeMap[capability];
  if (!requiredScope) {
    return { allowed: false, reason: "Unknown capability" };
  }
  let sessionHasCapability = false;
  switch (capability) {
    case "llm":
      sessionHasCapability = session.capabilities.llm.allowed;
      break;
    case "tools":
      sessionHasCapability = session.capabilities.tools.allowed;
      break;
    case "browser.read":
      sessionHasCapability = session.capabilities.browser.readActiveTab;
      break;
    case "browser.interact":
      sessionHasCapability = session.capabilities.browser.interact;
      break;
    case "browser.screenshot":
      sessionHasCapability = session.capabilities.browser.screenshot;
      break;
  }
  if (!sessionHasCapability) {
    return { allowed: false, reason: `Session does not have ${capability} capability` };
  }
  const check = await checkPermissions(origin, [requiredScope], tabId);
  if (!check.granted) {
    if (check.deniedScopes.length > 0) {
      return { allowed: false, reason: `Origin permission denied for ${requiredScope}` };
    }
    return { allowed: false, reason: `Origin permission not granted for ${requiredScope}` };
  }
  return { allowed: true };
}
async function checkSessionToolAccess(session, toolName, tabId) {
  if (!session.capabilities.tools.allowed) {
    return { allowed: false, reason: "Session does not have tool access" };
  }
  if (!session.capabilities.tools.allowedTools.includes(toolName)) {
    return { allowed: false, reason: `Tool "${toolName}" not in session's allowed tools` };
  }
  const originAllowed = await isToolAllowed(session.origin, toolName);
  if (!originAllowed) {
    return { allowed: false, reason: `Origin does not have permission for tool "${toolName}"` };
  }
  const budget = SessionRegistry.getRemainingToolBudget(session.sessionId);
  if (budget !== void 0 && budget <= 0) {
    return { allowed: false, reason: "Session tool budget exceeded" };
  }
  return { allowed: true };
}
async function requestSessionPermissions(session, tabId) {
  const requiredScopes = [];
  if (session.capabilities.llm.allowed) {
    requiredScopes.push("model:prompt");
  }
  if (session.capabilities.tools.allowed) {
    requiredScopes.push("mcp:tools.call");
    if (session.capabilities.tools.allowedTools.length > 0) {
      requiredScopes.push("mcp:tools.list");
    }
  }
  if (session.capabilities.browser.readActiveTab) {
    requiredScopes.push("browser:activeTab.read");
  }
  if (session.capabilities.browser.interact) {
    requiredScopes.push("browser:activeTab.interact");
  }
  if (session.capabilities.browser.screenshot) {
    requiredScopes.push("browser:activeTab.screenshot");
  }
  if (requiredScopes.length === 0) {
    return {
      granted: true,
      scopes: {}
    };
  }
  const reason = session.reason || (session.name ? `Session "${session.name}" requests access` : void 0);
  return requestPermissions(
    session.origin,
    {
      scopes: requiredScopes,
      reason,
      tools: session.capabilities.tools.allowedTools.length > 0 ? session.capabilities.tools.allowedTools : void 0
    },
    tabId
  );
}
async function validateSessionCapabilities(session, tabId) {
  const invalid = [];
  if (session.capabilities.llm.allowed) {
    const result = await checkSessionCapability(session, "llm", tabId);
    if (!result.allowed) {
      invalid.push("llm");
    }
  }
  if (session.capabilities.tools.allowed) {
    const check = await checkPermissions(session.origin, ["mcp:tools.call"], tabId);
    if (!check.granted) {
      invalid.push("tools");
    }
  }
  if (session.capabilities.browser.readActiveTab) {
    const result = await checkSessionCapability(session, "browser.read", tabId);
    if (!result.allowed) {
      invalid.push("browser.read");
    }
  }
  if (session.capabilities.browser.interact) {
    const result = await checkSessionCapability(session, "browser.interact", tabId);
    if (!result.allowed) {
      invalid.push("browser.interact");
    }
  }
  if (session.capabilities.browser.screenshot) {
    const result = await checkSessionCapability(session, "browser.screenshot", tabId);
    if (!result.allowed) {
      invalid.push("browser.screenshot");
    }
  }
  return {
    valid: invalid.length === 0,
    invalidCapabilities: invalid
  };
}
var PERMISSIONS_STORAGE_KEY, ONCE_GRANT_DURATION_MS, promptWindowId, pendingPromptResolve, SCOPE_DESCRIPTIONS;
var init_permissions = __esm({
  "src/policy/permissions.ts"() {
    "use strict";
    init_browser_compat();
    init_registry();
    PERMISSIONS_STORAGE_KEY = "harbor_origin_permissions";
    ONCE_GRANT_DURATION_MS = 10 * 60 * 1e3;
    promptWindowId = null;
    pendingPromptResolve = null;
    browserAPI.windows?.onRemoved?.addListener((windowId) => {
      if (windowId === promptWindowId) {
        promptWindowId = null;
        if (pendingPromptResolve) {
          pendingPromptResolve({ granted: false });
          pendingPromptResolve = null;
        }
      }
    });
    SCOPE_DESCRIPTIONS = {
      // Extension 1: Core AI & MCP
      "model:prompt": {
        title: "Generate text using AI",
        description: "Create text generation sessions and receive AI-generated responses.",
        risk: "low"
      },
      "model:tools": {
        title: "Use AI with tool calling",
        description: "Run autonomous agent tasks where AI can decide to call tools.",
        risk: "medium"
      },
      "model:list": {
        title: "List AI providers",
        description: "See which AI providers and models are available.",
        risk: "low"
      },
      "mcp:tools.list": {
        title: "List available tools",
        description: "See the list of tools from connected MCP servers.",
        risk: "low"
      },
      "mcp:tools.call": {
        title: "Execute tools",
        description: "Call specific MCP tools like search, file access, or APIs.",
        risk: "high"
      },
      "mcp:servers.register": {
        title: "Register MCP servers",
        description: "Allow the website to register its own MCP server.",
        risk: "medium"
      },
      // Extension 1: Browser (same-tab)
      "browser:activeTab.read": {
        title: "Read current page",
        description: "Extract readable text content from this page.",
        risk: "medium"
      },
      "browser:activeTab.interact": {
        title: "Interact with this page",
        description: "Click buttons, fill forms, and scroll on this page only.",
        risk: "high"
      },
      "browser:activeTab.screenshot": {
        title: "Take screenshots",
        description: "Capture screenshots of this page.",
        risk: "medium"
      },
      // Extension 2: Navigation and Tabs
      "browser:navigate": {
        title: "Navigate this tab",
        description: "Navigate the current tab to a different URL.",
        risk: "high"
      },
      "browser:tabs.read": {
        title: "See your open tabs",
        description: "See the URLs and titles of all your open tabs (metadata only, not content).",
        risk: "medium"
      },
      "browser:tabs.create": {
        title: "Open and control new tabs",
        description: "Create new browser tabs and have full control over tabs it creates (read, interact, navigate, close).",
        risk: "medium"
      },
      // Extension 2: Web Fetch
      "web:fetch": {
        title: "Make web requests",
        description: "Proxy HTTP requests through the extension (bypasses CORS for allowed domains).",
        risk: "high"
      },
      // Other
      "chat:open": {
        title: "Open chat UI",
        description: "Open the browser's chat interface.",
        risk: "low"
      },
      "addressBar:suggest": {
        title: "Provide address bar suggestions",
        description: "Show AI-powered suggestions in the browser address bar.",
        risk: "low"
      },
      "addressBar:context": {
        title: "Access current tab context",
        description: "Use current page information for smarter suggestions.",
        risk: "medium"
      },
      "addressBar:history": {
        title: "Access browsing history",
        description: "Use recent browsing history for personalized suggestions.",
        risk: "high"
      },
      "addressBar:execute": {
        title: "Execute from address bar",
        description: "Run tools and actions directly from address bar commands.",
        risk: "medium"
      },
      // Extension 3: Multi-Agent
      "agents:register": {
        title: "Register as an agent",
        description: "Register this page as an agent that can be discovered and invoked by other agents.",
        risk: "low"
      },
      "agents:discover": {
        title: "Discover other agents",
        description: "List and find other registered agents.",
        risk: "medium"
      },
      "agents:invoke": {
        title: "Invoke other agents",
        description: "Delegate tasks to other registered agents.",
        risk: "medium"
      },
      "agents:message": {
        title: "Message other agents",
        description: "Send and receive messages to/from other agents.",
        risk: "medium"
      },
      "agents:crossOrigin": {
        title: "Cross-origin agent access",
        description: "Communicate with agents from different websites.",
        risk: "high"
      },
      "agents:remote": {
        title: "Connect to remote agents",
        description: "Connect to agents running on remote servers via A2A protocol.",
        risk: "high"
      }
    };
    setInterval(cleanupExpiredGrants, 6e4);
  }
});

// src/background.ts
init_browser_compat();

// src/policy/store.ts
init_browser_compat();
var STORAGE_KEY = "harbor_capability_grants";
async function initializePolicyStore() {
  await browserAPI.storage.local.get(STORAGE_KEY);
  console.log("[Harbor] Policy store ready (stub)");
}

// src/background.ts
init_bridge_client();
init_native_bridge();

// src/mcp/host.ts
init_runtime();

// src/storage/servers.ts
init_browser_compat();
var STORAGE_KEY2 = "harbor_mcp_servers";
var LEGACY_STORAGE_KEY = "harbor_wasm_servers";
async function migrateIfNeeded() {
  const result = await browserAPI.storage.local.get([STORAGE_KEY2, LEGACY_STORAGE_KEY]);
  if (result[STORAGE_KEY2]) {
    return;
  }
  const legacyServers = result[LEGACY_STORAGE_KEY];
  if (legacyServers && legacyServers.length > 0) {
    const migratedServers = legacyServers.map((server) => ({
      ...server,
      runtime: server.runtime || "wasm"
    }));
    await browserAPI.storage.local.set({ [STORAGE_KEY2]: migratedServers });
    await browserAPI.storage.local.remove(LEGACY_STORAGE_KEY);
    console.log("[Harbor] Migrated", migratedServers.length, "servers to new storage format");
  }
}
async function loadInstalledServers() {
  await migrateIfNeeded();
  const result = await browserAPI.storage.local.get(STORAGE_KEY2);
  const servers = result[STORAGE_KEY2] || [];
  console.log("[Harbor] Loaded servers:", servers.length);
  return servers;
}
async function saveInstalledServers(servers) {
  await browserAPI.storage.local.set({ [STORAGE_KEY2]: servers });
}
async function addInstalledServer(server) {
  const existing = await loadInstalledServers();
  const next = existing.filter((item) => item.id !== server.id);
  next.push(server);
  await saveInstalledServers(next);
}
async function updateInstalledServer(server) {
  await addInstalledServer(server);
}
async function removeInstalledServer(serverId) {
  const existing = await loadInstalledServers();
  const next = existing.filter((item) => item.id !== serverId);
  await saveInstalledServers(next);
}
var ECHO_SERVER_SOURCE = `
async function main() {
  console.log('Echo JS MCP server starting...');
  
  while (true) {
    const line = await MCP.readLine();
    let request;
    try {
      request = JSON.parse(line);
    } catch (e) {
      console.error('Failed to parse request:', e);
      continue;
    }
    
    let response;
    
    switch (request.method) {
      case 'tools/list':
        response = {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            tools: [
              {
                name: 'echo',
                description: 'Echo back the input message',
                inputSchema: {
                  type: 'object',
                  properties: {
                    message: {
                      type: 'string',
                      description: 'The message to echo back'
                    }
                  },
                  required: ['message']
                }
              },
              {
                name: 'reverse',
                description: 'Reverse a string',
                inputSchema: {
                  type: 'object',
                  properties: {
                    text: {
                      type: 'string',
                      description: 'The text to reverse'
                    }
                  },
                  required: ['text']
                }
              }
            ]
          }
        };
        break;
        
      case 'tools/call':
        const toolName = request.params?.name;
        const args = request.params?.arguments || {};
        
        if (toolName === 'echo') {
          response = {
            jsonrpc: '2.0',
            id: request.id,
            result: {
              content: [
                { type: 'text', text: 'Echo: ' + (args.message || '(empty)') }
              ]
            }
          };
        } else if (toolName === 'reverse') {
          const reversed = (args.text || '').split('').reverse().join('');
          response = {
            jsonrpc: '2.0',
            id: request.id,
            result: {
              content: [
                { type: 'text', text: reversed }
              ]
            }
          };
        } else {
          response = {
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32601, message: 'Unknown tool: ' + toolName }
          };
        }
        break;
        
      default:
        response = {
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32601, message: 'Method not found: ' + request.method }
        };
    }
    
    MCP.writeLine(JSON.stringify(response));
  }
}

main().catch(err => console.error('Echo server error:', err));
`;
async function ensureBuiltinServers() {
  const existing = await loadInstalledServers();
  const timeServer = existing.find((s2) => s2.id === "time-wasm");
  if (timeServer && timeServer.runtime === "wasm") {
    const correctUrl = getExtensionURL("assets/mcp-time.wasm");
    if (timeServer.moduleUrl !== correctUrl) {
      console.log("[Harbor] Fixing time-wasm moduleUrl for Safari");
      timeServer.moduleUrl = correctUrl;
      await saveInstalledServers(existing);
    }
  }
  const hasTime = existing.some((s2) => s2.id === "time-wasm");
  const hasEcho = existing.some((s2) => s2.id === "echo-js");
  if (hasTime && hasEcho) {
    console.log("[Harbor] Built-in servers already present");
    return existing;
  }
  const serversToAdd = [];
  if (!hasTime) {
    const timeManifest = {
      id: "time-wasm",
      name: "Time Server",
      version: "0.1.0",
      runtime: "wasm",
      entrypoint: "mcp-time.wasm",
      moduleUrl: getExtensionURL("assets/mcp-time.wasm"),
      permissions: [],
      tools: [
        {
          name: "time.now",
          description: "Get current time from host",
          inputSchema: {
            type: "object",
            properties: {
              now: { type: "string" }
            },
            required: ["now"]
          }
        }
      ]
    };
    serversToAdd.push(timeManifest);
  }
  if (!hasEcho) {
    const echoManifest = {
      id: "echo-js",
      name: "Echo Server",
      version: "0.1.0",
      runtime: "js",
      scriptBase64: btoa(ECHO_SERVER_SOURCE),
      permissions: [],
      capabilities: {
        // No network access needed for echo server
      },
      tools: [
        {
          name: "echo",
          description: "Echo back the input message",
          inputSchema: {
            type: "object",
            properties: {
              message: { type: "string", description: "The message to echo back" }
            },
            required: ["message"]
          }
        },
        {
          name: "reverse",
          description: "Reverse a string",
          inputSchema: {
            type: "object",
            properties: {
              text: { type: "string", description: "The text to reverse" }
            },
            required: ["text"]
          }
        }
      ]
    };
    serversToAdd.push(echoManifest);
  }
  const next = [...existing, ...serversToAdd];
  await saveInstalledServers(next);
  console.log("[Harbor] Added built-in servers:", serversToAdd.map((s2) => s2.id).join(", "));
  return next;
}

// src/mcp/host.ts
function initializeMcpHost() {
  console.log("[Harbor] MCP host starting...");
  initializeMcpRuntime();
  ensureBuiltinServers().then((servers) => {
    servers.forEach((server) => registerMcpServer(server));
    console.log("[Harbor] MCP host ready (WASM + JS support).");
  });
}
async function listServersWithStatus() {
  const running = new Set(listRunningServerIds());
  return listMcpServers().map((handle) => ({
    ...handle.manifest,
    running: running.has(handle.id)
  }));
}
async function addServer(manifest) {
  registerMcpServer(manifest);
  await addInstalledServer(manifest);
}
function startServer(serverId) {
  return startMcpServer(serverId);
}
async function validateAndStartServer(serverId) {
  const started = await startMcpServer(serverId);
  if (!started) {
    return { ok: false, error: "Failed to start server" };
  }
  try {
    const response = await callMcpMethod(serverId, "tools/list");
    if (response.error) {
      stopMcpServer(serverId);
      return { ok: false, error: response.error.message };
    }
    const tools = response.result?.tools || [];
    const handle = getMcpServer(serverId);
    if (handle) {
      const updated = {
        ...handle.manifest,
        tools
      };
      registerMcpServer(updated);
      await updateInstalledServer(updated);
    }
    return { ok: true, tools };
  } catch (e) {
    stopMcpServer(serverId);
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
function stopServer(serverId) {
  return stopMcpServer(serverId);
}
async function removeServer(serverId) {
  unregisterMcpServer(serverId);
  await removeInstalledServer(serverId);
}
async function listTools(serverId) {
  const handle = getMcpServer(serverId);
  return handle?.manifest.tools || [];
}
function callTool(serverId, toolName, args) {
  const finalArgs = { ...args };
  if (serverId === "time-wasm" && toolName === "time.now" && !finalArgs.now) {
    finalArgs.now = (/* @__PURE__ */ new Date()).toISOString();
  }
  return callMcpTool(serverId, toolName, finalArgs);
}

// src/background.ts
init_permissions();

// src/extension-api.ts
init_browser_compat();
init_bridge_client();
init_native_bridge();

// src/llm/firefox-ml-provider.ts
var cachedCapabilities = null;
function getFirefoxML() {
  try {
    const browserGlobal = typeof browser !== "undefined" ? browser : null;
    const ml = browserGlobal?.trial?.ml;
    return ml ?? null;
  } catch {
    return null;
  }
}
async function detectFirefoxML(forceRefresh = false) {
  if (cachedCapabilities && !forceRefresh) {
    return cachedCapabilities;
  }
  const ml = getFirefoxML();
  if (!ml) {
    cachedCapabilities = {
      available: false,
      hasWllama: false,
      hasTransformers: false,
      supportsTools: false,
      models: []
    };
    return cachedCapabilities;
  }
  const hasTransformers = typeof ml.createEngine === "function";
  const wllamaAvailable = ml.wllama !== void 0 && typeof ml.wllama.createEngine === "function";
  let models = [];
  if (wllamaAvailable && ml.wllama?.listModels) {
    try {
      models = await ml.wllama.listModels();
    } catch (e) {
      console.debug("[Harbor] Could not list Firefox wllama models:", e);
      models = ["llama-3.2-1b", "llama-3.2-3b"];
    }
  }
  cachedCapabilities = {
    available: hasTransformers || wllamaAvailable,
    hasWllama: wllamaAvailable,
    hasTransformers,
    // wllama supports tool calling as of Firefox 142
    supportsTools: wllamaAvailable,
    models
  };
  console.log("[Harbor] Firefox ML capabilities detected:", cachedCapabilities);
  return cachedCapabilities;
}
function clearCapabilitiesCache() {
  cachedCapabilities = null;
}

// src/llm/provider-registry.ts
init_native_bridge();
init_bridge_client();
async function detectChromeAI() {
  try {
    const windowAi = globalThis.ai;
    if (!windowAi) {
      return null;
    }
    if (!windowAi.languageModel?.capabilities) {
      return null;
    }
    const caps = await windowAi.languageModel.capabilities();
    const available = caps.available === "readily" || caps.available === "after-download";
    return {
      available,
      supportsTools: false
      // Chrome AI doesn't support tools as of now
    };
  } catch {
    return null;
  }
}
var ProviderRegistry = class {
  providers = /* @__PURE__ */ new Map();
  defaultProviderId = null;
  firefoxCapabilities = null;
  chromeCapabilities = null;
  initialized = false;
  /**
   * Initialize the registry by detecting all available providers
   */
  async initialize() {
    if (this.initialized) {
      return;
    }
    console.log("[Harbor] Initializing provider registry...");
    await this.refreshCapabilities();
    this.initialized = true;
    console.log("[Harbor] Provider registry initialized");
  }
  /**
   * Refresh capability detection for all runtimes
   */
  async refreshCapabilities() {
    clearCapabilitiesCache();
    this.firefoxCapabilities = await detectFirefoxML();
    this.chromeCapabilities = await detectChromeAI();
    console.log("[Harbor] Capabilities refreshed:", {
      firefox: this.firefoxCapabilities,
      chrome: this.chromeCapabilities
    });
  }
  /**
   * Register a provider instance
   */
  register(provider) {
    this.providers.set(provider.id, provider);
    console.log(`[Harbor] Registered provider: ${provider.id} (${provider.type})`);
  }
  /**
   * Unregister a provider instance
   */
  unregister(providerId) {
    this.providers.delete(providerId);
  }
  /**
   * Get a specific provider by ID
   */
  getProvider(providerId) {
    return this.providers.get(providerId);
  }
  /**
   * Set the default provider ID
   */
  setDefault(providerId) {
    if (!this.providers.has(providerId) && providerId !== "bridge") {
      console.warn(`[Harbor] Provider ${providerId} not found, setting default anyway`);
    }
    this.defaultProviderId = providerId;
  }
  /**
   * Get runtime capabilities for all providers
   */
  async getCapabilities() {
    if (!this.initialized) {
      await this.initialize();
    }
    let bridgeProviders = [];
    let bridgeConnected = false;
    if (isNativeBridgeReady()) {
      bridgeConnected = true;
      try {
        const result = await bridgeRequest("llm.list_providers");
        bridgeProviders = result.providers.map((p) => p.id);
      } catch (e) {
        console.debug("[Harbor] Could not list bridge providers:", e);
      }
    }
    const harbor = {
      available: bridgeConnected || this.providers.size > 0,
      bridgeConnected,
      providers: bridgeProviders
    };
    return {
      firefox: this.firefoxCapabilities,
      chrome: this.chromeCapabilities,
      harbor
    };
  }
  /**
   * List all available providers with their info
   */
  async listProviders() {
    const providers = [];
    if (this.firefoxCapabilities?.hasWllama) {
      providers.push({
        id: "firefox-wllama",
        type: "firefox-wllama",
        name: "Firefox Local AI",
        available: true,
        models: this.firefoxCapabilities.models,
        isDefault: this.defaultProviderId === "firefox-wllama",
        supportsTools: this.firefoxCapabilities.supportsTools,
        supportsStreaming: true,
        isNative: true,
        runtime: "firefox"
      });
    }
    if (this.firefoxCapabilities?.hasTransformers) {
      providers.push({
        id: "firefox-transformers",
        type: "firefox-transformers",
        name: "Firefox ML (Transformers.js)",
        available: true,
        isDefault: this.defaultProviderId === "firefox-transformers",
        supportsTools: false,
        supportsStreaming: false,
        isNative: true,
        runtime: "firefox"
      });
    }
    if (this.chromeCapabilities?.available) {
      providers.push({
        id: "chrome",
        type: "chrome",
        name: "Chrome Built-in AI",
        available: true,
        isDefault: this.defaultProviderId === "chrome",
        supportsTools: this.chromeCapabilities.supportsTools,
        supportsStreaming: true,
        isNative: true,
        runtime: "chrome"
      });
    }
    for (const provider of this.providers.values()) {
      const info = await provider.getInfo();
      providers.push({
        ...info,
        isDefault: this.defaultProviderId === provider.id
      });
    }
    if (isNativeBridgeReady()) {
      try {
        const result = await bridgeRequest("llm.list_providers");
        for (const bp of result.providers) {
          if (!providers.some((p) => p.id === bp.id)) {
            providers.push({
              id: bp.id,
              type: bp.id,
              name: bp.name,
              available: bp.available,
              models: bp.models,
              isDefault: this.defaultProviderId === bp.id,
              supportsTools: bp.supportsTools ?? false,
              supportsStreaming: true,
              isNative: false,
              runtime: "bridge"
            });
          }
        }
      } catch (e) {
        console.debug("[Harbor] Could not list bridge providers:", e);
      }
    }
    return providers;
  }
  /**
   * Get the best available provider for a request
   * 
   * Selection priority:
   * 1. User-specified provider (explicit)
   * 2. User's configured default provider
   * 3. Native browser AI (Firefox wllama, Chrome AI) if available and suitable
   * 4. Bridge providers
   */
  async getBestProvider(request = {}) {
    if (request.provider) {
      return request.provider;
    }
    if (this.defaultProviderId) {
      if (await this.providerMeetsRequirements(this.defaultProviderId, request)) {
        return this.defaultProviderId;
      }
    }
    if (request.type !== "agent" || !request.requiresTools) {
      if (this.firefoxCapabilities?.hasWllama) {
        if (!request.requiresTools || this.firefoxCapabilities.supportsTools) {
          return "firefox-wllama";
        }
      }
      if (this.chromeCapabilities?.available) {
        if (!request.requiresTools || this.chromeCapabilities.supportsTools) {
          return "chrome";
        }
      }
    }
    if (isNativeBridgeReady()) {
      try {
        const result = await bridgeRequest("llm.get_active");
        if (result.provider) {
          return result.provider;
        }
      } catch {
      }
      try {
        const result = await bridgeRequest("llm.list_providers");
        for (const bp of result.providers) {
          if (bp.available && (!request.requiresTools || bp.supportsTools)) {
            return bp.id;
          }
        }
      } catch {
      }
    }
    return null;
  }
  /**
   * Get the best runtime identifier
   */
  async getBestRuntime() {
    if (this.firefoxCapabilities?.hasWllama) {
      return "firefox";
    }
    if (this.chromeCapabilities?.available) {
      return "chrome";
    }
    if (isNativeBridgeReady()) {
      return "harbor";
    }
    for (const provider of this.providers.values()) {
      if (await provider.isAvailable()) {
        return "harbor";
      }
    }
    return null;
  }
  /**
   * Check if a provider meets the request requirements
   */
  async providerMeetsRequirements(providerId, request) {
    if (providerId === "firefox-wllama") {
      if (request.requiresTools && !this.firefoxCapabilities?.supportsTools) {
        return false;
      }
      return this.firefoxCapabilities?.hasWllama ?? false;
    }
    if (providerId === "firefox-transformers") {
      if (request.type === "chat" || request.requiresTools) {
        return false;
      }
      return this.firefoxCapabilities?.hasTransformers ?? false;
    }
    if (providerId === "chrome") {
      if (request.requiresTools && !this.chromeCapabilities?.supportsTools) {
        return false;
      }
      return this.chromeCapabilities?.available ?? false;
    }
    const provider = this.providers.get(providerId);
    if (provider) {
      if (request.requiresTools && !provider.supportsTools()) {
        return false;
      }
      if (request.requiresStreaming && !provider.supportsStreaming()) {
        return false;
      }
      return provider.isAvailable();
    }
    return isNativeBridgeReady();
  }
};
var registryInstance = null;
function getProviderRegistry() {
  if (!registryInstance) {
    registryInstance = new ProviderRegistry();
  }
  return registryInstance;
}
async function getRuntimeCapabilities() {
  const registry = getProviderRegistry();
  return registry.getCapabilities();
}
async function listAllProviders() {
  const registry = getProviderRegistry();
  return registry.listProviders();
}

// src/sessions/index.ts
init_registry();
init_types();

// src/agents/background-router.ts
init_browser_compat();
init_permissions();

// src/agents/browser-api.ts
init_browser_compat();
var MAX_TEXT_LENGTH = 5e4;
var PRIVILEGED_PROTOCOLS = [
  "about:",
  "chrome:",
  "chrome-extension:",
  "moz-extension:",
  "edge:",
  "brave:",
  "opera:",
  "file:"
];
async function getRequestingTab(tabId) {
  const tab = await browserAPI.tabs.get(tabId);
  if (!tab || !tab.url) {
    throw Object.assign(
      new Error("Tab not found or has no URL"),
      { code: "ERR_INTERNAL" }
    );
  }
  for (const protocol of PRIVILEGED_PROTOCOLS) {
    if (tab.url.startsWith(protocol)) {
      throw Object.assign(
        new Error(`Cannot interact with privileged page: ${protocol}`),
        { code: "ERR_PERMISSION_DENIED" }
      );
    }
  }
  return tab;
}
async function getTabReadability(tabId) {
  const tab = await getRequestingTab(tabId);
  try {
    const results = await browserAPI.scripting.executeScript({
      target: { tabId },
      func: extractReadableContent
    });
    if (!results || results.length === 0 || !results[0].result) {
      throw new Error("Failed to extract content");
    }
    const { text, title } = results[0].result;
    return {
      url: tab.url,
      title: title || tab.title || "Untitled",
      text: text.slice(0, MAX_TEXT_LENGTH)
    };
  } catch (error2) {
    if (error2 instanceof Error) {
      if (error2.message.includes("Cannot access")) {
        throw Object.assign(
          new Error("Cannot read content from this page"),
          { code: "ERR_PERMISSION_DENIED" }
        );
      }
      if (error2.message.includes("No frame with id")) {
        throw Object.assign(
          new Error("Page is not accessible"),
          { code: "ERR_INTERNAL" }
        );
      }
    }
    throw Object.assign(
      new Error(`Content extraction failed: ${error2 instanceof Error ? error2.message : "Unknown error"}`),
      { code: "ERR_INTERNAL" }
    );
  }
}
async function getTabHtml(tabId, selector) {
  const tab = await getRequestingTab(tabId);
  try {
    const results = await browserAPI.scripting.executeScript({
      target: { tabId },
      func: (containerSelector) => {
        const container = containerSelector ? document.querySelector(containerSelector) : document.body;
        return {
          html: container?.outerHTML || document.body.outerHTML,
          url: window.location.href,
          title: document.title
        };
      },
      args: [selector || null]
    });
    if (!results || results.length === 0 || !results[0].result) {
      throw new Error("Failed to extract HTML content");
    }
    return results[0].result;
  } catch (error2) {
    if (error2 instanceof Error) {
      if (error2.message.includes("Cannot access")) {
        throw Object.assign(
          new Error("Cannot read content from this page"),
          { code: "ERR_PERMISSION_DENIED" }
        );
      }
    }
    throw Object.assign(
      new Error(`HTML extraction failed: ${error2 instanceof Error ? error2.message : "Unknown error"}`),
      { code: "ERR_INTERNAL" }
    );
  }
}
async function clickElement(tabId, selector, options) {
  await getRequestingTab(tabId);
  const results = await browserAPI.scripting.executeScript({
    target: { tabId },
    func: (sel, opts) => {
      const element = document.querySelector(sel);
      if (!element) {
        throw new Error(`Element not found: ${sel}`);
      }
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        throw new Error(`Element is not visible: ${sel}`);
      }
      if (element.disabled) {
        throw new Error(`Element is disabled: ${sel}`);
      }
      if (element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")) {
        element.click();
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return;
      }
      const clickCount = opts?.clickCount || 1;
      for (let i2 = 0; i2 < clickCount; i2++) {
        if (typeof element.click === "function") {
          element.click();
        } else {
          const clickEvent = new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            view: window,
            button: opts?.button === "right" ? 2 : opts?.button === "middle" ? 1 : 0
          });
          element.dispatchEvent(clickEvent);
        }
      }
    },
    args: [selector, options]
  });
  if (results[0]?.error) {
    throw Object.assign(
      new Error(results[0].error.message || "Click failed"),
      { code: "ERR_INTERNAL" }
    );
  }
}
async function fillInput(tabId, selector, value) {
  await getRequestingTab(tabId);
  const results = await browserAPI.scripting.executeScript({
    target: { tabId },
    func: (sel, val) => {
      const element = document.querySelector(sel);
      if (!element) {
        throw new Error(`Element not found: ${sel}`);
      }
      if (!("value" in element)) {
        throw new Error(`Element is not fillable: ${sel}`);
      }
      if (element.disabled || element.readOnly) {
        throw new Error(`Element is disabled or read-only: ${sel}`);
      }
      element.focus();
      element.value = "";
      element.value = val;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    },
    args: [selector, value]
  });
  if (results[0]?.error) {
    throw Object.assign(
      new Error(results[0].error.message || "Fill failed"),
      { code: "ERR_INTERNAL" }
    );
  }
}
async function selectOption(tabId, selector, value) {
  await getRequestingTab(tabId);
  const results = await browserAPI.scripting.executeScript({
    target: { tabId },
    func: (sel, val) => {
      const element = document.querySelector(sel);
      if (!element) {
        throw new Error(`Element not found: ${sel}`);
      }
      if (element.tagName !== "SELECT") {
        throw new Error(`Element is not a select: ${sel}`);
      }
      if (element.disabled) {
        throw new Error(`Select is disabled: ${sel}`);
      }
      const option = Array.from(element.options).find(
        (opt) => opt.value === val || opt.textContent === val
      );
      if (!option) {
        throw new Error(`Option not found: ${val}`);
      }
      element.value = option.value;
      element.dispatchEvent(new Event("change", { bubbles: true }));
    },
    args: [selector, value]
  });
  if (results[0]?.error) {
    throw Object.assign(
      new Error(results[0].error.message || "Select failed"),
      { code: "ERR_INTERNAL" }
    );
  }
}
async function scrollPage(tabId, options) {
  await getRequestingTab(tabId);
  await browserAPI.scripting.executeScript({
    target: { tabId },
    func: (opts) => {
      if (opts.selector) {
        const element = document.querySelector(opts.selector);
        if (!element) {
          throw new Error(`Element not found: ${opts.selector}`);
        }
        element.scrollIntoView({ behavior: opts.behavior || "smooth" });
      } else {
        window.scrollTo({
          left: opts.x ?? window.scrollX,
          top: opts.y ?? window.scrollY,
          behavior: opts.behavior || "smooth"
        });
      }
    },
    args: [options]
  });
}
async function getElementInfo(tabId, selector) {
  await getRequestingTab(tabId);
  const results = await browserAPI.scripting.executeScript({
    target: { tabId },
    func: (sel) => {
      const element = document.querySelector(sel);
      if (!element) {
        return null;
      }
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return {
        tagName: element.tagName.toLowerCase(),
        id: element.id || void 0,
        className: element.className || void 0,
        textContent: element.textContent?.slice(0, 500) || void 0,
        isVisible: rect.width > 0 && rect.height > 0 && style.visibility !== "hidden",
        isEnabled: !element.disabled,
        boundingBox: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        }
      };
    },
    args: [selector]
  });
  return results[0]?.result ?? null;
}
async function waitForSelector(tabId, selector, options) {
  await getRequestingTab(tabId);
  const timeout = options?.timeout ?? 3e4;
  const checkVisible = options?.visible ?? false;
  const results = await browserAPI.scripting.executeScript({
    target: { tabId },
    func: (sel, timeoutMs, mustBeVisible) => {
      return new Promise((resolve, reject) => {
        const getElementInfo2 = (el) => {
          const rect = el.getBoundingClientRect();
          const isVisible = rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).visibility !== "hidden" && window.getComputedStyle(el).display !== "none";
          return {
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            className: el.className || "",
            textContent: el.textContent?.slice(0, 100) || null,
            isVisible,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          };
        };
        const checkElement = () => {
          const el = document.querySelector(sel);
          if (el) {
            const info = getElementInfo2(el);
            if (!mustBeVisible || info.isVisible) {
              return info;
            }
          }
          return null;
        };
        const immediate = checkElement();
        if (immediate) {
          resolve(immediate);
          return;
        }
        let observer = null;
        let timeoutId = null;
        const cleanup = () => {
          if (observer) {
            observer.disconnect();
            observer = null;
          }
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
        };
        observer = new MutationObserver(() => {
          const result2 = checkElement();
          if (result2) {
            cleanup();
            resolve(result2);
          }
        });
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["class", "style", "hidden"]
        });
        timeoutId = window.setTimeout(() => {
          cleanup();
          reject(new Error(`Timeout waiting for selector: ${sel}`));
        }, timeoutMs);
      });
    },
    args: [selector, timeout, checkVisible]
  });
  const result = results[0]?.result;
  if (!result) {
    throw Object.assign(
      new Error(`Timeout waiting for selector: ${selector}`),
      { code: "ERR_TIMEOUT" }
    );
  }
  return result;
}
async function takeScreenshot(tabId, options) {
  await getRequestingTab(tabId);
  const tab = await browserAPI.tabs.get(tabId);
  const dataUrl = await browserAPI.tabs.captureVisibleTab(tab.windowId, {
    format: options?.format || "png",
    quality: options?.quality
  });
  return dataUrl;
}
function extractReadableContent() {
  const title = document.title;
  const elementsToRemove = [
    "script",
    "style",
    "noscript",
    "iframe",
    "object",
    "embed",
    "nav",
    "header",
    "footer",
    "aside",
    '[role="navigation"]',
    '[role="banner"]',
    '[role="contentinfo"]',
    '[aria-hidden="true"]',
    ".ad",
    ".ads",
    ".advertisement",
    ".social-share",
    ".comments",
    ".related-posts",
    ".sidebar",
    ".cookie-banner",
    ".popup",
    ".modal"
  ];
  const clone = document.body.cloneNode(true);
  for (const selector of elementsToRemove) {
    const elements = clone.querySelectorAll(selector);
    elements.forEach((el) => el.remove());
  }
  const mainSelectors = [
    "main",
    "article",
    '[role="main"]',
    ".content",
    ".post-content",
    ".article-content",
    ".entry-content",
    "#content",
    "#main"
  ];
  let contentElement = null;
  for (const selector of mainSelectors) {
    contentElement = clone.querySelector(selector);
    if (contentElement) break;
  }
  const targetElement = contentElement || clone;
  let text = extractTextFromElement(targetElement);
  text = text.replace(/\s+/g, " ").replace(/\n\s*\n/g, "\n\n").trim();
  return { text, title };
}
function extractTextFromElement(element) {
  const textParts = [];
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim();
      if (text) {
        textParts.push(text);
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node;
      const tagName = el.tagName.toLowerCase();
      const style = window.getComputedStyle?.(el);
      if (style?.display === "none" || style?.visibility === "hidden") {
        return;
      }
      const blockElements = [
        "p",
        "div",
        "section",
        "article",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "li",
        "br",
        "hr",
        "blockquote",
        "pre",
        "table",
        "tr"
      ];
      if (blockElements.includes(tagName)) {
        textParts.push("\n");
      }
      for (const child of el.childNodes) {
        walk(child);
      }
      if (blockElements.includes(tagName)) {
        textParts.push("\n");
      }
    }
  }
  walk(element);
  return textParts.join(" ");
}

// src/tabs/manager.ts
init_browser_compat();
var spawnedTabs = /* @__PURE__ */ new Map();
var tabsByOrigin = /* @__PURE__ */ new Map();
function registerSpawnedTab(tabId, origin, url, parentTabId) {
  const info = {
    tabId,
    origin,
    createdAt: Date.now(),
    parentTabId,
    url
  };
  spawnedTabs.set(tabId, info);
  if (!tabsByOrigin.has(origin)) {
    tabsByOrigin.set(origin, /* @__PURE__ */ new Set());
  }
  tabsByOrigin.get(origin).add(tabId);
  console.log("[TabManager] Registered spawned tab:", tabId, "for origin:", origin);
}
function canOriginControlTab(origin, tabId) {
  const info = spawnedTabs.get(tabId);
  return info !== void 0 && info.origin === origin;
}
function unregisterTab(tabId) {
  const info = spawnedTabs.get(tabId);
  if (info) {
    spawnedTabs.delete(tabId);
    tabsByOrigin.get(info.origin)?.delete(tabId);
    console.log("[TabManager] Unregistered tab:", tabId);
  }
}
async function listTabs(origin) {
  const tabs = await browserAPI.tabs.query({});
  return tabs.map((tab) => ({
    id: tab.id,
    url: tab.url || "",
    title: tab.title || "",
    active: tab.active,
    index: tab.index,
    windowId: tab.windowId,
    favIconUrl: tab.favIconUrl,
    status: tab.status,
    canControl: canOriginControlTab(origin, tab.id)
  }));
}
async function getTab(origin, tabId) {
  try {
    const tab = await browserAPI.tabs.get(tabId);
    return {
      id: tab.id,
      url: tab.url || "",
      title: tab.title || "",
      active: tab.active,
      index: tab.index,
      windowId: tab.windowId,
      favIconUrl: tab.favIconUrl,
      status: tab.status,
      canControl: canOriginControlTab(origin, tabId)
    };
  } catch {
    return null;
  }
}
async function createTab(origin, options, parentTabId) {
  const tab = await browserAPI.tabs.create({
    url: options.url,
    active: options.active ?? false,
    // Default to background
    index: options.index,
    windowId: options.windowId
  });
  registerSpawnedTab(tab.id, origin, options.url, parentTabId);
  return {
    id: tab.id,
    url: tab.url || options.url,
    title: tab.title || "",
    active: tab.active,
    index: tab.index,
    windowId: tab.windowId,
    favIconUrl: tab.favIconUrl,
    status: tab.status,
    canControl: true
    // Origin just created it
  };
}
async function closeTab(origin, tabId) {
  if (!canOriginControlTab(origin, tabId)) {
    throw new Error("Cannot close tab: origin did not spawn this tab");
  }
  try {
    await browserAPI.tabs.remove(tabId);
    unregisterTab(tabId);
    return true;
  } catch {
    return false;
  }
}
async function navigateTab(origin, tabId, url, isActiveTab) {
  if (!isActiveTab && !canOriginControlTab(origin, tabId)) {
    throw new Error("Cannot navigate tab: origin did not spawn this tab");
  }
  await browserAPI.tabs.update(tabId, { url });
  const info = spawnedTabs.get(tabId);
  if (info) {
    info.url = url;
  }
}
function waitForNavigation(tabId, timeoutMs = 3e4) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      browserAPI.tabs.onUpdated.removeListener(listener);
      reject(new Error("Navigation timeout"));
    }, timeoutMs);
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        browserAPI.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    browserAPI.tabs.onUpdated.addListener(listener);
  });
}
function initializeTabManager() {
  browserAPI.tabs.onRemoved.addListener((tabId) => {
    unregisterTab(tabId);
  });
  console.log("[TabManager] Initialized");
}

// src/multi-agent/registry.ts
init_browser_compat();
var agents = /* @__PURE__ */ new Map();
var agentsByOrigin = /* @__PURE__ */ new Map();
var agentsByTab = /* @__PURE__ */ new Map();
var agentUsage = /* @__PURE__ */ new Map();
var agentIdCounter = 0;
function generateAgentId() {
  return `agent-${Date.now()}-${++agentIdCounter}`;
}
function registerAgent(options, origin, tabId) {
  const id = generateAgentId();
  const now = Date.now();
  const agent = {
    id,
    name: options.name,
    description: options.description,
    type: "page",
    status: "active",
    origin,
    tabId,
    capabilities: options.capabilities || [],
    tags: options.tags || [],
    acceptsInvocations: options.acceptsInvocations ?? true,
    acceptsMessages: options.acceptsMessages ?? true,
    registeredAt: now,
    lastActiveAt: now
  };
  agents.set(id, agent);
  if (!agentsByOrigin.has(origin)) {
    agentsByOrigin.set(origin, /* @__PURE__ */ new Set());
  }
  agentsByOrigin.get(origin).add(id);
  if (tabId !== void 0) {
    if (!agentsByTab.has(tabId)) {
      agentsByTab.set(tabId, /* @__PURE__ */ new Set());
    }
    agentsByTab.get(tabId).add(id);
  }
  agentUsage.set(id, {
    agentId: id,
    promptCount: 0,
    tokensUsed: 0,
    toolCallCount: 0,
    messagesSent: 0,
    invocationsMade: 0,
    invocationsReceived: 0,
    startedAt: now,
    lastActivityAt: now
  });
  console.log("[AgentRegistry] Registered agent:", id, "name:", options.name, "origin:", origin);
  return agent;
}
function unregisterAgent(agentId, origin) {
  const agent = agents.get(agentId);
  if (!agent) {
    return false;
  }
  if (agent.origin !== origin) {
    return false;
  }
  agents.delete(agentId);
  agentsByOrigin.get(origin)?.delete(agentId);
  if (agent.tabId !== void 0) {
    agentsByTab.get(agent.tabId)?.delete(agentId);
  }
  agentUsage.delete(agentId);
  console.log("[AgentRegistry] Unregistered agent:", agentId);
  return true;
}
function getAgent(agentId) {
  return agents.get(agentId);
}
function getAgentsByOrigin(origin) {
  const ids = agentsByOrigin.get(origin);
  if (!ids) return [];
  return Array.from(ids).map((id) => agents.get(id)).filter((a2) => a2 !== void 0);
}
function touchAgent(agentId) {
  const agent = agents.get(agentId);
  if (agent) {
    agent.lastActiveAt = Date.now();
  }
  const usage = agentUsage.get(agentId);
  if (usage) {
    usage.lastActivityAt = Date.now();
  }
}
function cleanupTabAgents(tabId) {
  const ids = agentsByTab.get(tabId);
  if (!ids) return;
  for (const id of ids) {
    const agent = agents.get(id);
    if (agent) {
      agents.delete(id);
      agentsByOrigin.get(agent.origin)?.delete(id);
      agentUsage.delete(id);
    }
  }
  agentsByTab.delete(tabId);
  console.log("[AgentRegistry] Cleaned up agents for tab:", tabId);
}
function discoverAgents(queryOrigin, options, allowCrossOrigin) {
  const results = [];
  for (const agent of agents.values()) {
    if (agent.status !== "active") continue;
    const sameOrigin = agent.origin === queryOrigin;
    if (!sameOrigin && !allowCrossOrigin) {
      continue;
    }
    if (sameOrigin && options.includeSameOrigin === false) {
      continue;
    }
    if (!sameOrigin && options.includeCrossOrigin === false) {
      continue;
    }
    if (options.name && !agent.name.toLowerCase().includes(options.name.toLowerCase())) {
      continue;
    }
    if (options.capabilities && options.capabilities.length > 0) {
      const hasCapability = options.capabilities.some((c2) => agent.capabilities.includes(c2));
      if (!hasCapability) continue;
    }
    if (options.tags && options.tags.length > 0) {
      const hasTag = options.tags.some((t) => agent.tags.includes(t));
      if (!hasTag) continue;
    }
    results.push({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      origin: agent.origin,
      capabilities: agent.capabilities,
      tags: agent.tags,
      acceptsInvocations: agent.acceptsInvocations,
      acceptsMessages: agent.acceptsMessages,
      sameOrigin,
      isRemote: false
    });
  }
  return results;
}
function getAgentUsage(agentId) {
  return agentUsage.get(agentId);
}
function recordMessageSent(agentId) {
  const usage = agentUsage.get(agentId);
  if (usage) {
    usage.messagesSent++;
    usage.lastActivityAt = Date.now();
  }
  touchAgent(agentId);
}
function recordInvocationMade(agentId) {
  const usage = agentUsage.get(agentId);
  if (usage) {
    usage.invocationsMade++;
    usage.lastActivityAt = Date.now();
  }
  touchAgent(agentId);
}
function recordInvocationReceived(agentId) {
  const usage = agentUsage.get(agentId);
  if (usage) {
    usage.invocationsReceived++;
    usage.lastActivityAt = Date.now();
  }
  touchAgent(agentId);
}
function initializeAgentRegistry() {
  browserAPI.tabs.onRemoved.addListener((tabId) => {
    cleanupTabAgents(tabId);
  });
  browserAPI.webNavigation?.onCommitted?.addListener((details) => {
    if (details.frameId === 0 && details.transitionType !== "auto_subframe") {
      cleanupTabAgents(details.tabId);
    }
  });
  console.log("[AgentRegistry] Initialized");
}

// src/multi-agent/messaging.ts
init_permissions();
var messageHandlers = /* @__PURE__ */ new Map();
var invocationHandlers = /* @__PURE__ */ new Map();
var eventSubscriptions = /* @__PURE__ */ new Map();
var messageIdCounter = 0;
function generateMessageId() {
  return `msg-${Date.now()}-${++messageIdCounter}`;
}
function registerMessageHandler(agentId, handler) {
  messageHandlers.set(agentId, handler);
}
function unregisterMessageHandler(agentId) {
  messageHandlers.delete(agentId);
}
function registerInvocationHandler(agentId, handler) {
  invocationHandlers.set(agentId, handler);
}
function unregisterInvocationHandler(agentId) {
  invocationHandlers.delete(agentId);
}
function subscribeToEvent(agentId, eventType) {
  if (!eventSubscriptions.has(eventType)) {
    eventSubscriptions.set(eventType, /* @__PURE__ */ new Set());
  }
  eventSubscriptions.get(eventType).add(agentId);
}
function unsubscribeFromEvent(agentId, eventType) {
  eventSubscriptions.get(eventType)?.delete(agentId);
}
async function sendMessage2(fromAgentId, toAgentId, payload, fromOrigin) {
  const fromAgent = getAgent(fromAgentId);
  const toAgent = getAgent(toAgentId);
  if (!fromAgent) {
    return { delivered: false, error: "Sender agent not found" };
  }
  if (!toAgent) {
    return { delivered: false, error: "Recipient agent not found" };
  }
  if (!toAgent.acceptsMessages) {
    return { delivered: false, error: "Recipient does not accept messages" };
  }
  if (fromAgent.origin !== toAgent.origin) {
    const check = await checkPermissions(fromOrigin, ["agents:crossOrigin"]);
    if (!check.granted) {
      return { delivered: false, error: "Cross-origin messaging requires agents:crossOrigin permission" };
    }
  }
  const message = {
    id: generateMessageId(),
    from: fromAgentId,
    to: toAgentId,
    type: "event",
    payload,
    timestamp: Date.now()
  };
  const handler = messageHandlers.get(toAgentId);
  if (handler) {
    try {
      handler(message);
      recordMessageSent(fromAgentId);
      touchAgent(toAgentId);
      return { delivered: true };
    } catch (error2) {
      return { delivered: false, error: error2 instanceof Error ? error2.message : "Handler error" };
    }
  }
  return { delivered: false, error: "No handler registered for recipient" };
}
async function invokeAgent(request, fromAgentId, fromOrigin, traceId) {
  const trace = traceId || "no-trace";
  const startTime = Date.now();
  const fromAgent = getAgent(fromAgentId);
  const toAgent = getAgent(request.agentId);
  console.log(`[TRACE ${trace}] invokeAgent START - from: ${fromAgentId}, to: ${request.agentId}, task: ${request.task}`);
  if (!fromAgent) {
    return {
      success: false,
      error: { code: "ERR_AGENT_NOT_FOUND", message: "Invoker agent not found" },
      executionTime: Date.now() - startTime
    };
  }
  if (!toAgent) {
    return {
      success: false,
      error: { code: "ERR_AGENT_NOT_FOUND", message: "Target agent not found" },
      executionTime: Date.now() - startTime
    };
  }
  if (!toAgent.acceptsInvocations) {
    return {
      success: false,
      error: { code: "ERR_NOT_ACCEPTED", message: "Target agent does not accept invocations" },
      executionTime: Date.now() - startTime
    };
  }
  if (fromAgent.origin !== toAgent.origin) {
    const check = await checkPermissions(fromOrigin, ["agents:crossOrigin"]);
    if (!check.granted) {
      return {
        success: false,
        error: { code: "ERR_PERMISSION_DENIED", message: "Cross-origin invocation requires agents:crossOrigin permission" },
        executionTime: Date.now() - startTime
      };
    }
  }
  const handler = invocationHandlers.get(request.agentId);
  if (!handler) {
    console.log(`[TRACE ${trace}] ERROR - no handler for ${request.agentId}`);
    return {
      success: false,
      error: { code: "ERR_NO_HANDLER", message: "Target agent has no invocation handler" },
      executionTime: Date.now() - startTime
    };
  }
  console.log(`[TRACE ${trace}] Found handler, calling it...`);
  recordInvocationMade(fromAgentId);
  recordInvocationReceived(request.agentId);
  const timeout = request.timeout || 3e4;
  try {
    const result = await Promise.race([
      handler(request, fromAgentId, trace),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Invocation timeout")), timeout);
      })
    ]);
    console.log(`[TRACE ${trace}] Handler returned, success: ${result.success}`);
    return {
      ...result,
      executionTime: Date.now() - startTime
    };
  } catch (error2) {
    return {
      success: false,
      error: {
        code: "ERR_INVOCATION_FAILED",
        message: error2 instanceof Error ? error2.message : "Invocation failed"
      },
      executionTime: Date.now() - startTime
    };
  }
}

// src/multi-agent/orchestration.ts
async function executePipeline(pipeline, initialInput, invokerAgentId, invokerOrigin) {
  const startTime = Date.now();
  const stepResults = [];
  let currentInput = initialInput;
  for (const step of pipeline.steps) {
    const stepStartTime = Date.now();
    const task = formatTaskTemplate(step.taskTemplate, currentInput);
    const request = {
      agentId: step.agentId,
      task,
      input: currentInput
    };
    const response = await invokeAgent(request, invokerAgentId, invokerOrigin);
    const stepResult = {
      stepId: step.id,
      agentId: step.agentId,
      success: response.success,
      result: response.result,
      error: response.error?.message,
      executionTime: Date.now() - stepStartTime
    };
    stepResults.push(stepResult);
    if (!response.success) {
      return {
        pipelineId: pipeline.id,
        success: false,
        stepResults,
        totalExecutionTime: Date.now() - startTime,
        error: `Pipeline failed at step ${step.id}: ${response.error?.message}`
      };
    }
    if (step.outputTransform) {
      currentInput = applyTransform(response.result, step.outputTransform);
    } else {
      currentInput = response.result;
    }
  }
  return {
    pipelineId: pipeline.id,
    success: true,
    stepResults,
    finalOutput: currentInput,
    totalExecutionTime: Date.now() - startTime
  };
}
function formatTaskTemplate(template, input) {
  const inputStr = typeof input === "string" ? input : JSON.stringify(input);
  return template.replace(/\{\{input\}\}/g, inputStr);
}
function applyTransform(value, transform) {
  if (transform.startsWith(".")) {
    const path = transform.slice(1).split(".");
    let current = value;
    for (const key of path) {
      if (current === null || current === void 0) return void 0;
      current = current[key];
    }
    return current;
  }
  return value;
}
async function executeParallel(execution, invokerAgentId, invokerOrigin) {
  const startTime = Date.now();
  const taskPromises = execution.tasks.map(async (task) => {
    const taskStartTime = Date.now();
    const request = {
      agentId: task.agentId,
      task: task.task,
      input: task.input
    };
    const response = await invokeAgent(request, invokerAgentId, invokerOrigin);
    return {
      agentId: task.agentId,
      success: response.success,
      result: response.result,
      error: response.error?.message,
      executionTime: Date.now() - taskStartTime
    };
  });
  const taskResults = await Promise.all(taskPromises);
  const allSuccess = taskResults.every((r) => r.success);
  let combinedOutput;
  switch (execution.combineStrategy) {
    case "array":
      combinedOutput = taskResults.map((r) => r.result);
      break;
    case "merge":
      combinedOutput = taskResults.reduce((acc, r) => {
        if (r.result && typeof r.result === "object") {
          return { ...acc, ...r.result };
        }
        return acc;
      }, {});
      break;
    case "first":
      combinedOutput = taskResults.find((r) => r.success)?.result;
      break;
    case "custom":
      combinedOutput = taskResults;
      break;
  }
  return {
    executionId: execution.id,
    success: allSuccess,
    taskResults,
    combinedOutput,
    totalExecutionTime: Date.now() - startTime
  };
}
async function executeRouter(router, input, task, invokerAgentId, invokerOrigin) {
  let selectedAgentId;
  let matchedCondition = null;
  for (const route of router.routes) {
    if (evaluateCondition(route.condition, input)) {
      selectedAgentId = route.agentId;
      matchedCondition = route.condition;
      break;
    }
  }
  if (!selectedAgentId) {
    if (router.defaultAgentId) {
      selectedAgentId = router.defaultAgentId;
    } else {
      return {
        routerId: router.id,
        selectedAgentId: "",
        matchedCondition: null,
        invocationResult: {
          success: false,
          error: { code: "ERR_NO_ROUTE", message: "No matching route and no default agent" },
          executionTime: 0
        }
      };
    }
  }
  const request = {
    agentId: selectedAgentId,
    task,
    input
  };
  const result = await invokeAgent(request, invokerAgentId, invokerOrigin);
  return {
    routerId: router.id,
    selectedAgentId,
    matchedCondition,
    invocationResult: result
  };
}
function evaluateCondition(condition, input) {
  if (condition === "always") {
    return true;
  }
  const inputObj = input;
  if (condition.startsWith("hasProperty:")) {
    const prop = condition.slice("hasProperty:".length);
    return inputObj !== null && typeof inputObj === "object" && prop in inputObj;
  }
  if (condition.startsWith("type:")) {
    const expectedType = condition.slice("type:".length);
    return typeof input === expectedType;
  }
  if (condition.startsWith("regex:")) {
    const pattern = condition.slice("regex:".length);
    try {
      const regex = new RegExp(pattern);
      return typeof input === "string" && regex.test(input);
    } catch {
      return false;
    }
  }
  const colonIndex = condition.indexOf(":");
  if (colonIndex > 0) {
    const field = condition.slice(0, colonIndex);
    const value = condition.slice(colonIndex + 1);
    if (inputObj && typeof inputObj === "object") {
      return String(inputObj[field]) === value;
    }
  }
  return false;
}
async function executeSupervisor(supervisor, tasks, invokerAgentId, invokerOrigin) {
  const startTime = Date.now();
  const results = [];
  const workerState = /* @__PURE__ */ new Map();
  const maxConcurrent = supervisor.maxConcurrentPerWorker ?? 1;
  for (const workerId of supervisor.workers) {
    workerState.set(workerId, { busyCount: 0, totalAssigned: 0 });
  }
  const validWorkers = [];
  for (const workerId of supervisor.workers) {
    const worker = getAgent(workerId);
    if (worker && worker.acceptsInvocations) {
      validWorkers.push(workerId);
    }
  }
  if (validWorkers.length === 0) {
    return {
      success: false,
      results: tasks.map((task) => ({
        taskId: task.id,
        workerId: "",
        error: "No valid workers available",
        attempts: 0,
        executionTime: 0
      })),
      stats: {
        totalTasks: tasks.length,
        succeeded: 0,
        failed: tasks.length,
        totalTime: Date.now() - startTime
      }
    };
  }
  const sortedTasks = [...tasks].sort((a2, b2) => (b2.priority ?? 0) - (a2.priority ?? 0));
  let roundRobinIndex = 0;
  const taskPromises = sortedTasks.map(async (task) => {
    const taskStartTime = Date.now();
    let attempts = 0;
    let lastError;
    const maxAttempts = (supervisor.retry?.maxAttempts ?? 0) + 1;
    const triedWorkers = /* @__PURE__ */ new Set();
    while (attempts < maxAttempts) {
      const worker = selectWorker(
        supervisor.assignmentStrategy,
        validWorkers,
        workerState,
        maxConcurrent,
        task,
        triedWorkers,
        roundRobinIndex
      );
      if (!worker) {
        lastError = "No available worker for task";
        break;
      }
      if (supervisor.assignmentStrategy === "round-robin") {
        roundRobinIndex = (validWorkers.indexOf(worker) + 1) % validWorkers.length;
      }
      const state = workerState.get(worker);
      state.busyCount++;
      state.totalAssigned++;
      triedWorkers.add(worker);
      attempts++;
      try {
        const request = {
          agentId: worker,
          task: task.task,
          input: task.input
        };
        const response = await invokeAgent(request, invokerAgentId, invokerOrigin);
        state.busyCount--;
        if (response.success) {
          return {
            taskId: task.id,
            workerId: worker,
            result: response.result,
            attempts,
            executionTime: Date.now() - taskStartTime
          };
        } else {
          lastError = response.error?.message ?? "Unknown error";
          if (supervisor.retry?.reassignOnFailure && attempts < maxAttempts) {
            if (supervisor.retry.delayMs) {
              await delay(supervisor.retry.delayMs);
            }
            continue;
          }
        }
      } catch (error2) {
        state.busyCount--;
        lastError = error2 instanceof Error ? error2.message : "Unknown error";
        if (attempts < maxAttempts && supervisor.retry?.delayMs) {
          await delay(supervisor.retry.delayMs);
        }
      }
    }
    return {
      taskId: task.id,
      workerId: triedWorkers.size > 0 ? Array.from(triedWorkers).pop() : "",
      error: lastError,
      attempts,
      executionTime: Date.now() - taskStartTime
    };
  });
  const taskResults = await Promise.all(taskPromises);
  results.push(...taskResults);
  const succeeded = results.filter((r) => !r.error).length;
  const failed = results.filter((r) => r.error).length;
  return {
    success: failed === 0,
    results,
    stats: {
      totalTasks: tasks.length,
      succeeded,
      failed,
      totalTime: Date.now() - startTime
    }
  };
}
function selectWorker(strategy, workers, workerState, maxConcurrent, task, excludeWorkers, roundRobinIndex) {
  const availableWorkers = workers.filter((w2) => {
    if (excludeWorkers.has(w2)) return false;
    const state = workerState.get(w2);
    return state && state.busyCount < maxConcurrent;
  });
  if (availableWorkers.length === 0) {
    const fallbackWorkers = workers.filter((w2) => !excludeWorkers.has(w2));
    if (fallbackWorkers.length === 0) return null;
    return fallbackWorkers[0];
  }
  switch (strategy) {
    case "round-robin": {
      for (let i2 = 0; i2 < availableWorkers.length; i2++) {
        const idx = (roundRobinIndex + i2) % workers.length;
        const worker = workers[idx];
        if (availableWorkers.includes(worker)) {
          return worker;
        }
      }
      return availableWorkers[0];
    }
    case "random": {
      const idx = Math.floor(Math.random() * availableWorkers.length);
      return availableWorkers[idx];
    }
    case "least-busy": {
      let leastBusy = null;
      let minBusy = Infinity;
      for (const worker of availableWorkers) {
        const state = workerState.get(worker);
        if (state.busyCount < minBusy) {
          minBusy = state.busyCount;
          leastBusy = worker;
        }
      }
      return leastBusy;
    }
    case "capability-match": {
      if (!task.requiredCapabilities || task.requiredCapabilities.length === 0) {
        return availableWorkers[0];
      }
      for (const worker of availableWorkers) {
        const agent = getAgent(worker);
        if (agent) {
          const hasAllCapabilities = task.requiredCapabilities.every(
            (cap) => agent.capabilities.includes(cap)
          );
          if (hasAllCapabilities) {
            return worker;
          }
        }
      }
      return availableWorkers[0];
    }
    default:
      return availableWorkers[0];
  }
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src/multi-agent/remote.ts
var remoteAgents = /* @__PURE__ */ new Map();
var remoteIdCounter = 0;
function generateRemoteId() {
  return `remote-${Date.now()}-${++remoteIdCounter}`;
}
async function connectRemoteAgent(endpoint, headers) {
  try {
    const infoUrl = new URL("/agent-info", endpoint.url).toString();
    const response = await fetch(infoUrl, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        ...getAuthHeaders(endpoint),
        ...headers
      }
    });
    if (!response.ok) {
      console.warn("[RemoteA2A] Failed to connect to", endpoint.url, response.status);
      return null;
    }
    const info = await response.json();
    const id = generateRemoteId();
    const remoteAgent = {
      id,
      name: info.name,
      description: info.description,
      capabilities: info.capabilities || [],
      endpoint,
      reachable: true,
      lastPing: Date.now()
    };
    remoteAgents.set(id, remoteAgent);
    console.log("[RemoteA2A] Connected to remote agent:", id, info.name);
    return remoteAgent;
  } catch (error2) {
    console.warn("[RemoteA2A] Connection failed:", error2);
    return null;
  }
}
function disconnectRemoteAgent(agentId) {
  return remoteAgents.delete(agentId);
}
function listRemoteAgents() {
  return Array.from(remoteAgents.values());
}
async function pingRemoteAgent(agentId) {
  const agent = remoteAgents.get(agentId);
  if (!agent) return false;
  try {
    const healthUrl = new URL("/health", agent.endpoint.url).toString();
    const response = await fetch(healthUrl, {
      method: "GET",
      headers: getAuthHeaders(agent.endpoint)
    });
    agent.reachable = response.ok;
    agent.lastPing = Date.now();
    return response.ok;
  } catch {
    agent.reachable = false;
    return false;
  }
}
function getAuthHeaders(endpoint) {
  return {};
}
async function discoverRemoteAgents(baseUrl) {
  try {
    const discoveryUrl = new URL("/.well-known/agents", baseUrl).toString();
    const response = await fetch(discoveryUrl, {
      method: "GET",
      headers: { "Accept": "application/json" }
    });
    if (!response.ok) {
      return [];
    }
    const data = await response.json();
    return data.agents || [];
  } catch {
    return [];
  }
}

// src/agents/background-router.ts
init_bridge_client();
var DEBUG = true;
function log(...args) {
  if (DEBUG) {
    console.log("[Harbor Router]", ...args);
  }
}
var textSessions = /* @__PURE__ */ new Map();
var activeChats = /* @__PURE__ */ new Map();
var sessionIdCounter = 0;
function generateSessionId() {
  return `session-${Date.now()}-${++sessionIdCounter}`;
}
async function requirePermission(ctx, sender, scope) {
  log("requirePermission check - origin:", ctx.origin, "scope:", scope, "tabId:", ctx.tabId);
  const result = await checkPermissions(ctx.origin, [scope], ctx.tabId);
  log("requirePermission result:", JSON.stringify(result));
  if (result.granted) {
    return true;
  }
  sender.sendResponse({
    id: ctx.id,
    ok: false,
    error: {
      code: "ERR_SCOPE_REQUIRED",
      message: `Permission "${scope}" is required. Call agent.requestPermissions() first.`,
      details: { requiredScope: scope, missingScopes: result.missingScopes }
    }
  });
  return false;
}
async function handleRequestPermissions(ctx, sender) {
  const payload = ctx.payload;
  log("handleRequestPermissions:", ctx.origin, payload);
  const result = await requestPermissions(ctx.origin, payload, ctx.tabId);
  log("Permission result:", result);
  sender.sendResponse({
    id: ctx.id,
    ok: true,
    result
  });
}
async function handleListPermissions(ctx, sender) {
  const status = await getPermissionStatus(ctx.origin, ctx.tabId);
  sender.sendResponse({
    id: ctx.id,
    ok: true,
    result: status
  });
}
async function handleAgentCapabilities(ctx, sender) {
  try {
    const permStatus = await getPermissionStatus(ctx.origin, ctx.tabId);
    const runtimeCaps = await getRuntimeCapabilities();
    let toolCount = 0;
    const serverIds = [];
    try {
      const servers = await listServersWithStatus();
      for (const server of servers) {
        if (server.running) {
          serverIds.push(server.id);
          toolCount += server.tools?.length || 0;
        }
      }
    } catch {
    }
    const browserInteractionEnabled = true;
    const screenshotsEnabled = true;
    const browserControlEnabled = true;
    const multiAgentEnabled = true;
    let bestRuntime = null;
    if (runtimeCaps.firefox?.available && runtimeCaps.firefox.hasWllama) {
      bestRuntime = "firefox";
    } else if (runtimeCaps.chrome?.available) {
      bestRuntime = "chrome";
    } else if (runtimeCaps.harbor?.bridgeConnected) {
      bestRuntime = "harbor";
    }
    const report = {
      version: "1.0.0",
      llm: {
        available: runtimeCaps.harbor?.bridgeConnected || runtimeCaps.firefox?.available || runtimeCaps.chrome?.available || false,
        streaming: true,
        // All our providers support streaming
        toolCalling: runtimeCaps.harbor?.bridgeConnected || runtimeCaps.firefox?.supportsTools || runtimeCaps.chrome?.supportsTools || false,
        providers: runtimeCaps.harbor?.providers || [],
        bestRuntime
      },
      tools: {
        available: toolCount > 0,
        count: toolCount,
        servers: serverIds
      },
      browser: {
        readActiveTab: true,
        // Always supported
        interact: browserInteractionEnabled,
        screenshot: screenshotsEnabled,
        // Extension 2 features (requires browserControl flag)
        navigate: browserControlEnabled,
        readTabs: browserControlEnabled,
        createTabs: browserControlEnabled
      },
      // Extension 3 features (requires multiAgent flag)
      agents: {
        register: multiAgentEnabled,
        discover: multiAgentEnabled,
        invoke: multiAgentEnabled,
        message: multiAgentEnabled,
        crossOrigin: multiAgentEnabled,
        remote: multiAgentEnabled
      },
      permissions: {
        llm: {
          prompt: permStatus.scopes["model:prompt"] || "not-granted",
          tools: permStatus.scopes["model:tools"] || "not-granted",
          list: permStatus.scopes["model:list"] || "not-granted"
        },
        mcp: {
          list: permStatus.scopes["mcp:tools.list"] || "not-granted",
          call: permStatus.scopes["mcp:tools.call"] || "not-granted",
          register: permStatus.scopes["mcp:servers.register"] || "not-granted"
        },
        browser: {
          read: permStatus.scopes["browser:activeTab.read"] || "not-granted",
          interact: permStatus.scopes["browser:activeTab.interact"] || "not-granted",
          screenshot: permStatus.scopes["browser:activeTab.screenshot"] || "not-granted",
          // Extension 2 scopes
          navigate: permStatus.scopes["browser:navigate"] || "not-granted",
          tabsRead: permStatus.scopes["browser:tabs.read"] || "not-granted",
          tabsCreate: permStatus.scopes["browser:tabs.create"] || "not-granted"
        },
        // Extension 3 scopes
        agents: {
          register: permStatus.scopes["agents:register"] || "not-granted",
          discover: permStatus.scopes["agents:discover"] || "not-granted",
          invoke: permStatus.scopes["agents:invoke"] || "not-granted",
          message: permStatus.scopes["agents:message"] || "not-granted",
          crossOrigin: permStatus.scopes["agents:crossOrigin"] || "not-granted",
          remote: permStatus.scopes["agents:remote"] || "not-granted"
        },
        web: {
          fetch: permStatus.scopes["web:fetch"] || "not-granted"
        }
      },
      allowedTools: permStatus.allowedTools || [],
      features: {
        browserInteraction: browserInteractionEnabled,
        screenshots: screenshotsEnabled,
        // Extension 2 & 3 feature flags
        browserControl: browserControlEnabled,
        multiAgent: multiAgentEnabled,
        remoteTabs: browserControlEnabled,
        // Part of browserControl
        webFetch: browserControlEnabled
        // Part of browserControl
      }
    };
    sender.sendResponse({
      id: ctx.id,
      ok: true,
      result: report
    });
  } catch (error2) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_INTERNAL",
        message: error2 instanceof Error ? error2.message : "Failed to get capabilities"
      }
    });
  }
}
async function handleToolsList(ctx, sender) {
  if (!await requirePermission(ctx, sender, "mcp:tools.list")) {
    return;
  }
  try {
    const servers = await listServersWithStatus();
    const tools = [];
    for (const server of servers) {
      if (server.running && server.tools) {
        for (const tool of server.tools) {
          tools.push({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            serverId: server.id
          });
        }
      }
    }
    sender.sendResponse({
      id: ctx.id,
      ok: true,
      result: tools
    });
  } catch (error2) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_INTERNAL",
        message: error2 instanceof Error ? error2.message : "Failed to list tools"
      }
    });
  }
}
async function handleToolsCall(ctx, sender) {
  if (!await requirePermission(ctx, sender, "mcp:tools.call")) {
    return;
  }
  const payload = ctx.payload;
  const allowed = await isToolAllowed(ctx.origin, payload.tool);
  if (!allowed) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_TOOL_NOT_ALLOWED",
        message: `Tool "${payload.tool}" is not in the allowed list`
      }
    });
    return;
  }
  try {
    const parts = payload.tool.split("/");
    let serverId;
    let toolName;
    if (parts.length >= 2) {
      serverId = parts[0];
      toolName = parts.slice(1).join("/");
    } else {
      const servers = await listServersWithStatus();
      const found = servers.find((s2) => s2.running && s2.tools?.some((t) => t.name === payload.tool));
      if (!found) {
        sender.sendResponse({
          id: ctx.id,
          ok: false,
          error: {
            code: "ERR_TOOL_NOT_ALLOWED",
            message: `Tool "${payload.tool}" not found in any running server`
          }
        });
        return;
      }
      serverId = found.id;
      toolName = payload.tool;
    }
    const result = await callTool(serverId, toolName, payload.args);
    sender.sendResponse({
      id: ctx.id,
      ok: result.ok,
      result: result.result,
      error: result.error ? { code: "ERR_TOOL_FAILED", message: result.error } : void 0
    });
  } catch (error2) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_INTERNAL",
        message: error2 instanceof Error ? error2.message : "Tool call failed"
      }
    });
  }
}
async function handleCanCreateTextSession(ctx, sender) {
  try {
    const result = await bridgeRequest("llm.list_configured_models");
    const available = result.models && result.models.length > 0 ? "readily" : "no";
    sender.sendResponse({ id: ctx.id, ok: true, result: available });
  } catch {
    sender.sendResponse({ id: ctx.id, ok: true, result: "no" });
  }
}
async function handleCreateTextSession(ctx, sender) {
  if (!await requirePermission(ctx, sender, "model:prompt")) {
    return;
  }
  const payload = ctx.payload || {};
  const sessionId = generateSessionId();
  textSessions.set(sessionId, {
    sessionId,
    origin: ctx.origin,
    options: payload,
    history: payload.systemPrompt ? [{ role: "system", content: payload.systemPrompt }] : [],
    createdAt: Date.now()
  });
  sender.sendResponse({ id: ctx.id, ok: true, result: sessionId });
}
async function handleSessionPrompt(ctx, sender) {
  if (!await requirePermission(ctx, sender, "model:prompt")) {
    return;
  }
  const payload = ctx.payload;
  const session = textSessions.get(payload.sessionId);
  if (!session) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: "ERR_SESSION_NOT_FOUND", message: "Session not found" }
    });
    return;
  }
  if (session.origin !== ctx.origin) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: "ERR_PERMISSION_DENIED", message: "Session belongs to different origin" }
    });
    return;
  }
  try {
    session.history.push({ role: "user", content: payload.input });
    const result = await bridgeRequest("llm.chat", {
      messages: session.history,
      model: session.options.model
    });
    const content = result.choices?.[0]?.message?.content || result.response?.content || result.message?.content || result.content || "";
    log("Session prompt result:", content.slice(0, 100));
    session.history.push({ role: "assistant", content });
    sender.sendResponse({ id: ctx.id, ok: true, result: content });
  } catch (error2) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_MODEL_FAILED",
        message: error2 instanceof Error ? error2.message : "Model request failed"
      }
    });
  }
}
async function handleSessionDestroy(ctx, sender) {
  const payload = ctx.payload;
  const session = textSessions.get(payload.sessionId);
  if (session && session.origin === ctx.origin) {
    textSessions.delete(payload.sessionId);
  }
  sender.sendResponse({ id: ctx.id, ok: true, result: void 0 });
}
async function handleLanguageModelCapabilities(ctx, sender) {
  try {
    const result = await bridgeRequest("llm.list_configured_models");
    const available = result.models && result.models.length > 0 ? "readily" : "no";
    sender.sendResponse({
      id: ctx.id,
      ok: true,
      result: {
        available,
        defaultTemperature: 0.7,
        defaultTopK: 40,
        maxTopK: 100
      }
    });
  } catch {
    sender.sendResponse({
      id: ctx.id,
      ok: true,
      result: { available: "no" }
    });
  }
}
async function handleProviderslist(ctx, sender) {
  if (!await requirePermission(ctx, sender, "model:list")) {
    return;
  }
  try {
    const providers = await listAllProviders();
    sender.sendResponse({ id: ctx.id, ok: true, result: providers });
  } catch (error2) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_INTERNAL",
        message: error2 instanceof Error ? error2.message : "Failed to list providers"
      }
    });
  }
}
async function handleRuntimeGetCapabilities(ctx, sender) {
  try {
    const capabilities = await getRuntimeCapabilities();
    sender.sendResponse({ id: ctx.id, ok: true, result: capabilities });
  } catch (error2) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_INTERNAL",
        message: error2 instanceof Error ? error2.message : "Failed to get runtime capabilities"
      }
    });
  }
}
async function handleAgentRun(ctx, sender) {
  log("handleAgentRun called for:", ctx.id);
  const permCheck = await checkPermissions(ctx.origin, ["model:tools"], ctx.tabId);
  log("Permission check result:", permCheck);
  if (!permCheck.granted) {
    log("Permission denied, sending error stream event");
    sender.sendStreamEvent({
      id: ctx.id,
      event: {
        type: "error",
        error: {
          code: "ERR_SCOPE_REQUIRED",
          message: 'Permission "model:tools" is required. Call agent.requestPermissions() first.'
        }
      },
      done: true
    });
    return;
  }
  const payload = ctx.payload;
  log("Payload:", payload);
  try {
    log("Sending status event: Starting agent...");
    sender.sendStreamEvent({
      id: ctx.id,
      event: { type: "status", message: "Starting agent..." }
    });
    log("Getting available tools...");
    const servers = await listServersWithStatus();
    log("Servers:", servers.map((s2) => ({ id: s2.id, running: s2.running, tools: s2.tools?.length })));
    const availableTools = [];
    for (const server of servers) {
      if (server.running && server.tools) {
        for (const tool of server.tools) {
          availableTools.push({
            name: `${server.id}/${tool.name}`,
            serverId: server.id,
            description: tool.description,
            inputSchema: tool.inputSchema
          });
        }
      }
    }
    let toolsToUse = availableTools;
    if (payload.tools && payload.tools.length > 0 && !payload.useAllTools) {
      toolsToUse = availableTools.filter((t) => payload.tools.includes(t.name));
    }
    if (toolsToUse.length === 0) {
      sender.sendStreamEvent({
        id: ctx.id,
        event: { type: "status", message: "No tools available, running without tools..." }
      });
    }
    const toolNames = toolsToUse.map((t) => t.name.replace("/", "_")).join(", ");
    const systemPrompt = toolsToUse.length > 0 ? `You are a helpful assistant with access to tools. For each user query:
1. If you can answer directly, respond without using tools.
2. If you need external data, call the appropriate tool.
3. When you receive a tool result, use that information to respond to the user.
Available tools: ${toolNames}` : "You are a helpful assistant.";
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: payload.task }
    ];
    const llmTools = toolsToUse.map((t) => ({
      name: t.name.replace("/", "_"),
      // LLM-safe name
      description: t.description || `Tool: ${t.name}`,
      input_schema: t.inputSchema || { type: "object", properties: {} }
    }));
    const maxToolCalls = payload.maxToolCalls || 5;
    let toolCallCount = 0;
    log("Tools to use:", toolsToUse.map((t) => t.name));
    log("LLM tools:", llmTools);
    while (toolCallCount < maxToolCalls) {
      log("Agent loop iteration:", toolCallCount);
      sender.sendStreamEvent({
        id: ctx.id,
        event: { type: "status", message: toolCallCount === 0 ? "Thinking..." : "Continuing..." }
      });
      log("Calling LLM with messages:", messages.length, "tools:", llmTools.length);
      const llmResult = await bridgeRequest("llm.chat", {
        messages,
        tools: llmTools.length > 0 ? llmTools : void 0
      });
      log("LLM result received:", llmResult);
      const choice = llmResult.choices?.[0];
      if (!choice) {
        throw new Error("No response from LLM");
      }
      const response = choice.message;
      const toolCalls = response.tool_calls;
      log("Response:", response);
      log("Tool calls:", toolCalls);
      log("Finish reason:", choice.finish_reason);
      if (toolCalls && toolCalls.length > 0) {
        const toolCallSummary = toolCalls.map(
          (tc) => `[Called tool: ${tc.function.name}(${tc.function.arguments})]`
        ).join("\n");
        messages.push({
          role: "assistant",
          content: toolCallSummary
        });
      } else {
        messages.push({
          role: "assistant",
          content: response.content ?? ""
        });
      }
      if (!toolCalls || toolCalls.length === 0) {
        log("No tool calls, sending final event");
        sender.sendStreamEvent({
          id: ctx.id,
          event: {
            type: "final",
            output: response.content || ""
          },
          done: true
        });
        return;
      }
      for (const toolCall of toolCalls) {
        toolCallCount++;
        const toolName = toolCall.function.name.replace("_", "/");
        let args = {};
        try {
          args = JSON.parse(toolCall.function.arguments || "{}");
        } catch {
          args = {};
        }
        sender.sendStreamEvent({
          id: ctx.id,
          event: {
            type: "tool_call",
            tool: toolName,
            args
          }
        });
        const tool = toolsToUse.find((t) => t.name === toolName);
        log("Looking for tool:", toolName, "Found:", !!tool);
        let toolResult;
        if (tool) {
          try {
            log("Calling tool:", tool.serverId, toolName.split("/")[1] || toolName, args);
            toolResult = await callTool(tool.serverId, toolName.split("/")[1] || toolName, args);
            log("Tool result:", toolResult);
          } catch (error2) {
            log("Tool call error:", error2);
            toolResult = { ok: false, error: error2 instanceof Error ? error2.message : "Tool call failed" };
          }
        } else {
          toolResult = { ok: false, error: `Tool not found: ${toolName}` };
        }
        sender.sendStreamEvent({
          id: ctx.id,
          event: {
            type: "tool_result",
            tool: toolName,
            result: toolResult.ok ? toolResult.result : void 0,
            error: toolResult.error ? { code: "ERR_TOOL_FAILED", message: toolResult.error } : void 0
          }
        });
        let extractedResult = "";
        if (toolResult.ok && toolResult.result) {
          const mcpResult = toolResult.result;
          if (mcpResult.content && Array.isArray(mcpResult.content)) {
            extractedResult = mcpResult.content.filter((c2) => c2.type === "text" && c2.text).map((c2) => c2.text).join("\n");
          }
          if (!extractedResult) {
            extractedResult = typeof toolResult.result === "string" ? toolResult.result : JSON.stringify(toolResult.result);
          }
        }
        const resultContent = toolResult.ok ? `Tool ${toolName} returned: ${extractedResult}` : `Tool ${toolName} failed: ${toolResult.error}`;
        log("Tool result (extracted):", resultContent);
        if (toolResult.ok) {
          log("Got successful tool result, asking LLM to summarize...");
          const summaryMessages = [
            { role: "system", content: "You are a helpful assistant. Answer the user based on the tool result provided." },
            { role: "user", content: payload.task },
            { role: "assistant", content: `I called ${toolName} to get this information.` },
            { role: "user", content: resultContent }
          ];
          try {
            const summaryResult = await bridgeRequest("llm.chat", {
              messages: summaryMessages
              // NO tools - force text response
            });
            const summaryContent = summaryResult.choices?.[0]?.message?.content || resultContent;
            log("Summary from LLM:", summaryContent);
            sender.sendStreamEvent({
              id: ctx.id,
              event: {
                type: "final",
                output: summaryContent
              },
              done: true
            });
            return;
          } catch (summaryError) {
            log("Summary failed, using raw result:", summaryError);
            sender.sendStreamEvent({
              id: ctx.id,
              event: {
                type: "final",
                output: resultContent
              },
              done: true
            });
            return;
          }
        }
      }
      log("Messages after tool processing:", messages.map((m) => ({ role: m.role, content: m.content?.slice(0, 100) })));
    }
    sender.sendStreamEvent({
      id: ctx.id,
      event: {
        type: "final",
        output: "Unable to complete the task. The tools did not return useful results."
      },
      done: true
    });
  } catch (error2) {
    log("agent.run error:", error2);
    sender.sendStreamEvent({
      id: ctx.id,
      event: {
        type: "error",
        error: {
          code: "ERR_INTERNAL",
          message: error2 instanceof Error ? error2.message : "Agent run failed"
        }
      },
      done: true
    });
  }
}
async function handleActiveTabReadability(ctx, sender) {
  if (!await requirePermission(ctx, sender, "browser:activeTab.read")) {
    return;
  }
  if (!ctx.tabId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: "No tab ID available" }
    });
    return;
  }
  try {
    const result = await getTabReadability(ctx.tabId);
    sender.sendResponse({ id: ctx.id, ok: true, result });
  } catch (error2) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: error2.code || "ERR_INTERNAL",
        message: error2 instanceof Error ? error2.message : "Failed to read tab"
      }
    });
  }
}
async function handleActiveTabClick(ctx, sender) {
  if (!await requirePermission(ctx, sender, "browser:activeTab.interact")) {
    return;
  }
  if (!ctx.tabId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: "No tab ID available" }
    });
    return;
  }
  const payload = ctx.payload;
  try {
    await clickElement(ctx.tabId, payload.selector, payload.options);
    sender.sendResponse({ id: ctx.id, ok: true, result: void 0 });
  } catch (error2) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: error2.code || "ERR_INTERNAL",
        message: error2 instanceof Error ? error2.message : "Click failed"
      }
    });
  }
}
async function handleActiveTabFill(ctx, sender) {
  if (!await requirePermission(ctx, sender, "browser:activeTab.interact")) {
    return;
  }
  if (!ctx.tabId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: "No tab ID available" }
    });
    return;
  }
  const payload = ctx.payload;
  try {
    await fillInput(ctx.tabId, payload.selector, payload.value);
    sender.sendResponse({ id: ctx.id, ok: true, result: void 0 });
  } catch (error2) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: error2.code || "ERR_INTERNAL",
        message: error2 instanceof Error ? error2.message : "Fill failed"
      }
    });
  }
}
async function handleActiveTabSelect(ctx, sender) {
  if (!await requirePermission(ctx, sender, "browser:activeTab.interact")) {
    return;
  }
  if (!ctx.tabId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: "No tab ID available" }
    });
    return;
  }
  const payload = ctx.payload;
  try {
    await selectOption(ctx.tabId, payload.selector, payload.value);
    sender.sendResponse({ id: ctx.id, ok: true, result: void 0 });
  } catch (error2) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: error2.code || "ERR_INTERNAL",
        message: error2 instanceof Error ? error2.message : "Select failed"
      }
    });
  }
}
async function handleActiveTabScroll(ctx, sender) {
  if (!await requirePermission(ctx, sender, "browser:activeTab.interact")) {
    return;
  }
  if (!ctx.tabId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: "No tab ID available" }
    });
    return;
  }
  const payload = ctx.payload;
  try {
    await scrollPage(ctx.tabId, payload);
    sender.sendResponse({ id: ctx.id, ok: true, result: void 0 });
  } catch (error2) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: error2.code || "ERR_INTERNAL",
        message: error2 instanceof Error ? error2.message : "Scroll failed"
      }
    });
  }
}
async function handleActiveTabGetElement(ctx, sender) {
  if (!await requirePermission(ctx, sender, "browser:activeTab.read")) {
    return;
  }
  if (!ctx.tabId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: "No tab ID available" }
    });
    return;
  }
  const payload = ctx.payload;
  try {
    const result = await getElementInfo(ctx.tabId, payload.selector);
    sender.sendResponse({ id: ctx.id, ok: true, result });
  } catch (error2) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: error2.code || "ERR_INTERNAL",
        message: error2 instanceof Error ? error2.message : "Get element failed"
      }
    });
  }
}
async function handleActiveTabWaitForSelector(ctx, sender) {
  if (!await requirePermission(ctx, sender, "browser:activeTab.read")) {
    return;
  }
  if (!ctx.tabId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: "No tab ID available" }
    });
    return;
  }
  const payload = ctx.payload;
  try {
    const result = await waitForSelector(ctx.tabId, payload.selector, payload.options);
    sender.sendResponse({ id: ctx.id, ok: true, result });
  } catch (error2) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: error2.code || "ERR_INTERNAL",
        message: error2 instanceof Error ? error2.message : "Wait failed"
      }
    });
  }
}
async function handleActiveTabScreenshot(ctx, sender) {
  if (!await requirePermission(ctx, sender, "browser:activeTab.screenshot")) {
    return;
  }
  if (!ctx.tabId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: "No tab ID available" }
    });
    return;
  }
  const payload = ctx.payload;
  try {
    const result = await takeScreenshot(ctx.tabId, payload);
    sender.sendResponse({ id: ctx.id, ok: true, result });
  } catch (error2) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: error2.code || "ERR_INTERNAL",
        message: error2 instanceof Error ? error2.message : "Screenshot failed"
      }
    });
  }
}
async function handleBrowserNavigate(ctx, sender) {
  if (!await requirePermission(ctx, sender, "browser:navigate")) {
    return;
  }
  if (!ctx.tabId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: "No tab ID available" }
    });
    return;
  }
  const payload = ctx.payload;
  try {
    await navigateTab(ctx.origin, ctx.tabId, payload.url, true);
    sender.sendResponse({ id: ctx.id, ok: true, result: void 0 });
  } catch (error2) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_INTERNAL",
        message: error2 instanceof Error ? error2.message : "Navigation failed"
      }
    });
  }
}
async function handleBrowserWaitForNavigation(ctx, sender) {
  if (!await requirePermission(ctx, sender, "browser:navigate")) {
    return;
  }
  if (!ctx.tabId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: "No tab ID available" }
    });
    return;
  }
  const payload = ctx.payload;
  try {
    await waitForNavigation(ctx.tabId, payload?.timeout);
    sender.sendResponse({ id: ctx.id, ok: true, result: void 0 });
  } catch (error2) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_TIMEOUT",
        message: error2 instanceof Error ? error2.message : "Navigation timeout"
      }
    });
  }
}
async function handleTabsList(ctx, sender) {
  if (!await requirePermission(ctx, sender, "browser:tabs.read")) {
    return;
  }
  try {
    const tabs = await listTabs(ctx.origin);
    sender.sendResponse({ id: ctx.id, ok: true, result: tabs });
  } catch (error2) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_INTERNAL",
        message: error2 instanceof Error ? error2.message : "Failed to list tabs"
      }
    });
  }
}
async function handleTabsGet(ctx, sender) {
  if (!await requirePermission(ctx, sender, "browser:tabs.read")) {
    return;
  }
  const payload = ctx.payload;
  try {
    const tab = await getTab(ctx.origin, payload.tabId);
    sender.sendResponse({ id: ctx.id, ok: true, result: tab });
  } catch (error2) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_INTERNAL",
        message: error2 instanceof Error ? error2.message : "Failed to get tab"
      }
    });
  }
}
async function handleTabsCreate(ctx, sender) {
  if (!await requirePermission(ctx, sender, "browser:tabs.create")) {
    return;
  }
  const payload = ctx.payload;
  try {
    const tab = await createTab(ctx.origin, payload, ctx.tabId);
    sender.sendResponse({ id: ctx.id, ok: true, result: tab });
  } catch (error2) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_INTERNAL",
        message: error2 instanceof Error ? error2.message : "Failed to create tab"
      }
    });
  }
}
async function handleTabsClose(ctx, sender) {
  if (!await requirePermission(ctx, sender, "browser:tabs.create")) {
    return;
  }
  const payload = ctx.payload;
  if (!canOriginControlTab(ctx.origin, payload.tabId)) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_PERMISSION_DENIED",
        message: "Cannot close tab: origin did not create this tab"
      }
    });
    return;
  }
  try {
    const result = await closeTab(ctx.origin, payload.tabId);
    sender.sendResponse({ id: ctx.id, ok: true, result });
  } catch (error2) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_INTERNAL",
        message: error2 instanceof Error ? error2.message : "Failed to close tab"
      }
    });
  }
}
async function handleSpawnedTabReadability(ctx, sender) {
  if (!await requirePermission(ctx, sender, "browser:tabs.create")) {
    return;
  }
  const payload = ctx.payload;
  if (!canOriginControlTab(ctx.origin, payload.tabId)) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_PERMISSION_DENIED",
        message: "Cannot read tab: origin did not create this tab"
      }
    });
    return;
  }
  try {
    const result = await getTabReadability(payload.tabId);
    sender.sendResponse({ id: ctx.id, ok: true, result });
  } catch (error2) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_INTERNAL",
        message: error2 instanceof Error ? error2.message : "Failed to read tab"
      }
    });
  }
}
async function handleSpawnedTabGetHtml(ctx, sender) {
  if (!await requirePermission(ctx, sender, "browser:tabs.create")) {
    return;
  }
  const payload = ctx.payload;
  if (!canOriginControlTab(ctx.origin, payload.tabId)) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_PERMISSION_DENIED",
        message: "Cannot read tab: origin did not create this tab"
      }
    });
    return;
  }
  try {
    const result = await getTabHtml(payload.tabId, payload.selector);
    sender.sendResponse({ id: ctx.id, ok: true, result });
  } catch (error2) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_INTERNAL",
        message: error2 instanceof Error ? error2.message : "Failed to get HTML from tab"
      }
    });
  }
}
async function handleSpawnedTabClick(ctx, sender) {
  if (!await requirePermission(ctx, sender, "browser:tabs.create")) {
    return;
  }
  const payload = ctx.payload;
  if (!canOriginControlTab(ctx.origin, payload.tabId)) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_PERMISSION_DENIED",
        message: "Cannot interact with tab: origin did not create this tab"
      }
    });
    return;
  }
  try {
    await clickElement(payload.tabId, payload.selector, payload.options);
    sender.sendResponse({ id: ctx.id, ok: true, result: void 0 });
  } catch (error2) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_INTERNAL",
        message: error2 instanceof Error ? error2.message : "Click failed"
      }
    });
  }
}
async function handleSpawnedTabFill(ctx, sender) {
  if (!await requirePermission(ctx, sender, "browser:tabs.create")) {
    return;
  }
  const payload = ctx.payload;
  if (!canOriginControlTab(ctx.origin, payload.tabId)) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_PERMISSION_DENIED",
        message: "Cannot interact with tab: origin did not create this tab"
      }
    });
    return;
  }
  try {
    await fillInput(payload.tabId, payload.selector, payload.value);
    sender.sendResponse({ id: ctx.id, ok: true, result: void 0 });
  } catch (error2) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_INTERNAL",
        message: error2 instanceof Error ? error2.message : "Fill failed"
      }
    });
  }
}
async function handleSpawnedTabScroll(ctx, sender) {
  if (!await requirePermission(ctx, sender, "browser:tabs.create")) {
    return;
  }
  const payload = ctx.payload;
  if (!canOriginControlTab(ctx.origin, payload.tabId)) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_PERMISSION_DENIED",
        message: "Cannot interact with tab: origin did not create this tab"
      }
    });
    return;
  }
  try {
    await scrollPage(payload.tabId, payload);
    sender.sendResponse({ id: ctx.id, ok: true, result: void 0 });
  } catch (error2) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_INTERNAL",
        message: error2 instanceof Error ? error2.message : "Scroll failed"
      }
    });
  }
}
async function handleSpawnedTabScreenshot(ctx, sender) {
  if (!await requirePermission(ctx, sender, "browser:tabs.create")) {
    return;
  }
  const payload = ctx.payload;
  if (!canOriginControlTab(ctx.origin, payload.tabId)) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_PERMISSION_DENIED",
        message: "Cannot screenshot tab: origin did not create this tab"
      }
    });
    return;
  }
  try {
    const result = await takeScreenshot(payload.tabId, payload);
    sender.sendResponse({ id: ctx.id, ok: true, result });
  } catch (error2) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_INTERNAL",
        message: error2 instanceof Error ? error2.message : "Screenshot failed"
      }
    });
  }
}
async function handleSpawnedTabNavigate(ctx, sender) {
  if (!await requirePermission(ctx, sender, "browser:tabs.create")) {
    return;
  }
  const payload = ctx.payload;
  if (!canOriginControlTab(ctx.origin, payload.tabId)) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_PERMISSION_DENIED",
        message: "Cannot navigate tab: origin did not create this tab"
      }
    });
    return;
  }
  try {
    await navigateTab(ctx.origin, payload.tabId, payload.url, false);
    sender.sendResponse({ id: ctx.id, ok: true, result: void 0 });
  } catch (error2) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_INTERNAL",
        message: error2 instanceof Error ? error2.message : "Navigation failed"
      }
    });
  }
}
async function handleSpawnedTabWaitForNavigation(ctx, sender) {
  if (!await requirePermission(ctx, sender, "browser:tabs.create")) {
    return;
  }
  const payload = ctx.payload;
  if (!canOriginControlTab(ctx.origin, payload.tabId)) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_PERMISSION_DENIED",
        message: "Cannot wait on tab: origin did not create this tab"
      }
    });
    return;
  }
  try {
    await waitForNavigation(payload.tabId, payload.timeout);
    sender.sendResponse({ id: ctx.id, ok: true, result: void 0 });
  } catch (error2) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_TIMEOUT",
        message: error2 instanceof Error ? error2.message : "Navigation timeout"
      }
    });
  }
}
var FETCH_ALLOWED_DOMAINS = [];
async function handleAgentFetch(ctx, sender) {
  if (!await requirePermission(ctx, sender, "web:fetch")) {
    return;
  }
  const payload = ctx.payload;
  try {
    const url = new URL(payload.url);
    if (FETCH_ALLOWED_DOMAINS.length > 0 && !FETCH_ALLOWED_DOMAINS.includes(url.hostname)) {
      sender.sendResponse({
        id: ctx.id,
        ok: false,
        error: {
          code: "ERR_PERMISSION_DENIED",
          message: `Domain ${url.hostname} is not in the allowed list`
        }
      });
      return;
    }
    const response = await fetch(payload.url, {
      method: payload.method || "GET",
      headers: payload.headers,
      body: payload.body
    });
    const text = await response.text();
    const headers = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    sender.sendResponse({
      id: ctx.id,
      ok: true,
      result: {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers,
        text
      }
    });
  } catch (error2) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_INTERNAL",
        message: error2 instanceof Error ? error2.message : "Fetch failed"
      }
    });
  }
}
var originAgents = /* @__PURE__ */ new Map();
async function handleAgentsRegister(ctx, sender) {
  if (!await requirePermission(ctx, sender, "agents:register")) {
    return;
  }
  const options = ctx.payload;
  try {
    const agent = registerAgent(options, ctx.origin, ctx.tabId);
    originAgents.set(ctx.origin, agent.id);
    sender.sendResponse({
      id: ctx.id,
      ok: true,
      result: {
        id: agent.id,
        name: agent.name,
        capabilities: agent.capabilities,
        tags: agent.tags,
        acceptsInvocations: agent.acceptsInvocations,
        acceptsMessages: agent.acceptsMessages
      }
    });
  } catch (error2) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_INTERNAL",
        message: error2 instanceof Error ? error2.message : "Registration failed"
      }
    });
  }
}
async function handleAgentsUnregister(ctx, sender) {
  if (!await requirePermission(ctx, sender, "agents:register")) {
    return;
  }
  const payload = ctx.payload;
  const result = unregisterAgent(payload.agentId, ctx.origin);
  if (result) {
    originAgents.delete(ctx.origin);
  }
  sender.sendResponse({ id: ctx.id, ok: true, result });
}
async function handleAgentsGetInfo(ctx, sender) {
  const payload = ctx.payload;
  const agentId = payload?.agentId || originAgents.get(ctx.origin);
  if (!agentId) {
    sender.sendResponse({ id: ctx.id, ok: true, result: null });
    return;
  }
  const agent = getAgent(agentId);
  if (!agent) {
    sender.sendResponse({ id: ctx.id, ok: true, result: null });
    return;
  }
  if (agent.origin !== ctx.origin) {
    const check = await checkPermissions(ctx.origin, ["agents:crossOrigin"]);
    if (!check.granted) {
      sender.sendResponse({ id: ctx.id, ok: true, result: null });
      return;
    }
  }
  const usage = getAgentUsage(agentId);
  sender.sendResponse({
    id: ctx.id,
    ok: true,
    result: {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      origin: agent.origin,
      capabilities: agent.capabilities,
      tags: agent.tags,
      status: agent.status,
      usage: usage || {
        promptCount: 0,
        tokensUsed: 0,
        toolCallCount: 0,
        messagesSent: 0,
        invocationsMade: 0,
        invocationsReceived: 0
      }
    }
  });
}
async function handleAgentsDiscover(ctx, sender) {
  if (!await requirePermission(ctx, sender, "agents:discover")) {
    return;
  }
  const payload = ctx.payload;
  let allowCrossOrigin = false;
  if (payload?.includeCrossOrigin) {
    const check = await checkPermissions(ctx.origin, ["agents:crossOrigin"]);
    allowCrossOrigin = check.granted;
  }
  const agents2 = discoverAgents(ctx.origin, payload || {}, allowCrossOrigin);
  sender.sendResponse({ id: ctx.id, ok: true, result: agents2 });
}
async function handleAgentsList(ctx, sender) {
  const agents2 = getAgentsByOrigin(ctx.origin);
  sender.sendResponse({
    id: ctx.id,
    ok: true,
    result: agents2.map((a2) => ({
      id: a2.id,
      name: a2.name,
      status: a2.status
    }))
  });
}
async function handleAgentsInvoke(ctx, sender) {
  if (!await requirePermission(ctx, sender, "agents:invoke")) {
    return;
  }
  const payload = ctx.payload;
  const traceId = payload.traceId || `harbor-trace-${Date.now()}`;
  log(`[TRACE ${traceId}] handleAgentsInvoke START - target: ${payload.agentId}, task: ${payload.task}`);
  const fromAgentId = originAgents.get(ctx.origin);
  if (!fromAgentId) {
    log(`[TRACE ${traceId}] ERROR - invoker not registered`);
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_NOT_REGISTERED",
        message: "Must register as an agent before invoking others"
      }
    });
    return;
  }
  log(`[TRACE ${traceId}] Invoking from ${fromAgentId} to ${payload.agentId}`);
  const result = await invokeAgent(
    {
      agentId: payload.agentId,
      task: payload.task,
      input: payload.input,
      timeout: payload.timeout
    },
    fromAgentId,
    ctx.origin,
    traceId
  );
  log(`[TRACE ${traceId}] invokeAgentHandler complete, success: ${result.success}`);
  sender.sendResponse({ id: ctx.id, ok: true, result });
}
async function handleAgentsSend(ctx, sender) {
  if (!await requirePermission(ctx, sender, "agents:message")) {
    return;
  }
  const payload = ctx.payload;
  const fromAgentId = originAgents.get(ctx.origin);
  if (!fromAgentId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_NOT_REGISTERED",
        message: "Must register as an agent before sending messages"
      }
    });
    return;
  }
  const result = await sendMessage2(fromAgentId, payload.to, payload.payload, ctx.origin);
  sender.sendResponse({ id: ctx.id, ok: true, result });
}
async function handleAgentsSubscribe(ctx, sender) {
  if (!await requirePermission(ctx, sender, "agents:message")) {
    return;
  }
  const payload = ctx.payload;
  const agentId = originAgents.get(ctx.origin);
  if (agentId) {
    subscribeToEvent(agentId, payload.eventType);
  }
  sender.sendResponse({ id: ctx.id, ok: true, result: void 0 });
}
async function handleAgentsUnsubscribe(ctx, sender) {
  const payload = ctx.payload;
  const agentId = originAgents.get(ctx.origin);
  if (agentId) {
    unsubscribeFromEvent(agentId, payload.eventType);
  }
  sender.sendResponse({ id: ctx.id, ok: true, result: void 0 });
}
function handleAgentsRegisterMessageHandler(ctx, sender) {
  const agentId = originAgents.get(ctx.origin);
  if (!agentId) {
    sender.sendResponse({ id: ctx.id, ok: true, result: void 0 });
    return;
  }
  registerMessageHandler(agentId, (message) => {
    if (ctx.tabId) {
      browserAPI.tabs.sendMessage(ctx.tabId, {
        type: "harbor_agent_message",
        message
      }).catch(() => {
      });
    }
  });
  sender.sendResponse({ id: ctx.id, ok: true, result: void 0 });
}
function handleAgentsUnregisterMessageHandler(ctx, sender) {
  const agentId = originAgents.get(ctx.origin);
  if (agentId) {
    unregisterMessageHandler(agentId);
  }
  sender.sendResponse({ id: ctx.id, ok: true, result: void 0 });
}
var externalInvocationHandlers = /* @__PURE__ */ new Map();
function handleAgentsRegisterInvocationHandler(ctx, sender) {
  log("handleAgentsRegisterInvocationHandler called, payload:", JSON.stringify(ctx.payload));
  const payload = ctx.payload;
  const agentId = payload?.agentId || originAgents.get(ctx.origin);
  log("Resolved agentId:", agentId, "from payload.agentId:", payload?.agentId, "or originAgents lookup");
  if (!agentId) {
    log("No agent found for invocation handler registration:", ctx.origin);
    sender.sendResponse({ id: ctx.id, ok: true, result: void 0 });
    return;
  }
  const handlerOrigin = payload?.origin || ctx.origin;
  const handlerTabId = payload?.tabId || ctx.tabId;
  const handlerExtensionId = ctx.senderExtensionId;
  log("Registering invocation handler for", agentId, "origin:", handlerOrigin, "tabId:", handlerTabId, "extensionId:", handlerExtensionId);
  externalInvocationHandlers.set(agentId, { origin: handlerOrigin, tabId: handlerTabId, extensionId: handlerExtensionId });
  registerInvocationHandler(agentId, async (request, fromAgentId, traceId) => {
    const trace = traceId || "no-trace";
    log(`[TRACE ${trace}] Proxy handler called for ${agentId}, task: ${request.task}`);
    const externalInfo = externalInvocationHandlers.get(agentId);
    if (!externalInfo) {
      log(`[TRACE ${trace}] ERROR - no external handler info`);
      return {
        success: false,
        error: { code: "ERR_NO_EXTERNAL_HANDLER", message: "External handler not found" },
        executionTime: 0
      };
    }
    log(`[TRACE ${trace}] Forwarding to Web Agents API...`);
    try {
      const forwardRequest = {
        from: fromAgentId,
        task: request.task,
        input: request.input,
        timeout: request.timeout
      };
      const response = await forwardInvocationToExtension(agentId, forwardRequest, externalInfo, trace);
      log(`[TRACE ${trace}] forwardInvocationToExtension returned, success: ${response.success}`);
      return response;
    } catch (e) {
      log(`[TRACE ${trace}] forwardInvocationToExtension ERROR: ${e instanceof Error ? e.message : "Unknown"}`);
      return {
        success: false,
        error: { code: "ERR_FORWARD_FAILED", message: e instanceof Error ? e.message : "Forward failed" },
        executionTime: 0
      };
    }
  });
  sender.sendResponse({ id: ctx.id, ok: true, result: void 0 });
}
async function forwardInvocationToExtension(agentId, request, handlerInfo, traceId) {
  const trace = traceId || "no-trace";
  const startTime = Date.now();
  log(`[TRACE ${trace}] forwardInvocationToExtension - agentId: ${agentId}, task: ${request.task}, extensionId: ${handlerInfo.extensionId}, tabId: ${handlerInfo.tabId}`);
  if (!handlerInfo.extensionId) {
    log(`[TRACE ${trace}] ERROR - no extensionId in handlerInfo`);
    return {
      success: false,
      error: { code: "ERR_NO_EXTENSION", message: "No extension ID available for invocation forwarding" },
      executionTime: Date.now() - startTime
    };
  }
  return new Promise((resolve) => {
    const timeout = request.timeout || 3e4;
    const timeoutId = setTimeout(() => {
      log(`[TRACE ${trace}] forwardInvocationToExtension TIMEOUT`);
      resolve({
        success: false,
        error: { code: "ERR_TIMEOUT", message: "Invocation timed out" },
        executionTime: Date.now() - startTime
      });
    }, timeout);
    log(`[TRACE ${trace}] Sending to extension ${handlerInfo.extensionId}...`);
    browserAPI.runtime.sendMessage(
      handlerInfo.extensionId,
      {
        type: "harbor.forwardInvocation",
        agentId,
        request,
        handlerInfo: { origin: handlerInfo.origin, tabId: handlerInfo.tabId },
        traceId: trace
      },
      (response) => {
        clearTimeout(timeoutId);
        if (browserAPI.runtime.lastError) {
          log(`[TRACE ${trace}] runtime.sendMessage error: ${browserAPI.runtime.lastError.message}`);
          resolve({
            success: false,
            error: { code: "ERR_SEND_FAILED", message: browserAPI.runtime.lastError.message || "Send failed" },
            executionTime: Date.now() - startTime
          });
          return;
        }
        log(`[TRACE ${trace}] Got response from extension: ${JSON.stringify(response)}`);
        resolve({
          ...response,
          executionTime: Date.now() - startTime
        });
      }
    );
  });
}
function handleAgentsUnregisterInvocationHandler(ctx, sender) {
  const agentId = originAgents.get(ctx.origin);
  if (agentId) {
    unregisterInvocationHandler(agentId);
  }
  sender.sendResponse({ id: ctx.id, ok: true, result: void 0 });
}
async function handleOrchestratePipeline(ctx, sender) {
  if (!await requirePermission(ctx, sender, "agents:invoke")) {
    return;
  }
  const payload = ctx.payload;
  const agentId = originAgents.get(ctx.origin);
  if (!agentId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: "ERR_NOT_REGISTERED", message: "Must register as an agent first" }
    });
    return;
  }
  const result = await executePipeline(payload.pipeline, payload.initialInput, agentId, ctx.origin);
  sender.sendResponse({ id: ctx.id, ok: true, result });
}
async function handleOrchestrateParallel(ctx, sender) {
  if (!await requirePermission(ctx, sender, "agents:invoke")) {
    return;
  }
  const payload = ctx.payload;
  const agentId = originAgents.get(ctx.origin);
  if (!agentId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: "ERR_NOT_REGISTERED", message: "Must register as an agent first" }
    });
    return;
  }
  const result = await executeParallel(payload, agentId, ctx.origin);
  sender.sendResponse({ id: ctx.id, ok: true, result });
}
async function handleOrchestrateRoute(ctx, sender) {
  if (!await requirePermission(ctx, sender, "agents:invoke")) {
    return;
  }
  const payload = ctx.payload;
  const agentId = originAgents.get(ctx.origin);
  if (!agentId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: "ERR_NOT_REGISTERED", message: "Must register as an agent first" }
    });
    return;
  }
  const result = await executeRouter(payload.router, payload.input, payload.task, agentId, ctx.origin);
  sender.sendResponse({ id: ctx.id, ok: true, result });
}
async function handleOrchestrateSupervisor(ctx, sender) {
  if (!await requirePermission(ctx, sender, "agents:invoke")) {
    return;
  }
  const payload = ctx.payload;
  const agentId = originAgents.get(ctx.origin);
  if (!agentId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: "ERR_NOT_REGISTERED", message: "Must register as an agent first" }
    });
    return;
  }
  const result = await executeSupervisor(payload.supervisor, payload.tasks, agentId, ctx.origin);
  sender.sendResponse({ id: ctx.id, ok: true, result });
}
async function handleRemoteConnect(ctx, sender) {
  if (!await requirePermission(ctx, sender, "agents:remote")) {
    return;
  }
  const payload = ctx.payload;
  try {
    const agent = await connectRemoteAgent(payload);
    if (agent) {
      sender.sendResponse({
        id: ctx.id,
        ok: true,
        result: {
          id: agent.id,
          name: agent.name,
          description: agent.description,
          capabilities: agent.capabilities,
          reachable: agent.reachable
        }
      });
    } else {
      sender.sendResponse({
        id: ctx.id,
        ok: true,
        result: null
      });
    }
  } catch (error2) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_INTERNAL",
        message: error2 instanceof Error ? error2.message : "Connection failed"
      }
    });
  }
}
async function handleRemoteDisconnect(ctx, sender) {
  const payload = ctx.payload;
  const result = disconnectRemoteAgent(payload.agentId);
  sender.sendResponse({ id: ctx.id, ok: true, result });
}
async function handleRemoteList(ctx, sender) {
  const agents2 = listRemoteAgents();
  sender.sendResponse({
    id: ctx.id,
    ok: true,
    result: agents2.map((a2) => ({
      id: a2.id,
      name: a2.name,
      description: a2.description,
      capabilities: a2.capabilities,
      url: a2.endpoint.url,
      reachable: a2.reachable,
      lastPing: a2.lastPing
    }))
  });
}
async function handleRemotePing(ctx, sender) {
  const payload = ctx.payload;
  const result = await pingRemoteAgent(payload.agentId);
  sender.sendResponse({ id: ctx.id, ok: true, result });
}
async function handleRemoteDiscover(ctx, sender) {
  if (!await requirePermission(ctx, sender, "agents:remote")) {
    return;
  }
  const payload = ctx.payload;
  try {
    const agents2 = await discoverRemoteAgents(payload.baseUrl);
    sender.sendResponse({ id: ctx.id, ok: true, result: agents2 });
  } catch (error2) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_INTERNAL",
        message: error2 instanceof Error ? error2.message : "Discovery failed"
      }
    });
  }
}
function handleChatCanOpen(ctx, sender) {
  sender.sendResponse({
    id: ctx.id,
    ok: true,
    result: "readily"
  });
}
async function handleChatOpen(ctx, sender) {
  const payload = ctx.payload;
  const hasPermission = await checkPermissions(ctx.origin, ["chat:open"]);
  if (!hasPermission) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_PERMISSION_DENIED",
        message: 'Permission "chat:open" is required. Call agent.requestPermissions() first.'
      }
    });
    return;
  }
  const tabId = ctx.tabId;
  if (!tabId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_INTERNAL",
        message: "No tab ID available"
      }
    });
    return;
  }
  const chatId = `chat-${Date.now()}-${++sessionIdCounter}`;
  activeChats.set(chatId, {
    chatId,
    tabId,
    origin: ctx.origin,
    config: {
      initialMessage: payload?.initialMessage,
      systemPrompt: payload?.systemPrompt,
      tools: payload?.tools,
      style: payload?.style
    },
    createdAt: Date.now()
  });
  try {
    await browserAPI.scripting.executeScript({
      target: { tabId },
      func: (config) => {
        window.__harborPageChatConfig = config;
      },
      args: [{
        chatId,
        initialMessage: payload?.initialMessage,
        systemPrompt: payload?.systemPrompt,
        tools: payload?.tools,
        style: payload?.style
      }]
    });
    await browserAPI.scripting.executeScript({
      target: { tabId },
      files: ["dist/page-chat.js"]
    });
    log("Page chat injected into tab", tabId, "with chatId", chatId);
    sender.sendResponse({
      id: ctx.id,
      ok: true,
      result: { success: true, chatId }
    });
  } catch (err) {
    log("Failed to inject page chat:", err);
    activeChats.delete(chatId);
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: "ERR_INTERNAL",
        message: `Failed to open chat: ${err instanceof Error ? err.message : "Unknown error"}`
      }
    });
  }
}
async function handleChatClose(ctx, sender) {
  const payload = ctx.payload;
  const chatId = payload?.chatId;
  if (chatId) {
    const chat = activeChats.get(chatId);
    if (chat) {
      try {
        await browserAPI.tabs.sendMessage(chat.tabId, {
          type: "harbor_chat_close",
          chatId
        });
      } catch {
      }
      activeChats.delete(chatId);
    }
  } else {
    for (const [id, chat] of activeChats) {
      if (chat.origin === ctx.origin) {
        try {
          await browserAPI.tabs.sendMessage(chat.tabId, {
            type: "harbor_chat_close",
            chatId: id
          });
        } catch {
        }
        activeChats.delete(id);
      }
    }
  }
  sender.sendResponse({
    id: ctx.id,
    ok: true,
    result: { success: true }
  });
}
var websiteMcpServers = /* @__PURE__ */ new Map();
async function handleMcpDiscover(ctx, sender) {
  const { tabId } = ctx;
  if (!tabId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: "ERR_NO_TAB", message: "No tab context for discovery" }
    });
    return;
  }
  try {
    const results = await browserAPI.scripting.executeScript({
      target: { tabId },
      func: () => {
        const links = document.querySelectorAll('link[rel="mcp-server"]');
        return Array.from(links).map((link) => ({
          url: link.getAttribute("href") || "",
          name: link.getAttribute("title") || void 0,
          description: link.getAttribute("data-description") || void 0,
          tools: link.getAttribute("data-tools")?.split(",").map((t) => t.trim()) || void 0,
          transport: link.getAttribute("data-transport") || "sse"
        }));
      }
    });
    const servers = results?.[0]?.result || [];
    log("MCP discover found servers:", servers.length);
    sender.sendResponse({
      id: ctx.id,
      ok: true,
      result: { servers }
    });
  } catch (err) {
    log("MCP discover error:", err);
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: "ERR_DISCOVER_FAILED", message: err instanceof Error ? err.message : "Discovery failed" }
    });
  }
}
async function handleMcpRegister(ctx, sender) {
  const { url, name, description, tools, transport } = ctx.payload;
  if (!url || !name) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INVALID_REQUEST", message: "Missing url or name" }
    });
    return;
  }
  try {
    const serverUrl = new URL(url);
    const originUrl = new URL(ctx.origin);
    const isLocalhost = serverUrl.hostname === "localhost" || serverUrl.hostname === "127.0.0.1";
    const isSameOrigin = serverUrl.origin === originUrl.origin;
    if (!isLocalhost && !isSameOrigin) {
      log("MCP register rejected - cross-origin:", url, "from", ctx.origin);
      sender.sendResponse({
        id: ctx.id,
        ok: false,
        error: { code: "ERR_CROSS_ORIGIN", message: "MCP server must be on localhost or same origin" }
      });
      return;
    }
  } catch {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INVALID_URL", message: "Invalid MCP server URL" }
    });
    return;
  }
  const serverId = `website-${ctx.origin.replace(/[^a-zA-Z0-9]/g, "-")}-${Date.now()}`;
  const server = {
    serverId,
    origin: ctx.origin,
    tabId: ctx.tabId || 0,
    url,
    name,
    description,
    tools,
    transport: transport || "sse",
    connected: false,
    registeredAt: Date.now()
  };
  websiteMcpServers.set(serverId, server);
  log("MCP server registered:", serverId, url);
  sender.sendResponse({
    id: ctx.id,
    ok: true,
    result: {
      success: true,
      serverId
    }
  });
}
function handleMcpUnregister(ctx, sender) {
  const { serverId } = ctx.payload;
  if (!serverId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INVALID_REQUEST", message: "Missing serverId" }
    });
    return;
  }
  const server = websiteMcpServers.get(serverId);
  if (!server) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: "ERR_NOT_FOUND", message: "MCP server not found" }
    });
    return;
  }
  if (server.origin !== ctx.origin) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: "ERR_FORBIDDEN", message: "Cannot unregister server from different origin" }
    });
    return;
  }
  websiteMcpServers.delete(serverId);
  log("MCP server unregistered:", serverId);
  sender.sendResponse({
    id: ctx.id,
    ok: true,
    result: { success: true }
  });
}
function handleNotImplemented(ctx, sender) {
  sender.sendResponse({
    id: ctx.id,
    ok: false,
    error: {
      code: "ERR_NOT_IMPLEMENTED",
      message: `Method "${ctx.type}" is not yet implemented`
    }
  });
}
function handleStreamingNotImplemented(ctx, sender) {
  sender.sendStreamEvent({
    id: ctx.id,
    event: {
      type: "error",
      error: {
        code: "ERR_NOT_IMPLEMENTED",
        message: `Method "${ctx.type}" is not yet implemented`
      }
    },
    done: true
  });
}
async function routeMessage(ctx, sender) {
  log("Routing message:", ctx.type, "from", ctx.origin);
  switch (ctx.type) {
    case "agent.requestPermissions":
      return handleRequestPermissions(ctx, sender);
    case "agent.permissions.list":
      return handleListPermissions(ctx, sender);
    case "agent.capabilities":
      return handleAgentCapabilities(ctx, sender);
    case "agent.tools.list":
      return handleToolsList(ctx, sender);
    case "agent.tools.call":
      return handleToolsCall(ctx, sender);
    case "ai.canCreateTextSession":
      return handleCanCreateTextSession(ctx, sender);
    case "ai.createTextSession":
    case "ai.languageModel.create":
      return handleCreateTextSession(ctx, sender);
    case "ai.languageModel.capabilities":
      return handleLanguageModelCapabilities(ctx, sender);
    case "session.prompt":
      return handleSessionPrompt(ctx, sender);
    case "session.destroy":
      return handleSessionDestroy(ctx, sender);
    case "ai.providers.list":
      return handleProviderslist(ctx, sender);
    case "agent.run":
      return handleAgentRun(ctx, sender);
    case "session.promptStreaming":
      return handleStreamingNotImplemented(ctx, sender);
    case "agent.chat.canOpen":
      return handleChatCanOpen(ctx, sender);
    case "agent.chat.open":
      return handleChatOpen(ctx, sender);
    case "agent.chat.close":
      return handleChatClose(ctx, sender);
    case "ai.runtime.getCapabilities":
      return handleRuntimeGetCapabilities(ctx, sender);
    case "agent.browser.activeTab.readability":
      return handleActiveTabReadability(ctx, sender);
    case "agent.browser.activeTab.click":
      return handleActiveTabClick(ctx, sender);
    case "agent.browser.activeTab.fill":
      return handleActiveTabFill(ctx, sender);
    case "agent.browser.activeTab.select":
      return handleActiveTabSelect(ctx, sender);
    case "agent.browser.activeTab.scroll":
      return handleActiveTabScroll(ctx, sender);
    case "agent.browser.activeTab.getElement":
      return handleActiveTabGetElement(ctx, sender);
    case "agent.browser.activeTab.waitForSelector":
      return handleActiveTabWaitForSelector(ctx, sender);
    case "agent.browser.activeTab.screenshot":
      return handleActiveTabScreenshot(ctx, sender);
    case "agent.browser.navigate":
      return handleBrowserNavigate(ctx, sender);
    case "agent.browser.waitForNavigation":
      return handleBrowserWaitForNavigation(ctx, sender);
    case "agent.browser.tabs.list":
      return handleTabsList(ctx, sender);
    case "agent.browser.tabs.get":
      return handleTabsGet(ctx, sender);
    case "agent.browser.tabs.create":
      return handleTabsCreate(ctx, sender);
    case "agent.browser.tabs.close":
      return handleTabsClose(ctx, sender);
    case "agent.browser.tab.readability":
      return handleSpawnedTabReadability(ctx, sender);
    case "agent.browser.tab.getHtml":
      return handleSpawnedTabGetHtml(ctx, sender);
    case "agent.browser.tab.click":
      return handleSpawnedTabClick(ctx, sender);
    case "agent.browser.tab.fill":
      return handleSpawnedTabFill(ctx, sender);
    case "agent.browser.tab.scroll":
      return handleSpawnedTabScroll(ctx, sender);
    case "agent.browser.tab.screenshot":
      return handleSpawnedTabScreenshot(ctx, sender);
    case "agent.browser.tab.navigate":
      return handleSpawnedTabNavigate(ctx, sender);
    case "agent.browser.tab.waitForNavigation":
      return handleSpawnedTabWaitForNavigation(ctx, sender);
    case "agent.fetch":
      return handleAgentFetch(ctx, sender);
    case "agents.register":
      return handleAgentsRegister(ctx, sender);
    case "agents.unregister":
      return handleAgentsUnregister(ctx, sender);
    case "agents.getInfo":
      return handleAgentsGetInfo(ctx, sender);
    case "agents.discover":
      return handleAgentsDiscover(ctx, sender);
    case "agents.list":
      return handleAgentsList(ctx, sender);
    case "agents.invoke":
      return handleAgentsInvoke(ctx, sender);
    case "agents.send":
      return handleAgentsSend(ctx, sender);
    case "agents.subscribe":
      return handleAgentsSubscribe(ctx, sender);
    case "agents.unsubscribe":
      return handleAgentsUnsubscribe(ctx, sender);
    case "agents.registerMessageHandler":
      return handleAgentsRegisterMessageHandler(ctx, sender);
    case "agents.unregisterMessageHandler":
      return handleAgentsUnregisterMessageHandler(ctx, sender);
    case "agents.registerInvocationHandler":
      return handleAgentsRegisterInvocationHandler(ctx, sender);
    case "agents.unregisterInvocationHandler":
      return handleAgentsUnregisterInvocationHandler(ctx, sender);
    case "agents.orchestrate.pipeline":
      return handleOrchestratePipeline(ctx, sender);
    case "agents.orchestrate.parallel":
      return handleOrchestrateParallel(ctx, sender);
    case "agents.orchestrate.route":
      return handleOrchestrateRoute(ctx, sender);
    case "agents.orchestrate.supervisor":
      return handleOrchestrateSupervisor(ctx, sender);
    case "agents.remote.connect":
      return handleRemoteConnect(ctx, sender);
    case "agents.remote.disconnect":
      return handleRemoteDisconnect(ctx, sender);
    case "agents.remote.list":
      return handleRemoteList(ctx, sender);
    case "agents.remote.ping":
      return handleRemotePing(ctx, sender);
    case "agents.remote.discover":
      return handleRemoteDiscover(ctx, sender);
    case "session.clone":
    case "ai.providers.getActive":
    case "ai.providers.add":
    case "ai.providers.remove":
    case "ai.providers.setDefault":
    case "ai.providers.setTypeDefault":
    case "ai.runtime.getBest":
      return handleNotImplemented(ctx, sender);
    case "agent.mcp.discover":
      return handleMcpDiscover(ctx, sender);
    case "agent.mcp.register":
      return handleMcpRegister(ctx, sender);
    case "agent.mcp.unregister":
      return handleMcpUnregister(ctx, sender);
    case "agent.addressBar.canProvide":
    case "agent.addressBar.registerProvider":
    case "agent.addressBar.registerToolShortcuts":
    case "agent.addressBar.registerSiteProvider":
    case "agent.addressBar.discover":
    case "agent.addressBar.listProviders":
    case "agent.addressBar.unregisterProvider":
    case "agent.addressBar.setDefaultProvider":
    case "agent.addressBar.getDefaultProvider":
    case "agent.addressBar.query":
    case "agent.addressBar.select":
      return handleNotImplemented(ctx, sender);
    default:
      sender.sendResponse({
        id: ctx.id,
        ok: false,
        error: {
          code: "ERR_NOT_IMPLEMENTED",
          message: `Unknown method: ${ctx.type}`
        }
      });
  }
}
function handlePortConnection(port) {
  if (port.name !== "web-agent-transport") {
    return;
  }
  log("New web-agent-transport connection from tab:", port.sender?.tab?.id);
  const tabId = port.sender?.tab?.id;
  port.onMessage.addListener(async (message) => {
    if (message.type === "abort") {
      log("Abort signal received for:", message.id);
      return;
    }
    const ctx = {
      id: message.id,
      type: message.type,
      payload: message.payload,
      origin: message.origin || "unknown",
      tabId
    };
    const sender = {
      sendResponse: (response) => {
        try {
          port.postMessage(response);
        } catch (error2) {
          log("Failed to send response:", error2);
        }
      },
      sendStreamEvent: (event) => {
        try {
          port.postMessage(event);
        } catch (error2) {
          log("Failed to send stream event:", error2);
        }
      }
    };
    try {
      await routeMessage(ctx, sender);
    } catch (error2) {
      log("Error routing message:", error2);
      sender.sendResponse({
        id: ctx.id,
        ok: false,
        error: {
          code: "ERR_INTERNAL",
          message: error2 instanceof Error ? error2.message : "Internal error"
        }
      });
    }
  });
  port.onDisconnect.addListener(() => {
    log("web-agent-transport disconnected from tab:", tabId);
  });
}
function handlePermissionPromptMessage(message, _sender, sendResponse) {
  if (message?.type !== "permission_prompt_response") {
    return false;
  }
  log("Permission prompt response:", message.response);
  if (message.response) {
    handlePermissionPromptResponse(message.response);
  }
  sendResponse({ ok: true });
  return true;
}
function initializeRouter() {
  log("Initializing router...");
  initializeTabManager();
  initializeAgentRegistry();
  browserAPI.runtime.onConnect.addListener(handlePortConnection);
  browserAPI.runtime.onMessage.addListener(handlePermissionPromptMessage);
  log("External message routing delegated to extension-api.ts");
  log("Router initialized");
}
function routeExternalMessage(message, sender, sendResponse) {
  log("External message from", sender.id, ":", message.type);
  log("Full message:", JSON.stringify(message));
  log("Sender:", JSON.stringify({ id: sender.id, url: sender.url, tabId: sender.tab?.id }));
  const payload = message.payload;
  const pageOrigin = payload?.origin;
  const pageTabId = payload?.tabId;
  log("Extracted from payload - origin:", pageOrigin, "tabId:", pageTabId);
  const ctx = {
    id: message.requestId || `ext-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type: message.type,
    payload: message.payload,
    origin: pageOrigin || sender.url || sender.id || "external",
    tabId: pageTabId ?? sender.tab?.id,
    senderExtensionId: sender.id
    // Store the sender's extension ID for invocation forwarding
  };
  log("Final context - origin:", ctx.origin, "tabId:", ctx.tabId, "senderExtensionId:", ctx.senderExtensionId);
  const responseSender = {
    sendResponse: (response) => {
      sendResponse({
        ok: response.ok,
        result: response.result,
        error: response.error?.message || (response.ok ? void 0 : "Unknown error")
      });
    },
    sendStreamEvent: () => {
      log("Streaming not supported for external messages");
    }
  };
  routeMessage(ctx, responseSender).catch((error2) => {
    log("Error routing external message:", error2);
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : "Unknown error"
    });
  });
}

// src/extension-api.ts
function log2(...args) {
  console.log("[Harbor ExtAPI]", ...args);
}
function error(...args) {
  console.error("[Harbor ExtAPI]", ...args);
}
function success(result) {
  return { ok: true, result };
}
function failure(err) {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: message };
}
async function handleLlmChat(payload) {
  const { messages, model, max_tokens, temperature, system, tools } = payload;
  if (!messages || messages.length === 0) {
    return failure("Missing messages");
  }
  try {
    const request = { messages, model, max_tokens, temperature, system };
    if (tools && tools.length > 0) {
      request.tools = tools;
      log2("LLM chat with tools:", tools.map((t) => t.name));
    }
    const result = await bridgeRequest("llm.chat", request);
    log2("LLM chat result:", JSON.stringify(result).substring(0, 500));
    if (result.choices && result.choices.length > 0) {
      return success({
        content: result.choices[0].message.content || "",
        model: result.model,
        choices: result.choices
      });
    }
    const content = result.response?.content || result.message?.content || result.content || "";
    return success({ content, model: result.model });
  } catch (e) {
    return failure(e);
  }
}
async function handleLlmListProviders() {
  try {
    const result = await bridgeRequest("llm.list_providers");
    return success({ providers: result.providers, default_provider: result.default_provider });
  } catch (e) {
    return failure(e);
  }
}
async function handleLlmGetActiveProvider() {
  try {
    const result = await bridgeRequest("llm.get_config");
    return success({ default_model: result.default_model, providers: result.providers });
  } catch (e) {
    return failure(e);
  }
}
async function handleLlmConfigureProvider(payload) {
  const { id, provider, name, api_key, base_url, enabled } = payload;
  if (!provider && !id) {
    return failure("Missing provider or id");
  }
  try {
    const result = await bridgeRequest("llm.configure_provider", {
      id,
      provider,
      name,
      api_key,
      base_url,
      enabled
    });
    return success({ id: result.id });
  } catch (e) {
    return failure(e);
  }
}
async function handleLlmListModels() {
  try {
    const result = await bridgeRequest("llm.list_models");
    return success({ models: result.models });
  } catch (e) {
    return failure(e);
  }
}
async function handleLlmListConfiguredModels() {
  try {
    const result = await bridgeRequest("llm.list_configured_models");
    return success({ models: result.models });
  } catch (e) {
    return failure(e);
  }
}
async function handleMcpListServers() {
  try {
    const servers = await listServersWithStatus();
    return success({ servers });
  } catch (e) {
    return failure(e);
  }
}
async function handleMcpListTools(payload) {
  const { serverId } = payload || {};
  try {
    if (serverId) {
      const tools = await listTools(serverId);
      return success({ tools });
    } else {
      const servers = await listServersWithStatus();
      const allTools = [];
      for (const server of servers) {
        if (server.running && server.tools) {
          for (const tool of server.tools) {
            allTools.push({
              serverId: server.id,
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema
            });
          }
        }
      }
      return success({ tools: allTools });
    }
  } catch (e) {
    return failure(e);
  }
}
async function handleMcpCallTool(payload) {
  const { serverId, toolName, args } = payload;
  if (!serverId || !toolName) {
    return failure("Missing serverId or toolName");
  }
  try {
    const result = await callTool(serverId, toolName, args || {});
    if (!result.ok) {
      return failure(result.error || "Tool call failed");
    }
    return success({ result: result.result });
  } catch (e) {
    return failure(e);
  }
}
async function handleMcpStartServer(payload) {
  const { serverId } = payload;
  if (!serverId) {
    return failure("Missing serverId");
  }
  try {
    const started = await startServer(serverId);
    return success({ started });
  } catch (e) {
    return failure(e);
  }
}
async function handleMcpStopServer(payload) {
  const { serverId } = payload;
  if (!serverId) {
    return failure("Missing serverId");
  }
  try {
    const stopped = stopServer(serverId);
    return success({ stopped });
  } catch (e) {
    return failure(e);
  }
}
async function handleSystemHealth() {
  try {
    const bridgeState = getBridgeConnectionState();
    const bridgeHealthy = await checkBridgeHealth();
    return success({
      healthy: bridgeHealthy,
      bridge: {
        connected: bridgeState.connected,
        ready: bridgeState.bridgeReady,
        error: bridgeState.error
      }
    });
  } catch (e) {
    return failure(e);
  }
}
async function handleSystemGetCapabilities() {
  try {
    const capabilities = await getRuntimeCapabilities();
    const bridgeReady = isNativeBridgeReady();
    return success({
      bridgeReady,
      capabilities,
      features: {
        llm: bridgeReady,
        mcp: true,
        oauth: bridgeReady,
        streaming: bridgeReady
      }
    });
  } catch (e) {
    return failure(e);
  }
}
function handleSystemGetVersion() {
  return success({
    version: "0.1.0",
    extensionId: browserAPI.runtime.id
  });
}
async function handleSystemSyncPermissions(payload) {
  const { origin, scopes, grantType, allowedTools } = payload;
  if (!origin || !scopes || !Array.isArray(scopes)) {
    return failure("Invalid payload: missing origin or scopes");
  }
  log2("Syncing permissions from Web Agents API:", { origin, scopes, grantType });
  try {
    const { grantPermissions: grantPermissions2 } = await Promise.resolve().then(() => (init_permissions(), permissions_exports));
    await grantPermissions2(
      origin,
      scopes,
      grantType,
      void 0,
      // tabId
      allowedTools
    );
    log2("Permissions synced successfully for", origin);
    return success({ synced: true });
  } catch (e) {
    error("Failed to sync permissions:", e);
    return failure(e instanceof Error ? e.message : "Failed to sync permissions");
  }
}
async function handleSessionCreate(payload) {
  const { origin, tabId, options } = payload;
  if (!origin) {
    return failure("Missing origin");
  }
  if (!options) {
    return failure("Missing session options");
  }
  try {
    const allowedTools = options.capabilities?.tools || [];
    const result = SessionRegistry.createExplicitSession(origin, options, allowedTools, tabId);
    if (result.success) {
      return success({
        sessionId: result.sessionId,
        capabilities: result.capabilities
      });
    } else {
      return failure(result.error?.message || "Session creation failed");
    }
  } catch (e) {
    return failure(e);
  }
}
async function handleSessionCreateImplicit(payload) {
  const { origin, tabId, options } = payload;
  if (!origin) {
    return failure("Missing origin");
  }
  try {
    const session = SessionRegistry.createImplicitSession(origin, options || {}, tabId);
    return success({
      sessionId: session.sessionId,
      capabilities: session.capabilities
    });
  } catch (e) {
    return failure(e);
  }
}
async function handleSessionGet(payload) {
  const { sessionId, origin } = payload;
  if (!sessionId) {
    return failure("Missing sessionId");
  }
  try {
    if (origin) {
      const session = SessionRegistry.getValidatedSession(sessionId, origin);
      return success({ session: sessionToResponse(session) });
    } else {
      const session = SessionRegistry.getSession(sessionId);
      if (!session) {
        return failure("Session not found");
      }
      return success({ session: sessionToResponse(session) });
    }
  } catch (e) {
    return failure(e);
  }
}
async function handleSessionList(payload) {
  const { origin, status, type, activeOnly } = payload || {};
  try {
    const sessions = SessionRegistry.listSessions({ origin, status, type, activeOnly });
    return success({ sessions });
  } catch (e) {
    return failure(e);
  }
}
async function handleSessionTerminate(payload) {
  const { sessionId, origin } = payload;
  if (!sessionId || !origin) {
    return failure("Missing sessionId or origin");
  }
  try {
    const terminated = SessionRegistry.terminateSession(sessionId, origin);
    return success({ terminated });
  } catch (e) {
    return failure(e);
  }
}
async function handleSessionRecordUsage(payload) {
  const { sessionId, type, detail } = payload;
  if (!sessionId || !type) {
    return failure("Missing sessionId or type");
  }
  try {
    switch (type) {
      case "prompt": {
        const { userMessage, assistantMessage } = detail;
        if (userMessage && assistantMessage) {
          SessionRegistry.recordPrompt(sessionId, userMessage, assistantMessage);
        }
        break;
      }
      case "tool": {
        const { toolName } = detail;
        if (toolName) {
          const allowed = SessionRegistry.recordToolCall(sessionId, toolName);
          if (!allowed) {
            return failure("Tool call budget exceeded");
          }
        }
        break;
      }
      case "browser": {
        const { action } = detail;
        if (action) {
          SessionRegistry.recordBrowserAccess(sessionId, action);
        }
        break;
      }
    }
    SessionRegistry.touchSession(sessionId);
    return success({ recorded: true });
  } catch (e) {
    return failure(e);
  }
}
function sessionToResponse(session) {
  if (!session) return null;
  return {
    sessionId: session.sessionId,
    type: session.type,
    origin: session.origin,
    status: session.status,
    name: session.name,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    capabilities: {
      hasLLM: session.capabilities.llm.allowed,
      toolCount: session.capabilities.tools.allowedTools.length,
      hasBrowserAccess: session.capabilities.browser.readActiveTab || session.capabilities.browser.interact || session.capabilities.browser.screenshot
    },
    usage: session.usage
  };
}
async function routeExtensionApiMessage(message, sender) {
  const { type, payload } = message;
  log2(`Request from ${sender.id}: ${type}`);
  switch (type) {
    case "llm.chat":
      return handleLlmChat(payload);
    case "llm.listProviders":
      return handleLlmListProviders();
    case "llm.getActiveProvider":
      return handleLlmGetActiveProvider();
    case "llm.configureProvider":
      return handleLlmConfigureProvider(payload);
    case "llm.listModels":
      return handleLlmListModels();
    case "llm.listConfiguredModels":
      return handleLlmListConfiguredModels();
    case "mcp.listServers":
      return handleMcpListServers();
    case "mcp.listTools":
      return handleMcpListTools(payload);
    case "mcp.callTool":
      return handleMcpCallTool(payload);
    case "mcp.startServer":
      return handleMcpStartServer(payload);
    case "mcp.stopServer":
      return handleMcpStopServer(payload);
    case "session.create":
      return handleSessionCreate(payload);
    case "session.createImplicit":
      return handleSessionCreateImplicit(payload);
    case "session.get":
      return handleSessionGet(payload);
    case "session.list":
      return handleSessionList(payload);
    case "session.terminate":
      return handleSessionTerminate(payload);
    case "session.recordUsage":
      return handleSessionRecordUsage(payload);
    case "system.health":
      return handleSystemHealth();
    case "system.getCapabilities":
      return handleSystemGetCapabilities();
    case "system.getVersion":
      return handleSystemGetVersion();
    case "system.syncPermissions":
      return handleSystemSyncPermissions(payload);
    default:
      return failure(`Unknown message type: ${type}`);
  }
}
async function handleStreamingChat(message, sender, port) {
  const { payload, requestId } = message;
  const { messages, model, max_tokens, temperature, system } = payload || {};
  if (!messages || messages.length === 0) {
    port.postMessage({ type: "stream", requestId, event: { type: "error", error: { message: "Missing messages" } } });
    return;
  }
  if (!requestId) {
    port.postMessage({ type: "stream", requestId: "", event: { type: "error", error: { message: "Missing requestId for streaming" } } });
    return;
  }
  try {
    for await (const event of bridgeStreamRequest("llm.chat", { messages, model, max_tokens, temperature, system, stream: true })) {
      port.postMessage({ type: "stream", requestId, event });
      if (event.type === "done" || event.type === "error") {
        break;
      }
    }
  } catch (e) {
    port.postMessage({
      type: "stream",
      requestId,
      event: { type: "error", error: { message: e instanceof Error ? e.message : String(e) } }
    });
  }
}
function initializeExtensionApi() {
  log2("Initializing extension API...");
  SessionRegistry.subscribe((event) => {
    log2("Session event:", event.type);
    browserAPI.runtime.sendMessage({
      type: event.type,
      ...event.type === "session_created" ? { session: event.session } : {},
      ...event.type === "session_updated" ? { session: event.session } : {},
      ...event.type === "session_terminated" ? { sessionId: event.sessionId, origin: event.origin } : {}
    }).catch(() => {
    });
  });
  browserAPI.runtime.onMessageExternal.addListener(
    (message, sender, sendResponse) => {
      if (!message?.type) {
        sendResponse(failure("Invalid message: missing type"));
        return true;
      }
      const msgType = message.type;
      log2("External message:", msgType, "from", sender.id);
      const isExtensionApiMessage = msgType.startsWith("llm.") || msgType.startsWith("mcp.") || msgType.startsWith("session.") || msgType.startsWith("system.");
      if (isExtensionApiMessage) {
        if (message.type === "llm.chatStream") {
          sendResponse(failure("Use browser.runtime.connect for streaming requests"));
          return true;
        }
        routeExtensionApiMessage(message, sender).then(sendResponse).catch((e) => sendResponse(failure(e)));
      } else {
        routeExternalMessage(
          message,
          sender,
          sendResponse
        );
      }
      return true;
    }
  );
  browserAPI.runtime.onConnectExternal.addListener((port) => {
    log2("External port connection from:", port.sender?.id);
    port.onMessage.addListener((message) => {
      if (message.type === "llm.chatStream") {
        handleStreamingChat(message, port.sender, port);
      } else {
        routeExtensionApiMessage(message, port.sender).then((response) => port.postMessage({ type: "response", ...response })).catch((e) => port.postMessage({ type: "response", ok: false, error: String(e) }));
      }
    });
  });
  log2("Extension API initialized");
}

// src/background.ts
init_browser_compat();
init_native_bridge();
console.log(`[Harbor] Extension starting on ${getBrowserName()}...`);
console.log("[Harbor] Browser features:", getFeatureSummary());
serviceWorkerLifecycle.onStartup(() => {
  console.log("[Harbor] Service worker startup - restoring state...");
  initializeBridgeClient();
});
serviceWorkerLifecycle.onInstalled((details) => {
  console.log(`[Harbor] Extension ${details.reason}${details.previousVersion ? ` from ${details.previousVersion}` : ""}`);
  if (details.reason === "install") {
    console.log("[Harbor] First install - initializing...");
  } else if (details.reason === "update") {
    console.log("[Harbor] Extension updated");
  }
});
serviceWorkerLifecycle.onSuspend(() => {
  console.log("[Harbor] Service worker suspending - saving state...");
});
initializePolicyStore();
initializeBridgeClient();
initializeMcpHost();
initializeExtensionApi();
initializeRouter();
cleanupExpiredGrants();
if (isSafari()) {
  const POLL_INTERVAL = 500;
  async function pollPendingToolCalls() {
    if (!isNativeBridgeReady()) return;
    try {
      const response = await rpcRequest("mcp.poll_pending_calls", {});
      const calls = response?.calls || [];
      for (const call of calls) {
        console.log("[Harbor:Safari] Executing pending tool call:", call.call_id, call.serverId, call.toolName);
        try {
          const result = await callTool(call.serverId, call.toolName, call.args || {});
          await rpcRequest("mcp.submit_call_result", {
            call_id: call.call_id,
            result
          });
          console.log("[Harbor:Safari] Tool call succeeded:", call.call_id);
        } catch (err) {
          await rpcRequest("mcp.submit_call_result", {
            call_id: call.call_id,
            error: err instanceof Error ? err.message : String(err)
          });
          console.error("[Harbor:Safari] Tool call failed:", call.call_id, err);
        }
      }
    } catch (err) {
    }
  }
  setInterval(pollPendingToolCalls, POLL_INTERVAL);
  console.log("[Harbor:Safari] Started pending tool call polling");
}
browserAPI.runtime.onMessage.addListener((message) => {
  console.log("[Harbor] Incoming message:", message?.type, message);
  return false;
});
globalThis.debugCallTool = callTool;
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "sidebar_get_servers") {
    return false;
  }
  (async () => {
    const servers = await listServersWithStatus();
    sendResponse({ ok: true, servers });
  })().catch((error2) => {
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  });
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "sidebar_start_server") {
    return false;
  }
  const serverId = message.serverId;
  if (!serverId) {
    sendResponse({ ok: false, error: "Missing serverId" });
    return true;
  }
  (async () => {
    const started = await startServer(serverId);
    sendResponse({ ok: started });
  })().catch((error2) => {
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  });
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "sidebar_stop_server") {
    return false;
  }
  const serverId = message.serverId;
  if (!serverId) {
    sendResponse({ ok: false, error: "Missing serverId" });
    return true;
  }
  try {
    const stopped = stopServer(serverId);
    sendResponse({ ok: stopped });
  } catch (error2) {
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  }
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "sidebar_install_server") {
    return false;
  }
  const manifest = message.manifest;
  if (!manifest?.id) {
    sendResponse({ ok: false, error: "Missing manifest id" });
    return true;
  }
  (async () => {
    await addServer(message.manifest);
    sendResponse({ ok: true });
  })().catch((error2) => {
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  });
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "sidebar_validate_server") {
    return false;
  }
  const serverId = message.serverId;
  if (!serverId) {
    sendResponse({ ok: false, error: "Missing serverId" });
    return true;
  }
  (async () => {
    const result = await validateAndStartServer(serverId);
    sendResponse(result);
  })().catch((error2) => {
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  });
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "sidebar_remove_server") {
    return false;
  }
  const serverId = message.serverId;
  if (!serverId) {
    sendResponse({ ok: false, error: "Missing serverId" });
    return true;
  }
  (async () => {
    await removeServer(serverId);
    sendResponse({ ok: true });
  })().catch((error2) => {
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  });
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "bridge_get_status") {
    return false;
  }
  const state = getBridgeConnectionState();
  sendResponse({ ok: true, ...state });
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "bridge_check_health") {
    return false;
  }
  (async () => {
    await checkBridgeHealth();
    const state = getBridgeConnectionState();
    sendResponse({ ok: true, ...state });
  })().catch((error2) => {
    sendResponse({
      ok: false,
      connected: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  });
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "llm_list_providers") {
    return false;
  }
  (async () => {
    const result = await bridgeRequest("llm.list_providers");
    sendResponse({ ok: true, providers: result.providers, default_provider: result.default_provider });
  })().catch((error2) => {
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  });
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "llm_list_provider_types") {
    return false;
  }
  (async () => {
    const result = await bridgeRequest("llm.list_provider_types");
    sendResponse({ ok: true, provider_types: result.provider_types });
  })().catch((error2) => {
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  });
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "llm_get_config") {
    return false;
  }
  (async () => {
    const result = await bridgeRequest("llm.get_config");
    sendResponse({ ok: true, config: result });
  })().catch((error2) => {
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  });
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "llm_configure_provider") {
    return false;
  }
  const { id, provider, name, api_key, base_url, enabled } = message;
  if (!provider && !id) {
    sendResponse({ ok: false, error: "Missing provider or id" });
    return true;
  }
  (async () => {
    const result = await bridgeRequest("llm.configure_provider", {
      id,
      provider,
      name,
      api_key,
      base_url,
      enabled
    });
    sendResponse({ ok: result.ok, id: result.id });
  })().catch((error2) => {
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  });
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "llm_set_default_provider") {
    return false;
  }
  const { id } = message;
  if (!id) {
    sendResponse({ ok: false, error: "Missing id" });
    return true;
  }
  (async () => {
    const result = await bridgeRequest("llm.set_default_provider", { id });
    sendResponse({ ok: result.ok, default_provider: result.default_provider });
  })().catch((error2) => {
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  });
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "llm_remove_provider") {
    return false;
  }
  const { id } = message;
  if (!id) {
    sendResponse({ ok: false, error: "Missing id" });
    return true;
  }
  (async () => {
    const result = await bridgeRequest("llm.remove_provider", { id });
    sendResponse({ ok: result.ok });
  })().catch((error2) => {
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  });
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "llm_check_provider") {
    return false;
  }
  const { provider } = message;
  if (!provider) {
    sendResponse({ ok: false, error: "Missing provider" });
    return true;
  }
  (async () => {
    const result = await bridgeRequest("llm.check_provider", { provider });
    sendResponse({ ok: true, status: result });
  })().catch((error2) => {
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  });
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "llm_list_models") {
    return false;
  }
  (async () => {
    const result = await bridgeRequest("llm.list_models");
    sendResponse({ ok: true, models: result.models });
  })().catch((error2) => {
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  });
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "llm_set_default_model") {
    return false;
  }
  const { model } = message;
  if (!model) {
    sendResponse({ ok: false, error: "Missing model" });
    return true;
  }
  (async () => {
    const result = await bridgeRequest("llm.set_default_model", { model });
    sendResponse({ ok: result.ok, default_model: result.default_model });
  })().catch((error2) => {
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  });
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "llm_list_configured_models") {
    return false;
  }
  (async () => {
    const result = await bridgeRequest("llm.list_configured_models");
    sendResponse({ ok: true, models: result.models });
  })().catch((error2) => {
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  });
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "llm_add_configured_model") {
    return false;
  }
  const { model_id, name } = message;
  if (!model_id) {
    sendResponse({ ok: false, error: "Missing model_id" });
    return true;
  }
  (async () => {
    const result = await bridgeRequest("llm.add_configured_model", { model_id, name });
    sendResponse({ ok: result.ok, name: result.name, model_id: result.model_id });
  })().catch((error2) => {
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  });
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "llm_remove_configured_model") {
    return false;
  }
  const { name } = message;
  if (!name) {
    sendResponse({ ok: false, error: "Missing name" });
    return true;
  }
  (async () => {
    const result = await bridgeRequest("llm.remove_configured_model", { name });
    sendResponse({ ok: result.ok });
  })().catch((error2) => {
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  });
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "llm_set_configured_model_default") {
    return false;
  }
  const { name } = message;
  if (!name) {
    sendResponse({ ok: false, error: "Missing name" });
    return true;
  }
  (async () => {
    const result = await bridgeRequest("llm.set_configured_model_default", { name });
    sendResponse({ ok: result.ok, default: result.default });
  })().catch((error2) => {
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  });
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "llm_test_model") {
    return false;
  }
  const { model } = message;
  if (!model) {
    sendResponse({ ok: false, error: "Missing model" });
    return true;
  }
  (async () => {
    console.log("[Harbor] Testing model:", model);
    const result = await bridgeRequest("llm.chat", {
      model,
      messages: [{ role: "user", content: 'Say "hello" in exactly one word.' }],
      max_tokens: 10
    });
    const response = result.message?.content || result.content || "";
    console.log("[Harbor] Test result:", response);
    sendResponse({ ok: true, response });
  })().catch((error2) => {
    console.error("[Harbor] Test failed:", error2);
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  });
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "bridge_rpc") {
    return false;
  }
  const { method, params } = message;
  if (!method) {
    sendResponse({ ok: false, error: "Missing method" });
    return true;
  }
  (async () => {
    console.log("[Harbor] bridge_rpc:", method);
    const result = await bridgeRequest(method, params);
    sendResponse({ ok: true, result });
  })().catch((error2) => {
    console.error("[Harbor] bridge_rpc error:", error2);
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  });
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "sidebar_call_tool") {
    return false;
  }
  const { serverId, toolName, args } = message;
  console.log("[Harbor] sidebar_call_tool:", serverId, toolName, args);
  if (!serverId || !toolName) {
    sendResponse({ ok: false, error: "Missing serverId or toolName" });
    return true;
  }
  (async () => {
    console.log("[Harbor] Calling tool...");
    const result = await callTool(serverId, toolName, args || {});
    console.log("[Harbor] Tool result:", result);
    sendResponse(result);
  })().catch((error2) => {
    console.error("[Harbor] Tool error:", error2);
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  });
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "mcp_call_method") {
    return false;
  }
  const { serverId, method, params } = message;
  console.log("[Harbor] mcp_call_method:", serverId, method, params);
  if (!serverId || !method) {
    sendResponse({ ok: false, error: "Missing serverId or method" });
    return true;
  }
  (async () => {
    const { callMcpMethod: callMcpMethod2 } = await Promise.resolve().then(() => (init_runtime(), runtime_exports));
    const result = await callMcpMethod2(serverId, method, params);
    console.log("[Harbor] MCP method result:", result);
    if (result.error) {
      sendResponse({ ok: false, error: result.error.message });
    } else {
      sendResponse({ ok: true, result: result.result });
    }
  })().catch((error2) => {
    console.error("[Harbor] MCP method error:", error2);
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  });
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "llm_chat") {
    return false;
  }
  const { messages, model } = message;
  if (!messages || messages.length === 0) {
    sendResponse({ ok: false, error: "Missing messages" });
    return true;
  }
  (async () => {
    const result = await bridgeRequest("llm.chat", { messages, model });
    sendResponse({ ok: true, response: result.response, model: result.model });
  })().catch((error2) => {
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  });
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "native_bridge_status") {
    return false;
  }
  const state = getConnectionState();
  sendResponse({ ok: true, ...state });
  return true;
});
var WEB_AGENTS_API_EXTENSION_ID = "web-agents-api@mozilla.org";
async function fetchWebAgentsPermissions() {
  try {
    const response = await browserAPI.runtime.sendMessage(WEB_AGENTS_API_EXTENSION_ID, {
      type: "web_agents_permissions.list_all"
    });
    if (!response?.ok || !response.permissions) {
      return [];
    }
    return response.permissions.map((entry) => ({
      ...entry,
      source: "web-agents-api"
    }));
  } catch {
    return [];
  }
}
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "list_all_permissions") {
    return false;
  }
  (async () => {
    const permissions = await listAllPermissions();
    const webAgentsPermissions = await fetchWebAgentsPermissions();
    const merged = [
      ...permissions.map((entry) => ({ ...entry, source: "harbor" })),
      ...webAgentsPermissions
    ];
    sendResponse({ type: "list_all_permissions_result", permissions: merged });
  })().catch((error2) => {
    sendResponse({
      type: "list_all_permissions_result",
      permissions: [],
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  });
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "revoke_origin_permissions") {
    return false;
  }
  const { origin, source } = message;
  if (!origin) {
    sendResponse({ ok: false, error: "Missing origin" });
    return true;
  }
  (async () => {
    if (source === "web-agents-api") {
      await browserAPI.runtime.sendMessage(WEB_AGENTS_API_EXTENSION_ID, {
        type: "web_agents_permissions.revoke_origin",
        origin
      });
    } else {
      await revokePermissions(origin);
    }
    browserAPI.runtime.sendMessage({ type: "permissions_changed" }).catch(() => {
    });
    sendResponse({ ok: true });
  })().catch((error2) => {
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  });
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "oauth_start_flow") {
    return false;
  }
  const { provider, server_id, scopes } = message;
  if (!provider || !server_id || !scopes?.length) {
    sendResponse({ ok: false, error: "Missing provider, server_id, or scopes" });
    return true;
  }
  (async () => {
    const result = await bridgeRequest("oauth.start_flow", {
      provider,
      server_id,
      scopes
    });
    browserAPI.tabs.create({ url: result.auth_url });
    sendResponse({ ok: true, state: result.state });
  })().catch((error2) => {
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  });
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "oauth_status") {
    return false;
  }
  const { server_id } = message;
  if (!server_id) {
    sendResponse({ ok: false, error: "Missing server_id" });
    return true;
  }
  (async () => {
    const result = await bridgeRequest("oauth.status", { server_id });
    sendResponse({ ok: true, ...result });
  })().catch((error2) => {
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  });
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "oauth_get_tokens") {
    return false;
  }
  const { server_id } = message;
  if (!server_id) {
    sendResponse({ ok: false, error: "Missing server_id" });
    return true;
  }
  (async () => {
    const result = await bridgeRequest("oauth.get_tokens", { server_id });
    sendResponse({ ok: true, ...result });
  })().catch((error2) => {
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  });
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "oauth_revoke") {
    return false;
  }
  const { server_id } = message;
  if (!server_id) {
    sendResponse({ ok: false, error: "Missing server_id" });
    return true;
  }
  (async () => {
    await bridgeRequest("oauth.revoke", { server_id });
    sendResponse({ ok: true });
  })().catch((error2) => {
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  });
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "oauth_list_providers") {
    return false;
  }
  (async () => {
    const result = await bridgeRequest("oauth.list_providers");
    sendResponse({ ok: true, providers: result.providers });
  })().catch((error2) => {
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  });
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "oauth_get_credentials_status") {
    return false;
  }
  (async () => {
    const result = await bridgeRequest("oauth.get_credentials_status");
    sendResponse({ ok: true, ...result });
  })().catch((error2) => {
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  });
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "oauth_set_credentials") {
    return false;
  }
  const { provider, client_id, client_secret } = message;
  if (!provider || !client_id || !client_secret) {
    sendResponse({ ok: false, error: "Missing required fields" });
    return true;
  }
  (async () => {
    const result = await bridgeRequest("oauth.set_credentials", { provider, client_id, client_secret });
    sendResponse({ ok: true, ...result });
  })().catch((error2) => {
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  });
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "oauth_remove_credentials") {
    return false;
  }
  const { provider } = message;
  if (!provider) {
    sendResponse({ ok: false, error: "Missing provider" });
    return true;
  }
  (async () => {
    const result = await bridgeRequest("oauth.remove_credentials", { provider });
    sendResponse({ ok: true, ...result });
  })().catch((error2) => {
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  });
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "session.list") {
    return false;
  }
  const { origin, status, type, activeOnly } = message;
  try {
    const sessions = SessionRegistry.listSessions({ origin, status, type, activeOnly });
    sendResponse({ ok: true, sessions });
  } catch (error2) {
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  }
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "session.terminate") {
    return false;
  }
  const { sessionId, origin } = message;
  if (!sessionId || !origin) {
    sendResponse({ ok: false, error: "Missing sessionId or origin" });
    return true;
  }
  try {
    const terminated = SessionRegistry.terminateSession(sessionId, origin);
    sendResponse({ ok: true, terminated });
  } catch (error2) {
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  }
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "session.get") {
    return false;
  }
  const { sessionId } = message;
  if (!sessionId) {
    sendResponse({ ok: false, error: "Missing sessionId" });
    return true;
  }
  try {
    const session = SessionRegistry.getSession(sessionId);
    if (!session) {
      sendResponse({ ok: false, error: "Session not found" });
    } else {
      sendResponse({ ok: true, session });
    }
  } catch (error2) {
    sendResponse({
      ok: false,
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  }
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "sidebar_test_remote_server") {
    return false;
  }
  const { url, transport, authHeader } = message;
  if (!url) {
    sendResponse({ ok: false, error: "Missing URL" });
    return true;
  }
  (async () => {
    const { createRemoteTransport: createRemoteTransport2 } = await Promise.resolve().then(() => (init_remote_transport(), remote_transport_exports));
    const remoteTransport = createRemoteTransport2({
      url,
      transport: transport || "sse",
      authHeader,
      timeout: 1e4,
      autoReconnect: false
    });
    try {
      await remoteTransport.connect();
      const requestId = crypto.randomUUID();
      const response = await remoteTransport.send({
        jsonrpc: "2.0",
        id: requestId,
        method: "tools/list"
      });
      remoteTransport.disconnect();
      if (response.error) {
        sendResponse({ ok: false, error: response.error.message });
        return;
      }
      const tools = response.result?.tools || [];
      sendResponse({
        ok: true,
        toolCount: tools.length,
        tools: tools.map((t) => t.name)
      });
    } catch (error2) {
      remoteTransport.disconnect();
      sendResponse({
        ok: false,
        error: error2 instanceof Error ? error2.message : String(error2)
      });
    }
  })();
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "sidebar_add_remote_server") {
    return false;
  }
  const { url, name, transport, authHeader } = message;
  if (!url || !name) {
    sendResponse({ ok: false, error: "Missing URL or name" });
    return true;
  }
  (async () => {
    try {
      const serverId = `remote-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const manifest = {
        id: serverId,
        name,
        version: "1.0.0",
        runtime: "remote",
        remoteUrl: url,
        remoteTransport: transport || "sse",
        remoteAuthHeader: authHeader,
        permissions: [],
        tools: []
      };
      await addServer(manifest);
      const result = await validateAndStartServer(serverId);
      if (!result.ok) {
        await removeServer(serverId);
        sendResponse({ ok: false, error: result.error || "Failed to connect to server" });
        return;
      }
      sendResponse({ ok: true, serverId });
    } catch (error2) {
      sendResponse({
        ok: false,
        error: error2 instanceof Error ? error2.message : String(error2)
      });
    }
  })();
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "page_chat_ping") {
    return false;
  }
  sendResponse({ ok: true });
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "page_chat_message") {
    return false;
  }
  const { chatId, message: userMessage, systemPrompt, tools, pageContext } = message;
  console.log("[Harbor] page_chat_message:", chatId, userMessage?.slice(0, 50));
  if (!userMessage) {
    sendResponse({ type: "error", error: { message: "Missing message" } });
    return true;
  }
  (async () => {
    try {
      const messages = [
        { role: "system", content: systemPrompt || "You are a helpful assistant." },
        { role: "user", content: userMessage }
      ];
      const toolsUsed = [];
      const result = await bridgeRequest("llm.chat", {
        messages,
        max_tokens: 2e3
      });
      let responseText = result.choices?.[0]?.message?.content || result.message?.content || result.content || "";
      console.log("[Harbor] page_chat_message response:", responseText.slice(0, 100));
      sendResponse({
        type: "page_chat_response",
        response: responseText,
        toolsUsed
      });
    } catch (err) {
      console.error("[Harbor] page_chat_message error:", err);
      sendResponse({
        type: "error",
        error: { message: err instanceof Error ? err.message : "Unknown error" }
      });
    }
  })();
  return true;
});
browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "open_page_chat") {
    return false;
  }
  const tabId = message.tabId;
  if (!tabId) {
    sendResponse({ ok: false, error: "Missing tabId" });
    return true;
  }
  (async () => {
    try {
      await browserAPI.scripting.executeScript({
        target: { tabId },
        files: ["dist/page-chat.js"]
      });
      console.log("[Harbor] Page chat injected into tab", tabId);
      sendResponse({ ok: true });
    } catch (err) {
      console.error("[Harbor] Failed to inject page chat:", err);
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : "Failed to open page chat"
      });
    }
  })();
  return true;
});
console.log("[Harbor] Extension initialized.");
/*! Bundled license information:

@wasmer/wasi/dist/Library.esm.min.js:
  (*!
   * @wasmer/wasi
   * Isomorphic Javascript library for interacting with WASI Modules in Node.js and the Browser.
   *
   * @version v1.2.2
   * @author Wasmer Engineering Team <engineering@wasmer.io>
   * @homepage https://github.com/wasmerio/wasmer-js
   * @repository https://github.com/wasmerio/wasmer-js
   * @license MIT
   *)

ieee754/index.js:
  (*! ieee754. BSD-3-Clause License. Feross Aboukhadijeh <https://feross.org/opensource> *)

buffer/index.js:
  (*!
   * The buffer module from node.js, for the browser.
   *
   * @author   Feross Aboukhadijeh <https://feross.org>
   * @license  MIT
   *)
*/
//# sourceMappingURL=background.js.map
