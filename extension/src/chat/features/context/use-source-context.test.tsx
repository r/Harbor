// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SourceTabPort } from '../../services';
import { useSourceContext } from './use-source-context';

describe('useSourceContext', () => {
  it('loads preview metadata and captures only from the explicit callback', async () => {
    const source = {
      tabId: 41,
      windowId: 7,
      url: 'https://example.com/article',
      title: 'Example article',
      origin: 'https://example.com',
    };
    const sourceTabPort: SourceTabPort = {
      resolveLaunch: vi.fn<SourceTabPort['resolveLaunch']>()
        .mockResolvedValue({
          version: 1,
          launchId: 'launch-123',
          source,
          createdAt: 1_000,
          expiresAt: 10_000,
        }),
      inspect: vi.fn<SourceTabPort['inspect']>()
        .mockResolvedValue(source),
      capture: vi.fn<SourceTabPort['capture']>().mockResolvedValue({
        title: source.title,
        url: source.url,
        text: 'Approved content',
        capturedAt: 3_000,
      }),
    };

    const { result } = renderHook(() => useSourceContext({
      launchId: 'launch-123',
      sourceTabPort,
      now: () => 2_000,
    }));

    await waitFor(() => {
      expect(result.current.state.kind).toBe('available');
    });
    expect(sourceTabPort.capture).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.capture([
        'model:prompt',
        'browser:activeTab.read',
      ]);
    });

    expect(result.current.state.kind).toBe('captured');
    expect(sourceTabPort.capture).toHaveBeenCalledWith(source);
  });
});
