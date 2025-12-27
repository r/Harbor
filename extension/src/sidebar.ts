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

let servers: MCPServer[] = [];
let selectedServerId: string | null = null;

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

// Theme toggle
themeToggleBtn.addEventListener('click', toggleTheme);

init();
