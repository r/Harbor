// src/sidebar.ts
var refreshBtn = document.getElementById("refresh-btn");
var themeToggle = document.getElementById("theme-toggle");
var harborStatus = document.getElementById("harbor-status");
var harborStatusIndicator = document.getElementById("harbor-status-indicator");
var harborStatusText = document.getElementById("harbor-status-text");
var harborInstallHint = document.getElementById("harbor-install-hint");
var currentSiteOrigin = document.getElementById("current-site-origin");
var currentSitePermissions = document.getElementById("current-site-permissions");
var flagTextGeneration = document.getElementById("flag-textGeneration");
var flagToolCalling = document.getElementById("flag-toolCalling");
var flagToolAccess = document.getElementById("flag-toolAccess");
var flagBrowserInteraction = document.getElementById("flag-browserInteraction");
var flagBrowserControl = document.getElementById("flag-browserControl");
var flagMultiAgent = document.getElementById("flag-multiAgent");
var featureFlagReloadHint = document.getElementById("feature-flag-reload-hint");
var apiTogglesHeader = document.getElementById("api-toggles-header");
var apiTogglesToggle = document.getElementById("api-toggles-toggle");
var apiTogglesBody = document.getElementById("api-toggles-body");
var permissionsHeader = document.getElementById("permissions-header");
var permissionsToggle = document.getElementById("permissions-toggle");
var permissionsBody = document.getElementById("permissions-body");
var permissionsList = document.getElementById("permissions-list");
var revokeAllBtn = document.getElementById("revoke-all-btn");
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
  const icons = { light: "\u2600\uFE0F", dark: "\u{1F319}", system: "\u{1F5A5}\uFE0F" };
  themeToggle.textContent = icons[theme];
  themeToggle.title = `Theme: ${theme} (click to change)`;
}
function initTheme() {
  const isSafariBrowser = typeof browser !== "undefined" && navigator.userAgent.includes("Safari") && !navigator.userAgent.includes("Chrome");
  if (isSafariBrowser) {
    if (themeToggle) themeToggle.style.display = "none";
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
function showToast(message, type = "info", duration = 3e3) {
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();
  const toast = document.createElement("div");
  toast.className = `toast ${type !== "info" ? type : ""}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}
function setupPanelToggle(header, toggle, body) {
  header.addEventListener("click", () => {
    const isCollapsed = body.classList.contains("collapsed");
    body.classList.toggle("collapsed", !isCollapsed);
    toggle.classList.toggle("collapsed", !isCollapsed);
  });
}
async function checkHarborConnection() {
  harborStatusText.textContent = "Checking connection...";
  harborStatusIndicator.className = "status-indicator connecting";
  harborStatus.className = "harbor-status";
  try {
    const response = await chrome.runtime.sendMessage({ type: "checkHarborConnection" });
    if (response?.connected) {
      harborStatusIndicator.className = "status-indicator connected";
      harborStatusText.className = "harbor-status-text connected";
      harborStatusText.textContent = "Connected";
      harborStatus.className = "harbor-status connected";
      harborInstallHint.style.display = "none";
    } else {
      harborStatusIndicator.className = "status-indicator disconnected";
      harborStatusText.className = "harbor-status-text disconnected";
      harborStatusText.textContent = "Not connected";
      harborStatus.className = "harbor-status disconnected";
      harborInstallHint.style.display = "block";
    }
  } catch (error) {
    harborStatusIndicator.className = "status-indicator disconnected";
    harborStatusText.className = "harbor-status-text disconnected";
    harborStatusText.textContent = "Error checking connection";
    harborStatus.className = "harbor-status disconnected";
    harborInstallHint.style.display = "block";
  }
}
var DEFAULT_FLAGS = {
  textGeneration: true,
  toolCalling: false,
  toolAccess: true,
  browserInteraction: false,
  browserControl: false,
  multiAgent: false
};
var STORAGE_KEY = "web-agents-api-flags";
async function loadFeatureFlags() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return { ...DEFAULT_FLAGS, ...result[STORAGE_KEY] || {} };
}
async function saveFeatureFlags(flags) {
  await chrome.storage.local.set({ [STORAGE_KEY]: flags });
}
async function initFeatureFlags() {
  const flags = await loadFeatureFlags();
  flagTextGeneration.checked = flags.textGeneration;
  flagToolCalling.checked = flags.toolCalling;
  flagToolAccess.checked = flags.toolAccess;
  flagBrowserInteraction.checked = flags.browserInteraction;
  flagBrowserControl.checked = flags.browserControl;
  flagMultiAgent.checked = flags.multiAgent;
}
function setupFeatureFlagListeners() {
  const inputs = [
    { el: flagTextGeneration, key: "textGeneration" },
    { el: flagToolCalling, key: "toolCalling" },
    { el: flagToolAccess, key: "toolAccess" },
    { el: flagBrowserInteraction, key: "browserInteraction" },
    { el: flagBrowserControl, key: "browserControl" },
    { el: flagMultiAgent, key: "multiAgent" }
  ];
  for (const { el, key } of inputs) {
    el.addEventListener("change", async () => {
      const flags = await loadFeatureFlags();
      flags[key] = el.checked;
      await saveFeatureFlags(flags);
      featureFlagReloadHint.classList.add("visible");
      showToast(`${key} ${el.checked ? "enabled" : "disabled"}`, "success");
    });
  }
}
var currentOrigin = null;
async function updateCurrentSite() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) {
      const url = new URL(tab.url);
      currentOrigin = url.origin;
      currentSiteOrigin.textContent = currentOrigin;
      await updateCurrentSitePermissions();
    } else {
      currentOrigin = null;
      currentSiteOrigin.textContent = "\u2014";
      currentSitePermissions.innerHTML = '<div class="current-site-no-permissions">No active tab</div>';
    }
  } catch (error) {
    currentOrigin = null;
    currentSiteOrigin.textContent = "\u2014";
    currentSitePermissions.innerHTML = '<div class="current-site-no-permissions">Could not get current tab</div>';
  }
}
async function updateCurrentSitePermissions() {
  if (!currentOrigin) {
    currentSitePermissions.innerHTML = '<div class="current-site-no-permissions">No active tab</div>';
    return;
  }
  try {
    const response = await chrome.runtime.sendMessage({
      type: "getPermissionsForOrigin",
      origin: currentOrigin
    });
    if (!response || !response.scopes || Object.keys(response.scopes).length === 0) {
      currentSitePermissions.innerHTML = '<div class="current-site-no-permissions">No permissions granted for this site</div>';
      return;
    }
    let html = '<div class="permission-scopes">';
    for (const [scope, grant] of Object.entries(response.scopes)) {
      if (grant === "not-granted" || grant === "denied") continue;
      const isTemp = grant === "granted-once";
      html += `<span class="permission-scope-badge ${isTemp ? "temporary" : ""}">${scope}${isTemp ? " (temp)" : ""}</span>`;
    }
    html += "</div>";
    if (response.allowedTools && response.allowedTools.length > 0) {
      html += '<div class="permission-tools">';
      html += '<div class="permission-tools-title">Allowed Tools</div>';
      html += '<div class="permission-tools-list">';
      for (const tool of response.allowedTools) {
        html += `<span class="permission-tool-badge">${tool}</span>`;
      }
      html += "</div></div>";
    }
    html += `<div class="permission-actions">
      <button class="btn btn-danger btn-sm" id="revoke-current-btn">Revoke</button>
    </div>`;
    currentSitePermissions.innerHTML = html;
    const revokeBtn = document.getElementById("revoke-current-btn");
    if (revokeBtn) {
      revokeBtn.addEventListener("click", async () => {
        await revokePermissions(currentOrigin);
        await updateCurrentSitePermissions();
        await loadAllPermissions();
        showToast("Permissions revoked", "success");
      });
    }
  } catch (error) {
    currentSitePermissions.innerHTML = '<div class="current-site-no-permissions">Error loading permissions</div>';
  }
}
async function loadAllPermissions() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "listAllPermissions" });
    const permissions = response?.permissions || [];
    if (permissions.length === 0) {
      permissionsList.innerHTML = '<div class="empty-state">No permissions granted yet</div>';
      revokeAllBtn.style.display = "none";
      return;
    }
    let html = "";
    for (const entry of permissions) {
      const grantedScopes = Object.entries(entry.scopes).filter(
        ([, grant]) => grant === "granted-once" || grant === "granted-always"
      );
      if (grantedScopes.length === 0) continue;
      const isCurrent = entry.origin === currentOrigin;
      html += `<div class="permission-item">
        <div class="permission-origin ${isCurrent ? "current" : ""}">
          ${entry.origin}
          ${isCurrent ? '<span class="current-badge">current</span>' : ""}
        </div>
        <div class="permission-scopes">`;
      for (const [scope, grant] of grantedScopes) {
        const isTemp = grant === "granted-once";
        html += `<span class="permission-scope-badge ${isTemp ? "temporary" : ""}">${scope}${isTemp ? " (temp)" : ""}</span>`;
      }
      html += "</div>";
      if (entry.allowedTools && entry.allowedTools.length > 0) {
        html += `<div class="permission-tools">
          <div class="permission-tools-title">Allowed Tools</div>
          <div class="permission-tools-list">`;
        for (const tool of entry.allowedTools) {
          html += `<span class="permission-tool-badge">${tool}</span>`;
        }
        html += "</div></div>";
      }
      html += `<div class="permission-actions">
        <button class="btn btn-danger btn-sm revoke-btn" data-origin="${entry.origin}">Revoke</button>
      </div>
      </div>`;
    }
    permissionsList.innerHTML = html || '<div class="empty-state">No permissions granted yet</div>';
    revokeAllBtn.style.display = html ? "block" : "none";
    permissionsList.querySelectorAll(".revoke-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        const origin = e.target.getAttribute("data-origin");
        if (origin) {
          await revokePermissions(origin);
          await loadAllPermissions();
          await updateCurrentSitePermissions();
          showToast("Permissions revoked", "success");
        }
      });
    });
  } catch (error) {
    permissionsList.innerHTML = '<div class="empty-state">Error loading permissions</div>';
    revokeAllBtn.style.display = "none";
  }
}
async function revokePermissions(origin) {
  await chrome.runtime.sendMessage({ type: "revokePermissions", origin });
}
async function revokeAllPermissions() {
  await chrome.runtime.sendMessage({ type: "revokeAllPermissions" });
  await loadAllPermissions();
  await updateCurrentSitePermissions();
  showToast("All permissions revoked", "success");
}
async function refresh() {
  await checkHarborConnection();
  await updateCurrentSite();
  await loadAllPermissions();
}
async function init() {
  initTheme();
  setupPanelToggle(apiTogglesHeader, apiTogglesToggle, apiTogglesBody);
  setupPanelToggle(permissionsHeader, permissionsToggle, permissionsBody);
  themeToggle.addEventListener("click", cycleTheme);
  refreshBtn.addEventListener("click", refresh);
  revokeAllBtn.addEventListener("click", revokeAllPermissions);
  await initFeatureFlags();
  setupFeatureFlagListeners();
  await refresh();
  chrome.tabs.onActivated.addListener(() => {
    updateCurrentSite();
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url) {
      updateCurrentSite();
    }
  });
}
init().catch(console.error);
//# sourceMappingURL=sidebar.js.map
