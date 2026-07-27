import type { PermissionScope } from './agents/types';
import { browserAPI } from './browser-compat';
import {
  createCapabilityBadge,
  createScopeLedgerRow,
  createToolSelectionRow,
  describePermissionPrincipal,
} from './permission-prompt-view';
import { SCOPE_DESCRIPTIONS } from './policy/permissions';

type Theme = 'light' | 'dark' | 'system';

type PermissionPromptResponse = {
  granted: boolean;
  grantType?: 'granted-once' | 'granted-always';
  allowedTools?: string[];
  explicitDeny?: boolean;
};

function getSystemTheme(): Exclude<Theme, 'system'> {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

function applyTheme(theme: Theme): void {
  const effectiveTheme = theme === 'system' ? getSystemTheme() : theme;
  document.documentElement.dataset.harborTheme = effectiveTheme;
  document.documentElement.dataset.theme = effectiveTheme;
}

function initializeTheme(): void {
  const savedTheme = localStorage.getItem('harbor-theme') as Theme | null;
  applyTheme(savedTheme ?? 'system');

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener(
    'change',
    () => {
      const currentTheme = localStorage.getItem('harbor-theme') as Theme | null;
      if (!currentTheme || currentTheme === 'system') {
        applyTheme('system');
      }
    },
  );

  window.addEventListener('storage', event => {
    if (event.key === 'harbor-theme' && event.newValue) {
      applyTheme(event.newValue as Theme);
    }
  });
}

function parseList(value: string): string[] {
  return value.split(',').filter(Boolean);
}

function renderPrincipal(origin: string): void {
  const principal = describePermissionPrincipal(origin);
  const nameElement = document.getElementById('principal-name');
  const originElement = document.getElementById('origin');

  if (nameElement) {
    nameElement.textContent = principal.name;
  }
  if (originElement) {
    originElement.textContent = principal.detail;
  }
}

function renderSessionContext(params: URLSearchParams): void {
  const sessionName = params.get('sessionName') ?? '';
  const sessionType = params.get('sessionType') ?? '';
  if (!sessionName && sessionType !== 'explicit') {
    return;
  }

  const container = document.getElementById('session-context');
  const nameElement = document.getElementById('session-name');
  const badgesElement = document.getElementById('session-badges');
  if (!container || !nameElement || !badgesElement) {
    return;
  }

  container.hidden = false;
  nameElement.textContent = sessionName || 'Agent session';

  if (sessionType === 'explicit') {
    badgesElement.append(
      createCapabilityBadge(document, 'Explicit session', 'neutral'),
    );
  }
  if (params.get('llm') === 'true') {
    badgesElement.append(
      createCapabilityBadge(document, 'Model', 'model'),
    );
  }

  const requestedTools = Number.parseInt(
    params.get('toolsCount') ?? '0',
    10,
  );
  if (requestedTools > 0) {
    badgesElement.append(
      createCapabilityBadge(
        document,
        `${requestedTools} tools`,
        'tools',
      ),
    );
  }

  const browserCapabilities = parseList(params.get('browser') ?? '');
  if (browserCapabilities.length > 0) {
    badgesElement.append(
      createCapabilityBadge(
        document,
        `Page: ${browserCapabilities.join(', ')}`,
        'browser',
      ),
    );
  }
}

function renderReason(reason: string): void {
  if (!reason) {
    return;
  }

  const container = document.getElementById('reason-container');
  const reasonElement = document.getElementById('reason');
  if (container && reasonElement) {
    container.hidden = false;
    reasonElement.textContent = reason;
  }
}

function renderScopes(scopes: PermissionScope[]): void {
  const list = document.getElementById('scopes-list');
  const count = document.getElementById('scope-count');
  if (!list || !count) {
    return;
  }

  count.textContent = `${scopes.length} ${
    scopes.length === 1 ? 'capability' : 'capabilities'
  }`;

  if (scopes.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'scopes-empty';
    empty.textContent = 'No additional capabilities requested.';
    list.appendChild(empty);
    return;
  }

  scopes.forEach((scope, index) => {
    list.appendChild(createScopeLedgerRow(
      document,
      scope,
      index,
      SCOPE_DESCRIPTIONS[scope],
    ));
  });
}

function renderTools(tools: string[]): void {
  if (tools.length === 0) {
    return;
  }

  const section = document.getElementById('tools-section');
  const list = document.getElementById('tools-list');
  const count = document.getElementById('tool-count');
  if (!section || !list || !count) {
    return;
  }

  section.hidden = false;
  count.textContent = `${tools.length} selected`;
  tools.forEach((tool, index) => {
    list.appendChild(createToolSelectionRow(document, tool, index));
  });
}

function selectedToolNames(): string[] {
  const selectedTools: string[] = [];
  const checkboxes = document.querySelectorAll<HTMLInputElement>(
    '#tools-list input[type="checkbox"]',
  );

  for (const checkbox of checkboxes) {
    if (checkbox.checked && checkbox.dataset.tool) {
      selectedTools.push(checkbox.dataset.tool);
    }
  }
  return selectedTools;
}

function sendResponse(response: PermissionPromptResponse): void {
  void browserAPI.runtime.sendMessage({
    type: 'permission_prompt_response',
    response,
  });
}

function initializeActions(): void {
  document.getElementById('btn-deny')?.addEventListener('click', () => {
    sendResponse({ granted: false, explicitDeny: true });
  });

  document.getElementById('btn-grant')?.addEventListener('click', () => {
    const grantOnce = (
      document.getElementById('grant-once') as HTMLInputElement | null
    )?.checked;
    const tools = selectedToolNames();

    sendResponse({
      granted: true,
      grantType: grantOnce ? 'granted-once' : 'granted-always',
      allowedTools: tools.length > 0 ? tools : undefined,
    });
  });
}

function initializePermissionPrompt(): void {
  initializeTheme();

  const params = new URLSearchParams(window.location.search);
  const origin = params.get('origin') || 'Unknown';
  const scopes = parseList(
    params.get('scopes') ?? '',
  ) as PermissionScope[];
  const tools = parseList(params.get('tools') ?? '');

  renderPrincipal(origin);
  renderSessionContext(params);
  renderReason(params.get('reason') ?? '');
  renderScopes(scopes);
  renderTools(tools);
  initializeActions();
}

initializePermissionPrompt();
