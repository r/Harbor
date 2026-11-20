import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent as buildAgentApp, AGENT_METHODS, type AgentApp, type StopReason } from '@agentclientprotocol/sdk';

// A maintainer decision: a site may have at most
// PER_SITE_AGENT_LIMIT (2) live ACP agents at once, counting a
// `window.agent.run` while it's running and a `window.ai` text session for
// its whole life together. A createTextSession or agent.run over the cap
// fails with ERR_AGENT_BUSY before acp.open is ever called. The bridge's
// own global 8-agent cap (bridge-rs/src/acp/mod.rs's MAX_LIVE_AGENTS, coded
// "agent_cap" on its fatal error) maps to the same ERR_AGENT_BUSY, worded
// for the bridge's limit instead of the site's. See
// docs/ACP_BACKEND_DESIGN.md sections 2 and 3.
//
// These drive AcpAgentBackend.run() directly (as acp-backend.test.ts does)
// and ai.handleAiCreateTextSession/handleSessionDestroy directly (as
// acp-text-session.test.ts does), against a fake bridge whose "agent" side
// is a real ACP SDK AgentApp, so the two backends' shared accounting is
// exercised through genuine ACP JSON-RPC on both sides.

const mocks = vi.hoisted(() => ({
  hasPermission: vi.fn(),
  getFeatureFlags: vi.fn(),
  readAgentBackendSetting: vi.fn(),
  bridge: { current: null as null | ReturnType<typeof import('./support/fake-acp-bridge').createFakeAcpBridge> },
}));

vi.mock('../handlers', () => ({ hasPermission: mocks.hasPermission }));
vi.mock('../handlers/permission-handlers', async (importOriginal) => ({
  ...(await importOriginal<object>()), hasPermission: mocks.hasPermission,
}));
vi.mock('../harbor-core', () => ({
  harborRequest: vi.fn(async () => ({ bridgeReady: true })),
  acpOpenStream: (agentId: string, workspace: string) => mocks.bridge.current!.acpOpenStream(agentId, workspace),
  acpSend: (channel: string, message: unknown) => mocks.bridge.current!.acpSend(channel, message),
  acpClose: (channel: string) => mocks.bridge.current!.acpClose(channel),
  requireAgentPromptAction: async () => true,
  isModelPromptGrantedForAgent: async () => true,
  // This file is about the per-site agent cap, not site-registered MCP
  // servers — no origin here registered any.
  listSiteServersForAcp: () => [],
}));
vi.mock('../policy/feature-flags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../policy/feature-flags')>()),
  getFeatureFlags: mocks.getFeatureFlags,
}));
vi.mock('../agent-question', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-question')>()),
  askAgentQuestion: vi.fn(),
}));
vi.mock('../agent-backend-setting', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-backend-setting')>()),
  readAgentBackendSetting: mocks.readAgentBackendSetting,
}));

import { createFakeAcpBridge } from './support/fake-acp-bridge';
import { AcpAgentBackend } from '../acp-backend';
import { PER_SITE_AGENT_LIMIT, resetAgentSlotsForTests, liveAgentCountForOrigin } from '../acp-agent-limits';
import { openAcpChannel, type AcpChannelResult } from '../acp-connection';
import type { AgentRunRequest } from '../agent-backend';
import type { StreamToken } from '../types';
import type { AcpBridgeEvent } from '../harbor-core';
import * as ai from '../handlers/ai-handlers';
import type { RequestContext } from '../handlers/types';

const AGENT_ID = 'test-agent';
const ORIGIN = 'https://example.test';

function ctx(type: string, payload: unknown, overrides: Partial<RequestContext> = {}): RequestContext {
  return { id: `req-${type}-${Math.random()}`, type, origin: ORIGIN, tabId: 1, payload, ...overrides } as RequestContext;
}

function baseRunRequest(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return { origin: ORIGIN, tabId: 1, task: 'do a thing', maxToolCalls: 5, tools: [], ...overrides };
}

async function collect(backend: AcpAgentBackend, req: AgentRunRequest, signal: AbortSignal): Promise<StreamToken[]> {
  const events: StreamToken[] = [];
  await backend.run(req, (e) => events.push(e), signal);
  return events;
}

/**
 * A fake agent whose `session/prompt` only resolves once the test calls
 * the matching resolver — so a run's slot stays held for exactly as long
 * as the test wants, and `session/cancel` resolves it with `cancelled`
 * (the same path `AbortController.abort()` on a run's signal drives).
 */
function registerControllableAgent(bridge: ReturnType<typeof createFakeAcpBridge>, agentId = AGENT_ID) {
  const resolvers: Array<(r: { stopReason: StopReason }) => void> = [];
  const app = buildAgentApp({ name: 'fake' })
    .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }))
    .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: `sess-${resolvers.length}` }))
    .onNotification(AGENT_METHODS.session_cancel, async () => { resolvers.shift()?.({ stopReason: 'cancelled' }); })
    .onRequest(AGENT_METHODS.session_prompt, () => new Promise((resolve) => { resolvers.push(resolve); }));
  bridge.registerAgent(agentId, app, {});
}

function registerSimpleAgent(bridge: ReturnType<typeof createFakeAcpBridge>, agentId = AGENT_ID) {
  const app = buildAgentApp({ name: 'fake' })
    .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }))
    .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 'sess-1' }))
    .onNotification(AGENT_METHODS.session_cancel, async () => {})
    .onRequest(AGENT_METHODS.session_prompt, async () => ({ stopReason: 'end_turn' as StopReason }));
  bridge.registerAgent(agentId, app, {});
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.hasPermission.mockResolvedValue(true);
  mocks.readAgentBackendSetting.mockResolvedValue({ type: 'acp', agentId: AGENT_ID });
  const { DEFAULT_FLAGS } = await import('../policy/feature-flag-set');
  mocks.getFeatureFlags.mockResolvedValue(DEFAULT_FLAGS);
  mocks.bridge.current = createFakeAcpBridge();
  resetAgentSlotsForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the per-site agent cap', () => {
  it(`refuses the ${PER_SITE_AGENT_LIMIT + 1}th agent.run for one origin, before acp.open`, async () => {
    const bridge = mocks.bridge.current!;
    registerControllableAgent(bridge);
    const backend = new AcpAgentBackend(AGENT_ID);

    // PER_SITE_AGENT_LIMIT runs started back to back, synchronously: each
    // backend.run() call reserves its slot (acp-agent-limits.ts) before its
    // first await, so by the time the loop below finishes, all of them
    // already hold one.
    const controllers = Array.from({ length: PER_SITE_AGENT_LIMIT }, () => new AbortController());
    const runs = controllers.map((c) => collect(backend, baseRunRequest(), c.signal));
    expect(liveAgentCountForOrigin(ORIGIN)).toBe(PER_SITE_AGENT_LIMIT);

    const overflowEvents = await collect(backend, baseRunRequest(), new AbortController().signal);
    expect(overflowEvents).toEqual([
      { type: 'error', error: { code: 'ERR_AGENT_BUSY', message: `This site already has ${PER_SITE_AGENT_LIMIT} agents running` } },
    ]);
    // Never opened a channel for the refused run.
    expect(bridge.openCalls).toHaveLength(PER_SITE_AGENT_LIMIT);

    // Let each run actually reach session/prompt (initialize/session-new
    // are async) before cancelling, so each one's own abort listener is
    // registered first.
    await new Promise((r) => setTimeout(r, 20));
    controllers.forEach((c) => c.abort());
    await Promise.all(runs);
    expect(liveAgentCountForOrigin(ORIGIN)).toBe(0);
  });

  it("counts an agent.run against the same origin's createTextSession cap, and frees the slot once the run ends", async () => {
    const bridge = mocks.bridge.current!;
    registerControllableAgent(bridge);
    const backend = new AcpAgentBackend(AGENT_ID);

    // One long-running agent.run holds one of the two slots.
    const runController = new AbortController();
    const runPromise = collect(backend, baseRunRequest(), runController.signal);
    expect(liveAgentCountForOrigin(ORIGIN)).toBe(1);

    // One text session fits under the cap (this run + this session = 2).
    const created1 = await ai.handleAiCreateTextSession(ctx('ai.createTextSession', {}));
    expect(created1.ok).toBe(true);
    const sessionId1 = (created1 as { result: string }).result;
    expect(liveAgentCountForOrigin(ORIGIN)).toBe(2);

    // A second text session — which would be a 3rd agent — is refused
    // before acp.open.
    const openCallsBefore = bridge.openCalls.length;
    const created2 = await ai.handleAiCreateTextSession(ctx('ai.createTextSession', {}));
    expect(created2).toMatchObject({
      ok: false,
      error: { code: 'ERR_AGENT_BUSY', message: `This site already has ${PER_SITE_AGENT_LIMIT} agents running` },
    });
    expect(bridge.openCalls).toHaveLength(openCallsBefore);

    // Ending the run frees its slot; a new text session now succeeds.
    runController.abort();
    await runPromise;
    expect(liveAgentCountForOrigin(ORIGIN)).toBe(1);

    const created3 = await ai.handleAiCreateTextSession(ctx('ai.createTextSession', {}));
    expect(created3.ok).toBe(true);
    const sessionId3 = (created3 as { result: string }).result;
    expect(liveAgentCountForOrigin(ORIGIN)).toBe(2);

    await ai.handleSessionDestroy(ctx('session.destroy', { sessionId: sessionId1 }));
    await ai.handleSessionDestroy(ctx('session.destroy', { sessionId: sessionId3 }));
    expect(liveAgentCountForOrigin(ORIGIN)).toBe(0);
  });

  it('frees a text session\'s slot when the tab (or port) that opened it goes away, not only on an explicit destroy', async () => {
    registerSimpleAgent(mocks.bridge.current!);
    const created = await ai.handleAiCreateTextSession(ctx('ai.createTextSession', {}, { tabId: 42 }));
    expect(created.ok).toBe(true);
    expect(liveAgentCountForOrigin(ORIGIN)).toBe(1);

    const { cleanupAcpTextSessionsForTab } = await import('../acp-text-session');
    await cleanupAcpTextSessionsForTab(42, () => {});

    expect(liveAgentCountForOrigin(ORIGIN)).toBe(0);
  });

  it('frees the slot when open() itself fails (never counts a session that never actually started)', async () => {
    const bridge = mocks.bridge.current!;
    const app = buildAgentApp({ name: 'fake' })
      .onRequest(AGENT_METHODS.initialize, async () => { throw new Error('boom'); })
      .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 's' }));
    bridge.registerAgent(AGENT_ID, app, {});

    const created = await ai.handleAiCreateTextSession(ctx('ai.createTextSession', {}));
    expect(created).toMatchObject({ ok: false, error: { code: 'ERR_AGENT_FAILED' } });
    expect(liveAgentCountForOrigin(ORIGIN)).toBe(0);
  });

  it('is scoped per origin: a different site has its own two slots', async () => {
    registerControllableAgent(mocks.bridge.current!);
    const backend = new AcpAgentBackend(AGENT_ID);
    const controllers = Array.from({ length: PER_SITE_AGENT_LIMIT }, () => new AbortController());
    const runs = controllers.map((c) => collect(backend, baseRunRequest(), c.signal));
    expect(liveAgentCountForOrigin(ORIGIN)).toBe(PER_SITE_AGENT_LIMIT);

    const other = await ai.handleAiCreateTextSession(ctx('ai.createTextSession', {}, { origin: 'https://other.test' }));
    expect(other.ok).toBe(true);
    expect(liveAgentCountForOrigin('https://other.test')).toBe(1);

    controllers.forEach((c) => c.abort());
    await Promise.all(runs);
    await ai.handleSessionDestroy(ctx('session.destroy', { sessionId: (other as { result: string }).result }, { origin: 'https://other.test' }));
  });
});

describe("the bridge's global agent cap maps to the same coded error", () => {
  it('maps a fatal "agent_cap" error to ERR_AGENT_BUSY, worded for the bridge\'s own limit', async () => {
    async function* events(): AsyncGenerator<AcpBridgeEvent> {
      yield { type: 'error', fatal: true, code: 'agent_cap', message: 'too many open agents (limit 8)' };
    }
    const result: AcpChannelResult = await openAcpChannel(events(), () => false, () => {});
    expect(result).toEqual({
      kind: 'failed',
      error: { type: 'error', error: { code: 'ERR_AGENT_BUSY', message: 'Too many agents are running' } },
    });
  });

  it('still maps an uncoded fatal error to the generic ERR_AGENT_FAILED', async () => {
    async function* events(): AsyncGenerator<AcpBridgeEvent> {
      yield { type: 'error', fatal: true, message: 'failed to start agent: no such file or directory' };
    }
    const result: AcpChannelResult = await openAcpChannel(events(), () => false, () => {});
    expect(result).toEqual({
      kind: 'failed',
      error: { type: 'error', error: { code: 'ERR_AGENT_FAILED', message: 'The agent failed to start' } },
    });
  });
});
