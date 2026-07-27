// @vitest-environment jsdom

import {
  act,
  renderHook,
  waitFor,
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatReadiness } from '../../contracts';
import type { ReadinessService } from '../../services';
import { useChatReadiness } from './useChatReadiness';

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve: resolvePromise,
  };
}

const readyReadiness: ChatReadiness = {
  api: 'available',
  bridge: 'ready',
  model: {
    state: 'ready',
    provider: 'Ollama',
    model: 'Local',
    locality: 'local',
  },
  tools: {
    state: 'empty',
    count: 0,
  },
  blockers: [],
};

const offlineReadiness: ChatReadiness = {
  api: 'available',
  bridge: 'offline',
  model: {
    state: 'unavailable',
  },
  tools: {
    state: 'unavailable',
    count: 0,
  },
  blockers: [{
    kind: 'retry',
    label: 'Check Again',
  }],
};

describe('useChatReadiness', () => {
  it('checks readiness on mount', async () => {
    const service: ReadinessService = {
      check: vi.fn(async () => readyReadiness),
    };

    const { result } = renderHook(() => useChatReadiness(service));

    expect(result.current.readiness.bridge).toBe('checking');
    await waitFor(() => {
      expect(result.current.readiness).toEqual(readyReadiness);
    });
    expect(service.check).toHaveBeenCalledOnce();
  });

  it('does not let an older request overwrite a newer retry', async () => {
    const firstRequest = deferred<ChatReadiness>();
    const secondRequest = deferred<ChatReadiness>();
    const service: ReadinessService = {
      check: vi.fn()
        .mockReturnValueOnce(firstRequest.promise)
        .mockReturnValueOnce(secondRequest.promise),
    };
    const { result } = renderHook(() => useChatReadiness(service));

    await waitFor(() => {
      expect(service.check).toHaveBeenCalledOnce();
    });

    act(() => {
      void result.current.retry();
    });
    expect(service.check).toHaveBeenCalledTimes(2);

    await act(async () => {
      secondRequest.resolve(readyReadiness);
      await secondRequest.promise;
    });
    expect(result.current.readiness).toEqual(readyReadiness);

    await act(async () => {
      firstRequest.resolve(offlineReadiness);
      await firstRequest.promise;
    });
    expect(result.current.readiness).toEqual(readyReadiness);
  });

  it('turns an unexpected service failure into a recoverable state', async () => {
    const service: ReadinessService = {
      check: vi.fn(async () => {
        throw new Error('Unexpected failure');
      }),
    };

    const { result } = renderHook(() => useChatReadiness(service));

    await waitFor(() => {
      expect(result.current.readiness.bridge).toBe('offline');
    });
    expect(result.current.readiness.blockers.map(action => action.kind)).toEqual([
      'retry',
      'open-connections',
    ]);
  });
});
