/**
 * Web Agents API - Sidebar Script
 * 
 * Manages API feature toggles. Site permissions are managed in Harbor's sidebar.
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
  // Use same key as Harbor for theme sync between extensions
  localStorage.setItem('harbor-theme', theme);
  updateThemeToggle(theme);
}

function updateThemeToggle(theme: Theme): void {
  const icons: Record<Theme, string> = { light: '☀️', dark: '🌙', system: '🖥️' };
  themeToggle.textContent = icons[theme];
  themeToggle.title = `Theme: ${theme} (click to change)`;
}

function initTheme(): void {
  // Safari: Always use system theme and hide the toggle button
  const isSafariBrowser = typeof browser !== 'undefined' && 
    navigator.userAgent.includes('Safari') && 
    !navigator.userAgent.includes('Chrome');
  
  if (isSafariBrowser) {
    // Hide theme toggle button in Safari
    if (themeToggle) themeToggle.style.display = 'none';
    
    // Always follow system theme
    applyTheme('system');
    
    // Listen for system theme changes
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      applyTheme('system');
    });
    return;
  }
  
  // Chrome/Firefox: Use saved theme with manual toggle
  const saved = localStorage.getItem('harbor-theme') as Theme | null;
  const theme = saved || 'system';
  applyTheme(theme);
  
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const current = localStorage.getItem('harbor-theme') as Theme | null;
    if (current === 'system' || !current) {
      applyTheme('system');
    }
  });
  
  // Listen for theme changes from Harbor extension
  window.addEventListener('storage', (e) => {
    if (e.key === 'harbor-theme' && e.newValue) {
      applyTheme(e.newValue as Theme);
    }
  });
}

function cycleTheme(): void {
  const current = localStorage.getItem('harbor-theme') as Theme | null || 'system';
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
  toolCalling: true,
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
// Initialization
// =============================================================================

async function refresh(): Promise<void> {
  await checkHarborConnection();
}

async function init(): Promise<void> {
  initTheme();
  
  // Setup panel toggles
  setupPanelToggle(apiTogglesHeader, apiTogglesToggle, apiTogglesBody);
  
  // Setup event listeners
  themeToggle.addEventListener('click', cycleTheme);
  refreshBtn.addEventListener('click', refresh);
  
  // Initialize feature flags
  await initFeatureFlags();
  setupFeatureFlagListeners();
  
  // Initial load
  await refresh();
}

init().catch(console.error);
