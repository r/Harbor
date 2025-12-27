// Harbor Directory Page
import browser from 'webextension-polyfill';
import type { CatalogServer, ProviderStatus, CatalogResponse } from './catalog/types';

// DOM Elements
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const remoteOnlyCheckbox = document.getElementById('remote-only-checkbox') as HTMLInputElement;
const remoteOnlyToggle = document.getElementById('remote-only-toggle') as HTMLLabelElement;
const refreshBtn = document.getElementById('refresh-btn') as HTMLButtonElement;
const providerStatusEl = document.getElementById('provider-status') as HTMLDivElement;
const mainContent = document.getElementById('main-content') as HTMLElement;

// State
let allServers: CatalogServer[] = [];
let providerStatus: ProviderStatus[] = [];
let isLoading = false;
let remoteOnlyFilter = false;

// Utility functions
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showToast(message: string, type: 'success' | 'error' = 'success'): void {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast('Copied to clipboard!');
  } catch {
    showToast('Failed to copy', 'error');
  }
}

// Provider status rendering
function renderProviderStatus(): void {
  if (providerStatus.length === 0) {
    providerStatusEl.innerHTML = '';
    return;
  }

  const providerNames: Record<string, string> = {
    official_registry: 'Official Registry',
    github_awesome: 'GitHub Awesome',
    mcpservers_org: 'mcpservers.org',
  };

  providerStatusEl.innerHTML = providerStatus
    .map(status => {
      const name = providerNames[status.id] || status.id;
      const statusClass = status.ok ? 'ok' : 'error';
      
      return `
        <div class="provider-badge ${statusClass}" title="${status.error || ''}">
          <span class="provider-dot"></span>
          <span class="provider-name">${escapeHtml(name)}</span>
          ${status.ok && status.count !== undefined 
            ? `<span class="provider-count">${status.count}</span>` 
            : ''}
          ${status.error 
            ? `<span class="provider-error">${escapeHtml(status.error)}</span>` 
            : ''}
        </div>
      `;
    })
    .join('');
}

// Main content rendering
function renderServers(): void {
  if (isLoading) {
    mainContent.innerHTML = `
      <div class="loading-state">
        <div class="loading-spinner">⏳</div>
        <p>Loading directory...</p>
      </div>
    `;
    return;
  }

  // Filter servers
  const query = searchInput.value.toLowerCase().trim();
  let filtered = allServers;

  if (remoteOnlyFilter) {
    filtered = filtered.filter(s => !s.installableOnly);
  }

  if (query) {
    filtered = filtered.filter(s =>
      s.name.toLowerCase().includes(query) ||
      (s.description?.toLowerCase().includes(query)) ||
      s.tags.some(t => t.toLowerCase().includes(query))
    );
  }

  if (filtered.length === 0) {
    mainContent.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        <p class="empty-title">${query ? 'No servers match your search' : 'No servers found'}</p>
        <p>Try adjusting your filters or refreshing the catalog.</p>
      </div>
    `;
    return;
  }

  // Split into remote and installable-only
  const remoteServers = filtered.filter(s => !s.installableOnly);
  const installableServers = filtered.filter(s => s.installableOnly);

  let html = '';

  // Remote / Connectable section
  if (remoteServers.length > 0) {
    html += `
      <div class="section-header">
        <span class="section-title">🌐 Remote / Connectable</span>
        <span class="section-count">${remoteServers.length}</span>
      </div>
      <div class="server-grid">
        ${remoteServers.map(renderServerCard).join('')}
      </div>
    `;
  }

  // Installable-only section (if not filtered out)
  if (!remoteOnlyFilter && installableServers.length > 0) {
    html += `
      <div class="section-header">
        <span class="section-title">📦 Installable Only</span>
        <span class="section-count">${installableServers.length}</span>
      </div>
      <div class="server-grid">
        ${installableServers.map(renderServerCard).join('')}
      </div>
    `;
  }

  mainContent.innerHTML = html;

  // Attach event listeners
  mainContent.querySelectorAll('.btn-add').forEach(btn => {
    btn.addEventListener('click', () => {
      const el = btn as HTMLButtonElement;
      const name = el.dataset.name!;
      const url = el.dataset.url!;
      addToHarbor(name, url);
    });
  });

  mainContent.querySelectorAll('.btn-copy').forEach(btn => {
    btn.addEventListener('click', () => {
      const el = btn as HTMLButtonElement;
      copyToClipboard(el.dataset.url!);
    });
  });
}

function renderServerCard(server: CatalogServer): string {
  const cardClass = server.installableOnly ? 'installable' : 'remote';
  const sourceClass = server.source;
  const sourceLabel = server.source === 'official_registry' ? 'Registry' : 'Awesome';
  
  const tagsHtml = server.tags
    .filter(t => !['remote', 'installable_only'].includes(t))
    .slice(0, 4)
    .map(t => `<span class="server-tag">${escapeHtml(t)}</span>`)
    .join('');

  const endpointHtml = server.endpointUrl
    ? `
      <div class="server-endpoint">
        <span class="server-endpoint-url">${escapeHtml(server.endpointUrl)}</span>
        <button class="btn btn-small btn-copy" data-url="${escapeHtml(server.endpointUrl)}" title="Copy URL">📋</button>
      </div>
    `
    : `<p class="server-no-endpoint">No remote endpoint published</p>`;

  const actionsHtml = server.endpointUrl
    ? `
      <button class="btn btn-small btn-add" data-name="${escapeHtml(server.name)}" data-url="${escapeHtml(server.endpointUrl)}">
        Add to Harbor
      </button>
    `
    : '';

  const linkHtml = server.homepageUrl
    ? `<a href="${escapeHtml(server.homepageUrl)}" target="_blank" class="server-link">
        ${server.homepageUrl.includes('github.com') ? 'GitHub' : 'Homepage'} ↗
      </a>`
    : '';

  return `
    <div class="server-card ${cardClass}">
      <div class="server-header">
        <span class="server-name">${escapeHtml(server.name)}</span>
        <span class="server-source ${sourceClass}">${sourceLabel}</span>
      </div>
      ${server.description ? `<p class="server-description">${escapeHtml(server.description)}</p>` : ''}
      ${endpointHtml}
      ${tagsHtml ? `<div class="server-tags">${tagsHtml}</div>` : ''}
      <div class="server-actions">
        ${actionsHtml}
        ${linkHtml}
      </div>
    </div>
  `;
}

// Actions
async function loadCatalog(force = false): Promise<void> {
  isLoading = true;
  refreshBtn.classList.add('loading');
  renderServers();

  try {
    const response = await browser.runtime.sendMessage({
      type: force ? 'catalog_refresh' : 'catalog_get',
      force,
    }) as CatalogResponse;

    allServers = response.servers || [];
    providerStatus = response.providerStatus || [];
    
    console.log(`[Directory] Loaded ${allServers.length} servers from ${providerStatus.length} providers`);
  } catch (error) {
    console.error('[Directory] Failed to load catalog:', error);
    showToast('Failed to load catalog', 'error');
  } finally {
    isLoading = false;
    refreshBtn.classList.remove('loading');
    renderProviderStatus();
    renderServers();
  }
}

async function addToHarbor(name: string, url: string): Promise<void> {
  try {
    const response = await browser.runtime.sendMessage({
      type: 'add_server',
      label: name,
      base_url: url,
    }) as { type: string; server?: unknown; error?: { message: string } };

    if (response.type === 'add_server_result' && response.server) {
      showToast(`Added "${name}" to Harbor!`);
    } else if (response.type === 'error' && response.error) {
      showToast(`Failed: ${response.error.message}`, 'error');
    }
  } catch (error) {
    console.error('[Directory] Failed to add server:', error);
    showToast('Failed to add server', 'error');
  }
}

// Event listeners
let searchDebounce: ReturnType<typeof setTimeout> | null = null;

searchInput.addEventListener('input', () => {
  if (searchDebounce) clearTimeout(searchDebounce);
  searchDebounce = setTimeout(renderServers, 200);
});

remoteOnlyCheckbox.addEventListener('change', () => {
  remoteOnlyFilter = remoteOnlyCheckbox.checked;
  remoteOnlyToggle.classList.toggle('active', remoteOnlyFilter);
  renderServers();
});

refreshBtn.addEventListener('click', () => {
  loadCatalog(true);
});

// Initialize
loadCatalog();
