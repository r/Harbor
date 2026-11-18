/**
 * Permission Prompt Handler
 *
 * Runs in the permission prompt popup window.
 * Uses the same design tokens as the sidebar for consistency.
 */

import { browserAPI } from './browser-compat';
import { SCOPE_DESCRIPTIONS } from './policy/permissions';
import { escapeHtml } from './html-escape';
import type { PermissionScope } from './agents/types';

// Icons for each scope category
const SCOPE_ICONS: Record<string, string> = {
  'model:prompt': '🤖',
  'model:tools': '🔧',
  'model:list': '📋',
  'mcp:tools.list': '🔌',
  'mcp:tools.call': '⚡',
  'mcp:servers.register': '📡',
  'browser:activeTab.read': '📄',
  'browser:activeTab.interact': '👆',
  'browser:activeTab.screenshot': '📸',
  'chat:open': '💬',
  'web:fetch': '🌐',
};

// =============================================================================
// Theme Management (synced with sidebar)
// =============================================================================

type Theme = 'light' | 'dark' | 'system';

function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme: Theme): void {
  const effectiveTheme = theme === 'system' ? getSystemTheme() : theme;
  document.documentElement.setAttribute('data-theme', effectiveTheme);
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

  // Listen for theme changes from other windows (sidebar)
  window.addEventListener('storage', (e) => {
    if (e.key === 'harbor-theme' && e.newValue) {
      applyTheme(e.newValue as Theme);
    }
  });
}

// Initialize theme immediately
initTheme();

// =============================================================================
// Permission Prompt Logic
// =============================================================================

// Parse URL params
const params = new URLSearchParams(window.location.search);
const origin = params.get('origin') || 'Unknown';
const scopesParam = params.get('scopes') || '';
const reason = params.get('reason') || '';
const toolsParam = params.get('tools') || '';
const sessionName = params.get('sessionName') || '';
const sessionType = params.get('sessionType') || '';
const requestedLLM = params.get('llm') === 'true';
const requestedTools = params.get('toolsCount') || '0';
const requestedBrowser = params.get('browser') || '';

const scopes = scopesParam.split(',').filter(Boolean) as PermissionScope[];
const tools = toolsParam.split(',').filter(Boolean);

// Render origin
const originEl = document.getElementById('origin');
if (originEl) {
  originEl.textContent = origin;
}

// Render session context (for explicit sessions)
if (sessionName || sessionType === 'explicit') {
  const sessionContext = document.getElementById('session-context');
  const sessionNameEl = document.getElementById('session-name');
  const sessionBadges = document.getElementById('session-badges');
  
  if (sessionContext && sessionNameEl && sessionBadges) {
    sessionContext.style.display = 'block';
    sessionNameEl.textContent = sessionName || 'Agent Session';
    
    // Add capability badges
    const badges: string[] = [];
    if (sessionType === 'explicit') {
      badges.push('<span class="session-badge explicit">Explicit Session</span>');
    }
    if (requestedLLM) {
      badges.push('<span class="session-badge llm">LLM</span>');
    }
    if (parseInt(requestedTools, 10) > 0) {
      badges.push(`<span class="session-badge tools">${escapeHtml(requestedTools)} Tools</span>`);
    }
    if (requestedBrowser) {
      const browserCaps = requestedBrowser.split(',').filter(Boolean);
      if (browserCaps.length > 0) {
        badges.push(`<span class="session-badge browser">Browser: ${escapeHtml(browserCaps.join(', '))}</span>`);
      }
    }
    
    sessionBadges.innerHTML = badges.join('');
  }
}

// Render reason
if (reason) {
  const reasonContainer = document.getElementById('reason-container');
  const reasonEl = document.getElementById('reason');
  if (reasonContainer && reasonEl) {
    reasonContainer.style.display = 'block';
    reasonEl.textContent = reason;
  }
}

// Render scopes
const scopesList = document.getElementById('scopes-list');
if (scopesList) {
  if (scopes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'scopes-empty';
    empty.textContent = 'No specific permissions requested';
    scopesList.appendChild(empty);
  } else {
    for (const scope of scopes) {
      const info = SCOPE_DESCRIPTIONS[scope];
      const icon = SCOPE_ICONS[scope] || '🔐';
      
      const item = document.createElement('div');
      item.className = 'scope-item';
      
      if (info) {
        item.innerHTML = `
          <div class="scope-header">
            <span class="scope-icon">${icon}</span>
            <span class="scope-title">${info.title}</span>
            <span class="risk-badge risk-${info.risk}">${info.risk}</span>
          </div>
          <div class="scope-description">${info.description}</div>
        `;
      } else {
        // Fallback for unknown scopes
        item.innerHTML = `
          <div class="scope-header">
            <span class="scope-icon">${icon}</span>
            <span class="scope-title">${escapeHtml(scope)}</span>
          </div>
          <div class="scope-description">Access to ${escapeHtml(scope)}</div>
        `;
      }
      scopesList.appendChild(item);
    }
  }
}

// Render tools
if (tools.length > 0) {
  const toolsSection = document.getElementById('tools-section');
  const toolsList = document.getElementById('tools-list');
  if (toolsSection && toolsList) {
    toolsSection.style.display = 'block';

    tools.forEach((tool, index) => {
      // Tool names come from MCP servers, so build the row without innerHTML.
      const item = document.createElement('div');
      item.className = 'tool-item';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = `tool-${index}`;
      checkbox.dataset.tool = tool;
      checkbox.checked = true;
      const label = document.createElement('label');
      label.htmlFor = checkbox.id;
      label.className = 'tool-name';
      label.textContent = tool;
      item.append(checkbox, label);
      toolsList.appendChild(item);
    });
  }
}

// Handle deny button
const btnDeny = document.getElementById('btn-deny');
btnDeny?.addEventListener('click', () => {
  sendResponse({ granted: false, explicitDeny: true });
});

// Handle allow button
const btnAllow = document.getElementById('btn-grant');
btnAllow?.addEventListener('click', () => {
  const grantOnce = (document.getElementById('grant-once') as HTMLInputElement)?.checked;
  const grantType = grantOnce ? 'granted-once' : 'granted-always';

  // Collect selected tools
  const selectedTools: string[] = [];
  const toolCheckboxes = document.querySelectorAll<HTMLInputElement>('#tools-list input[type="checkbox"]');
  for (const checkbox of toolCheckboxes) {
    if (checkbox.checked) {
      const toolName = checkbox.dataset.tool;
      if (toolName) selectedTools.push(toolName);
    }
  }

  sendResponse({
    granted: true,
    grantType,
    allowedTools: selectedTools.length > 0 ? selectedTools : undefined,
  });
});

// Send response to background script
function sendResponse(response: {
  granted: boolean;
  grantType?: 'granted-once' | 'granted-always';
  allowedTools?: string[];
  explicitDeny?: boolean;
}): void {
  console.log('[Permission Prompt] Sending response:', response);
  browserAPI.runtime.sendMessage({
    type: 'permission_prompt_response',
    response,
  });
}

// Handle window close (user dismissed)
window.addEventListener('beforeunload', () => {
  // This may not always fire, but the background script handles window close events
});
