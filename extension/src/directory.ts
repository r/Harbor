// Harbor Directory Page
import browser from 'webextension-polyfill';
import type { CatalogServer, ProviderStatus, CatalogResponse } from './catalog/types';

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
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const filterPillsContainer = document.getElementById('filter-pills') as HTMLDivElement;
const providerStatusEl = document.getElementById('provider-status') as HTMLDivElement;
const mainContent = document.getElementById('main-content') as HTMLElement;
const themeToggleBtn = document.getElementById('theme-toggle') as HTMLButtonElement;

// State
let allServers: CatalogServer[] = [];
let providerStatus: ProviderStatus[] = [];
let isLoading = false;
let activeFilter = 'all';

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

// Apply filters
function applyFilters(servers: CatalogServer[]): CatalogServer[] {
  const query = searchInput.value.toLowerCase().trim();
  let filtered = servers;

  // Apply category filter
  if (activeFilter !== 'all') {
    switch (activeFilter) {
      case 'remote':
        filtered = filtered.filter(s => !s.installableOnly);
        break;
      case 'official':
        filtered = filtered.filter(s => s.source === 'official_registry');
        break;
      default:
        // Filter by tag
        filtered = filtered.filter(s =>
          s.tags.some(t => t.toLowerCase().includes(activeFilter))
        );
    }
  }

  // Apply search query
  if (query) {
    filtered = filtered.filter(s =>
      s.name.toLowerCase().includes(query) ||
      (s.description?.toLowerCase().includes(query)) ||
      s.tags.some(t => t.toLowerCase().includes(query))
    );
  }

  return filtered;
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

  const filtered = applyFilters(allServers);
  const query = searchInput.value.toLowerCase().trim();

  if (filtered.length === 0) {
    mainContent.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        <p class="empty-title">${query ? 'No servers match your search' : 'No servers found'}</p>
        <p class="empty-description">Try adjusting your filters or refreshing the catalog.</p>
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
        <div class="section-title-group">
          <span class="section-title">Remote Servers</span>
          <span class="section-count">${remoteServers.length}</span>
        </div>
      </div>
      <div class="server-grid">
        ${remoteServers.map(renderServerCard).join('')}
      </div>
    `;
  }

  // Installable-only section
  if (installableServers.length > 0 && activeFilter !== 'remote') {
    html += `
      <div class="section-header">
        <div class="section-title-group">
          <span class="section-title">Installable Only</span>
          <span class="section-count">${installableServers.length}</span>
        </div>
      </div>
      <div class="server-grid">
        ${installableServers.map(renderServerCard).join('')}
      </div>
    `;
  }

  mainContent.innerHTML = html;

  // Attach event listeners
  mainContent.querySelectorAll('.btn-add').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const el = btn as HTMLButtonElement;
      const name = el.dataset.name!;
      const url = el.dataset.url!;
      addToHarbor(name, url);
    });
  });

  mainContent.querySelectorAll('.btn-copy').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const el = btn as HTMLButtonElement;
      copyToClipboard(el.dataset.url!);
    });
  });
}

function renderServerCard(server: CatalogServer): string {
  const badges: string[] = [];
  
  // Source badge
  if (server.source === 'official_registry') {
    badges.push(`<span class="badge badge-registry">registry</span>`);
  } else {
    badges.push(`<span class="badge badge-awesome">awesome</span>`);
  }
  
  // Remote badge
  if (!server.installableOnly) {
    badges.push(`<span class="badge badge-remote">remote</span>`);
  }
  
  const tagsHtml = server.tags
    .filter(t => !['remote', 'installable_only'].includes(t))
    .slice(0, 4)
    .map(t => `<span class="server-tag">${escapeHtml(t)}</span>`)
    .join('');

  const endpointHtml = server.endpointUrl
    ? `
      <div class="server-endpoint">
        <span class="server-endpoint-url">${escapeHtml(server.endpointUrl)}</span>
        <button class="btn btn-copy" data-url="${escapeHtml(server.endpointUrl)}" title="Copy URL">📋</button>
      </div>
    `
    : `<p class="server-no-endpoint">No remote endpoint available</p>`;

  const actionsHtml = server.endpointUrl
    ? `
      <button class="btn btn-small btn-success btn-add" data-name="${escapeHtml(server.name)}" data-url="${escapeHtml(server.endpointUrl)}">
        + Add to Harbor
      </button>
    `
    : '';

  const linkHtml = server.homepageUrl
    ? `<a href="${escapeHtml(server.homepageUrl)}" target="_blank" class="server-link" onclick="event.stopPropagation()">
        ${server.homepageUrl.includes('github.com') ? 'GitHub ↗' : 'Homepage ↗'}
      </a>`
    : '';

  return `
    <div class="server-card">
      <div class="server-card-header">
        <span class="server-name">${escapeHtml(server.name)}</span>
        <div class="server-badges">${badges.join('')}</div>
      </div>
      ${server.description ? `<p class="server-description">${escapeHtml(server.description)}</p>` : ''}
      ${endpointHtml}
      ${tagsHtml ? `<div class="server-tags">${tagsHtml}</div>` : ''}
      <div class="server-actions">
        ${linkHtml}
        ${actionsHtml}
      </div>
    </div>
  `;
}

// Actions
async function loadCatalog(force = false): Promise<void> {
  isLoading = true;
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

// Update filter pills UI
function updateFilterPillsUI(): void {
  filterPillsContainer.querySelectorAll('.filter-pill').forEach(pill => {
    const filter = (pill as HTMLElement).dataset.filter;
    pill.classList.toggle('active', filter === activeFilter);
  });
}

// Event listeners
let searchDebounce: ReturnType<typeof setTimeout> | null = null;

searchInput.addEventListener('input', () => {
  if (searchDebounce) clearTimeout(searchDebounce);
  searchDebounce = setTimeout(renderServers, 200);
});

// Filter pills click handler
filterPillsContainer.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const pill = target.closest('.filter-pill') as HTMLElement;
  if (pill && pill.dataset.filter) {
    activeFilter = pill.dataset.filter;
    updateFilterPillsUI();
    renderServers();
  }
});

// Theme toggle
themeToggleBtn.addEventListener('click', toggleTheme);

// Initialize
loadCatalog();
