/**
 * Tests for the sidebar-facing session handlers.
 *
 * A session is created the way a page creates one (the page API's
 * agent.sessions.create handler, through Harbor's real in-process core and
 * SessionRegistry), then listed and terminated through the runtime messages
 * the sidebar sends.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hasPermission: vi.fn(),
  getPermissions: vi.fn(),
}));
vi.mock('../../page-api/handlers/permission-handlers', () => ({
  hasPermission: mocks.hasPermission,
  getPermissions: mocks.getPermissions,
}));

import { handleSessionsCreate } from '../../page-api/handlers/session-handlers';
import { SessionRegistry } from '../../sessions';

type Listener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void
) => boolean | void;

const listeners: Listener[] = [];
const ORIGIN = 'https://example.test';

beforeAll(async () => {
  const chrome = (globalThis as unknown as { chrome: { runtime: { onMessage: { addListener: (l: Listener) => void } } } }).chrome;
  chrome.runtime.onMessage.addListener = (l: Listener) => {
    listeners.push(l);
  };
  const mod = await import('../session-handlers');
  mod.registerSessionHandlers();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasPermission.mockResolvedValue(true);
  mocks.getPermissions.mockResolvedValue({ scopes: {}, allowedTools: [] });
  for (const s of SessionRegistry.listSessions()) {
    SessionRegistry.destroySession(s.sessionId, s.origin);
  }
});

/** Send a runtime message the way the sidebar does and await the response. */
function sidebarSend(message: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve) => {
    let resolved = false;
    let async = false;
    const sendResponse = (response: unknown) => {
      if (resolved) return;
      resolved = true;
      resolve(response);
    };
    for (const l of listeners) {
      if (l(message, {} as chrome.runtime.MessageSender, sendResponse) === true) async = true;
    }
    if (!async && !resolved) resolve(undefined);
  });
}

async function createPageSession(name: string): Promise<string> {
  const res = (await handleSessionsCreate({
    id: 'req-create',
    type: 'agent.sessions.create',
    origin: ORIGIN,
    payload: { name, capabilities: { tools: [], browser: [] } },
  } as never)) as { ok: boolean; result: { sessionId: string } };
  expect(res.ok).toBe(true);
  return res.result.sessionId;
}

describe('sidebar session handlers', () => {
  it('lists a session a page created', async () => {
    const sessionId = await createPageSession('Page session');

    const res = (await sidebarSend({ type: 'session.list' })) as {
      ok: boolean;
      sessions: Array<{ sessionId: string; origin: string; status: string; name?: string }>;
    };

    expect(res.ok).toBe(true);
    expect(res.sessions).toEqual([
      expect.objectContaining({ sessionId, origin: ORIGIN, status: 'active', name: 'Page session' }),
    ]);
  });

  it('terminates a page session, and the list then shows it terminated', async () => {
    const sessionId = await createPageSession('Page session');

    const term = await sidebarSend({ type: 'session.terminate', sessionId, origin: ORIGIN });
    expect(term).toEqual({ ok: true, terminated: true });

    const res = (await sidebarSend({ type: 'session.list' })) as {
      sessions: Array<{ sessionId: string; status: string }>;
    };
    expect(res.sessions).toEqual([expect.objectContaining({ sessionId, status: 'terminated' })]);
    expect(() => SessionRegistry.getValidatedSession(sessionId, ORIGIN)).toThrow(/terminated/);
  });

  it('still applies the list filters', async () => {
    await createPageSession('Page session');

    const other = (await sidebarSend({ type: 'session.list', origin: 'https://other.test' })) as {
      sessions: unknown[];
    };
    expect(other.sessions).toEqual([]);

    const implicitOnly = (await sidebarSend({ type: 'session.list', sessionType: 'implicit' })) as {
      sessions: unknown[];
    };
    expect(implicitOnly.sessions).toEqual([]);

    const explicitOnly = (await sidebarSend({ type: 'session.list', sessionType: 'explicit' })) as {
      sessions: unknown[];
    };
    expect(explicitOnly.sessions).toHaveLength(1);
  });
});
