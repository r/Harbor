// src/browser-compat.ts
var browserAPI = typeof browser !== "undefined" ? browser : chrome;

// src/sidebar.ts
var headerLogo = document.getElementById("header-logo");
var serversEl = document.getElementById("servers");
var addBtn = document.getElementById("add");
var fileInput = document.getElementById("file");
var addRemoteBtn = document.getElementById("add-remote");
var remoteServerForm = document.getElementById("remote-server-form");
var remoteServerUrlInput = document.getElementById("remote-server-url");
var remoteServerNameInput = document.getElementById("remote-server-name");
var remoteServerTransportSelect = document.getElementById("remote-server-transport");
var remoteServerAuthInput = document.getElementById("remote-server-auth");
var remoteServerTestBtn = document.getElementById("remote-server-test");
var remoteServerSaveBtn = document.getElementById("remote-server-save");
var remoteServerCancelBtn = document.getElementById("remote-server-cancel");
var bridgeStatusIndicator = document.getElementById("bridge-status-indicator");
var bridgeStatusText = document.getElementById("bridge-status-text");
var llmPanelHeader = document.getElementById("llm-panel-header");
var llmPanelToggle = document.getElementById("llm-panel-toggle");
var llmPanelBody = document.getElementById("llm-panel-body");
var llmStatusIndicator = document.getElementById("llm-status-indicator");
var llmStatusText = document.getElementById("llm-status-text");
var configuredModelsEl = document.getElementById("configured-models");
var availableModelsSelect = document.getElementById("available-models");
var addModelBtn = document.getElementById("add-model-btn");
var providersCountEl = document.getElementById("providers-count");
var detectedProvidersEl = document.getElementById("detected-providers");
var apiKeyConfig = document.getElementById("api-key-config");
var apiKeyProviderName = document.getElementById("api-key-provider-name");
var apiKeyInput = document.getElementById("api-key-input");
var apiKeySaveBtn = document.getElementById("api-key-save");
var apiKeyCancelBtn = document.getElementById("api-key-cancel");
var serversPanelHeader = document.getElementById("servers-panel-header");
var serversPanelToggle = document.getElementById("servers-panel-toggle");
var configuringProviderId = null;
var oauthPanelHeader = document.getElementById("oauth-panel-header");
var oauthPanelToggle = document.getElementById("oauth-panel-toggle");
var oauthPanelBody = document.getElementById("oauth-panel-body");
var oauthStatusIndicator = document.getElementById("oauth-status-indicator");
var oauthStatusText = document.getElementById("oauth-status-text");
var oauthProvidersList = document.getElementById("oauth-providers-list");
var oauthConfigForm = document.getElementById("oauth-config-form");
var oauthConfigProviderName = document.getElementById("oauth-config-provider-name");
var oauthClientIdInput = document.getElementById("oauth-client-id");
var oauthClientSecretInput = document.getElementById("oauth-client-secret");
var oauthConfigSaveBtn = document.getElementById("oauth-config-save");
var oauthConfigCancelBtn = document.getElementById("oauth-config-cancel");
var oauthHelpLink = document.getElementById("oauth-help-link");
var configuringOAuthProvider = null;
var cachedAvailableModels = [];
var BRIDGE_STATUS_POLL_INTERVAL = 5e3;
function getSystemTheme() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function applyTheme(theme) {
  const effectiveTheme = theme === "system" ? getSystemTheme() : theme;
  document.documentElement.setAttribute("data-theme", effectiveTheme);
  localStorage.setItem("harbor-theme", theme);
  updateThemeToggle(theme);
}
function updateThemeToggle(theme) {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  const icons = { light: "\u2600\uFE0F", dark: "\u{1F319}", system: "\u{1F5A5}\uFE0F" };
  btn.textContent = icons[theme];
  btn.title = `Theme: ${theme} (click to change)`;
}
function initTheme() {
  const isSafariBrowser = typeof browser !== "undefined" && navigator.userAgent.includes("Safari") && !navigator.userAgent.includes("Chrome");
  if (isSafariBrowser) {
    const themeBtn = document.getElementById("theme-toggle");
    if (themeBtn) themeBtn.style.display = "none";
    applyTheme("system");
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      applyTheme("system");
    });
    return;
  }
  const saved = localStorage.getItem("harbor-theme");
  const theme = saved || "system";
  applyTheme(theme);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    const current = localStorage.getItem("harbor-theme");
    if (current === "system" || !current) {
      applyTheme("system");
    }
  });
}
function cycleTheme() {
  const current = localStorage.getItem("harbor-theme") || "system";
  const order = ["system", "light", "dark"];
  const next = order[(order.indexOf(current) + 1) % order.length];
  applyTheme(next);
}
initTheme();
function showToast(message, type = "info", duration = 3e3) {
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();
  const toast = document.createElement("div");
  toast.className = `toast ${type !== "info" ? type : ""}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}
var DEBUGGING_URL = "about:debugging#/runtime/this-firefox";
headerLogo.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(DEBUGGING_URL);
    showToast("Copied debugging URL to clipboard");
  } catch (err) {
    console.error("[Sidebar] Failed to copy to clipboard:", err);
    showToast("Failed to copy URL");
  }
});
function updateBridgeStatusUI(connected, error) {
  if (connected) {
    bridgeStatusIndicator.className = "status-indicator connected";
    bridgeStatusText.className = "status-text connected";
    bridgeStatusText.textContent = "Connected";
  } else {
    bridgeStatusIndicator.className = "status-indicator disconnected";
    bridgeStatusText.className = "status-text disconnected";
    bridgeStatusText.textContent = "Disconnected";
    if (error) {
      bridgeStatusText.title = error;
    }
  }
}
var lastBridgeConnected = false;
async function checkBridgeStatus() {
  try {
    const response = await browserAPI.runtime.sendMessage({ type: "bridge_check_health" });
    const debugInfo = `connected: ${response.connected}, error: ${response.error || "none"}`;
    bridgeStatusText.title = debugInfo;
    console.log("[Sidebar] Bridge status:", debugInfo);
    updateBridgeStatusUI(response.connected, response.error);
    if (response.connected && !lastBridgeConnected) {
      console.log("[Sidebar] Bridge connected - refreshing all data...");
      Promise.all([
        loadServers().catch((e) => console.error("[Sidebar] Failed to load servers:", e)),
        loadLlmProviders().catch((e) => console.error("[Sidebar] Failed to load LLM providers:", e)),
        loadPermissions().catch((e) => console.error("[Sidebar] Failed to load permissions:", e)),
        loadSessions().catch((e) => console.error("[Sidebar] Failed to load sessions:", e))
      ]);
    }
    lastBridgeConnected = response.connected;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown error";
    console.error("[Sidebar] Failed to check bridge status:", errorMsg);
    bridgeStatusText.title = `Error: ${errorMsg}`;
    updateBridgeStatusUI(false, errorMsg);
    lastBridgeConnected = false;
  }
}
function startBridgeStatusPolling() {
  checkBridgeStatus();
  setInterval(checkBridgeStatus, BRIDGE_STATUS_POLL_INTERVAL);
}
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}
function renderServer(server) {
  const item = document.createElement("div");
  item.className = "server";
  const header = document.createElement("div");
  header.className = "server-title";
  const nameContainer = document.createElement("span");
  nameContainer.style.display = "flex";
  nameContainer.style.alignItems = "center";
  nameContainer.style.gap = "6px";
  const name = document.createElement("span");
  name.textContent = server.name;
  nameContainer.appendChild(name);
  const runtimeBadge = document.createElement("span");
  if (server.runtime === "remote") {
    runtimeBadge.className = "badge badge-remote";
    runtimeBadge.textContent = "REMOTE";
  } else {
    runtimeBadge.className = "badge badge-muted";
    runtimeBadge.textContent = server.runtime === "js" ? "JS" : "WASM";
  }
  nameContainer.appendChild(runtimeBadge);
  const actions = document.createElement("span");
  actions.className = "server-actions";
  if (!server.running) {
    const startButton = document.createElement("button");
    startButton.className = "btn btn-secondary btn-sm";
    startButton.textContent = "Start";
    startButton.addEventListener("click", async () => {
      startButton.disabled = true;
      const response = await browserAPI.runtime.sendMessage({
        type: "sidebar_validate_server",
        serverId: server.id
      });
      if (!response?.ok) {
        console.error(response?.error || "Failed to start server");
      }
      await loadServers();
      startButton.disabled = false;
    });
    actions.appendChild(startButton);
  } else {
    const stopButton = document.createElement("button");
    stopButton.className = "btn btn-secondary btn-sm";
    stopButton.textContent = "Stop";
    stopButton.addEventListener("click", async () => {
      stopButton.disabled = true;
      const response = await browserAPI.runtime.sendMessage({
        type: "sidebar_stop_server",
        serverId: server.id
      });
      if (!response?.ok) {
        console.error(response?.error || "Failed to stop server");
      }
      await loadServers();
      stopButton.disabled = false;
    });
    actions.appendChild(stopButton);
  }
  const removeButton = document.createElement("button");
  removeButton.className = "btn btn-ghost btn-sm";
  removeButton.textContent = "Unload";
  removeButton.addEventListener("click", async () => {
    removeButton.disabled = true;
    const response = await browserAPI.runtime.sendMessage({
      type: "sidebar_remove_server",
      serverId: server.id
    });
    if (!response?.ok) {
      console.error(response?.error || "Failed to remove server");
    }
    await loadServers();
    removeButton.disabled = false;
  });
  actions.appendChild(removeButton);
  header.appendChild(nameContainer);
  header.appendChild(actions);
  const meta = document.createElement("div");
  meta.className = "server-meta";
  const statusDot = document.createElement("span");
  statusDot.className = `status-dot ${server.running ? "status-running" : "status-stopped"}`;
  meta.appendChild(statusDot);
  const statusText = document.createElement("span");
  statusText.textContent = server.running ? "Running" : "Stopped";
  statusText.style.marginRight = "12px";
  meta.appendChild(statusText);
  if (server.runtime === "remote" && server.remoteUrl) {
    const urlText = document.createElement("span");
    urlText.textContent = server.remoteUrl;
    urlText.style.color = "var(--color-text-muted)";
    urlText.style.fontSize = "var(--text-xs)";
    urlText.style.fontFamily = "var(--font-mono)";
    urlText.style.marginRight = "12px";
    urlText.style.wordBreak = "break-all";
    meta.appendChild(urlText);
  }
  const toolNames = (server.tools || []).map((tool) => tool.name).join(", ");
  if (toolNames.length > 0) {
    const toolsText = document.createElement("span");
    toolsText.textContent = `Tools: ${toolNames}`;
    toolsText.style.color = "var(--color-text-muted)";
    meta.appendChild(toolsText);
  }
  item.appendChild(header);
  item.appendChild(meta);
  return item;
}
var isLoadingServers = false;
async function loadServers() {
  if (isLoadingServers) {
    console.log("[Sidebar] Already loading servers, skipping...");
    return;
  }
  isLoadingServers = true;
  try {
    serversEl.innerHTML = "";
    const response = await browserAPI.runtime.sendMessage({ type: "sidebar_get_servers" });
    if (!response?.ok) {
      serversEl.textContent = response?.error || "Failed to load servers";
      return;
    }
    const servers = response.servers;
    if (!servers || servers.length === 0) {
      serversEl.textContent = "No servers installed.";
      return;
    }
    const seen = /* @__PURE__ */ new Set();
    const uniqueServers = servers.filter((s) => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    });
    uniqueServers.forEach((server) => serversEl.appendChild(renderServer(server)));
  } finally {
    isLoadingServers = false;
  }
}
var themeToggle = document.getElementById("theme-toggle");
themeToggle?.addEventListener("click", cycleTheme);
addBtn.addEventListener("click", () => {
  fileInput.click();
});
fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) {
    return;
  }
  let manifest;
  if (file.name.endsWith(".json")) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed.id && !parsed.name) {
        showToast("Invalid manifest: missing id or name");
        fileInput.value = "";
        return;
      }
      manifest = {
        ...parsed,
        // Generate id if not provided
        id: parsed.id || `mcp-${Date.now()}`,
        // Default runtime to 'js' if scriptBase64 or scriptUrl present
        runtime: parsed.runtime || (parsed.scriptBase64 || parsed.scriptUrl ? "js" : "wasm"),
        permissions: parsed.permissions || []
      };
      showToast(`Loading ${manifest.runtime === "js" ? "JS" : "WASM"} server: ${manifest.name || manifest.id}`);
    } catch (e) {
      console.error("Failed to parse manifest:", e);
      showToast("Failed to parse JSON manifest");
      fileInput.value = "";
      return;
    }
  } else {
    const bytes = await file.arrayBuffer();
    manifest = {
      id: `wasm-${Date.now()}`,
      name: file.name.replace(/\.wasm$/i, ""),
      version: "0.1.0",
      runtime: "wasm",
      entrypoint: file.name,
      moduleBytesBase64: toBase64(bytes),
      permissions: [],
      tools: []
    };
    showToast(`Loading WASM server: ${manifest.name}`);
  }
  const response = await browserAPI.runtime.sendMessage({
    type: "sidebar_install_server",
    manifest
  });
  if (!response?.ok) {
    console.error(response?.error || "Failed to install server");
    showToast("Failed to install server");
  }
  fileInput.value = "";
  const validate = await browserAPI.runtime.sendMessage({
    type: "sidebar_validate_server",
    serverId: manifest.id
  });
  if (!validate?.ok) {
    console.error(validate?.error || "Failed to validate server");
    showToast("Failed to start server: " + (validate?.error || "unknown error"));
  } else {
    showToast("Server installed and started");
  }
  await loadServers();
});
loadServers().catch((error) => {
  console.error("Failed to load servers", error);
});
function showRemoteServerForm() {
  remoteServerForm.style.display = "block";
  remoteServerUrlInput.value = "";
  remoteServerNameInput.value = "";
  remoteServerTransportSelect.value = "sse";
  remoteServerAuthInput.value = "";
  remoteServerUrlInput.focus();
}
function hideRemoteServerForm() {
  remoteServerForm.style.display = "none";
  remoteServerUrlInput.value = "";
  remoteServerNameInput.value = "";
  remoteServerAuthInput.value = "";
}
addRemoteBtn?.addEventListener("click", showRemoteServerForm);
remoteServerCancelBtn?.addEventListener("click", hideRemoteServerForm);
remoteServerTestBtn?.addEventListener("click", async () => {
  const url = remoteServerUrlInput.value.trim();
  if (!url) {
    showToast("Please enter a server URL", "error");
    return;
  }
  remoteServerTestBtn.disabled = true;
  remoteServerTestBtn.textContent = "Testing...";
  try {
    const response = await browserAPI.runtime.sendMessage({
      type: "sidebar_test_remote_server",
      url,
      transport: remoteServerTransportSelect.value,
      authHeader: remoteServerAuthInput.value.trim() || void 0
    });
    if (response?.ok) {
      showToast(`Connection successful! Found ${response.toolCount || 0} tools.`, "success");
      if (!remoteServerNameInput.value && response.serverName) {
        remoteServerNameInput.value = response.serverName;
      }
    } else {
      showToast(`Connection failed: ${response?.error || "Unknown error"}`, "error");
    }
  } catch (err) {
    showToast(`Test failed: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
  remoteServerTestBtn.disabled = false;
  remoteServerTestBtn.textContent = "Test Connection";
});
remoteServerSaveBtn?.addEventListener("click", async () => {
  const url = remoteServerUrlInput.value.trim();
  const name = remoteServerNameInput.value.trim();
  const transport = remoteServerTransportSelect.value;
  const authHeader = remoteServerAuthInput.value.trim() || void 0;
  if (!url) {
    showToast("Please enter a server URL", "error");
    return;
  }
  if (!name) {
    showToast("Please enter a server name", "error");
    return;
  }
  remoteServerSaveBtn.disabled = true;
  remoteServerSaveBtn.textContent = "Adding...";
  try {
    const response = await browserAPI.runtime.sendMessage({
      type: "sidebar_add_remote_server",
      url,
      name,
      transport,
      authHeader
    });
    if (response?.ok) {
      showToast(`Added remote server: ${name}`, "success");
      hideRemoteServerForm();
      await loadServers();
    } else {
      showToast(`Failed to add server: ${response?.error || "Unknown error"}`, "error");
    }
  } catch (err) {
    showToast(`Failed: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
  remoteServerSaveBtn.disabled = false;
  remoteServerSaveBtn.textContent = "Add Server";
});
browserAPI.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.harbor_mcp_servers) {
    console.log("[Sidebar] Server storage changed, refreshing...");
    loadServers();
  }
});
startBridgeStatusPolling();
function setupPanelToggle(header, toggle, body) {
  header.addEventListener("click", () => {
    const isCollapsed = body.classList.toggle("collapsed");
    toggle.classList.toggle("collapsed", isCollapsed);
  });
}
setupPanelToggle(llmPanelHeader, llmPanelToggle, llmPanelBody);
setupPanelToggle(serversPanelHeader, serversPanelToggle, serversEl);
function capitalizeFirst(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
function showApiKeyConfig(providerType) {
  configuringProviderId = providerType;
  apiKeyProviderName.textContent = `Configure ${capitalizeFirst(providerType)}`;
  apiKeyInput.value = "";
  apiKeyConfig.style.display = "block";
  apiKeyInput.focus();
}
function hideApiKeyConfig() {
  configuringProviderId = null;
  apiKeyConfig.style.display = "none";
  apiKeyInput.value = "";
}
apiKeySaveBtn.addEventListener("click", async () => {
  if (!configuringProviderId || !apiKeyInput.value.trim()) return;
  apiKeySaveBtn.disabled = true;
  apiKeySaveBtn.textContent = "Saving...";
  try {
    const response = await browserAPI.runtime.sendMessage({
      type: "llm_configure_provider",
      provider: configuringProviderId,
      name: capitalizeFirst(configuringProviderId),
      api_key: apiKeyInput.value.trim(),
      enabled: true
    });
    if (response.ok) {
      showToast("API key saved");
      hideApiKeyConfig();
      await loadLlmProviders();
    } else {
      showToast("Failed to save: " + (response.error || "Unknown error"));
    }
  } catch (err) {
    showToast("Failed to save API key");
    console.error("Failed to save:", err);
  }
  apiKeySaveBtn.disabled = false;
  apiKeySaveBtn.textContent = "Save";
});
apiKeyCancelBtn.addEventListener("click", () => {
  hideApiKeyConfig();
});
async function loadLlmProviders() {
  try {
    const [configuredModelsRes, modelsRes, providersRes] = await Promise.all([
      browserAPI.runtime.sendMessage({ type: "llm_list_configured_models" }),
      browserAPI.runtime.sendMessage({ type: "llm_list_models" }),
      browserAPI.runtime.sendMessage({ type: "llm_list_providers" })
    ]);
    const configuredModels = configuredModelsRes.ok ? configuredModelsRes.models || [] : [];
    renderConfiguredModels(configuredModels);
    const availableModels = modelsRes.ok ? modelsRes.models || [] : [];
    cachedAvailableModels = availableModels;
    renderAvailableModelsDropdown(availableModels, configuredModels);
    const providers = providersRes.ok ? providersRes.providers || [] : [];
    const availableCount = providers.filter((p) => p.available || p.is_local && p.configured).length;
    providersCountEl.textContent = String(availableCount);
    renderProviders(providers);
    if (configuredModels.length > 0) {
      llmStatusIndicator.className = "status-indicator connected";
      llmStatusText.className = "status-text connected";
      llmStatusText.textContent = `${configuredModels.length} model${configuredModels.length > 1 ? "s" : ""}`;
    } else if (availableModels.length > 0) {
      llmStatusIndicator.className = "status-indicator connecting";
      llmStatusText.className = "status-text connecting";
      llmStatusText.textContent = "No models configured";
    } else {
      llmStatusIndicator.className = "status-indicator disconnected";
      llmStatusText.className = "status-text disconnected";
      llmStatusText.textContent = "No models";
    }
  } catch (err) {
    console.error("[Sidebar] Failed to load LLM data:", err);
    llmStatusIndicator.className = "status-indicator disconnected";
    llmStatusText.className = "status-text disconnected";
    llmStatusText.textContent = "Offline";
    configuredModelsEl.innerHTML = '<div class="no-models">Bridge not connected</div>';
  }
}
function renderConfiguredModels(models) {
  configuredModelsEl.innerHTML = "";
  if (models.length === 0) {
    configuredModelsEl.innerHTML = '<div class="no-models">No models configured. Add one below.</div>';
    return;
  }
  for (const model of models) {
    const el = document.createElement("div");
    el.className = `configured-model ${model.is_default ? "is-default" : ""}`;
    el.innerHTML = `
      <div class="configured-model-info">
        <div class="configured-model-name">
          ${model.name}
          ${model.is_default ? '<span class="badge badge-success">Default</span>' : ""}
        </div>
        <div class="configured-model-id">${model.model_id}</div>
      </div>
      <div class="configured-model-actions">
        <button class="btn btn-ghost btn-sm test-model-btn" data-model="${model.model_id}" title="Test connection">\u26A1</button>
        ${!model.is_default ? `<button class="btn btn-ghost btn-sm set-default-model-btn" data-name="${model.name}" title="Set as default">\u2605</button>` : ""}
        <button class="btn btn-ghost btn-sm remove-model-btn" data-name="${model.name}" title="Remove">\u2715</button>
      </div>
    `;
    configuredModelsEl.appendChild(el);
  }
  configuredModelsEl.querySelectorAll(".test-model-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const modelId = btn.dataset.model;
      if (!modelId) return;
      const originalText = btn.textContent;
      btn.textContent = "...";
      btn.disabled = true;
      try {
        const result = await browserAPI.runtime.sendMessage({
          type: "llm_test_model",
          model: modelId
        });
        if (result.ok) {
          showToast(`\u2713 Model works! Response: "${result.response?.slice(0, 50)}..."`, "success");
        } else {
          showToast(`\u2717 Test failed: ${result.error}`, "error");
        }
      } catch (err) {
        showToast(`\u2717 Test failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      } finally {
        btn.textContent = originalText;
        btn.disabled = false;
      }
    });
  });
  configuredModelsEl.querySelectorAll(".set-default-model-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.name;
      if (!name) return;
      await browserAPI.runtime.sendMessage({ type: "llm_set_configured_model_default", name });
      await loadLlmProviders();
    });
  });
  configuredModelsEl.querySelectorAll(".remove-model-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.name;
      if (!name) return;
      await browserAPI.runtime.sendMessage({ type: "llm_remove_configured_model", name });
      await loadLlmProviders();
      showToast(`Removed "${name}"`);
    });
  });
}
function renderAvailableModelsDropdown(models, configured) {
  const configuredIds = new Set(configured.map((c) => c.model_id));
  availableModelsSelect.innerHTML = '<option value="">Select a model to add...</option>';
  const available = models.filter((m) => !configuredIds.has(m.id));
  if (available.length === 0) {
    availableModelsSelect.innerHTML = '<option value="">No more models available</option>';
    addModelBtn.disabled = true;
    return;
  }
  for (const model of available) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.id;
    availableModelsSelect.appendChild(option);
  }
}
function renderProviders(providers) {
  detectedProvidersEl.innerHTML = "";
  const localProviders = providers.filter((p) => p.is_local);
  const cloudProviders = providers.filter((p) => !p.is_local);
  for (const provider of [...localProviders, ...cloudProviders]) {
    const isAvailable = provider.available || provider.is_local && provider.configured;
    const needsConfig = !provider.is_local && !provider.has_api_key;
    const el = document.createElement("div");
    el.className = `detected-provider ${isAvailable ? "available" : needsConfig ? "needs-config" : "unavailable"}`;
    let statusText = "";
    let statusClass = "";
    if (isAvailable) {
      statusText = "\u25CF Running";
      statusClass = "available";
    } else if (provider.is_local) {
      statusText = "\u25CB Not detected";
      statusClass = "unavailable";
    } else if (needsConfig) {
      statusText = "\u25CB Needs API key";
      statusClass = "needs-config";
    } else {
      statusText = "\u25CF Ready";
      statusClass = "available";
    }
    let actionHtml = "";
    if (needsConfig) {
      actionHtml = `<button class="btn btn-secondary btn-sm configure-provider-btn" data-provider="${provider.type}">Configure</button>`;
    }
    el.innerHTML = `
      <div class="detected-provider-info">
        <div class="detected-provider-name">${provider.name}</div>
        <div class="detected-provider-status ${statusClass}">${statusText}</div>
      </div>
      <div class="detected-provider-action">${actionHtml}</div>
    `;
    detectedProvidersEl.appendChild(el);
  }
  detectedProvidersEl.querySelectorAll(".configure-provider-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const providerType = btn.dataset.provider;
      if (providerType) showApiKeyConfig(providerType);
    });
  });
}
availableModelsSelect.addEventListener("change", () => {
  addModelBtn.disabled = !availableModelsSelect.value;
});
addModelBtn.addEventListener("click", async () => {
  const modelId = availableModelsSelect.value;
  if (!modelId) return;
  addModelBtn.disabled = true;
  try {
    const response = await browserAPI.runtime.sendMessage({
      type: "llm_add_configured_model",
      model_id: modelId
    });
    if (response.ok) {
      showToast(`Added "${response.name}"`);
      await loadLlmProviders();
    } else {
      showToast("Failed to add model");
    }
  } catch (err) {
    showToast("Failed to add model");
  }
  addModelBtn.disabled = false;
});
loadLlmProviders().catch((error) => {
  console.error("Failed to load LLM providers", error);
});
var permissionsPanelHeader = document.getElementById("permissions-panel-header");
var permissionsPanelToggle = document.getElementById("permissions-panel-toggle");
var permissionsList = document.getElementById("permissions-list");
var refreshPermissionsBtn = document.getElementById("refresh-permissions-btn");
async function loadPermissions() {
  try {
    const response = await browserAPI.runtime.sendMessage({ type: "list_all_permissions" });
    if (response?.permissions) {
      renderPermissions(response.permissions);
    }
  } catch (err) {
    console.error("[Sidebar] Failed to load permissions:", err);
    permissionsList.innerHTML = '<div class="empty-state">Failed to load permissions.</div>';
  }
}
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
function renderPermissions(permissions) {
  if (permissions.length === 0) {
    permissionsList.innerHTML = '<div class="empty-state">No site permissions granted yet.</div>';
    return;
  }
  permissionsList.innerHTML = permissions.map((perm) => {
    const grantedScopes = Object.entries(perm.scopes).filter(([, status]) => status === "granted-always" || status === "granted-once").map(([scope, status]) => ({ scope, status }));
    const deniedScopes = Object.entries(perm.scopes).filter(([, status]) => status === "denied").map(([scope]) => scope);
    const scopeBadges = [
      ...grantedScopes.map(({ scope, status }) => {
        const label = scope.split(":")[1] || scope;
        const isOnce = status === "granted-once";
        const badgeClass = isOnce ? "permission-scope-badge temporary" : "permission-scope-badge";
        const suffix = isOnce ? ' <span class="permission-temp-label">\u23F1</span>' : "";
        return `<span class="${badgeClass}">${escapeHtml(label)}${suffix}</span>`;
      }),
      ...deniedScopes.map((scope) => {
        const label = scope.split(":")[1] || scope;
        return `<span class="permission-scope-badge denied">${escapeHtml(label)} \u2715</span>`;
      })
    ].join("");
    let toolsHtml = "";
    if (perm.allowedTools && perm.allowedTools.length > 0) {
      const toolBadges = perm.allowedTools.map((tool) => {
        const toolName = tool.split("/")[1] || tool;
        return `<span class="permission-tool-badge">${escapeHtml(toolName)}</span>`;
      }).join("");
      toolsHtml = `
        <div class="permission-tools-section">
          <div class="permission-tools-title">Allowed Tools</div>
          <div class="permission-tools-list">${toolBadges}</div>
        </div>
      `;
    }
    const sourceLabel = perm.source === "web-agents-api" ? "Web Agents API" : "Harbor";
    const sourceBadge = `<span class="permission-source-badge ${perm.source || "harbor"}">${escapeHtml(sourceLabel)}</span>`;
    return `
      <div class="permission-origin-item" data-origin="${escapeHtml(perm.origin)}">
        <div class="permission-origin-header">
          <span class="permission-origin-name">${escapeHtml(perm.origin)}</span>
          ${sourceBadge}
        </div>
        <div class="permission-scopes">
          ${scopeBadges || '<span style="color: var(--color-text-muted); font-size: 11px;">No scopes</span>'}
        </div>
        ${toolsHtml}
        <div class="permission-actions">
          <button class="btn btn-sm btn-danger revoke-permissions-btn" data-origin="${escapeHtml(perm.origin)}" data-source="${escapeHtml(perm.source || "harbor")}">Revoke All</button>
        </div>
      </div>
    `;
  }).join("");
  permissionsList.querySelectorAll(".revoke-permissions-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const origin = btn.dataset.origin;
      const source = btn.dataset.source;
      if (!confirm(`Revoke all permissions for ${origin}?`)) return;
      try {
        await browserAPI.runtime.sendMessage({ type: "revoke_origin_permissions", origin, source });
        await loadPermissions();
        showToast("Permissions revoked");
      } catch (err) {
        console.error("[Sidebar] Failed to revoke permissions:", err);
        showToast("Failed to revoke permissions", "error");
      }
    });
  });
}
setupPanelToggle(permissionsPanelHeader, permissionsPanelToggle, permissionsList);
refreshPermissionsBtn?.addEventListener("click", async (e) => {
  e.stopPropagation();
  refreshPermissionsBtn.disabled = true;
  await loadPermissions();
  refreshPermissionsBtn.disabled = false;
});
browserAPI.runtime.onMessage.addListener((message) => {
  if (message?.type === "permissions_changed") {
    loadPermissions();
  }
  return false;
});
loadPermissions();
var oauthProviderConfigs = [
  {
    id: "google",
    name: "Google",
    icon: "\u{1F535}",
    helpUrl: "https://console.cloud.google.com/apis/credentials"
  },
  {
    id: "github",
    name: "GitHub",
    icon: "\u26AB",
    helpUrl: "https://github.com/settings/developers"
  }
];
async function loadOAuthCredentialsStatus() {
  try {
    const response = await browserAPI.runtime.sendMessage({ type: "oauth_get_credentials_status" });
    if (response?.ok && response.providers) {
      renderOAuthProviders(response.providers);
      const configuredCount = Object.values(response.providers).filter((p) => p.configured).length;
      if (configuredCount > 0) {
        oauthStatusIndicator.className = "status-indicator connected";
        oauthStatusText.className = "status-text connected";
        oauthStatusText.textContent = `${configuredCount} configured`;
      } else {
        oauthStatusIndicator.className = "status-indicator disconnected";
        oauthStatusText.className = "status-text disconnected";
        oauthStatusText.textContent = "Not configured";
      }
    } else {
      oauthProvidersList.innerHTML = '<div class="no-providers">Waiting for bridge...</div>';
      oauthStatusIndicator.className = "status-indicator connecting";
      oauthStatusText.className = "status-text connecting";
      oauthStatusText.textContent = "Loading...";
    }
  } catch (err) {
    console.error("[Sidebar] Failed to load OAuth credentials status:", err);
    oauthProvidersList.innerHTML = '<div class="no-providers">Failed to load</div>';
    oauthStatusIndicator.className = "status-indicator disconnected";
    oauthStatusText.className = "status-text disconnected";
    oauthStatusText.textContent = "Error";
  }
}
function renderOAuthProviders(providers) {
  oauthProvidersList.innerHTML = "";
  for (const config of oauthProviderConfigs) {
    const status = providers[config.id];
    const isConfigured = status?.configured ?? false;
    const el = document.createElement("div");
    el.className = `detected-provider ${isConfigured ? "available" : "needs-config"}`;
    const statusText = isConfigured ? `\u2713 Configured${status?.client_id_preview ? ` (${status.client_id_preview})` : ""}` : "\u25CB Not configured";
    const statusClass = isConfigured ? "available" : "needs-config";
    const actionHtml = isConfigured ? `<button class="btn btn-ghost btn-sm oauth-remove-btn" data-provider="${config.id}" title="Remove credentials">\u2715</button>` : `<button class="btn btn-secondary btn-sm oauth-configure-btn" data-provider="${config.id}">Configure</button>`;
    el.innerHTML = `
      <div class="detected-provider-info">
        <div class="detected-provider-name">${config.icon} ${config.name}</div>
        <div class="detected-provider-status ${statusClass}">${statusText}</div>
      </div>
      <div class="detected-provider-action">${actionHtml}</div>
    `;
    oauthProvidersList.appendChild(el);
  }
  oauthProvidersList.querySelectorAll(".oauth-configure-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const provider = btn.dataset.provider;
      if (provider) showOAuthConfigForm(provider);
    });
  });
  oauthProvidersList.querySelectorAll(".oauth-remove-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const provider = btn.dataset.provider;
      if (!provider) return;
      if (!confirm(`Remove ${provider} OAuth credentials?`)) return;
      btn.disabled = true;
      try {
        const response = await browserAPI.runtime.sendMessage({
          type: "oauth_remove_credentials",
          provider
        });
        if (response.ok) {
          showToast(`Removed ${provider} credentials`);
          await loadOAuthCredentialsStatus();
        } else {
          showToast(`Failed: ${response.error}`, "error");
        }
      } catch (err) {
        showToast("Failed to remove credentials", "error");
      }
      btn.disabled = false;
    });
  });
}
function showOAuthConfigForm(provider) {
  configuringOAuthProvider = provider;
  const config = oauthProviderConfigs.find((p) => p.id === provider);
  const displayName = config?.name ?? provider;
  oauthConfigProviderName.textContent = `Configure ${displayName}`;
  oauthHelpLink.href = config?.helpUrl ?? "#";
  oauthClientIdInput.value = "";
  oauthClientSecretInput.value = "";
  oauthConfigForm.style.display = "block";
  oauthClientIdInput.focus();
}
function hideOAuthConfigForm() {
  configuringOAuthProvider = null;
  oauthConfigForm.style.display = "none";
  oauthClientIdInput.value = "";
  oauthClientSecretInput.value = "";
}
oauthConfigSaveBtn?.addEventListener("click", async () => {
  if (!configuringOAuthProvider) return;
  const clientId = oauthClientIdInput.value.trim();
  const clientSecret = oauthClientSecretInput.value.trim();
  if (!clientId || !clientSecret) {
    showToast("Please enter both Client ID and Client Secret", "error");
    return;
  }
  oauthConfigSaveBtn.disabled = true;
  oauthConfigSaveBtn.textContent = "Saving...";
  try {
    const response = await browserAPI.runtime.sendMessage({
      type: "oauth_set_credentials",
      provider: configuringOAuthProvider,
      client_id: clientId,
      client_secret: clientSecret
    });
    if (response.ok) {
      showToast(`${configuringOAuthProvider} credentials saved!`, "success");
      hideOAuthConfigForm();
      await loadOAuthCredentialsStatus();
    } else {
      showToast(`Failed: ${response.error}`, "error");
    }
  } catch (err) {
    showToast("Failed to save credentials", "error");
    console.error("Failed to save OAuth credentials:", err);
  }
  oauthConfigSaveBtn.disabled = false;
  oauthConfigSaveBtn.textContent = "Save";
});
oauthConfigCancelBtn?.addEventListener("click", hideOAuthConfigForm);
setupPanelToggle(oauthPanelHeader, oauthPanelToggle, oauthPanelBody);
(async function loadOAuthWithRetry() {
  const maxRetries = 10;
  const retryDelay = 1e3;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await browserAPI.runtime.sendMessage({ type: "oauth_get_credentials_status" });
      if (response?.ok && response.providers) {
        renderOAuthProviders(response.providers);
        const configuredCount = Object.values(response.providers).filter((p) => p.configured).length;
        if (configuredCount > 0) {
          oauthStatusIndicator.className = "status-indicator connected";
          oauthStatusText.className = "status-text connected";
          oauthStatusText.textContent = `${configuredCount} configured`;
        } else {
          oauthStatusIndicator.className = "status-indicator disconnected";
          oauthStatusText.className = "status-text disconnected";
          oauthStatusText.textContent = "Not configured";
        }
        return;
      }
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelay));
  }
  console.warn("[Sidebar] Failed to load OAuth status after retries");
})();
var quickActionsHeader = document.getElementById("quick-actions-header");
var quickActionsToggle = document.getElementById("quick-actions-toggle");
var quickActionsBody = document.getElementById("quick-actions-body");
var openDirectoryBtn = document.getElementById("open-directory-btn");
var openChatBtn = document.getElementById("open-chat-btn");
var reloadExtensionBtn = document.getElementById("reload-extension-btn");
setupPanelToggle(quickActionsHeader, quickActionsToggle, quickActionsBody);
openDirectoryBtn.addEventListener("click", async () => {
  try {
    const directoryUrl = browserAPI.runtime.getURL("dist/directory.html");
    console.log("[Sidebar] Opening directory at:", directoryUrl);
    await browserAPI.tabs.create({ url: directoryUrl });
  } catch (err) {
    console.error("[Sidebar] Failed to open directory:", err);
    showToast("Failed to open directory");
  }
});
openChatBtn.addEventListener("click", async () => {
  try {
    const chatUrl = browserAPI.runtime.getURL("demo/chat-poc/index.html");
    console.log("[Sidebar] Opening chat at:", chatUrl);
    await browserAPI.tabs.create({ url: chatUrl });
  } catch (err) {
    console.error("[Sidebar] Failed to open chat:", err);
    showToast("Failed to open chat");
  }
});
reloadExtensionBtn.addEventListener("click", async () => {
  try {
    await browserAPI.runtime.reload();
  } catch (err) {
    console.error("[Sidebar] Failed to reload:", err);
    showToast("Failed to reload extension");
  }
});
var toolTesterHeader = document.getElementById("tool-tester-header");
var toolTesterToggle = document.getElementById("tool-tester-toggle");
var toolTesterBody = document.getElementById("tool-tester-body");
var toolTesterServerSelect = document.getElementById("tool-tester-server");
var toolTesterToolSelect = document.getElementById("tool-tester-tool");
var toolTesterSchemaDiv = document.getElementById("tool-tester-schema");
var toolTesterArgsInput = document.getElementById("tool-tester-args");
var toolTesterHint = document.getElementById("tool-tester-hint");
var toolTesterRunBtn = document.getElementById("tool-tester-run");
var toolTesterResultDiv = document.getElementById("tool-tester-result");
var toolTesterOutput = document.getElementById("tool-tester-output");
var cachedServersWithTools = [];
setupPanelToggle(toolTesterHeader, toolTesterToggle, toolTesterBody);
async function loadToolTesterServers() {
  try {
    const response = await browserAPI.runtime.sendMessage({ type: "sidebar_get_servers" });
    console.log("[Tool Tester] Got servers response:", response);
    if (!response?.ok) return;
    cachedServersWithTools = response.servers;
    console.log("[Tool Tester] Servers:", cachedServersWithTools.map((s) => ({
      id: s.id,
      name: s.name,
      running: s.running,
      toolCount: s.tools?.length
    })));
    toolTesterServerSelect.innerHTML = '<option value="">Select a server...</option>';
    for (const server of cachedServersWithTools) {
      if (server.running) {
        const option = document.createElement("option");
        option.value = server.id;
        const toolCount = server.tools?.length || 0;
        option.textContent = `${server.name} (${toolCount} tools)`;
        toolTesterServerSelect.appendChild(option);
      }
    }
  } catch (err) {
    console.error("[Sidebar] Failed to load servers for tool tester:", err);
  }
}
toolTesterServerSelect.addEventListener("change", async () => {
  const serverId = toolTesterServerSelect.value;
  toolTesterToolSelect.innerHTML = '<option value="">Loading tools...</option>';
  toolTesterToolSelect.disabled = true;
  toolTesterSchemaDiv.style.display = "none";
  toolTesterRunBtn.disabled = true;
  toolTesterResultDiv.style.display = "none";
  if (!serverId) {
    toolTesterToolSelect.innerHTML = '<option value="">Select a tool...</option>';
    return;
  }
  let server = cachedServersWithTools.find((s) => s.id === serverId);
  let tools = server?.tools || [];
  if (tools.length === 0) {
    console.log("[Tool Tester] No cached tools, fetching via MCP...");
    try {
      const listResponse = await browserAPI.runtime.sendMessage({
        type: "mcp_call_method",
        serverId,
        method: "tools/list"
      });
      console.log("[Tool Tester] tools/list response:", listResponse);
      if (listResponse?.ok && listResponse.result?.tools) {
        tools = listResponse.result.tools;
        if (server) {
          server.tools = tools;
        }
      }
    } catch (err) {
      console.error("[Tool Tester] Failed to fetch tools:", err);
    }
  }
  toolTesterToolSelect.innerHTML = '<option value="">Select a tool...</option>';
  if (tools.length === 0) {
    toolTesterToolSelect.innerHTML = '<option value="">No tools available</option>';
    return;
  }
  toolTesterToolSelect.disabled = false;
  for (const tool of tools) {
    const option = document.createElement("option");
    option.value = tool.name;
    option.textContent = tool.name;
    toolTesterToolSelect.appendChild(option);
  }
});
toolTesterToolSelect.addEventListener("change", () => {
  const serverId = toolTesterServerSelect.value;
  const toolName = toolTesterToolSelect.value;
  toolTesterSchemaDiv.style.display = "none";
  toolTesterRunBtn.disabled = true;
  toolTesterResultDiv.style.display = "none";
  if (!serverId || !toolName) return;
  const server = cachedServersWithTools.find((s) => s.id === serverId);
  const tool = server?.tools?.find((t) => t.name === toolName);
  if (!tool) return;
  toolTesterSchemaDiv.style.display = "block";
  toolTesterRunBtn.disabled = false;
  let hint = tool.description || "No description";
  if (tool.inputSchema) {
    const schema = tool.inputSchema;
    const required = schema.required || [];
    const props = schema.properties || {};
    const propHints = Object.entries(props).map(([key, val]) => {
      const req = required.includes(key) ? " (required)" : "";
      return `\u2022 ${key}: ${val.type || "any"}${req}${val.description ? " - " + val.description : ""}`;
    });
    if (propHints.length > 0) {
      hint += "\n\nParameters:\n" + propHints.join("\n");
    }
  }
  toolTesterHint.textContent = hint;
  toolTesterHint.style.whiteSpace = "pre-wrap";
  if (tool.inputSchema) {
    const schema = tool.inputSchema;
    const props = schema.properties || {};
    const example = {};
    for (const key of Object.keys(props)) {
      example[key] = "";
    }
    toolTesterArgsInput.value = JSON.stringify(example, null, 2);
  } else {
    toolTesterArgsInput.value = "{}";
  }
});
toolTesterRunBtn.addEventListener("click", async () => {
  const serverId = toolTesterServerSelect.value;
  const toolName = toolTesterToolSelect.value;
  if (!serverId || !toolName) return;
  let args = {};
  try {
    const argsText = toolTesterArgsInput.value.trim();
    if (argsText) {
      args = JSON.parse(argsText);
    }
  } catch (err) {
    showToast("Invalid JSON in arguments", "error");
    return;
  }
  toolTesterRunBtn.disabled = true;
  toolTesterRunBtn.textContent = "Running...";
  toolTesterResultDiv.style.display = "block";
  toolTesterOutput.textContent = "Executing...";
  try {
    console.log(`[Tool Tester] Calling ${serverId}/${toolName} with:`, args);
    const response = await browserAPI.runtime.sendMessage({
      type: "sidebar_call_tool",
      serverId,
      toolName,
      args
    });
    console.log("[Tool Tester] Response:", response);
    if (response?.ok) {
      toolTesterOutput.textContent = JSON.stringify(response.result, null, 2);
    } else {
      toolTesterOutput.textContent = `Error: ${response?.error || "Unknown error"}`;
    }
  } catch (err) {
    console.error("[Tool Tester] Error:", err);
    toolTesterOutput.textContent = `Exception: ${err instanceof Error ? err.message : String(err)}`;
  }
  toolTesterRunBtn.disabled = false;
  toolTesterRunBtn.textContent = "Run Tool";
});
toolTesterHeader.addEventListener("click", () => {
  setTimeout(() => {
    if (!toolTesterBody.classList.contains("collapsed")) {
      loadToolTesterServers();
    }
  }, 50);
});
var sessionsPanelHeader = document.getElementById("sessions-panel-header");
var sessionsPanelToggle = document.getElementById("sessions-panel-toggle");
var sessionsList = document.getElementById("sessions-list");
var sessionsStatusIndicator = document.getElementById("sessions-status-indicator");
var sessionsCount = document.getElementById("sessions-count");
var refreshSessionsBtn = document.getElementById("refresh-sessions-btn");
async function loadSessions() {
  try {
    const response = await browserAPI.runtime.sendMessage({ type: "session.list" });
    if (response?.ok && response.sessions) {
      renderSessions(response.sessions);
      const activeCount = response.sessions.filter((s) => s.status === "active").length;
      if (activeCount > 0) {
        sessionsStatusIndicator.className = "status-indicator connected";
        sessionsCount.className = "status-text connected";
        sessionsCount.textContent = String(activeCount);
      } else {
        sessionsStatusIndicator.className = "status-indicator disconnected";
        sessionsCount.className = "status-text disconnected";
        sessionsCount.textContent = "0";
      }
    } else {
      sessionsList.innerHTML = '<div class="empty-state">Failed to load sessions.</div>';
    }
  } catch (err) {
    console.error("[Sidebar] Failed to load sessions:", err);
    sessionsList.innerHTML = '<div class="empty-state">Failed to load sessions.</div>';
  }
}
function formatRelativeTime(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;
  if (diff < 6e4) return "just now";
  if (diff < 36e5) return `${Math.floor(diff / 6e4)}m ago`;
  if (diff < 864e5) return `${Math.floor(diff / 36e5)}h ago`;
  return `${Math.floor(diff / 864e5)}d ago`;
}
function renderSessions(sessions) {
  if (sessions.length === 0) {
    sessionsList.innerHTML = '<div class="empty-state">No active sessions.</div>';
    return;
  }
  const sorted = [...sessions].sort((a, b) => {
    if (a.status === "active" && b.status !== "active") return -1;
    if (a.status !== "active" && b.status === "active") return 1;
    return b.lastActiveAt - a.lastActiveAt;
  });
  sessionsList.innerHTML = sorted.map((session) => {
    const typeClass = session.type === "explicit" ? "explicit" : "implicit";
    const statusClass = session.status === "terminated" ? "terminated" : "";
    const displayName = session.name || (session.type === "implicit" ? "Anonymous Session" : "Agent Session");
    const capBadges = [];
    if (session.capabilities.hasLLM) {
      capBadges.push('<span class="session-cap-badge llm">LLM</span>');
    }
    if (session.capabilities.toolCount > 0) {
      capBadges.push(`<span class="session-cap-badge tools">${session.capabilities.toolCount} Tools</span>`);
    }
    if (session.capabilities.hasBrowserAccess) {
      capBadges.push('<span class="session-cap-badge browser">Browser</span>');
    }
    const originDisplay = session.origin.length > 40 ? session.origin.slice(0, 37) + "..." : session.origin;
    return `
      <div class="session-item ${typeClass} ${statusClass}" data-session-id="${session.sessionId}">
        <div class="session-header">
          <div class="session-name">
            ${escapeHtml(displayName)}
            <span class="session-type-badge ${typeClass}">${session.type}</span>
          </div>
          <span class="session-time">${formatRelativeTime(session.lastActiveAt)}</span>
        </div>
        <div class="session-origin" title="${escapeHtml(session.origin)}">${escapeHtml(originDisplay)}</div>
        <div class="session-capabilities">
          ${capBadges.length > 0 ? capBadges.join("") : '<span style="color: var(--color-text-muted); font-size: 10px;">No capabilities</span>'}
        </div>
        <div class="session-stats">
          <span class="session-stat">\u{1F4AC} ${session.usage.promptCount} prompts</span>
          <span class="session-stat">\u26A1 ${session.usage.toolCallCount} tool calls</span>
        </div>
        ${session.status === "active" ? `
          <div class="session-actions">
            <button class="btn btn-sm btn-danger terminate-session-btn" data-session-id="${session.sessionId}" data-origin="${escapeHtml(session.origin)}">Terminate</button>
          </div>
        ` : `
          <div class="session-actions">
            <span style="font-size: var(--text-xs); color: var(--color-text-muted);">Session ${session.status}</span>
          </div>
        `}
      </div>
    `;
  }).join("");
  sessionsList.querySelectorAll(".terminate-session-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const sessionId = btn.dataset.sessionId;
      const origin = btn.dataset.origin;
      btn.disabled = true;
      btn.textContent = "...";
      try {
        await browserAPI.runtime.sendMessage({
          type: "session.terminate",
          sessionId,
          origin
        });
        await loadSessions();
        showToast("Session terminated");
      } catch (err) {
        console.error("[Sidebar] Failed to terminate session:", err);
        showToast("Failed to terminate session", "error");
      }
    });
  });
}
setupPanelToggle(sessionsPanelHeader, sessionsPanelToggle, sessionsList);
refreshSessionsBtn?.addEventListener("click", async (e) => {
  e.stopPropagation();
  refreshSessionsBtn.disabled = true;
  await loadSessions();
  refreshSessionsBtn.disabled = false;
});
browserAPI.runtime.onMessage.addListener((message) => {
  if (message?.type === "session_created" || message?.type === "session_terminated" || message?.type === "session_updated") {
    loadSessions();
  }
  return false;
});
loadSessions();
setInterval(loadSessions, 3e4);
//# sourceMappingURL=sidebar.js.map
