if (typeof chrome === 'undefined' && typeof browser !== 'undefined') { globalThis.chrome = browser; }
// src/types.ts
var ErrorCodes = {
  NOT_INSTALLED: "ERR_NOT_INSTALLED",
  PERMISSION_DENIED: "ERR_PERMISSION_DENIED",
  SCOPE_REQUIRED: "ERR_SCOPE_REQUIRED",
  TOOL_NOT_ALLOWED: "ERR_TOOL_NOT_ALLOWED",
  TOOL_FAILED: "ERR_TOOL_FAILED",
  MODEL_FAILED: "ERR_MODEL_FAILED",
  SESSION_NOT_FOUND: "ERR_SESSION_NOT_FOUND",
  HARBOR_NOT_FOUND: "ERR_HARBOR_NOT_FOUND",
  TIMEOUT: "ERR_TIMEOUT",
  INTERNAL: "ERR_INTERNAL",
  AGENT_NOT_FOUND: "ERR_AGENT_NOT_FOUND",
  AGENT_NOT_ACCEPTING: "ERR_AGENT_NOT_ACCEPTING"
};

// src/harbor-client.ts
var KNOWN_HARBOR_IDS = [
  "harbor@krikorian.co",
  // Firefox AMO signed ID (current)
  "harbor@mozilla.org",
  // Firefox production ID (future)
  "raffi.krikorian.harbor@gmail.com",
  // Firefox AMO signed ID (old)
  // Chrome stable dev ID (generated from key in manifest.chrome.json)
  // All developers loading from the repo will get this same ID
  "ljnciidcajlichemnbohopnlaonhkpgm",
  // Safari extension bundle identifier
  "org.harbor.Extension"
  // Add Chrome Web Store ID here when published (will be different)
];
var REQUEST_TIMEOUT = 3e4;
var SAFARI_HTTP_BASE = "http://127.0.0.1:8766";
var harborExtensionId = null;
var connectionState = "unknown";
async function discoverHarbor() {
  console.log("[Web Agents API] Starting Harbor discovery...");
  if (harborExtensionId && connectionState === "connected") {
    console.log("[Web Agents API] Using cached Harbor ID:", harborExtensionId);
    return harborExtensionId;
  }
  if (isSafari()) {
    console.log("[Web Agents API] Safari detected, trying HTTP connection to bridge...");
    try {
      const response = await fetch(`${SAFARI_HTTP_BASE}/health`, { method: "GET" });
      if (response.ok) {
        harborExtensionId = "safari-bridge";
        connectionState = "connected";
        console.log("[Web Agents API] Safari: Harbor bridge available via HTTP");
        return harborExtensionId;
      }
    } catch (e) {
      console.log("[Web Agents API] Safari HTTP connection failed:", e);
    }
    console.log("[Web Agents API] Safari: Harbor bridge not found");
    connectionState = "not-found";
    return null;
  }
  for (const id of KNOWN_HARBOR_IDS) {
    console.log("[Web Agents API] Trying known ID:", id);
    try {
      const response = await sendMessageToExtension(id, { type: "system.getVersion" });
      console.log("[Web Agents API] Response from", id, ":", response);
      if (response?.ok) {
        harborExtensionId = id;
        connectionState = "connected";
        console.log("[Web Agents API] Harbor discovered:", id);
        return id;
      }
    } catch (e) {
      console.log("[Web Agents API] Failed to contact", id, ":", e);
    }
  }
  try {
    const storageResult = await chrome.storage.local.get("harbor_extension_id");
    console.log("[Web Agents API] Stored Harbor ID:", storageResult.harbor_extension_id);
    if (storageResult.harbor_extension_id) {
      const id = storageResult.harbor_extension_id;
      try {
        const response = await sendMessageToExtension(id, { type: "system.getVersion" });
        console.log("[Web Agents API] Response from stored ID:", response);
        if (response?.ok) {
          harborExtensionId = id;
          connectionState = "connected";
          console.log("[Web Agents API] Harbor discovered via storage:", id);
          return id;
        }
      } catch (e) {
        console.log("[Web Agents API] Failed to contact stored ID:", e);
      }
    }
  } catch (e) {
    console.log("[Web Agents API] Storage access failed:", e);
  }
  console.log("[Web Agents API] Harbor not found");
  connectionState = "not-found";
  return null;
}
function getHarborState() {
  return {
    connected: connectionState === "connected",
    extensionId: harborExtensionId
  };
}
function setHarborExtensionId(id) {
  harborExtensionId = id;
  connectionState = "connected";
  chrome.storage.local.set({ harbor_extension_id: id }).catch(() => {
  });
}
function isSafari() {
  return typeof browser !== "undefined" && navigator.userAgent.includes("Safari") && !navigator.userAgent.includes("Chrome");
}
async function sendMessageToExtension(extensionId, message) {
  console.log("[Web Agents API] sendMessageToExtension:", extensionId, message.type, "safari:", isSafari());
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Request timed out after ${REQUEST_TIMEOUT}ms`));
    }, REQUEST_TIMEOUT);
  });
  const messagePromise = new Promise((resolve, reject) => {
    try {
      if (isSafari() && typeof browser !== "undefined" && browser.runtime?.sendMessage) {
        console.log("[Web Agents API] Using Safari/browser API for cross-extension message");
        browser.runtime.sendMessage(extensionId, message).then((response) => {
          console.log("[Web Agents API] Safari sendMessage response:", response);
          resolve(response);
        }).catch((e) => {
          console.log("[Web Agents API] Safari sendMessage error:", e);
          reject(e);
        });
        return;
      }
      const result = chrome.runtime.sendMessage(extensionId, message, (response) => {
        if (chrome.runtime.lastError) {
          console.log("[Web Agents API] sendMessage error:", chrome.runtime.lastError.message);
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        console.log("[Web Agents API] sendMessage response (callback):", response);
        resolve(response);
      });
      if (result && typeof result.then === "function") {
        result.then((response) => {
          console.log("[Web Agents API] sendMessage response (promise):", response);
          resolve(response);
        }).catch((e) => {
          console.log("[Web Agents API] sendMessage promise error:", e);
          reject(e);
        });
      }
    } catch (e) {
      console.log("[Web Agents API] sendMessage exception:", e);
      reject(e);
    }
  });
  return Promise.race([messagePromise, timeoutPromise]);
}
async function safariHttpRequest(method, params = {}) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  console.log("[Web Agents API:Safari] HTTP RPC:", method);
  const response = await fetch(`${SAFARI_HTTP_BASE}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, method, params })
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  const data = await response.json();
  if (data?.error) {
    throw new Error(data.error.message || JSON.stringify(data.error));
  }
  return data?.result ?? null;
}
async function harborRequest(type, payload) {
  if (!harborExtensionId || connectionState !== "connected") {
    const id = await discoverHarbor();
    if (!id) {
      throw createError(ErrorCodes.HARBOR_NOT_FOUND, "Harbor extension not found. Please install Harbor.");
    }
  }
  if (isSafari()) {
    const methodMap = {
      "system.health": "system.health",
      "system.getVersion": "system.health",
      // No version on bridge, use health
      "system.getCapabilities": "system.health",
      // Simplified
      "llm.listProviders": "llm.list_providers",
      "llm.chat": "llm.chat",
      "mcp.listServers": "js.list_servers",
      "mcp.listTools": "mcp.list_tools",
      // Tools synced from Harbor
      "mcp.callTool": "mcp.call_tool"
      // Tool execution via bridge
    };
    const bridgeMethod = methodMap[type];
    if (bridgeMethod) {
      const result = await safariHttpRequest(bridgeMethod, payload);
      return result;
    }
    console.log("[Web Agents API:Safari] Method not supported via bridge:", type);
    return { supported: false };
  }
  const response = await sendMessageToExtension(harborExtensionId, { type, payload });
  if (!response.ok) {
    throw createError(ErrorCodes.INTERNAL, response.error || "Unknown error from Harbor");
  }
  return response.result;
}
function harborStreamRequest(type, payload) {
  if (!harborExtensionId || connectionState !== "connected") {
    throw createError(ErrorCodes.HARBOR_NOT_FOUND, "Harbor extension not found");
  }
  const requestId = `stream-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const eventQueue = [];
  let resolveWaiting = null;
  let done = false;
  let error = null;
  let port = null;
  try {
    port = chrome.runtime.connect(harborExtensionId, { name: "stream" });
  } catch (e) {
    throw createError(ErrorCodes.HARBOR_NOT_FOUND, "Failed to connect to Harbor");
  }
  port.onMessage.addListener((message) => {
    if (message.requestId !== requestId) return;
    if (message.type === "stream" && message.event) {
      const event = message.event;
      if (resolveWaiting) {
        resolveWaiting(event);
        resolveWaiting = null;
      } else {
        eventQueue.push(event);
      }
      if (event.type === "done" || event.type === "error") {
        done = true;
        if (event.type === "error" && event.error) {
          error = new Error(event.error.message);
        }
      }
    }
  });
  port.onDisconnect.addListener(() => {
    done = true;
    if (resolveWaiting) {
      resolveWaiting(null);
      resolveWaiting = null;
    }
  });
  port.postMessage({ type, payload, requestId });
  const stream = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (eventQueue.length > 0) {
            const event2 = eventQueue.shift();
            if (event2.type === "done" || event2.type === "error") {
              return { done: true, value: event2 };
            }
            return { done: false, value: event2 };
          }
          if (done) {
            if (error) {
              throw error;
            }
            return { done: true, value: void 0 };
          }
          const event = await new Promise((resolve) => {
            resolveWaiting = resolve;
          });
          if (event === null) {
            if (error) {
              throw error;
            }
            return { done: true, value: void 0 };
          }
          if (event.type === "done" || event.type === "error") {
            return { done: true, value: event };
          }
          return { done: false, value: event };
        }
      };
    }
  };
  const cancel = () => {
    done = true;
    if (port) {
      port.disconnect();
      port = null;
    }
  };
  return { stream, cancel };
}
function createError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// src/policy/feature-flags.ts
var STORAGE_KEY = "web-agents-api-flags";
var DEFAULT_FLAGS = {
  textGeneration: true,
  toolCalling: false,
  toolAccess: true,
  browserInteraction: false,
  browserControl: false,
  multiAgent: false
};
var cachedFlags = null;
async function getFeatureFlags() {
  if (cachedFlags) {
    return cachedFlags;
  }
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    cachedFlags = { ...DEFAULT_FLAGS, ...result[STORAGE_KEY] };
    return cachedFlags;
  } catch {
    return DEFAULT_FLAGS;
  }
}
if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes[STORAGE_KEY]) {
      cachedFlags = null;
    }
  });
}

// src/background.ts
console.log("[Web Agents API] Extension starting...");
var browserAPI = typeof browser !== "undefined" ? browser : chrome;
async function executeScriptInTab(tabId, func, args = []) {
  if (chrome?.scripting?.executeScript) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func,
      args
    });
    return results?.[0]?.result;
  }
  if (typeof browser !== "undefined" && browser?.scripting?.executeScript) {
    const results = await browser.scripting.executeScript({
      target: { tabId },
      func,
      args
    });
    return results?.[0]?.result;
  }
  if (typeof browser !== "undefined" && browser?.tabs?.executeScript) {
    const code = `(${func.toString()}).apply(null, ${JSON.stringify(args)})`;
    const results = await browser.tabs.executeScript(tabId, { code });
    return results?.[0];
  }
  throw new Error("No script execution API available");
}
var PERMISSION_KEY_PREFIX = "permissions:";
var textSessions = /* @__PURE__ */ new Map();
var sessionIdCounter = 0;
function generateSessionId() {
  return `session-${Date.now()}-${++sessionIdCounter}`;
}
var spawnedTabs = /* @__PURE__ */ new Map();
function trackSpawnedTab(origin, tabId) {
  if (!spawnedTabs.has(origin)) {
    spawnedTabs.set(origin, /* @__PURE__ */ new Set());
  }
  spawnedTabs.get(origin).add(tabId);
}
function untrackSpawnedTab(origin, tabId) {
  const tabs = spawnedTabs.get(origin);
  if (tabs) {
    return tabs.delete(tabId);
  }
  return false;
}
function isSpawnedTab(origin, tabId) {
  return spawnedTabs.get(origin)?.has(tabId) ?? false;
}
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const tabs of spawnedTabs.values()) {
    tabs.delete(tabId);
  }
});
async function getPermissions(origin) {
  const key = PERMISSION_KEY_PREFIX + origin;
  const result = await chrome.storage.local.get(key);
  return result[key] || { scopes: {} };
}
async function savePermissions(origin, permissions) {
  const key = PERMISSION_KEY_PREFIX + origin;
  await chrome.storage.local.set({ [key]: permissions });
}
async function listAllPermissions() {
  const result = await chrome.storage.local.get(null);
  const entries = [];
  for (const [key, value] of Object.entries(result)) {
    if (!key.startsWith(PERMISSION_KEY_PREFIX)) continue;
    const origin = key.slice(PERMISSION_KEY_PREFIX.length);
    const permissions = value || { scopes: {} };
    const scopes = {};
    for (const [scope, grant] of Object.entries(permissions.scopes || {})) {
      if (grant.type === "granted-once" && grant.expiresAt && Date.now() > grant.expiresAt) {
        scopes[scope] = "not-granted";
      } else {
        scopes[scope] = grant.type;
      }
    }
    entries.push({
      origin,
      scopes,
      allowedTools: permissions.allowedTools
    });
  }
  return entries;
}
async function revokeOriginPermissions(origin) {
  const key = PERMISSION_KEY_PREFIX + origin;
  await chrome.storage.local.remove(key);
}
async function checkPermission(origin, scope) {
  const permissions = await getPermissions(origin);
  const grant = permissions.scopes[scope];
  if (!grant) {
    return "not-granted";
  }
  if (grant.type === "granted-once" && grant.expiresAt) {
    if (Date.now() > grant.expiresAt) {
      return "not-granted";
    }
  }
  return grant.type;
}
async function hasPermission(origin, scope) {
  const status = await checkPermission(origin, scope);
  return status === "granted-once" || status === "granted-always";
}
var pendingPermissionPrompts = /* @__PURE__ */ new Map();
var promptIdCounter = 0;
function generatePromptId() {
  return `prompt-${Date.now()}-${++promptIdCounter}`;
}
function resolvePromptClosed(windowId) {
  for (const [promptId, pending] of pendingPermissionPrompts.entries()) {
    if (pending.windowId === windowId) {
      pendingPermissionPrompts.delete(promptId);
      pending.resolve({ promptId, granted: false });
      return;
    }
  }
}
async function openPermissionPrompt(options) {
  const promptId = generatePromptId();
  const url = new URL(chrome.runtime.getURL("permission-prompt.html"));
  url.searchParams.set("promptId", promptId);
  url.searchParams.set("origin", options.origin);
  if (options.scopes.length > 0) {
    url.searchParams.set("scopes", options.scopes.join(","));
  }
  if (options.reason) {
    url.searchParams.set("reason", options.reason);
  }
  if (options.tools && options.tools.length > 0) {
    url.searchParams.set("tools", options.tools.join(","));
  }
  return new Promise((resolve) => {
    pendingPermissionPrompts.set(promptId, { resolve });
    chrome.windows.create(
      {
        url: url.toString(),
        type: "popup",
        width: 480,
        height: 640
      },
      (createdWindow) => {
        if (chrome.runtime.lastError || !createdWindow?.id) {
          pendingPermissionPrompts.delete(promptId);
          resolve({ promptId, granted: false });
          return;
        }
        const pending = pendingPermissionPrompts.get(promptId);
        if (pending) {
          pending.windowId = createdWindow.id;
        }
      }
    );
  });
}
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "permission_prompt_response") {
    return false;
  }
  const response = message.response;
  if (!response) {
    sendResponse({ ok: false });
    return true;
  }
  let promptId = response.promptId;
  if (!promptId && pendingPermissionPrompts.size === 1) {
    promptId = Array.from(pendingPermissionPrompts.keys())[0];
  }
  const pending = promptId ? pendingPermissionPrompts.get(promptId) : void 0;
  if (!pending) {
    sendResponse({ ok: false });
    return true;
  }
  pendingPermissionPrompts.delete(promptId);
  if (pending.windowId) {
    chrome.windows.remove(pending.windowId);
  }
  pending.resolve({ ...response, promptId });
  sendResponse({ ok: true });
  return true;
});
chrome.windows.onRemoved.addListener((windowId) => {
  resolvePromptClosed(windowId);
});
function handleWebAgentsPermissionsMessage(message, sendResponse) {
  if (message?.type === "web_agents_permissions.list_all") {
    (async () => {
      const permissions = await listAllPermissions();
      sendResponse({ ok: true, permissions });
    })().catch((error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }
  if (message?.type === "web_agents_permissions.revoke_origin") {
    const { origin } = message;
    if (!origin) {
      sendResponse({ ok: false, error: "Missing origin" });
      return true;
    }
    (async () => {
      await revokeOriginPermissions(origin);
      sendResponse({ ok: true });
    })().catch((error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }
  return false;
}
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  return handleWebAgentsPermissionsMessage(message, sendResponse);
});
chrome.runtime.onMessageExternal?.addListener((message, _sender, sendResponse) => {
  return handleWebAgentsPermissionsMessage(message, sendResponse);
});
async function showPermissionPrompt(origin, scopes, reason, tools) {
  const permissions = await getPermissions(origin);
  const result = {};
  const scopesToRequest = [];
  const requestedTools = tools && tools.length > 0 ? tools : [];
  const existingAllowedTools = permissions.allowedTools || [];
  const missingTools = requestedTools.filter((tool) => !existingAllowedTools.includes(tool));
  for (const scope of scopes) {
    const existing = await checkPermission(origin, scope);
    if (existing === "granted-once" || existing === "granted-always") {
      result[scope] = existing;
      continue;
    }
    if (existing === "denied") {
      result[scope] = "denied";
      continue;
    }
    scopesToRequest.push(scope);
  }
  let didUpdatePermissions = false;
  if (scopesToRequest.length > 0) {
    const promptResponse = await openPermissionPrompt({ origin, scopes: scopesToRequest, reason, tools });
    if (promptResponse.granted) {
      const grantType = promptResponse.grantType || "granted-once";
      for (const scope of scopesToRequest) {
        const grant = {
          type: grantType,
          grantedAt: Date.now(),
          expiresAt: grantType === "granted-once" ? Date.now() + 10 * 60 * 1e3 : void 0
        };
        permissions.scopes[scope] = grant;
        result[scope] = grant.type;
      }
      if (promptResponse.allowedTools && promptResponse.allowedTools.length > 0) {
        permissions.allowedTools = [
          .../* @__PURE__ */ new Set([...permissions.allowedTools || [], ...promptResponse.allowedTools])
        ];
      }
      didUpdatePermissions = true;
    } else {
      for (const scope of scopesToRequest) {
        if (promptResponse.explicitDeny) {
          permissions.scopes[scope] = { type: "denied", grantedAt: Date.now() };
          result[scope] = "denied";
          didUpdatePermissions = true;
        } else {
          result[scope] = "not-granted";
        }
      }
    }
  }
  if (scopesToRequest.length === 0 && missingTools.length > 0) {
    const promptResponse = await openPermissionPrompt({
      origin,
      scopes: ["mcp:tools.call"],
      reason,
      tools: missingTools
    });
    if (promptResponse.granted && promptResponse.allowedTools && promptResponse.allowedTools.length > 0) {
      permissions.allowedTools = [
        .../* @__PURE__ */ new Set([...permissions.allowedTools || [], ...promptResponse.allowedTools])
      ];
      didUpdatePermissions = true;
    }
  }
  if (didUpdatePermissions) {
    await savePermissions(origin, permissions);
    const grantedScopes = Object.entries(result).filter(([, grant]) => grant === "granted-once" || grant === "granted-always").map(([scope]) => scope);
    if (grantedScopes.length > 0) {
      const grantType = result[grantedScopes[0]];
      try {
        await harborRequest("system.syncPermissions", {
          origin,
          scopes: grantedScopes,
          grantType,
          allowedTools: permissions.allowedTools
        });
        console.log("[Web Agents API] Synced permissions to Harbor:", grantedScopes);
      } catch (e) {
        console.warn("[Web Agents API] Failed to sync permissions to Harbor:", e);
      }
    }
  }
  const allGranted = scopes.every((s) => result[s] === "granted-once" || result[s] === "granted-always");
  return {
    granted: allGranted,
    scopes: result,
    allowedTools: permissions.allowedTools
  };
}
async function handleAiCanCreateTextSession(ctx) {
  try {
    const harborState = getHarborState();
    if (!harborState.connected) {
      await discoverHarbor();
    }
    const capabilities = await harborRequest("system.getCapabilities");
    return { id: ctx.id, ok: true, result: capabilities.bridgeReady ? "readily" : "no" };
  } catch {
    return { id: ctx.id, ok: true, result: "no" };
  }
}
async function handleAiCreateTextSession(ctx) {
  if (!await hasPermission(ctx.origin, "model:prompt")) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_PERMISSION_DENIED", message: "Permission model:prompt required" }
    };
  }
  const options = ctx.payload || {};
  const sessionId = generateSessionId();
  textSessions.set(sessionId, {
    sessionId,
    origin: ctx.origin,
    options,
    history: [],
    createdAt: Date.now()
  });
  return { id: ctx.id, ok: true, result: sessionId };
}
async function handleSessionPrompt(ctx) {
  const { sessionId, input } = ctx.payload;
  const session = textSessions.get(sessionId);
  if (!session) {
    return { id: ctx.id, ok: false, error: { code: "ERR_SESSION_NOT_FOUND", message: "Session not found" } };
  }
  if (session.origin !== ctx.origin) {
    return { id: ctx.id, ok: false, error: { code: "ERR_PERMISSION_DENIED", message: "Session belongs to different origin" } };
  }
  try {
    session.history.push({ role: "user", content: input });
    const messages = [];
    if (session.options.systemPrompt) {
      messages.push({ role: "system", content: session.options.systemPrompt });
    }
    messages.push(...session.history);
    const result = await harborRequest("llm.chat", {
      messages,
      model: session.options.model,
      temperature: session.options.temperature
    });
    session.history.push({ role: "assistant", content: result.content });
    return { id: ctx.id, ok: true, result: result.content };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_MODEL_FAILED", message: e instanceof Error ? e.message : "LLM request failed" }
    };
  }
}
async function handleSessionDestroy(ctx) {
  const { sessionId } = ctx.payload;
  textSessions.delete(sessionId);
  return { id: ctx.id, ok: true, result: null };
}
async function handleLanguageModelCapabilities(ctx) {
  try {
    const harborState = getHarborState();
    if (!harborState.connected) {
      await discoverHarbor();
    }
    const capabilities = await harborRequest("system.getCapabilities");
    return {
      id: ctx.id,
      ok: true,
      result: {
        available: capabilities.bridgeReady ? "readily" : "no",
        defaultTemperature: 0.7,
        defaultTopK: 40,
        maxTopK: 100
      }
    };
  } catch {
    return { id: ctx.id, ok: true, result: { available: "no" } };
  }
}
async function handleProviderslist(ctx) {
  if (!await hasPermission(ctx.origin, "model:list")) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_PERMISSION_DENIED", message: "Permission model:list required" }
    };
  }
  try {
    const result = await harborRequest("llm.listProviders");
    return { id: ctx.id, ok: true, result: result.providers };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: e instanceof Error ? e.message : "Failed to list providers" }
    };
  }
}
async function handleProvidersGetActive(ctx) {
  try {
    const result = await harborRequest("llm.getActiveProvider");
    return { id: ctx.id, ok: true, result: { provider: null, model: result.default_model || null } };
  } catch {
    return { id: ctx.id, ok: true, result: { provider: null, model: null } };
  }
}
async function handleRequestPermissions(ctx) {
  const { scopes, reason, tools } = ctx.payload;
  const result = await showPermissionPrompt(ctx.origin, scopes, reason, tools);
  return { id: ctx.id, ok: true, result };
}
async function handlePermissionsList(ctx) {
  const permissions = await getPermissions(ctx.origin);
  const scopes = {};
  for (const [scope, grant] of Object.entries(permissions.scopes)) {
    if (grant.type === "granted-once" && grant.expiresAt && Date.now() > grant.expiresAt) {
      scopes[scope] = "not-granted";
    } else {
      scopes[scope] = grant.type;
    }
  }
  return {
    id: ctx.id,
    ok: true,
    result: {
      origin: ctx.origin,
      scopes,
      allowedTools: permissions.allowedTools
    }
  };
}
async function handleToolsList(ctx) {
  if (!await hasPermission(ctx.origin, "mcp:tools.list")) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_PERMISSION_DENIED", message: "Permission mcp:tools.list required" }
    };
  }
  try {
    const result = await harborRequest("mcp.listTools", {});
    return { id: ctx.id, ok: true, result: result.tools };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: e instanceof Error ? e.message : "Failed to list tools" }
    };
  }
}
async function handleToolsCall(ctx) {
  if (!await hasPermission(ctx.origin, "mcp:tools.call")) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_PERMISSION_DENIED", message: "Permission mcp:tools.call required" }
    };
  }
  const { tool, args } = ctx.payload;
  const permissions = await getPermissions(ctx.origin);
  if (permissions.allowedTools && !permissions.allowedTools.includes(tool)) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_TOOL_NOT_ALLOWED", message: `Tool ${tool} not in allowlist` }
    };
  }
  let serverId;
  let toolName;
  if (tool.includes("/")) {
    [serverId, toolName] = tool.split("/", 2);
  } else {
    const toolsResult = await harborRequest("mcp.listTools", {});
    const found = toolsResult.tools.find((t) => t.name === tool);
    if (!found) {
      return {
        id: ctx.id,
        ok: false,
        error: { code: "ERR_TOOL_NOT_FOUND", message: `Tool ${tool} not found` }
      };
    }
    serverId = found.serverId;
    toolName = tool;
  }
  try {
    const result = await harborRequest("mcp.callTool", {
      serverId,
      toolName,
      args: args || {}
    });
    return { id: ctx.id, ok: true, result: result.result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_TOOL_FAILED", message: e instanceof Error ? e.message : "Tool call failed" }
    };
  }
}
async function handleSessionsCreate(ctx) {
  const options = ctx.payload;
  if (!options || !options.capabilities) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INVALID_REQUEST", message: "Missing capabilities in session options" }
    };
  }
  const requiredScopes = [];
  if (options.capabilities.llm) {
    requiredScopes.push("model:prompt");
  }
  if (options.capabilities.tools && options.capabilities.tools.length > 0) {
    requiredScopes.push("mcp:tools.call");
  }
  for (const scope of requiredScopes) {
    if (!await hasPermission(ctx.origin, scope)) {
      return {
        id: ctx.id,
        ok: false,
        error: { code: "ERR_PERMISSION_DENIED", message: `Permission ${scope} required` }
      };
    }
  }
  const permissions = await getPermissions(ctx.origin);
  const allowedTools = permissions.allowedTools || [];
  try {
    const result = await harborRequest("session.create", {
      origin: ctx.origin,
      tabId: ctx.tabId,
      options
    });
    return {
      id: ctx.id,
      ok: true,
      result: {
        success: true,
        sessionId: result.sessionId,
        capabilities: result.capabilities
      }
    };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: e instanceof Error ? e.message : "Session creation failed" }
    };
  }
}
async function handleSessionsGet(ctx) {
  const { sessionId } = ctx.payload;
  if (!sessionId) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INVALID_REQUEST", message: "Missing sessionId" }
    };
  }
  try {
    const result = await harborRequest("session.get", {
      sessionId,
      origin: ctx.origin
    });
    return { id: ctx.id, ok: true, result: result.session };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_SESSION_NOT_FOUND", message: e instanceof Error ? e.message : "Session not found" }
    };
  }
}
async function handleSessionsList(ctx) {
  try {
    const result = await harborRequest("session.list", {
      origin: ctx.origin,
      activeOnly: true
    });
    return { id: ctx.id, ok: true, result: result.sessions };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: e instanceof Error ? e.message : "Failed to list sessions" }
    };
  }
}
async function handleSessionsTerminate(ctx) {
  const { sessionId } = ctx.payload;
  if (!sessionId) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INVALID_REQUEST", message: "Missing sessionId" }
    };
  }
  try {
    const result = await harborRequest("session.terminate", {
      sessionId,
      origin: ctx.origin
    });
    return { id: ctx.id, ok: true, result: { terminated: result.terminated } };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_SESSION_NOT_FOUND", message: e instanceof Error ? e.message : "Session not found" }
    };
  }
}
async function handleMcpDiscover(ctx) {
  try {
    const result = await harborRequest("agent.mcp.discover", { origin: ctx.origin });
    return { id: ctx.id, ok: true, result: result.servers || [] };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_MCP_DISCOVER", message: e instanceof Error ? e.message : "Failed to discover MCP servers" }
    };
  }
}
async function handleMcpRegister(ctx) {
  const { url, name, description, tools, transport } = ctx.payload;
  if (!url || !name) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INVALID_REQUEST", message: "Missing url or name" }
    };
  }
  try {
    const result = await harborRequest("agent.mcp.register", {
      origin: ctx.origin,
      url,
      name,
      description,
      tools,
      transport
    });
    return { id: ctx.id, ok: true, result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_MCP_REGISTER", message: e instanceof Error ? e.message : "Failed to register MCP server" }
    };
  }
}
async function handleMcpUnregister(ctx) {
  const { serverId } = ctx.payload;
  if (!serverId) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INVALID_REQUEST", message: "Missing serverId" }
    };
  }
  try {
    const result = await harborRequest("agent.mcp.unregister", {
      origin: ctx.origin,
      serverId
    });
    return { id: ctx.id, ok: true, result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_MCP_UNREGISTER", message: e instanceof Error ? e.message : "Failed to unregister MCP server" }
    };
  }
}
async function handleChatCanOpen(ctx) {
  try {
    const result = await harborRequest("agent.chat.canOpen", {
      origin: ctx.origin
    });
    return { id: ctx.id, ok: true, result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_CHAT", message: e instanceof Error ? e.message : "Failed to check chat availability" }
    };
  }
}
async function handleChatOpen(ctx) {
  const { systemPrompt, initialMessage, tools, style } = ctx.payload || {};
  try {
    const result = await harborRequest("agent.chat.open", {
      origin: ctx.origin,
      tabId: ctx.tabId,
      systemPrompt,
      initialMessage,
      tools,
      style
    });
    return { id: ctx.id, ok: true, result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_CHAT_OPEN", message: e instanceof Error ? e.message : "Failed to open chat" }
    };
  }
}
async function handleChatClose(ctx) {
  const { chatId } = ctx.payload;
  if (!chatId) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INVALID_REQUEST", message: "Missing chatId" }
    };
  }
  try {
    const result = await harborRequest("agent.chat.close", {
      origin: ctx.origin,
      chatId
    });
    return { id: ctx.id, ok: true, result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_CHAT_CLOSE", message: e instanceof Error ? e.message : "Failed to close chat" }
    };
  }
}
var registeredAgents = /* @__PURE__ */ new Map();
var pendingInvocations = /* @__PURE__ */ new Map();
var agentInvocationTabs = /* @__PURE__ */ new Map();
async function registerProxyInvocationHandler(agentId, origin, tabId) {
  console.log("[Web Agents API] registerProxyInvocationHandler called:", { agentId, origin, tabId });
  if (tabId > 0) {
    agentInvocationTabs.set(agentId, tabId);
    console.log("[Web Agents API] Stored tab mapping:", agentId, "->", tabId);
  }
  const harborState = getHarborState();
  console.log("[Web Agents API] Harbor state:", harborState);
  if (!harborState.connected) {
    console.warn("[Web Agents API] Harbor not connected, trying to discover...");
    const id = await discoverHarbor();
    if (!id) {
      console.error("[Web Agents API] Cannot register invocation handler - Harbor not found");
      return;
    }
  }
  try {
    console.log("[Web Agents API] Sending agents.registerInvocationHandler to Harbor...");
    const result = await harborRequest("agents.registerInvocationHandler", {
      agentId,
      origin,
      tabId
    });
    console.log("[Web Agents API] Harbor response for registerInvocationHandler:", result);
  } catch (e) {
    console.error("[Web Agents API] Failed to register proxy handler with Harbor:", e);
  }
}
async function handleIncomingInvocation(agentId, request, traceId) {
  const trace = traceId || "no-trace";
  let tabId = agentInvocationTabs.get(agentId);
  if (!tabId) {
    const agent = registeredAgents.get(agentId);
    if (agent?.tabId) {
      tabId = agent.tabId;
    }
  }
  console.log(`[TRACE ${trace}] handleIncomingInvocation - agentId: ${agentId}, tabId: ${tabId}, task: ${request.task}`);
  if (!tabId) {
    console.log(`[TRACE ${trace}] handleIncomingInvocation ERROR - no tab`);
    return { success: false, error: { code: "ERR_NO_TAB", message: "Agent tab not found" } };
  }
  const invocationId = `inv-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const timeout = request.timeout || 3e4;
  console.log(`[TRACE ${trace}] Sending to tab ${tabId} with invocationId: ${invocationId}`);
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      pendingInvocations.delete(invocationId);
      resolve({ success: false, error: { code: "ERR_TIMEOUT", message: "Invocation timed out" } });
    }, timeout);
    pendingInvocations.set(invocationId, {
      resolve: (response) => {
        clearTimeout(timeoutId);
        pendingInvocations.delete(invocationId);
        resolve(response);
      },
      reject: (error) => {
        clearTimeout(timeoutId);
        pendingInvocations.delete(invocationId);
        resolve({ success: false, error: { code: "ERR_FAILED", message: error.message } });
      },
      timeout: timeoutId
    });
    chrome.tabs.sendMessage(tabId, {
      type: "agentInvocation",
      invocationId,
      agentId,
      from: request.from,
      task: request.task,
      input: request.input,
      traceId: trace
    }).catch((error) => {
      console.log(`[TRACE ${trace}] tabs.sendMessage ERROR: ${error.message}`);
      clearTimeout(timeoutId);
      pendingInvocations.delete(invocationId);
      resolve({ success: false, error: { code: "ERR_SEND_FAILED", message: error.message } });
    });
  });
}
async function handleAgentsRegister(ctx) {
  const options = ctx.payload;
  if (!options.name) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INVALID_REQUEST", message: "Missing name" }
    };
  }
  try {
    const result = await harborRequest("agents.register", {
      ...options,
      origin: ctx.origin,
      tabId: ctx.tabId
    });
    const tabId = ctx.tabId;
    console.log("[Web Agents API] Agent registered:", result.id, "tabId:", tabId, "acceptsInvocations:", result.acceptsInvocations);
    registeredAgents.set(result.id, {
      agentId: result.id,
      origin: ctx.origin,
      tabId: tabId || 0,
      // Will be updated if we get tabId later
      name: result.name,
      capabilities: result.capabilities
    });
    if (result.acceptsInvocations) {
      await registerProxyInvocationHandler(result.id, ctx.origin, tabId || 0);
    }
    return { id: ctx.id, ok: true, result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: e instanceof Error ? e.message : "Registration failed" }
    };
  }
}
async function handleAgentsUnregister(ctx) {
  const { agentId } = ctx.payload;
  if (!agentId) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INVALID_REQUEST", message: "Missing agentId" }
    };
  }
  try {
    await harborRequest("agents.unregister", { agentId, origin: ctx.origin });
    registeredAgents.delete(agentId);
    return { id: ctx.id, ok: true, result: null };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: e instanceof Error ? e.message : "Unregistration failed" }
    };
  }
}
async function handleAgentsGetInfo(ctx) {
  const { agentId } = ctx.payload;
  if (!agentId) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INVALID_REQUEST", message: "Missing agentId" }
    };
  }
  try {
    const result = await harborRequest("agents.getInfo", { agentId, origin: ctx.origin });
    return { id: ctx.id, ok: true, result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_AGENT_NOT_FOUND", message: e instanceof Error ? e.message : "Agent not found" }
    };
  }
}
async function handleAgentsDiscover(ctx) {
  const query = ctx.payload;
  try {
    const result = await harborRequest("agents.discover", {
      ...query,
      origin: ctx.origin
    });
    return { id: ctx.id, ok: true, result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: e instanceof Error ? e.message : "Discovery failed" }
    };
  }
}
async function handleAgentsList(ctx) {
  try {
    const result = await harborRequest("agents.list", { origin: ctx.origin });
    return { id: ctx.id, ok: true, result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: e instanceof Error ? e.message : "List failed" }
    };
  }
}
async function handleAgentsInvoke(ctx) {
  const { agentId, request } = ctx.payload;
  const traceId = `trace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  console.log(`[TRACE ${traceId}] handleAgentsInvoke START - agentId: ${agentId}, task: ${request?.task}`);
  if (!agentId || !request) {
    console.log(`[TRACE ${traceId}] handleAgentsInvoke ERROR - missing params`);
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INVALID_REQUEST", message: "Missing agentId or request" }
    };
  }
  try {
    console.log(`[TRACE ${traceId}] Sending to Harbor...`);
    const result = await harborRequest("agents.invoke", {
      agentId,
      task: request.task,
      input: request.input,
      timeout: request.timeout,
      origin: ctx.origin,
      tabId: ctx.tabId,
      traceId
      // Pass trace ID to Harbor
    });
    console.log(`[TRACE ${traceId}] Harbor response received, success: ${result?.success}`);
    return { id: ctx.id, ok: true, result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: e instanceof Error ? e.message : "Invocation failed" }
    };
  }
}
async function handleAgentsSend(ctx) {
  const { agentId, payload } = ctx.payload;
  if (!agentId) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INVALID_REQUEST", message: "Missing agentId" }
    };
  }
  try {
    const result = await harborRequest("agents.send", {
      agentId,
      payload,
      origin: ctx.origin,
      tabId: ctx.tabId
    });
    return { id: ctx.id, ok: true, result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: e instanceof Error ? e.message : "Send failed" }
    };
  }
}
async function handleAgentsSubscribe(ctx) {
  const { eventType } = ctx.payload;
  if (!eventType) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INVALID_REQUEST", message: "Missing eventType" }
    };
  }
  try {
    await harborRequest("agents.subscribe", {
      eventType,
      origin: ctx.origin,
      tabId: ctx.tabId
    });
    return { id: ctx.id, ok: true, result: null };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: e instanceof Error ? e.message : "Subscribe failed" }
    };
  }
}
async function handleAgentsUnsubscribe(ctx) {
  const { eventType } = ctx.payload;
  if (!eventType) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INVALID_REQUEST", message: "Missing eventType" }
    };
  }
  try {
    await harborRequest("agents.unsubscribe", {
      eventType,
      origin: ctx.origin,
      tabId: ctx.tabId
    });
    return { id: ctx.id, ok: true, result: null };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: e instanceof Error ? e.message : "Unsubscribe failed" }
    };
  }
}
async function handleAgentsBroadcast(ctx) {
  const { eventType, data } = ctx.payload;
  if (!eventType) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INVALID_REQUEST", message: "Missing eventType" }
    };
  }
  try {
    const result = await harborRequest("agents.broadcast", {
      eventType,
      data,
      origin: ctx.origin,
      tabId: ctx.tabId
    });
    return { id: ctx.id, ok: true, result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: e instanceof Error ? e.message : "Broadcast failed" }
    };
  }
}
async function handleAgentsPipeline(ctx) {
  const { config, initialInput } = ctx.payload;
  if (!config?.steps?.length) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INVALID_REQUEST", message: "Missing pipeline steps" }
    };
  }
  try {
    const result = await harborRequest("agents.orchestrate.pipeline", {
      config,
      initialInput,
      origin: ctx.origin
    });
    return { id: ctx.id, ok: true, result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: e instanceof Error ? e.message : "Pipeline failed" }
    };
  }
}
async function handleAgentsParallel(ctx) {
  const { config } = ctx.payload;
  if (!config?.tasks?.length) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INVALID_REQUEST", message: "Missing parallel tasks" }
    };
  }
  try {
    const result = await harborRequest("agents.orchestrate.parallel", {
      config,
      origin: ctx.origin
    });
    return { id: ctx.id, ok: true, result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: e instanceof Error ? e.message : "Parallel execution failed" }
    };
  }
}
async function handleAgentsRoute(ctx) {
  const { config, input, task } = ctx.payload;
  if (!config?.routes?.length) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INVALID_REQUEST", message: "Missing routes" }
    };
  }
  try {
    const result = await harborRequest("agents.orchestrate.route", {
      config,
      input,
      task,
      origin: ctx.origin
    });
    return { id: ctx.id, ok: true, result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: e instanceof Error ? e.message : "Routing failed" }
    };
  }
}
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [agentId, agent] of registeredAgents.entries()) {
    if (agent.tabId === tabId) {
      registeredAgents.delete(agentId);
      harborRequest("agents.unregister", { agentId, origin: agent.origin }).catch(() => {
      });
    }
  }
});
async function handleAgentRun(ctx, sendEvent) {
  const { task, maxToolCalls = 5, systemPrompt } = ctx.payload;
  console.log("[Web Agents API] agent.run starting:", { task, maxToolCalls, origin: ctx.origin });
  if (!await hasPermission(ctx.origin, "model:prompt")) {
    console.log("[Web Agents API] agent.run: Missing model:prompt permission");
    sendEvent({
      id: ctx.id,
      event: { type: "error", error: { code: "ERR_PERMISSION_DENIED", message: "Permission model:prompt required" } },
      done: true
    });
    return;
  }
  try {
    let tools = [];
    const hasToolsListPerm = await hasPermission(ctx.origin, "mcp:tools.list");
    console.log("[Web Agents API] agent.run: mcp:tools.list permission:", hasToolsListPerm);
    if (hasToolsListPerm) {
      const toolsResult = await harborRequest("mcp.listTools", {});
      tools = toolsResult.tools || [];
      console.log("[Web Agents API] agent.run: Found", tools.length, "tools");
      const permissions = await getPermissions(ctx.origin);
      if (permissions.allowedTools && permissions.allowedTools.length > 0) {
        tools = tools.filter(
          (t) => permissions.allowedTools.includes(t.name) || permissions.allowedTools.includes(`${t.serverId}/${t.name}`)
        );
        console.log("[Web Agents API] agent.run: After filtering:", tools.length, "tools");
      }
    }
    const llmTools = tools.map((t) => ({
      name: `${t.serverId}_${t.name}`.replace(/[^a-zA-Z0-9_]/g, "_"),
      // LLM-safe name
      description: t.description || `Tool: ${t.serverId}/${t.name}`,
      input_schema: t.inputSchema || { type: "object", properties: {} },
      // Keep original info for later
      _serverId: t.serverId,
      _toolName: t.name
    }));
    console.log("[Web Agents API] agent.run: LLM tools:", llmTools.map((t) => t.name));
    if (llmTools.length > 0) {
      sendEvent({
        id: ctx.id,
        event: { type: "token", token: JSON.stringify({
          type: "thinking",
          content: `Available tools: ${tools.map((t) => `${t.serverId}/${t.name}`).join(", ")}`
        }) }
      });
    } else {
      sendEvent({
        id: ctx.id,
        event: { type: "token", token: JSON.stringify({
          type: "thinking",
          content: "No tools available (check mcp:tools.list permission)"
        }) }
      });
    }
    const messages = [];
    const fullSystemPrompt = systemPrompt || "You are a helpful assistant that can use tools to help users.";
    messages.push({ role: "system", content: fullSystemPrompt });
    messages.push({ role: "user", content: task });
    let toolCallCount = 0;
    while (toolCallCount < maxToolCalls) {
      console.log("[Web Agents API] agent.run: Calling LLM with", messages.length, "messages and", llmTools.length, "tools");
      let result;
      try {
        result = await harborRequest("llm.chat", {
          messages,
          tools: llmTools.length > 0 ? llmTools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema
          })) : void 0
        });
        console.log("[Web Agents API] agent.run: LLM result:", JSON.stringify(result).substring(0, 500));
      } catch (e) {
        console.error("[Web Agents API] agent.run: LLM request failed:", e);
        sendEvent({
          id: ctx.id,
          event: { type: "token", token: JSON.stringify({ type: "error", error: `LLM request failed: ${e}` }) }
        });
        sendEvent({ id: ctx.id, event: { type: "done" }, done: true });
        return;
      }
      const choice = result.choices?.[0];
      const responseContent = choice?.message?.content || result.content || "";
      const toolCalls = choice?.message?.tool_calls;
      console.log("[Web Agents API] agent.run: Response content:", responseContent?.substring(0, 200));
      console.log("[Web Agents API] agent.run: Tool calls:", toolCalls);
      if (toolCalls && toolCalls.length > 0) {
        const hasToolsCallPerm = await hasPermission(ctx.origin, "mcp:tools.call");
        if (!hasToolsCallPerm) {
          messages.push({ role: "assistant", content: responseContent || "I need to use tools but permission was denied." });
          messages.push({ role: "user", content: "Tool calling is not permitted. Please provide an answer without using tools." });
          continue;
        }
        for (const tc of toolCalls) {
          const llmToolName = tc.function.name;
          let args = {};
          try {
            args = JSON.parse(tc.function.arguments || "{}");
          } catch {
            args = {};
          }
          const toolInfo = llmTools.find((t) => t.name === llmToolName);
          const serverId = toolInfo?._serverId || "";
          const actualToolName = toolInfo?._toolName || llmToolName;
          const displayName = `${serverId}/${actualToolName}`;
          console.log("[Web Agents API] agent.run: Calling tool:", displayName, "with args:", args);
          sendEvent({
            id: ctx.id,
            event: { type: "token", token: JSON.stringify({ type: "tool_call", tool: displayName, args }) }
          });
          let toolResult;
          try {
            const callResult = await harborRequest("mcp.callTool", {
              serverId,
              toolName: actualToolName,
              args
            });
            toolResult = callResult.result;
            console.log("[Web Agents API] agent.run: Tool result:", toolResult);
          } catch (e) {
            console.error("[Web Agents API] agent.run: Tool call failed:", e);
            toolResult = { error: e instanceof Error ? e.message : "Tool call failed" };
          }
          sendEvent({
            id: ctx.id,
            event: { type: "token", token: JSON.stringify({ type: "tool_result", tool: displayName, result: toolResult }) }
          });
          messages.push({
            role: "assistant",
            content: `[Called tool: ${displayName}(${JSON.stringify(args)})]`
          });
          messages.push({
            role: "user",
            content: `Tool "${displayName}" returned: ${JSON.stringify(toolResult)}`
          });
          toolCallCount++;
        }
      } else {
        console.log("[Web Agents API] agent.run: Final response (no tool calls)");
        sendEvent({
          id: ctx.id,
          event: { type: "token", token: JSON.stringify({ type: "final", output: responseContent }) }
        });
        sendEvent({ id: ctx.id, event: { type: "done" }, done: true });
        return;
      }
    }
    console.log("[Web Agents API] agent.run: Max tool calls reached, getting final answer");
    messages.push({ role: "user", content: "Please provide your final answer based on the information gathered." });
    const finalResult = await harborRequest("llm.chat", { messages });
    const finalContent = finalResult.choices?.[0]?.message?.content || finalResult.content || "";
    sendEvent({
      id: ctx.id,
      event: { type: "token", token: JSON.stringify({ type: "final", output: finalContent }) }
    });
    sendEvent({ id: ctx.id, event: { type: "done" }, done: true });
  } catch (e) {
    console.error("[Web Agents API] agent.run: Error:", e);
    sendEvent({
      id: ctx.id,
      event: { type: "error", error: { code: "ERR_AGENT_FAILED", message: e instanceof Error ? e.message : "Agent run failed" } },
      done: true
    });
  }
}
async function handleSessionPromptStreaming(ctx, sendEvent) {
  const { sessionId, input } = ctx.payload;
  const session = textSessions.get(sessionId);
  if (!session) {
    sendEvent({ id: ctx.id, event: { type: "error", error: { code: "ERR_SESSION_NOT_FOUND", message: "Session not found" } }, done: true });
    return;
  }
  if (session.origin !== ctx.origin) {
    sendEvent({ id: ctx.id, event: { type: "error", error: { code: "ERR_PERMISSION_DENIED", message: "Session belongs to different origin" } }, done: true });
    return;
  }
  try {
    session.history.push({ role: "user", content: input });
    const messages = [];
    if (session.options.systemPrompt) {
      messages.push({ role: "system", content: session.options.systemPrompt });
    }
    messages.push(...session.history);
    const { stream, cancel } = harborStreamRequest("llm.chatStream", {
      messages,
      model: session.options.model,
      temperature: session.options.temperature
    });
    let fullContent = "";
    for await (const event of stream) {
      if (event.type === "token" && event.token) {
        fullContent += event.token;
        sendEvent({ id: ctx.id, event: { type: "token", token: event.token } });
      } else if (event.type === "done") {
        session.history.push({ role: "assistant", content: fullContent });
        sendEvent({ id: ctx.id, event: { type: "done" }, done: true });
        break;
      } else if (event.type === "error") {
        sendEvent({
          id: ctx.id,
          event: { type: "error", error: { code: "ERR_MODEL_FAILED", message: event.error?.message || "Stream error" } },
          done: true
        });
        break;
      }
    }
  } catch (e) {
    sendEvent({
      id: ctx.id,
      event: { type: "error", error: { code: "ERR_MODEL_FAILED", message: e instanceof Error ? e.message : "Streaming failed" } },
      done: true
    });
  }
}
async function handleBrowserClick(ctx) {
  if (!await hasPermission(ctx.origin, "browser:activeTab.interact")) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_PERMISSION_DENIED", message: "Permission browser:activeTab.interact required" }
    };
  }
  const { ref } = ctx.payload;
  if (!ref) {
    return { id: ctx.id, ok: false, error: { code: "ERR_INVALID_REQUEST", message: "Missing ref parameter" } };
  }
  if (!ctx.tabId) {
    return { id: ctx.id, ok: false, error: { code: "ERR_INTERNAL", message: "No tab context available" } };
  }
  try {
    const result = await executeScriptInTab(
      ctx.tabId,
      (selector) => {
        const el = document.querySelector(selector);
        if (!el) {
          return { success: false, error: `Element not found: ${selector}` };
        }
        if (el instanceof HTMLElement) {
          if (el.disabled) {
            return { success: false, error: `Element is disabled: ${selector}` };
          }
          el.click();
          if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }
          return { success: true };
        }
        return { success: false, error: "Element is not clickable" };
      },
      [ref]
    );
    if (!result) {
      return { id: ctx.id, ok: false, error: { code: "ERR_INTERNAL", message: "Script execution failed" } };
    }
    if (!result.success) {
      return { id: ctx.id, ok: false, error: { code: "ERR_ELEMENT_NOT_FOUND", message: result.error || "Click failed" } };
    }
    return { id: ctx.id, ok: true, result: { success: true } };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: e instanceof Error ? e.message : "Click failed" }
    };
  }
}
async function handleBrowserFill(ctx) {
  if (!await hasPermission(ctx.origin, "browser:activeTab.interact")) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_PERMISSION_DENIED", message: "Permission browser:activeTab.interact required" }
    };
  }
  const { ref, value } = ctx.payload;
  if (!ref) {
    return { id: ctx.id, ok: false, error: { code: "ERR_INVALID_REQUEST", message: "Missing ref parameter" } };
  }
  if (!ctx.tabId) {
    return { id: ctx.id, ok: false, error: { code: "ERR_INTERNAL", message: "No tab context available" } };
  }
  try {
    const result = await executeScriptInTab(
      ctx.tabId,
      (selector, fillValue) => {
        const el = document.querySelector(selector);
        if (!el) {
          return { success: false, error: `Element not found: ${selector}` };
        }
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          el.value = fillValue;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { success: true };
        }
        if (el instanceof HTMLElement && el.isContentEditable) {
          el.textContent = fillValue;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          return { success: true };
        }
        return { success: false, error: "Element is not fillable" };
      },
      [ref, value ?? ""]
    );
    if (!result) {
      return { id: ctx.id, ok: false, error: { code: "ERR_INTERNAL", message: "Script execution failed" } };
    }
    if (!result.success) {
      return { id: ctx.id, ok: false, error: { code: "ERR_ELEMENT_NOT_FOUND", message: result.error || "Fill failed" } };
    }
    return { id: ctx.id, ok: true, result: { success: true } };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: e instanceof Error ? e.message : "Fill failed" }
    };
  }
}
async function handleBrowserSelect(ctx) {
  if (!await hasPermission(ctx.origin, "browser:activeTab.interact")) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_PERMISSION_DENIED", message: "Permission browser:activeTab.interact required" }
    };
  }
  const { ref, value } = ctx.payload;
  if (!ref) {
    return { id: ctx.id, ok: false, error: { code: "ERR_INVALID_REQUEST", message: "Missing ref parameter" } };
  }
  if (!ctx.tabId) {
    return { id: ctx.id, ok: false, error: { code: "ERR_INTERNAL", message: "No tab context available" } };
  }
  try {
    const result = await executeScriptInTab(
      ctx.tabId,
      (selector, selectValue) => {
        const el = document.querySelector(selector);
        if (!el) {
          return { success: false, error: `Element not found: ${selector}` };
        }
        if (el instanceof HTMLSelectElement) {
          el.value = selectValue;
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { success: true };
        }
        return { success: false, error: "Element is not a select" };
      },
      [ref, value ?? ""]
    );
    if (!result) {
      return { id: ctx.id, ok: false, error: { code: "ERR_INTERNAL", message: "Script execution failed" } };
    }
    if (!result.success) {
      return { id: ctx.id, ok: false, error: { code: "ERR_ELEMENT_NOT_FOUND", message: result.error || "Select failed" } };
    }
    return { id: ctx.id, ok: true, result: { success: true } };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: e instanceof Error ? e.message : "Select failed" }
    };
  }
}
async function handleBrowserScroll(ctx) {
  if (!await hasPermission(ctx.origin, "browser:activeTab.interact")) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_PERMISSION_DENIED", message: "Permission browser:activeTab.interact required" }
    };
  }
  const { direction, amount } = ctx.payload;
  if (!direction) {
    return { id: ctx.id, ok: false, error: { code: "ERR_INVALID_REQUEST", message: "Missing direction parameter" } };
  }
  if (!ctx.tabId) {
    return { id: ctx.id, ok: false, error: { code: "ERR_INTERNAL", message: "No tab context available" } };
  }
  try {
    const result = await executeScriptInTab(
      ctx.tabId,
      (dir, scrollAmount) => {
        const px = scrollAmount || 300;
        switch (dir) {
          case "up":
            window.scrollBy(0, -px);
            break;
          case "down":
            window.scrollBy(0, px);
            break;
          case "left":
            window.scrollBy(-px, 0);
            break;
          case "right":
            window.scrollBy(px, 0);
            break;
        }
        return { success: true };
      },
      [direction, amount ?? 300]
    );
    if (!result) {
      return { id: ctx.id, ok: false, error: { code: "ERR_INTERNAL", message: "Script execution failed" } };
    }
    return { id: ctx.id, ok: true, result: { success: true } };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: e instanceof Error ? e.message : "Scroll failed" }
    };
  }
}
async function handleBrowserScreenshot(ctx) {
  if (!await hasPermission(ctx.origin, "browser:activeTab.screenshot")) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_PERMISSION_DENIED", message: "Permission browser:activeTab.screenshot required" }
    };
  }
  if (!ctx.tabId) {
    return { id: ctx.id, ok: false, error: { code: "ERR_INTERNAL", message: "No tab context available" } };
  }
  try {
    const tabsApi = typeof browser !== "undefined" ? browser.tabs : chrome.tabs;
    const dataUrl = await tabsApi.captureVisibleTab({ format: "png" });
    return { id: ctx.id, ok: true, result: { dataUrl } };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: e instanceof Error ? e.message : "Screenshot failed" }
    };
  }
}
async function handleBrowserGetElements(ctx) {
  if (!await hasPermission(ctx.origin, "browser:activeTab.read")) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_PERMISSION_DENIED", message: "Permission browser:activeTab.read required" }
    };
  }
  if (!ctx.tabId) {
    return { id: ctx.id, ok: false, error: { code: "ERR_INTERNAL", message: "No tab context available" } };
  }
  try {
    const result = await executeScriptInTab(
      ctx.tabId,
      () => {
        const elements = [];
        const selectors = [
          "a[href]",
          "button",
          "input",
          "select",
          "textarea",
          '[role="button"]',
          '[role="link"]',
          "[onclick]",
          '[contenteditable="true"]'
        ];
        const seen = /* @__PURE__ */ new Set();
        for (const selector of selectors) {
          for (const el of document.querySelectorAll(selector)) {
            if (seen.has(el)) continue;
            seen.add(el);
            const style = window.getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden") continue;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            let ref = "";
            if (el.id) {
              ref = `#${el.id}`;
            } else {
              const parts = [];
              let current = el;
              while (current && current !== document.body) {
                let pathSelector = current.tagName.toLowerCase();
                if (current.id) {
                  pathSelector = `#${current.id}`;
                  parts.unshift(pathSelector);
                  break;
                }
                const parent = current.parentElement;
                if (parent) {
                  const siblings = Array.from(parent.children).filter((c) => c.tagName === current.tagName);
                  if (siblings.length > 1) {
                    const index = siblings.indexOf(current) + 1;
                    pathSelector += `:nth-of-type(${index})`;
                  }
                }
                parts.unshift(pathSelector);
                current = parent;
              }
              ref = parts.join(" > ");
            }
            const info = {
              ref,
              tag: el.tagName.toLowerCase()
            };
            if (el instanceof HTMLInputElement) {
              info.type = el.type;
              if (el.placeholder) info.placeholder = el.placeholder;
              if (el.value && el.type !== "password") info.value = el.value;
            } else if (el instanceof HTMLTextAreaElement) {
              if (el.placeholder) info.placeholder = el.placeholder;
            } else if (el instanceof HTMLSelectElement) {
              info.value = el.value;
            }
            const text = el.textContent?.trim().slice(0, 100);
            if (text) info.text = text;
            const role = el.getAttribute("role");
            if (role) info.role = role;
            elements.push(info);
          }
        }
        return elements;
      },
      []
    );
    if (!result) {
      return { id: ctx.id, ok: false, error: { code: "ERR_INTERNAL", message: "Script execution failed" } };
    }
    return { id: ctx.id, ok: true, result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: e instanceof Error ? e.message : "GetElements failed" }
    };
  }
}
async function handleBrowserReadability(ctx) {
  if (!await hasPermission(ctx.origin, "browser:activeTab.read")) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_PERMISSION_DENIED", message: "Permission browser:activeTab.read required" }
    };
  }
  if (!ctx.tabId) {
    return { id: ctx.id, ok: false, error: { code: "ERR_INTERNAL", message: "No tab context available" } };
  }
  try {
    const result = await executeScriptInTab(
      ctx.tabId,
      () => {
        const title = document.title;
        const url = window.location.href;
        const mainSelectors = ["main", "article", '[role="main"]', ".content", "#content", ".post", ".article"];
        let content = "";
        for (const selector of mainSelectors) {
          const el = document.querySelector(selector);
          if (el) {
            content = el.textContent?.trim() || "";
            break;
          }
        }
        if (!content) {
          content = document.body.textContent?.trim() || "";
        }
        content = content.replace(/\s+/g, " ").trim();
        return {
          title,
          url,
          content: content.slice(0, 5e4),
          // Limit size
          length: content.length
        };
      },
      []
    );
    if (!result) {
      return { id: ctx.id, ok: false, error: { code: "ERR_INTERNAL", message: "Script execution failed" } };
    }
    return { id: ctx.id, ok: true, result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: e instanceof Error ? e.message : "Readability extraction failed" }
    };
  }
}
async function handleTabsCreate(ctx) {
  if (!await hasPermission(ctx.origin, "browser:tabs.create")) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_PERMISSION_DENIED", message: "Permission browser:tabs.create required" }
    };
  }
  const payload = ctx.payload;
  if (!payload.url) {
    return { id: ctx.id, ok: false, error: { code: "ERR_INVALID_REQUEST", message: "Missing url parameter" } };
  }
  try {
    const tab = await chrome.tabs.create({
      url: payload.url,
      active: payload.active ?? false,
      index: payload.index,
      windowId: payload.windowId
    });
    if (!tab.id) {
      return { id: ctx.id, ok: false, error: { code: "ERR_INTERNAL", message: "Failed to create tab" } };
    }
    trackSpawnedTab(ctx.origin, tab.id);
    return {
      id: ctx.id,
      ok: true,
      result: {
        id: tab.id,
        url: tab.url || payload.url,
        title: tab.title || "",
        active: tab.active,
        index: tab.index,
        windowId: tab.windowId,
        canControl: true
      }
    };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: e instanceof Error ? e.message : "Failed to create tab" }
    };
  }
}
async function handleTabsList(ctx) {
  if (!await hasPermission(ctx.origin, "browser:tabs.read")) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_PERMISSION_DENIED", message: "Permission browser:tabs.read required" }
    };
  }
  try {
    const tabs = await chrome.tabs.query({});
    const result = tabs.map((tab) => ({
      id: tab.id,
      url: tab.url || "",
      title: tab.title || "",
      active: tab.active,
      index: tab.index,
      windowId: tab.windowId,
      favIconUrl: tab.favIconUrl,
      status: tab.status,
      canControl: tab.id ? isSpawnedTab(ctx.origin, tab.id) : false
    }));
    return { id: ctx.id, ok: true, result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: e instanceof Error ? e.message : "Failed to list tabs" }
    };
  }
}
async function handleTabsClose(ctx) {
  if (!await hasPermission(ctx.origin, "browser:tabs.create")) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_PERMISSION_DENIED", message: "Permission browser:tabs.create required" }
    };
  }
  const { tabId } = ctx.payload;
  if (typeof tabId !== "number") {
    return { id: ctx.id, ok: false, error: { code: "ERR_INVALID_REQUEST", message: "Missing tabId parameter" } };
  }
  if (!isSpawnedTab(ctx.origin, tabId)) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_PERMISSION_DENIED", message: "Can only close tabs created by this origin" }
    };
  }
  try {
    await chrome.tabs.remove(tabId);
    untrackSpawnedTab(ctx.origin, tabId);
    return { id: ctx.id, ok: true, result: true };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: e instanceof Error ? e.message : "Failed to close tab" }
    };
  }
}
async function handleSpawnedTabReadability(ctx) {
  if (!await hasPermission(ctx.origin, "browser:tabs.create")) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_PERMISSION_DENIED", message: "Permission browser:tabs.create required" }
    };
  }
  const { tabId } = ctx.payload;
  if (typeof tabId !== "number") {
    return { id: ctx.id, ok: false, error: { code: "ERR_INVALID_REQUEST", message: "Missing tabId parameter" } };
  }
  if (!isSpawnedTab(ctx.origin, tabId)) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_PERMISSION_DENIED", message: "Can only read from tabs created by this origin" }
    };
  }
  try {
    const result = await executeScriptInTab(
      tabId,
      () => {
        const title = document.title;
        const url = window.location.href;
        const mainSelectors = ["main", "article", '[role="main"]', ".content", "#content", ".post", ".article"];
        let content = "";
        for (const selector of mainSelectors) {
          const el = document.querySelector(selector);
          if (el) {
            content = el.textContent?.trim() || "";
            break;
          }
        }
        if (!content) {
          content = document.body.textContent?.trim() || "";
        }
        content = content.replace(/\s+/g, " ").trim();
        return {
          title,
          url,
          content: content.slice(0, 5e4),
          text: content.slice(0, 5e4),
          // Alias for compatibility
          length: content.length
        };
      },
      []
    );
    if (!result) {
      return { id: ctx.id, ok: false, error: { code: "ERR_INTERNAL", message: "Script execution failed" } };
    }
    return { id: ctx.id, ok: true, result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: e instanceof Error ? e.message : "Readability extraction failed" }
    };
  }
}
async function handleSpawnedTabGetHtml(ctx) {
  if (!await hasPermission(ctx.origin, "browser:tabs.create")) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_PERMISSION_DENIED", message: "Permission browser:tabs.create required" }
    };
  }
  const { tabId, selector } = ctx.payload;
  if (typeof tabId !== "number") {
    return { id: ctx.id, ok: false, error: { code: "ERR_INVALID_REQUEST", message: "Missing tabId parameter" } };
  }
  if (!isSpawnedTab(ctx.origin, tabId)) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_PERMISSION_DENIED", message: "Can only read from tabs created by this origin" }
    };
  }
  try {
    const result = await executeScriptInTab(
      tabId,
      (containerSelector) => {
        const container = containerSelector ? document.querySelector(containerSelector) : document.body;
        return {
          html: container?.outerHTML || document.body.outerHTML,
          url: window.location.href,
          title: document.title
        };
      },
      [selector || null]
    );
    if (!result) {
      return { id: ctx.id, ok: false, error: { code: "ERR_INTERNAL", message: "Script execution failed" } };
    }
    return { id: ctx.id, ok: true, result };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: e instanceof Error ? e.message : "Get HTML failed" }
    };
  }
}
async function handleSpawnedTabWaitForLoad(ctx) {
  if (!await hasPermission(ctx.origin, "browser:tabs.create")) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_PERMISSION_DENIED", message: "Permission browser:tabs.create required" }
    };
  }
  const { tabId, timeout = 3e4 } = ctx.payload;
  if (typeof tabId !== "number") {
    return { id: ctx.id, ok: false, error: { code: "ERR_INVALID_REQUEST", message: "Missing tabId parameter" } };
  }
  if (!isSpawnedTab(ctx.origin, tabId)) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_PERMISSION_DENIED", message: "Can only wait for tabs created by this origin" }
    };
  }
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") {
      return { id: ctx.id, ok: true, result: void 0 };
    }
    await new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error("Navigation timeout"));
      }, timeout);
      const listener = (updatedTabId, changeInfo) => {
        if (updatedTabId === tabId && changeInfo.status === "complete") {
          clearTimeout(timeoutId);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
    return { id: ctx.id, ok: true, result: void 0 };
  } catch (e) {
    return {
      id: ctx.id,
      ok: false,
      error: { code: "ERR_INTERNAL", message: e instanceof Error ? e.message : "Wait for load failed" }
    };
  }
}
async function routeMessage(ctx) {
  switch (ctx.type) {
    // AI operations
    case "ai.canCreateTextSession":
      return handleAiCanCreateTextSession(ctx);
    case "ai.createTextSession":
    case "ai.languageModel.create":
      return handleAiCreateTextSession(ctx);
    case "session.prompt":
      return handleSessionPrompt(ctx);
    case "session.destroy":
      return handleSessionDestroy(ctx);
    case "ai.languageModel.capabilities":
      return handleLanguageModelCapabilities(ctx);
    case "ai.providers.list":
      return handleProviderslist(ctx);
    case "ai.providers.getActive":
      return handleProvidersGetActive(ctx);
    // Permission operations
    case "agent.requestPermissions":
      return handleRequestPermissions(ctx);
    case "agent.permissions.list":
      return handlePermissionsList(ctx);
    // Tool operations
    case "agent.tools.list":
      return handleToolsList(ctx);
    case "agent.tools.call":
      return handleToolsCall(ctx);
    // Session operations (explicit sessions)
    case "agent.sessions.create":
      return handleSessionsCreate(ctx);
    case "agent.sessions.get":
      return handleSessionsGet(ctx);
    case "agent.sessions.list":
      return handleSessionsList(ctx);
    case "agent.sessions.terminate":
      return handleSessionsTerminate(ctx);
    // MCP server operations
    case "agent.mcp.discover":
      return handleMcpDiscover(ctx);
    case "agent.mcp.register":
      return handleMcpRegister(ctx);
    case "agent.mcp.unregister":
      return handleMcpUnregister(ctx);
    // Chat API operations
    case "agent.chat.canOpen":
      return handleChatCanOpen(ctx);
    case "agent.chat.open":
      return handleChatOpen(ctx);
    case "agent.chat.close":
      return handleChatClose(ctx);
    // Browser interaction operations
    case "agent.browser.activeTab.click":
      return handleBrowserClick(ctx);
    case "agent.browser.activeTab.fill":
      return handleBrowserFill(ctx);
    case "agent.browser.activeTab.scroll":
      return handleBrowserScroll(ctx);
    case "agent.browser.activeTab.screenshot":
      return handleBrowserScreenshot(ctx);
    case "agent.browser.activeTab.getElements":
      return handleBrowserGetElements(ctx);
    case "agent.browser.activeTab.readability":
      return handleBrowserReadability(ctx);
    case "agent.browser.activeTab.select":
      return handleBrowserSelect(ctx);
    // Tab management operations
    case "agent.browser.tabs.create":
      return handleTabsCreate(ctx);
    case "agent.browser.tabs.list":
      return handleTabsList(ctx);
    case "agent.browser.tabs.close":
      return handleTabsClose(ctx);
    // Spawned tab operations
    case "agent.browser.tab.readability":
      return handleSpawnedTabReadability(ctx);
    case "agent.browser.tab.getHtml":
      return handleSpawnedTabGetHtml(ctx);
    case "agent.browser.tab.waitForLoad":
      return handleSpawnedTabWaitForLoad(ctx);
    // Multi-agent operations
    case "agent.agents.register":
      return handleAgentsRegister(ctx);
    case "agent.agents.unregister":
      return handleAgentsUnregister(ctx);
    case "agent.agents.getInfo":
      return handleAgentsGetInfo(ctx);
    case "agent.agents.discover":
      return handleAgentsDiscover(ctx);
    case "agent.agents.list":
      return handleAgentsList(ctx);
    case "agent.agents.invoke":
      return handleAgentsInvoke(ctx);
    case "agent.agents.send":
      return handleAgentsSend(ctx);
    case "agent.agents.subscribe":
      return handleAgentsSubscribe(ctx);
    case "agent.agents.unsubscribe":
      return handleAgentsUnsubscribe(ctx);
    case "agent.agents.broadcast":
      return handleAgentsBroadcast(ctx);
    case "agent.agents.orchestrate.pipeline":
      return handleAgentsPipeline(ctx);
    case "agent.agents.orchestrate.parallel":
      return handleAgentsParallel(ctx);
    case "agent.agents.orchestrate.route":
      return handleAgentsRoute(ctx);
    default:
      return {
        id: ctx.id,
        ok: false,
        error: { code: "ERR_INTERNAL", message: `Unknown message type: ${ctx.type}` }
      };
  }
}
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "web-agent-transport") return;
  console.log("[Web Agents API] Port connected, sender:", JSON.stringify(port.sender));
  port.onMessage.addListener(async (message) => {
    const tabId = port.sender?.tab?.id;
    console.log("[Web Agents API] Port message received:", message.type, "tabId:", tabId);
    const ctx = {
      id: message.id,
      type: message.type,
      payload: message.payload,
      origin: message.origin || "",
      tabId
    };
    if (ctx.type === "session.promptStreaming") {
      const sendEvent = (event) => {
        try {
          port.postMessage(event);
        } catch {
        }
      };
      await handleSessionPromptStreaming(ctx, sendEvent);
      return;
    }
    if (ctx.type === "agent.run") {
      const sendEvent = (event) => {
        try {
          port.postMessage(event);
        } catch {
        }
      };
      await handleAgentRun(ctx, sendEvent);
      return;
    }
    const response = await routeMessage(ctx);
    try {
      port.postMessage(response);
    } catch {
    }
  });
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "harbor_discovered" && message.extensionId) {
    setHarborExtensionId(message.extensionId);
    sendResponse({ ok: true });
  }
  return false;
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "agentInvocationResponse") {
    return false;
  }
  const { invocationId, success, result, error } = message.response;
  console.log("[Web Agents API] Received invocation response:", invocationId, success);
  const pending = pendingInvocations.get(invocationId);
  if (pending) {
    pending.resolve({ success, result, error });
  }
  sendResponse({ ok: true });
  return true;
});
var processedForwardedInvocations = /* @__PURE__ */ new Set();
function handleForwardedInvocation(message, sendResponse, source) {
  const { agentId, request, handlerInfo, traceId } = message;
  const trace = traceId || "no-trace";
  console.log(`[TRACE ${trace}] handleForwardedInvocation START - source: ${source}, agentId: ${agentId}, task: ${request.task}`);
  const invocationKey = `${agentId}-${request.from}-${request.task}-${JSON.stringify(request.input || {}).slice(0, 100)}`;
  if (processedForwardedInvocations.has(invocationKey)) {
    console.log(`[TRACE ${trace}] DUPLICATE forwarded invocation, skipping - source: ${source}`);
    return false;
  }
  processedForwardedInvocations.add(invocationKey);
  setTimeout(() => processedForwardedInvocations.delete(invocationKey), 3e4);
  const tabId = handlerInfo.tabId || agentInvocationTabs.get(agentId);
  console.log(`[TRACE ${trace}] Tab lookup - handlerInfo.tabId: ${handlerInfo.tabId}, agentInvocationTabs: ${agentInvocationTabs.get(agentId)}, final: ${tabId}`);
  if (!tabId) {
    console.log(`[TRACE ${trace}] ERROR - no tab found`);
    sendResponse({ success: false, error: { code: "ERR_NO_TAB", message: "Agent tab not found" } });
    return true;
  }
  console.log(`[TRACE ${trace}] Calling handleIncomingInvocation...`);
  handleIncomingInvocation(agentId, request, trace).then((response) => {
    console.log(`[TRACE ${trace}] handleIncomingInvocation complete, success: ${response.success}`);
    sendResponse(response);
  }).catch((error) => {
    console.log(`[TRACE ${trace}] handleIncomingInvocation ERROR: ${error.message}`);
    sendResponse({ success: false, error: { code: "ERR_FAILED", message: error.message } });
  });
  return true;
}
chrome.runtime.onMessageExternal?.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "harbor.forwardInvocation") {
    return false;
  }
  return handleForwardedInvocation(message, sendResponse, "onMessageExternal");
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "harbor.forwardInvocation") {
    return false;
  }
  if (sender.id === chrome.runtime.id) {
    return false;
  }
  return handleForwardedInvocation(message, sendResponse, "onMessage");
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "checkHarborConnection") {
    (async () => {
      const state = getHarborState();
      if (!state.connected) {
        const id = await discoverHarbor();
        sendResponse({ connected: !!id, extensionId: id });
      } else {
        sendResponse({ connected: true, extensionId: state.extensionId });
      }
    })();
    return true;
  }
  if (message?.type === "getPermissionsForOrigin") {
    const { origin } = message;
    if (!origin) {
      sendResponse({ scopes: {}, allowedTools: [] });
      return true;
    }
    (async () => {
      const permissions = await getPermissions(origin);
      const scopes = {};
      for (const [scope, grant] of Object.entries(permissions.scopes || {})) {
        if (grant.type === "granted-once" && grant.expiresAt && Date.now() > grant.expiresAt) {
          scopes[scope] = "not-granted";
        } else {
          scopes[scope] = grant.type;
        }
      }
      sendResponse({ scopes, allowedTools: permissions.allowedTools || [] });
    })();
    return true;
  }
  if (message?.type === "listAllPermissions") {
    (async () => {
      const permissions = await listAllPermissions();
      sendResponse({ permissions });
    })();
    return true;
  }
  if (message?.type === "revokePermissions") {
    const { origin } = message;
    if (!origin) {
      sendResponse({ ok: false, error: "Missing origin" });
      return true;
    }
    (async () => {
      await revokeOriginPermissions(origin);
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (message?.type === "revokeAllPermissions") {
    (async () => {
      const result = await chrome.storage.local.get(null);
      const keysToRemove = [];
      for (const key of Object.keys(result)) {
        if (key.startsWith("permissions:")) {
          keysToRemove.push(key);
        }
      }
      if (keysToRemove.length > 0) {
        await chrome.storage.local.remove(keysToRemove);
      }
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (message?.type === "getFeatureFlags") {
    (async () => {
      const flags = await getFeatureFlags();
      sendResponse(flags);
    })();
    return true;
  }
  return false;
});
discoverHarbor().then((id) => {
  if (id) {
    console.log("[Web Agents API] Harbor found:", id);
  } else {
    console.log("[Web Agents API] Harbor not found - will retry on first request");
  }
});
console.log("[Web Agents API] Extension initialized.");
//# sourceMappingURL=background.js.map
