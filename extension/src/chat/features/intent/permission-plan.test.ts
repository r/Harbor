import { describe, expect, it } from 'vitest';
import type { ChatIntent } from '../../contracts';
import { buildPermissionPlan } from './permission-plan';

describe('permission plan', () => {
  it('requests only model prompting for ordinary chat', () => {
    expect(buildPermissionPlan({
      context: { mode: 'off' },
      tools: { mode: 'off' },
    })).toEqual({
      scopes: ['model:prompt'],
      reason: 'Answer this message with the selected model',
      toolAllowlist: [],
    });
  });

  it('adds page read access only for source context', () => {
    expect(buildPermissionPlan({
      context: {
        mode: 'source',
        preview: {
          title: 'Article',
          origin: 'https://example.com',
        },
      },
      tools: { mode: 'off' },
    }).scopes).toEqual([
      'model:prompt',
      'browser:activeTab.read',
    ]);
  });

  it('adds tool scopes and preserves a normalized allowlist', () => {
    expect(buildPermissionPlan({
      context: { mode: 'off' },
      tools: {
        mode: 'approved',
        toolNames: ['search/query', ' search/query ', 'time/now'],
      },
    })).toEqual({
      scopes: [
        'model:prompt',
        'model:tools',
        'mcp:tools.list',
        'mcp:tools.call',
      ],
      reason: 'Answer using the selected tools',
      toolAllowlist: ['search/query', 'time/now'],
    });
  });

  it('rejects an approved tool mode without an allowlist', () => {
    const invalidIntent: ChatIntent = {
      context: { mode: 'off' },
      tools: {
        mode: 'approved',
        toolNames: [],
      },
    };

    expect(() => buildPermissionPlan(invalidIntent)).toThrow(
      'Approved tool access requires at least one tool',
    );
  });
});
