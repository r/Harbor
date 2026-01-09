import browser from 'webextension-polyfill';

interface MCPServer {
  server_id: string;
  label: string;
  base_url: string;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  error_message?: string | null;
}

interface BridgeResponse {
  type: string;
  request_id: string;
  [key: string]: unknown;
}

interface ConnectionState {
  connected: boolean;
  lastMessage: BridgeResponse | null;
  error: string | null;
}

// Installed server types
interface InstalledServer {
  id: string;
  name: string;
  packageType: string;
  packageId: string;
  description?: string;
  homepageUrl?: string;
  requiredEnvVars: Array<{
    name: string;
    description?: string;
    isSecret?: boolean;
  }>;
}


interface InstalledServerStatus {
  installed: boolean;
  server?: InstalledServer;
  process?: {
    state: string;
    pid?: number;
  };
  missingSecrets?: string[];
  canStart?: boolean;
}

interface CredentialInfo {
  key: string;
  type: string;
  setAt: number;
  hasUsername?: boolean;
  isExpired?: boolean;
}

// Manifest types
interface McpManifest {
  manifestVersion: string;
  name: string;
  description?: string;
  repository?: string;
  package: {
    type: 'npm' | 'pypi' | 'docker' | 'binary';
    name: string;
  };
  runtime?: {
    hasNativeCode?: boolean;
  };
  execution?: {
    transport?: 'stdio' | 'http' | 'sse';
    dockerMode?: 'preferred' | 'optional' | 'incompatible' | 'required';
  };
  environment?: Array<{
    name: string;
    description: string;
    required?: boolean;
    type?: string;
    default?: string;
  }>;
  secrets?: Array<{
    name: string;
    description: string;
    required?: boolean;
    helpUrl?: string;
  }>;
  oauth?: {
    provider: string;
    supportedSources: Array<'host' | 'user' | 'server'>;
    preferredSource?: 'host' | 'user' | 'server';
    scopes: string[];
    description?: string;
    apis?: Array<{
      name: string;
      displayName: string;
      enableUrl?: string;
    }>;
    hostMode?: {
      tokenEnvVar?: string;
      refreshTokenEnvVar?: string;
    };
    userMode?: {
      clientCredentialsPath?: string;
      clientCredentialsEnvVar?: string;
    };
  };
}

interface ManifestInstallResult {
  serverId: string;
  server: InstalledServer;
  needsOAuth: boolean;
  oauthMode?: 'host' | 'user' | 'server';
}

interface OAuthCapabilityCheck {
  required: boolean;
  canHandle: boolean;
  recommendedSource?: 'host' | 'user' | 'server';
  hostModeAvailable?: boolean;
  userModeAvailable?: boolean;
  missingScopes?: string[];
  missingApis?: string[];
  reason?: string;
}

interface ManifestOAuthStatus {
  required: boolean;
  mode?: 'host' | 'user' | 'server';
  hasTokens: boolean;
  tokensValid: boolean;
  needsRefresh: boolean;
}

// LLM types
interface LLMModel {
  id: string;
  name: string;
  size: number;
  sizeHuman: string;
  description: string;
  supportsTools: boolean;
  recommended?: boolean;
}

interface OllamaInfo {
  version: string | null;
  supportsTools: boolean;
  minimumToolVersion: string;
  recommendedVersion: string;
  warning?: string;
}

interface LLMSetupStatus {
  available: boolean;
  runningProvider: 'llamafile' | 'ollama' | 'external' | null;
  runningUrl: string | null;
  downloadedModels: string[];
  activeModel: string | null;
  availableModels: LLMModel[];
  ollamaInfo?: OllamaInfo;
}

// LLM Provider Configuration types
interface LLMProviderStatus {
  id: string;
  name: string;
  available: boolean;
  baseUrl: string;
  version?: string;
  supportsTools?: boolean;
  models?: LLMModel[];
  error?: string;
  warning?: string;
  checkedAt: number;
}

interface LLMSupportedProviders {
  local: string[];
  remote: string[];
  configuredApiKeys: string[];
}

interface LLMConfig {
  providers: number;
  available: number;
  activeProvider: string | null;
  activeModel: string | null;
  configuredApiKeys: string[];
}

// Theme handling - synced across all extension pages via browser.storage
async function initTheme(): Promise<void> {
  // Try to get from browser.storage first (synced across pages)
  try {
    const result = await browser.storage.local.get('harbor-theme');
    const savedTheme = result['harbor-theme'] as string | undefined;
    if (savedTheme) {
      document.documentElement.setAttribute('data-theme', savedTheme);
      updateThemeIcon(savedTheme);
      return;
    }
  } catch (e) {
    // Fall back to localStorage
  }
  
  // Fall back to localStorage or system preference
  const localTheme = localStorage.getItem('harbor-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = localTheme || (prefersDark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
  updateThemeIcon(theme);
  
  // Save to browser.storage for sync
  try {
    await browser.storage.local.set({ 'harbor-theme': theme });
  } catch (e) {}
}

async function toggleTheme(): Promise<void> {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('harbor-theme', next);
  updateThemeIcon(next);
  
  // Sync to browser.storage so other pages pick it up
  try {
    await browser.storage.local.set({ 'harbor-theme': next });
  } catch (e) {}
}

// Listen for theme changes from other pages
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['harbor-theme']) {
    const newTheme = changes['harbor-theme'].newValue as string;
    document.documentElement.setAttribute('data-theme', newTheme);
    updateThemeIcon(newTheme);
  }
});

function updateThemeIcon(theme: string): void {
  const icon = document.getElementById('theme-icon');
  if (icon) {
    icon.textContent = theme === 'dark' ? '○' : '●';
  }
}

// Initialize theme immediately
initTheme();

// =============================================================================
// Dev Mode Detection
// =============================================================================

const devModeLink = document.getElementById('dev-mode-link') as HTMLAnchorElement;

/**
 * Check if running as a temporarily installed (development) extension.
 * If so, show a link to the debugging page for quick reload/inspect.
 */
async function checkDevMode(): Promise<void> {
  try {
    const self = await browser.management.getSelf();
    
    // installType is 'development' for temporary add-ons in Firefox
    if (self.installType === 'development') {
      devModeLink.style.display = 'inline-block';
      
      // Handle click - open debugging page in current window
      devModeLink.addEventListener('click', async (e) => {
        e.preventDefault();
        try {
          // Get the current active tab and update it to navigate to about:debugging
          const tabs = await browser.tabs.query({ active: true, currentWindow: true });
          if (tabs[0]?.id) {
            await browser.tabs.update(tabs[0].id, { url: 'about:debugging#/runtime/this-firefox' });
          } else {
            // Fallback: create a new tab
            await browser.tabs.create({ url: 'about:debugging#/runtime/this-firefox' });
          }
        } catch (err) {
          console.error('[Sidebar] Failed to open debugging page:', err);
          // Last resort: copy URL to clipboard and show message
          await navigator.clipboard.writeText('about:debugging#/runtime/this-firefox');
          alert('Could not open debugging page. URL copied to clipboard - paste it in a new tab.');
        }
      });
      
      console.log('[Sidebar] Running in development mode');
    }
  } catch (err) {
    // management API might not be available, silently ignore
    console.log('[Sidebar] Could not check install type:', err);
  }
}


// DOM Elements
const statusIndicator = document.getElementById('status-indicator') as HTMLDivElement;
const statusText = document.getElementById('status-text') as HTMLSpanElement;
const errorContainer = document.getElementById('error-container') as HTMLDivElement;
const sendHelloBtn = document.getElementById('send-hello') as HTMLButtonElement;
const reconnectBtn = document.getElementById('reconnect') as HTMLButtonElement;
const toolsCard = document.getElementById('tools-card') as HTMLDivElement;
const toolsResponse = document.getElementById('tools-response') as HTMLPreElement;
const openDirectoryBtn = document.getElementById('open-directory') as HTMLButtonElement;
const themeToggleBtn = document.getElementById('theme-toggle') as HTMLButtonElement;

// Installed servers elements
const installedServerListEl = document.getElementById('installed-server-list') as HTMLDivElement;
const credentialModal = document.getElementById('credential-modal') as HTMLDivElement;
const credentialModalTitle = document.getElementById('credential-modal-title') as HTMLHeadingElement;
const credentialModalBody = document.getElementById('credential-modal-body') as HTMLDivElement;
const credentialModalClose = document.getElementById('credential-modal-close') as HTMLButtonElement;
const credentialModalCancel = document.getElementById('credential-modal-cancel') as HTMLButtonElement;
const credentialModalSave = document.getElementById('credential-modal-save') as HTMLButtonElement;

// LLM elements
const llmStatusIndicator = document.getElementById('llm-status-indicator') as HTMLDivElement;
const llmStatusText = document.getElementById('llm-status-text') as HTMLSpanElement;
const llmDetails = document.getElementById('llm-details') as HTMLDivElement;
const llmDownloadSection = document.getElementById('llm-download-section') as HTMLDivElement;
const llmModelDropdown = document.getElementById('llm-model-dropdown') as HTMLSelectElement;
const llmDownloadBtn = document.getElementById('llm-download-btn') as HTMLButtonElement;
const llmProgressSection = document.getElementById('llm-progress-section') as HTMLDivElement;
const llmDownloadModelName = document.getElementById('llm-download-model-name') as HTMLSpanElement;
const llmProgressBar = document.getElementById('llm-progress-bar') as HTMLDivElement;
const llmProgressText = document.getElementById('llm-progress-text') as HTMLDivElement;
const llmControlSection = document.getElementById('llm-control-section') as HTMLDivElement;
const llmStartBtn = document.getElementById('llm-start-btn') as HTMLButtonElement;
const llmStopBtn = document.getElementById('llm-stop-btn') as HTMLButtonElement;
const llmDeleteBtn = document.getElementById('llm-delete-btn') as HTMLButtonElement;
const llmDownloadedModelName = document.getElementById('llm-downloaded-model-name') as HTMLSpanElement;

// Docker elements
const dockerStatusIndicator = document.getElementById('docker-status-indicator') as HTMLDivElement;
const dockerStatusText = document.getElementById('docker-status-text') as HTMLSpanElement;
const dockerDetails = document.getElementById('docker-details') as HTMLDivElement;

// Python elements
const pythonStatusIndicator = document.getElementById('python-status-indicator') as HTMLDivElement;
const pythonStatusText = document.getElementById('python-status-text') as HTMLSpanElement;
const pythonDetails = document.getElementById('python-details') as HTMLDivElement;

// Node.js elements
const nodeStatusIndicator = document.getElementById('node-status-indicator') as HTMLDivElement;
const nodeStatusText = document.getElementById('node-status-text') as HTMLSpanElement;
const nodeDetails = document.getElementById('node-details') as HTMLDivElement;

// Capabilities summary
const capabilitiesSummary = document.getElementById('capabilities-summary') as HTMLDivElement;
const capabilitiesMessages = document.getElementById('capabilities-messages') as HTMLDivElement;

let servers: MCPServer[] = [];
let selectedServerId: string | null = null;
let installedServers: InstalledServerStatus[] = [];
let currentCredentialServerId: string | null = null;

// Add server elements
const githubUrlInput = document.getElementById('github-url-input') as HTMLInputElement;
const installGithubBtn = document.getElementById('install-github-btn') as HTMLButtonElement;

function formatJson(obj: unknown): string {
  const json = JSON.stringify(obj, null, 2);
  return json
    .replace(/"([^"]+)":/g, '<span class="json-key">"$1"</span>:')
    .replace(/: "([^"]+)"/g, ': <span class="json-string">"$1"</span>')
    .replace(/: (\d+)/g, ': <span class="json-value">$1</span>')
    .replace(/: (true|false|null)/g, ': <span class="json-value">$1</span>');
}

function updateConnectionUI(state: ConnectionState): void {
  if (state.connected) {
    statusIndicator.className = 'status-indicator connected';
    statusText.className = 'status-text connected';
    statusText.textContent = 'Connected';
  } else {
    statusIndicator.className = 'status-indicator disconnected';
    statusText.className = 'status-text disconnected';
    statusText.textContent = 'Disconnected';
  }

  if (state.error) {
    errorContainer.style.display = 'block';
    errorContainer.textContent = state.error;
  } else {
    errorContainer.style.display = 'none';
  }
}

function getStatusClass(status: string): string {
  switch (status) {
    case 'connected':
      return 'connected';
    case 'connecting':
      return 'connecting';
    default:
      return 'disconnected';
  }
}

function getStatusText(status: string): string {
  switch (status) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting...';
    case 'error':
      return 'Error';
    default:
      return 'Disconnected';
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function loadServers(): Promise<void> {
  // Legacy server loading - kept for compatibility
  try {
    const response = (await browser.runtime.sendMessage({
      type: 'list_servers',
    })) as { type: string; servers?: MCPServer[] };

    if (response.type === 'list_servers_result' && response.servers) {
      servers = response.servers;
    }
  } catch (err) {
    console.error('Failed to load servers:', err);
  }
}

// =============================================================================
// Installed Servers Management
// =============================================================================

async function loadInstalledServers(): Promise<void> {
  try {
    const response = await browser.runtime.sendMessage({
      type: 'list_installed',
    }) as { type: string; servers?: InstalledServerStatus[] };

    if (response.type === 'list_installed_result' && response.servers) {
      installedServers = response.servers;
      renderInstalledServers();
      updateServersStatusDot();
    }
  } catch (err) {
    console.error('Failed to load installed servers:', err);
    updateServersStatusDot();
  }
}

function getServerStatusInfo(status: InstalledServerStatus): { text: string; class: string } {
  if (!status.installed) {
    return { text: 'Not Installed', class: 'error' };
  }

  const processState = status.process?.state;
  
  if (processState === 'running') {
    return { text: 'Running', class: 'running' };
  }
  
  if (status.missingSecrets && status.missingSecrets.length > 0) {
    return { text: 'Needs Auth', class: 'needs-auth' };
  }
  
  if (processState === 'crashed' || processState === 'error') {
    return { text: 'Error', class: 'error' };
  }
  
  return { text: 'Stopped', class: 'stopped' };
}

// Get language badge info from package type
function getLanguageBadge(packageType: string): { label: string; class: string; icon: string } {
  switch (packageType?.toLowerCase()) {
    case 'npm':
      return { label: 'JS/TS', class: 'lang-js', icon: '🟨' };
    case 'pypi':
      return { label: 'Python', class: 'lang-python', icon: '🐍' };
    case 'binary':
      return { label: 'Go/Binary', class: 'lang-go', icon: '🔷' };
    case 'http':
      return { label: 'HTTP', class: 'lang-http', icon: '🌐' };
    case 'sse':
      return { label: 'SSE', class: 'lang-http', icon: '📡' };
    default:
      // Default to JS/TS for unknown types
      return { label: 'JS/TS', class: 'lang-js', icon: '🟨' };
  }
}

function renderInstalledServers(): void {
  if (installedServers.length === 0) {
    installedServerListEl.innerHTML = `
      <div class="empty-state">
        No servers installed. 
        <a href="#" id="go-to-directory" style="color: var(--color-accent-primary);">Browse the directory</a> to find servers.
      </div>
    `;
    const goToDir = document.getElementById('go-to-directory');
    if (goToDir) {
      goToDir.addEventListener('click', (e) => {
        e.preventDefault();
        openDirectoryBtn.click();
      });
    }
    return;
  }

  console.log('[Sidebar] Rendering installed servers:', installedServers.length);
  
  // Count running servers
  const runningCount = installedServers.filter(s => s.process?.state === 'running').length;
  
  // Build running summary if any servers are running
  let summaryHtml = '';
  if (runningCount > 0) {
    summaryHtml = `
      <div class="running-servers-summary">
        <span class="dot"></span>
        <span>${runningCount} server${runningCount > 1 ? 's' : ''} running</span>
      </div>
    `;
  }
  
  // Sort: running first, then needs-auth, then stopped
  const sortedServers = [...installedServers]
    .filter(status => status.installed && status.server)
    .sort((a, b) => {
      const aRunning = a.process?.state === 'running' ? 0 : 1;
      const bRunning = b.process?.state === 'running' ? 0 : 1;
      if (aRunning !== bRunning) return aRunning - bRunning;
      
      const aNeedsAuth = (a.missingSecrets?.length || 0) > 0 ? 0 : 1;
      const bNeedsAuth = (b.missingSecrets?.length || 0) > 0 ? 0 : 1;
      return aNeedsAuth - bNeedsAuth;
    });
  
  const serversHtml = sortedServers
    .map(status => {
      const server = status.server!;
      const statusInfo = getServerStatusInfo(status);
      const isRunning = status.process?.state === 'running';
      const needsAuth = status.missingSecrets && status.missingSecrets.length > 0;
      
      // Determine the card class for left border
      let cardClass = 'installed-server-item';
      if (isRunning) cardClass += ' running';
      else if (needsAuth) cardClass += ' needs-auth';
      else if (status.process?.state === 'error' || status.process?.state === 'crashed') cardClass += ' error';
      
      console.log('[Sidebar] Server:', server.id, 'isRunning:', isRunning, 'needsAuth:', needsAuth, 'process:', status.process);

      const langBadge = getLanguageBadge(server.packageType);
      
      return `
        <div class="${cardClass}" data-server-id="${escapeHtml(server.id)}">
          <div class="server-header">
            <span class="server-label">${escapeHtml(server.name)}</span>
            <span class="server-status-badge ${statusInfo.class}">${statusInfo.text}</span>
          </div>
          ${server.description ? `<div class="text-xs text-muted mt-1">${escapeHtml(server.description)}</div>` : ''}
          <div class="server-package-info">
            <span class="lang-badge ${langBadge.class}">${langBadge.icon} ${langBadge.label}</span>
            <span class="package-name">${escapeHtml(server.packageId)}</span>
          </div>
          ${needsAuth ? `
            <div class="error-message mb-2">
              Missing: ${status.missingSecrets!.join(', ')}
            </div>
          ` : ''}
          <div class="server-actions">
            ${needsAuth ? `
              <button class="btn btn-sm btn-primary configure-btn" data-server-id="${escapeHtml(server.id)}">Configure</button>
            ` : ''}
            ${!needsAuth && !isRunning ? `
              <div class="start-btn-group" style="display: inline-flex; position: relative;">
                <button class="btn btn-sm btn-success start-btn" data-server-id="${escapeHtml(server.id)}">Start</button>
                <button class="btn btn-sm btn-success start-dropdown-btn" data-server-id="${escapeHtml(server.id)}" style="padding: 0 4px; border-left: 1px solid rgba(255,255,255,0.2);" title="Start options">▾</button>
                <div class="start-dropdown" style="display: none; position: absolute; top: 100%; left: 0; background: var(--color-bg-elevated); border: 1px solid var(--color-border); border-radius: 4px; min-width: 140px; z-index: 100; box-shadow: 0 2px 8px rgba(0,0,0,0.3);">
                  <button class="dropdown-item start-native-btn" data-server-id="${escapeHtml(server.id)}" style="display: block; width: 100%; padding: 8px 12px; text-align: left; background: none; border: none; color: var(--color-text); cursor: pointer;">▶ Start</button>
                  <button class="dropdown-item start-docker-btn" data-server-id="${escapeHtml(server.id)}" style="display: block; width: 100%; padding: 8px 12px; text-align: left; background: none; border: none; color: var(--color-text); cursor: pointer;">🐳 Start in Docker</button>
                </div>
              </div>
            ` : ''}
            ${isRunning ? `
              <button class="btn btn-sm btn-danger stop-btn" data-server-id="${escapeHtml(server.id)}">Stop</button>
              <button class="btn btn-sm btn-secondary mcp-tools-btn" data-server-id="${escapeHtml(server.id)}">Tools</button>
            ` : ''}
            <button class="btn btn-sm btn-ghost configure-btn" data-server-id="${escapeHtml(server.id)}" ${needsAuth ? 'style="display:none;"' : ''}>⚙</button>
            <button class="btn btn-sm btn-danger uninstall-btn" data-server-id="${escapeHtml(server.id)}">✕</button>
          </div>
        </div>
      `;
    })
    .join('');
  
  installedServerListEl.innerHTML = summaryHtml + serversHtml;

  // Add event listeners
  console.log('[Sidebar] === ATTACHING EVENT LISTENERS ===');
  console.log('[Sidebar] installedServerListEl:', installedServerListEl);
  console.log('[Sidebar] innerHTML length:', installedServerListEl.innerHTML.length);
  
  const configBtns = installedServerListEl.querySelectorAll('.configure-btn');
  console.log('[Sidebar] Found configure buttons:', configBtns.length);
  configBtns.forEach(btn => {
    btn.addEventListener('click', () => openCredentialModal((btn as HTMLElement).dataset.serverId!));
  });

  // Start button (main) - starts normally
  const startBtns = installedServerListEl.querySelectorAll('.start-btn');
  console.log('[Sidebar] Found start buttons:', startBtns.length);
  startBtns.forEach(btn => {
    const serverId = (btn as HTMLElement).dataset.serverId;
    console.log('[Sidebar] Adding click listener to start button for:', serverId);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      console.log('[Sidebar] *** START BUTTON CLICKED *** for:', serverId);
      startInstalledServer(serverId!);
    });
  });

  // Start dropdown toggle
  installedServerListEl.querySelectorAll('.start-dropdown-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const dropdown = (btn as HTMLElement).parentElement?.querySelector('.start-dropdown') as HTMLElement;
      if (dropdown) {
        const isVisible = dropdown.style.display !== 'none';
        // Close all other dropdowns first
        document.querySelectorAll('.start-dropdown').forEach(d => (d as HTMLElement).style.display = 'none');
        dropdown.style.display = isVisible ? 'none' : 'block';
      }
    });
  });

  // Start native option
  installedServerListEl.querySelectorAll('.start-native-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const serverId = (btn as HTMLElement).dataset.serverId!;
      (btn as HTMLElement).closest('.start-dropdown')!.setAttribute('style', 'display: none');
      startInstalledServer(serverId, false, false);
    });
  });

  // Start in Docker option
  installedServerListEl.querySelectorAll('.start-docker-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const serverId = (btn as HTMLElement).dataset.serverId!;
      (btn as HTMLElement).closest('.start-dropdown')!.setAttribute('style', 'display: none');
      startInstalledServer(serverId, false, true);
    });
  });

  installedServerListEl.querySelectorAll('.stop-btn').forEach(btn => {
    btn.addEventListener('click', () => stopInstalledServer((btn as HTMLElement).dataset.serverId!));
  });

  installedServerListEl.querySelectorAll('.mcp-tools-btn').forEach(btn => {
    btn.addEventListener('click', () => listMcpTools((btn as HTMLElement).dataset.serverId!));
  });

  installedServerListEl.querySelectorAll('.uninstall-btn').forEach(btn => {
    btn.addEventListener('click', () => uninstallServer((btn as HTMLElement).dataset.serverId!));
  });
}

async function openCredentialModal(serverId: string): Promise<void> {
  currentCredentialServerId = serverId;
  
  // Find the server
  const serverStatus = installedServers.find(s => s.server?.id === serverId);
  if (!serverStatus?.server) {
    console.error('Server not found:', serverId);
    return;
  }
  
  const server = serverStatus.server;
  credentialModalTitle.textContent = `Configure ${server.name}`;

  // Get current credential status
  let credentialList: CredentialInfo[] = [];
  try {
    const response = await browser.runtime.sendMessage({
      type: 'list_credentials',
      server_id: serverId,
    }) as { type: string; credentials?: CredentialInfo[] };
    
    if (response.type === 'list_credentials_result' && response.credentials) {
      credentialList = response.credentials;
    }
  } catch (err) {
    console.error('Failed to get credentials:', err);
  }

  // Get required env vars
  const requiredVars = server.requiredEnvVars || [];
  const secretVars = requiredVars.filter(v => v.isSecret);
  
  // Also include any already-set credentials that aren't in requiredVars
  const existingKeys = new Set(secretVars.map(v => v.name));
  const additionalCreds = credentialList.filter(c => !existingKeys.has(c.key));

  // Build credential fields HTML
  let fieldsHtml = '';
  
  // Required credentials
  fieldsHtml += secretVars.map(envVar => {
    const isSet = credentialList.some(c => c.key === envVar.name);
    
    return `
      <div class="credential-field">
        <div class="credential-label">
          <span class="credential-label-text">${escapeHtml(envVar.name)}</span>
          <span class="credential-required">*</span>
        </div>
        ${envVar.description ? `<div class="credential-description">${escapeHtml(envVar.description)}</div>` : ''}
        <div class="password-input-wrapper">
          <input 
            type="password" 
            class="credential-input ${isSet ? 'is-set' : ''}" 
            data-key="${escapeHtml(envVar.name)}"
            placeholder="${isSet ? '••••••••' : 'Enter value...'}"
          >
          <button class="password-toggle" type="button" data-showing="false">◉</button>
        </div>
        <div class="credential-status ${isSet ? 'set' : 'missing'}">
          ${isSet ? '✓ Set' : '! Missing'}
        </div>
      </div>
    `;
  }).join('');
  
  // Additional credentials already configured
  fieldsHtml += additionalCreds.map(cred => {
    return `
      <div class="credential-field">
        <div class="credential-label">
          <span class="credential-label-text">${escapeHtml(cred.key)}</span>
          <button class="btn btn-sm btn-ghost delete-credential-btn" data-key="${escapeHtml(cred.key)}" title="Remove">✕</button>
        </div>
        <div class="password-input-wrapper">
          <input 
            type="password" 
            class="credential-input is-set" 
            data-key="${escapeHtml(cred.key)}"
            placeholder="••••••••"
          >
          <button class="password-toggle" type="button" data-showing="false">◉</button>
        </div>
        <div class="credential-status set">✓ Set</div>
      </div>
    `;
  }).join('');
  
  // Always show args configuration for ANY server
  // This is fully generic - no per-server configuration needed
  const currentArgs = server.args || [];
  
  fieldsHtml += `
    <div class="args-config-section">
      <div class="section-divider">
        <span>⚙️ Command Arguments</span>
      </div>
      <div class="credential-description" style="margin-bottom: var(--space-2);">
        Some servers require command-line arguments (e.g., directories, URLs).
        ${server.homepageUrl ? `<a href="${escapeHtml(server.homepageUrl)}" target="_blank" rel="noopener">Check documentation →</a>` : ''}
      </div>
      <div id="args-list" class="directory-list">
        ${currentArgs.length > 0 ? currentArgs.map((arg, i) => `
          <div class="directory-item" data-index="${i}">
            <input type="text" class="credential-input args-value" value="${escapeHtml(arg)}" placeholder="e.g., /path/to/dir or --option=value">
            <button class="btn btn-sm btn-ghost remove-arg-btn" data-index="${i}">✕</button>
          </div>
        `).join('') : `
          <div class="directory-item" data-index="0">
            <input type="text" class="credential-input args-value" value="" placeholder="e.g., /path/to/dir or --option=value">
            <button class="btn btn-sm btn-ghost remove-arg-btn" data-index="0">✕</button>
          </div>
        `}
      </div>
      <button class="btn btn-sm btn-secondary" id="add-arg-btn">+ Add Argument</button>
    </div>
  `;
  
  // Add custom env var section
  fieldsHtml += `
    <div class="add-credential-section">
      <div class="section-divider">
        <span>Add Environment Variable</span>
      </div>
      <div class="add-credential-form">
        <input 
          type="text" 
          id="new-credential-key" 
          class="credential-input" 
          placeholder="VARIABLE_NAME"
          style="text-transform: uppercase;"
        >
        <div class="password-input-wrapper">
          <input 
            type="password" 
            id="new-credential-value" 
            class="credential-input" 
            placeholder="Value..."
          >
          <button class="password-toggle" type="button" data-showing="false">◉</button>
        </div>
        <button class="btn btn-sm btn-primary" id="add-credential-btn">Add</button>
      </div>
      <div class="credential-hint">
        Environment variables are passed to the server process.
        ${server.homepageUrl ? `<a href="${escapeHtml(server.homepageUrl)}" target="_blank" rel="noopener">See documentation →</a>` : ''}
      </div>
    </div>
  `;
  
  credentialModalBody.innerHTML = fieldsHtml;

  // Add password toggle functionality
  credentialModalBody.querySelectorAll('.password-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const wrapper = btn.parentElement!;
      const input = wrapper.querySelector('input') as HTMLInputElement;
      const showing = btn.getAttribute('data-showing') === 'true';
      
      input.type = showing ? 'password' : 'text';
      btn.textContent = showing ? '◉' : '○';
      btn.setAttribute('data-showing', (!showing).toString());
    });
  });
  
  // Add credential button
  const addCredBtn = document.getElementById('add-credential-btn');
  const newKeyInput = document.getElementById('new-credential-key') as HTMLInputElement;
  const newValueInput = document.getElementById('new-credential-value') as HTMLInputElement;
  
  addCredBtn?.addEventListener('click', async () => {
    const key = newKeyInput.value.trim().toUpperCase();
    const value = newValueInput.value.trim();
    
    if (!key || !value) {
      alert('Please enter both a variable name and value.');
      return;
    }
    
    try {
      await browser.runtime.sendMessage({
        type: 'set_credential',
        server_id: serverId,
        key,
        value,
        credential_type: 'api_key',
      });
      // Refresh the modal to show the new credential
      openCredentialModal(serverId);
    } catch (err) {
      console.error('Failed to add credential:', err);
      alert('Failed to add credential.');
    }
  });
  
  // Delete credential buttons
  credentialModalBody.querySelectorAll('.delete-credential-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const key = (btn as HTMLElement).dataset.key!;
      if (!confirm(`Remove ${key}?`)) return;
      
      try {
        await browser.runtime.sendMessage({
          type: 'delete_credential',
          server_id: serverId,
          key,
        });
        // Refresh the modal
        openCredentialModal(serverId);
      } catch (err) {
        console.error('Failed to delete credential:', err);
      }
    });
  });
  
  // Args configuration event handlers (fully generic for any server)
  const addArgBtn = document.getElementById('add-arg-btn');
  const argsList = document.getElementById('args-list');
  
  if (addArgBtn && argsList) {
    const placeholder = 'e.g., /path/to/dir or --option=value';
    
    addArgBtn.addEventListener('click', () => {
      const newIndex = argsList.children.length;
      const newItem = document.createElement('div');
      newItem.className = 'directory-item';
      newItem.dataset.index = String(newIndex);
      newItem.innerHTML = `
        <input type="text" class="credential-input args-value" value="" placeholder="${escapeHtml(placeholder)}">
        <button class="btn btn-sm btn-ghost remove-arg-btn" data-index="${newIndex}">✕</button>
      `;
      argsList.appendChild(newItem);
      
      // Add remove handler for the new button
      newItem.querySelector('.remove-arg-btn')?.addEventListener('click', () => {
        if (argsList.children.length > 1) {
          newItem.remove();
        } else {
          // Don't remove the last one, just clear it
          const input = newItem.querySelector('.args-value') as HTMLInputElement;
          if (input) input.value = '';
        }
      });
      
      // Focus the new input
      (newItem.querySelector('.args-value') as HTMLInputElement)?.focus();
    });
  }
  
  // Remove arg button handlers
  credentialModalBody.querySelectorAll('.remove-arg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.directory-item');
      if (item && argsList && argsList.children.length > 1) {
        item.remove();
      } else if (item) {
        // Don't remove the last one, just clear it
        const input = item.querySelector('.args-value') as HTMLInputElement;
        if (input) input.value = '';
      }
    });
  });

  credentialModal.style.display = 'flex';
}

function closeCredentialModal(): void {
  credentialModal.style.display = 'none';
  currentCredentialServerId = null;
}

async function saveCredentials(): Promise<void> {
  if (!currentCredentialServerId) return;

  const inputs = credentialModalBody.querySelectorAll('.credential-input:not(.directory-path)') as NodeListOf<HTMLInputElement>;
  let hasErrors = false;

  for (const input of inputs) {
    const key = input.dataset.key;
    if (!key) continue; // Skip inputs without a key (like the new credential inputs)
    
    const value = input.value.trim();
    
    // Only save if a value was entered (don't overwrite with empty)
    if (value) {
      try {
        await browser.runtime.sendMessage({
          type: 'set_credential',
          server_id: currentCredentialServerId,
          key,
          value,
          credential_type: 'api_key',
        });
      } catch (err) {
        console.error('Failed to save credential:', err);
        hasErrors = true;
      }
    }
  }
  
  // Save server args (generalized - any server can have args)
  const argsInputs = credentialModalBody.querySelectorAll('.args-value') as NodeListOf<HTMLInputElement>;
  if (argsInputs.length > 0) {
    const args = Array.from(argsInputs)
      .map(input => input.value.trim())
      .filter(arg => arg.length > 0);
    
    // Always save args, even if empty (to clear previous args)
    try {
      await browser.runtime.sendMessage({
        type: 'update_server_args',
        server_id: currentCredentialServerId,
        args: args,
      });
      console.log('[Sidebar] Saved server args:', args);
    } catch (err) {
      console.error('Failed to save server args:', err);
      hasErrors = true;
    }
  }

  if (!hasErrors) {
    closeCredentialModal();
    await loadInstalledServers();
  }
}

async function startInstalledServer(
  serverId: string, 
  skipSecurityCheck: boolean = false,
  useDocker: boolean = false
): Promise<void> {
  console.log('[Sidebar] Starting server:', serverId, 'skipSecurityCheck:', skipSecurityCheck, 'useDocker:', useDocker);
  
  // Clear any existing inline prompts and progress
  document.querySelectorAll('.docker-fallback-inline').forEach(el => el.remove());
  clearServerProgress(serverId);
  
  // Check if OAuth is needed for this server (if it was installed via manifest)
  const oauthReady = await checkAndPromptOAuth(serverId);
  if (!oauthReady) {
    console.log('[Sidebar] OAuth not ready, cannot start server');
    return;
  }
  
  // Show immediate feedback - disable button and show connecting state
  const serverCard = document.querySelector(`.installed-server-item[data-server-id="${serverId}"]`);
  const startBtn = serverCard?.querySelector('.start-btn') as HTMLButtonElement;
  const statusBadge = serverCard?.querySelector('.server-status-badge') as HTMLSpanElement;
  
  if (startBtn) {
    startBtn.disabled = true;
    startBtn.textContent = '⏳';
  }
  if (statusBadge) {
    statusBadge.className = 'server-status-badge connecting';
    statusBadge.innerHTML = '<span class="connecting-spinner"></span> Starting...';
  }
  
  // Show progress message
  const progressMessage = useDocker ? 'Starting Docker container...' : 'Connecting to MCP server...';
  showServerProgress(serverId, progressMessage);
  
  try {
    // Check if this server has a manifest (needs special handling for OAuth tokens)
    const manifestCheck = await browser.runtime.sendMessage({
      type: 'get_server_manifest',
      server_id: serverId,
    }) as { hasManifest?: boolean; manifest?: McpManifest } | undefined;
    
    let response: { 
      type: string; 
      connected?: boolean; 
      needs_security_approval?: boolean;
      docker_available?: boolean;
      docker_recommended?: boolean;
      docker_fallback_available?: boolean;
      docker_fallback_message?: string;
      running_in_docker?: boolean;
      security_instructions?: string;
      error?: string;
      serverId?: string;
      process?: { pid: number; state: string };
    };
    
    if (manifestCheck?.hasManifest && manifestCheck.manifest?.oauth) {
      // Use start_manifest_server which injects OAuth tokens
      console.log('[Sidebar] Using manifest-based start for OAuth server');
      const manifestResponse = await browser.runtime.sendMessage({
        type: 'start_manifest_server',
        server_id: serverId,
        use_docker: useDocker,
      }) as {
        type: string;
        serverId?: string;
        process?: { pid: number; state: string; errorMessage?: string };
        docker_fallback_available?: boolean;
        docker_fallback_message?: string;
        error?: { message?: string };
      };
      
      // Check if Docker fallback is being offered (macOS security issue)
      if (manifestResponse?.docker_fallback_available) {
        console.log('[Sidebar] Docker fallback available for manifest server');
        response = {
          type: 'mcp_connect_result',
          connected: false,
          docker_fallback_available: true,
          docker_fallback_message: manifestResponse.docker_fallback_message || 
            'This server has native dependencies that may cause issues on macOS. Would you like to run in Docker instead?',
        };
      }
      // Convert manifest start response to mcp_connect format
      else if (manifestResponse?.type === 'start_manifest_server_result') {
        response = {
          type: 'mcp_connect_result',
          connected: manifestResponse.connected === true,
          running_in_docker: manifestResponse.running_in_docker || useDocker,
          error: manifestResponse.error,
        };
      } else if (manifestResponse?.type === 'error') {
        response = {
          type: 'error',
          error: manifestResponse.error?.message || 'Failed to start server',
        };
      } else {
        response = manifestResponse;
      }
    } else {
      // Use regular mcp_connect for non-manifest servers
      response = await browser.runtime.sendMessage({
        type: 'mcp_connect',
        server_id: serverId,
        skip_security_check: skipSecurityCheck,
        use_docker: useDocker,
      });
    }

    console.log('[Sidebar] Start response:', response);
    console.log('[Sidebar] docker_fallback_available:', response.docker_fallback_available);
    console.log('[Sidebar] docker_fallback_message:', response.docker_fallback_message);

    if (response.type === 'mcp_connect_result') {
      if (response.connected) {
        console.log('[Sidebar] Server started and connected:', serverId, 'docker:', response.running_in_docker);
        clearServerProgress(serverId);
        // Refresh Docker status to show running container
        if (response.running_in_docker) {
          setTimeout(() => checkDockerStatus(), 1000);
        }
      } else if (response.needs_security_approval) {
        // Show security approval instructions with Docker option if available
        showSecurityApprovalModal(
          serverId, 
          response.security_instructions || '',
          response.docker_available || false,
          response.docker_recommended || false
        );
        return; // Don't refresh yet
      } else if (response.docker_fallback_available === true) {
        // Native start failed but Docker is available - show Docker fallback inline prompt
        console.log('[Sidebar] Showing Docker fallback prompt for:', serverId);
        showDockerFallbackModal(
          serverId,
          response.docker_fallback_message || 'Failed to start server. Docker may help.',
          response.error || ''
        );
        return; // Don't refresh yet
      } else if (response.error) {
        // Connection failed with error - no Docker fallback
        console.error('[Sidebar] Connection failed (no Docker fallback):', response.error);
        clearServerProgress(serverId);
        
        // Provide more helpful error messages
        let errorMsg = response.error;
        if (errorMsg.includes('Connection closed') || errorMsg.includes('-32000')) {
          errorMsg += '\n\nThis usually means the server crashed on startup. Check:\n• Missing environment variables (click ⚙️ to configure)\n• Incorrect command arguments';
        }
        alert(`Failed to start: ${errorMsg}`);
      } else {
        // Connected is false but no security approval needed - must be an error
        console.error('[Sidebar] Connection failed without error details');
        alert('Failed to start server. Check the console for details.');
      }
    } else if (response.type === 'error') {
      const error = response as unknown as { error: { message: string } };
      console.error('[Sidebar] Start error:', error);
      alert(`Failed to start: ${error.error.message}`);
    } else {
      console.warn('[Sidebar] Unexpected response:', response);
      alert('Unexpected response from bridge. Check the console.');
    }
    
    await loadInstalledServers();
  } catch (err) {
    console.error('[Sidebar] Failed to start server:', err);
    clearServerProgress(serverId);
    alert(`Failed to start server: ${err}`);
    // Refresh to reset the UI state
    await loadInstalledServers();
  }
}

/**
 * Show an inline security approval prompt below the server card.
 */
function showSecurityApprovalModal(
  serverId: string, 
  instructions: string,
  dockerAvailable: boolean = false,
  dockerRecommended: boolean = false
): void {
  // Remove any existing inline prompts first (security or docker fallback)
  document.querySelectorAll('.security-approval-inline').forEach(el => el.remove());
  document.querySelectorAll('.docker-fallback-inline').forEach(el => el.remove());
  
  // Find the server card
  const serverCard = document.querySelector(`.installed-server-item[data-server-id="${serverId}"]`);
  if (!serverCard) {
    console.error('Could not find server card for:', serverId);
    // Fallback: use alert
    alert(instructions);
    return;
  }
  
  // Build Docker button if available
  const dockerButton = dockerAvailable 
    ? `<button class="btn btn-success security-docker-btn" style="flex: 1;">
        🐳 Run in Docker${dockerRecommended ? ' (Recommended)' : ''}
       </button>`
    : '';
  
  // Create inline prompt
  const inlinePrompt = document.createElement('div');
  inlinePrompt.className = 'security-approval-inline';
  inlinePrompt.innerHTML = `
    <div style="background: var(--color-surface-secondary, #1e1e1e); border: 1px solid var(--color-border-default, #333); border-radius: 8px; padding: 12px; margin-top: 8px;">
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
        <span style="font-size: 18px;">⚠️</span>
        <strong style="color: var(--color-text-primary, #fff);">macOS Security Approval</strong>
      </div>
      <pre style="white-space: pre-wrap; font-family: var(--font-sans); font-size: 11px; line-height: 1.4; background: var(--color-bg-subtle, #2a2a2a); color: var(--color-text-secondary, #aaa); padding: 8px; border-radius: 4px; margin: 0 0 12px 0; max-height: 150px; overflow-y: auto;">${escapeHtml(instructions)}</pre>
      <div style="display: flex; gap: 8px; flex-wrap: wrap;">
        ${dockerButton}
        <button class="btn btn-primary security-proceed-btn" style="flex: 1;">✓ I've Allowed It - Start Now</button>
        <button class="btn btn-secondary security-cancel-btn">Cancel</button>
      </div>
    </div>
  `;
  
  // Insert after the server card
  serverCard.insertAdjacentElement('afterend', inlinePrompt);
  
  // Scroll into view
  inlinePrompt.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  
  // Add event listeners
  const cancelBtn = inlinePrompt.querySelector('.security-cancel-btn')!;
  const proceedBtn = inlinePrompt.querySelector('.security-proceed-btn')!;
  const dockerBtn = inlinePrompt.querySelector('.security-docker-btn');

  cancelBtn.addEventListener('click', () => {
    inlinePrompt.remove();
  });

  proceedBtn.addEventListener('click', async () => {
    inlinePrompt.remove();
    // Retry with skip_security_check to bypass the first-run check
    await startInstalledServer(serverId, true, false);
  });
  
  // Docker button handler
  if (dockerBtn) {
    dockerBtn.addEventListener('click', async () => {
      inlinePrompt.remove();
      // Start in Docker mode
      await startInstalledServer(serverId, false, true);
    });
  }
}

/**
 * Show Docker fallback as a modal overlay (fallback when card isn't found).
 */
function showDockerFallbackAsModal(serverId: string, message: string): void {
  // Remove any existing modals first
  document.querySelectorAll('.docker-fallback-modal-overlay').forEach(el => el.remove());
  
  const modalHtml = `
    <div class="modal-overlay docker-fallback-modal-overlay" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 9999;">
      <div class="modal-content" style="max-width: 420px; background: var(--color-surface-primary); border-radius: 8px; border: 1px solid var(--color-border-default); overflow: hidden;">
        <div class="modal-header" style="padding: 12px 16px; border-bottom: 1px solid var(--color-border-subtle);">
          <h3 style="margin: 0; font-size: 16px;">🐳 Run with Docker</h3>
        </div>
        <div class="modal-body" style="padding: 16px;">
          <p style="margin: 0 0 12px 0; color: var(--text-primary);">
            ${escapeHtml(message)}
          </p>
          <div style="background: var(--bg-tertiary); padding: 12px; border-radius: 6px; border-left: 3px solid var(--accent-primary);">
            <strong style="color: var(--accent-primary);">✓ Docker is available</strong>
            <p style="color: var(--text-secondary); font-size: 12px; margin-top: 4px; margin-bottom: 0;">
              Click below to run this server in Docker.
            </p>
          </div>
        </div>
        <div class="modal-footer" style="padding: 12px 16px; border-top: 1px solid var(--color-border-subtle); display: flex; gap: 8px; justify-content: flex-end;">
          <button class="btn btn-secondary docker-modal-cancel">Cancel</button>
          <button class="btn btn-success docker-modal-retry">🐳 Run in Docker</button>
        </div>
      </div>
    </div>
  `;
  
  document.body.insertAdjacentHTML('beforeend', modalHtml);
  
  const overlay = document.querySelector('.docker-fallback-modal-overlay')!;
  const cancelBtn = overlay.querySelector('.docker-modal-cancel')!;
  const retryBtn = overlay.querySelector('.docker-modal-retry')!;
  
  cancelBtn.addEventListener('click', () => overlay.remove());
  retryBtn.addEventListener('click', async () => {
    overlay.remove();
    await startInstalledServer(serverId, false, true);
  });
  
  // Click outside to close
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
}

/**
 * Show an inline Docker fallback prompt below the server card.
 */
function showDockerFallbackModal(serverId: string, message: string, _originalError: string): void {
  // Remove any existing Docker fallback prompts first
  document.querySelectorAll('.docker-fallback-inline').forEach(el => el.remove());
  document.querySelectorAll('.docker-fallback-modal-overlay').forEach(el => el.remove());
  
  // Find the server card - it has data-server-id directly on it
  const serverCard = document.querySelector(`.installed-server-item[data-server-id="${serverId}"]`);
  if (!serverCard) {
    console.error('Could not find server card for:', serverId);
    // Fallback: show as a modal overlay instead of inline
    showDockerFallbackAsModal(serverId, message);
    return;
  }
  
  // Create inline prompt
  const inlinePrompt = document.createElement('div');
  inlinePrompt.className = 'docker-fallback-inline';
  inlinePrompt.innerHTML = `
    <div style="background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 8px; padding: 12px; margin-top: 8px;">
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
        <span style="font-size: 18px;">🐳</span>
        <strong style="color: var(--text-primary);">Run with Docker?</strong>
      </div>
      <p style="color: var(--text-secondary); font-size: 12px; margin: 0 0 12px 0;">
        ${escapeHtml(message)}
      </p>
      <div style="display: flex; gap: 8px;">
        <button class="btn btn-success docker-retry-btn" style="flex: 1;">🐳 Run in Docker</button>
        <button class="btn btn-secondary docker-cancel-btn">Cancel</button>
      </div>
    </div>
  `;
  
  // Insert after the server card
  serverCard.insertAdjacentElement('afterend', inlinePrompt);
  
  // Scroll into view
  inlinePrompt.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  
  // Add event listeners
  const retryBtn = inlinePrompt.querySelector('.docker-retry-btn')!;
  const cancelBtn = inlinePrompt.querySelector('.docker-cancel-btn')!;
  
  retryBtn.addEventListener('click', async () => {
    inlinePrompt.remove();
    await startInstalledServer(serverId, false, true);
  });
  
  cancelBtn.addEventListener('click', () => {
    inlinePrompt.remove();
  });
}

/**
 * Show progress for a server operation (like Docker startup).
 */
function showServerProgress(serverId: string, message: string): void {
  // Find or create the progress element for this server
  let progressEl = document.getElementById(`server-progress-${serverId}`);
  
  if (!progressEl) {
    // Find the server card to attach progress to
    const serverCard = document.querySelector(`.installed-server-item[data-server-id="${serverId}"]`);
    if (!serverCard) {
      console.log('[Progress] No server card found for:', serverId);
      return;
    }
    
    // Create progress element
    progressEl = document.createElement('div');
    progressEl.id = `server-progress-${serverId}`;
    progressEl.className = 'server-progress';
    progressEl.innerHTML = `
      <div style="margin-top: 8px; padding: 8px 12px; background: var(--color-bg-subtle); border-radius: 6px; border-left: 3px solid var(--color-accent-primary);">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span class="progress-spinner" style="display: inline-block; width: 12px; height: 12px; border: 2px solid var(--color-border-default); border-top-color: var(--color-accent-primary); border-radius: 50%; animation: spin 1s linear infinite;"></span>
          <span class="progress-message" style="font-size: 11px; color: var(--text-secondary);"></span>
        </div>
      </div>
    `;
    serverCard.appendChild(progressEl);
    
    // Add CSS animation if not already present
    if (!document.getElementById('progress-spinner-style')) {
      const style = document.createElement('style');
      style.id = 'progress-spinner-style';
      style.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
      document.head.appendChild(style);
    }
  }
  
  // Update the message
  const messageEl = progressEl.querySelector('.progress-message');
  if (messageEl) {
    messageEl.textContent = message;
  }
  
  // If the message indicates completion, remove after a delay
  if (message.includes('✓') && message.includes('established')) {
    setTimeout(() => {
      progressEl?.remove();
      loadInstalledServers(); // Refresh to show running state
    }, 1500);
  }
}

/**
 * Clear progress display for a server.
 */
function clearServerProgress(serverId: string): void {
  const progressEl = document.getElementById(`server-progress-${serverId}`);
  if (progressEl) {
    progressEl.remove();
  }
}

async function stopInstalledServer(serverId: string): Promise<void> {
  try {
    await browser.runtime.sendMessage({
      type: 'mcp_disconnect',
      server_id: serverId,
    });
    
    await loadInstalledServers();
  } catch (err) {
    console.error('Failed to stop server:', err);
  }
}

async function listMcpTools(serverId: string): Promise<void> {
  try {
    const response = await browser.runtime.sendMessage({
      type: 'mcp_list_tools',
      server_id: serverId,
    });

    toolsCard.style.display = 'block';
    toolsResponse.innerHTML = formatJson(response);
  } catch (err) {
    console.error('Failed to list MCP tools:', err);
    toolsCard.style.display = 'block';
    toolsResponse.textContent = `Error: ${err}`;
  }
}

async function uninstallServer(serverId: string): Promise<void> {
  if (!confirm('Uninstall this server? This will also remove its credentials.')) {
    return;
  }

  try {
    // Stop if running
    await browser.runtime.sendMessage({
      type: 'mcp_disconnect',
      server_id: serverId,
    });

    // Uninstall
    await browser.runtime.sendMessage({
      type: 'uninstall_server',
      server_id: serverId,
    });

    await loadInstalledServers();
  } catch (err) {
    console.error('Failed to uninstall server:', err);
  }
}


// =============================================================================
// Manifest-based Installation with OAuth
// =============================================================================

/**
 * Install a server from a manifest with OAuth handling.
 */
async function installFromManifest(manifest: McpManifest): Promise<boolean> {
  console.log('[Sidebar] Installing from manifest:', manifest.name);

  try {
    // First check if we can handle OAuth requirements
    if (manifest.oauth) {
      const oauthCheck = await browser.runtime.sendMessage({
        type: 'check_manifest_oauth',
        manifest,
      }) as { type: string; error?: string } & OAuthCapabilityCheck;

      if (oauthCheck.type === 'error') {
        alert(`OAuth check failed: ${oauthCheck.error}`);
        return false;
      }

      console.log('[Sidebar] OAuth check result:', oauthCheck);

      // If user mode is required and host mode not available, warn the user
      if (oauthCheck.required && !oauthCheck.hostModeAvailable && oauthCheck.userModeAvailable) {
        const proceed = confirm(
          `This server requires you to create your own OAuth application.\n\n` +
          `Reason: ${oauthCheck.reason || 'Host mode not available'}\n\n` +
          `Would you like to continue? You'll need to follow the setup instructions.`
        );
        if (!proceed) return false;
      }
    }

    // Install the server
    const result = await browser.runtime.sendMessage({
      type: 'install_from_manifest',
      manifest,
    }) as { type: string; error?: string } & ManifestInstallResult;

    if (result.type === 'error') {
      alert(`Installation failed: ${result.error}`);
      return false;
    }

    console.log('[Sidebar] Install result:', result);

    // If OAuth is needed, start the flow
    if (result.needsOAuth && result.oauthMode === 'host') {
      const oauthStarted = await startManifestOAuthFlow(result.serverId, manifest);
      if (!oauthStarted) {
        console.warn('[Sidebar] OAuth flow not completed');
        // Server is installed but OAuth not done - user can retry later
      }
    }

    // Refresh server list
    await loadInstalledServers();
    
    return true;
  } catch (err) {
    console.error('[Sidebar] Manifest installation failed:', err);
    alert(`Installation failed: ${err}`);
    return false;
  }
}

/**
 * Start OAuth flow for a manifest-installed server.
 * Shows consent UI and opens browser for authentication.
 */
async function startManifestOAuthFlow(serverId: string, manifest: McpManifest): Promise<boolean> {
  if (!manifest.oauth) return true;

  // Show consent dialog
  const scopes = manifest.oauth.scopes;
  const description = manifest.oauth.description || 'Access to your account';
  
  const consent = confirm(
    `${manifest.name} needs your permission:\n\n` +
    `${description}\n\n` +
    `Scopes requested:\n` +
    scopes.map(s => `• ${formatScope(s)}`).join('\n') +
    `\n\nClick OK to sign in with ${capitalizeFirst(manifest.oauth.provider)}.`
  );

  if (!consent) return false;

  try {
    // Start OAuth flow
    const response = await browser.runtime.sendMessage({
      type: 'manifest_oauth_start',
      server_id: serverId,
    }) as { type: string; authUrl?: string; state?: string; error?: string };

    if (response.type === 'error' || !response.authUrl) {
      alert(`Failed to start authorization: ${response.error || 'Unknown error'}`);
      return false;
    }

    // Open auth URL in browser
    window.open(response.authUrl, '_blank');

    // Show waiting state
    showOAuthWaiting(serverId, manifest.oauth.provider);

    // Poll for completion
    return await waitForOAuthCompletion(serverId);
  } catch (err) {
    console.error('[Sidebar] OAuth flow failed:', err);
    return false;
  }
}

/**
 * Show waiting state while OAuth is in progress.
 */
function showOAuthWaiting(serverId: string, provider: string): void {
  // Find the server card and show waiting state
  const serverCard = document.querySelector(`[data-server-id="${serverId}"]`);
  if (serverCard) {
    const statusEl = serverCard.querySelector('.server-status');
    if (statusEl) {
      statusEl.innerHTML = `
        <span class="status-indicator connecting"></span>
        <span>Waiting for ${capitalizeFirst(provider)} authorization...</span>
      `;
    }
  }
}

/**
 * Wait for OAuth to complete by polling status.
 */
async function waitForOAuthCompletion(serverId: string, maxWaitMs: number = 5 * 60 * 1000): Promise<boolean> {
  const startTime = Date.now();
  const pollInterval = 2000; // 2 seconds

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));

    const status = await browser.runtime.sendMessage({
      type: 'manifest_oauth_status',
      server_id: serverId,
    }) as ManifestOAuthStatus;

    if (status.hasTokens && status.tokensValid) {
      console.log('[Sidebar] OAuth completed successfully');
      await loadInstalledServers(); // Refresh to update UI
      return true;
    }
  }

  console.warn('[Sidebar] OAuth timed out');
  return false;
}

/**
 * Format an OAuth scope for display.
 */
function formatScope(scope: string): string {
  // Extract the last part of the scope URL for readability
  const parts = scope.split('/');
  const lastPart = parts[parts.length - 1];
  
  // Make it more readable
  return lastPart
    .replace(/\./g, ' ')
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
}

/**
 * Capitalize first letter.
 */
function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Check OAuth status and prompt for auth if needed.
 */
async function checkAndPromptOAuth(serverId: string): Promise<boolean> {
  // Get the manifest for this server
  const manifestResponse = await browser.runtime.sendMessage({
    type: 'get_server_manifest',
    server_id: serverId,
  }) as { type: string; hasManifest: boolean; manifest?: McpManifest };

  if (!manifestResponse.hasManifest || !manifestResponse.manifest?.oauth) {
    return true; // No OAuth needed
  }

  // Check OAuth status
  const status = await browser.runtime.sendMessage({
    type: 'manifest_oauth_status',
    server_id: serverId,
  }) as ManifestOAuthStatus;

  if (status.hasTokens && status.tokensValid) {
    return true; // Already authenticated
  }

  // Need to authenticate
  return await startManifestOAuthFlow(serverId, manifestResponse.manifest);
}

// =============================================================================
// GitHub URL Install
// =============================================================================

async function installFromGithubUrl(): Promise<void> {
  const url = githubUrlInput?.value.trim();
  
  if (!url) {
    alert('Please enter a GitHub URL.');
    githubUrlInput?.focus();
    return;
  }

  // Basic GitHub URL validation
  if (!url.includes('github.com/') && !url.match(/^[\w-]+\/[\w.-]+$/)) {
    alert('Please enter a valid GitHub URL or owner/repo format.');
    githubUrlInput?.focus();
    return;
  }

  if (installGithubBtn) {
    installGithubBtn.disabled = true;
    installGithubBtn.textContent = 'Installing...';
  }

  try {
    const response = await browser.runtime.sendMessage({
      type: 'install_github_repo',
      github_url: url,
    }) as { 
      type: string; 
      success?: boolean;
      server_id?: string;
      package_type?: string;
      error?: { message: string };
      needs_config?: boolean;
    };

    if (response.type === 'install_github_repo_result' && response.success) {
      githubUrlInput.value = '';
      await loadInstalledServers();
      
      // Show success notification
      const packageType = response.package_type || 'server';
      alert(`Successfully installed ${packageType} from GitHub!`);
      
      // If the server needs configuration, open the modal
      if (response.needs_config && response.server_id) {
        setTimeout(() => {
          openCredentialModal(response.server_id!);
        }, 300);
      }
    } else {
      const errorMsg = response.error?.message || 'Unknown error';
      alert(`Failed to install from GitHub: ${errorMsg}`);
    }
  } catch (err) {
    console.error('Failed to install from GitHub:', err);
    alert(`Failed to install from GitHub: ${err}`);
  } finally {
    if (installGithubBtn) {
      installGithubBtn.disabled = false;
      installGithubBtn.textContent = 'Install';
    }
  }
}

// =============================================================================
// LLM Setup Management
// =============================================================================

let llmStatus: LLMSetupStatus | null = null;
let isDownloading = false;

async function checkLLMStatus(): Promise<void> {
  try {
    const response = await browser.runtime.sendMessage({
      type: 'llm_setup_status',
    }) as { type: string; status?: LLMSetupStatus };

    if (response.type === 'llm_setup_status_result' && response.status) {
      llmStatus = response.status;
      renderLLMStatus();
      updateRuntimeStatusDot();
    }
  } catch (err) {
    console.error('Failed to check LLM status:', err);
    llmStatusText.textContent = 'Error checking LLM';
    updateRuntimeStatusDot();
  }
}

function renderLLMStatus(): void {
  if (!llmStatus) return;

  if (llmStatus.available) {
    // LLM is running
    llmStatusIndicator.className = 'status-indicator connected';
    llmStatusText.className = 'status-text connected';
    llmStatusText.textContent = 'Available';
    
    const provider = llmStatus.runningProvider || 'Unknown';
    const providerName = provider === 'llamafile' ? 'Llamafile' : 
                         provider === 'ollama' ? 'Ollama' : 'External';
    
    // Build details HTML
    let detailsHtml = `<strong>${providerName}</strong>`;
    
    // Add Ollama-specific version info
    if (provider === 'ollama' && llmStatus.ollamaInfo) {
      const ollama = llmStatus.ollamaInfo;
      if (ollama.version) {
        detailsHtml += ` <span class="text-muted">v${ollama.version}</span>`;
      }
      
      // Tool support badge
      if (ollama.supportsTools) {
        detailsHtml += ` <span class="badge badge-success">Tools ✓</span>`;
      } else {
        detailsHtml += ` <span class="badge badge-warning">No Tools</span>`;
      }
    }
    
    detailsHtml += `<br><span class="text-xs text-muted mono">${llmStatus.runningUrl}</span>`;
    
    // Note: Don't add model here - it's shown in the control section below
    
    // Add Ollama warning if present
    if (llmStatus.ollamaInfo?.warning) {
      detailsHtml += `<div class="error-message mt-2" style="background: var(--color-warning-subtle); color: var(--color-warning);">
        ${llmStatus.ollamaInfo.warning}
      </div>`;
    }
    
    llmDetails.innerHTML = detailsHtml;
    
    // Hide download section when LLM is running
    llmDownloadSection.style.display = 'none';
    llmProgressSection.style.display = 'none';
    
    // Show controls for llamafile (we can stop it even if we didn't start it)
    if (llmStatus.runningProvider === 'llamafile') {
      llmControlSection.style.display = 'block';
      llmStartBtn.style.display = 'none';
      llmStopBtn.style.display = 'flex';
      llmDeleteBtn.style.display = 'none'; // Can't delete while running
      llmDownloadedModelName.textContent = llmStatus.activeModel || llmStatus.downloadedModels[0] || 'llamafile';
    } else {
      // External LLM (Ollama or other) - no stop button
      llmControlSection.style.display = 'none';
    }
    
  } else {
    // No LLM running
    llmDetails.textContent = '';
    
    // Check if we have downloaded models
    if (llmStatus.downloadedModels.length > 0) {
      // Has downloaded models - ready to start
      llmStatusIndicator.className = 'status-indicator warning';
      llmStatusText.className = 'status-text warning';
      llmStatusText.textContent = 'Ready to Start';
      llmDownloadSection.style.display = 'none';
      llmControlSection.style.display = 'block';
      llmStartBtn.style.display = 'flex';
      llmStopBtn.style.display = 'none';
      llmDeleteBtn.style.display = 'inline-flex';
      llmDownloadedModelName.textContent = llmStatus.downloadedModels.join(', ');
      llmDetails.textContent = '';
    } else {
      // No models - needs configuration
      llmStatusIndicator.className = 'status-indicator disconnected';
      llmStatusText.className = 'status-text disconnected';
      llmStatusText.textContent = 'Not Configured';
      // Show setup options
      llmDownloadSection.style.display = 'block';
      llmControlSection.style.display = 'none';
    }
  }
}

async function downloadLLMModel(): Promise<void> {
  if (isDownloading) return;
  
  const modelId = llmModelDropdown.value;
  const modelOption = llmModelDropdown.options[llmModelDropdown.selectedIndex];
  
  isDownloading = true;
  llmDownloadBtn.disabled = true;
  llmDownloadSection.style.display = 'none';
  llmProgressSection.style.display = 'block';
  
  // Extract just the model name (without size info)
  const modelName = (modelOption.textContent || modelId).split('(')[0].trim();
  llmDownloadModelName.textContent = modelName;
  
  // Use animated indeterminate progress bar
  llmProgressBar.style.width = '100%';
  llmProgressBar.classList.add('progress-bar-animated');
  
  try {
    // This is a long-running request - the bridge will stream progress
    // For now, we just wait for completion
    const response = await browser.runtime.sendMessage({
      type: 'llm_download_model',
      model_id: modelId,
    }) as { type: string; success?: boolean; status?: LLMSetupStatus };
    
    if (response.type === 'llm_download_model_result' && response.started) {
      // Download started in background - keep showing progress
      // Actual completion will come via status_update message
      console.log('Download started in background');
      return; // Don't hide progress section yet
    }
    
    if (response.type === 'llm_download_model_result' && response.success) {
      llmProgressBar.classList.remove('progress-bar-animated');
      llmProgressBar.style.width = '100%';
      llmProgressText.innerHTML = '✅ <strong>Download complete!</strong> Click "Start" to run the model.';
      
      if (response.status) {
        llmStatus = response.status;
      }
      
      // Wait a moment then refresh
      setTimeout(() => {
        llmProgressSection.style.display = 'none';
        renderLLMStatus();
      }, 1500);
      
    } else if (response.type === 'error') {
      const error = response as unknown as { error: { message: string } };
      llmProgressText.textContent = `Error: ${error.error.message}`;
      llmProgressBar.style.background = 'var(--accent-danger)';
      
      setTimeout(() => {
        llmProgressSection.style.display = 'none';
        llmDownloadSection.style.display = 'block';
      }, 3000);
    }
    
  } catch (err) {
    console.error('Download failed:', err);
    llmProgressBar.classList.remove('progress-bar-animated');
    llmProgressBar.style.width = '0%';
    llmProgressText.innerHTML = `❌ <strong>Download failed:</strong> ${err}`;
    
    setTimeout(() => {
      llmProgressSection.style.display = 'none';
      llmDownloadSection.style.display = 'block';
    }, 3000);
    
  } finally {
    isDownloading = false;
    llmDownloadBtn.disabled = false;
  }
}

async function startLocalLLM(): Promise<void> {
  if (!llmStatus?.downloadedModels.length) return;
  
  const modelId = llmStatus.downloadedModels[0]; // Use first downloaded
  llmStartBtn.disabled = true;
  llmStartBtn.textContent = 'Starting...';
  
  try {
    const response = await browser.runtime.sendMessage({
      type: 'llm_start_local',
      model_id: modelId,
    }) as { type: string; success?: boolean; url?: string };
    
    if (response.type === 'llm_start_local_result' && response.success) {
      // Trigger LLM detection and refresh all LLM UI components
      await browser.runtime.sendMessage({ type: 'llm_detect' });
      await checkLLMStatus();
      await loadLLMConfig(); // Refresh provider dropdown so llamafile shows as available
    } else if (response.type === 'error') {
      const error = response as unknown as { error: { message: string } };
      alert(`Failed to start LLM: ${error.error.message}`);
    }
    
  } catch (err) {
    console.error('Failed to start LLM:', err);
    alert(`Failed to start LLM: ${err}`);
  } finally {
    llmStartBtn.disabled = false;
    llmStartBtn.textContent = 'Start Local LLM';
  }
}

async function stopLocalLLM(): Promise<void> {
  llmStopBtn.disabled = true;
  llmStopBtn.textContent = 'Stopping...';
  
  try {
    await browser.runtime.sendMessage({
      type: 'llm_stop_local',
    });
    
    await checkLLMStatus();
    
  } catch (err) {
    console.error('Failed to stop LLM:', err);
  } finally {
    llmStopBtn.disabled = false;
    llmStopBtn.textContent = '⏹️ Stop';
  }
}

async function deleteLocalLLM(): Promise<void> {
  if (!llmStatus?.downloadedModels.length) return;
  
  const modelId = llmStatus.downloadedModels[0];
  
  // Confirm deletion
  if (!confirm(`Delete the downloaded model "${modelId}"?\n\nYou can re-download it later if needed.`)) {
    return;
  }
  
  llmDeleteBtn.disabled = true;
  
  try {
    const response = await browser.runtime.sendMessage({
      type: 'llm_delete_model',
      model_id: modelId,
    }) as { type: string; deleted?: boolean; success?: boolean; error?: string };
    
    console.log('[Sidebar] Delete response:', response);
    
    if (response.type === 'llm_delete_model_result' && response.deleted) {
      console.log('Model deleted successfully');
      // Clear local status and refresh
      llmStatus = null;
      await checkLLMStatus();
      renderLLMStatus();
    } else if (response.type === 'error') {
      console.error('Failed to delete model:', response.error);
      alert(`Failed to delete model: ${response.error || 'Unknown error'}`);
    } else {
      console.warn('Unexpected delete response:', response);
    }
  } catch (err) {
    console.error('Failed to delete model:', err);
    alert(`Failed to delete model: ${err}`);
  } finally {
    llmDeleteBtn.disabled = false;
  }
}

// =============================================================================
// Docker Status
// =============================================================================

interface DockerContainer {
  id: string;
  name: string;
  serverId: string;
  image: string;
  status: 'running' | 'stopped';
  statusText: string;
  uptime?: string;
  cpu?: string;
  memory?: string;
}

interface DockerStatus {
  available: boolean;
  version?: string;
  error?: string;
  images?: Record<string, { exists: boolean; size?: string }>;
  containers?: DockerContainer[];
}

let dockerStatus: DockerStatus | null = null;

async function checkDockerStatus(): Promise<void> {
  try {
    const response = await browser.runtime.sendMessage({
      type: 'check_docker',
    }) as { type: string } & DockerStatus;

    if (response.type === 'check_docker_result') {
      dockerStatus = {
        available: response.available,
        version: response.version,
        error: response.error,
        images: response.images,
        containers: response.containers,
      };
      renderDockerStatus();
      updateRuntimeStatusDot();
    }
  } catch (err) {
    console.error('Failed to check Docker status:', err);
    dockerStatusText.textContent = 'Error checking Docker';
    dockerStatusIndicator.className = 'status-indicator disconnected';
    updateRuntimeStatusDot();
  }
}

function renderDockerStatus(): void {
  if (!dockerStatus) return;

  if (dockerStatus.available) {
    dockerStatusIndicator.className = 'status-indicator connected';
    dockerStatusText.className = 'status-text connected';
    dockerStatusText.textContent = `🐳 Docker`;
    
    let detailsHtml = `<strong>v${dockerStatus.version || 'unknown'}</strong>`;
    
    // Show image status if available
    if (dockerStatus.images) {
      const builtImages = Object.entries(dockerStatus.images)
        .filter(([_, info]) => info.exists)
        .map(([name, info]) => `${name} (${info.size})`)
        .join(', ');
      
      if (builtImages) {
        detailsHtml += `<br><span class="text-xs text-muted">Images: ${builtImages}</span>`;
      } else {
        detailsHtml += `<br><span class="text-xs text-muted">No images built yet</span>`;
      }
    }
    
    // Show running containers
    if (dockerStatus.containers && dockerStatus.containers.length > 0) {
      const runningContainers = dockerStatus.containers.filter(c => c.status === 'running');
      
      if (runningContainers.length > 0) {
        detailsHtml += `<div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--color-border-subtle);">`;
        detailsHtml += `<div class="text-xs text-muted" style="margin-bottom: 4px;">Running Containers (${runningContainers.length}):</div>`;
        
        for (const container of runningContainers) {
          detailsHtml += `
            <div style="display: flex; align-items: center; gap: 6px; padding: 4px 0; font-size: 11px;">
              <span style="width: 6px; height: 6px; background: var(--color-success); border-radius: 50%; flex-shrink: 0;"></span>
              <span style="font-weight: 500; color: var(--text-primary);">${escapeHtml(container.serverId)}</span>
              ${container.uptime ? `<span class="text-muted">· ${escapeHtml(container.uptime)}</span>` : ''}
              ${container.cpu ? `<span class="text-muted">· CPU: ${escapeHtml(container.cpu)}</span>` : ''}
              ${container.memory ? `<span class="text-muted">· ${escapeHtml(container.memory.split(' / ')[0])}</span>` : ''}
            </div>
          `;
        }
        
        detailsHtml += `</div>`;
      }
    }
    
    dockerDetails.innerHTML = detailsHtml;
  } else {
    dockerStatusIndicator.className = 'status-indicator disconnected';
    dockerStatusText.className = 'status-text disconnected';
    dockerStatusText.textContent = '🐳 Docker';
    dockerDetails.innerHTML = `<span class="text-xs text-muted">${dockerStatus.error || 'Not available'}</span>`;
  }
}

// =============================================================================
// Runtime Dependencies Check
// =============================================================================

interface RuntimeInfo {
  type: string;
  available: boolean;
  version: string | null;
  path: string | null;
  runnerCmd: string | null;
  installHint: string | null;
}

interface RuntimesResponse {
  type: string;
  runtimes: RuntimeInfo[];
  canInstall: {
    npm: boolean;
    pypi: boolean;
    oci: boolean;
  };
}

let runtimesCache: RuntimesResponse | null = null;

async function checkRuntimes(): Promise<void> {
  try {
    const response = await browser.runtime.sendMessage({
      type: 'check_runtimes',
    }) as RuntimesResponse;

    if (response.type === 'check_runtimes_result') {
      runtimesCache = response;
      renderRuntimeStatus();
      updateCapabilitiesSummary();
    }
  } catch (err) {
    console.error('Failed to check runtimes:', err);
    // Set error state for Python and Node
    pythonStatusIndicator.className = 'status-indicator disconnected';
    pythonStatusText.textContent = 'Error';
    nodeStatusIndicator.className = 'status-indicator disconnected';
    nodeStatusText.textContent = 'Error';
  }
}

function renderRuntimeStatus(): void {
  if (!runtimesCache) return;

  const pythonRuntime = runtimesCache.runtimes.find(r => r.type === 'python');
  const nodeRuntime = runtimesCache.runtimes.find(r => r.type === 'node');

  // Render Python status
  if (pythonRuntime) {
    if (pythonRuntime.available) {
      pythonStatusIndicator.className = 'status-indicator connected';
      pythonStatusText.className = 'status-text connected';
      pythonStatusText.textContent = '🐍 Python';
      
      let details = `<strong>v${pythonRuntime.version || 'unknown'}</strong>`;
      if (pythonRuntime.runnerCmd) {
        details += `<br><span class="text-xs text-muted">Runner: ${escapeHtml(pythonRuntime.runnerCmd)}</span>`;
      }
      pythonDetails.innerHTML = details;
    } else {
      pythonStatusIndicator.className = 'status-indicator disconnected';
      pythonStatusText.className = 'status-text disconnected';
      pythonStatusText.textContent = '🐍 Python';
      pythonDetails.innerHTML = `<span class="text-xs text-muted">Not installed</span>`;
    }
  }

  // Render Node.js status
  if (nodeRuntime) {
    if (nodeRuntime.available) {
      nodeStatusIndicator.className = 'status-indicator connected';
      nodeStatusText.className = 'status-text connected';
      nodeStatusText.textContent = '📦 Node.js';
      
      let details = `<strong>v${nodeRuntime.version || 'unknown'}</strong>`;
      if (nodeRuntime.runnerCmd) {
        details += `<br><span class="text-xs text-muted">Runner: ${escapeHtml(nodeRuntime.runnerCmd)}</span>`;
      }
      details += `<br><span class="text-xs text-muted" style="font-style: italic;">Bridge uses bundled Node.js</span>`;
      nodeDetails.innerHTML = details;
    } else {
      nodeStatusIndicator.className = 'status-indicator warning';
      nodeStatusText.className = 'status-text warning';
      nodeStatusText.textContent = '📦 Node.js';
      nodeDetails.innerHTML = `<span class="text-xs text-muted">External Node.js not found<br><span style="font-style: italic;">Bridge uses bundled Node.js</span></span>`;
    }
  }
}

function updateCapabilitiesSummary(): void {
  if (!runtimesCache || !capabilitiesSummary || !capabilitiesMessages) return;

  const messages: string[] = [];

  const dockerRuntime = runtimesCache.runtimes.find(r => r.type === 'docker');
  const pythonRuntime = runtimesCache.runtimes.find(r => r.type === 'python');
  // Note: Node.js is always available via bundled bridge, so we don't warn about it

  // Docker is the most important - it enables running ANY server securely
  if (!dockerRuntime?.available && !dockerStatus?.available) {
    messages.push('• <strong>Docker not available:</strong> Cannot run MCP servers with native dependencies or in sandboxed containers. <a href="https://docker.com/products/docker-desktop/" target="_blank" style="color: var(--color-accent-primary);">Install Docker Desktop</a>');
  }

  // Python is needed for Python-based MCP servers when not using Docker
  if (!pythonRuntime?.available && !dockerRuntime?.available && !dockerStatus?.available) {
    messages.push('• <strong>Python not available:</strong> Cannot run Python MCP servers natively. Install Python 3 or use Docker.');
  }

  if (messages.length > 0) {
    capabilitiesSummary.style.display = 'block';
    capabilitiesMessages.innerHTML = messages.join('<br style="margin-bottom: 4px;">');
  } else {
    capabilitiesSummary.style.display = 'none';
  }
}

// Listen for state updates from background
browser.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as { 
    type: string; 
    state?: ConnectionState; 
    response?: BridgeResponse;
    category?: string;
    status?: string;
    percent?: number;
    bytesDownloaded?: number;
    totalBytes?: number;
    modelId?: string;
    error?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  };

  // Debug: log ALL messages received by sidebar
  console.log('[Sidebar] Received message:', msg.type, msg.category || '');

  if (msg.type === 'state_update' && msg.state) {
    updateConnectionUI(msg.state);
  }
  
  // Handle LLM download progress updates
  if (msg.type === 'catalog_status' && msg.category === 'llm_download') {
    console.log('[Sidebar] LLM download progress:', msg.status, msg.percent, '% bytes:', msg.bytesDownloaded);
    
    if (msg.status === 'downloading' && typeof msg.percent === 'number') {
      // Update progress bar
      llmProgressBar.classList.remove('progress-bar-animated');
      llmProgressBar.style.width = `${msg.percent}%`;
      const mbDownloaded = Math.round((msg.bytesDownloaded || 0) / 1_000_000);
      const mbTotal = Math.round((msg.totalBytes || 0) / 1_000_000);
      llmProgressText.textContent = `${msg.percent}% (${mbDownloaded} MB / ${mbTotal} MB)`;
    } else if (msg.status === 'complete') {
      // Download complete
      llmProgressBar.classList.remove('progress-bar-animated');
      llmProgressBar.style.width = '100%';
      llmProgressText.innerHTML = '✅ <strong>Download complete!</strong>';
      isDownloading = false;
      llmDownloadBtn.disabled = false;
      
      // Update status and UI after a brief delay
      setTimeout(() => {
        llmProgressSection.style.display = 'none';
        checkLLMStatus();
      }, 2000);
    } else if (msg.status === 'error') {
      // Download failed
      llmProgressBar.classList.remove('progress-bar-animated');
      llmProgressBar.style.width = '0%';
      llmProgressText.innerHTML = `❌ <strong>Download failed:</strong> ${msg.error || 'Unknown error'}`;
      isDownloading = false;
      llmDownloadBtn.disabled = false;
      
      setTimeout(() => {
        llmProgressSection.style.display = 'none';
        llmDownloadSection.style.display = 'block';
      }, 5000);
    }
  }
});

// Initialize

// =============================================================================
// Utility Functions
// =============================================================================

function formatTimeWithMs(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = date.getHours().toString().padStart(2, '0');
  const mins = date.getMinutes().toString().padStart(2, '0');
  const secs = date.getSeconds().toString().padStart(2, '0');
  const ms = date.getMilliseconds().toString().padStart(3, '0');
  return `${hours}:${mins}:${secs}.${ms}`;
}

// =============================================================================
// Bridge Activity Panel
// =============================================================================

interface BridgeLogEntry {
  id: number;
  timestamp: number;
  direction: 'send' | 'recv';
  type: string;
  summary: string;
  data: unknown;
}

let bridgeLog: BridgeLogEntry[] = [];
let bridgeTab: 'activity' | 'json' = 'activity';
let selectedBridgeEntry: BridgeLogEntry | null = null;

const bridgeActivityPanel = document.getElementById('bridge-activity-panel') as HTMLDivElement;
const bridgeActivityHeader = document.getElementById('bridge-activity-header') as HTMLDivElement;
const bridgeActivityContent = document.getElementById('bridge-activity-content') as HTMLDivElement;
const bridgeActivityLog = document.getElementById('bridge-activity-log') as HTMLDivElement;
const bridgeJsonView = document.getElementById('bridge-json-view') as HTMLDivElement;
const bridgeJsonContent = document.getElementById('bridge-json-content') as HTMLPreElement;
const bridgeIndicator = document.getElementById('bridge-indicator') as HTMLSpanElement;
const bridgeCollapseIcon = document.getElementById('bridge-activity-collapse-icon') as HTMLSpanElement;
const copyBridgeJsonBtn = document.getElementById('copy-bridge-json-btn') as HTMLButtonElement;

function initBridgeActivityPanel(): void {
  // Toggle collapsed state
  bridgeActivityHeader?.addEventListener('click', () => {
    bridgeActivityContent.classList.toggle('collapsed');
    bridgeCollapseIcon.textContent = bridgeActivityContent.classList.contains('collapsed') ? '▶' : '▼';
  });
  
  // Tab switching
  document.querySelectorAll('.bridge-tab').forEach(tab => {
    tab.addEventListener('click', (e) => {
      e.stopPropagation();
      const tabName = (tab as HTMLElement).dataset.tab as 'activity' | 'json';
      bridgeTab = tabName;
      
      document.querySelectorAll('.bridge-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      
      if (tabName === 'activity') {
        bridgeActivityLog.style.display = 'block';
        bridgeJsonView.style.display = 'none';
      } else {
        bridgeActivityLog.style.display = 'none';
        bridgeJsonView.style.display = 'block';
      }
    });
  });
  
  // Copy JSON button
  copyBridgeJsonBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const content = bridgeJsonContent.textContent || '';
    if (content && content !== 'Select a message to view') {
      try {
        await navigator.clipboard.writeText(content);
        const originalText = copyBridgeJsonBtn.textContent;
        copyBridgeJsonBtn.textContent = '✓ Copied!';
        setTimeout(() => {
          copyBridgeJsonBtn.textContent = originalText;
        }, 1500);
      } catch (err) {
        console.error('Failed to copy:', err);
      }
    }
  });
  
  // Load existing log
  loadBridgeLog();
}

async function loadBridgeLog(): Promise<void> {
  try {
    const response = await browser.runtime.sendMessage({ type: 'get_message_log' }) as { log: BridgeLogEntry[] };
    if (response?.log) {
      bridgeLog = response.log;
      renderBridgeLog();
    }
  } catch (e) {
    console.error('[Bridge Activity] Failed to load log:', e);
  }
}

function addBridgeEntry(entry: BridgeLogEntry): void {
  bridgeLog.push(entry);
  if (bridgeLog.length > 100) {
    bridgeLog.shift();
  }
  
  // Update indicator
  if (bridgeIndicator) {
    bridgeIndicator.classList.remove('idle', 'error');
    if (entry.type === 'error') {
      bridgeIndicator.classList.add('error');
    }
  }
  
  renderBridgeLog();
}

function renderBridgeLog(): void {
  if (!bridgeActivityLog) return;
  
  if (bridgeLog.length === 0) {
    bridgeActivityLog.innerHTML = '<div style="color: var(--color-text-muted); padding: var(--space-2);">No messages yet...</div>';
    return;
  }
  
  // Show newest at bottom (slice last 50)
  const entries = bridgeLog.slice(-50);
  
  bridgeActivityLog.innerHTML = entries.map(entry => {
    const time = formatTimeWithMs(entry.timestamp);
    const dirClass = entry.direction === 'send' ? 'send' : 'recv';
    const arrow = entry.direction === 'send' ? '→' : '←';
    
    return `
      <div class="bridge-entry" data-id="${entry.id}">
        <span class="bridge-time">${time}</span>
        <span class="bridge-dir ${dirClass}">${arrow}</span>
        <span class="bridge-type">${escapeHtml(entry.type)}</span>
        <span class="bridge-summary">${escapeHtml(entry.summary)}</span>
      </div>
    `;
  }).join('');
  
  // Auto-scroll to bottom
  bridgeActivityLog.scrollTop = bridgeActivityLog.scrollHeight;
  
  // Make entries clickable to show JSON
  bridgeActivityLog.querySelectorAll('.bridge-entry').forEach(el => {
    el.addEventListener('click', () => {
      const id = parseInt((el as HTMLElement).dataset.id || '0');
      const entry = bridgeLog.find(e => e.id === id);
      if (entry) {
        selectedBridgeEntry = entry;
        try {
          bridgeJsonContent.textContent = JSON.stringify(entry.data, null, 2);
        } catch {
          bridgeJsonContent.textContent = 'Unable to display message data';
        }
        // Switch to JSON tab
        bridgeTab = 'json';
        document.querySelectorAll('.bridge-tab').forEach(t => t.classList.remove('active'));
        document.querySelector('.bridge-tab[data-tab="json"]')?.classList.add('active');
        bridgeActivityLog.style.display = 'none';
        bridgeJsonView.style.display = 'block';
      }
    });
  });
}

// Listen for bridge activity updates
browser.runtime.onMessage.addListener((message) => {
  // Handle log entries for bridge activity panel
  if (message.type === 'log_entry') {
    addBridgeEntry(message.entry);
  }
  
  // Handle installed servers changed (after install/uninstall)
  if (message.type === 'installed_servers_changed') {
    console.log('[Sidebar] Installed servers changed, refreshing...');
    loadInstalledServers();
    checkDockerStatus(); // Refresh Docker container info too
  }
  
  // Handle server connected/disconnected
  if (message.type === 'mcp_server_connected' || message.type === 'mcp_server_disconnected') {
    console.log('[Sidebar] Server connection changed, refreshing Docker status...');
    setTimeout(() => checkDockerStatus(), 500); // Small delay for Docker to update
  }
  
  // Handle permissions changed (after grant/deny in permission prompt)
  if (message.type === 'permissions_changed') {
    console.log('[Sidebar] Permissions changed, refreshing...');
    loadPermissions();
  }
  
  // Handle server progress updates (Docker startup, etc.)
  if (message.type === 'server_progress') {
    const serverId = message.server_id as string;
    const progressMessage = message.message as string;
    console.log('[Sidebar] Server progress:', serverId, progressMessage);
    showServerProgress(serverId, progressMessage);
  }
});

// =============================================================================
// Collapsible Panels
// =============================================================================

const PANEL_COLLAPSE_KEY = 'harbor-panel-collapsed';

function loadPanelCollapseState(): Record<string, boolean> {
  try {
    const saved = localStorage.getItem(PANEL_COLLAPSE_KEY);
    if (saved) {
      return JSON.parse(saved);
    }
  } catch (e) {
    console.error('Failed to load panel collapse state:', e);
  }
  // Default: runtime status and bridge activity collapsed
  return {
    'runtime': true,
    'bridge-activity': true,
  };
}

function savePanelCollapseState(state: Record<string, boolean>): void {
  try {
    localStorage.setItem(PANEL_COLLAPSE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error('Failed to save panel collapse state:', e);
  }
}

function initCollapsiblePanels(): void {
  const collapseState = loadPanelCollapseState();
  
  // Apply initial state and add click handlers
  document.querySelectorAll('.panel[data-panel]').forEach(panel => {
    const panelId = panel.getAttribute('data-panel');
    if (!panelId) return;
    
    // Apply initial collapsed state
    if (collapseState[panelId]) {
      panel.classList.add('collapsed');
    } else {
      panel.classList.remove('collapsed');
    }
    
    // Add click handler to header
    const header = panel.querySelector('.panel-header');
    if (header) {
      header.addEventListener('click', (e) => {
        // Don't toggle if clicking on buttons inside header
        if ((e.target as HTMLElement).closest('button')) return;
        
        const isCollapsed = panel.classList.toggle('collapsed');
        const state = loadPanelCollapseState();
        state[panelId] = isCollapsed;
        savePanelCollapseState(state);
      });
    }
  });
}

function updateRuntimeStatusDot(): void {
  const dot = document.getElementById('runtime-status-dot');
  if (!dot) return;
  
  // Check LLM status
  const llmIndicator = document.getElementById('llm-status-indicator');
  const dockerIndicator = document.getElementById('docker-status-indicator');
  
  const llmOk = llmIndicator?.classList.contains('connected');
  const dockerOk = dockerIndicator?.classList.contains('connected');
  
  // Remove all status classes
  dot.classList.remove('green', 'yellow', 'red', 'gray');
  
  if (llmOk && dockerOk) {
    dot.classList.add('green');
    dot.title = 'All systems operational';
  } else if (llmOk || dockerOk) {
    dot.classList.add('yellow');
    dot.title = 'Some systems available';
  } else {
    dot.classList.add('red');
    dot.title = 'No runtimes available';
  }
}

function updateServersStatusDot(): void {
  const dot = document.getElementById('servers-status-dot');
  if (!dot) return;
  
  // Count running servers
  const runningCount = installedServers.filter(s => s.status === 'running').length;
  const errorCount = installedServers.filter(s => s.status === 'error').length;
  const totalCount = installedServers.length;
  
  // Remove all status classes
  dot.classList.remove('green', 'yellow', 'red', 'gray');
  
  if (totalCount === 0) {
    dot.classList.add('gray');
    dot.title = 'No servers installed';
  } else if (errorCount > 0) {
    dot.classList.add('red');
    dot.title = `${errorCount} server(s) with errors`;
  } else if (runningCount > 0) {
    dot.classList.add('green');
    dot.title = `${runningCount} server(s) running`;
  } else {
    dot.classList.add('yellow');
    dot.title = `${totalCount} server(s) stopped`;
  }
}

async function init(): Promise<void> {
  // Check if running as temporary/development extension
  await checkDevMode();
  
  // Initialize collapsible panels first
  initCollapsiblePanels();
  
  try {
    const state = (await browser.runtime.sendMessage({
      type: 'get_state',
    })) as ConnectionState;
    if (state) {
      updateConnectionUI(state);
    }
  } catch (err) {
    console.error('Failed to get initial state:', err);
  }

  await loadServers();
  await loadInstalledServers();
  await checkLLMStatus();
  
  // Skip automatic Docker check on startup to avoid macOS TCC permission popup
  // Docker status will be checked lazily when user interacts with Docker features
  const skipDockerAutoCheck = localStorage.getItem('harbor-skip-docker-autocheck') === 'true';
  if (!skipDockerAutoCheck) {
    await checkDockerStatus();
  }
  
  // Check all runtime dependencies (Python, Node.js)
  // This gives users visibility into what MCP server types they can run
  await checkRuntimes();
  
  // Load LLM provider configuration
  await loadLLMConfig();
  
  // Load site permissions
  await loadPermissions();
  
  // Update status dots
  updateRuntimeStatusDot();
  updateServersStatusDot();
  
  // Initialize bridge activity panel
  initBridgeActivityPanel();
  
  // Check for orphaned Docker containers and reconnect them
  // Skip if user has disabled Docker auto-check (avoids macOS permission popup)
  if (!skipDockerAutoCheck) {
    await reconnectOrphanedContainers();
  }
}

/**
 * Reconnect to any Docker containers that are still running from a previous session.
 */
async function reconnectOrphanedContainers(): Promise<void> {
  // Only proceed if Docker is available and has running containers
  if (!dockerStatus?.available || !dockerStatus?.containers?.length) {
    return;
  }
  
  const runningContainers = dockerStatus.containers.filter(c => c.status === 'running');
  if (runningContainers.length === 0) {
    return;
  }
  
  console.log(`[Sidebar] Found ${runningContainers.length} running Docker containers, attempting reconnection...`);
  
  // Show a notification to the user
  for (const container of runningContainers) {
    showServerProgress(container.serverId, '🔄 Reconnecting to running container...');
  }
  
  try {
    const response = await browser.runtime.sendMessage({
      type: 'reconnect_orphaned_containers',
    }) as { 
      type: string; 
      reconnected?: string[]; 
      failed?: Array<{ serverId: string; error: string }>;
      message?: string;
    };
    
    console.log('[Sidebar] Reconnect response:', response);
    
    if (response.type === 'reconnect_orphaned_containers_result') {
      // Clear progress for all containers
      for (const container of runningContainers) {
        clearServerProgress(container.serverId);
      }
      
      // Show success/failure notifications
      if (response.reconnected && response.reconnected.length > 0) {
        console.log(`[Sidebar] Successfully reconnected: ${response.reconnected.join(', ')}`);
      }
      
      if (response.failed && response.failed.length > 0) {
        for (const fail of response.failed) {
          console.warn(`[Sidebar] Failed to reconnect ${fail.serverId}: ${fail.error}`);
        }
      }
      
      // Refresh the server list and Docker status
      await loadInstalledServers();
      await checkDockerStatus();
    }
  } catch (err) {
    console.error('[Sidebar] Failed to reconnect orphaned containers:', err);
    // Clear progress on error
    for (const container of runningContainers) {
      clearServerProgress(container.serverId);
    }
  }
}

// Button handlers
sendHelloBtn.addEventListener('click', async () => {
  try {
    await browser.runtime.sendMessage({ type: 'send_hello' });
  } catch (err) {
    console.error('Failed to send hello:', err);
  }
});

reconnectBtn.addEventListener('click', async () => {
  try {
    await browser.runtime.sendMessage({ type: 'reconnect' });
  } catch (err) {
    console.error('Failed to reconnect:', err);
  }
});

// Open Directory button
openDirectoryBtn.addEventListener('click', () => {
  const directoryUrl = browser.runtime.getURL('directory.html');
  browser.tabs.create({ url: directoryUrl });
});

// Open Chat button (opens the API demo which serves as both reference implementation and usable chat)
const openChatBtn = document.getElementById('open-chat') as HTMLButtonElement;
openChatBtn?.addEventListener('click', () => {
  const demoUrl = browser.runtime.getURL('demo/index.html');
  browser.tabs.create({ url: demoUrl });
});

// Theme toggle
themeToggleBtn.addEventListener('click', toggleTheme);

// Refresh installed servers button
const refreshInstalledBtn = document.getElementById('refresh-installed') as HTMLButtonElement;
refreshInstalledBtn?.addEventListener('click', async () => {
  refreshInstalledBtn.classList.add('loading');
  refreshInstalledBtn.disabled = true;
  await loadInstalledServers();
  refreshInstalledBtn.classList.remove('loading');
  refreshInstalledBtn.disabled = false;
});

// Go to directory link (in empty state)
document.getElementById('go-to-directory-link')?.addEventListener('click', (e) => {
  e.preventDefault();
  openDirectoryBtn.click();
});

// Credential modal event listeners
credentialModalClose.addEventListener('click', closeCredentialModal);
credentialModalCancel.addEventListener('click', closeCredentialModal);
credentialModalSave.addEventListener('click', saveCredentials);

// Close modal on backdrop click
credentialModal.querySelector('.modal-backdrop')?.addEventListener('click', closeCredentialModal);

// Close modal on Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && credentialModal.style.display !== 'none') {
    closeCredentialModal();
  }
  if (e.key === 'Escape' && addRemoteModal.style.display !== 'none') {
    closeAddRemoteModal();
  }
});

// Add remote server modal
const addRemoteModal = document.getElementById('add-remote-modal') as HTMLDivElement;
const addRemoteBtn = document.getElementById('add-remote-server-btn') as HTMLButtonElement;
const addRemoteModalClose = document.getElementById('add-remote-modal-close') as HTMLButtonElement;
const addRemoteModalCancel = document.getElementById('add-remote-modal-cancel') as HTMLButtonElement;
const addRemoteModalAdd = document.getElementById('add-remote-modal-add') as HTMLButtonElement;
const remoteServerNameInput = document.getElementById('remote-server-name') as HTMLInputElement;
const remoteServerUrlInput = document.getElementById('remote-server-url') as HTMLInputElement;
const remoteServerTypeSelect = document.getElementById('remote-server-type') as HTMLSelectElement;

function openAddRemoteModal(): void {
  remoteServerNameInput.value = '';
  remoteServerUrlInput.value = '';
  remoteServerTypeSelect.value = 'http';
  addRemoteModal.style.display = 'flex';
  remoteServerNameInput.focus();
}

function closeAddRemoteModal(): void {
  addRemoteModal.style.display = 'none';
}

async function addRemoteServer(): Promise<void> {
  const name = remoteServerNameInput.value.trim();
  const url = remoteServerUrlInput.value.trim();
  const transportType = remoteServerTypeSelect.value as 'http' | 'sse';
  
  if (!name) {
    alert('Please enter a server name.');
    remoteServerNameInput.focus();
    return;
  }
  
  if (!url) {
    alert('Please enter a server URL.');
    remoteServerUrlInput.focus();
    return;
  }
  
  // Validate URL
  try {
    new URL(url);
  } catch {
    alert('Please enter a valid URL.');
    remoteServerUrlInput.focus();
    return;
  }
  
  addRemoteModalAdd.disabled = true;
  addRemoteModalAdd.textContent = 'Adding...';
  
  try {
    const response = await browser.runtime.sendMessage({
      type: 'add_remote_server',
      name,
      url,
      transport_type: transportType,
    });
    
    if (response?.type === 'add_remote_server_result') {
      closeAddRemoteModal();
      await loadInstalledServers();
    } else if (response?.type === 'error') {
      const error = response as unknown as { error: { message: string } };
      alert(`Failed to add server: ${error.error.message}`);
    }
  } catch (err) {
    console.error('Failed to add remote server:', err);
    alert('Failed to add remote server.');
  } finally {
    addRemoteModalAdd.disabled = false;
    addRemoteModalAdd.textContent = 'Add Server';
  }
}

// Add remote server event listeners
addRemoteBtn?.addEventListener('click', openAddRemoteModal);
addRemoteModalClose?.addEventListener('click', closeAddRemoteModal);
addRemoteModalCancel?.addEventListener('click', closeAddRemoteModal);
addRemoteModalAdd?.addEventListener('click', addRemoteServer);
addRemoteModal?.querySelector('.modal-backdrop')?.addEventListener('click', closeAddRemoteModal);

// Import config modal
const importConfigModal = document.getElementById('import-config-modal') as HTMLDivElement;
const importConfigBtn = document.getElementById('import-config-btn') as HTMLButtonElement;
const importConfigModalClose = document.getElementById('import-config-modal-close') as HTMLButtonElement;
const importConfigModalCancel = document.getElementById('import-config-modal-cancel') as HTMLButtonElement;
const importConfigModalImport = document.getElementById('import-config-modal-import') as HTMLButtonElement;
const importConfigJsonInput = document.getElementById('import-config-json') as HTMLTextAreaElement;

function openImportConfigModal(): void {
  importConfigJsonInput.value = '';
  importConfigModal.style.display = 'flex';
  importConfigJsonInput.focus();
}

function closeImportConfigModal(): void {
  importConfigModal.style.display = 'none';
}

async function importConfig(): Promise<void> {
  const configJson = importConfigJsonInput.value.trim();
  
  if (!configJson) {
    alert('Please paste a JSON configuration.');
    importConfigJsonInput.focus();
    return;
  }
  
  // Validate JSON
  try {
    JSON.parse(configJson);
  } catch {
    alert('Invalid JSON. Please check your configuration.');
    return;
  }
  
  importConfigModalImport.disabled = true;
  importConfigModalImport.textContent = 'Importing...';
  
  try {
    const response = await browser.runtime.sendMessage({
      type: 'import_config',
      config_json: configJson,
    }) as { 
      type: string; 
      imported?: Array<{ server: { name: string }; requiredInputs: Array<{ id: string; description: string }> }>; 
      errors?: Array<{ name: string; error: string }>;
      format?: string;
    };
    
    if (response?.type === 'import_config_result') {
      const imported = response.imported || [];
      const errors = response.errors || [];
      
      if (imported.length > 0) {
        closeImportConfigModal();
        await loadInstalledServers();
        
        // Show success message with any required inputs
        let message = `Successfully imported ${imported.length} server(s)`;
        
        // Check if any servers need credentials configured
        const needsConfig = imported.filter(i => i.requiredInputs && i.requiredInputs.length > 0);
        if (needsConfig.length > 0) {
          message += `\n\n⚠️ ${needsConfig.length} server(s) require credentials. Click the ⚙ gear icon to configure.`;
        }
        
        if (errors.length > 0) {
          message += `\n\n❌ ${errors.length} server(s) failed:\n${errors.map(e => `• ${e.name}: ${e.error}`).join('\n')}`;
        }
        
        alert(message);
      } else if (errors.length > 0) {
        alert(`Import failed:\n${errors.map(e => `• ${e.name}: ${e.error}`).join('\n')}`);
      } else {
        alert('No servers found in configuration.');
      }
    } else if (response?.type === 'error') {
      const error = response as unknown as { error: { message: string } };
      alert(`Import failed: ${error.error.message}`);
    }
  } catch (err) {
    console.error('Failed to import config:', err);
    alert('Failed to import configuration.');
  } finally {
    importConfigModalImport.disabled = false;
    importConfigModalImport.textContent = 'Import';
  }
}

// Import config event listeners
importConfigBtn?.addEventListener('click', openImportConfigModal);
importConfigModalClose?.addEventListener('click', closeImportConfigModal);
importConfigModalCancel?.addEventListener('click', closeImportConfigModal);
importConfigModalImport?.addEventListener('click', importConfig);
importConfigModal?.querySelector('.modal-backdrop')?.addEventListener('click', closeImportConfigModal);

// Handle Escape key for import modal too
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && importConfigModal?.style.display !== 'none') {
    closeImportConfigModal();
  }
});

// LLM event listeners
llmDownloadBtn.addEventListener('click', downloadLLMModel);
llmStartBtn.addEventListener('click', startLocalLLM);
llmStopBtn.addEventListener('click', stopLocalLLM);
llmDeleteBtn.addEventListener('click', deleteLocalLLM);

// =============================================================================
// LLM Provider Settings
// =============================================================================

// LLM Provider settings elements
const llmProviderSelect = document.getElementById('llm-provider-select') as HTMLSelectElement;
const llmModelSelect = document.getElementById('llm-model-select') as HTMLSelectElement;
const llmProviderStatus = document.getElementById('llm-provider-status') as HTMLDivElement;
const llmApiKeySection = document.getElementById('llm-api-key-section') as HTMLDivElement;
const llmApiKeysList = document.getElementById('llm-api-keys-list') as HTMLDivElement;
const llmSettingsDot = document.getElementById('llm-settings-dot') as HTMLSpanElement;
const refreshLlmConfigBtn = document.getElementById('refresh-llm-config') as HTMLButtonElement;

// LLM API Key Modal elements
const llmApiKeyModal = document.getElementById('llm-api-key-modal') as HTMLDivElement;
const llmApiKeyModalTitle = document.getElementById('llm-api-key-modal-title') as HTMLHeadingElement;
const llmApiKeyModalDescription = document.getElementById('llm-api-key-modal-description') as HTMLParagraphElement;
const llmApiKeyLabel = document.getElementById('llm-api-key-label') as HTMLSpanElement;
const llmApiKeyInput = document.getElementById('llm-api-key-input') as HTMLInputElement;
const llmApiKeyToggle = document.getElementById('llm-api-key-toggle') as HTMLButtonElement;
const llmApiKeyStatus = document.getElementById('llm-api-key-status') as HTMLDivElement;
const llmApiKeyHint = document.getElementById('llm-api-key-hint') as HTMLDivElement;
const llmApiKeyModalClose = document.getElementById('llm-api-key-modal-close') as HTMLButtonElement;
const llmApiKeyModalCancel = document.getElementById('llm-api-key-modal-cancel') as HTMLButtonElement;
const llmApiKeyModalRemove = document.getElementById('llm-api-key-modal-remove') as HTMLButtonElement;
const llmApiKeyModalSave = document.getElementById('llm-api-key-modal-save') as HTMLButtonElement;

let llmProviders: LLMProviderStatus[] = [];
let llmSupportedProviders: LLMSupportedProviders = { local: [], remote: [], configuredApiKeys: [] };
let currentApiKeyProvider: string | null = null;

// Provider display names and hints
const PROVIDER_INFO: Record<string, { name: string; hint: string; envVar: string }> = {
  openai: { 
    name: 'OpenAI', 
    hint: 'Get your API key from <a href="https://platform.openai.com/api-keys" target="_blank">platform.openai.com</a>',
    envVar: 'OPENAI_API_KEY'
  },
  anthropic: { 
    name: 'Anthropic', 
    hint: 'Get your API key from <a href="https://console.anthropic.com/settings/keys" target="_blank">console.anthropic.com</a>',
    envVar: 'ANTHROPIC_API_KEY'
  },
  mistral: { 
    name: 'Mistral', 
    hint: 'Get your API key from <a href="https://console.mistral.ai/api-keys/" target="_blank">console.mistral.ai</a>',
    envVar: 'MISTRAL_API_KEY'
  },
  groq: { 
    name: 'Groq', 
    hint: 'Get your API key from <a href="https://console.groq.com/keys" target="_blank">console.groq.com</a>',
    envVar: 'GROQ_API_KEY'
  },
  ollama: { name: 'Ollama', hint: 'Local LLM - no API key required', envVar: '' },
  llamafile: { name: 'llamafile', hint: 'Local LLM - no API key required', envVar: '' },
};

/**
 * Load LLM provider configuration.
 */
async function loadLLMConfig(): Promise<void> {
  try {
    // First, get supported providers
    const supportedResponse = await browser.runtime.sendMessage({
      type: 'llm_get_supported_providers',
    }) as { type: string; local?: string[]; remote?: string[]; configuredApiKeys?: string[] };
    
    if (supportedResponse.type === 'llm_get_supported_providers_result') {
      llmSupportedProviders = {
        local: supportedResponse.local || [],
        remote: supportedResponse.remote || [],
        configuredApiKeys: supportedResponse.configuredApiKeys || [],
      };
    }
    
    // Detect all providers
    const detectResponse = await browser.runtime.sendMessage({
      type: 'llm_detect',
    }) as { type: string; providers?: LLMProviderStatus[]; active?: string | null };
    
    if (detectResponse.type === 'llm_detect_result' && detectResponse.providers) {
      llmProviders = detectResponse.providers;
      console.log('[Sidebar] LLM providers detected:', llmProviders.map(p => ({ id: p.id, available: p.available })));
    }
    
    // Get current config
    const configResponse = await browser.runtime.sendMessage({
      type: 'llm_get_config',
    }) as { type: string; activeProvider?: string | null; activeModel?: string | null; configuredApiKeys?: string[] };
    
    if (configResponse.type === 'llm_get_config_result') {
      // Update configured keys from fresh response
      if (configResponse.configuredApiKeys) {
        llmSupportedProviders.configuredApiKeys = configResponse.configuredApiKeys;
      }
    }
    
    renderLLMProviderSettings(configResponse.activeProvider, configResponse.activeModel);
  } catch (err) {
    console.error('Failed to load LLM config:', err);
    llmProviderStatus.textContent = 'Error loading LLM configuration';
  }
}

/**
 * Render LLM provider settings UI.
 */
function renderLLMProviderSettings(activeProvider: string | null | undefined, activeModel: string | null | undefined): void {
  console.log('[Sidebar] Rendering LLM settings:', { 
    activeProvider, 
    activeModel, 
    localProviders: llmSupportedProviders.local,
    llmProviders: llmProviders.map(p => ({ id: p.id, available: p.available }))
  });
  
  // Populate provider dropdown
  llmProviderSelect.innerHTML = '<option value="">-- Select Provider --</option>';
  
  // Add local providers first
  const localGroup = document.createElement('optgroup');
  localGroup.label = 'Local (no API key)';
  for (const providerId of llmSupportedProviders.local) {
    const option = document.createElement('option');
    option.value = providerId;
    const info = PROVIDER_INFO[providerId] || { name: providerId };
    const providerStatus = llmProviders.find(p => p.id === providerId);
    const available = providerStatus?.available ? ' ✓' : ' (offline)';
    option.textContent = info.name + available;
    option.disabled = !providerStatus?.available;
    if (providerId === activeProvider) {
      option.selected = true;
    }
    localGroup.appendChild(option);
  }
  llmProviderSelect.appendChild(localGroup);
  
  // Add remote providers
  const remoteGroup = document.createElement('optgroup');
  remoteGroup.label = 'Remote (API key required)';
  for (const providerId of llmSupportedProviders.remote) {
    const option = document.createElement('option');
    option.value = providerId;
    const info = PROVIDER_INFO[providerId] || { name: providerId };
    const hasKey = llmSupportedProviders.configuredApiKeys.includes(providerId);
    const providerStatus = llmProviders.find(p => p.id === providerId);
    const available = providerStatus?.available ? ' ✓' : hasKey ? ' (configured)' : ' (no key)';
    option.textContent = info.name + available;
    if (providerId === activeProvider) {
      option.selected = true;
    }
    remoteGroup.appendChild(option);
  }
  llmProviderSelect.appendChild(remoteGroup);
  
  // Populate model dropdown if a provider is selected
  updateModelDropdown(activeProvider, activeModel);
  
  // Show API key section for remote providers
  renderApiKeySection();
  
  // Update status dot
  updateLLMSettingsDot(activeProvider);
  
  // Show provider status
  if (activeProvider) {
    const status = llmProviders.find(p => p.id === activeProvider);
    if (status) {
      let html = `<strong>${PROVIDER_INFO[activeProvider]?.name || activeProvider}</strong>`;
      if (status.available) {
        html += ` <span class="badge badge-success">Available</span>`;
        if (status.version) {
          html += ` v${status.version}`;
        }
        if (status.supportsTools) {
          html += ` <span class="badge badge-success">Tools ✓</span>`;
        }
      } else if (status.error) {
        html += ` <span class="badge badge-error">Error</span>`;
        html += `<br><span class="text-xs text-muted">${status.error}</span>`;
      }
      if (activeModel) {
        html += `<br><span class="text-xs text-muted">Model: ${activeModel}</span>`;
      }
      llmProviderStatus.innerHTML = html;
    } else {
      llmProviderStatus.innerHTML = '';
    }
  } else {
    llmProviderStatus.innerHTML = '<span class="text-muted">No provider selected</span>';
  }
}

/**
 * Update model dropdown for selected provider.
 */
async function updateModelDropdown(providerId: string | null | undefined, activeModel: string | null | undefined): Promise<void> {
  if (!providerId) {
    llmModelSelect.innerHTML = '<option value="">-- Select Provider First --</option>';
    llmModelSelect.disabled = true;
    return;
  }
  
  const providerStatus = llmProviders.find(p => p.id === providerId);
  if (!providerStatus?.available) {
    llmModelSelect.innerHTML = '<option value="">-- Provider Not Available --</option>';
    llmModelSelect.disabled = true;
    return;
  }
  
  llmModelSelect.disabled = false;
  
  // Get models for this provider
  let models = providerStatus.models || [];
  
  // If no cached models, fetch them
  if (models.length === 0) {
    try {
      const response = await browser.runtime.sendMessage({
        type: 'llm_list_models_for',
        provider_id: providerId,
      }) as { type: string; models?: LLMModel[] };
      
      if (response.type === 'llm_list_models_for_result' && response.models) {
        models = response.models;
      }
    } catch (err) {
      console.error('Failed to load models:', err);
    }
  }
  
  llmModelSelect.innerHTML = '';
  
  if (models.length === 0) {
    llmModelSelect.innerHTML = '<option value="">-- No Models Available --</option>';
    return;
  }
  
  for (const model of models) {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.id + (model.supportsTools ? ' (tools)' : '');
    if (model.id === activeModel) {
      option.selected = true;
    }
    llmModelSelect.appendChild(option);
  }
  
  // Select first if none selected
  if (!activeModel && models.length > 0) {
    llmModelSelect.value = models[0].id;
  }
}

/**
 * Render API key configuration section.
 */
function renderApiKeySection(): void {
  // Only show if there are remote providers
  if (llmSupportedProviders.remote.length === 0) {
    llmApiKeySection.style.display = 'none';
    return;
  }
  
  llmApiKeySection.style.display = 'block';
  
  let html = '';
  for (const providerId of llmSupportedProviders.remote) {
    const info = PROVIDER_INFO[providerId] || { name: providerId };
    const hasKey = llmSupportedProviders.configuredApiKeys.includes(providerId);
    
    html += `
      <div class="credential-field" style="margin-bottom: var(--space-2);">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span class="credential-label-text">${info.name}</span>
          <button class="btn btn-sm ${hasKey ? 'btn-ghost' : 'btn-primary'} api-key-configure-btn" data-provider="${providerId}">
            ${hasKey ? '✓ Configured' : 'Add Key'}
          </button>
        </div>
      </div>
    `;
  }
  
  llmApiKeysList.innerHTML = html;
  
  // Add event listeners
  llmApiKeysList.querySelectorAll('.api-key-configure-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const providerId = (btn as HTMLElement).dataset.provider!;
      openApiKeyModal(providerId);
    });
  });
}

/**
 * Update LLM settings status dot.
 */
function updateLLMSettingsDot(activeProvider: string | null | undefined): void {
  llmSettingsDot.classList.remove('green', 'yellow', 'red', 'gray');
  
  if (!activeProvider) {
    llmSettingsDot.classList.add('gray');
    llmSettingsDot.title = 'No provider selected';
    return;
  }
  
  const status = llmProviders.find(p => p.id === activeProvider);
  if (status?.available) {
    llmSettingsDot.classList.add('green');
    llmSettingsDot.title = `${PROVIDER_INFO[activeProvider]?.name || activeProvider} connected`;
  } else if (llmSupportedProviders.configuredApiKeys.includes(activeProvider)) {
    llmSettingsDot.classList.add('yellow');
    llmSettingsDot.title = `${PROVIDER_INFO[activeProvider]?.name || activeProvider} configured but not available`;
  } else {
    llmSettingsDot.classList.add('red');
    llmSettingsDot.title = `${PROVIDER_INFO[activeProvider]?.name || activeProvider} not available`;
  }
}

/**
 * Open API key configuration modal.
 */
function openApiKeyModal(providerId: string): void {
  currentApiKeyProvider = providerId;
  const info = PROVIDER_INFO[providerId] || { name: providerId, hint: '', envVar: '' };
  const hasKey = llmSupportedProviders.configuredApiKeys.includes(providerId);
  
  llmApiKeyModalTitle.textContent = `Configure ${info.name} API Key`;
  llmApiKeyModalDescription.textContent = `Enter your ${info.name} API key to enable this provider.`;
  llmApiKeyLabel.textContent = info.envVar || 'API Key';
  llmApiKeyInput.value = '';
  llmApiKeyInput.placeholder = hasKey ? '••••••••••••' : 'Enter API key...';
  llmApiKeyHint.innerHTML = info.hint || '';
  
  if (hasKey) {
    llmApiKeyStatus.className = 'credential-status set';
    llmApiKeyStatus.textContent = '✓ Key configured';
    llmApiKeyModalRemove.style.display = 'inline-flex';
  } else {
    llmApiKeyStatus.className = 'credential-status missing';
    llmApiKeyStatus.textContent = '! Not configured';
    llmApiKeyModalRemove.style.display = 'none';
  }
  
  llmApiKeyModal.style.display = 'flex';
  llmApiKeyInput.focus();
}

/**
 * Close API key modal.
 */
function closeApiKeyModal(): void {
  llmApiKeyModal.style.display = 'none';
  currentApiKeyProvider = null;
}

/**
 * Save API key.
 */
async function saveApiKey(): Promise<void> {
  if (!currentApiKeyProvider) return;
  
  const apiKey = llmApiKeyInput.value.trim();
  if (!apiKey) {
    alert('Please enter an API key.');
    return;
  }
  
  llmApiKeyModalSave.disabled = true;
  llmApiKeyModalSave.textContent = 'Saving...';
  
  try {
    const response = await browser.runtime.sendMessage({
      type: 'llm_set_api_key',
      provider_id: currentApiKeyProvider,
      api_key: apiKey,
    }) as { type: string; success?: boolean; available?: boolean };
    
    if (response.type === 'llm_set_api_key_result' && response.success) {
      // Save provider ID before closing modal (which clears it)
      const savedProviderId = currentApiKeyProvider;
      
      closeApiKeyModal();
      await loadLLMConfig();
      
      // If this provider is now available and not already selected, offer to select it
      if (response.available && savedProviderId && llmProviderSelect.value !== savedProviderId) {
        const providerName = PROVIDER_INFO[savedProviderId]?.name || savedProviderId;
        if (confirm(`${providerName} is now available. Use it as your LLM provider?`)) {
          llmProviderSelect.value = savedProviderId;
          await onProviderChange();
        }
      }
    } else {
      alert('Failed to save API key.');
    }
  } catch (err) {
    console.error('Failed to save API key:', err);
    alert('Error saving API key.');
  } finally {
    llmApiKeyModalSave.disabled = false;
    llmApiKeyModalSave.textContent = 'Save';
  }
}

/**
 * Remove API key.
 */
async function removeApiKey(): Promise<void> {
  if (!currentApiKeyProvider) return;
  
  if (!confirm(`Remove API key for ${PROVIDER_INFO[currentApiKeyProvider]?.name || currentApiKeyProvider}?`)) {
    return;
  }
  
  try {
    await browser.runtime.sendMessage({
      type: 'llm_remove_api_key',
      provider_id: currentApiKeyProvider,
    });
    
    closeApiKeyModal();
    await loadLLMConfig();
  } catch (err) {
    console.error('Failed to remove API key:', err);
    alert('Error removing API key.');
  }
}

/**
 * Handle provider selection change.
 */
async function onProviderChange(): Promise<void> {
  const providerId = llmProviderSelect.value;
  
  if (!providerId) {
    llmModelSelect.innerHTML = '<option value="">-- Select Provider First --</option>';
    llmModelSelect.disabled = true;
    llmProviderStatus.innerHTML = '';
    updateLLMSettingsDot(null);
    return;
  }
  
  // Check if this is a remote provider without API key
  if (llmSupportedProviders.remote.includes(providerId) && 
      !llmSupportedProviders.configuredApiKeys.includes(providerId)) {
    // Open API key modal
    openApiKeyModal(providerId);
    return;
  }
  
  // Set the active provider
  try {
    const response = await browser.runtime.sendMessage({
      type: 'llm_set_active',
      provider_id: providerId,
    }) as { type: string; success?: boolean; model?: string };
    
    if (response.type === 'llm_set_active_result' && response.success) {
      await loadLLMConfig();
    } else {
      alert('Failed to set provider.');
      await loadLLMConfig();
    }
  } catch (err) {
    console.error('Failed to set provider:', err);
    alert('Error setting provider.');
    await loadLLMConfig();
  }
}

/**
 * Handle model selection change.
 */
async function onModelChange(): Promise<void> {
  const modelId = llmModelSelect.value;
  
  if (!modelId) return;
  
  try {
    await browser.runtime.sendMessage({
      type: 'llm_set_model',
      model_id: modelId,
    });
    
    // Update status display
    const activeProvider = llmProviderSelect.value;
    if (activeProvider) {
      const status = llmProviders.find(p => p.id === activeProvider);
      if (status) {
        let html = `<strong>${PROVIDER_INFO[activeProvider]?.name || activeProvider}</strong>`;
        if (status.available) {
          html += ` <span class="badge badge-success">Available</span>`;
        }
        html += `<br><span class="text-xs text-muted">Model: ${modelId}</span>`;
        llmProviderStatus.innerHTML = html;
      }
    }
  } catch (err) {
    console.error('Failed to set model:', err);
  }
}

// LLM Provider settings event listeners
llmProviderSelect?.addEventListener('change', onProviderChange);
llmModelSelect?.addEventListener('change', onModelChange);
refreshLlmConfigBtn?.addEventListener('click', loadLLMConfig);

// API Key modal event listeners
llmApiKeyModalClose?.addEventListener('click', closeApiKeyModal);
llmApiKeyModalCancel?.addEventListener('click', closeApiKeyModal);
llmApiKeyModalSave?.addEventListener('click', saveApiKey);
llmApiKeyModalRemove?.addEventListener('click', removeApiKey);
llmApiKeyModal?.querySelector('.modal-backdrop')?.addEventListener('click', closeApiKeyModal);

// API Key toggle visibility
llmApiKeyToggle?.addEventListener('click', () => {
  const isPassword = llmApiKeyInput.type === 'password';
  llmApiKeyInput.type = isPassword ? 'text' : 'password';
  llmApiKeyToggle.textContent = isPassword ? '○' : '◉';
});

// Close modal on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && llmApiKeyModal?.style.display !== 'none') {
    closeApiKeyModal();
  }
});

// GitHub install event listeners
installGithubBtn?.addEventListener('click', installFromGithubUrl);

githubUrlInput?.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    installFromGithubUrl();
  }
});

// =============================================================================
// Permissions Management
// =============================================================================

interface PermissionStatus {
  origin: string;
  scopes: Record<string, string>;
  allowedTools?: string[];
}

const permissionsListEl = document.getElementById('permissions-list') as HTMLDivElement;
const refreshPermissionsBtn = document.getElementById('refresh-permissions') as HTMLButtonElement;

async function loadPermissions(): Promise<void> {
  try {
    const response = await browser.runtime.sendMessage({
      type: 'list_all_permissions',
    }) as { type: string; permissions?: PermissionStatus[] };

    if (response.type === 'list_all_permissions_result' && response.permissions) {
      renderPermissions(response.permissions);
    }
  } catch (err) {
    console.error('Failed to load permissions:', err);
    permissionsListEl.innerHTML = `
      <div class="empty-state">
        Failed to load permissions.
      </div>
    `;
  }
}

function renderPermissions(permissions: PermissionStatus[]): void {
  if (permissions.length === 0) {
    permissionsListEl.innerHTML = `
      <div class="empty-state">
        No site permissions granted yet.
      </div>
    `;
    return;
  }

  permissionsListEl.innerHTML = permissions.map(perm => {
    const grantedScopes = Object.entries(perm.scopes)
      .filter(([_, status]) => status === 'granted-always' || status === 'granted-once')
      .map(([scope, status]) => ({ scope, status }));
    
    const deniedScopes = Object.entries(perm.scopes)
      .filter(([_, status]) => status === 'denied')
      .map(([scope]) => scope);

    const scopeBadges = [
      ...grantedScopes.map(({ scope, status }) => {
        const label = scope.split(':')[1] || scope;
        const isOnce = status === 'granted-once';
        const badgeClass = isOnce ? 'permission-scope-badge temporary' : 'permission-scope-badge';
        const suffix = isOnce ? ' <span class="permission-temp-label">⏱ once</span>' : '';
        return `<span class="${badgeClass}">${escapeHtml(label)}${suffix}</span>`;
      }),
      ...deniedScopes.map(scope => {
        const label = scope.split(':')[1] || scope;
        return `<span class="permission-scope-badge denied">${escapeHtml(label)} ✕</span>`;
      }),
    ].join('');

    let toolsHtml = '';
    if (perm.allowedTools && perm.allowedTools.length > 0) {
      const toolBadges = perm.allowedTools.map(tool => {
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

    return `
      <div class="permission-origin-item" data-origin="${escapeHtml(perm.origin)}">
        <div class="permission-origin-header">
          <span class="permission-origin-name">${escapeHtml(perm.origin)}</span>
        </div>
        <div class="permission-scopes">
          ${scopeBadges || '<span class="text-muted text-xs">No scopes</span>'}
        </div>
        ${toolsHtml}
        <div class="permission-actions">
          <button class="btn btn-sm btn-ghost edit-permissions-btn" data-origin="${escapeHtml(perm.origin)}">Edit</button>
          <button class="btn btn-sm btn-danger revoke-permissions-btn" data-origin="${escapeHtml(perm.origin)}">Revoke All</button>
        </div>
      </div>
    `;
  }).join('');

  // Add event listeners
  permissionsListEl.querySelectorAll('.revoke-permissions-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const origin = (btn as HTMLElement).dataset.origin!;
      if (!confirm(`Revoke all permissions for ${origin}?`)) return;
      
      try {
        await browser.runtime.sendMessage({
          type: 'revoke_origin_permissions',
          origin,
        });
        await loadPermissions();
      } catch (err) {
        console.error('Failed to revoke permissions:', err);
        alert('Failed to revoke permissions.');
      }
    });
  });

  permissionsListEl.querySelectorAll('.edit-permissions-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const origin = (btn as HTMLElement).dataset.origin!;
      // TODO: Open a modal to edit permissions/tools for this origin
      alert(`Edit permissions for ${origin}\n\nComing soon: This will allow you to modify allowed tools.`);
    });
  });
}

// Refresh permissions button
refreshPermissionsBtn?.addEventListener('click', async () => {
  refreshPermissionsBtn.classList.add('loading');
  refreshPermissionsBtn.disabled = true;
  await loadPermissions();
  refreshPermissionsBtn.classList.remove('loading');
  refreshPermissionsBtn.disabled = false;
});

init();
