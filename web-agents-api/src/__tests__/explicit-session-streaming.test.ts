import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// HBR-13: session.promptStreaming on explicit sessions, through the real
// background port listener. Adapted from the independent verifier's tests.

const mocks = vi.hoisted(() => ({
  harborRequest: vi.fn(), harborStreamRequest: vi.fn(), hasPermission: vi.fn(), getPermissions: vi.fn(),
}));
vi.mock('../harbor-client', () => ({
  harborRequest: mocks.harborRequest, harborStreamRequest: mocks.harborStreamRequest,
  discoverHarbor: async () => null, setHarborExtensionId: vi.fn(), getHarborState: () => ({ connected: true }),
}));
vi.mock('../policy/feature-flags', () => ({ getFeatureFlags: async () => ({ toolCalling: true }) }));
vi.mock('../handlers/permission-handlers', () => ({ hasPermission: mocks.hasPermission, getPermissions: mocks.getPermissions }));
vi.mock('../handlers', async () => {
  const ai = await vi.importActual<typeof import('../handlers/ai-handlers')>('../handlers/ai-handlers');
  return {
    routeMessage: vi.fn(), isStreamingMessage: vi.fn(), hasPermission: mocks.hasPermission,
    getPermissions: mocks.getPermissions, listAllPermissions: vi.fn(),
    revokeOriginPermissions: vi.fn(), resolvePromptClosed: vi.fn(),
    handlePermissionPromptResponse: vi.fn(), resolveTextSession: ai.resolveTextSession,
    recordExplicitPrompt: ai.recordExplicitPrompt,
    restoreSpawnedTabs: vi.fn(), handleTabRemoved: vi.fn(), getAllSpawnedTabs: vi.fn(),
    isSpawnedTab: vi.fn(), handleIncomingInvocation: vi.fn(), resolveInvocationResponse: vi.fn(),
    cleanupAgentsForTab: vi.fn(), agentInvocationTabs: new Map(),
  };
});

const ORIGIN = 'https://example.test';
let counter = 0;
let harbor: Map<string, { origin: string; hasLLM: boolean; terminated?: boolean }>;
let receive: (m: unknown) => Promise<void>;
let postMessage: ReturnType<typeof vi.fn>;
let sessions: typeof import('../handlers/session-handlers');
let ai: typeof import('../handlers/ai-handlers');

beforeEach(() => {
  vi.clearAllMocks();
  postMessage?.mockClear();
  harbor = new Map();
  mocks.hasPermission.mockResolvedValue(true);
  mocks.getPermissions.mockResolvedValue({ scopes: {}, allowedTools: [] });
  mocks.harborRequest.mockImplementation(async (method: string, p: Record<string, any>) => {
    if (method === 'session.create') {
      const id = `h-${++counter}`;
      harbor.set(id, { origin: p.origin, hasLLM: !!p.options.capabilities.llm });
      return { sessionId: id, capabilities: {} };
    }
    if (method === 'session.get') {
      const s = harbor.get(p.sessionId);
      if (!s || s.terminated) throw new Error('Session not found');
      if (s.origin !== p.origin) throw new Error('Session belongs to different origin');
      return { session: { capabilities: { hasLLM: s.hasLLM, toolCount: 0, hasBrowserAccess: false } } };
    }
    if (method === 'session.recordUsage') return {};
    if (method === 'session.terminate') { const s = harbor.get(p.sessionId); if (s) s.terminated = true; return { terminated: !!s }; }
    throw new Error('unexpected ' + method);
  });
  mocks.harborStreamRequest.mockImplementation(() => ({
    stream: (async function* () { yield { type: 'token', token: 'Hel' }; yield { type: 'token', token: 'lo' }; yield { type: 'done' }; })(),
    cancel: vi.fn(),
  }));
});
beforeAll(async () => {
  const event = () => ({ addListener: vi.fn() });
  const onConnect = event();
  vi.stubGlobal('chrome', { tabs: { onRemoved: event() }, windows: { onRemoved: event() },
    runtime: { onConnect, onMessage: event(), onMessageExternal: event() } });
  await import('../background');
  // Same module instances as background's resolveTextSession (after resetModules)
  sessions = await import('../handlers/session-handlers');
  ai = await import('../handlers/ai-handlers');
  postMessage = vi.fn();
  onConnect.addListener.mock.calls[0][0]({ name: 'web-agent-transport', sender: { tab: { id: 1 } }, postMessage,
    onMessage: { addListener: (l: typeof receive) => { receive = l; } } });
});
afterAll(() => vi.unstubAllGlobals());

const ctx = (type: string, payload: unknown, origin = ORIGIN) => ({ id: 'r', type, origin, payload } as never);
async function create(capabilities: Record<string, unknown> = { llm: { model: 'm' } }) {
  const r = await sessions.handleSessionsCreate(ctx('agent.sessions.create', { capabilities, options: { systemPrompt: 'S' } })) as any;
  return r.result.sessionId as string;
}
async function stream(sessionId: string, origin = ORIGIN) {
  await receive({ id: 'st', type: 'session.promptStreaming', origin, payload: { sessionId, input: 'Hi' } });
  return postMessage.mock.calls.map((c) => c[0]);
}
const errCode = (evs: any[]) => evs.at(-1)?.event?.error?.code;

describe('promptStreaming on explicit sessions', () => {
  it('streams from the creating origin', async () => {
    const id = await create();
    const evs = await stream(id);
    expect(evs.map((e: any) => e.event.type)).toEqual(['token', 'token', 'done']);
    expect(mocks.harborStreamRequest).toHaveBeenCalledWith('llm.chatStream', expect.objectContaining({
      messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'Hi' }], model: 'm' }));
  });
  it('refuses another origin without reaching the model', async () => {
    const id = await create();
    expect(errCode(await stream(id, 'https://evil.test'))).toBe('ERR_PERMISSION_DENIED');
    expect(mocks.harborStreamRequest).not.toHaveBeenCalled();
  });
  it('refuses a terminated session', async () => {
    const id = await create();
    await sessions.handleSessionsTerminate(ctx('agent.sessions.terminate', { sessionId: id }));
    expect(errCode(await stream(id))).toBe('ERR_SESSION_NOT_FOUND');
    expect(mocks.harborStreamRequest).not.toHaveBeenCalled();
  });
  it('refuses a session Harbor dropped behind the WAA', async () => {
    const id = await create();
    harbor.delete(id);
    expect(errCode(await stream(id))).toBe('ERR_SESSION_NOT_FOUND');
    expect(mocks.harborStreamRequest).not.toHaveBeenCalled();
  });
  it('refuses a session without llm', async () => {
    const id = await create({ tools: ['a/b'] });
    expect(errCode(await stream(id))).toBe('ERR_PERMISSION_DENIED');
    expect(mocks.harborStreamRequest).not.toHaveBeenCalled();
  });
  it('implicit sessions still stream without a Harbor session lookup', async () => {
    const r = await ai.handleAiCreateTextSession(ctx('ai.createTextSession', { systemPrompt: 'X' })) as any;
    const evs = await stream(r.result);
    expect(evs.at(-1).event.type).toBe('done');
    expect(mocks.harborRequest).not.toHaveBeenCalledWith('session.get', expect.anything());
    // other origin still refused for implicit
    postMessage.mockClear();
    expect(errCode(await stream(r.result, 'https://evil.test'))).toBe('ERR_PERMISSION_DENIED');
  });
  it('ignores session.destroy from another origin', async () => {
    const id = await create();
    await ai.handleSessionDestroy(ctx('session.destroy', { sessionId: id }, 'https://evil.test'));
    expect(await stream(id)).toEqual(expect.arrayContaining([expect.objectContaining({ event: { type: 'done' } })]));
  });
  it('keeps the session when Harbor briefly cannot answer', async () => {
    const id = await create();
    const real = mocks.harborRequest.getMockImplementation()!;
    mocks.harborRequest.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Harbor extension not found. Please install Harbor.'), { code: 'ERR_HARBOR_NOT_FOUND' });
    });
    expect(errCode(await stream(id))).toBe('ERR_HARBOR_NOT_FOUND');
    expect(mocks.harborStreamRequest).not.toHaveBeenCalled();
    mocks.harborRequest.mockImplementation(real);
    postMessage.mockClear();
    expect((await stream(id)).at(-1).event.type).toBe('done');
  });
  it('tells Harbor about the prompt once the stream is done', async () => {
    const id = await create();
    await stream(id);
    expect(mocks.harborRequest).toHaveBeenCalledWith('session.recordUsage', {
      sessionId: id, type: 'prompt', detail: { userMessage: 'Hi', assistantMessage: 'Hello' },
    });
  });
});
