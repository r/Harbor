import { describe, expect, it } from 'vitest';
import type {
  PermissionScope,
  PermissionStatus,
} from '../types';
import { authorizeAgentRun } from './agent-run';

function permissionStatus(
  overrides: Partial<Record<PermissionScope, 'granted-once' | 'granted-always' | 'denied' | 'not-granted'>> = {},
  allowedTools: string[] = [],
): PermissionStatus {
  return {
    origin: 'moz-extension://harbor',
    scopes: {
      'model:tools': 'granted-once',
      'mcp:tools.list': 'granted-once',
      'mcp:tools.call': 'granted-once',
      ...overrides,
    } as PermissionStatus['scopes'],
    allowedTools,
  };
}

describe('authorizeAgentRun', () => {
  it('requires the model and MCP tool scopes', () => {
    expect(authorizeAgentRun(
      { task: 'Search' },
      permissionStatus({ 'mcp:tools.call': 'not-granted' }),
    )).toEqual({
      granted: false,
      message: 'Model and tool access must be approved before this run.',
    });
  });

  it('rejects tools outside the approved allowlist', () => {
    expect(authorizeAgentRun(
      { task: 'Search', tools: ['search/web'] },
      permissionStatus({}, ['calendar/list']),
    )).toEqual({
      granted: false,
      message: 'One or more requested tools are not approved for this run.',
    });
  });

  it('returns the explicit approved tool set', () => {
    const result = authorizeAgentRun(
      { task: 'Search', tools: ['search/web'] },
      permissionStatus({}, ['search/web']),
    );

    expect(result.granted).toBe(true);
    expect(result.granted && Array.from(result.allowedTools)).toEqual([
      'search/web',
    ]);
  });
});
