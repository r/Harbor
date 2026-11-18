import { beforeEach, describe, expect, it, vi } from 'vitest';

// a session from agent.sessions.create() must be promptable.

const mocks = vi.hoisted(() => ({
  harborRequest: vi.fn(),
  hasPermission: vi.fn(),
  getPermissions: vi.fn(),
}));
vi.mock('../harbor-core', () => ({
  harborRequest: mocks.harborRequest,
  harborStreamRequest: vi.fn(),
}));
vi.mock('../handlers/permission-handlers', () => ({
  hasPermission: mocks.hasPermission,
  getPermissions: mocks.getPermissions,
}));

import { handleSessionsCreate, handleSessionsTerminate } from '../handlers/session-handlers';
import { handleSessionPrompt } from '../handlers/ai-handlers';

const ORIGIN = 'https://example.test';
const ctx = (type: string, payload: unknown, origin = ORIGIN) =>
  ({ id: `req-${type}`, type, origin, payload } as never);

let harborSessions: Map<string, { origin: string; hasLLM: boolean; terminated?: boolean }>;

beforeEach(() => {
  vi.clearAllMocks();
  harborSessions = new Map();
  mocks.hasPermission.mockResolvedValue(true);
  mocks.getPermissions.mockResolvedValue({ scopes: {}, allowedTools: ['time/now'] });
  mocks.harborRequest.mockImplementation(async (method: string, payload: Record<string, unknown>) => {
    switch (method) {
      case 'session.create': {
        const sessionId = `harbor-${harborSessions.size + 1}`;
        const options = payload.options as { capabilities: { llm?: unknown } };
        harborSessions.set(sessionId, { origin: payload.origin as string, hasLLM: !!options.capabilities.llm });
        return { sessionId, capabilities: {} };
      }
      case 'session.get': {
        const s = harborSessions.get(payload.sessionId as string);
        if (!s || s.terminated) throw new Error('Session not found');
        if (s.origin !== payload.origin) throw new Error('Session belongs to different origin');
        return { session: { sessionId: payload.sessionId, origin: s.origin, status: 'active', capabilities: { hasLLM: s.hasLLM, toolCount: 0, hasBrowserAccess: false } } };
      }
      case 'session.terminate': {
        const s = harborSessions.get(payload.sessionId as string);
        if (s) s.terminated = true;
        return { terminated: !!s };
      }
      case 'session.recordUsage':
        return {};
      case 'llm.chat':
        return { content: 'Hello from the model.' };
      default:
        throw new Error(`unexpected ${method}`);
    }
  });
});

async function createExplicit(capabilities: Record<string, unknown> = { llm: { model: 'ollama:test' } }) {
  const res = await handleSessionsCreate(ctx('agent.sessions.create', {
    capabilities,
    options: { systemPrompt: 'Be terse', temperature: 0.2 },
  })) as { ok: boolean; result: { sessionId: string } };
  expect(res.ok).toBe(true);
  return res.result.sessionId;
}

describe('prompting an explicit session', () => {
  it('prompts with the session options from the creating origin', async () => {
    const sessionId = await createExplicit();
    const res = await handleSessionPrompt(ctx('session.prompt', { sessionId, input: 'Hi' }));
    expect(res).toMatchObject({ ok: true, result: 'Hello from the model.' });
    expect(mocks.harborRequest).toHaveBeenCalledWith('llm.chat', {
      origin: ORIGIN,
      messages: [{ role: 'system', content: 'Be terse' }, { role: 'user', content: 'Hi' }],
      model: 'ollama:test',
      temperature: 0.2,
    });
  });

  it('keeps conversation history across prompts', async () => {
    const sessionId = await createExplicit();
    await handleSessionPrompt(ctx('session.prompt', { sessionId, input: 'Hi' }));
    await handleSessionPrompt(ctx('session.prompt', { sessionId, input: 'Again' }));
    const last = mocks.harborRequest.mock.calls.filter(([m]) => m === 'llm.chat').at(-1)![1];
    expect(last.messages.map((m: { content: string }) => m.content))
      .toEqual(['Be terse', 'Hi', 'Hello from the model.', 'Again']);
  });

  it('refuses another origin', async () => {
    const sessionId = await createExplicit();
    const res = await handleSessionPrompt(ctx('session.prompt', { sessionId, input: 'Hi' }, 'https://evil.test'));
    expect(res).toMatchObject({ ok: false, error: { code: 'ERR_PERMISSION_DENIED' } });
    expect(mocks.harborRequest).not.toHaveBeenCalledWith('llm.chat', expect.anything());
  });

  it('refuses a terminated session', async () => {
    const sessionId = await createExplicit();
    await handleSessionsTerminate(ctx('agent.sessions.terminate', { sessionId }));
    const res = await handleSessionPrompt(ctx('session.prompt', { sessionId, input: 'Hi' }));
    expect(res).toMatchObject({ ok: false, error: { code: 'ERR_SESSION_NOT_FOUND' } });
    expect(mocks.harborRequest).not.toHaveBeenCalledWith('llm.chat', expect.anything());
  });

  it('refuses a session Harbor no longer has (expired)', async () => {
    const sessionId = await createExplicit();
    harborSessions.get(sessionId)!.terminated = true;
    const res = await handleSessionPrompt(ctx('session.prompt', { sessionId, input: 'Hi' }));
    expect(res).toMatchObject({ ok: false, error: { code: 'ERR_SESSION_NOT_FOUND' } });
    expect(mocks.harborRequest).not.toHaveBeenCalledWith('llm.chat', expect.anything());
  });

  it('tells Harbor about each prompt', async () => {
    const sessionId = await createExplicit();
    await handleSessionPrompt(ctx('session.prompt', { sessionId, input: 'Hi' }));
    expect(mocks.harborRequest).toHaveBeenCalledWith('session.recordUsage', {
      sessionId, origin: ORIGIN, type: 'prompt', detail: { userMessage: 'Hi', assistantMessage: 'Hello from the model.' },
    });
  });

  it('keeps the session when Harbor briefly cannot answer', async () => {
    const sessionId = await createExplicit();
    const real = mocks.harborRequest.getMockImplementation()!;
    mocks.harborRequest.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Request timeout'), { code: 'ERR_TIMEOUT' });
    });
    expect(await handleSessionPrompt(ctx('session.prompt', { sessionId, input: 'Hi' })))
      .toMatchObject({ ok: false, error: { code: 'ERR_TIMEOUT' } });
    mocks.harborRequest.mockImplementation(real);
    expect(await handleSessionPrompt(ctx('session.prompt', { sessionId, input: 'Hi' })))
      .toMatchObject({ ok: true });
  });

  it('refuses a prompt once the origin no longer holds model:prompt', async () => {
    const sessionId = await createExplicit();
    mocks.hasPermission.mockImplementation(async (_origin: string, scope: string) => scope !== 'model:prompt');
    const res = await handleSessionPrompt(ctx('session.prompt', { sessionId, input: 'Hi' }));
    expect(res).toMatchObject({ ok: false, error: { code: 'ERR_PERMISSION_DENIED' } });
    expect(mocks.harborRequest).not.toHaveBeenCalledWith('llm.chat', expect.anything());
  });

  it('refuses a session created without the llm capability', async () => {
    const sessionId = await createExplicit({ tools: ['time/now'] });
    const res = await handleSessionPrompt(ctx('session.prompt', { sessionId, input: 'Hi' }));
    expect(res).toMatchObject({ ok: false, error: { code: 'ERR_PERMISSION_DENIED' } });
    expect(mocks.harborRequest).not.toHaveBeenCalledWith('llm.chat', expect.anything());
  });
});

describe('creating an explicit session', () => {
  it("sends Harbor the origin's granted tools", async () => {
    await createExplicit({ llm: {}, tools: ['time/now', 'fs/write'] });
    expect(mocks.harborRequest).toHaveBeenCalledWith('session.create', expect.objectContaining({
      origin: ORIGIN,
      allowedTools: ['time/now'],
    }));
  });
});

describe('Harbor returns no session', () => {
  it('refuses to create an explicit session instead of recording one with no ID', async () => {
    mocks.harborRequest.mockImplementation(async () => ({}));
    const res = await handleSessionsCreate(ctx('agent.sessions.create', { capabilities: { llm: {} } }));
    expect(res).toMatchObject({ ok: false, error: { code: 'ERR_INTERNAL', message: 'Harbor did not create a session' } });
  });
});
