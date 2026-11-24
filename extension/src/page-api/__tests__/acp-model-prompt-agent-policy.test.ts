/**
 * `model.prompt.agent` gates every `session/prompt` sent to the person's
 * own ACP agent, through the same `requireAction`/policy-engine path a
 * page's own `llm.chat`/`session.create` calls use (extension-api.ts's
 * `gatePageCall`) — so a denial reaches the rule engine and the audit log,
 * not just Harbor's own `model:prompt` origin-grant store.
 *
 * This drives the real port, real background.ts, real harbor-core.ts
 * (including the real `requireAgentPromptAction`), the real policy engine,
 * rules and audit log. Only the bridge (a fake ACP agent) and the ACP
 * channel plumbing (acpOpenStream/acpSend/acpClose) are stubbed — as
 * acp-backend-selection.test.ts does for agent.run's own cancellation
 * paths.
 *
 * Module setup runs once (`beforeAll`): `requireAgentPromptAction`'s own
 * import of `harbor-core.ts` keeps the real module via `importOriginal`,
 * and a `vi.resetModules()` between tests (as other ACP port tests use)
 * re-runs that factory against a module graph whose real `policy/audit.ts`
 * singleton the test's own later `import('../../policy/audit')` no longer
 * matches — the log reads back empty even though the run just populated
 * it. Resetting state instead of modules between tests avoids that.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent as buildAgentApp, AGENT_METHODS, type StopReason } from '@agentclientprotocol/sdk';
import { resetMockBrowser } from '../../__tests__/test-setup';
import { createFakeAcpBridge } from './support/fake-acp-bridge';

const mocks = vi.hoisted(() => ({
  bridge: { current: null as null | ReturnType<typeof import('./support/fake-acp-bridge').createFakeAcpBridge> },
}));

vi.mock('../harbor-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../harbor-core')>()),
  acpOpenStream: (agentId: string, workspace: string) => mocks.bridge.current!.acpOpenStream(agentId, workspace),
  acpSend: (channel: string, message: unknown) => mocks.bridge.current!.acpSend(channel, message),
  acpClose: (channel: string) => mocks.bridge.current!.acpClose(channel),
}));

const ORIGIN = 'https://example.test';
const AGENT_ID = 'test-agent';

type Listener = (port: unknown) => void;
let onConnect: Listener;

beforeAll(async () => {
  const chromeGlobal = globalThis as unknown as { chrome: Record<string, unknown> };
  chromeGlobal.chrome.runtime = {
    ...(chromeGlobal.chrome.runtime as Record<string, unknown>),
    onConnect: { addListener: (l: Listener) => { onConnect = l; } },
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
  };
  chromeGlobal.chrome.tabs = {
    ...(chromeGlobal.chrome.tabs as Record<string, unknown>),
    onRemoved: { addListener: vi.fn() },
    get: vi.fn(async () => { throw new Error('no tab'); }),
  };

  const { initializePageApi } = await import('../background');
  initializePageApi();
});

beforeEach(async () => {
  resetMockBrowser();
  mocks.bridge.current = createFakeAcpBridge();
});

/**
 * Harbor's own origin-grant store: the pre-existing hasPermission check in
 * background.ts's handleAgentRun passes, so the new policy gate is isolated
 * and tested on its own. Granted *after* `setAgentBackend()`, not before: a
 * `model:prompt`/`model:tools` grant now records which backend it was given
 * for (policy/backend-grant.ts), so granting it under the built-in backend
 * and then switching to the ACP agent would make it stop counting —
 * exactly the behaviour that feature is for, but not what these tests are
 * about.
 */
async function grantPrompting(): Promise<void> {
  const { grantPermissions } = await import('../../policy/permissions');
  await grantPermissions(ORIGIN, ['model:prompt', 'model:tools'], 'granted-always');
}

afterEach(async () => {
  const { Policy } = await import('../../policy/store');
  Policy.__reset();
  const { Audit } = await import('../../policy/audit');
  Audit.clear();
});

type Posted = { id?: string; event?: { type: string; error?: { code?: string; message: string } }; done?: boolean };

function connectPort() {
  const listeners: Array<(m: unknown) => void> = [];
  const posted: Posted[] = [];
  onConnect({
    name: 'harbor-page-api',
    sender: { url: `${ORIGIN}/page`, tab: { id: 9 } },
    onMessage: { addListener: (l: (m: unknown) => void) => listeners.push(l) },
    onDisconnect: { addListener: () => {} },
    postMessage: (m: Posted) => posted.push(m),
  });
  const receive = async (message: unknown) => {
    await Promise.all(listeners.map((l) => l(message)));
  };
  const streamError = async (type: string, payload: unknown) => {
    const id = 'r1';
    await receive({ id, type, payload });
    await vi.waitFor(() => expect(posted.some((p) => p.id === id && p.done)).toBe(true));
    return posted.find((p) => p.id === id && p.done)!.event?.error;
  };
  return { receive, streamError, posted };
}

function registerHappyAgent(onPrompt: (ctx: { params: { sessionId: string } }) => Promise<{ stopReason: StopReason }>) {
  const app = buildAgentApp({ name: 'fake-agent' })
    .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }))
    .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 'sess-1' }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .onRequest(AGENT_METHODS.session_prompt, async (ctx) => onPrompt(ctx as any));
  mocks.bridge.current!.registerAgent(AGENT_ID, app, {});
}

async function setAgentBackend() {
  await chrome.storage.local.set({ harbor_agent_backend: { type: 'acp', agentId: AGENT_ID } });
}

async function denyAgentPrompts() {
  const { Policy } = await import('../../policy/store');
  const { compileRule } = await import('../../policy/rules');
  Policy.__setForTesting([
    compileRule({ id: 'deny-agent-prompt', effect: 'deny', principal: { origin: '*' }, action: 'model.prompt.agent', source: 'user' } as never),
  ]);
}

describe('model.prompt.agent gates agent.run on the ACP backend', () => {
  it.each(['acp', 'builtin'])('%s only checks installed tools when that backend uses them', async (backend) => {
    if (backend === 'acp') await setAgentBackend();
    await grantPrompting();
    const { grantPermissions } = await import('../../policy/permissions');
    await grantPermissions(ORIGIN, ['mcp:tools.list'], 'granted-always');
    const { Policy } = await import('../../policy/store');
    const { compileRule } = await import('../../policy/rules');
    Policy.__setForTesting([
      compileRule({ id: 'deny-installed-tools', effect: 'deny', principal: { origin: '*' }, action: 'tool.list', source: 'user' } as never),
    ]);
    let promptCalled = false;
    registerHappyAgent(async () => { promptCalled = true; return { stopReason: 'end_turn' }; });

    const { receive, posted } = connectPort();
    await receive({ id: 'tools-run', type: 'agent.run', payload: { task: 'hi' } });
    await vi.waitFor(() => expect(posted.some(p => p.done)).toBe(true));
    const terminal = posted.find(p => p.done);
    const { Audit } = await import('../../policy/audit');
    const toolChecks = Audit.query({ origin: ORIGIN, action: 'tool.list' });

    if (backend === 'acp') {
      expect(terminal?.event).toEqual({ type: 'done' });
      expect(promptCalled).toBe(true);
      expect(toolChecks).toEqual([]);
    } else {
      expect(terminal?.event?.error?.code).toBe('ERR_BLOCKED_BY_POLICY');
      expect(promptCalled).toBe(false);
      expect(toolChecks.some(r => r.effect === 'deny')).toBe(true);
    }
  });

  it('denies the run with ERR_PERMISSION_DENIED, without ever sending session/prompt, and records an audit entry for the deny', async () => {
    await setAgentBackend();
    await grantPrompting();
    await denyAgentPrompts();
    let promptCalled = false;
    registerHappyAgent(async () => { promptCalled = true; return { stopReason: 'end_turn' }; });

    const { streamError } = connectPort();
    const error = await streamError('agent.run', { task: 'hi' });

    expect(error?.code).toBe('ERR_PERMISSION_DENIED');
    expect(promptCalled).toBe(false);

    const { Audit } = await import('../../policy/audit');
    const records = Audit.query({ origin: ORIGIN, action: 'model.prompt.agent', effect: 'deny' });
    expect(records.length).toBeGreaterThan(0);
    expect(records[0].errorCode).toBe('ERR_BLOCKED_BY_POLICY');
  });

  it('allows the run through to session/prompt when no rule denies model.prompt.agent', async () => {
    await setAgentBackend();
    await grantPrompting();
    let promptCalled = false;
    registerHappyAgent(async () => { promptCalled = true; return { stopReason: 'end_turn' }; });

    const { receive, posted } = connectPort();
    await receive({ id: 'run-ok', type: 'agent.run', origin: ORIGIN, payload: { task: 'hi' } });
    await vi.waitFor(() => expect(posted.some((p) => p.id === 'run-ok' && p.done)).toBe(true));

    expect(promptCalled).toBe(true);
    const terminal = posted.find((p) => p.id === 'run-ok' && p.done);
    expect(terminal?.event).toEqual({ type: 'done' });

    // The engine's own default for an egress action is `ask`; the site's
    // existing `model:prompt` grant lets it proceed anyway without a second
    // native prompt (gatePageCall's own "origin-grant" upstream-consent
    // deal), recorded as such rather than rewritten to `allow`.
    const { Audit } = await import('../../policy/audit');
    const records = Audit.query({ origin: ORIGIN, action: 'model.prompt.agent' });
    expect(records.some((r) => r.effect !== 'deny' && r.consent === 'origin-grant')).toBe(true);
  });
});

describe('a session-owned flow reaches the ACP prompt boundary', () => {
  it.each(['session.prompt', 'session.promptStreaming'] as const)('preserves label refusal for %s before any agent prompt', async (type) => {
    await setAgentBackend();
    await grantPrompting();
    let promptCalls = 0;
    registerHappyAgent(async () => { promptCalls++; return { stopReason: 'end_turn' }; });
    const { receive, posted } = connectPort();
    await receive({ id: 'flow-create', type: 'agent.sessions.create', payload: { capabilities: { llm: {} } } });
    const created = posted.find(p => p.id === 'flow-create') as unknown as { ok: boolean; result: { sessionId: string } };
    expect(created.ok).toBe(true);
    const sessionId = created.result.sessionId;
    const { SessionRegistry } = await import('../../sessions');
    // Internal synthetic source label. Pages cannot supply this flow state.
    SessionRegistry.getLabelFlow(sessionId, ORIGIN).addPageOutput('https://accounts.google.com');
    await receive({ id: 'flow-prompt', type, payload: { sessionId, input: 'dummy input', labels: [] } });
    const response = posted.find(p => p.id === 'flow-prompt') as unknown as { error?: { code: string }; event?: { error?: { code: string } } };
    expect(response.error?.code ?? response.event?.error?.code).toBe('ERR_LABEL_FLOW_BLOCKED');
    expect(promptCalls).toBe(0);
    const { Audit } = await import('../../policy/audit');
    expect(Audit.query({ origin: ORIGIN, action: 'model.prompt.agent' }).some(r => r.errorCode === 'ERR_LABEL_FLOW_BLOCKED')).toBe(true);
    await receive({ id: 'flow-end', type: 'agent.sessions.terminate', payload: { sessionId } });
  });
});
