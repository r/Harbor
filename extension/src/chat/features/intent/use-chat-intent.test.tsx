// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useChatIntent } from './use-chat-intent';

describe('useChatIntent', () => {
  it('updates source and tool intent only from explicit callbacks', () => {
    const { result } = renderHook(() => useChatIntent());

    act(() => {
      result.current.includeSource({
        title: 'Article',
        origin: 'https://example.com',
      });
      result.current.allowTools(['search/query']);
    });

    expect(result.current.intent).toEqual({
      context: {
        mode: 'source',
        preview: {
          title: 'Article',
          origin: 'https://example.com',
        },
      },
      tools: {
        mode: 'approved',
        toolNames: ['search/query'],
      },
    });

    act(() => {
      result.current.reset();
    });

    expect(result.current.intent).toEqual({
      context: { mode: 'off' },
      tools: { mode: 'off' },
    });
  });
});
