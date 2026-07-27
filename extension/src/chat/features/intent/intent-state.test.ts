import { describe, expect, it } from 'vitest';
import {
  approveTools,
  createDefaultChatIntent,
  includeSourceContext,
  removeDeniedCapabilities,
} from './intent-state';

describe('chat intent state', () => {
  it('defaults page context and tools to off', () => {
    expect(createDefaultChatIntent()).toEqual({
      context: { mode: 'off' },
      tools: { mode: 'off' },
    });
  });

  it('normalizes the approved tool allowlist', () => {
    const intent = approveTools(
      createDefaultChatIntent(),
      ['search/query', ' search/query ', '', 'time/now'],
    );

    expect(intent.tools).toEqual({
      mode: 'approved',
      toolNames: ['search/query', 'time/now'],
    });
  });

  it('removes only capabilities affected by denied scopes', () => {
    const sourceIntent = includeSourceContext(
      approveTools(createDefaultChatIntent(), ['search/query']),
      {
        title: 'Harbor',
        origin: 'https://example.com',
      },
    );

    expect(removeDeniedCapabilities(
      sourceIntent,
      ['browser:activeTab.read'],
    )).toEqual({
      intent: {
        context: { mode: 'off' },
        tools: {
          mode: 'approved',
          toolNames: ['search/query'],
        },
      },
      omitted: ['context'],
    });
  });
});
