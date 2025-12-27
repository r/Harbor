import browser from 'webextension-polyfill';
import { directoryManager, CatalogServer } from './directory';

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

// Directory elements
const directorySearchInput = document.getElementById('directory-search') as HTMLInputElement;
const directoryRefreshBtn = document.getElementById('directory-refresh') as HTMLButtonElement;
const directoryFilters = document.getElementById('directory-filters') as HTMLDivElement;
const directoryListEl = document.getElementById('directory-list') as HTMLDivElement;
const directoryCountEl = document.getElementById('directory-count') as HTMLSpanElement;

let servers: MCPServer[] = [];
let catalogServers: CatalogServer[] = [];
let directoryLoading = false;
let activeSources: Set<string> = new Set(['manual_seed', 'registry', 'github_awesome']);
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

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
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

  // Note: We don't auto-refresh on bridge_response anymore to avoid loops.
  // Each action (add/remove/connect/disconnect) explicitly calls loadServers() after completion.
});

// Directory functions
function getSourceLabel(source: string): string {
  switch (source) {
    case 'registry':
      return 'Registry';
    case 'github_awesome':
      return 'Awesome';
    case 'manual_seed':
      return 'Seed';
    default:
      return source;
  }
}

function renderDirectoryList(): void {
  if (directoryLoading) {
    directoryListEl.innerHTML = '<div class="directory-loading">Loading directory...</div>';
    return;
  }

  // Filter by active sources and search query
  const searchQuery = directorySearchInput.value.toLowerCase().trim();
  const filtered = catalogServers.filter((server) => {
    // Source filter
    if (!activeSources.has(server.source)) return false;
    
    // Search filter
    if (searchQuery) {
      return (
        server.name.toLowerCase().includes(searchQuery) ||
        server.description.toLowerCase().includes(searchQuery) ||
        server.tags.some((t) => t.toLowerCase().includes(searchQuery))
      );
    }
    return true;
  });

  // Update count badge
  directoryCountEl.textContent = String(filtered.length);

  if (filtered.length === 0) {
    directoryListEl.innerHTML = `
      <div class="directory-empty">
        <div class="directory-empty-icon">📭</div>
        <div>${searchQuery ? 'No servers match your search' : 'No servers in directory'}</div>
      </div>
    `;
    return;
  }

  directoryListEl.innerHTML = filtered
    .map((server) => {
      const hasEndpoint = server.endpointUrl && server.endpointUrl.length > 0;
      const tagsHtml = server.tags
        .filter((t) => t !== 'installable_only')
        .slice(0, 3)
        .map((t) => `<span class="directory-tag">${escapeHtml(t)}</span>`)
        .join('');

      const linksHtml = [];
      if (server.repository) {
        linksHtml.push(`<a href="${escapeHtml(server.repository)}" target="_blank" class="directory-link">GitHub</a>`);
      }
      if (server.homepage) {
        linksHtml.push(`<a href="${escapeHtml(server.homepage)}" target="_blank" class="directory-link">Homepage</a>`);
      }

      return `
        <div class="directory-item ${hasEndpoint ? 'has-endpoint' : 'no-endpoint'}">
          <div class="directory-item-header">
            <span class="directory-item-name">${escapeHtml(server.name)}</span>
            <span class="directory-item-source ${server.source}">${getSourceLabel(server.source)}</span>
          </div>
          ${server.description ? `<div class="directory-item-description">${escapeHtml(server.description)}</div>` : ''}
          ${
            hasEndpoint
              ? `<div class="directory-item-endpoint">${escapeHtml(server.endpointUrl)}</div>`
              : `<div class="directory-item-no-endpoint">No remote endpoint published</div>`
          }
          ${tagsHtml ? `<div class="directory-item-tags">${tagsHtml}</div>` : ''}
          ${linksHtml.length > 0 ? `<div class="directory-item-links">${linksHtml.join('')}</div>` : ''}
          <div class="directory-item-actions">
            ${
              hasEndpoint
                ? `<button class="btn-small btn-success directory-add-btn" data-server-id="${escapeHtml(server.id)}" data-name="${escapeHtml(server.name)}" data-url="${escapeHtml(server.endpointUrl)}">Add to Harbor</button>`
                : `<button class="btn-small btn-secondary directory-info-btn" data-server-id="${escapeHtml(server.id)}" data-repo="${escapeHtml(server.repository || server.homepage || '')}">Install/Info</button>`
            }
          </div>
        </div>
      `;
    })
    .join('');

  // Add event listeners
  directoryListEl.querySelectorAll('.directory-add-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const el = btn as HTMLButtonElement;
      const name = el.dataset.name!;
      const url = el.dataset.url!;
      await addServerFromDirectory(name, url);
    });
  });

  directoryListEl.querySelectorAll('.directory-info-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const el = btn as HTMLButtonElement;
      const repo = el.dataset.repo;
      if (repo) {
        window.open(repo, '_blank');
      } else {
        alert('No installation info available. Check the server documentation.');
      }
    });
  });
}

async function loadDirectory(forceRefresh = false): Promise<void> {
  directoryLoading = true;
  renderDirectoryList();
  directoryRefreshBtn.classList.add('loading');

  try {
    const query = directorySearchInput.value.trim();
    if (query) {
      catalogServers = await directoryManager.searchServers(query);
    } else {
      catalogServers = await directoryManager.getAllServers(forceRefresh);
    }
  } catch (err) {
    console.error('Failed to load directory:', err);
    catalogServers = [];
  } finally {
    directoryLoading = false;
    directoryRefreshBtn.classList.remove('loading');
    renderDirectoryList();
  }
}

async function addServerFromDirectory(name: string, url: string): Promise<void> {
  try {
    const response = (await browser.runtime.sendMessage({
      type: 'add_server',
      label: name,
      base_url: url,
    })) as { type: string; server?: MCPServer };

    if (response.type === 'add_server_result' && response.server) {
      await loadServers();
      // Scroll to top of server list
      serverListEl.scrollIntoView({ behavior: 'smooth' });
    } else if (response.type === 'error') {
      const error = response as unknown as { error: { message: string } };
      alert(`Failed to add server: ${error.error.message}`);
    }
  } catch (err) {
    console.error('Failed to add server from directory:', err);
    alert('Failed to add server');
  }
}

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
  
  // Load directory in background
  loadDirectory();
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

// Directory event handlers
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

directorySearchInput.addEventListener('input', () => {
  // Debounce search
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
  }
  searchDebounceTimer = setTimeout(() => {
    loadDirectory();
  }, 300);
});

directoryRefreshBtn.addEventListener('click', () => {
  loadDirectory(true);
});

// Filter checkboxes
directoryFilters.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
  checkbox.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const source = input.dataset.source!;
    if (input.checked) {
      activeSources.add(source);
    } else {
      activeSources.delete(source);
    }
    renderDirectoryList();
  });
});

init();
