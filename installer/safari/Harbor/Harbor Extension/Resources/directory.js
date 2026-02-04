// src/browser-compat.ts
var browserAPI = typeof browser !== "undefined" ? browser : chrome;

// src/storage/package-loader.ts
function detectFormat(url, contentType) {
  const lowerUrl = url.toLowerCase();
  if (lowerUrl.endsWith(".zip") || lowerUrl.endsWith(".mcp.zip")) {
    return "zip";
  }
  if (contentType) {
    if (contentType.includes("application/zip") || contentType.includes("application/x-zip")) {
      return "zip";
    }
  }
  return "distributable";
}
async function loadFromUrl(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return { success: false, error: `Failed to fetch: ${response.status} ${response.statusText}` };
    }
    const contentType = response.headers.get("content-type") || "";
    const format = detectFormat(url, contentType);
    if (format === "zip") {
      return loadZipPackage(await response.arrayBuffer(), url);
    } else {
      return loadJsonPackage(await response.text(), url);
    }
  } catch (err) {
    return { success: false, error: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }
}
async function loadFromFile(file) {
  try {
    const format = detectFormat(file.name, file.type);
    if (format === "zip") {
      return loadZipPackage(await file.arrayBuffer(), file.name);
    } else {
      return loadJsonPackage(await file.text(), file.name);
    }
  } catch (err) {
    return { success: false, error: `File read error: ${err instanceof Error ? err.message : String(err)}` };
  }
}
async function loadJsonPackage(jsonText, sourceUrl) {
  let manifest;
  try {
    manifest = JSON.parse(jsonText);
  } catch (err) {
    return { success: false, error: "Invalid JSON" };
  }
  if (!manifest.id || !manifest.name) {
    return { success: false, error: "Missing required fields: id and name" };
  }
  if (manifest.scriptBase64 || manifest.wasmBase64 || manifest.moduleBytesBase64) {
    return {
      success: true,
      manifest,
      format: "distributable",
      sourceUrl
    };
  }
  const baseUrl = sourceUrl.substring(0, sourceUrl.lastIndexOf("/") + 1);
  if (manifest.runtime === "js" && manifest.scriptUrl) {
    const scriptFullUrl = resolveUrl(manifest.scriptUrl, baseUrl);
    const scriptResult = await fetchCode(scriptFullUrl);
    if (!scriptResult.success) {
      return { success: false, error: `Failed to load script: ${scriptResult.error}` };
    }
    manifest = {
      ...manifest,
      scriptBase64: btoa(unescape(encodeURIComponent(scriptResult.code))),
      scriptUrl: void 0
      // Remove URL since code is now embedded
    };
    return { success: true, manifest, format: "manifest-url", sourceUrl };
  }
  if (manifest.runtime === "wasm" && (manifest.moduleUrl || manifest.wasmUrl)) {
    const wasmUrl = manifest.moduleUrl || manifest.wasmUrl;
    const wasmFullUrl = resolveUrl(wasmUrl, baseUrl);
    const wasmResult = await fetchBinary(wasmFullUrl);
    if (!wasmResult.success) {
      return { success: false, error: `Failed to load WASM: ${wasmResult.error}` };
    }
    manifest = {
      ...manifest,
      wasmBase64: arrayBufferToBase64(wasmResult.data),
      moduleUrl: void 0,
      wasmUrl: void 0
    };
    return { success: true, manifest, format: "manifest-url", sourceUrl };
  }
  return { success: false, error: "No executable code found (missing scriptUrl, scriptBase64, moduleUrl, or wasmBase64)" };
}
async function loadZipPackage(data, sourceUrl) {
  try {
    const files = await extractZip(data);
    const manifestEntry = files.find(
      (f) => f.name === "manifest.json" || f.name.endsWith("/manifest.json")
    );
    if (!manifestEntry) {
      return { success: false, error: "No manifest.json found in zip" };
    }
    let manifest;
    try {
      manifest = JSON.parse(new TextDecoder().decode(manifestEntry.data));
    } catch {
      return { success: false, error: "Invalid manifest.json in zip" };
    }
    if (!manifest.id || !manifest.name) {
      return { success: false, error: "Missing required fields: id and name" };
    }
    if (manifest.runtime === "js" && manifest.scriptUrl) {
      const scriptName = manifest.scriptUrl.replace(/^\.?\//, "");
      const scriptEntry = files.find(
        (f) => f.name === scriptName || f.name.endsWith("/" + scriptName) || f.name === "server.js" || f.name.endsWith(".js")
      );
      if (!scriptEntry) {
        return { success: false, error: `Script file not found in zip: ${manifest.scriptUrl}` };
      }
      const scriptText = new TextDecoder().decode(scriptEntry.data);
      manifest = {
        ...manifest,
        scriptBase64: btoa(unescape(encodeURIComponent(scriptText))),
        scriptUrl: void 0
      };
    } else if (manifest.runtime === "wasm" && (manifest.moduleUrl || manifest.wasmUrl || manifest.entrypoint)) {
      const wasmName = (manifest.moduleUrl || manifest.wasmUrl || manifest.entrypoint || "").replace(/^\.?\//, "");
      const wasmEntry = files.find(
        (f) => f.name === wasmName || f.name.endsWith("/" + wasmName) || f.name.endsWith(".wasm")
      );
      if (!wasmEntry) {
        return { success: false, error: `WASM file not found in zip: ${wasmName}` };
      }
      manifest = {
        ...manifest,
        wasmBase64: arrayBufferToBase64(wasmEntry.data),
        moduleUrl: void 0,
        wasmUrl: void 0
      };
    } else if (!manifest.scriptBase64 && !manifest.wasmBase64 && !manifest.moduleBytesBase64) {
      return { success: false, error: "No executable code found in manifest or zip" };
    }
    return { success: true, manifest, format: "zip", sourceUrl };
  } catch (err) {
    return { success: false, error: `Zip extraction failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
async function extractZip(data) {
  const view = new DataView(data);
  const files = [];
  let offset = 0;
  const bytes = new Uint8Array(data);
  while (offset < data.byteLength - 4) {
    const sig = view.getUint32(offset, true);
    if (sig !== 67324752) {
      break;
    }
    const compressionMethod = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const uncompressedSize = view.getUint32(offset + 22, true);
    const fileNameLength = view.getUint16(offset + 26, true);
    const extraFieldLength = view.getUint16(offset + 28, true);
    const fileNameStart = offset + 30;
    const fileName = new TextDecoder().decode(bytes.slice(fileNameStart, fileNameStart + fileNameLength));
    const dataStart = fileNameStart + fileNameLength + extraFieldLength;
    const dataEnd = dataStart + compressedSize;
    const compressedData = bytes.slice(dataStart, dataEnd);
    if (!fileName.endsWith("/")) {
      let fileData;
      if (compressionMethod === 0) {
        fileData = compressedData;
      } else if (compressionMethod === 8) {
        try {
          const ds = new DecompressionStream("deflate-raw");
          const writer = ds.writable.getWriter();
          writer.write(compressedData);
          writer.close();
          const reader = ds.readable.getReader();
          const chunks = [];
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
          const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
          fileData = new Uint8Array(totalLength);
          let pos = 0;
          for (const chunk of chunks) {
            fileData.set(chunk, pos);
            pos += chunk.length;
          }
        } catch (err) {
          console.warn(`Failed to decompress ${fileName}:`, err);
          fileData = compressedData;
        }
      } else {
        console.warn(`Unknown compression method ${compressionMethod} for ${fileName}`);
        fileData = compressedData;
      }
      files.push({ name: fileName, data: fileData });
    }
    offset = dataEnd;
  }
  return files;
}
function resolveUrl(url, baseUrl) {
  if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("chrome-extension://")) {
    return url;
  }
  if (url.startsWith("./")) {
    url = url.slice(2);
  }
  return baseUrl + url;
}
async function fetchCode(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return { success: false, error: `${response.status} ${response.statusText}` };
    }
    return { success: true, code: await response.text() };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
async function fetchBinary(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return { success: false, error: `${response.status} ${response.statusText}` };
    }
    return { success: true, data: await response.arrayBuffer() };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
function arrayBufferToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// src/directory.ts
var BUNDLED_SERVERS = [
  {
    id: "time-wasm",
    name: "Time Server",
    description: "Provides tools for getting the current time and converting between timezones. A simple WASM-based MCP server.",
    version: "1.0.0",
    runtime: "wasm",
    icon: "\u{1F550}",
    tags: ["time", "datetime", "timezone", "wasm"],
    wasmUrl: "assets/mcp-time.wasm",
    tools: [
      { name: "get_current_time", description: "Get the current time in a specific timezone" },
      { name: "convert_time", description: "Convert time between timezones" }
    ]
  },
  {
    id: "echo-js",
    name: "Echo Server",
    description: "A simple demo server that echoes back input and reverses strings. Useful for testing MCP tool calls.",
    version: "1.0.0",
    runtime: "js",
    icon: "\u{1F50A}",
    tags: ["demo", "test", "echo"],
    builtIn: true,
    tools: [
      { name: "echo", description: "Echo back the input message" },
      { name: "reverse", description: "Reverse a string" }
    ]
  },
  {
    id: "gmail-harbor",
    name: "Gmail (Harbor)",
    description: "Read and send emails via Gmail API. Supports searching, reading, sending emails and managing labels. Requires Google OAuth.",
    version: "1.0.0",
    runtime: "js",
    icon: "\u{1F4E7}",
    tags: ["gmail", "email", "google", "oauth"],
    manifestUrl: "bundled/gmail-harbor/manifest.json",
    tools: [
      { name: "search_emails", description: "Search emails using Gmail query syntax" },
      { name: "read_email", description: "Read the full content of an email" },
      { name: "send_email", description: "Send a new email" },
      { name: "list_email_labels", description: "List all Gmail labels" },
      { name: "modify_email", description: "Add or remove labels from emails" },
      { name: "delete_email", description: "Permanently delete an email" }
    ],
    oauth: {
      provider: "google",
      scopes: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.send",
        "https://www.googleapis.com/auth/gmail.modify"
      ]
    }
  },
  // Example remote server (from the bring-your-chatbot demo)
  {
    id: "acme-shop-remote",
    name: "Acme Shop (Demo)",
    description: "Example remote MCP server from the bring-your-chatbot demo. Runs locally on port 3001. Search products, manage cart, and get recommendations.",
    version: "1.0.0",
    runtime: "remote",
    icon: "\u{1F6D2}",
    tags: ["demo", "remote", "shop", "sse"],
    remoteUrl: "http://localhost:3001/mcp",
    remoteTransport: "sse",
    tools: [
      { name: "search_products", description: "Search the product catalog" },
      { name: "get_product_details", description: "Get details of a product" },
      { name: "add_to_cart", description: "Add item to cart" },
      { name: "get_cart", description: "View cart contents" }
    ]
  }
];
var STORAGE_KEY = "harbor_wasm_servers";
var list = document.getElementById("list");
var themeToggle = document.getElementById("theme-toggle");
var installUrlInput = document.getElementById("install-url");
var installUrlBtn = document.getElementById("install-url-btn");
var dropZone = document.getElementById("drop-zone");
var fileInput = document.getElementById("file-input");
var installedServerIds = /* @__PURE__ */ new Set();
function renderServerCard(server) {
  const isInstalled = installedServerIds.has(server.id) || server.builtIn;
  const card = document.createElement("div");
  card.className = `server-card ${isInstalled ? "installed" : ""}`;
  card.dataset.serverId = server.id;
  const header = document.createElement("div");
  header.className = "server-card-header";
  const iconContainer = document.createElement("div");
  iconContainer.className = "server-card-icon";
  iconContainer.textContent = server.icon;
  const info = document.createElement("div");
  info.className = "server-card-info";
  const nameRow = document.createElement("div");
  nameRow.className = "server-card-name-row";
  const name = document.createElement("span");
  name.className = "server-card-name";
  name.textContent = server.name;
  const badges = document.createElement("div");
  badges.className = "server-card-badges";
  const runtimeBadge = document.createElement("span");
  const runtimeClass = server.runtime === "wasm" ? "wasm" : server.runtime === "remote" ? "remote" : "js";
  runtimeBadge.className = `badge badge-${runtimeClass}`;
  runtimeBadge.textContent = server.runtime.toUpperCase();
  badges.appendChild(runtimeBadge);
  if (server.builtIn) {
    const builtInBadge = document.createElement("span");
    builtInBadge.className = "badge badge-builtin";
    builtInBadge.textContent = "Built-in";
    badges.appendChild(builtInBadge);
  } else if (isInstalled) {
    const installedBadge = document.createElement("span");
    installedBadge.className = "badge badge-installed";
    installedBadge.textContent = "Installed";
    badges.appendChild(installedBadge);
  }
  if (server.oauth) {
    const oauthBadge = document.createElement("span");
    oauthBadge.className = "badge badge-warning";
    oauthBadge.textContent = "Requires OAuth";
    badges.appendChild(oauthBadge);
  }
  nameRow.appendChild(name);
  nameRow.appendChild(badges);
  const desc = document.createElement("div");
  desc.className = "server-card-desc";
  desc.textContent = server.description;
  info.appendChild(nameRow);
  info.appendChild(desc);
  header.appendChild(iconContainer);
  header.appendChild(info);
  const tools = document.createElement("div");
  tools.className = "server-card-tools";
  const toolsLabel = document.createElement("span");
  toolsLabel.className = "tools-label";
  toolsLabel.textContent = "Tools: ";
  tools.appendChild(toolsLabel);
  const toolsList = server.tools.map((t) => t.name).join(", ");
  const toolsText = document.createElement("span");
  toolsText.className = "tools-list";
  toolsText.textContent = toolsList;
  tools.appendChild(toolsText);
  const tags = document.createElement("div");
  tags.className = "server-card-tags";
  server.tags.forEach((tag) => {
    const tagEl = document.createElement("span");
    tagEl.className = "tag";
    tagEl.textContent = tag;
    tags.appendChild(tagEl);
  });
  const actions = document.createElement("div");
  actions.className = "server-card-actions";
  if (!server.builtIn) {
    const installBtn = document.createElement("button");
    installBtn.className = `btn ${isInstalled ? "btn-secondary" : "btn-primary"}`;
    installBtn.textContent = isInstalled ? "Uninstall" : "Install";
    installBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (isInstalled) {
        uninstallServer(server);
      } else {
        installServer(server);
      }
    });
    actions.appendChild(installBtn);
  }
  card.appendChild(header);
  card.appendChild(tools);
  card.appendChild(tags);
  card.appendChild(actions);
  return card;
}
async function loadInstalledServers() {
  try {
    const response = await browserAPI.runtime.sendMessage({ type: "sidebar_get_servers" });
    console.log("[Directory] Got servers response:", response);
    if (response?.ok && response.servers) {
      const serverIds = response.servers.map((s) => s.id);
      console.log("[Directory] Installed server IDs:", serverIds);
      installedServerIds = new Set(serverIds);
    } else {
      const result = await browserAPI.storage.local.get(STORAGE_KEY);
      const servers = result[STORAGE_KEY] || [];
      const serverIds = servers.map((s) => s.id);
      console.log("[Directory] Storage server IDs:", serverIds);
      installedServerIds = new Set(serverIds);
    }
    console.log("[Directory] Final installedServerIds:", [...installedServerIds]);
  } catch (err) {
    console.error("[Directory] Failed to load installed servers:", err);
  }
}
async function installServer(server) {
  const btn = document.querySelector(`[data-server-id="${server.id}"] .btn`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Installing...";
  }
  try {
    if (server.runtime === "remote" && server.remoteUrl) {
      const response = await browserAPI.runtime.sendMessage({
        type: "sidebar_add_remote_server",
        url: server.remoteUrl,
        name: server.name,
        transport: server.remoteTransport || "sse"
      });
      if (!response?.ok) {
        throw new Error(response?.error || "Failed to connect to remote server");
      }
      installedServerIds.add(server.id);
      showToast(`Connected to ${server.name}`, "success");
      refreshList();
      return;
    } else if (server.runtime === "wasm" && server.wasmUrl) {
      const wasmResponse = await fetch(browserAPI.runtime.getURL(server.wasmUrl));
      const wasmBytes = await wasmResponse.arrayBuffer();
      const manifest = {
        id: server.id,
        name: server.name,
        version: server.version,
        runtime: "wasm",
        entrypoint: server.wasmUrl,
        moduleBytesBase64: btoa(String.fromCharCode(...new Uint8Array(wasmBytes))),
        permissions: [],
        tools: server.tools
      };
      const response = await browserAPI.runtime.sendMessage({
        type: "sidebar_install_server",
        manifest
      });
      if (!response?.ok) {
        throw new Error(response?.error || "Failed to install server");
      }
      await browserAPI.runtime.sendMessage({
        type: "sidebar_validate_server",
        serverId: server.id
      });
    } else if (server.runtime === "js" && server.manifestUrl) {
      const manifestResponse = await fetch(browserAPI.runtime.getURL(server.manifestUrl));
      const manifest = await manifestResponse.json();
      if (manifest.oauth) {
        console.log("[Directory] Server requires OAuth:", manifest.oauth);
        if (btn) btn.textContent = "Authenticating...";
        const statusResponse = await browserAPI.runtime.sendMessage({
          type: "oauth_status",
          server_id: server.id
        });
        console.log("[Directory] Initial OAuth status:", statusResponse);
        if (!statusResponse?.ok || !statusResponse.authenticated) {
          console.log("[Directory] Starting OAuth flow...");
          const flowResponse = await browserAPI.runtime.sendMessage({
            type: "oauth_start_flow",
            provider: manifest.oauth.provider,
            server_id: server.id,
            scopes: manifest.oauth.scopes
          });
          console.log("[Directory] OAuth flow response:", flowResponse);
          if (!flowResponse?.ok) {
            throw new Error(flowResponse?.error || "Failed to start OAuth flow");
          }
          showToast("Complete sign-in in the new tab...", "info");
          console.log("[Directory] Waiting for OAuth completion...");
          const authenticated = await waitForOAuthCompletion(server.id);
          console.log("[Directory] OAuth wait result:", authenticated);
          if (!authenticated) {
            throw new Error("OAuth authentication was not completed");
          }
          showToast("Authentication successful!", "success");
        }
        if (btn) btn.textContent = "Installing...";
      }
      const scriptUrl = new URL(manifest.scriptUrl, browserAPI.runtime.getURL(server.manifestUrl)).href;
      const scriptResponse = await fetch(scriptUrl);
      const scriptText = await scriptResponse.text();
      const fullManifest = {
        ...manifest,
        id: server.id,
        runtime: "js",
        scriptBase64: btoa(unescape(encodeURIComponent(scriptText)))
      };
      const response = await browserAPI.runtime.sendMessage({
        type: "sidebar_install_server",
        manifest: fullManifest
      });
      if (!response?.ok) {
        throw new Error(response?.error || "Failed to install server");
      }
      await browserAPI.runtime.sendMessage({
        type: "sidebar_validate_server",
        serverId: server.id
      });
    }
    installedServerIds.add(server.id);
    showToast(`Installed ${server.name}`, "success");
    refreshList();
  } catch (err) {
    console.error("[Directory] Failed to install server:", err);
    showToast(`Failed to install: ${err instanceof Error ? err.message : String(err)}`, "error");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Install";
    }
  }
}
async function waitForOAuthCompletion(serverId, timeoutMs = 3e5) {
  const pollInterval = 2e3;
  const maxAttempts = timeoutMs / pollInterval;
  let attempts = 0;
  console.log(`[Directory] Starting OAuth poll for server: ${serverId}`);
  while (attempts < maxAttempts) {
    attempts++;
    try {
      const response = await browserAPI.runtime.sendMessage({
        type: "oauth_status",
        server_id: serverId
      });
      console.log(`[Directory] OAuth poll #${attempts} response:`, response);
      if (response?.ok && response.authenticated) {
        console.log("[Directory] OAuth completed successfully!");
        return true;
      }
    } catch (err) {
      console.warn("[Directory] OAuth poll error:", err);
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
  console.warn(`[Directory] OAuth polling timed out after ${attempts} attempts`);
  return false;
}
async function uninstallServer(server) {
  const btn = document.querySelector(`[data-server-id="${server.id}"] .btn`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Removing...";
  }
  try {
    const response = await browserAPI.runtime.sendMessage({
      type: "sidebar_remove_server",
      serverId: server.id
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Failed to remove server");
    }
    installedServerIds.delete(server.id);
    showToast(`Removed ${server.name}`, "success");
    refreshList();
  } catch (err) {
    console.error("[Directory] Failed to remove server:", err);
    showToast(`Failed to remove: ${err instanceof Error ? err.message : String(err)}`, "error");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Uninstall";
    }
  }
}
function showToast(message, type = "info") {
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3e3);
}
async function refreshList() {
  renderServerList();
  try {
    await loadInstalledServers();
    renderServerList();
  } catch (err) {
    console.error("[Directory] Failed to check server status:", err);
  }
}
function renderServerList() {
  list.innerHTML = "";
  if (BUNDLED_SERVERS.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `
      <div class="empty-icon">\u{1F4E6}</div>
      <div class="empty-title">No bundled servers</div>
      <div class="empty-desc">No MCP servers are bundled with this version of Harbor.</div>
    `;
    list.appendChild(empty);
    return;
  }
  BUNDLED_SERVERS.forEach((server) => {
    list.appendChild(renderServerCard(server));
  });
}
async function installFromUrl(url) {
  if (!url.trim()) {
    showToast("Please enter a URL", "error");
    return;
  }
  installUrlBtn.disabled = true;
  installUrlBtn.textContent = "Loading...";
  try {
    const result = await loadFromUrl(url);
    await handleLoadResult(result);
  } finally {
    installUrlBtn.disabled = false;
    installUrlBtn.textContent = "Install";
  }
}
async function installFromFile(file) {
  showToast(`Loading ${file.name}...`, "info");
  try {
    const result = await loadFromFile(file);
    await handleLoadResult(result);
  } catch (err) {
    showToast(`Failed to load file: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
}
async function handleLoadResult(result) {
  if (!result.success) {
    showToast(`Failed to load: ${result.error}`, "error");
    return;
  }
  const manifest = result.manifest;
  console.log("[Directory] Loaded manifest:", manifest);
  if (installedServerIds.has(manifest.id)) {
    showToast(`Server "${manifest.name}" is already installed`, "error");
    return;
  }
  if (!manifest.runtime) {
    if (manifest.scriptBase64 || manifest.scriptUrl) {
      manifest.runtime = "js";
    } else if (manifest.wasmBase64 || manifest.moduleBytesBase64 || manifest.moduleUrl) {
      manifest.runtime = "wasm";
    }
  }
  if (manifest.oauth) {
    try {
      const response = await browserAPI.runtime.sendMessage({
        type: "oauth_status",
        server_id: manifest.id
      });
      if (!response?.ok || !response.authenticated) {
        showToast(`Server "${manifest.name}" requires OAuth. Sign in first via the OAuth setup flow.`, "error");
        return;
      }
    } catch {
      showToast(`Server "${manifest.name}" requires OAuth which could not be verified.`, "error");
      return;
    }
  }
  try {
    const response = await browserAPI.runtime.sendMessage({
      type: "sidebar_install_server",
      manifest
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Failed to install server");
    }
    await browserAPI.runtime.sendMessage({
      type: "sidebar_validate_server",
      serverId: manifest.id
    });
    installedServerIds.add(manifest.id);
    showToast(`Installed ${manifest.name}`, "success");
    refreshList();
  } catch (err) {
    showToast(`Failed to install: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
}
function setupDropZone() {
  if (!dropZone || !fileInput) return;
  dropZone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) {
      installFromFile(file);
      fileInput.value = "";
    }
  });
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragging");
  });
  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("dragging");
  });
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragging");
    const file = e.dataTransfer?.files?.[0];
    if (file) {
      installFromFile(file);
    }
  });
}
function setupUrlInstall() {
  if (!installUrlBtn || !installUrlInput) return;
  installUrlBtn.addEventListener("click", () => {
    installFromUrl(installUrlInput.value);
  });
  installUrlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      installFromUrl(installUrlInput.value);
    }
  });
}
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
  if (!themeToggle) return;
  const icons = { light: "\u2600\uFE0F", dark: "\u{1F319}", system: "\u{1F5A5}\uFE0F" };
  themeToggle.textContent = icons[theme];
  themeToggle.title = `Theme: ${theme} (click to change)`;
}
function initTheme() {
  const saved = localStorage.getItem("harbor-theme");
  const theme = saved || "system";
  applyTheme(theme);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    const current = localStorage.getItem("harbor-theme");
    if (current === "system" || !current) {
      applyTheme("system");
    }
  });
  window.addEventListener("storage", (e) => {
    if (e.key === "harbor-theme" && e.newValue) {
      applyTheme(e.newValue);
    }
  });
}
function cycleTheme() {
  const current = localStorage.getItem("harbor-theme") || "system";
  const order = ["system", "light", "dark"];
  const next = order[(order.indexOf(current) + 1) % order.length];
  applyTheme(next);
}
function init() {
  console.log("[Directory] Initializing...");
  console.log("[Directory] list element:", list);
  console.log("[Directory] BUNDLED_SERVERS:", BUNDLED_SERVERS.length);
  initTheme();
  themeToggle?.addEventListener("click", cycleTheme);
  setupUrlInstall();
  setupDropZone();
  if (list) {
    refreshList().catch((error) => {
      console.error("[Directory] Failed to load directory:", error);
    });
  } else {
    console.error("[Directory] List element not found!");
  }
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
//# sourceMappingURL=directory.js.map
