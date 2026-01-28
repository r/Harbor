/**
 * Harbor Directory - Bundled MCP Servers
 * 
 * Shows a list of bundled/curated MCP servers that can be installed with one click.
 * Supports installing from:
 * - Bundled servers (shipped with extension)
 * - URL (single-file distributable, zip package, or manifest URL)
 * - File upload (drag-drop or file picker)
 */

import { browserAPI } from './browser-compat';
import { loadFromUrl, loadFromFile, type LoadResult } from './storage/package-loader';
import { getFeatureFlags, setFeatureFlags, type FeatureFlags } from './policy/feature-flags';

// Make this a module to avoid global scope conflicts
export {};

type BundledServer = {
  id: string;
  name: string;
  description: string;
  version: string;
  runtime: 'js' | 'wasm';
  icon: string;
  tags: string[];
  manifestUrl?: string;
  wasmUrl?: string;
  builtIn?: boolean; // Pre-installed with extension, can't be installed from directory
  tools: Array<{
    name: string;
    description?: string;
  }>;
  // OAuth configuration
  oauth?: {
    provider: 'google' | 'github';
    scopes: string[];
  };
};

type InstalledServer = {
  id: string;
  name: string;
  version: string;
  runtime?: 'wasm' | 'js';
  entrypoint?: string;
  tools?: Array<{ name: string }>;
  running: boolean;
};

// Bundled servers that ship with Harbor
const BUNDLED_SERVERS: BundledServer[] = [
  {
    id: 'time-wasm',
    name: 'Time Server',
    description: 'Provides tools for getting the current time and converting between timezones. A simple WASM-based MCP server.',
    version: '1.0.0',
    runtime: 'wasm',
    icon: '🕐',
    tags: ['time', 'datetime', 'timezone', 'wasm'],
    wasmUrl: 'assets/mcp-time.wasm',
    tools: [
      { name: 'get_current_time', description: 'Get the current time in a specific timezone' },
      { name: 'convert_time', description: 'Convert time between timezones' },
    ],
  },
  {
    id: 'echo-js',
    name: 'Echo Server',
    description: 'A simple demo server that echoes back input and reverses strings. Useful for testing MCP tool calls.',
    version: '1.0.0',
    runtime: 'js',
    icon: '🔊',
    tags: ['demo', 'test', 'echo'],
    builtIn: true,
    tools: [
      { name: 'echo', description: 'Echo back the input message' },
      { name: 'reverse', description: 'Reverse a string' },
    ],
  },
  {
    id: 'gmail-harbor',
    name: 'Gmail (Harbor)',
    description: 'Read and send emails via Gmail API. Supports searching, reading, sending emails and managing labels. Requires Google OAuth.',
    version: '1.0.0',
    runtime: 'js',
    icon: '📧',
    tags: ['gmail', 'email', 'google', 'oauth'],
    manifestUrl: 'bundled/gmail-harbor/manifest.json',
    tools: [
      { name: 'search_emails', description: 'Search emails using Gmail query syntax' },
      { name: 'read_email', description: 'Read the full content of an email' },
      { name: 'send_email', description: 'Send a new email' },
      { name: 'list_email_labels', description: 'List all Gmail labels' },
      { name: 'modify_email', description: 'Add or remove labels from emails' },
      { name: 'delete_email', description: 'Permanently delete an email' },
    ],
    oauth: {
      provider: 'google',
      scopes: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.send',
        'https://www.googleapis.com/auth/gmail.modify',
      ],
    },
  },
];

const STORAGE_KEY = 'harbor_wasm_servers';

// DOM elements
const list = document.getElementById('list') as HTMLDivElement;
const themeToggle = document.getElementById('theme-toggle') as HTMLButtonElement;
const installUrlInput = document.getElementById('install-url') as HTMLInputElement;
const installUrlBtn = document.getElementById('install-url-btn') as HTMLButtonElement;
const dropZone = document.getElementById('drop-zone') as HTMLDivElement;
const fileInput = document.getElementById('file-input') as HTMLInputElement;

// Track installed servers
let installedServerIds = new Set<string>();

function renderServerCard(server: BundledServer): HTMLElement {
  const isInstalled = installedServerIds.has(server.id) || server.builtIn;
  
  const card = document.createElement('div');
  card.className = `server-card ${isInstalled ? 'installed' : ''}`;
  card.dataset.serverId = server.id;

  const header = document.createElement('div');
  header.className = 'server-card-header';

  const iconContainer = document.createElement('div');
  iconContainer.className = 'server-card-icon';
  iconContainer.textContent = server.icon;

  const info = document.createElement('div');
  info.className = 'server-card-info';

  const nameRow = document.createElement('div');
  nameRow.className = 'server-card-name-row';

  const name = document.createElement('span');
  name.className = 'server-card-name';
  name.textContent = server.name;

  const badges = document.createElement('div');
  badges.className = 'server-card-badges';

  const runtimeBadge = document.createElement('span');
  runtimeBadge.className = `badge badge-${server.runtime === 'wasm' ? 'wasm' : 'js'}`;
  runtimeBadge.textContent = server.runtime.toUpperCase();
  badges.appendChild(runtimeBadge);

  if (server.builtIn) {
    const builtInBadge = document.createElement('span');
    builtInBadge.className = 'badge badge-builtin';
    builtInBadge.textContent = 'Built-in';
    badges.appendChild(builtInBadge);
  } else if (isInstalled) {
    const installedBadge = document.createElement('span');
    installedBadge.className = 'badge badge-installed';
    installedBadge.textContent = 'Installed';
    badges.appendChild(installedBadge);
  }

  // OAuth badge (just informational, no separate sign-in flow needed)
  if (server.oauth) {
    const oauthBadge = document.createElement('span');
    oauthBadge.className = 'badge badge-warning';
    oauthBadge.textContent = 'Requires OAuth';
    badges.appendChild(oauthBadge);
  }

  nameRow.appendChild(name);
  nameRow.appendChild(badges);

  const desc = document.createElement('div');
  desc.className = 'server-card-desc';
  desc.textContent = server.description;

  info.appendChild(nameRow);
  info.appendChild(desc);

  header.appendChild(iconContainer);
  header.appendChild(info);

  // Tools section
  const tools = document.createElement('div');
  tools.className = 'server-card-tools';
  
  const toolsLabel = document.createElement('span');
  toolsLabel.className = 'tools-label';
  toolsLabel.textContent = 'Tools: ';
  tools.appendChild(toolsLabel);
  
  const toolsList = server.tools.map(t => t.name).join(', ');
  const toolsText = document.createElement('span');
  toolsText.className = 'tools-list';
  toolsText.textContent = toolsList;
  tools.appendChild(toolsText);

  // Tags
  const tags = document.createElement('div');
  tags.className = 'server-card-tags';
  server.tags.forEach((tag) => {
    const tagEl = document.createElement('span');
    tagEl.className = 'tag';
    tagEl.textContent = tag;
    tags.appendChild(tagEl);
  });

  // Action buttons
  const actions = document.createElement('div');
  actions.className = 'server-card-actions';

  if (!server.builtIn) {
    const installBtn = document.createElement('button');
    installBtn.className = `btn ${isInstalled ? 'btn-secondary' : 'btn-primary'}`;
    installBtn.textContent = isInstalled ? 'Uninstall' : 'Install';
    installBtn.addEventListener('click', (e) => {
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

async function loadInstalledServers(): Promise<void> {
  try {
    const response = await browserAPI.runtime.sendMessage({ type: 'sidebar_get_servers' });
    console.log('[Directory] Got servers response:', response);
    if (response?.ok && response.servers) {
      const serverIds = response.servers.map((s: InstalledServer) => s.id);
      console.log('[Directory] Installed server IDs:', serverIds);
      installedServerIds = new Set(serverIds);
    } else {
      // Also check storage directly for WASM servers
      const result = await browserAPI.storage.local.get(STORAGE_KEY);
      const servers = (result[STORAGE_KEY] as Array<{ id: string }>) || [];
      const serverIds = servers.map((s) => s.id);
      console.log('[Directory] Storage server IDs:', serverIds);
      installedServerIds = new Set(serverIds);
    }
    console.log('[Directory] Final installedServerIds:', [...installedServerIds]);
  } catch (err) {
    console.error('[Directory] Failed to load installed servers:', err);
  }
}

async function installServer(server: BundledServer): Promise<void> {
  const btn = document.querySelector(`[data-server-id="${server.id}"] .btn`) as HTMLButtonElement;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Installing...';
  }

  try {
    if (server.runtime === 'wasm' && server.wasmUrl) {
      // Load WASM module
      const wasmResponse = await fetch(browserAPI.runtime.getURL(server.wasmUrl));
      const wasmBytes = await wasmResponse.arrayBuffer();
      
      const manifest = {
        id: server.id,
        name: server.name,
        version: server.version,
        runtime: 'wasm',
        entrypoint: server.wasmUrl,
        moduleBytesBase64: btoa(String.fromCharCode(...new Uint8Array(wasmBytes))),
        permissions: [],
        tools: server.tools,
      };

      const response = await browserAPI.runtime.sendMessage({
        type: 'sidebar_install_server',
        manifest,
      });

      if (!response?.ok) {
        throw new Error(response?.error || 'Failed to install server');
      }

      // Start the server
      await browserAPI.runtime.sendMessage({
        type: 'sidebar_validate_server',
        serverId: server.id,
      });
    } else if (server.runtime === 'js' && server.manifestUrl) {
      // Load JS manifest
      const manifestResponse = await fetch(browserAPI.runtime.getURL(server.manifestUrl));
      const manifest = await manifestResponse.json();

      // Check if OAuth is required
      if (manifest.oauth) {
        console.log('[Directory] Server requires OAuth:', manifest.oauth);
        if (btn) btn.textContent = 'Authenticating...';
        
        // Check if already authenticated
        const statusResponse = await browserAPI.runtime.sendMessage({
          type: 'oauth_status',
          server_id: server.id,
        });
        console.log('[Directory] Initial OAuth status:', statusResponse);
        
        if (!statusResponse?.ok || !statusResponse.authenticated) {
          // Need to do OAuth - start the flow
          console.log('[Directory] Starting OAuth flow...');
          const flowResponse = await browserAPI.runtime.sendMessage({
            type: 'oauth_start_flow',
            provider: manifest.oauth.provider,
            server_id: server.id,
            scopes: manifest.oauth.scopes,
          });
          console.log('[Directory] OAuth flow response:', flowResponse);
          
          if (!flowResponse?.ok) {
            throw new Error(flowResponse?.error || 'Failed to start OAuth flow');
          }
          
          showToast('Complete sign-in in the new tab...', 'info');
          
          // Wait for OAuth to complete (poll for status)
          console.log('[Directory] Waiting for OAuth completion...');
          const authenticated = await waitForOAuthCompletion(server.id);
          console.log('[Directory] OAuth wait result:', authenticated);
          if (!authenticated) {
            throw new Error('OAuth authentication was not completed');
          }
          
          showToast('Authentication successful!', 'success');
        }
        
        if (btn) btn.textContent = 'Installing...';
      }

      // Load the script
      const scriptUrl = new URL(manifest.scriptUrl, browserAPI.runtime.getURL(server.manifestUrl)).href;
      const scriptResponse = await fetch(scriptUrl);
      const scriptText = await scriptResponse.text();
      
      const fullManifest = {
        ...manifest,
        id: server.id,
        runtime: 'js',
        scriptBase64: btoa(unescape(encodeURIComponent(scriptText))),
      };

      const response = await browserAPI.runtime.sendMessage({
        type: 'sidebar_install_server',
        manifest: fullManifest,
      });

      if (!response?.ok) {
        throw new Error(response?.error || 'Failed to install server');
      }

      // Start the server
      await browserAPI.runtime.sendMessage({
        type: 'sidebar_validate_server',
        serverId: server.id,
      });
    }

    installedServerIds.add(server.id);
    showToast(`Installed ${server.name}`, 'success');
    refreshList();
  } catch (err) {
    console.error('[Directory] Failed to install server:', err);
    showToast(`Failed to install: ${err instanceof Error ? err.message : String(err)}`, 'error');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Install';
    }
  }
}

/**
 * Wait for OAuth authentication to complete by polling.
 */
async function waitForOAuthCompletion(serverId: string, timeoutMs = 300000): Promise<boolean> {
  const pollInterval = 2000; // 2 seconds
  const maxAttempts = timeoutMs / pollInterval;
  let attempts = 0;
  
  console.log(`[Directory] Starting OAuth poll for server: ${serverId}`);
  
  while (attempts < maxAttempts) {
    attempts++;
    
    try {
      const response = await browserAPI.runtime.sendMessage({
        type: 'oauth_status',
        server_id: serverId,
      });
      
      console.log(`[Directory] OAuth poll #${attempts} response:`, response);
      
      if (response?.ok && response.authenticated) {
        console.log('[Directory] OAuth completed successfully!');
        return true;
      }
    } catch (err) {
      console.warn('[Directory] OAuth poll error:', err);
    }
    
    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }
  
  console.warn(`[Directory] OAuth polling timed out after ${attempts} attempts`);
  return false;
}

async function uninstallServer(server: BundledServer): Promise<void> {
  const btn = document.querySelector(`[data-server-id="${server.id}"] .btn`) as HTMLButtonElement;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Removing...';
  }

  try {
    const response = await browserAPI.runtime.sendMessage({
      type: 'sidebar_remove_server',
      serverId: server.id,
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Failed to remove server');
    }

    installedServerIds.delete(server.id);
    showToast(`Removed ${server.name}`, 'success');
    refreshList();
  } catch (err) {
    console.error('[Directory] Failed to remove server:', err);
    showToast(`Failed to remove: ${err instanceof Error ? err.message : String(err)}`, 'error');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Uninstall';
    }
  }
}

function showToast(message: string, type: 'info' | 'success' | 'error' = 'info'): void {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), 3000);
}

async function refreshList(): Promise<void> {
  // Render immediately, then update installed status
  renderServerList();
  
  // Load installed status in background and re-render
  try {
    await loadInstalledServers();
    renderServerList();
  } catch (err) {
    console.error('[Directory] Failed to check server status:', err);
  }
}

function renderServerList(): void {
  list.innerHTML = '';
  
  if (BUNDLED_SERVERS.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `
      <div class="empty-icon">📦</div>
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

/**
 * Install a server from a URL.
 */
async function installFromUrl(url: string): Promise<void> {
  if (!url.trim()) {
    showToast('Please enter a URL', 'error');
    return;
  }

  installUrlBtn.disabled = true;
  installUrlBtn.textContent = 'Loading...';

  try {
    const result = await loadFromUrl(url);
    await handleLoadResult(result);
  } finally {
    installUrlBtn.disabled = false;
    installUrlBtn.textContent = 'Install';
  }
}

/**
 * Install a server from a File.
 */
async function installFromFile(file: File): Promise<void> {
  showToast(`Loading ${file.name}...`, 'info');

  try {
    const result = await loadFromFile(file);
    await handleLoadResult(result);
  } catch (err) {
    showToast(`Failed to load file: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

/**
 * Handle the result of loading a package.
 */
async function handleLoadResult(result: LoadResult): Promise<void> {
  if (!result.success) {
    showToast(`Failed to load: ${result.error}`, 'error');
    return;
  }

  const manifest = result.manifest;
  console.log('[Directory] Loaded manifest:', manifest);

  // Check if server is already installed
  if (installedServerIds.has(manifest.id)) {
    showToast(`Server "${manifest.name}" is already installed`, 'error');
    return;
  }

  // Ensure runtime is set
  if (!manifest.runtime) {
    if (manifest.scriptBase64 || manifest.scriptUrl) {
      manifest.runtime = 'js';
    } else if (manifest.wasmBase64 || manifest.moduleBytesBase64 || manifest.moduleUrl) {
      manifest.runtime = 'wasm';
    }
  }

  // Check for OAuth requirements
  if (manifest.oauth) {
    // Check OAuth status
    try {
      const response = await browserAPI.runtime.sendMessage({
        type: 'oauth_status',
        server_id: manifest.id,
      });
      if (!response?.ok || !response.authenticated) {
        showToast(`Server "${manifest.name}" requires OAuth. Sign in first via the OAuth setup flow.`, 'error');
        return;
      }
    } catch {
      showToast(`Server "${manifest.name}" requires OAuth which could not be verified.`, 'error');
      return;
    }
  }

  // Install the server
  try {
    const response = await browserAPI.runtime.sendMessage({
      type: 'sidebar_install_server',
      manifest,
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Failed to install server');
    }

    // Start the server to validate it
    await browserAPI.runtime.sendMessage({
      type: 'sidebar_validate_server',
      serverId: manifest.id,
    });

    installedServerIds.add(manifest.id);
    showToast(`Installed ${manifest.name}`, 'success');
    refreshList();
  } catch (err) {
    showToast(`Failed to install: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

/**
 * Setup drop zone for file upload.
 */
function setupDropZone(): void {
  if (!dropZone || !fileInput) return;

  // Click to browse
  dropZone.addEventListener('click', () => fileInput.click());

  // File input change
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) {
      installFromFile(file);
      fileInput.value = ''; // Reset for next use
    }
  });

  // Drag and drop events
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragging');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragging');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragging');

    const file = e.dataTransfer?.files?.[0];
    if (file) {
      installFromFile(file);
    }
  });
}

/**
 * Setup URL install button.
 */
function setupUrlInstall(): void {
  if (!installUrlBtn || !installUrlInput) return;

  installUrlBtn.addEventListener('click', () => {
    installFromUrl(installUrlInput.value);
  });

  // Install on Enter key
  installUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      installFromUrl(installUrlInput.value);
    }
  });
}

// Theme management
type Theme = 'light' | 'dark' | 'system';

function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme: Theme): void {
  const effectiveTheme = theme === 'system' ? getSystemTheme() : theme;
  document.documentElement.setAttribute('data-theme', effectiveTheme);
  localStorage.setItem('harbor-theme', theme);
  updateThemeToggle(theme);
}

function updateThemeToggle(theme: Theme): void {
  if (!themeToggle) return;
  const icons: Record<Theme, string> = { light: '☀️', dark: '🌙', system: '🖥️' };
  themeToggle.textContent = icons[theme];
  themeToggle.title = `Theme: ${theme} (click to change)`;
}

function initTheme(): void {
  const saved = localStorage.getItem('harbor-theme') as Theme | null;
  const theme = saved || 'system';
  applyTheme(theme);

  // Listen for system theme changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const current = localStorage.getItem('harbor-theme') as Theme | null;
    if (current === 'system' || !current) {
      applyTheme('system');
    }
  });

  // Listen for theme changes from other tabs/windows (sidebar)
  window.addEventListener('storage', (e) => {
    if (e.key === 'harbor-theme' && e.newValue) {
      applyTheme(e.newValue as Theme);
    }
  });
}

function cycleTheme(): void {
  const current = (localStorage.getItem('harbor-theme') as Theme | null) || 'system';
  const order: Theme[] = ['system', 'light', 'dark'];
  const next = order[(order.indexOf(current) + 1) % order.length];
  applyTheme(next);
}

// Initialize when DOM is ready
// =============================================================================
// Settings / Feature Flags
// =============================================================================

async function initSettings(): Promise<void> {
  const settingsSection = document.getElementById('settings-section');
  const settingsToggle = document.getElementById('settings-toggle');
  const settingsContent = document.getElementById('settings-content');

  if (!settingsSection || !settingsToggle || !settingsContent) {
    console.warn('[Directory] Settings elements not found');
    return;
  }

  // Toggle expand/collapse
  settingsToggle.addEventListener('click', () => {
    const isExpanded = settingsSection.classList.toggle('expanded');
    settingsContent.style.display = isExpanded ? 'block' : 'none';
  });

  // Load current flags and set checkboxes
  const flags = await getFeatureFlags();
  
  const flagCheckboxes: { id: string; flag: keyof FeatureFlags }[] = [
    { id: 'flag-browserInteraction', flag: 'browserInteraction' },
    { id: 'flag-screenshots', flag: 'screenshots' },
    { id: 'flag-experimental', flag: 'experimental' },
  ];

  for (const { id, flag } of flagCheckboxes) {
    const checkbox = document.getElementById(id) as HTMLInputElement | null;
    if (checkbox) {
      checkbox.checked = flags[flag];
      checkbox.addEventListener('change', async () => {
        await setFeatureFlags({ [flag]: checkbox.checked });
        showToast(
          checkbox.checked 
            ? `${flag} enabled` 
            : `${flag} disabled`,
          'success'
        );
      });
    }
  }
}

function init(): void {
  console.log('[Directory] Initializing...');
  console.log('[Directory] list element:', list);
  console.log('[Directory] BUNDLED_SERVERS:', BUNDLED_SERVERS.length);

  initTheme();
  themeToggle?.addEventListener('click', cycleTheme);

  // Setup URL and file install handlers
  setupUrlInstall();
  setupDropZone();

  // Setup feature flag settings
  initSettings().catch((error) => {
    console.error('[Directory] Failed to init settings:', error);
  });

  if (list) {
    refreshList().catch((error) => {
      console.error('[Directory] Failed to load directory:', error);
    });
  } else {
    console.error('[Directory] List element not found!');
  }
}

// Run init when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
