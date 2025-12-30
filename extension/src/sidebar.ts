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

// Theme handling
function initTheme(): void {
  const savedTheme = localStorage.getItem('harbor-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = savedTheme || (prefersDark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
  updateThemeIcon(theme);
}

function toggleTheme(): void {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('harbor-theme', next);
  updateThemeIcon(next);
}

function updateThemeIcon(theme: string): void {
  const icon = document.getElementById('theme-icon');
  if (icon) {
    icon.textContent = theme === 'dark' ? '☀️' : '🌙';
  }
}

// Initialize theme immediately
initTheme();

// DOM Elements
const statusIndicator = document.getElementById('status-indicator') as HTMLDivElement;
const statusText = document.getElementById('status-text') as HTMLSpanElement;
const errorContainer = document.getElementById('error-container') as HTMLDivElement;
const lastMessageEl = document.getElementById('last-message') as HTMLPreElement;
const copyResponseBtn = document.getElementById('copy-response-btn') as HTMLButtonElement;
const sendHelloBtn = document.getElementById('send-hello') as HTMLButtonElement;
const reconnectBtn = document.getElementById('reconnect') as HTMLButtonElement;
const serverLabelInput = document.getElementById('server-label') as HTMLInputElement;
const serverUrlInput = document.getElementById('server-url') as HTMLInputElement;
const addServerBtn = document.getElementById('add-server') as HTMLButtonElement;
const serverListEl = document.getElementById('server-list') as HTMLDivElement;
const responseHeader = document.getElementById('response-header') as HTMLDivElement;
const responseContent = document.getElementById('response-content') as HTMLDivElement;
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

let servers: MCPServer[] = [];
let selectedServerId: string | null = null;
let installedServers: InstalledServerStatus[] = [];
let currentCredentialServerId: string | null = null;

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

  if (state.lastMessage) {
    lastMessageEl.className = '';
    lastMessageEl.innerHTML = formatJson(state.lastMessage);
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

function renderServerList(): void {
  if (servers.length === 0) {
    serverListEl.innerHTML = '<div class="empty-state">No servers configured</div>';
    return;
  }

  serverListEl.innerHTML = servers
    .map(
      (server) => `
    <div class="server-item" data-server-id="${server.server_id}">
      <div class="server-header">
        <span class="server-label">${escapeHtml(server.label)}</span>
        <div class="server-status">
          <div class="status-indicator ${getStatusClass(server.status)}"></div>
          <span class="status-text ${getStatusClass(server.status)}">${getStatusText(server.status)}</span>
        </div>
      </div>
      <div class="server-url">${escapeHtml(server.base_url)}</div>
      ${server.error_message ? `<div class="error-message">${escapeHtml(server.error_message)}</div>` : ''}
      <div class="server-actions">
        ${
          server.status === 'connected'
            ? `
          <button class="btn-small btn-danger disconnect-btn" data-server-id="${server.server_id}">Disconnect</button>
          <button class="btn-small btn-secondary list-tools-btn" data-server-id="${server.server_id}">List Tools</button>
        `
            : `
          <button class="btn-small btn-success connect-btn" data-server-id="${server.server_id}" ${server.status === 'connecting' ? 'disabled' : ''}>
            ${server.status === 'connecting' ? 'Connecting...' : 'Connect'}
          </button>
        `
        }
        <button class="btn-small btn-danger remove-btn" data-server-id="${server.server_id}">Remove</button>
      </div>
    </div>
  `
    )
    .join('');

  // Add event listeners
  serverListEl.querySelectorAll('.connect-btn').forEach((btn) => {
    btn.addEventListener('click', () => connectServer((btn as HTMLElement).dataset.serverId!));
  });

  serverListEl.querySelectorAll('.disconnect-btn').forEach((btn) => {
    btn.addEventListener('click', () => disconnectServer((btn as HTMLElement).dataset.serverId!));
  });

  serverListEl.querySelectorAll('.list-tools-btn').forEach((btn) => {
    btn.addEventListener('click', () => listTools((btn as HTMLElement).dataset.serverId!));
  });

  serverListEl.querySelectorAll('.remove-btn').forEach((btn) => {
    btn.addEventListener('click', () => removeServer((btn as HTMLElement).dataset.serverId!));
  });
}

async function loadServers(): Promise<void> {
  try {
    const response = (await browser.runtime.sendMessage({
      type: 'list_servers',
    })) as { type: string; servers?: MCPServer[] };

    if (response.type === 'list_servers_result' && response.servers) {
      servers = response.servers;
      renderServerList();
    }
  } catch (err) {
    console.error('Failed to load servers:', err);
  }
}

async function addServer(): Promise<void> {
  const label = serverLabelInput.value.trim();
  const baseUrl = serverUrlInput.value.trim();

  if (!label || !baseUrl) {
    alert('Please enter both label and URL');
    return;
  }

  try {
    addServerBtn.disabled = true;
    const response = (await browser.runtime.sendMessage({
      type: 'add_server',
      label,
      base_url: baseUrl,
    })) as { type: string; server?: MCPServer };

    if (response.type === 'add_server_result' && response.server) {
      serverLabelInput.value = '';
      serverUrlInput.value = '';
      await loadServers();
    } else if (response.type === 'error') {
      const error = response as unknown as { error: { message: string } };
      alert(`Failed to add server: ${error.error.message}`);
    }
  } catch (err) {
    console.error('Failed to add server:', err);
    alert('Failed to add server');
  } finally {
    addServerBtn.disabled = false;
  }
}

async function removeServer(serverId: string): Promise<void> {
  if (!confirm('Remove this server?')) {
    return;
  }

  try {
    await browser.runtime.sendMessage({
      type: 'remove_server',
      server_id: serverId,
    });
    await loadServers();
  } catch (err) {
    console.error('Failed to remove server:', err);
  }
}

async function connectServer(serverId: string): Promise<void> {
  try {
    // Optimistically update UI
    const server = servers.find((s) => s.server_id === serverId);
    if (server) {
      server.status = 'connecting';
      renderServerList();
    }

    const response = (await browser.runtime.sendMessage({
      type: 'connect_server',
      server_id: serverId,
    })) as { type: string };

    await loadServers();

    if (response.type === 'error') {
      const error = response as unknown as { error: { message: string } };
      alert(`Connection failed: ${error.error.message}`);
    }
  } catch (err) {
    console.error('Failed to connect:', err);
    await loadServers();
  }
}

async function disconnectServer(serverId: string): Promise<void> {
  try {
    await browser.runtime.sendMessage({
      type: 'disconnect_server',
      server_id: serverId,
    });
    await loadServers();
  } catch (err) {
    console.error('Failed to disconnect:', err);
  }
}

async function listTools(serverId: string): Promise<void> {
  try {
    selectedServerId = serverId;
    const response = await browser.runtime.sendMessage({
      type: 'list_tools',
      server_id: serverId,
    });

    toolsCard.style.display = 'block';
    toolsResponse.innerHTML = formatJson(response);
  } catch (err) {
    console.error('Failed to list tools:', err);
    toolsCard.style.display = 'block';
    toolsResponse.textContent = `Error: ${err}`;
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
    }
  } catch (err) {
    console.error('Failed to load installed servers:', err);
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

function renderInstalledServers(): void {
  if (installedServers.length === 0) {
    installedServerListEl.innerHTML = `
      <div class="empty-state">
        No servers installed. 
        <a href="#" id="go-to-directory" style="color: var(--accent-primary);">Browse the directory</a> to find servers.
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
  
  installedServerListEl.innerHTML = installedServers
    .filter(status => status.installed && status.server)
    .map(status => {
      const server = status.server!;
      const statusInfo = getServerStatusInfo(status);
      const isRunning = status.process?.state === 'running';
      const needsAuth = status.missingSecrets && status.missingSecrets.length > 0;
      
      console.log('[Sidebar] Server:', server.id, 'isRunning:', isRunning, 'needsAuth:', needsAuth, 'process:', status.process);

      return `
        <div class="installed-server-item" data-server-id="${escapeHtml(server.id)}">
          <div class="server-header">
            <span class="server-label">${escapeHtml(server.name)}</span>
            <span class="server-status-badge ${statusInfo.class}">${statusInfo.text}</span>
          </div>
          ${server.description ? `<div class="server-description" style="font-size: 11px; color: var(--text-muted); margin: 4px 0;">${escapeHtml(server.description)}</div>` : ''}
          <div class="server-package-info">${escapeHtml(server.packageType)}:${escapeHtml(server.packageId)}</div>
          ${needsAuth ? `
            <div class="error-message" style="margin-bottom: 10px;">
              Missing credentials: ${status.missingSecrets!.join(', ')}
            </div>
          ` : ''}
          <div class="server-actions">
            ${needsAuth ? `
              <button class="btn-small btn-primary configure-btn" data-server-id="${escapeHtml(server.id)}">🔑 Configure</button>
            ` : ''}
            ${!needsAuth && !isRunning ? `
              <button class="btn-small btn-success start-btn" data-server-id="${escapeHtml(server.id)}">▶ Start</button>
            ` : ''}
            ${isRunning ? `
              <button class="btn-small btn-danger stop-btn" data-server-id="${escapeHtml(server.id)}">⏹ Stop</button>
              <button class="btn-small btn-secondary mcp-tools-btn" data-server-id="${escapeHtml(server.id)}">Tools</button>
            ` : ''}
            <button class="btn-small btn-secondary configure-btn" data-server-id="${escapeHtml(server.id)}" ${needsAuth ? 'style="display:none;"' : ''}>⚙️</button>
            <button class="btn-small btn-danger uninstall-btn" data-server-id="${escapeHtml(server.id)}">🗑️</button>
          </div>
        </div>
      `;
    })
    .join('');

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

  if (secretVars.length === 0) {
    credentialModalBody.innerHTML = `
      <div class="empty-state">
        This server doesn't require any credentials.
      </div>
    `;
  } else {
    credentialModalBody.innerHTML = secretVars.map(envVar => {
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
              placeholder="${isSet ? '••••••••••••••••' : 'Enter value...'}"
            >
            <button class="password-toggle" type="button" data-showing="false">👁️</button>
          </div>
          <div class="credential-status ${isSet ? 'set' : 'missing'}">
            ${isSet ? '✓ Configured' : '⚠ Not set'}
          </div>
        </div>
      `;
    }).join('');

    // Add password toggle functionality
    credentialModalBody.querySelectorAll('.password-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const wrapper = btn.parentElement!;
        const input = wrapper.querySelector('input') as HTMLInputElement;
        const showing = btn.getAttribute('data-showing') === 'true';
        
        input.type = showing ? 'password' : 'text';
        btn.textContent = showing ? '👁️' : '🙈';
        btn.setAttribute('data-showing', (!showing).toString());
      });
    });
  }

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

async function startInstalledServer(serverId: string): Promise<void> {
  console.log('[Sidebar] Starting server:', serverId);
  
  try {
    // Use mcp_connect to start and connect via stdio
    const response = await browser.runtime.sendMessage({
      type: 'mcp_connect',
      server_id: serverId,
    }) as { type: string; connected?: boolean; error?: { message: string } };

    console.log('[Sidebar] Start response:', response);

    if (response.type === 'mcp_connect_result' && response.connected) {
      console.log('[Sidebar] Server started and connected:', serverId);
    } else if (response.type === 'error') {
      const error = response as unknown as { error: { message: string } };
      console.error('[Sidebar] Start error:', error);
      alert(`Failed to start: ${error.error.message}`);
    } else {
      console.warn('[Sidebar] Unexpected response:', response);
    }
    
    await loadInstalledServers();
  } catch (err) {
    console.error('[Sidebar] Failed to start server:', err);
    alert(`Failed to start server: ${err}`);
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
    }
  } catch (err) {
    console.error('Failed to check LLM status:', err);
    llmStatusText.textContent = 'Error checking LLM';
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
        detailsHtml += ` <span style="color: var(--text-muted);">v${ollama.version}</span>`;
      }
      
      // Tool support badge
      if (ollama.supportsTools) {
        detailsHtml += ` <span class="badge badge-success" style="margin-left: 4px; font-size: 9px;">Tools ✓</span>`;
      } else {
        detailsHtml += ` <span class="badge badge-warning" style="margin-left: 4px; font-size: 9px;">No Tools</span>`;
      }
    }
    
    detailsHtml += `<br><span style="font-size: 11px; color: var(--text-muted);">${llmStatus.runningUrl}</span>`;
    
    if (llmStatus.activeModel) {
      detailsHtml += `<br>Model: ${llmStatus.activeModel}`;
    }
    
    // Add Ollama warning if present
    if (llmStatus.ollamaInfo?.warning) {
      detailsHtml += `<div style="margin-top: 8px; padding: 8px; background: var(--accent-warning-bg); border-radius: 6px; font-size: 11px; color: var(--accent-warning);">
        ⚠️ ${llmStatus.ollamaInfo.warning}
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

// Listen for state updates from background
browser.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as { type: string; state?: ConnectionState; response?: BridgeResponse };

  if (msg.type === 'state_update' && msg.state) {
    updateConnectionUI(msg.state);
  }
});

// Initialize
async function init(): Promise<void> {
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
}

// Button handlers
sendHelloBtn.addEventListener('click', async () => {
  try {
    await browser.runtime.sendMessage({ type: 'send_hello' });
  } catch (err) {
    console.error('Failed to send hello:', err);
  }
});

// Copy last response button
copyResponseBtn.addEventListener('click', async () => {
  const content = lastMessageEl.textContent || '';
  if (content && content !== 'No messages received') {
    try {
      await navigator.clipboard.writeText(content);
      const originalText = copyResponseBtn.textContent;
      copyResponseBtn.textContent = '✓ Copied!';
      copyResponseBtn.style.background = 'var(--accent-success-bg)';
      copyResponseBtn.style.color = 'var(--accent-success)';
      setTimeout(() => {
        copyResponseBtn.textContent = originalText;
        copyResponseBtn.style.background = '';
        copyResponseBtn.style.color = '';
      }, 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }
});

reconnectBtn.addEventListener('click', async () => {
  try {
    await browser.runtime.sendMessage({ type: 'reconnect' });
  } catch (err) {
    console.error('Failed to reconnect:', err);
  }
});

addServerBtn.addEventListener('click', addServer);

// Allow Enter key to submit
serverUrlInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    addServer();
  }
});

// Collapsible response section
responseHeader.addEventListener('click', () => {
  responseContent.classList.toggle('collapsed');
  const icon = responseHeader.querySelector('.collapse-icon') as HTMLSpanElement;
  icon.textContent = responseContent.classList.contains('collapsed') ? '▶' : '▼';
});

// Open Directory button
openDirectoryBtn.addEventListener('click', () => {
  const directoryUrl = browser.runtime.getURL('directory.html');
  browser.tabs.create({ url: directoryUrl });
});

// Compare mode toggle in sidebar
const compareModeToggle = document.getElementById('compare-mode-toggle') as HTMLInputElement;

// Load saved compare mode state
browser.storage.local.get('compareMode').then((result) => {
  if (compareModeToggle && result.compareMode) {
    compareModeToggle.checked = true;
  }
});

// Save compare mode state when toggled
compareModeToggle?.addEventListener('change', () => {
  browser.storage.local.set({ compareMode: compareModeToggle.checked });
  // Broadcast to any open chat pages
  browser.runtime.sendMessage({
    type: 'compare_mode_changed',
    enabled: compareModeToggle.checked,
  }).catch(() => {});
});

// Tool Router toggle in sidebar
const toolRouterToggle = document.getElementById('tool-router-toggle') as HTMLInputElement;

// Load saved tool router state (default: true)
browser.storage.local.get('useToolRouter').then((result) => {
  if (toolRouterToggle) {
    // Default to true if not set
    toolRouterToggle.checked = result.useToolRouter !== false;
  }
});

// Save tool router state when toggled
toolRouterToggle?.addEventListener('change', () => {
  browser.storage.local.set({ useToolRouter: toolRouterToggle.checked });
  // Broadcast to any open chat pages
  browser.runtime.sendMessage({
    type: 'tool_router_changed',
    enabled: toolRouterToggle.checked,
  }).catch(() => {});
});

// Open Chat button
const openChatBtn = document.getElementById('open-chat') as HTMLButtonElement;
openChatBtn?.addEventListener('click', () => {
  const chatUrl = browser.runtime.getURL('chat.html');
  browser.tabs.create({ url: chatUrl });
});

// Theme toggle
themeToggleBtn.addEventListener('click', toggleTheme);

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
});

// LLM event listeners
llmDownloadBtn.addEventListener('click', downloadLLMModel);
llmStartBtn.addEventListener('click', startLocalLLM);
llmStopBtn.addEventListener('click', stopLocalLLM);

init();
