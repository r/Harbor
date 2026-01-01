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

// Docker elements
const dockerStatusIndicator = document.getElementById('docker-status-indicator') as HTMLDivElement;
const dockerStatusText = document.getElementById('docker-status-text') as HTMLSpanElement;
const dockerDetails = document.getElementById('docker-details') as HTMLDivElement;

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
              <button class="btn btn-sm btn-success start-btn" data-server-id="${escapeHtml(server.id)}">Start</button>
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
  installedServerListEl.querySelectorAll('.configure-btn').forEach(btn => {
    btn.addEventListener('click', () => openCredentialModal((btn as HTMLElement).dataset.serverId!));
  });

  installedServerListEl.querySelectorAll('.start-btn').forEach(btn => {
    console.log('[Sidebar] Adding click listener to start button for:', (btn as HTMLElement).dataset.serverId);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const serverId = (btn as HTMLElement).dataset.serverId!;
      console.log('[Sidebar] Start button clicked for:', serverId);
      startInstalledServer(serverId);
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

  credentialModal.style.display = 'flex';
}

function closeCredentialModal(): void {
  credentialModal.style.display = 'none';
  currentCredentialServerId = null;
}

async function saveCredentials(): Promise<void> {
  if (!currentCredentialServerId) return;

  const inputs = credentialModalBody.querySelectorAll('.credential-input') as NodeListOf<HTMLInputElement>;
  let hasErrors = false;

  for (const input of inputs) {
    const key = input.dataset.key!;
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
  
  // Show initial progress if using Docker
  if (useDocker) {
    showServerProgress(serverId, 'Starting Docker...');
  }
  
  try {
    // Use mcp_connect to start and connect via stdio
    const response = await browser.runtime.sendMessage({
      type: 'mcp_connect',
      server_id: serverId,
      skip_security_check: skipSecurityCheck,
      use_docker: useDocker,
    }) as { 
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
    };

    console.log('[Sidebar] Start response:', response);
    console.log('[Sidebar] docker_fallback_available:', response.docker_fallback_available);
    console.log('[Sidebar] docker_fallback_message:', response.docker_fallback_message);

    if (response.type === 'mcp_connect_result') {
      if (response.connected) {
        console.log('[Sidebar] Server started and connected:', serverId, 'docker:', response.running_in_docker);
        clearServerProgress(serverId);
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
        alert(`Failed to start: ${response.error}`);
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
  }
}

function showSecurityApprovalModal(
  serverId: string, 
  instructions: string,
  dockerAvailable: boolean = false,
  dockerRecommended: boolean = false
): void {
  // Build Docker button if available
  const dockerButton = dockerAvailable 
    ? `<button class="btn btn-success" id="security-docker-btn" style="margin-right: auto;">
        🐳 Run in Docker${dockerRecommended ? ' (Recommended)' : ''}
       </button>`
    : '';
  
  // Create modal HTML
  const modalHtml = `
    <div class="modal-overlay" id="security-modal">
      <div class="modal-content" style="max-width: 550px;">
        <div class="modal-header">
          <h3>⚠️ macOS Security Approval</h3>
        </div>
        <div class="modal-body">
          <pre style="white-space: pre-wrap; font-family: var(--font-sans); font-size: var(--text-sm); line-height: 1.5; background: var(--color-surface-secondary); padding: var(--space-3); border-radius: var(--radius-md); overflow-x: auto;">${escapeHtml(instructions)}</pre>
        </div>
        <div class="modal-footer" style="display: flex; gap: var(--space-2);">
          ${dockerButton}
          <button class="btn btn-secondary" id="security-cancel-btn">Cancel</button>
          <button class="btn btn-primary" id="security-proceed-btn">I've Allowed It - Start Now</button>
        </div>
      </div>
    </div>
  `;

  // Add to DOM
  const container = document.createElement('div');
  container.innerHTML = modalHtml;
  document.body.appendChild(container.firstElementChild!);

  // Event handlers
  const modal = document.getElementById('security-modal')!;
  const cancelBtn = document.getElementById('security-cancel-btn')!;
  const proceedBtn = document.getElementById('security-proceed-btn')!;
  const dockerBtn = document.getElementById('security-docker-btn');

  cancelBtn.addEventListener('click', () => {
    modal.remove();
  });

  proceedBtn.addEventListener('click', async () => {
    modal.remove();
    // Retry with skip_security_check to bypass the first-run check
    await startInstalledServer(serverId, true, false);
  });
  
  // Docker button handler
  if (dockerBtn) {
    dockerBtn.addEventListener('click', async () => {
      modal.remove();
      // Start in Docker mode
      await startInstalledServer(serverId, false, true);
    });
  }

  // Click outside to close
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.remove();
    }
  });
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
    
    if (llmStatus.activeModel) {
      detailsHtml += `<br><span class="text-xs">Model: ${llmStatus.activeModel}</span>`;
    }
    
    // Add Ollama warning if present
    if (llmStatus.ollamaInfo?.warning) {
      detailsHtml += `<div class="error-message mt-2" style="background: var(--color-warning-subtle); color: var(--color-warning);">
        ${llmStatus.ollamaInfo.warning}
      </div>`;
    }
    
    llmDetails.innerHTML = detailsHtml;
    
    // Hide download section, show controls if we started it
    llmDownloadSection.style.display = 'none';
    llmProgressSection.style.display = 'none';
    
    if (llmStatus.activeModel) {
      // We started this LLM, show stop button
      llmControlSection.style.display = 'block';
      llmStartBtn.style.display = 'none';
      llmStopBtn.style.display = 'flex';
    } else {
      llmControlSection.style.display = 'none';
    }
    
  } else {
    // No LLM running
    llmStatusIndicator.className = 'status-indicator disconnected';
    llmStatusText.className = 'status-text disconnected';
    llmStatusText.textContent = 'Not Available';
    llmDetails.textContent = '';
    
    // Check if we have downloaded models
    if (llmStatus.downloadedModels.length > 0) {
      llmDownloadSection.style.display = 'none';
      llmControlSection.style.display = 'block';
      llmStartBtn.style.display = 'flex';
      llmStopBtn.style.display = 'none';
      llmDetails.textContent = `Downloaded: ${llmStatus.downloadedModels.join(', ')}`;
    } else {
      // Show download section
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
  llmDownloadModelName.textContent = modelOption.textContent || modelId;
  llmProgressBar.style.width = '0%';
  llmProgressText.textContent = 'Starting download...';
  
  try {
    // This is a long-running request - the bridge will stream progress
    // For now, we just wait for completion
    const response = await browser.runtime.sendMessage({
      type: 'llm_download_model',
      model_id: modelId,
    }) as { type: string; success?: boolean; status?: LLMSetupStatus };
    
    if (response.type === 'llm_download_model_result' && response.success) {
      llmProgressBar.style.width = '100%';
      llmProgressText.textContent = 'Download complete!';
      
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
    llmProgressText.textContent = `Error: ${err}`;
    
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
      // Also trigger LLM detection so the LLM manager knows about it
      await browser.runtime.sendMessage({ type: 'llm_detect' });
      await checkLLMStatus();
    } else if (response.type === 'error') {
      const error = response as unknown as { error: { message: string } };
      alert(`Failed to start LLM: ${error.error.message}`);
    }
    
  } catch (err) {
    console.error('Failed to start LLM:', err);
    alert(`Failed to start LLM: ${err}`);
  } finally {
    llmStartBtn.disabled = false;
    llmStartBtn.textContent = '▶️ Start';
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

// =============================================================================
// Docker Status
// =============================================================================

interface DockerStatus {
  available: boolean;
  version?: string;
  error?: string;
  images?: Record<string, { exists: boolean; size?: string }>;
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
    
    dockerDetails.innerHTML = detailsHtml;
  } else {
    dockerStatusIndicator.className = 'status-indicator disconnected';
    dockerStatusText.className = 'status-text disconnected';
    dockerStatusText.textContent = '🐳 Docker';
    dockerDetails.innerHTML = `<span class="text-xs text-muted">${dockerStatus.error || 'Not available'}</span>`;
  }
}

// Listen for state updates from background
browser.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as { type: string; state?: ConnectionState; response?: BridgeResponse };

  if (msg.type === 'state_update' && msg.state) {
    updateConnectionUI(msg.state);
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
  await checkDockerStatus();
  
  // Update status dots
  updateRuntimeStatusDot();
  updateServersStatusDot();
  
  // Initialize bridge activity panel
  initBridgeActivityPanel();
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

// Open Chat button
const openChatBtn = document.getElementById('open-chat') as HTMLButtonElement;
openChatBtn?.addEventListener('click', () => {
  const chatUrl = browser.runtime.getURL('chat.html');
  browser.tabs.create({ url: chatUrl });
});

// Open Chat POC (API demo) button
const openChatPocBtn = document.getElementById('open-chat-poc') as HTMLButtonElement;
openChatPocBtn?.addEventListener('click', () => {
  const chatPocUrl = browser.runtime.getURL('demo/index.html');
  browser.tabs.create({ url: chatPocUrl });
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

// GitHub install event listeners
installGithubBtn?.addEventListener('click', installFromGithubUrl);

githubUrlInput?.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    installFromGithubUrl();
  }
});

init();
