// Make this a module to avoid global scope conflicts
export {};

import { browserAPI } from './browser-compat';

type SecretDecl = { name: string; label: string; type?: 'text' | 'password' };

type ServerStatus = {
  id: string;
  name: string;
  version: string;
  runtime?: 'wasm' | 'js' | 'remote';
  entrypoint?: string;
  remoteUrl?: string;
  tools?: Array<{ name: string }>;
  running: boolean;
  secretsDecl?: SecretDecl[];
};

type BridgeStatus = {
  ok: boolean;
  connected: boolean;
  bridgeReady?: boolean;
  lastCheck: number;
  error: string | null;
};

type ProviderInfo = {
  id: string;
  type: string;
  name: string;
  configured: boolean;
  needs_api_key: boolean;
  is_local: boolean;
  is_default: boolean;
  is_type_default: boolean;
  has_api_key: boolean;
  base_url?: string;
  available?: boolean;
};

type LlmConfig = {
  version: number;
  default_model?: string;
  default_provider?: string;
  providers: Record<string, {
    id: string;
    type: string;
    name: string;
    enabled: boolean;
    has_api_key: boolean;
    base_url?: string;
    is_type_default: boolean;
  }>;
};


type ModelInfo = {
  id: string;
  provider?: string;
  owned_by?: string;
};

type ConfiguredModel = {
  name: string;
  model_id: string;
  is_default: boolean;
};

// Header elements
const headerLogo = document.getElementById('header-logo') as HTMLDivElement;

// Server elements
const serversEl = document.getElementById('servers') as HTMLDivElement;
const serversListEl = document.getElementById('servers-list') as HTMLDivElement;
const addBtn = document.getElementById('add') as HTMLButtonElement;
const fileInput = document.getElementById('file') as HTMLInputElement;
const addRemoteBtn = document.getElementById('add-remote') as HTMLButtonElement;

// Remote server form elements
const remoteServerForm = document.getElementById('remote-server-form') as HTMLDivElement;
const remoteServerUrlInput = document.getElementById('remote-server-url') as HTMLInputElement;
const remoteServerNameInput = document.getElementById('remote-server-name') as HTMLInputElement;
const remoteServerTransportSelect = document.getElementById('remote-server-transport') as HTMLSelectElement;
const remoteServerAuthInput = document.getElementById('remote-server-auth') as HTMLInputElement;
const remoteServerTestBtn = document.getElementById('remote-server-test') as HTMLButtonElement;
const remoteServerSaveBtn = document.getElementById('remote-server-save') as HTMLButtonElement;
const remoteServerCancelBtn = document.getElementById('remote-server-cancel') as HTMLButtonElement;

// Server secrets (Configure credentials) form
const serverSecretsForm = document.getElementById('server-secrets-form') as HTMLDivElement;
const serverSecretsTitle = document.getElementById('server-secrets-title') as HTMLSpanElement;
const serverSecretsFields = document.getElementById('server-secrets-fields') as HTMLDivElement;
const serverSecretsSaveBtn = document.getElementById('server-secrets-save') as HTMLButtonElement;
const serverSecretsCancelBtn = document.getElementById('server-secrets-cancel') as HTMLButtonElement;
const serverSecretsCancelBtn2 = document.getElementById('server-secrets-cancel-btn') as HTMLButtonElement;

// Bridge status elements
const bridgeStatusIndicator = document.getElementById('bridge-status-indicator') as HTMLDivElement;
const bridgeStatusText = document.getElementById('bridge-status-text') as HTMLSpanElement;

// Setup status panel
const setupStatusList = document.getElementById('setup-status-list') as HTMLDivElement;
const setupStatusBody = document.getElementById('setup-status-body') as HTMLDivElement;
const setupStatusToggle = document.getElementById('setup-status-toggle') as HTMLSpanElement;
const setupStatusHeader = document.getElementById('setup-status-header') as HTMLDivElement;
const openDebuggingLink = document.getElementById('open-debugging-link') as HTMLAnchorElement;

// LLM elements
const llmPanelHeader = document.getElementById('llm-panel-header') as HTMLDivElement;
const llmPanelToggle = document.getElementById('llm-panel-toggle') as HTMLSpanElement;
const llmPanelBody = document.getElementById('llm-panel-body') as HTMLDivElement;
const llmStatusIndicator = document.getElementById('llm-status-indicator') as HTMLDivElement;
const llmStatusText = document.getElementById('llm-status-text') as HTMLSpanElement;
const configuredModelsEl = document.getElementById('configured-models') as HTMLDivElement;
const availableModelsSelect = document.getElementById('available-models') as HTMLSelectElement;
const addModelBtn = document.getElementById('add-model-btn') as HTMLButtonElement;
const providersCountEl = document.getElementById('providers-count') as HTMLSpanElement;
const detectedProvidersEl = document.getElementById('detected-providers') as HTMLDivElement;
const apiKeyConfig = document.getElementById('api-key-config') as HTMLDivElement;
const apiKeyProviderName = document.getElementById('api-key-provider-name') as HTMLSpanElement;
const apiKeyInput = document.getElementById('api-key-input') as HTMLInputElement;
const apiKeySaveBtn = document.getElementById('api-key-save') as HTMLButtonElement;
const apiKeyCancelBtn = document.getElementById('api-key-cancel') as HTMLButtonElement;
const serversPanelHeader = document.getElementById('servers-panel-header') as HTMLDivElement;
const serversPanelToggle = document.getElementById('servers-panel-toggle') as HTMLSpanElement;

// Track which provider is being configured
let configuringProviderId: string | null = null;

// OAuth App Credentials elements
const oauthPanelHeader = document.getElementById('oauth-panel-header') as HTMLDivElement;
const oauthPanelToggle = document.getElementById('oauth-panel-toggle') as HTMLSpanElement;
const oauthPanelBody = document.getElementById('oauth-panel-body') as HTMLDivElement;
const oauthStatusIndicator = document.getElementById('oauth-status-indicator') as HTMLDivElement;
const oauthStatusText = document.getElementById('oauth-status-text') as HTMLSpanElement;
const oauthProvidersList = document.getElementById('oauth-providers-list') as HTMLDivElement;
const oauthConfigForm = document.getElementById('oauth-config-form') as HTMLDivElement;
const oauthConfigProviderName = document.getElementById('oauth-config-provider-name') as HTMLSpanElement;
const oauthClientIdInput = document.getElementById('oauth-client-id') as HTMLInputElement;
const oauthClientSecretInput = document.getElementById('oauth-client-secret') as HTMLInputElement;
const oauthConfigSaveBtn = document.getElementById('oauth-config-save') as HTMLButtonElement;
const oauthConfigCancelBtn = document.getElementById('oauth-config-cancel') as HTMLButtonElement;
const oauthHelpLink = document.getElementById('oauth-help-link') as HTMLAnchorElement;

// Track which OAuth provider is being configured
let configuringOAuthProvider: string | null = null;

// Cache available models
let cachedAvailableModels: ModelInfo[] = [];

// Bridge status polling
const BRIDGE_STATUS_POLL_INTERVAL = 5000; // 5 seconds

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
  localStorage.setItem('harbor-theme', theme);
  updateThemeToggle(theme);
}

function updateThemeToggle(theme: Theme): void {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  
  const icons: Record<Theme, string> = { light: '☀️', dark: '🌙', system: '🖥️' };
  btn.textContent = icons[theme];
  btn.title = `Theme: ${theme} (click to change)`;
}

function initTheme(): void {
  // Safari: Always use system theme and hide the toggle button
  const isSafariBrowser = typeof browser !== 'undefined' && 
    navigator.userAgent.includes('Safari') && 
    !navigator.userAgent.includes('Chrome');
  
  if (isSafariBrowser) {
    // Hide theme toggle button in Safari
    const themeBtn = document.getElementById('theme-toggle');
    if (themeBtn) themeBtn.style.display = 'none';
    
    // Always follow system theme
    applyTheme('system');
    
    // Listen for system theme changes
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      applyTheme('system');
    });
    return;
  }
  
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
}

function cycleTheme(): void {
  const current = localStorage.getItem('harbor-theme') as Theme | null || 'system';
  const order: Theme[] = ['system', 'light', 'dark'];
  const next = order[(order.indexOf(current) + 1) % order.length];
  applyTheme(next);
}

// Initialize theme on load
initTheme();

// =============================================================================
// Toast notification helper
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
// Header Logo - Open about:debugging or copy to clipboard
// =============================================================================

const DEBUGGING_URL = 'about:debugging#/runtime/this-firefox';

headerLogo.addEventListener('click', async () => {
  try {
    // Try to open the URL in a new tab
    // Note: Firefox extensions cannot directly open about: URLs via tabs.create
    // So we copy to clipboard as the fallback
    await navigator.clipboard.writeText(DEBUGGING_URL);
    showToast('Copied debugging URL to clipboard');
  } catch (err) {
    console.error('[Sidebar] Failed to copy to clipboard:', err);
    showToast('Failed to copy URL');
  }
});

function updateBridgeStatusUI(connected: boolean, error?: string | null): void {
  if (connected) {
    bridgeStatusIndicator.className = 'status-indicator connected';
    bridgeStatusText.className = 'status-text connected';
    bridgeStatusText.textContent = 'Connected';
  } else {
    bridgeStatusIndicator.className = 'status-indicator disconnected';
    bridgeStatusText.className = 'status-text disconnected';
    bridgeStatusText.textContent = 'Disconnected';
    if (error) {
      bridgeStatusText.title = error;
    }
  }
}

let lastBridgeConnected = false;
let lastBridgeError: string | null = null;

function renderSetupStatus(): void {
  if (!setupStatusList) return;
  const bridgeOk = lastBridgeConnected;
  const bridgeErr = lastBridgeError;

  setupStatusList.innerHTML = '';
  // Bridge row (MCP and browser capture are solely Harbor)
  const bridgeRow = document.createElement('div');
  bridgeRow.className = 'setup-status-row';
  const bridgeDot = document.createElement('span');
  bridgeDot.className = `status-dot ${bridgeOk ? 'status-running' : 'status-stopped'}`;
  const bridgeLabel = document.createElement('span');
  bridgeLabel.className = 'label';
  bridgeLabel.textContent = 'Bridge';
  const bridgeContent = document.createElement('div');
  bridgeContent.innerHTML = bridgeOk
    ? '<span>Connected</span>'
    : `<span>Disconnected</span><div class="hint">Run in terminal: cd harbor/bridge-rs && ./install.sh --firefox-only --skip-build — then restart Firefox.</div>`;
  if (bridgeErr && !bridgeOk) {
    const errEl = document.createElement('div');
    errEl.className = 'hint';
    errEl.textContent = bridgeErr;
    bridgeContent.appendChild(errEl);
  }
  bridgeRow.append(bridgeDot, bridgeLabel, bridgeContent);
  setupStatusList.appendChild(bridgeRow);
}

async function checkBridgeStatus(): Promise<void> {
  try {
    const response = await browserAPI.runtime.sendMessage({ type: 'bridge_check_health' }) as BridgeStatus;
    lastBridgeError = response.error ?? null;
    // Debug: show response in title attribute
    const debugInfo = `connected: ${response.connected}, bridgeReady: ${response.bridgeReady}, error: ${response.error || 'none'}`;
    bridgeStatusText.title = debugInfo;
    console.log('[Sidebar] Bridge status:', debugInfo);

    // Only consider fully ready when both connected AND bridgeReady
    const isReady = response.connected && response.bridgeReady;
    const wasReady = lastBridgeConnected;
    lastBridgeConnected = isReady;

    updateBridgeStatusUI(isReady, response.error);
    renderSetupStatus();

    // If bridge just became fully ready, refresh all data immediately
    if (isReady && !wasReady) {
      console.log('[Sidebar] Bridge fully ready - refreshing all data...');
      // Refresh all data in parallel
      Promise.all([
        loadServers().catch(e => console.error('[Sidebar] Failed to load servers:', e)),
        loadLlmProviders().catch(e => console.error('[Sidebar] Failed to load LLM providers:', e)),
        loadPermissions().catch(e => console.error('[Sidebar] Failed to load permissions:', e)),
        loadSessions().catch(e => console.error('[Sidebar] Failed to load sessions:', e)),
      ]);
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[Sidebar] Failed to check bridge status:', errorMsg);
    lastBridgeError = errorMsg;
    // Show error in UI for debugging
    bridgeStatusText.title = `Error: ${errorMsg}`;
    updateBridgeStatusUI(false, errorMsg);
    renderSetupStatus();
    lastBridgeConnected = false;
  }
}

function startBridgeStatusPolling(): void {
  // Initial check
  checkBridgeStatus();
  // Periodic polling
  setInterval(checkBridgeStatus, BRIDGE_STATUS_POLL_INTERVAL);

  // When user switches back to Harbor sidebar, refresh immediately so we don't show stale "Disconnected"
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      checkBridgeStatus();
    }
  });
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function renderServer(server: ServerStatus, bridgeConnected?: boolean): HTMLElement {
  const item = document.createElement('div');
  item.className = 'server';

  // Row 1: Header with name, badge, and action buttons
  const header = document.createElement('div');
  header.className = 'server-title';

  const nameContainer = document.createElement('span');
  nameContainer.style.display = 'flex';
  nameContainer.style.alignItems = 'center';
  nameContainer.style.gap = '6px';

  const name = document.createElement('span');
  name.textContent = server.name;
  nameContainer.appendChild(name);

  // Show runtime badge (JS, WASM, or Remote)
  const runtimeBadge = document.createElement('span');
  if (server.runtime === 'remote') {
    runtimeBadge.className = 'badge badge-remote';
    runtimeBadge.textContent = 'REMOTE';
  } else {
    runtimeBadge.className = 'badge badge-muted';
    runtimeBadge.textContent = server.runtime === 'js' ? 'JS' : 'WASM';
  }
  nameContainer.appendChild(runtimeBadge);

  // Action buttons container
  const actions = document.createElement('span');
  actions.className = 'server-actions';

  if (!server.running) {
    const startButton = document.createElement('button');
    startButton.className = 'btn btn-secondary btn-sm';
    startButton.textContent = 'Start';
    startButton.addEventListener('click', async () => {
      startButton.disabled = true;
      const response = await browserAPI.runtime.sendMessage({
        type: 'sidebar_validate_server',
        serverId: server.id,
      });
      if (!response?.ok) {
        console.error(response?.error || 'Failed to start server');
      }
      await loadServers();
      startButton.disabled = false;
    });
    actions.appendChild(startButton);
  } else {
    const stopButton = document.createElement('button');
    stopButton.className = 'btn btn-secondary btn-sm';
    stopButton.textContent = 'Stop';
    stopButton.addEventListener('click', async () => {
      stopButton.disabled = true;
      const response = await browserAPI.runtime.sendMessage({
        type: 'sidebar_stop_server',
        serverId: server.id,
      });
      if (!response?.ok) {
        console.error(response?.error || 'Failed to stop server');
      }
      await loadServers();
      await loadToolTesterServers();
      stopButton.disabled = false;
    });
    actions.appendChild(stopButton);
  }

  const removeButton = document.createElement('button');
  removeButton.className = 'btn btn-ghost btn-sm';
  removeButton.textContent = 'Unload';
  removeButton.addEventListener('click', async () => {
    removeButton.disabled = true;
    const response = await browserAPI.runtime.sendMessage({
      type: 'sidebar_remove_server',
      serverId: server.id,
    });
    if (!response?.ok) {
      console.error(response?.error || 'Failed to remove server');
    }
    await loadServers();
    await loadToolTesterServers();
    removeButton.disabled = false;
  });
  actions.appendChild(removeButton);

  if (server.secretsDecl?.length) {
    const configureButton = document.createElement('button');
    configureButton.className = 'btn btn-ghost btn-sm';
    configureButton.textContent = 'Configure';
    configureButton.title = 'Set credentials for this server';
    configureButton.addEventListener('click', () => openServerSecretsForm(server));
    actions.appendChild(configureButton);
  }

  header.appendChild(nameContainer);
  header.appendChild(actions);

  // Row 2: Status and tools info
  const meta = document.createElement('div');
  meta.className = 'server-meta';

  const statusDot = document.createElement('span');
  statusDot.className = `status-dot ${server.running ? 'status-running' : 'status-stopped'}`;
  meta.appendChild(statusDot);

  const statusText = document.createElement('span');
  const isStub = server.runtime === 'js' && server.running && bridgeConnected === false;
  statusText.textContent = server.running ? (isStub ? 'Running (Stub)' : 'Running') : 'Stopped';
  statusText.style.marginRight = '12px';
  meta.appendChild(statusText);
  if (isStub) {
    const stubHint = document.createElement('span');
    stubHint.className = 'status-stub-hint';
    stubHint.style.color = 'var(--color-text-muted)';
    stubHint.style.fontSize = '11px';
    stubHint.textContent = ' — Connect bridge for real tools';
    meta.appendChild(stubHint);
  }
  
  // Show remote URL for remote servers
  if (server.runtime === 'remote' && server.remoteUrl) {
    const urlText = document.createElement('span');
    urlText.textContent = server.remoteUrl;
    urlText.style.color = 'var(--color-text-muted)';
    urlText.style.fontSize = 'var(--text-xs)';
    urlText.style.fontFamily = 'var(--font-mono)';
    urlText.style.marginRight = '12px';
    urlText.style.wordBreak = 'break-all';
    meta.appendChild(urlText);
  }

  const toolNames = (server.tools || []).map((tool) => tool.name).join(', ');
  if (toolNames.length > 0) {
    const toolsText = document.createElement('span');
    toolsText.textContent = `Tools: ${toolNames}`;
    toolsText.style.color = 'var(--color-text-muted)';
    meta.appendChild(toolsText);
  }

  item.appendChild(header);
  item.appendChild(meta);
  return item;
}

let isLoadingServers = false;
async function loadServers(): Promise<void> {
  if (isLoadingServers) {
    console.log('[Sidebar] Already loading servers, skipping...');
    return;
  }
  isLoadingServers = true;
  
  try {
    const listEl = serversListEl || serversEl;
    listEl.innerHTML = '';
    const response = await browserAPI.runtime.sendMessage({ type: 'sidebar_get_servers' });
    if (!response?.ok) {
      listEl.textContent = response?.error || 'Failed to load servers';
      return;
    }
    const servers = response.servers as ServerStatus[];
    const bridgeConnected = response.bridgeConnected === true;
    if (!servers || servers.length === 0) {
      listEl.textContent = 'No servers installed.';
      return;
    }
    // Deduplicate by ID just in case
    const seen = new Set<string>();
    const uniqueServers = servers.filter(s => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    });
    uniqueServers.forEach((server) => listEl.appendChild(renderServer(server, bridgeConnected)));
    // Keep Tool Tester dropdown in sync (e.g. after adding or starting a server)
    loadToolTesterServers().catch((e) => console.warn('[Sidebar] Tool Tester refresh:', e));
  } finally {
    isLoadingServers = false;
  }
}

// Server secrets (Configure) form state and actions
let configuringSecretsServer: ServerStatus | null = null;

function openServerSecretsForm(server: ServerStatus): void {
  if (!server.secretsDecl?.length || !serverSecretsForm || !serverSecretsFields) return;
  configuringSecretsServer = server;
  serverSecretsTitle.textContent = `Credentials for ${server.name}`;
  serverSecretsFields.innerHTML = '';
  for (const decl of server.secretsDecl) {
    const group = document.createElement('div');
    group.className = 'form-group';
    const label = document.createElement('label');
    label.className = 'form-label';
    label.setAttribute('for', `secret-${decl.name}`);
    label.textContent = decl.label;
    const input = document.createElement('input');
    input.type = decl.type === 'password' ? 'password' : 'text';
    input.className = 'form-input';
    input.id = `secret-${decl.name}`;
    input.dataset.secretName = decl.name;
    input.placeholder = decl.optional ? '(optional)' : '';
    group.appendChild(label);
    group.appendChild(input);
    serverSecretsFields.appendChild(group);
  }
  serverSecretsForm.style.display = 'block';
  // Load current values
  browserAPI.runtime.sendMessage({ type: 'sidebar_get_server_secrets', serverId: server.id }).then((response: { ok?: boolean; secrets?: Record<string, string> }) => {
    if (response?.ok && response.secrets) {
      for (const [name, value] of Object.entries(response.secrets)) {
        const input = serverSecretsFields.querySelector(`[data-secret-name="${name}"]`) as HTMLInputElement | null;
        if (input) input.value = value ?? '';
      }
    }
  });
}

function closeServerSecretsForm(): void {
  configuringSecretsServer = null;
  if (serverSecretsForm) serverSecretsForm.style.display = 'none';
}

async function saveServerSecrets(): Promise<void> {
  if (!configuringSecretsServer?.secretsDecl?.length || !serverSecretsFields) return;
  const secrets: Record<string, string> = {};
  for (const decl of configuringSecretsServer.secretsDecl) {
    const input = serverSecretsFields.querySelector(`[data-secret-name="${decl.name}"]`) as HTMLInputElement | null;
    if (input) secrets[decl.name] = input.value.trim();
  }
  const response = await browserAPI.runtime.sendMessage({
    type: 'sidebar_set_server_secrets',
    serverId: configuringSecretsServer.id,
    secrets,
  });
  if (response?.ok) {
    closeServerSecretsForm();
  } else {
    console.error(response?.error || 'Failed to save credentials');
  }
}

if (serverSecretsSaveBtn) serverSecretsSaveBtn.addEventListener('click', saveServerSecrets);
if (serverSecretsCancelBtn) serverSecretsCancelBtn.addEventListener('click', closeServerSecretsForm);
if (serverSecretsCancelBtn2) serverSecretsCancelBtn2.addEventListener('click', closeServerSecretsForm);

// Theme toggle
const themeToggle = document.getElementById('theme-toggle');
themeToggle?.addEventListener('click', cycleTheme);

addBtn.addEventListener('click', () => {
  fileInput.click();
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) {
    return;
  }

  let manifest: Record<string, unknown>;

  if (file.name.endsWith('.json')) {
    // Handle JSON manifest file
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      
      // Validate required fields
      if (!parsed.id && !parsed.name) {
        showToast('Invalid manifest: missing id or name');
        fileInput.value = '';
        return;
      }
      
      manifest = {
        ...parsed,
        // Generate id if not provided
        id: parsed.id || `mcp-${Date.now()}`,
        // Default runtime to 'js' if scriptBase64 or scriptUrl present
        runtime: parsed.runtime || (parsed.scriptBase64 || parsed.scriptUrl ? 'js' : 'wasm'),
        permissions: parsed.permissions || [],
      };
      
      showToast(`Loading ${manifest.runtime === 'js' ? 'JS' : 'WASM'} server: ${manifest.name || manifest.id}`);
    } catch (e) {
      console.error('Failed to parse manifest:', e);
      showToast('Failed to parse JSON manifest');
      fileInput.value = '';
      return;
    }
  } else {
    // Handle WASM file (existing behavior)
    const bytes = await file.arrayBuffer();
    manifest = {
      id: `wasm-${Date.now()}`,
      name: file.name.replace(/\.wasm$/i, ''),
      version: '0.1.0',
      runtime: 'wasm',
      entrypoint: file.name,
      moduleBytesBase64: toBase64(bytes),
      permissions: [],
      tools: [],
    };
    showToast(`Loading WASM server: ${manifest.name}`);
  }

  const response = await browserAPI.runtime.sendMessage({
    type: 'sidebar_install_server',
    manifest,
  });
  if (!response?.ok) {
    console.error(response?.error || 'Failed to install server');
    showToast('Failed to install server');
  }
  fileInput.value = '';
  const validate = await browserAPI.runtime.sendMessage({
    type: 'sidebar_validate_server',
    serverId: manifest.id,
  });
  if (!validate?.ok) {
    console.error(validate?.error || 'Failed to validate server');
    showToast('Failed to start server: ' + (validate?.error || 'unknown error'));
  } else {
    showToast('Server installed and started');
  }
  await loadServers();
});

loadServers().catch((error) => {
  console.error('Failed to load servers', error);
});

// =============================================================================
// Remote Server Form Handlers
// =============================================================================

function showRemoteServerForm(): void {
  remoteServerForm.style.display = 'block';
  remoteServerUrlInput.value = '';
  remoteServerNameInput.value = '';
  remoteServerTransportSelect.value = 'sse';
  remoteServerAuthInput.value = '';
  remoteServerUrlInput.focus();
}

function hideRemoteServerForm(): void {
  remoteServerForm.style.display = 'none';
  remoteServerUrlInput.value = '';
  remoteServerNameInput.value = '';
  remoteServerAuthInput.value = '';
}

addRemoteBtn?.addEventListener('click', showRemoteServerForm);
remoteServerCancelBtn?.addEventListener('click', hideRemoteServerForm);

// Test connection to remote server
remoteServerTestBtn?.addEventListener('click', async () => {
  const url = remoteServerUrlInput.value.trim();
  if (!url) {
    showToast('Please enter a server URL', 'error');
    return;
  }

  remoteServerTestBtn.disabled = true;
  remoteServerTestBtn.textContent = 'Testing...';

  try {
    const response = await browserAPI.runtime.sendMessage({
      type: 'sidebar_test_remote_server',
      url,
      transport: remoteServerTransportSelect.value,
      authHeader: remoteServerAuthInput.value.trim() || undefined,
    });

    if (response?.ok) {
      showToast(`Connection successful! Found ${response.toolCount || 0} tools.`, 'success');
      // Auto-fill name if not set and server returned one
      if (!remoteServerNameInput.value && response.serverName) {
        remoteServerNameInput.value = response.serverName;
      }
    } else {
      showToast(`Connection failed: ${response?.error || 'Unknown error'}`, 'error');
    }
  } catch (err) {
    showToast(`Test failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }

  remoteServerTestBtn.disabled = false;
  remoteServerTestBtn.textContent = 'Test Connection';
});

// Save remote server
remoteServerSaveBtn?.addEventListener('click', async () => {
  const url = remoteServerUrlInput.value.trim();
  const name = remoteServerNameInput.value.trim();
  const transport = remoteServerTransportSelect.value as 'sse' | 'websocket';
  const authHeader = remoteServerAuthInput.value.trim() || undefined;

  if (!url) {
    showToast('Please enter a server URL', 'error');
    return;
  }

  if (!name) {
    showToast('Please enter a server name', 'error');
    return;
  }

  remoteServerSaveBtn.disabled = true;
  remoteServerSaveBtn.textContent = 'Adding...';

  try {
    const response = await browserAPI.runtime.sendMessage({
      type: 'sidebar_add_remote_server',
      url,
      name,
      transport,
      authHeader,
    });

    if (response?.ok) {
      showToast(`Added remote server: ${name}`, 'success');
      hideRemoteServerForm();
      await loadServers();
    } else {
      showToast(`Failed to add server: ${response?.error || 'Unknown error'}`, 'error');
    }
  } catch (err) {
    showToast(`Failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }

  remoteServerSaveBtn.disabled = false;
  remoteServerSaveBtn.textContent = 'Add Server';
});

// Auto-refresh servers when storage changes (e.g., from Directory page)
browserAPI.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.harbor_mcp_servers) {
    console.log('[Sidebar] Server storage changed, refreshing...');
    loadServers();
  }
});

// Start bridge status polling
startBridgeStatusPolling();

// =============================================================================
// Panel Toggle Logic
// =============================================================================

function setupPanelToggle(header: HTMLElement, toggle: HTMLElement, body: HTMLElement): void {
  header.addEventListener('click', () => {
    const isCollapsed = body.classList.toggle('collapsed');
    toggle.classList.toggle('collapsed', isCollapsed);
  });
}

setupPanelToggle(llmPanelHeader, llmPanelToggle, llmPanelBody);
if (setupStatusHeader && setupStatusToggle && setupStatusBody) {
  setupPanelToggle(setupStatusHeader, setupStatusToggle, setupStatusBody);
}
openDebuggingLink?.addEventListener('click', async (e) => {
  e.preventDefault();
  try {
    await navigator.clipboard.writeText(DEBUGGING_URL);
    showToast('Copied about:debugging URL — paste in address bar');
  } catch (err) {
    console.error('[Sidebar] Failed to copy URL:', err);
    showToast('Failed to copy URL');
  }
});
setupPanelToggle(serversPanelHeader, serversPanelToggle, serversEl);

// =============================================================================
// LLM Provider Management
// =============================================================================

function updateLlmHeaderStatus(availableCount: number): void {
  if (availableCount > 0) {
    llmStatusIndicator.className = 'status-indicator connected';
    llmStatusText.className = 'status-text connected';
    llmStatusText.textContent = `${availableCount} available`;
  } else {
    llmStatusIndicator.className = 'status-indicator disconnected';
    llmStatusText.className = 'status-text disconnected';
    llmStatusText.textContent = 'None available';
  }
}


function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// Show API key configuration for a cloud provider
function showApiKeyConfig(providerType: string): void {
  configuringProviderId = providerType;
  apiKeyProviderName.textContent = `Configure ${capitalizeFirst(providerType)}`;
  apiKeyInput.value = '';
  apiKeyConfig.style.display = 'block';
  apiKeyInput.focus();
}

// Hide API key configuration
function hideApiKeyConfig(): void {
  configuringProviderId = null;
  apiKeyConfig.style.display = 'none';
  apiKeyInput.value = '';
}

// API Key save button
apiKeySaveBtn.addEventListener('click', async () => {
  if (!configuringProviderId || !apiKeyInput.value.trim()) return;

  apiKeySaveBtn.disabled = true;
  apiKeySaveBtn.textContent = 'Saving...';

  try {
    const response = await browserAPI.runtime.sendMessage({
      type: 'llm_configure_provider',
      provider: configuringProviderId,
      name: capitalizeFirst(configuringProviderId),
      api_key: apiKeyInput.value.trim(),
      enabled: true,
    }) as { ok: boolean; id?: string; error?: string };
    
    if (response.ok) {
      showToast('API key saved');
      hideApiKeyConfig();
      await loadLlmProviders();
    } else {
      showToast('Failed to save: ' + (response.error || 'Unknown error'));
    }
  } catch (err) {
    showToast('Failed to save API key');
    console.error('Failed to save:', err);
  }

  apiKeySaveBtn.disabled = false;
  apiKeySaveBtn.textContent = 'Save';
});

// API Key cancel button
apiKeyCancelBtn.addEventListener('click', () => {
  hideApiKeyConfig();
});

async function loadLlmProviders(): Promise<void> {
  console.log('[Sidebar] loadLlmProviders starting...');
  try {
    // Load configured models, available models, and providers in parallel
    const [configuredModelsRes, modelsRes, providersRes] = await Promise.all([
      browserAPI.runtime.sendMessage({ type: 'llm_list_configured_models' }) as Promise<{
        ok: boolean;
        models?: ConfiguredModel[];
        error?: string;
      }>,
      browserAPI.runtime.sendMessage({ type: 'llm_list_models' }) as Promise<{
        ok: boolean;
        models?: ModelInfo[];
        error?: string;
      }>,
      browserAPI.runtime.sendMessage({ type: 'llm_list_providers' }) as Promise<{
        ok: boolean;
        providers?: ProviderInfo[];
        error?: string;
      }>,
    ]);

    console.log('[Sidebar] configuredModelsRes:', JSON.stringify(configuredModelsRes));
    console.log('[Sidebar] modelsRes:', modelsRes.ok ? `${modelsRes.models?.length} models` : modelsRes.error);
    console.log('[Sidebar] providersRes:', providersRes.ok ? `${providersRes.providers?.length} providers` : providersRes.error);

    // Handle configured models
    const configuredModels = configuredModelsRes.ok ? (configuredModelsRes.models || []) : [];
    console.log('[Sidebar] Rendering configured models:', configuredModels.length);
    renderConfiguredModels(configuredModels);

    // Handle available models for dropdown
    const availableModels = modelsRes.ok ? (modelsRes.models || []) : [];
    cachedAvailableModels = availableModels;
    renderAvailableModelsDropdown(availableModels, configuredModels);

    // Handle providers
    const providers = providersRes.ok ? (providersRes.providers || []) : [];
    const availableCount = providers.filter(p => p.available || (p.is_local && p.configured)).length;
    
    providersCountEl.textContent = String(availableCount);
    renderProviders(providers);

    // Update header status based on configured models
    if (configuredModels.length > 0) {
      llmStatusIndicator.className = 'status-indicator connected';
      llmStatusText.className = 'status-text connected';
      llmStatusText.textContent = `${configuredModels.length} model${configuredModels.length > 1 ? 's' : ''}`;
    } else if (availableModels.length > 0) {
      llmStatusIndicator.className = 'status-indicator connecting';
      llmStatusText.className = 'status-text connecting';
      llmStatusText.textContent = 'No models configured';
    } else {
      llmStatusIndicator.className = 'status-indicator disconnected';
      llmStatusText.className = 'status-text disconnected';
      llmStatusText.textContent = 'No models';
    }
    
  } catch (err) {
    console.error('[Sidebar] Failed to load LLM data:', err);
    llmStatusIndicator.className = 'status-indicator disconnected';
    llmStatusText.className = 'status-text disconnected';
    llmStatusText.textContent = 'Offline';
    configuredModelsEl.innerHTML = '<div class="no-models">Bridge not connected</div>';
  }
}

// Render configured models list
function renderConfiguredModels(models: ConfiguredModel[]): void {
  configuredModelsEl.innerHTML = '';
  
  if (models.length === 0) {
    configuredModelsEl.innerHTML = '<div class="no-models">No models configured. Add one below.</div>';
    return;
  }
  
  for (const model of models) {
    const el = document.createElement('div');
    el.className = `configured-model ${model.is_default ? 'is-default' : ''}`;
    
    el.innerHTML = `
      <div class="configured-model-info">
        <div class="configured-model-name">
          ${model.name}
          ${model.is_default ? '<span class="badge badge-success">Default</span>' : ''}
        </div>
        <div class="configured-model-id">${model.model_id}</div>
      </div>
      <div class="configured-model-actions">
        <button class="btn btn-ghost btn-sm test-model-btn" data-model="${model.model_id}" title="Test connection">⚡</button>
        ${!model.is_default ? `<button class="btn btn-ghost btn-sm set-default-model-btn" data-name="${model.name}" title="Set as default">★</button>` : ''}
        <button class="btn btn-ghost btn-sm remove-model-btn" data-name="${model.name}" title="Remove">✕</button>
      </div>
    `;
    
    configuredModelsEl.appendChild(el);
  }
  
  // Event listeners
  configuredModelsEl.querySelectorAll('.test-model-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const modelId = (btn as HTMLElement).dataset.model;
      if (!modelId) return;
      
      const originalText = btn.textContent;
      btn.textContent = '...';
      (btn as HTMLButtonElement).disabled = true;
      
      try {
        const result = await browserAPI.runtime.sendMessage({ 
          type: 'llm_test_model', 
          model: modelId 
        }) as { ok: boolean; response?: string; error?: string };
        
        if (result.ok) {
          showToast(`✓ Model works! Response: "${result.response?.slice(0, 50)}..."`, 'success');
        } else {
          showToast(`✗ Test failed: ${result.error}`, 'error');
        }
      } catch (err) {
        showToast(`✗ Test failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      } finally {
        btn.textContent = originalText;
        (btn as HTMLButtonElement).disabled = false;
      }
    });
  });
  
  configuredModelsEl.querySelectorAll('.set-default-model-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = (btn as HTMLElement).dataset.name;
      if (!name) return;
      await browserAPI.runtime.sendMessage({ type: 'llm_set_configured_model_default', name });
      await loadLlmProviders();
    });
  });
  
  configuredModelsEl.querySelectorAll('.remove-model-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = (btn as HTMLElement).dataset.name;
      if (!name) return;
      await browserAPI.runtime.sendMessage({ type: 'llm_remove_configured_model', name });
      await loadLlmProviders();
      showToast(`Removed "${name}"`);
    });
  });
}

// Render available models dropdown
function renderAvailableModelsDropdown(models: ModelInfo[], configured: ConfiguredModel[]): void {
  const configuredIds = new Set(configured.map(c => c.model_id));
  
  availableModelsSelect.innerHTML = '<option value="">Select a model to add...</option>';
  
  // Filter out already configured models
  const available = models.filter(m => !configuredIds.has(m.id));
  
  if (available.length === 0) {
    availableModelsSelect.innerHTML = '<option value="">No more models available</option>';
    addModelBtn.disabled = true;
    return;
  }
  
  for (const model of available) {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.id;
    availableModelsSelect.appendChild(option);
  }
}

// Render providers list
function renderProviders(providers: ProviderInfo[]): void {
  detectedProvidersEl.innerHTML = '';
  
  const localProviders = providers.filter(p => p.is_local);
  const cloudProviders = providers.filter(p => !p.is_local);
  
  for (const provider of [...localProviders, ...cloudProviders]) {
    const isAvailable = provider.available || (provider.is_local && provider.configured);
    const needsConfig = !provider.is_local && !provider.has_api_key;
    
    const el = document.createElement('div');
    el.className = `detected-provider ${isAvailable ? 'available' : needsConfig ? 'needs-config' : 'unavailable'}`;
    
    let statusText = '';
    let statusClass = '';
    if (isAvailable) {
      statusText = '● Running';
      statusClass = 'available';
    } else if (provider.is_local) {
      statusText = '○ Not detected';
      statusClass = 'unavailable';
    } else if (needsConfig) {
      statusText = '○ Needs API key';
      statusClass = 'needs-config';
    } else {
      statusText = '● Ready';
      statusClass = 'available';
    }
    
    let actionHtml = '';
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
  
  // Event listeners for configure buttons
  detectedProvidersEl.querySelectorAll('.configure-provider-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const providerType = (btn as HTMLElement).dataset.provider;
      if (providerType) showApiKeyConfig(providerType);
    });
  });
}

// Available models dropdown change handler
availableModelsSelect.addEventListener('change', () => {
  addModelBtn.disabled = !availableModelsSelect.value;
});

// Add model button
addModelBtn.addEventListener('click', async () => {
  const modelId = availableModelsSelect.value;
  if (!modelId) return;
  
  console.log('[Sidebar] Adding model:', modelId);
  addModelBtn.disabled = true;
  try {
    const response = await browserAPI.runtime.sendMessage({
      type: 'llm_add_configured_model',
      model_id: modelId,
    }) as { ok: boolean; name?: string; error?: string };
    
    console.log('[Sidebar] Add model response:', JSON.stringify(response));
    
    if (response.ok) {
      showToast(`Added "${response.name}"`, 'success');
      console.log('[Sidebar] Refreshing model list after add...');
      await loadLlmProviders();
      console.log('[Sidebar] Refresh complete');
    } else {
      const errorMsg = response.error || 'Unknown error';
      console.error('[Harbor] Failed to add model:', errorMsg);
      showToast(`Failed to add model: ${errorMsg}`, 'error');
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('[Harbor] Failed to add model:', errorMsg);
    showToast(`Failed to add model: ${errorMsg}`, 'error');
  }
  addModelBtn.disabled = false;
});

// LLM providers are loaded when bridge becomes ready (see checkBridgeStatus)
// Don't call loadLlmProviders() here - it causes a race condition

// =============================================================================
// Permissions Panel
// =============================================================================

const permissionsPanelHeader = document.getElementById('permissions-panel-header') as HTMLDivElement;
const permissionsPanelToggle = document.getElementById('permissions-panel-toggle') as HTMLSpanElement;
const permissionsList = document.getElementById('permissions-list') as HTMLDivElement;
const refreshPermissionsBtn = document.getElementById('refresh-permissions-btn') as HTMLButtonElement;

type PermissionStatusEntry = {
  origin: string;
  scopes: Record<string, string>;
  allowedTools?: string[];
  source?: 'harbor' | 'web-agents-api';
};

async function loadPermissions(): Promise<void> {
  try {
    const response = await browserAPI.runtime.sendMessage({ type: 'list_all_permissions' }) as {
      type: string;
      permissions?: PermissionStatusEntry[];
    };

    if (response?.permissions) {
      renderPermissions(response.permissions);
    }
  } catch (err) {
    console.error('[Sidebar] Failed to load permissions:', err);
    permissionsList.innerHTML = '<div class="empty-state">Failed to load permissions.</div>';
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderPermissions(permissions: PermissionStatusEntry[]): void {
  if (permissions.length === 0) {
    permissionsList.innerHTML = '<div class="empty-state">No site permissions granted yet.</div>';
    return;
  }

  permissionsList.innerHTML = permissions.map((perm) => {
    const grantedScopes = Object.entries(perm.scopes)
      .filter(([, status]) => status === 'granted-always' || status === 'granted-once')
      .map(([scope, status]) => ({ scope, status }));

    const deniedScopes = Object.entries(perm.scopes)
      .filter(([, status]) => status === 'denied')
      .map(([scope]) => scope);

    const scopeBadges = [
      ...grantedScopes.map(({ scope, status }) => {
        const label = scope.split(':')[1] || scope;
        const isOnce = status === 'granted-once';
        const badgeClass = isOnce ? 'permission-scope-badge temporary' : 'permission-scope-badge';
        const suffix = isOnce ? ' <span class="permission-temp-label">⏱</span>' : '';
        return `<span class="${badgeClass}">${escapeHtml(label)}${suffix}</span>`;
      }),
      ...deniedScopes.map((scope) => {
        const label = scope.split(':')[1] || scope;
        return `<span class="permission-scope-badge denied">${escapeHtml(label)} ✕</span>`;
      }),
    ].join('');

    let toolsHtml = '';
    if (perm.allowedTools && perm.allowedTools.length > 0) {
      const toolBadges = perm.allowedTools.map((tool) => {
        const toolName = tool.split('/')[1] || tool;
        return `<span class="permission-tool-badge">${escapeHtml(toolName)}</span>`;
      }).join('');

      toolsHtml = `
        <div class="permission-tools-section">
          <div class="permission-tools-title">Allowed Tools</div>
          <div class="permission-tools-list">${toolBadges}</div>
        </div>
      `;
    }

    const sourceLabel = perm.source === 'web-agents-api' ? 'Web Agents API' : 'Harbor';
    const sourceBadge = `<span class="permission-source-badge ${perm.source || 'harbor'}">${escapeHtml(sourceLabel)}</span>`;

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
          <button class="btn btn-sm btn-danger revoke-permissions-btn" data-origin="${escapeHtml(perm.origin)}" data-source="${escapeHtml(perm.source || 'harbor')}">Revoke All</button>
        </div>
      </div>
    `;
  }).join('');

  // Add event listeners for revoke buttons
  permissionsList.querySelectorAll('.revoke-permissions-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const origin = (btn as HTMLElement).dataset.origin!;
      const source = (btn as HTMLElement).dataset.source;
      if (!confirm(`Revoke all permissions for ${origin}?`)) return;

      try {
        await browserAPI.runtime.sendMessage({ type: 'revoke_origin_permissions', origin, source });
        await loadPermissions();
        showToast('Permissions revoked');
      } catch (err) {
        console.error('[Sidebar] Failed to revoke permissions:', err);
        showToast('Failed to revoke permissions', 'error');
      }
    });
  });
}

// Setup permissions panel toggle
setupPanelToggle(permissionsPanelHeader, permissionsPanelToggle, permissionsList);

// Refresh permissions button
refreshPermissionsBtn?.addEventListener('click', async (e) => {
  e.stopPropagation();
  refreshPermissionsBtn.disabled = true;
  await loadPermissions();
  refreshPermissionsBtn.disabled = false;
});

// Listen for permission changes from background
browserAPI.runtime.onMessage.addListener((message) => {
  if (message?.type === 'permissions_changed') {
    loadPermissions();
  }
  return false;
});

// Load permissions on startup
loadPermissions();

// =============================================================================
// OAuth App Credentials Panel
// =============================================================================

const oauthProviderConfigs: Array<{ id: string; name: string; icon: string; helpUrl: string }> = [
  {
    id: 'google',
    name: 'Google',
    icon: '🔵',
    helpUrl: 'https://console.cloud.google.com/apis/credentials',
  },
  {
    id: 'github',
    name: 'GitHub',
    icon: '⚫',
    helpUrl: 'https://github.com/settings/developers',
  },
];

async function loadOAuthCredentialsStatus(): Promise<void> {
  try {
    const response = await browserAPI.runtime.sendMessage({ type: 'oauth_get_credentials_status' }) as {
      ok: boolean;
      providers?: Record<string, { configured: boolean; client_id_preview?: string }>;
      error?: string;
    };

    if (response?.ok && response.providers) {
      renderOAuthProviders(response.providers);
      
      // Update header status
      const configuredCount = Object.values(response.providers).filter(p => p.configured).length;
      if (configuredCount > 0) {
        oauthStatusIndicator.className = 'status-indicator connected';
        oauthStatusText.className = 'status-text connected';
        oauthStatusText.textContent = `${configuredCount} configured`;
      } else {
        oauthStatusIndicator.className = 'status-indicator disconnected';
        oauthStatusText.className = 'status-text disconnected';
        oauthStatusText.textContent = 'Not configured';
      }
    } else {
      // Bridge not connected or error - show a simple message, don't block
      oauthProvidersList.innerHTML = '<div class="no-providers">Waiting for bridge...</div>';
      oauthStatusIndicator.className = 'status-indicator connecting';
      oauthStatusText.className = 'status-text connecting';
      oauthStatusText.textContent = 'Loading...';
    }
  } catch (err) {
    console.error('[Sidebar] Failed to load OAuth credentials status:', err);
    oauthProvidersList.innerHTML = '<div class="no-providers">Failed to load</div>';
    oauthStatusIndicator.className = 'status-indicator disconnected';
    oauthStatusText.className = 'status-text disconnected';
    oauthStatusText.textContent = 'Error';
  }
}

function renderOAuthProviders(providers: Record<string, { configured: boolean; client_id_preview?: string }>): void {
  oauthProvidersList.innerHTML = '';
  
  for (const config of oauthProviderConfigs) {
    const status = providers[config.id];
    const isConfigured = status?.configured ?? false;
    
    const el = document.createElement('div');
    el.className = `detected-provider ${isConfigured ? 'available' : 'needs-config'}`;
    
    const statusText = isConfigured 
      ? `✓ Configured${status?.client_id_preview ? ` (${status.client_id_preview})` : ''}`
      : '○ Not configured';
    const statusClass = isConfigured ? 'available' : 'needs-config';
    
    const actionHtml = isConfigured
      ? `<button class="btn btn-ghost btn-sm oauth-remove-btn" data-provider="${config.id}" title="Remove credentials">✕</button>`
      : `<button class="btn btn-secondary btn-sm oauth-configure-btn" data-provider="${config.id}">Configure</button>`;
    
    el.innerHTML = `
      <div class="detected-provider-info">
        <div class="detected-provider-name">${config.icon} ${config.name}</div>
        <div class="detected-provider-status ${statusClass}">${statusText}</div>
      </div>
      <div class="detected-provider-action">${actionHtml}</div>
    `;
    
    oauthProvidersList.appendChild(el);
  }
  
  // Event listeners for configure buttons
  oauthProvidersList.querySelectorAll('.oauth-configure-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const provider = (btn as HTMLElement).dataset.provider;
      if (provider) showOAuthConfigForm(provider);
    });
  });
  
  // Event listeners for remove buttons
  oauthProvidersList.querySelectorAll('.oauth-remove-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const provider = (btn as HTMLElement).dataset.provider;
      if (!provider) return;
      if (!confirm(`Remove ${provider} OAuth credentials?`)) return;
      
      (btn as HTMLButtonElement).disabled = true;
      try {
        const response = await browserAPI.runtime.sendMessage({
          type: 'oauth_remove_credentials',
          provider,
        }) as { ok: boolean; error?: string };
        
        if (response.ok) {
          showToast(`Removed ${provider} credentials`);
          await loadOAuthCredentialsStatus();
        } else {
          showToast(`Failed: ${response.error}`, 'error');
        }
      } catch (err) {
        showToast('Failed to remove credentials', 'error');
      }
      (btn as HTMLButtonElement).disabled = false;
    });
  });
}

function showOAuthConfigForm(provider: string): void {
  configuringOAuthProvider = provider;
  const config = oauthProviderConfigs.find(p => p.id === provider);
  const displayName = config?.name ?? provider;
  
  oauthConfigProviderName.textContent = `Configure ${displayName}`;
  oauthHelpLink.href = config?.helpUrl ?? '#';
  oauthClientIdInput.value = '';
  oauthClientSecretInput.value = '';
  oauthConfigForm.style.display = 'block';
  oauthClientIdInput.focus();
}

function hideOAuthConfigForm(): void {
  configuringOAuthProvider = null;
  oauthConfigForm.style.display = 'none';
  oauthClientIdInput.value = '';
  oauthClientSecretInput.value = '';
}

// OAuth config save button
oauthConfigSaveBtn?.addEventListener('click', async () => {
  if (!configuringOAuthProvider) return;
  
  const clientId = oauthClientIdInput.value.trim();
  const clientSecret = oauthClientSecretInput.value.trim();
  
  if (!clientId || !clientSecret) {
    showToast('Please enter both Client ID and Client Secret', 'error');
    return;
  }
  
  oauthConfigSaveBtn.disabled = true;
  oauthConfigSaveBtn.textContent = 'Saving...';
  
  try {
    const response = await browserAPI.runtime.sendMessage({
      type: 'oauth_set_credentials',
      provider: configuringOAuthProvider,
      client_id: clientId,
      client_secret: clientSecret,
    }) as { ok: boolean; error?: string };
    
    if (response.ok) {
      showToast(`${configuringOAuthProvider} credentials saved!`, 'success');
      hideOAuthConfigForm();
      await loadOAuthCredentialsStatus();
    } else {
      showToast(`Failed: ${response.error}`, 'error');
    }
  } catch (err) {
    showToast('Failed to save credentials', 'error');
    console.error('Failed to save OAuth credentials:', err);
  }
  
  oauthConfigSaveBtn.disabled = false;
  oauthConfigSaveBtn.textContent = 'Save';
});

// OAuth config cancel button
oauthConfigCancelBtn?.addEventListener('click', hideOAuthConfigForm);

// Setup OAuth panel toggle
setupPanelToggle(oauthPanelHeader, oauthPanelToggle, oauthPanelBody);

// Load OAuth credentials status on startup (with retry until bridge is ready)
(async function loadOAuthWithRetry() {
  const maxRetries = 10;
  const retryDelay = 1000;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await browserAPI.runtime.sendMessage({ type: 'oauth_get_credentials_status' }) as {
        ok: boolean;
        providers?: Record<string, { configured: boolean; client_id_preview?: string }>;
      };
      
      if (response?.ok && response.providers) {
        renderOAuthProviders(response.providers);
        const configuredCount = Object.values(response.providers).filter(p => p.configured).length;
        if (configuredCount > 0) {
          oauthStatusIndicator.className = 'status-indicator connected';
          oauthStatusText.className = 'status-text connected';
          oauthStatusText.textContent = `${configuredCount} configured`;
        } else {
          oauthStatusIndicator.className = 'status-indicator disconnected';
          oauthStatusText.className = 'status-text disconnected';
          oauthStatusText.textContent = 'Not configured';
        }
        return; // Success, stop retrying
      }
    } catch {
      // Will retry
    }
    
    // Wait before retrying
    await new Promise(resolve => setTimeout(resolve, retryDelay));
  }
  
  // Max retries reached
  console.warn('[Sidebar] Failed to load OAuth status after retries');
})();

// =============================================================================
// Quick Actions Panel
// =============================================================================

const quickActionsHeader = document.getElementById('quick-actions-header') as HTMLDivElement;
const quickActionsToggle = document.getElementById('quick-actions-toggle') as HTMLSpanElement;
const quickActionsBody = document.getElementById('quick-actions-body') as HTMLDivElement;
const openDirectoryBtn = document.getElementById('open-directory-btn') as HTMLButtonElement;
const openChatBtn = document.getElementById('open-chat-btn') as HTMLButtonElement;
const reloadExtensionBtn = document.getElementById('reload-extension-btn') as HTMLButtonElement;

// Set up panel toggle
setupPanelToggle(quickActionsHeader, quickActionsToggle, quickActionsBody);

// Open Directory button - opens the MCP server directory
openDirectoryBtn.addEventListener('click', async () => {
  try {
    const directoryUrl = browserAPI.runtime.getURL('directory.html');
    console.log('[Sidebar] Opening directory at:', directoryUrl);
    await browserAPI.tabs.create({ url: directoryUrl });
  } catch (err) {
    console.error('[Sidebar] Failed to open directory:', err);
    showToast('Failed to open directory');
  }
});

// Open Chat button - opens the chat demo in a new tab
openChatBtn.addEventListener('click', async () => {
  try {
    // The demo is at the extension root level
    const chatUrl = browserAPI.runtime.getURL('demo/chat-poc/index.html');
    console.log('[Sidebar] Opening chat at:', chatUrl);
    await browserAPI.tabs.create({ url: chatUrl });
  } catch (err) {
    console.error('[Sidebar] Failed to open chat:', err);
    showToast('Failed to open chat');
  }
});

// Reload Extension button
reloadExtensionBtn.addEventListener('click', async () => {
  try {
    await browserAPI.runtime.reload();
  } catch (err) {
    console.error('[Sidebar] Failed to reload:', err);
    showToast('Failed to reload extension');
  }
});

// =============================================================================
// Tool Tester Panel
// =============================================================================

const toolTesterHeader = document.getElementById('tool-tester-header') as HTMLDivElement;
const toolTesterToggle = document.getElementById('tool-tester-toggle') as HTMLSpanElement;
const toolTesterBody = document.getElementById('tool-tester-body') as HTMLDivElement;
const toolTesterServerSelect = document.getElementById('tool-tester-server') as HTMLSelectElement;
const toolTesterToolSelect = document.getElementById('tool-tester-tool') as HTMLSelectElement;
const toolTesterSchemaDiv = document.getElementById('tool-tester-schema') as HTMLDivElement;
const toolTesterArgsInput = document.getElementById('tool-tester-args') as HTMLTextAreaElement;
const toolTesterHint = document.getElementById('tool-tester-hint') as HTMLDivElement;
const toolTesterRunBtn = document.getElementById('tool-tester-run') as HTMLButtonElement;
const toolTesterResultDiv = document.getElementById('tool-tester-result') as HTMLDivElement;
const toolTesterOutput = document.getElementById('tool-tester-output') as HTMLElement;
const toolTesterParsed = document.getElementById('tool-tester-parsed') as HTMLDivElement;
const toolTesterCopyBtn = document.getElementById('tool-tester-copy') as HTMLButtonElement;

function renderSearchResultParsed(data: Record<string, unknown>): string {
  const query = typeof data.query === 'string' ? data.query : '';
  const articles = Array.isArray(data.articles) ? data.articles : [];
  const urls = Array.isArray(data.articleUrls) ? data.articleUrls : [];
  const parts: string[] = [];
  if (query) parts.push(`<div class="form-label" style="margin-bottom: var(--space-1);">Query: ${escapeHtml(query)}</div>`);
  if (articles.length > 0) {
    parts.push('<table style="width:100%; border-collapse: collapse; margin-bottom: var(--space-2);"><thead><tr><th style="text-align:left; padding: 4px 6px; border-bottom: 1px solid var(--border);">Title</th><th style="text-align:left; padding: 4px 6px; border-bottom: 1px solid var(--border);">Author</th><th style="text-align:left; padding: 4px 6px; border-bottom: 1px solid var(--border);">Date</th></tr></thead><tbody>');
    for (const a of articles.slice(0, 20)) {
      const row = a as Record<string, unknown>;
      const title = escapeHtml(String(row.title ?? ''));
      const author = escapeHtml(String(row.author ?? ''));
      const date = escapeHtml(String(row.date ?? row.dateISO ?? ''));
      parts.push(`<tr><td style="padding: 4px 6px; border-bottom: 1px solid var(--border);">${title}</td><td style="padding: 4px 6px; border-bottom: 1px solid var(--border);">${author}</td><td style="padding: 4px 6px; border-bottom: 1px solid var(--border);">${date}</td></tr>`);
    }
    parts.push('</tbody></table>');
    if (articles.length > 20) parts.push(`<div style="color: var(--text-muted);">… and ${articles.length - 20} more</div>`);
  }
  if (urls.length > 0) parts.push(`<div style="color: var(--text-muted);">Article URLs: ${urls.length}</div>`);
  return parts.join('');
}

type ToolInfo = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

type ServerWithTools = {
  id: string;
  name: string;
  running: boolean;
  tools?: ToolInfo[];
};

let cachedServersWithTools: ServerWithTools[] = [];

// Setup panel toggle
setupPanelToggle(toolTesterHeader, toolTesterToggle, toolTesterBody);

// Load servers into the dropdown when panel opens
async function loadToolTesterServers(): Promise<void> {
  try {
    const response = await browserAPI.runtime.sendMessage({ type: 'sidebar_get_servers' });
    console.log('[Tool Tester] Got servers response:', response);
    if (!response?.ok) return;
    
    cachedServersWithTools = response.servers as ServerWithTools[];
    console.log('[Tool Tester] Servers:', cachedServersWithTools.map(s => ({ 
      id: s.id, 
      name: s.name, 
      running: s.running, 
      toolCount: s.tools?.length 
    })));
    
    // Populate server dropdown
    const runningIds = new Set(cachedServersWithTools.filter((s) => s.running).map((s) => s.id));
    toolTesterServerSelect.innerHTML = '<option value="">Select a server...</option>';
    for (const server of cachedServersWithTools) {
      if (server.running) {
        const option = document.createElement('option');
        option.value = server.id;
        const toolCount = server.tools?.length || 0;
        option.textContent = `${server.name} (${toolCount} tools)`;
        toolTesterServerSelect.appendChild(option);
      }
    }
    // If currently selected server is no longer running/listed, clear selection and tools
    const currentId = toolTesterServerSelect.value;
    if (currentId && !runningIds.has(currentId)) {
      toolTesterServerSelect.value = '';
      toolTesterToolSelect.innerHTML = '<option value="">Select a tool...</option>';
      toolTesterSchemaDiv.style.display = 'none';
      toolTesterRunBtn.disabled = true;
      toolTesterResultDiv.style.display = 'none';
    }
  } catch (err) {
    console.error('[Sidebar] Failed to load servers for tool tester:', err);
  }
}

// When server is selected, populate tools dropdown
toolTesterServerSelect.addEventListener('change', async () => {
  const serverId = toolTesterServerSelect.value;
  toolTesterToolSelect.innerHTML = '<option value="">Loading tools...</option>';
  toolTesterToolSelect.disabled = true;
  toolTesterSchemaDiv.style.display = 'none';
  toolTesterRunBtn.disabled = true;
  toolTesterResultDiv.style.display = 'none';
  
  if (!serverId) {
    toolTesterToolSelect.innerHTML = '<option value="">Select a tool...</option>';
    return;
  }
  
  // Try to get tools from cached data first
  let server = cachedServersWithTools.find(s => s.id === serverId);
  let tools = server?.tools || [];
  
  // If no tools in cache, fetch them via tools/list
  if (tools.length === 0) {
    console.log('[Tool Tester] No cached tools, fetching via MCP...');
    try {
      const listResponse = await browserAPI.runtime.sendMessage({
        type: 'mcp_call_method',
        serverId,
        method: 'tools/list',
      });
      console.log('[Tool Tester] tools/list response:', listResponse);
      if (listResponse?.ok && listResponse.result?.tools) {
        tools = listResponse.result.tools;
        // Update cache
        if (server) {
          server.tools = tools;
        }
      }
    } catch (err) {
      console.error('[Tool Tester] Failed to fetch tools:', err);
    }
  }
  
  toolTesterToolSelect.innerHTML = '<option value="">Select a tool...</option>';
  
  if (tools.length === 0) {
    toolTesterToolSelect.innerHTML = '<option value="">No tools available</option>';
    return;
  }
  
  toolTesterToolSelect.disabled = false;
  for (const tool of tools) {
    const option = document.createElement('option');
    option.value = tool.name;
    option.textContent = tool.name;
    toolTesterToolSelect.appendChild(option);
  }
});

// When tool is selected, show schema and enable run button
toolTesterToolSelect.addEventListener('change', () => {
  const serverId = toolTesterServerSelect.value;
  const toolName = toolTesterToolSelect.value;
  
  toolTesterSchemaDiv.style.display = 'none';
  toolTesterRunBtn.disabled = true;
  toolTesterResultDiv.style.display = 'none';
  
  if (!serverId || !toolName) return;
  
  const server = cachedServersWithTools.find(s => s.id === serverId);
  const tool = server?.tools?.find(t => t.name === toolName);
  
  if (!tool) return;
  
  toolTesterSchemaDiv.style.display = 'block';
  toolTesterRunBtn.disabled = false;
  
  // Show description and schema hint
  let hint = tool.description || 'No description';
  if (tool.inputSchema) {
    const schema = tool.inputSchema as { required?: string[]; properties?: Record<string, { type?: string; description?: string }> };
    const required = schema.required || [];
    const props = schema.properties || {};
    const propHints = Object.entries(props).map(([key, val]) => {
      const req = required.includes(key) ? ' (required)' : '';
      return `• ${key}: ${val.type || 'any'}${req}${val.description ? ' - ' + val.description : ''}`;
    });
    if (propHints.length > 0) {
      hint += '\n\nParameters:\n' + propHints.join('\n');
    }
  }
  toolTesterHint.textContent = hint;
  toolTesterHint.style.whiteSpace = 'pre-wrap';
  
  // Pre-populate args with empty object or example
  if (tool.inputSchema) {
    const schema = tool.inputSchema as { properties?: Record<string, unknown> };
    const props = schema.properties || {};
    const example: Record<string, string> = {};
    for (const key of Object.keys(props)) {
      example[key] = '';
    }
    toolTesterArgsInput.value = JSON.stringify(example, null, 2);
  } else {
    toolTesterArgsInput.value = '{}';
  }
});

// Run the tool
toolTesterRunBtn.addEventListener('click', async () => {
  const serverId = toolTesterServerSelect.value;
  const toolName = toolTesterToolSelect.value;
  
  if (!serverId || !toolName) return;
  
  let args: Record<string, unknown> = {};
  try {
    const argsText = toolTesterArgsInput.value.trim();
    if (argsText) {
      args = JSON.parse(argsText);
    }
  } catch (err) {
    showToast('Invalid JSON in arguments', 'error');
    return;
  }
  
  toolTesterRunBtn.disabled = true;
  toolTesterRunBtn.textContent = 'Running...';
  toolTesterResultDiv.style.display = 'block';
  toolTesterOutput.textContent = 'Executing...';
  toolTesterParsed.style.display = 'none';
  toolTesterParsed.innerHTML = '';

  try {
    console.log(`[Tool Tester] Calling ${serverId}/${toolName} with:`, args);
    const response = await browserAPI.runtime.sendMessage({
      type: 'sidebar_call_tool',
      serverId,
      toolName,
      args,
    });
    
    console.log('[Tool Tester] Response:', response);
    
    if (response?.ok) {
      const result = response.result as Record<string, unknown> | undefined;
      toolTesterOutput.textContent = JSON.stringify(response.result, null, 2);
      // Show parsed view when result has searchResult or when content contains JSON we can parse
      let data = result?.searchResult as Record<string, unknown> | undefined;
      if (!data && result?.content && Array.isArray(result.content)) {
        const second = result.content[1] as { type?: string; text?: string; mediaType?: string } | undefined;
        if (second?.text && second.mediaType === 'application/json') {
          try {
            data = JSON.parse(second.text) as Record<string, unknown>;
          } catch {
            data = undefined;
          }
        }
      }
      if (data && (data.articles || data.query !== undefined)) {
        toolTesterParsed.style.display = 'block';
        toolTesterParsed.innerHTML = renderSearchResultParsed(data);
      } else {
        toolTesterParsed.style.display = 'none';
        toolTesterParsed.innerHTML = '';
      }
    } else {
      toolTesterOutput.textContent = `Error: ${response?.error || 'Unknown error'}`;
      toolTesterParsed.style.display = 'none';
      toolTesterParsed.innerHTML = '';
    }
  } catch (err) {
    console.error('[Tool Tester] Error:', err);
    toolTesterOutput.textContent = `Exception: ${err instanceof Error ? err.message : String(err)}`;
  }
  
  toolTesterRunBtn.disabled = false;
  toolTesterRunBtn.textContent = 'Run Tool';
});

toolTesterCopyBtn?.addEventListener('click', async () => {
  const text = toolTesterOutput?.textContent ?? '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toolTesterCopyBtn.textContent = 'Copied!';
    setTimeout(() => { toolTesterCopyBtn.textContent = 'Copy'; }, 1500);
  } catch (e) {
    console.warn('[Tool Tester] Copy failed:', e);
  }
});

// Load servers when the panel body becomes visible (on expand)
toolTesterHeader.addEventListener('click', () => {
  // Small delay to let the toggle happen first
  setTimeout(() => {
    if (!toolTesterBody.classList.contains('collapsed')) {
      loadToolTesterServers();
    }
  }, 50);
});

// =============================================================================
// Agent Sessions Panel
// =============================================================================

type SessionSummary = {
  sessionId: string;
  type: 'implicit' | 'explicit';
  origin: string;
  status: 'active' | 'suspended' | 'terminated';
  name?: string;
  createdAt: number;
  lastActiveAt: number;
  capabilities: {
    hasLLM: boolean;
    toolCount: number;
    hasBrowserAccess: boolean;
  };
  usage: {
    promptCount: number;
    toolCallCount: number;
  };
};

const sessionsPanelHeader = document.getElementById('sessions-panel-header') as HTMLDivElement;
const sessionsPanelToggle = document.getElementById('sessions-panel-toggle') as HTMLSpanElement;
const sessionsList = document.getElementById('sessions-list') as HTMLDivElement;
const sessionsStatusIndicator = document.getElementById('sessions-status-indicator') as HTMLDivElement;
const sessionsCount = document.getElementById('sessions-count') as HTMLSpanElement;
const refreshSessionsBtn = document.getElementById('refresh-sessions-btn') as HTMLButtonElement;

async function loadSessions(): Promise<void> {
  try {
    const response = await browserAPI.runtime.sendMessage({ type: 'session.list' }) as {
      ok: boolean;
      sessions?: SessionSummary[];
      error?: string;
    };

    if (response?.ok && response.sessions) {
      renderSessions(response.sessions);
      
      // Update status indicator
      const activeCount = response.sessions.filter(s => s.status === 'active').length;
      if (activeCount > 0) {
        sessionsStatusIndicator.className = 'status-indicator connected';
        sessionsCount.className = 'status-text connected';
        sessionsCount.textContent = String(activeCount);
      } else {
        sessionsStatusIndicator.className = 'status-indicator disconnected';
        sessionsCount.className = 'status-text disconnected';
        sessionsCount.textContent = '0';
      }
    } else {
      sessionsList.innerHTML = '<div class="empty-state">Failed to load sessions.</div>';
    }
  } catch (err) {
    console.error('[Sidebar] Failed to load sessions:', err);
    sessionsList.innerHTML = '<div class="empty-state">Failed to load sessions.</div>';
  }
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function renderSessions(sessions: SessionSummary[]): void {
  if (sessions.length === 0) {
    sessionsList.innerHTML = '<div class="empty-state">No active sessions.</div>';
    return;
  }

  // Sort: active first, then by lastActiveAt descending
  const sorted = [...sessions].sort((a, b) => {
    if (a.status === 'active' && b.status !== 'active') return -1;
    if (a.status !== 'active' && b.status === 'active') return 1;
    return b.lastActiveAt - a.lastActiveAt;
  });

  sessionsList.innerHTML = sorted.map((session) => {
    const typeClass = session.type === 'explicit' ? 'explicit' : 'implicit';
    const statusClass = session.status === 'terminated' ? 'terminated' : '';
    const displayName = session.name || (session.type === 'implicit' ? 'Anonymous Session' : 'Agent Session');
    
    // Build capability badges
    const capBadges: string[] = [];
    if (session.capabilities.hasLLM) {
      capBadges.push('<span class="session-cap-badge llm">LLM</span>');
    }
    if (session.capabilities.toolCount > 0) {
      capBadges.push(`<span class="session-cap-badge tools">${session.capabilities.toolCount} Tools</span>`);
    }
    if (session.capabilities.hasBrowserAccess) {
      capBadges.push('<span class="session-cap-badge browser">Browser</span>');
    }
    
    // Truncate origin for display
    const originDisplay = session.origin.length > 40 
      ? session.origin.slice(0, 37) + '...' 
      : session.origin;

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
          ${capBadges.length > 0 ? capBadges.join('') : '<span style="color: var(--color-text-muted); font-size: 10px;">No capabilities</span>'}
        </div>
        <div class="session-stats">
          <span class="session-stat">💬 ${session.usage.promptCount} prompts</span>
          <span class="session-stat">⚡ ${session.usage.toolCallCount} tool calls</span>
        </div>
        ${session.status === 'active' ? `
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
  }).join('');

  // Add event listeners for terminate buttons
  sessionsList.querySelectorAll('.terminate-session-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const sessionId = (btn as HTMLElement).dataset.sessionId!;
      const origin = (btn as HTMLElement).dataset.origin!;
      
      (btn as HTMLButtonElement).disabled = true;
      (btn as HTMLButtonElement).textContent = '...';
      
      try {
        await browserAPI.runtime.sendMessage({
          type: 'session.terminate',
          sessionId,
          origin,
        });
        await loadSessions();
        showToast('Session terminated');
      } catch (err) {
        console.error('[Sidebar] Failed to terminate session:', err);
        showToast('Failed to terminate session', 'error');
      }
    });
  });
}

// Setup sessions panel toggle
setupPanelToggle(sessionsPanelHeader, sessionsPanelToggle, sessionsList);

// Refresh sessions button
refreshSessionsBtn?.addEventListener('click', async (e) => {
  e.stopPropagation();
  refreshSessionsBtn.disabled = true;
  await loadSessions();
  refreshSessionsBtn.disabled = false;
});

// Listen for session changes from background
browserAPI.runtime.onMessage.addListener((message) => {
  if (message?.type === 'session_created' || 
      message?.type === 'session_terminated' || 
      message?.type === 'session_updated') {
    loadSessions();
  }
  return false;
});

// Load sessions on startup
loadSessions();

// Auto-refresh sessions every 30 seconds
setInterval(loadSessions, 30000);

