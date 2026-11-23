/**
 * Permission Prompt Handler
 *
 * Runs in the permission prompt popup window.
 * Uses the same design tokens as the sidebar for consistency.
 */

import { browserAPI } from './browser-compat';
import { consentScopeDescription, consentScopeRows } from './policy/agent-consent-copy';
import { buildScopeItem } from './scope-item';
import { escapeHtml } from './html-escape';
import type { PermissionScope } from './agents/types';
import type { IconName } from './icons';

// Icons for each scope category
const SCOPE_ICONS: Record<string, IconName> = {
  'model:prompt': 'message-circle',
  'model:tools': 'wrench',
  'model:list': 'list',
  'mcp:tools.list': 'plug',
  'mcp:tools.call': 'play',
  'mcp:servers.register': 'server',
  'browser:activeTab.read': 'file-text',
  'browser:activeTab.interact': 'mouse-pointer-click',
  'browser:activeTab.screenshot': 'camera',
  'chat:open': 'message-circle',
  'web:fetch': 'globe',
};

// =============================================================================
// Permission Prompt Logic
// =============================================================================

// Parse URL params
const params = new URLSearchParams(window.location.search);
const origin = params.get('origin') || 'Unknown';
const scopesParam = params.get('scopes') || '';
const reason = params.get('reason') || '';
const toolsParam = params.get('tools') || '';
const agentOriginsParam = params.get('agentOrigins') || '';
const sessionName = params.get('sessionName') || '';
const sessionType = params.get('sessionType') || '';
const requestedLLM = params.get('llm') === 'true';
const requestedTools = params.get('toolsCount') || '0';
const requestedBrowser = params.get('browser') || '';
// Set only when the person has selected an ACP agent — permissions.ts
// resolves it once per prompt via resolveConsentAgentName(). Absent with
// no agent selected, so the switch below leaves the built-in wording for
// model:prompt/model:tools untouched.
const agentName = params.get('agent') || null;
// The backend selected when this prompt was shown — echoed back verbatim
// in the response below, never re-read live: if the person switches
// backends while this popup is still open, the grant must land on the
// backend this prompt actually named, not whatever is selected by the
// time they answer (item 3, docs/ACP_BACKEND_DESIGN.md).
const backendTag = params.get('backendTag') || undefined;

const scopes = scopesParam.split(',').filter(Boolean) as PermissionScope[];
const tools = toolsParam.split(',').filter(Boolean);
const agentOrigins = agentOriginsParam.split(',').filter(Boolean);

// Origins come from the requesting tab. Keep the scheme visible for non-HTTPS sites.
const site = origin.replace(/^https:\/\//, '');
const agentOnly = Boolean(agentName) && scopes.length > 0 &&
  scopes.every((scope) => scope === 'model:prompt' || scope === 'model:tools');

const heading = document.getElementById('heading');
if (heading) {
  heading.textContent = agentOnly
    ? `Let ${site} send requests to ${agentName}?`
    : `Allow the permissions requested by ${site}?`;
}

const btnAlways = document.getElementById('btn-always');
if (btnAlways) {
  btnAlways.textContent = agentOnly
    ? `Allow ${site} to use ${agentName} without asking`
    : `Allow these permissions for ${site} without asking`;
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
      badges.push('<span class="session-badge llm">Model access</span>');
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
  const reasonLabel = document.getElementById('reason-label');
  if (reasonContainer && reasonEl && reasonLabel) {
    reasonContainer.hidden = false;
    reasonLabel.textContent = `Stated reason from ${site}`;
    reasonEl.textContent = reason;
  }
}

// Render scopes
const scopesList = document.getElementById('scopes-list');
if (agentOnly) {
  const warning = document.getElementById('agent-warning');
  if (warning) {
    warning.hidden = false;
    warning.textContent = reason
      ? `${site} can also ask ${agentName} to do other things using its tools and what it remembers about you.`
      : `${agentName} can act on this site's requests using its tools and what it remembers about you.`;
  }
  const scopesHeading = document.getElementById('scopes-heading');
  if (scopesHeading) scopesHeading.hidden = true;
  if (scopesList) scopesList.hidden = true;
} else if (scopesList) {
  if (scopes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'scopes-empty';
    empty.textContent = 'No specific permissions requested';
    scopesList.appendChild(empty);
  } else {
    // model:prompt and model:tools collapse into one row when an agent is
    // selected and both are requested (consentScopeDescription already
    // gives them the same title/description/risk in that case) — see
    // consentScopeRows. Every other scope, and these two with no agent
    // selected or only one requested, stays its own row.
    for (const row of consentScopeRows(scopes, agentName)) {
      const scope = row[0];
      const info = consentScopeDescription(scope, agentName);
      const icon = SCOPE_ICONS[scope] ?? 'shield';

      const item = info
        ? buildScopeItem(icon, info.title, info.description, info.risk)
        : buildScopeItem(icon, scope, `Access to ${scope}`); // fallback for unknown scopes
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

// Render the sites whose agents this grant would reach
if (agentOrigins.length > 0) {
  const sitesSection = document.getElementById('agent-sites-section');
  const sitesList = document.getElementById('agent-sites-list');
  if (sitesSection && sitesList) {
    sitesSection.style.display = 'block';
    for (const site of agentOrigins) {
      // Site origins come from the page, so build the row without innerHTML.
      const item = document.createElement('div');
      item.className = 'tool-item';
      const label = document.createElement('span');
      label.className = 'tool-name';
      label.textContent = site;
      item.append(label);
      sitesList.appendChild(item);
    }
  }
}

// Handle deny button
const btnDeny = document.getElementById('btn-deny');
btnDeny?.addEventListener('click', () => {
  sendResponse({ granted: false, explicitDeny: true, backendTag });
});

// Each button maps directly to the grant named on it.
const btnAllow = document.getElementById('btn-grant');
if (btnAllow && params.get('merged') === '1') {
  btnAllow.textContent = 'Allow for 10 minutes';
}
btnAllow?.addEventListener('click', () => allow('granted-once'));
btnAlways?.addEventListener('click', () => allow('granted-always'));

function allow(grantType: 'granted-once' | 'granted-always'): void {
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
    backendTag,
    // Exactly the sites shown above; Harbor grants no site this page didn't show.
    agentOrigins: agentOrigins.length > 0 ? agentOrigins : undefined,
  });
}

// Send response to background script
function sendResponse(response: {
  granted: boolean;
  grantType?: 'granted-once' | 'granted-always';
  allowedTools?: string[];
  agentOrigins?: string[];
  explicitDeny?: boolean;
  backendTag?: string;
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
