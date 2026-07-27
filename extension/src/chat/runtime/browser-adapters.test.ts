import { describe, expect, it, vi } from 'vitest';
import type { SourceTabReference } from '../contracts';
import type { ChatTransport } from './chat-transport';
import {
  createChatPermissionPort,
  createTransportTextGenerationPort,
  type CachedSourceTabPort,
} from './browser-adapters';

const SOURCE: SourceTabReference = {
  tabId: 7,
  windowId: 3,
  url: 'https://example.com/article',
  title: 'Article',
  origin: 'https://example.com',
};

function createSourcePort(
  source: SourceTabReference | undefined,
): CachedSourceTabPort {
  return {
    resolveLaunch: vi.fn(),
    inspect: vi.fn(),
    capture: vi.fn(),
    getResolvedSource: () => source,
  };
}

function createTransport(
  request: (
    type: string,
    payload?: unknown,
    source?: SourceTabReference,
  ) => Promise<unknown>,
): ChatTransport {
  return {
    request: request as ChatTransport['request'],
    stream: vi.fn(),
    disconnect: vi.fn(),
  };
}

describe('createChatPermissionPort', () => {
  it('reads model grants from chat and browser grants from the source tab', async () => {
    const request = vi.fn(async (
      _type: string,
      _payload?: unknown,
      source?: SourceTabReference,
    ) => ({
      scopes: source
        ? { 'browser:activeTab.read': 'granted-once' }
        : {
          'model:prompt': 'granted-always',
          'model:tools': 'denied',
        },
    }));
    const port = createChatPermissionPort(
      createTransport(request),
      createSourcePort(SOURCE),
    );

    await expect(port.list()).resolves.toEqual({
      'model:prompt': 'granted',
      'model:tools': 'denied',
      'browser:activeTab.read': 'granted',
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('splits chat and source permissions into their correct identities', async () => {
    const request = vi.fn(async (
      _type: string,
      payload?: unknown,
      _source?: SourceTabReference,
    ) => {
      const scopes = (payload as { scopes: string[] }).scopes;
      return {
        granted: true,
        scopes: Object.fromEntries(
          scopes.map(scope => [scope, 'granted-once']),
        ),
      };
    });
    const port = createChatPermissionPort(
      createTransport(request),
      createSourcePort(SOURCE),
    );

    await expect(port.request({
      scopes: ['model:prompt', 'browser:activeTab.read'],
      reason: 'Answer with the current page',
      toolAllowlist: [],
    })).resolves.toEqual({
      kind: 'granted',
      scopes: ['model:prompt', 'browser:activeTab.read'],
    });

    expect(request.mock.calls[0][2]).toBeUndefined();
    expect(request.mock.calls[1][2]).toEqual(SOURCE);
  });

  it('does not request page access without a resolved source tab', async () => {
    const request = vi.fn();
    const port = createChatPermissionPort(
      createTransport(request),
      createSourcePort(undefined),
    );

    await expect(port.request({
      scopes: ['browser:activeTab.read'],
      reason: 'Read the current page',
      toolAllowlist: [],
    })).resolves.toEqual({
      kind: 'unavailable',
      message: 'The source page is no longer available.',
    });
    expect(request).not.toHaveBeenCalled();
  });
});

describe('createTransportTextGenerationPort', () => {
  it('adapts request-response sessions to the text stream contract', async () => {
    const request = vi.fn(async (
      type: string,
      _payload?: unknown,
      _source?: SourceTabReference,
    ) => {
      if (type === 'ai.createTextSession') {
        return 'session-1';
      }
      if (type === 'session.prompt') {
        return 'Hello from Harbor';
      }
      return undefined;
    });
    const port = createTransportTextGenerationPort(
      createTransport(request),
    );
    const session = await port.createTextSession();
    const output: unknown[] = [];

    for await (const event of session.promptStreaming('Hello')) {
      output.push(event);
    }
    await session.destroy();

    expect(output).toEqual(['Hello from Harbor']);
    expect(request).toHaveBeenCalledWith(
      'session.prompt',
      { sessionId: 'session-1', input: 'Hello' },
    );
    expect(request).toHaveBeenCalledWith(
      'session.destroy',
      { sessionId: 'session-1' },
    );
  });
});
