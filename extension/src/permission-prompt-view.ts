import type { PermissionScope } from './agents/types';

export type ScopeDescription = {
  title: string;
  description: string;
  risk: 'low' | 'medium' | 'high';
};

export type PermissionPrincipal = {
  name: string;
  detail: string;
};

export function describePermissionPrincipal(
  origin: string,
): PermissionPrincipal {
  try {
    const url = new URL(origin);
    if (
      url.protocol === 'chrome-extension:'
      || url.protocol === 'moz-extension:'
    ) {
      return {
        name: 'Harbor Chat',
        detail: origin,
      };
    }

    return {
      name: url.hostname || origin,
      detail: origin,
    };
  } catch {
    return {
      name: 'Unknown requestor',
      detail: origin,
    };
  }
}

export function createScopeLedgerRow(
  document: Document,
  scope: PermissionScope,
  index: number,
  description?: ScopeDescription,
): HTMLElement {
  const row = document.createElement('article');
  row.className = 'scope-row';
  row.dataset.risk = description?.risk ?? 'unknown';

  const sequence = document.createElement('span');
  sequence.className = 'scope-row__sequence';
  sequence.textContent = String(index + 1).padStart(2, '0');

  const content = document.createElement('div');
  content.className = 'scope-row__content';

  const metadata = document.createElement('div');
  metadata.className = 'scope-row__metadata';

  const category = document.createElement('span');
  category.className = 'scope-row__category';
  category.textContent = scopeCategory(scope);

  const risk = document.createElement('span');
  risk.className = 'risk-label';
  risk.textContent = description
    ? `${description.risk} risk`
    : 'Review';

  const title = document.createElement('strong');
  title.className = 'scope-row__title';
  title.textContent = description?.title ?? scope;

  const identifier = document.createElement('code');
  identifier.className = 'scope-row__identifier';
  identifier.textContent = scope;

  const detail = document.createElement('p');
  detail.className = 'scope-row__description';
  detail.textContent = description?.description ?? `Access to ${scope}`;

  metadata.append(category, risk);
  content.append(metadata, title, identifier, detail);
  row.append(sequence, content);
  return row;
}

export function createToolSelectionRow(
  document: Document,
  tool: string,
  index: number,
): HTMLLabelElement {
  const label = document.createElement('label');
  label.className = 'tool-row';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = `permission-tool-${index + 1}`;
  input.dataset.tool = tool;
  input.checked = true;

  const copy = document.createElement('span');
  copy.className = 'tool-row__copy';

  const name = document.createElement('strong');
  name.className = 'tool-row__name';
  name.textContent = tool;

  const detail = document.createElement('small');
  detail.textContent = 'Available to this run';

  copy.append(name, detail);
  label.append(input, copy);
  return label;
}

export function createCapabilityBadge(
  document: Document,
  label: string,
  tone: 'neutral' | 'model' | 'tools' | 'browser',
): HTMLSpanElement {
  const badge = document.createElement('span');
  badge.className = `session-badge session-badge--${tone}`;
  badge.textContent = label;
  return badge;
}

function scopeCategory(scope: PermissionScope): string {
  if (scope.startsWith('model:')) {
    return 'Model';
  }
  if (scope.startsWith('mcp:')) {
    return 'Tools';
  }
  if (scope.startsWith('browser:')) {
    return 'Page';
  }
  if (scope.startsWith('addressBar:')) {
    return 'Navigation';
  }
  if (scope.startsWith('agents:')) {
    return 'Agents';
  }
  return 'Harbor';
}
