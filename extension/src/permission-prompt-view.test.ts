// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  createScopeLedgerRow,
  createToolSelectionRow,
  describePermissionPrincipal,
} from './permission-prompt-view';

describe('permission prompt view', () => {
  it('names the internal extension principal without hiding its identity', () => {
    expect(describePermissionPrincipal(
      'chrome-extension://abcdefghijklmnop/',
    )).toEqual({
      name: 'Harbor Chat',
      detail: 'chrome-extension://abcdefghijklmnop/',
    });
  });

  it('renders scope metadata as a Port Authority ledger row', () => {
    const row = createScopeLedgerRow(
      document,
      'mcp:tools.call',
      0,
      {
        title: 'Execute tools',
        description: 'Call only the selected connected tools.',
        risk: 'high',
      },
    );

    expect(row.textContent).toContain('01');
    expect(row.textContent).toContain('Tools');
    expect(row.textContent).toContain('high risk');
    expect(row.textContent).toContain('mcp:tools.call');
    expect(row.dataset.risk).toBe('high');
  });

  it('treats tool names as text while preserving their exact value', () => {
    const tool = '<img src=x onerror=alert(1)>';
    const row = createToolSelectionRow(document, tool, 0);

    expect(row.querySelector('img')).toBeNull();
    expect(row.textContent).toContain(tool);
    expect(row.querySelector('input')?.dataset.tool).toBe(tool);
  });
});
