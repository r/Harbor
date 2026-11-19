import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agent as buildAgentApp, AGENT_METHODS, CLIENT_METHODS, RequestError, type StopReason } from '@agentclientprotocol/sdk';

const mocks = vi.hoisted(() => ({
  hasPermission: vi.fn(),
  bridge: { current: null as any },
  openGate: { current: null as null | Promise<void> },
}));
vi.mock('../handlers', () => ({ hasPermission: mocks.hasPermission }));
vi.mock('../harbor-core', () => ({
  acpOpenStream: (agentId: string, workspace: string) => {
    const inner = mocks.bridge.current!.acpOpenStream(agentId, workspace);
    const gate = mocks.openGate.current;
    if (!gate) return inner;
    let first = true;
    const orig = inner.stream.next.bind(inner.stream);
    inner.stream.next = (async () => { if (first) { first = false; await gate; } return orig(); }) as any;
    return inner;
  },
  acpSend: (c: string, m: unknown) => mocks.bridge.current!.acpSend(c, m),
  acpClose: (c: string) => mocks.bridge.current!.acpClose(c),
}));

import { createFakeAcpBridge } from './support/fake-acp-bridge';
import { AcpAgentBackend, ACP_RUN_TIMEOUT_MS } from '../acp-backend';
import type { StreamToken } from '../types';

const req = { origin: 'https://example.test', tabId: 1, task: 't', maxToolCalls: 5, tools: [] };
const terminals = (ev: StreamToken[]) => ev.filter((e) => e.type === 'done' || e.type === 'error');

beforeEach(() => { mocks.hasPermission.mockReset(); mocks.hasPermission.mockResolvedValue(true); mocks.openGate.current = null; vi.useRealTimers(); });

describe('ACP backend: races, ordering and hostile input', () => {
  it('P1 abort while acp.open is pending stops the run before the prompt', async () => {
    const b = createFakeAcpBridge(); mocks.bridge.current = b;
    let promptCalled = false; let releasePrompt!: (r: { stopReason: StopReason }) => void;
    b.registerAgent('a', buildAgentApp({ name: 'f' })
      .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }))
      .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 's' }))
      .onRequest(AGENT_METHODS.session_prompt, () => { promptCalled = true; return new Promise((r) => { releasePrompt = r; }); }), {});
    let openNow!: () => void; mocks.openGate.current = new Promise((r) => { openNow = r; });
    const closeSpy = vi.spyOn(b, 'acpClose');
    const c = new AbortController(); const ev: StreamToken[] = [];
    const p = new AcpAgentBackend('a').run(req, (e) => ev.push(e), c.signal);
    await new Promise((r) => setTimeout(r, 10));
    c.abort();            // page aborts / tab closes while the agent is still spawning
    openNow();
    const settled = await Promise.race([p.then(() => 'settled'), new Promise((r) => setTimeout(() => r('still-running'), 500))]);
    if (releasePrompt) releasePrompt({ stopReason: 'end_turn' });
    await p;
    expect(promptCalled).toBe(false);
    expect(settled).toBe('settled');
  });

  for (const stage of ['initialize', 'session_new'] as const) {
    it(`P2 abort during ${stage}`, async () => {
      const b = createFakeAcpBridge(); mocks.bridge.current = b;
      let entered!: () => void; const inStage = new Promise<void>((r) => { entered = r; });
      const hang = () => { entered(); return new Promise<never>(() => {}); };
      b.registerAgent('a', buildAgentApp({ name: 'f' })
        .onRequest(AGENT_METHODS.initialize, async () => stage === 'initialize' ? hang() : ({ protocolVersion: 1 }))
        .onRequest(AGENT_METHODS.session_new, async () => stage === 'session_new' ? hang() : ({ sessionId: 's' }))
        .onRequest(AGENT_METHODS.session_prompt, async () => ({ stopReason: 'end_turn' as StopReason })), {});
      const closeSpy = vi.spyOn(b, 'acpClose');
      const c = new AbortController(); const ev: StreamToken[] = [];
      const p = new AcpAgentBackend('a').run(req, (e) => ev.push(e), c.signal);
      await inStage; c.abort(); await p;
      expect(terminals(ev)).toHaveLength(1);
      expect(ev.at(-1)).toMatchObject({ error: { code: 'ERR_ABORTED' } });
      expect(closeSpy).toHaveBeenCalledTimes(1);
    });
  }

  it('P3 timeout and abort together give exactly one terminal', async () => {
    vi.useFakeTimers();
    const b = createFakeAcpBridge(); mocks.bridge.current = b;
    let resolvePrompt: any = null;
    b.registerAgent('a', buildAgentApp({ name: 'f' })
      .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }))
      .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 's' }))
      .onNotification(AGENT_METHODS.session_cancel, async () => { resolvePrompt?.({ stopReason: 'cancelled' }); })
      .onRequest(AGENT_METHODS.session_prompt, () => new Promise((r) => { resolvePrompt = r; })), {});
    const c = new AbortController(); const ev: StreamToken[] = [];
    const p = new AcpAgentBackend('a').run(req, (e) => ev.push(e), c.signal);
    await vi.waitFor(() => expect(resolvePrompt).not.toBeNull(), { timeout: 2000 });
    c.abort();
    await vi.advanceTimersByTimeAsync(ACP_RUN_TIMEOUT_MS);
    await p;
    expect(terminals(ev)).toHaveLength(1);
  });

  it('P4 agent ignores session/cancel and answers end_turn later: one terminal', async () => {
    const b = createFakeAcpBridge(); mocks.bridge.current = b;
    let resolvePrompt: any = null;
    b.registerAgent('a', buildAgentApp({ name: 'f' })
      .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }))
      .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 's' }))
      .onNotification(AGENT_METHODS.session_cancel, async () => { setTimeout(() => resolvePrompt({ stopReason: 'end_turn' }), 20); })
      .onRequest(AGENT_METHODS.session_prompt, () => new Promise((r) => { resolvePrompt = r; })), {});
    const c = new AbortController(); const ev: StreamToken[] = [];
    const p = new AcpAgentBackend('a').run(req, (e) => ev.push(e), c.signal);
    await vi.waitFor(() => expect(resolvePrompt).not.toBeNull());
    c.abort(); await p; await new Promise((r) => setTimeout(r, 60));
    expect(terminals(ev)).toHaveLength(1);
    expect(ev.at(-1)).toMatchObject({ error: { code: 'ERR_ABORTED' } });
  });

  it('P5 hostile updates: huge rawInput, unknown-id update, non-text content, garbage messages', async () => {
    const b = createFakeAcpBridge(); mocks.bridge.current = b;
    b.registerAgent('a', buildAgentApp({ name: 'f' })
      .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }))
      .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 's' }))
      .onRequest(AGENT_METHODS.session_prompt, async (ctx: any) => {
        const n = (u: unknown) => ctx.client.notify(CLIENT_METHODS.session_update, { sessionId: 's', update: u }).catch(() => { /* the run may already be over */ });
        await n({ sessionUpdate: 'tool_call', toolCallId: 'x', title: '<img src=x onerror=alert(1)>', rawInput: { blob: 'A'.repeat(2_000_000) } });
        await n({ sessionUpdate: 'tool_call_update', toolCallId: 'ghost', status: 'completed', content: [{ type: 'content', content: { type: 'image', data: 'AAAA', mimeType: 'image/png' } }] });
        await n({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'AAAA', mimeType: 'image/png' } });
        await n({ sessionUpdate: 'bogus_kind', x: 1 });
        await n({ nope: true });
        await n({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } });
        await new Promise((r) => setTimeout(r, 20));
        return { stopReason: 'end_turn' as StopReason };
      }), {});
    // garbage straight onto the relay
    const origOpen = b.acpOpenStream;
    b.acpOpenStream = (id: string, ws: string) => {
      const r = origOpen(id, ws); const orig = r.stream.next.bind(r.stream); let n = 0;
      r.stream.next = (async () => {
        n++;
        if (n === 2) return { done: false, value: { type: 'message', message: 'not json-rpc' } };
        if (n === 3) return { done: false, value: { type: 'message', message: null } };
        if (n === 4) return { done: false, value: { type: 'message', message: [1, 2] } };
        if (n === 5) return { done: false, value: { type: 'error', message: 'dropped oversized line' } };
        return orig();
      }) as any;
      return r;
    };
    const ev: StreamToken[] = [];
    await new AcpAgentBackend('a').run(req, (e) => ev.push(e), new AbortController().signal);
    expect(terminals(ev)).toHaveLength(1);
    expect(ev.at(-1)).toMatchObject({ type: 'done' });
  });

  it('P6 tool_call notification immediately followed by the prompt response: order', async () => {
    const b = createFakeAcpBridge(); mocks.bridge.current = b;
    mocks.hasPermission.mockImplementation(() => new Promise((r) => setTimeout(() => r(true), 5)));
    b.registerAgent('a', buildAgentApp({ name: 'f' })
      .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }))
      .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 's' }))
      .onRequest(AGENT_METHODS.session_prompt, async (ctx: any) => {
        await ctx.client.notify(CLIENT_METHODS.session_update, { sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'read' } });
        return { stopReason: 'end_turn' as StopReason };
      }), {});
    const ev: StreamToken[] = [];
    await new AcpAgentBackend('a').run(req, (e) => ev.push(e), new AbortController().signal);
    await new Promise((r) => setTimeout(r, 50));
    const order = ev.map((e) => (e.type === 'token' ? JSON.parse(e.token as string).type : e.type));
    expect(order).toEqual(['tool_call', 'final', 'done']);
  });

  const CWD = '/Users/someone/.harbor/acp/workspaces/abc123';
  const promptAgent = (onPrompt: (ctx: any) => Promise<any>) =>
    buildAgentApp({ name: 'f' })
      .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }))
      .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 's' }))
      .onRequest(AGENT_METHODS.session_prompt, onPrompt);

  it('scrubs paths from an agent error message', async () => {
    const b = createFakeAcpBridge(); mocks.bridge.current = b;
    b.registerAgent('a', promptAgent(async () => {
      throw new RequestError(-32603, `cannot read ${CWD}/secret or /Users/someone/.ssh/id_rsa`);
    }), { cwd: CWD });
    const ev: StreamToken[] = [];
    await new AcpAgentBackend('a').run(req, (e) => ev.push(e), new AbortController().signal);
    const all = JSON.stringify(ev);
    expect(all).not.toContain('/Users/someone');
    expect(terminals(ev)).toHaveLength(1);
    expect(terminals(ev)[0]).toMatchObject({ type: 'error', error: { code: 'ERR_AGENT_FAILED' } });
  });

  it('ends the run with an error on an unknown stop reason', async () => {
    const b = createFakeAcpBridge(); mocks.bridge.current = b;
    b.registerAgent('a', promptAgent(async () => ({ stopReason: 'paused' as StopReason })), { cwd: CWD });
    const ev: StreamToken[] = [];
    await new AcpAgentBackend('a').run(req, (e) => ev.push(e), new AbortController().signal);
    expect(terminals(ev)).toHaveLength(1);
    expect(terminals(ev)[0]).toMatchObject({ type: 'error', error: { code: 'ERR_AGENT_FAILED' } });
  });

  it('scrubs paths in object keys and respects path boundaries', async () => {
    const b = createFakeAcpBridge(); mocks.bridge.current = b;
    b.registerAgent('a', promptAgent(async (ctx: any) => {
      await ctx.client.notify(CLIENT_METHODS.session_update, {
        sessionId: 's',
        update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'read', rawInput: { [`${CWD}/key`]: 1 } },
      });
      await ctx.client.notify(CLIENT_METHODS.session_update, {
        sessionId: 's',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'see /Users/someone. and /Users/someoneelse/x' } },
      });
      return { stopReason: 'end_turn' as StopReason };
    }), { cwd: CWD });
    const ev: StreamToken[] = [];
    await new AcpAgentBackend('a').run(req, (e) => ev.push(e), new AbortController().signal);
    const tokens = ev.filter((e) => e.type === 'token').map((e) => JSON.parse(e.token as string));
    const call = tokens.find((t) => t.type === 'tool_call');
    expect(Object.keys(call.args)).toEqual(['./key']);
    const final = tokens.find((t) => t.type === 'final');
    expect(final.output).toBe('see ~. and /Users/someoneelse/x');
  });

  it('scrubs a backslash-separated home path', async () => {
    const WIN = 'C:\\Users\\someone\\.harbor\\acp\\workspaces\\abc123';
    const b = createFakeAcpBridge(); mocks.bridge.current = b;
    b.registerAgent('a', promptAgent(async (ctx: any) => {
      await ctx.client.notify(CLIENT_METHODS.session_update, {
        sessionId: 's',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'home C:\\Users\\someone\\notes and C:\\Users\\someoneelse\\x' } },
      });
      return { stopReason: 'end_turn' as StopReason };
    }), { cwd: WIN });
    const ev: StreamToken[] = [];
    await new AcpAgentBackend('a').run(req, (e) => ev.push(e), new AbortController().signal);
    const final = ev.filter((e) => e.type === 'token').map((e) => JSON.parse(e.token as string)).find((t) => t.type === 'final');
    expect(final.output).toBe('home ~\\notes and C:\\Users\\someoneelse\\x');
  });

  it('keeps both object keys when two scrub to the same string', async () => {
    const b = createFakeAcpBridge(); mocks.bridge.current = b;
    b.registerAgent('a', promptAgent(async (ctx: any) => {
      await ctx.client.notify(CLIENT_METHODS.session_update, {
        sessionId: 's',
        update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'read', rawInput: { '.': 1, [CWD]: 2 } },
      });
      return { stopReason: 'end_turn' as StopReason };
    }), { cwd: CWD });
    const ev: StreamToken[] = [];
    await new AcpAgentBackend('a').run(req, (e) => ev.push(e), new AbortController().signal);
    const call = ev.filter((e) => e.type === 'token').map((e) => JSON.parse(e.token as string)).find((t) => t.type === 'tool_call');
    expect(Object.values(call.args).sort()).toEqual([1, 2]);
    expect(JSON.stringify(call.args)).not.toContain('/Users/someone');
  });

  it('gives the page only a generic message when the agent fails to start', async () => {
    const b = createFakeAcpBridge(); mocks.bridge.current = b;
    const ev: StreamToken[] = [];
    // No agent registered under this id, so the fake bridge reports a fatal error.
    await new AcpAgentBackend('missing').run(req, (e) => ev.push(e), new AbortController().signal);
    expect(terminals(ev)).toHaveLength(1);
    expect(terminals(ev)[0]).toMatchObject({ type: 'error', error: { code: 'ERR_AGENT_FAILED', message: 'The agent failed to start' } });
  });
});
