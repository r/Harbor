/**
 * Web Agents API - Sidebar Script
 * 
 * Manages API feature toggles and permission visibility.
 */

export {};

// =============================================================================
// Types
// =============================================================================

interface FeatureFlags {
  textGeneration: boolean;
  toolCalling: boolean;
  toolAccess: boolean;
  browserInteraction: boolean;
  browserControl: boolean;
  multiAgent: boolean;
}

interface PermissionEntry {
  origin: string;
  scopes: Record<string, string>;
  allowedTools?: string[];
}

// =============================================================================
// DOM Elements
// =============================================================================

const refreshBtn = document.getElementById('refresh-btn') as HTMLButtonElement;
const themeToggle = document.getElementById('theme-toggle') as HTMLButtonElement;

// Harbor status elements
const harborStatus = document.getElementById('harbor-status') as HTMLDivElement;
const harborStatusIndicator = document.getElementById('harbor-status-indicator') as HTMLDivElement;
const harborStatusText = document.getElementById('harbor-status-text') as HTMLDivElement;
const harborInstallHint = document.getElementById('harbor-install-hint') as HTMLDivElement;

// Current site elements
const currentSiteOrigin = document.getElementById('current-site-origin') as HTMLDivElement;
const currentSitePermissions = document.getElementById('current-site-permissions') as HTMLDivElement;

// API toggles
const flagTextGeneration = document.getElementById('flag-textGeneration') as HTMLInputElement;
const flagToolCalling = document.getElementById('flag-toolCalling') as HTMLInputElement;
const flagToolAccess = document.getElementById('flag-toolAccess') as HTMLInputElement;
const flagBrowserInteraction = document.getElementById('flag-browserInteraction') as HTMLInputElement;
const flagBrowserControl = document.getElementById('flag-browserControl') as HTMLInputElement;
const flagMultiAgent = document.getElementById('flag-multiAgent') as HTMLInputElement;
const featureFlagReloadHint = document.getElementById('feature-flag-reload-hint') as HTMLDivElement;

// Panel toggles
const apiTogglesHeader = document.getElementById('api-toggles-header') as HTMLDivElement;
const apiTogglesToggle = document.getElementById('api-toggles-toggle') as HTMLSpanElement;
const apiTogglesBody = document.getElementById('api-toggles-body') as HTMLDivElement;
const permissionsHeader = document.getElementById('permissions-header') as HTMLDivElement;
const permissionsToggle = document.getElementById('permissions-toggle') as HTMLSpanElement;
const permissionsBody = document.getElementById('permissions-body') as HTMLDivElement;
const permissionsList = document.getElementById('permissions-list') as HTMLDivElement;
const revokeAllBtn = document.getElementById('revoke-all-btn') as HTMLButtonElement;

// =============================================================================
// Theme Management
// =============================================================================

type Theme = 'light' | 'dark' | 'system';

function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme: Theme): void {
  const effectiveTheme = theme === 'system' ? getSystemTheme() : theme;
  document.documentElement.setAttribute('data-theme', effectiveTheme);
  localStorage.setItem('web-agents-api-theme', theme);
  updateThemeToggle(theme);
}

function updateThemeToggle(theme: Theme): void {
  const icons: Record<Theme, string> = { light: '☀️', dark: '🌙', system: '🖥️' };
  themeToggle.textContent = icons[theme];
  themeToggle.title = `Theme: ${theme} (click to change)`;
}

function initTheme(): void {
  const saved = localStorage.getItem('web-agents-api-theme') as Theme | null;
  const theme = saved || 'system';
  applyTheme(theme);
  
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const current = localStorage.getItem('web-agents-api-theme') as Theme | null;
    if (current === 'system' || !current) {
      applyTheme('system');
    }
  });
}

function cycleTheme(): void {
  const current = localStorage.getItem('web-agents-api-theme') as Theme | null || 'system';
  const order: Theme[] = ['system', 'light', 'dark'];
  const next = order[(order.indexOf(current) + 1) % order.length];
  applyTheme(next);
}

// =============================================================================
// Toast Notification
// =============================================================================

function showToast(message: string, type: 'info' | 'error' | 'success' = 'info', duration = 3000): void {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast ${type !== 'info' ? type : ''}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), duration);
}

// =============================================================================
// Panel Toggle
// =============================================================================

function setupPanelToggle(header: HTMLElement, toggle: HTMLElement, body: HTMLElement): void {
  header.addEventListener('click', () => {
    const isCollapsed = body.classList.contains('collapsed');
    body.classList.toggle('collapsed', !isCollapsed);
    toggle.classList.toggle('collapsed', !isCollapsed);
  });
}

// =============================================================================
// Harbor Connection Status
// =============================================================================

async function checkHarborConnection(): Promise<void> {
  harborStatusText.textContent = 'Checking connection...';
  harborStatusIndicator.className = 'status-indicator connecting';
  harborStatus.className = 'harbor-status';
  
  try {
    const response = await chrome.runtime.sendMessage({ type: 'checkHarborConnection' });
    
    if (response?.connected) {
      harborStatusIndicator.className = 'status-indicator connected';
      harborStatusText.className = 'harbor-status-text connected';
      harborStatusText.textContent = 'Connected';
      harborStatus.className = 'harbor-status connected';
      harborInstallHint.style.display = 'none';
    } else {
      harborStatusIndicator.className = 'status-indicator disconnected';
      harborStatusText.className = 'harbor-status-text disconnected';
      harborStatusText.textContent = 'Not connected';
      harborStatus.className = 'harbor-status disconnected';
      harborInstallHint.style.display = 'block';
    }
  } catch (error) {
    harborStatusIndicator.className = 'status-indicator disconnected';
    harborStatusText.className = 'harbor-status-text disconnected';
    harborStatusText.textContent = 'Error checking connection';
    harborStatus.className = 'harbor-status disconnected';
    harborInstallHint.style.display = 'block';
  }
}

// =============================================================================
// Feature Flags
// =============================================================================

const DEFAULT_FLAGS: FeatureFlags = {
  textGeneration: true,
  toolCalling: false,
  toolAccess: true,
  browserInteraction: false,
  browserControl: false,
  multiAgent: false,
};

const STORAGE_KEY = 'web-agents-api-flags';

async function loadFeatureFlags(): Promise<FeatureFlags> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return { ...DEFAULT_FLAGS, ...(result[STORAGE_KEY] || {}) };
}

async function saveFeatureFlags(flags: FeatureFlags): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: flags });
}

async function initFeatureFlags(): Promise<void> {
  const flags = await loadFeatureFlags();
  
  flagTextGeneration.checked = flags.textGeneration;
  flagToolCalling.checked = flags.toolCalling;
  flagToolAccess.checked = flags.toolAccess;
  flagBrowserInteraction.checked = flags.browserInteraction;
  flagBrowserControl.checked = flags.browserControl;
  flagMultiAgent.checked = flags.multiAgent;
}

function setupFeatureFlagListeners(): void {
  const inputs = [
    { el: flagTextGeneration, key: 'textGeneration' },
    { el: flagToolCalling, key: 'toolCalling' },
    { el: flagToolAccess, key: 'toolAccess' },
    { el: flagBrowserInteraction, key: 'browserInteraction' },
    { el: flagBrowserControl, key: 'browserControl' },
    { el: flagMultiAgent, key: 'multiAgent' },
  ];

  for (const { el, key } of inputs) {
    el.addEventListener('change', async () => {
      const flags = await loadFeatureFlags();
      (flags as Record<string, boolean>)[key] = el.checked;
      await saveFeatureFlags(flags);
      
      // Show reload hint
      featureFlagReloadHint.classList.add('visible');
      
      showToast(`${key} ${el.checked ? 'enabled' : 'disabled'}`, 'success');
    });
  }
}

// =============================================================================
// Current Site
// =============================================================================

let currentOrigin: string | null = null;

async function updateCurrentSite(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (tab?.url) {
      const url = new URL(tab.url);
      currentOrigin = url.origin;
      currentSiteOrigin.textContent = currentOrigin;
      
      // Get permissions for this site
      await updateCurrentSitePermissions();
    } else {
      currentOrigin = null;
      currentSiteOrigin.textContent = '—';
      currentSitePermissions.innerHTML = '<div class="current-site-no-permissions">No active tab</div>';
    }
  } catch (error) {
    currentOrigin = null;
    currentSiteOrigin.textContent = '—';
    currentSitePermissions.innerHTML = '<div class="current-site-no-permissions">Could not get current tab</div>';
  }
}

async function updateCurrentSitePermissions(): Promise<void> {
  if (!currentOrigin) {
    currentSitePermissions.innerHTML = '<div class="current-site-no-permissions">No active tab</div>';
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({ 
      type: 'getPermissionsForOrigin', 
      origin: currentOrigin 
    });

    if (!response || !response.scopes || Object.keys(response.scopes).length === 0) {
      currentSitePermissions.innerHTML = '<div class="current-site-no-permissions">No permissions granted for this site</div>';
      return;
    }

    let html = '<div class="permission-scopes">';
    for (const [scope, grant] of Object.entries(response.scopes)) {
      if (grant === 'not-granted' || grant === 'denied') continue;
      const isTemp = grant === 'granted-once';
      html += `<span class="permission-scope-badge ${isTemp ? 'temporary' : ''}">${scope}${isTemp ? ' (temp)' : ''}</span>`;
    }
    html += '</div>';

    if (response.allowedTools && response.allowedTools.length > 0) {
      html += '<div class="permission-tools">';
      html += '<div class="permission-tools-title">Allowed Tools</div>';
      html += '<div class="permission-tools-list">';
      for (const tool of response.allowedTools) {
        html += `<span class="permission-tool-badge">${tool}</span>`;
      }
      html += '</div></div>';
    }

    html += `<div class="permission-actions">
      <button class="btn btn-danger btn-sm" id="revoke-current-btn">Revoke</button>
    </div>`;

    currentSitePermissions.innerHTML = html;

    // Add revoke handler
    const revokeBtn = document.getElementById('revoke-current-btn');
    if (revokeBtn) {
      revokeBtn.addEventListener('click', async () => {
        await revokePermissions(currentOrigin!);
        await updateCurrentSitePermissions();
        await loadAllPermissions();
        showToast('Permissions revoked', 'success');
      });
    }
  } catch (error) {
    currentSitePermissions.innerHTML = '<div class="current-site-no-permissions">Error loading permissions</div>';
  }
}

// =============================================================================
// All Permissions
// =============================================================================

async function loadAllPermissions(): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'listAllPermissions' });
    const permissions: PermissionEntry[] = response?.permissions || [];

    if (permissions.length === 0) {
      permissionsList.innerHTML = '<div class="empty-state">No permissions granted yet</div>';
      revokeAllBtn.style.display = 'none';
      return;
    }

    let html = '';
    for (const entry of permissions) {
      // Filter out not-granted scopes
      const grantedScopes = Object.entries(entry.scopes).filter(
        ([, grant]) => grant === 'granted-once' || grant === 'granted-always'
      );
      
      if (grantedScopes.length === 0) continue;

      const isCurrent = entry.origin === currentOrigin;
      
      html += `<div class="permission-item">
        <div class="permission-origin ${isCurrent ? 'current' : ''}">
          ${entry.origin}
          ${isCurrent ? '<span class="current-badge">current</span>' : ''}
        </div>
        <div class="permission-scopes">`;
      
      for (const [scope, grant] of grantedScopes) {
        const isTemp = grant === 'granted-once';
        html += `<span class="permission-scope-badge ${isTemp ? 'temporary' : ''}">${scope}${isTemp ? ' (temp)' : ''}</span>`;
      }
      
      html += '</div>';

      if (entry.allowedTools && entry.allowedTools.length > 0) {
        html += `<div class="permission-tools">
          <div class="permission-tools-title">Allowed Tools</div>
          <div class="permission-tools-list">`;
        for (const tool of entry.allowedTools) {
          html += `<span class="permission-tool-badge">${tool}</span>`;
        }
        html += '</div></div>';
      }

      html += `<div class="permission-actions">
        <button class="btn btn-danger btn-sm revoke-btn" data-origin="${entry.origin}">Revoke</button>
      </div>
      </div>`;
    }

    permissionsList.innerHTML = html || '<div class="empty-state">No permissions granted yet</div>';
    revokeAllBtn.style.display = html ? 'block' : 'none';

    // Add revoke handlers
    permissionsList.querySelectorAll('.revoke-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const origin = (e.target as HTMLElement).getAttribute('data-origin');
        if (origin) {
          await revokePermissions(origin);
          await loadAllPermissions();
          await updateCurrentSitePermissions();
          showToast('Permissions revoked', 'success');
        }
      });
    });
  } catch (error) {
    permissionsList.innerHTML = '<div class="empty-state">Error loading permissions</div>';
    revokeAllBtn.style.display = 'none';
  }
}

async function revokePermissions(origin: string): Promise<void> {
  await chrome.runtime.sendMessage({ type: 'revokePermissions', origin });
}

async function revokeAllPermissions(): Promise<void> {
  await chrome.runtime.sendMessage({ type: 'revokeAllPermissions' });
  await loadAllPermissions();
  await updateCurrentSitePermissions();
  showToast('All permissions revoked', 'success');
}

// =============================================================================
// Initialization
// =============================================================================

async function refresh(): Promise<void> {
  await checkHarborConnection();
  await updateCurrentSite();
  await loadAllPermissions();
}

async function init(): Promise<void> {
  initTheme();
  
  // Setup panel toggles
  setupPanelToggle(apiTogglesHeader, apiTogglesToggle, apiTogglesBody);
  setupPanelToggle(permissionsHeader, permissionsToggle, permissionsBody);
  
  // Setup event listeners
  themeToggle.addEventListener('click', cycleTheme);
  refreshBtn.addEventListener('click', refresh);
  revokeAllBtn.addEventListener('click', revokeAllPermissions);
  
  // Initialize feature flags
  await initFeatureFlags();
  setupFeatureFlagListeners();
  
  // Initial load
  await refresh();
  
  // Listen for tab changes
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
