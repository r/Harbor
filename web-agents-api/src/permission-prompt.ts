/**
 * Permission Prompt Handler
 *
 * Runs in the permission prompt popup window.
 */

import type { PermissionScope } from './types';

// Scope descriptions for the v1 API
const SCOPE_DESCRIPTIONS: Record<PermissionScope, { title: string; description: string; risk: 'low' | 'medium' | 'high' }> = {
  'model:prompt': {
    title: 'Text Generation',
    description: 'Generate text using AI models. The site can send prompts and receive responses.',
    risk: 'low',
  },
  'model:list': {
    title: 'List Providers',
    description: 'View available AI providers and models.',
    risk: 'low',
  },
  'mcp:tools.list': {
    title: 'List Tools',
    description: 'View available MCP tools that can be called.',
    risk: 'low',
  },
  'mcp:tools.call': {
    title: 'Execute Tools',
    description: 'Call MCP tools to perform actions. Tools may access external services.',
    risk: 'medium',
  },
};

// Icons for each scope
const SCOPE_ICONS: Record<string, string> = {
  'model:prompt': '🤖',
  'model:list': '📋',
  'mcp:tools.list': '🔌',
  'mcp:tools.call': '⚡',
};

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
}

function initTheme(): void {
  // Use same key as Harbor for theme sync between extensions
  const saved = localStorage.getItem('harbor-theme') as Theme | null;
  const theme = saved || 'system';
  applyTheme(theme);

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const current = localStorage.getItem('harbor-theme') as Theme | null;
    if (current === 'system' || !current) {
      applyTheme('system');
    }
  });
}

// Initialize theme
initTheme();

// =============================================================================
// Permission Prompt Logic
// =============================================================================

// Parse URL params
const params = new URLSearchParams(window.location.search);
const promptId = params.get('promptId') || '';
const origin = params.get('origin') || 'Unknown';
const scopesParam = params.get('scopes') || '';
const reason = params.get('reason') || '';
const toolsParam = params.get('tools') || '';

const scopes = scopesParam.split(',').filter(Boolean) as PermissionScope[];
const tools = toolsParam.split(',').filter(Boolean);

// Render origin
const originEl = document.getElementById('origin');
if (originEl) {
  originEl.textContent = origin;
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
        item.innerHTML = `
          <div class="scope-header">
            <span class="scope-icon">${icon}</span>
            <span class="scope-title">${scope}</span>
          </div>
          <div class="scope-description">Access to ${scope}</div>
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

    for (const tool of tools) {
      const item = document.createElement('div');
      item.className = 'tool-item';
      item.innerHTML = `
        <input type="checkbox" id="tool-${tool}" data-tool="${tool}" checked>
        <label for="tool-${tool}" class="tool-name">${tool}</label>
      `;
      toolsList.appendChild(item);
    }
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
  chrome.runtime.sendMessage({
    type: 'permission_prompt_response',
    response: { promptId, ...response },
  });
}
