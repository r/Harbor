/**
 * Harbor JS AI Provider - Permission Prompt
 * 
 * Handles the permission dialog UI and communicates decisions back to the background script.
 */

import browser from 'webextension-polyfill';
import type { PermissionScope } from './provider/types';

// Scope icons and descriptions
const SCOPE_INFO: Record<PermissionScope, { icon: string; iconClass: string; description: string }> = {
  'model:prompt': {
    icon: 'AI',
    iconClass: 'model',
    description: 'Generate text using AI models',
  },
  'model:tools': {
    icon: '⚡',
    iconClass: 'model',
    description: 'Use AI with tool calling capabilities',
  },
  'mcp:tools.list': {
    icon: '📋',
    iconClass: 'tools',
    description: 'List available MCP tools',
  },
  'mcp:tools.call': {
    icon: '🔧',
    iconClass: 'tools',
    description: 'Execute MCP tools on your behalf',
  },
  'browser:activeTab.read': {
    icon: '👁',
    iconClass: 'browser',
    description: 'Read content from the currently active browser tab',
  },
  'web:fetch': {
    icon: '🌐',
    iconClass: 'browser',
    description: 'Make web requests on your behalf (not implemented)',
  },
};

// =============================================================================
// Parse URL Parameters
// =============================================================================

function parseParams(): { promptId: string; origin: string; scopes: PermissionScope[]; reason: string; tools: string[] } {
  const params = new URLSearchParams(window.location.search);
  
  const promptId = params.get('promptId') || '';
  const origin = params.get('origin') || 'Unknown origin';
  const reason = params.get('reason') || '';
  
  let scopes: PermissionScope[] = [];
  try {
    scopes = JSON.parse(params.get('scopes') || '[]');
  } catch {
    console.error('Failed to parse scopes');
  }
  
  let tools: string[] = [];
  try {
    const toolsParam = params.get('tools');
    if (toolsParam) {
      tools = JSON.parse(toolsParam);
    }
  } catch {
    console.error('Failed to parse tools');
  }
  
  return { promptId, origin, scopes, reason, tools };
}

// =============================================================================
// Render UI
// =============================================================================

function renderUI(): void {
  const { origin, scopes, reason, tools } = parseParams();
  
  // Set origin
  const originEl = document.getElementById('origin');
  if (originEl) {
    originEl.textContent = origin;
  }
  
  // Set reason if provided
  const reasonContainer = document.getElementById('reason-container');
  const reasonEl = document.getElementById('reason');
  if (reason && reasonContainer && reasonEl) {
    reasonEl.textContent = reason;
    reasonContainer.style.display = 'block';
  }
  
  // Render scopes
  const scopeList = document.getElementById('scope-list');
  if (scopeList) {
    scopeList.innerHTML = scopes.map(scope => {
      const info = SCOPE_INFO[scope] || {
        icon: '?',
        iconClass: 'model',
        description: scope,
      };
      
      return `
        <div class="scope-item">
          <div class="scope-icon ${info.iconClass}">${info.icon}</div>
          <div class="scope-info">
            <div class="scope-name">${escapeHtml(scope)}</div>
            <div class="scope-description">${escapeHtml(info.description)}</div>
          </div>
        </div>
      `;
    }).join('');
  }
  
  // Render tools section if mcp:tools.call is requested and tools are available
  if (scopes.includes('mcp:tools.call') && tools.length > 0) {
    renderToolsUI(tools);
  }
}

function renderToolsUI(tools: string[]): void {
  const section = document.getElementById('tools-section');
  const list = document.getElementById('tools-list');
  if (!section || !list) return;
  
  section.style.display = 'block';
  
  list.innerHTML = tools.map(tool => {
    const slashIndex = tool.indexOf('/');
    const serverId = slashIndex > -1 ? tool.slice(0, slashIndex) : 'unknown';
    const toolName = slashIndex > -1 ? tool.slice(slashIndex + 1) : tool;
    
    return `
      <label class="tool-item">
        <input type="checkbox" class="tool-checkbox" value="${escapeHtml(tool)}" checked>
        <div class="tool-info">
          <div class="tool-name">${escapeHtml(toolName)}</div>
          <div class="tool-server">${escapeHtml(serverId)}</div>
        </div>
      </label>
    `;
  }).join('');
  
  // Add select all / none handlers
  document.getElementById('select-all')?.addEventListener('click', () => {
    list.querySelectorAll<HTMLInputElement>('.tool-checkbox').forEach(cb => {
      cb.checked = true;
    });
  });
  
  document.getElementById('select-none')?.addEventListener('click', () => {
    list.querySelectorAll<HTMLInputElement>('.tool-checkbox').forEach(cb => {
      cb.checked = false;
    });
  });
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// =============================================================================
// Decision Handling
// =============================================================================

function getSelectedTools(): string[] | undefined {
  const { tools } = parseParams();
  if (tools.length === 0) return undefined;
  
  const checkboxes = document.querySelectorAll<HTMLInputElement>('.tool-checkbox:checked');
  const selected = Array.from(checkboxes).map(cb => cb.value);
  
  // If all tools are selected, return undefined (means all allowed)
  if (selected.length === tools.length) {
    return undefined;
  }
  
  return selected;
}

async function sendDecision(decision: 'allow-once' | 'allow-always' | 'deny'): Promise<void> {
  const { promptId, tools } = parseParams();
  
  // Get selected tools (only relevant if not denying)
  let allowedTools: string[] | undefined;
  if (decision !== 'deny' && tools.length > 0) {
    allowedTools = getSelectedTools();
    
    // If no tools selected but tools were available, show warning
    const checkboxes = document.querySelectorAll<HTMLInputElement>('.tool-checkbox:checked');
    if (checkboxes.length === 0) {
      const proceed = confirm('No tools selected. The site will not be able to call any tools. Continue?');
      if (!proceed) return;
      allowedTools = []; // Empty array means no tools allowed
    }
  }
  
  try {
    // Send decision to background script
    await browser.runtime.sendMessage({
      type: 'provider_permission_response',
      promptId,
      decision,
      allowedTools,
    });
    
    // Close this popup window
    window.close();
  } catch (err) {
    console.error('Failed to send permission decision:', err);
    // Show error to user
    alert('Failed to save permission decision. Please close this window and try again.');
  }
}

// =============================================================================
// Event Listeners
// =============================================================================

function setupListeners(): void {
  document.getElementById('allow-always')?.addEventListener('click', () => {
    sendDecision('allow-always');
  });
  
  document.getElementById('allow-once')?.addEventListener('click', () => {
    sendDecision('allow-once');
  });
  
  document.getElementById('deny')?.addEventListener('click', () => {
    sendDecision('deny');
  });
  
  // Handle window close (treat as deny)
  window.addEventListener('beforeunload', () => {
    // Note: We can't reliably send async messages here, so the background
    // script should have a timeout to handle cases where the user just closes the window
  });
}

// =============================================================================
// Theme
// =============================================================================

function initTheme(): void {
  // Check localStorage first
  const savedTheme = localStorage.getItem('harbor-theme');
  if (savedTheme) {
    document.documentElement.setAttribute('data-theme', savedTheme);
    return;
  }
  
  // Fall back to system preference
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
}

// =============================================================================
// Initialize
// =============================================================================

function init(): void {
  initTheme();
  renderUI();
  setupListeners();
}

// Run when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

