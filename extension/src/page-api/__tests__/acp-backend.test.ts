import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent as buildAgentApp, AGENT_METHODS, CLIENT_METHODS, type AgentApp, type StopReason } from '@agentclientprotocol/sdk';

// AcpAgentBackend runs `agent.run` on a user-configured ACP agent, over the
// bridge's acp.open/acp.send/acp.close relay (bridge-rs/README.md "ACP
// agents"). These tests drive it directly (as agent-run-budget.test.ts does
// for builtinAgentBackend) against a fake bridge whose "agent" side is a
// real ACP SDK AgentApp, so the backend speaks genuine ACP JSON-RPC.
// Selection (the stored setting) and cancellation from the page port are
// covered separately, through the real port listener, in
// acp-backend-selection.test.ts.

const mocks = vi.hoisted(() => ({
  hasPermission: vi.fn(),
  bridge: { current: null as null | ReturnType<typeof import('./support/fake-acp-bridge').createFakeAcpBridge> },
}));

vi.mock('../handlers', () => ({ hasPermission: mocks.hasPermission }));
vi.mock('../harbor-core', () => ({
  acpOpenStream: (agentId: string, workspace: string) => mocks.bridge.current!.acpOpenStream(agentId, workspace),
  acpSend: (channel: string, message: unknown) => mocks.bridge.current!.acpSend(channel, message),
  acpClose: (channel: string) => mocks.bridge.current!.acpClose(channel),
}));

import { createFakeAcpBridge } from './support/fake-acp-bridge';
import { AcpAgentBackend, ACP_RUN_TIMEOUT_MS } from '../acp-backend';
import type { AgentRunRequest } from '../agent-backend';
import type { StreamToken } from '../types';

const AGENT_ID = 'test-agent';

interface FakeAgentOptions {
  cwd?: string;
  failToStart?: string;
  onInitialize?: (params: unknown) => void;
  onSessionNew?: (params: unknown) => void;
  onSessionCancel?: (params: unknown) => void;
  onPrompt: (ctx: { params: { sessionId: string; prompt: unknown }; client: { notify: (method: string, params: unknown) => Promise<void>; request: (method: string, params: unknown) => Promise<unknown> } }) => Promise<{ stopReason: StopReason }>;
}

function buildFakeAgent(opts: FakeAgentOptions): AgentApp {
  return buildAgentApp({ name: 'fake-agent' })
    .onRequest(AGENT_METHODS.initialize, async (ctx) => {
      opts.onInitialize?.(ctx.params);
      return { protocolVersion: 1 };
    })
    .onRequest(AGENT_METHODS.session_new, async (ctx) => {
      opts.onSessionNew?.(ctx.params);
      return { sessionId: 'sess-1' };
    })
    .onNotification(AGENT_METHODS.session_cancel, async (ctx) => {
      opts.onSessionCancel?.(ctx.params);
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .onRequest(AGENT_METHODS.session_prompt, async (ctx) => opts.onPrompt(ctx as any));
}

function registerFakeAgent(opts: FakeAgentOptions) {
  const fakeBridge = createFakeAcpBridge();
  mocks.bridge.current = fakeBridge;
  if (opts.failToStart) {
    fakeBridge.registerAgent(AGENT_ID, buildFakeAgent(opts), { failToStart: opts.failToStart });
  } else {
    fakeBridge.registerAgent(AGENT_ID, buildFakeAgent(opts), { cwd: opts.cwd });
  }
  return fakeBridge;
}

function baseRequest(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    origin: 'https://example.test',
    tabId: 1,
    task: 'do the thing',
    maxToolCalls: 5,
    tools: [],
    ...overrides,
  };
}

async function collect(backend: AcpAgentBackend, req: AgentRunRequest, signal = new AbortController().signal): Promise<StreamToken[]> {
  const events: StreamToken[] = [];
  await backend.run(req, (e) => events.push(e), signal);
  return events;
}

function tokenEvents(events: StreamToken[]): Array<{ type: string } & Record<string, unknown>> {
  return events
    .filter((e) => e.type === 'token' && typeof e.token === 'string')
    .map((e) => JSON.parse(e.token as string));
}

beforeEach(() => {
  mocks.hasPermission.mockReset();
  mocks.hasPermission.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AcpAgentBackend', () => {
  it('opens the channel with the run origin as the workspace, and sends cwd from the open event into session/new', async () => {
    let sessionNewCwd: unknown;
    registerFakeAgent({
      cwd: '/custom/workspace',
      onSessionNew: (params) => { sessionNewCwd = (params as { cwd: string }).cwd; },
      onPrompt: async () => ({ stopReason: 'end_turn' }),
    });

    const backend = new AcpAgentBackend(AGENT_ID);
    await collect(backend, baseRequest({ origin: 'https://example.test' }));

    expect(sessionNewCwd).toBe('/custom/workspace');
  });

  it('sends mcpServers: [] and advertises no fs or terminal capabilities', async () => {
    let initParams: unknown;
    registerFakeAgent({
      onInitialize: (params) => { initParams = params; },
      onPrompt: async () => ({ stopReason: 'end_turn' }),
    });

    const backend = new AcpAgentBackend(AGENT_ID);
    await collect(backend, baseRequest());

    expect(initParams).toMatchObject({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
  });

  it('sends mcpServers: [] on session/new', async () => {
    let sessionNewParams: unknown;
    registerFakeAgent({
      onSessionNew: (params) => { sessionNewParams = params; },
      onPrompt: async () => ({ stopReason: 'end_turn' }),
    });
    const backend = new AcpAgentBackend(AGENT_ID);
    await collect(backend, baseRequest());
    expect((sessionNewParams as { mcpServers: unknown[] }).mcpServers).toEqual([]);
  });

  it('sends the task as the user message and the systemPrompt labelled as instructions from the origin', async () => {
    let promptBlocks: Array<{ type: string; text: string }> = [];
    registerFakeAgent({
      onPrompt: async (ctx) => {
        promptBlocks = ctx.params.prompt as typeof promptBlocks;
        return { stopReason: 'end_turn' };
      },
    });

    const backend = new AcpAgentBackend(AGENT_ID);
    await collect(backend, baseRequest({
      origin: 'https://site.example',
      task: 'find the weather',
      systemPrompt: 'Always answer in French.',
    }));

    const texts = promptBlocks.map((b) => b.text);
    expect(texts).toContain('find the weather');
    expect(texts.some((t) => t.includes('Instructions from https://site.example:') && t.includes('Always answer in French.'))).toBe(true);
  });

  it('omits the instructions block when the page sends no systemPrompt', async () => {
    let promptBlocks: Array<{ type: string; text: string }> = [];
    registerFakeAgent({
      onPrompt: async (ctx) => {
        promptBlocks = ctx.params.prompt as typeof promptBlocks;
        return { stopReason: 'end_turn' };
      },
    });
    const backend = new AcpAgentBackend(AGENT_ID);
    await collect(backend, baseRequest({ task: 'hello', systemPrompt: undefined }));
    expect(promptBlocks).toHaveLength(1);
    expect(promptBlocks[0].text).toBe('hello');
  });

  describe('event mapping', () => {
    it('maps agent_thought_chunk to a thinking token event', async () => {
      registerFakeAgent({
        onPrompt: async (ctx) => {
          await ctx.client.notify(CLIENT_METHODS.session_update, {
            sessionId: ctx.params.sessionId,
            update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'pondering...' } },
          });
          return { stopReason: 'end_turn' };
        },
      });
      const backend = new AcpAgentBackend(AGENT_ID);
      const events = tokenEvents(await collect(backend, baseRequest()));
      expect(events).toContainEqual({ type: 'thinking', content: 'pondering...' });
    });

    it('maps tool_call to a tool_call token event using title as the tool name and rawInput as args', async () => {
      registerFakeAgent({
        onPrompt: async (ctx) => {
          await ctx.client.notify(CLIENT_METHODS.session_update, {
            sessionId: ctx.params.sessionId,
            update: {
              sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Read file', kind: 'read',
              rawInput: { path: '/tmp/a.txt' },
            },
          });
          return { stopReason: 'end_turn' };
        },
      });
      const backend = new AcpAgentBackend(AGENT_ID);
      const events = tokenEvents(await collect(backend, baseRequest()));
      expect(events).toContainEqual({ type: 'tool_call', tool: 'Read file', args: { path: '/tmp/a.txt' } });
    });

    it('falls back to kind when a tool_call has no title, and to {} when it has no rawInput', async () => {
      registerFakeAgent({
        onPrompt: async (ctx) => {
          // `title` is a required field on the wire, so an agent that has
          // nothing to say sends it empty rather than omitting it.
          await ctx.client.notify(CLIENT_METHODS.session_update, {
            sessionId: ctx.params.sessionId,
            update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: '', kind: 'execute' },
          });
          return { stopReason: 'end_turn' };
        },
      });
      const backend = new AcpAgentBackend(AGENT_ID);
      const events = tokenEvents(await collect(backend, baseRequest()));
      expect(events).toContainEqual({ type: 'tool_call', tool: 'execute', args: {} });
    });

    it('maps a completed tool_call_update to a tool_result event carrying content', async () => {
      registerFakeAgent({
        onPrompt: async (ctx) => {
          await ctx.client.notify(CLIENT_METHODS.session_update, {
            sessionId: ctx.params.sessionId,
            update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Run tests' },
          });
          await ctx.client.notify(CLIENT_METHODS.session_update, {
            sessionId: ctx.params.sessionId,
            update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'ok' } }] },
          });
          return { stopReason: 'end_turn' };
        },
      });
      const backend = new AcpAgentBackend(AGENT_ID);
      const events = tokenEvents(await collect(backend, baseRequest()));
      expect(events).toContainEqual({
        type: 'tool_result', tool: 'Run tests',
        result: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
      });
    });

    it('maps a failed tool_call_update to a tool_result event, falling back to rawOutput', async () => {
      registerFakeAgent({
        onPrompt: async (ctx) => {
          await ctx.client.notify(CLIENT_METHODS.session_update, {
            sessionId: ctx.params.sessionId,
            update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Run tests' },
          });
          await ctx.client.notify(CLIENT_METHODS.session_update, {
            sessionId: ctx.params.sessionId,
            update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'failed', rawOutput: { exitCode: 1 } },
          });
          return { stopReason: 'end_turn' };
        },
      });
      const backend = new AcpAgentBackend(AGENT_ID);
      const events = tokenEvents(await collect(backend, baseRequest()));
      expect(events).toContainEqual({ type: 'tool_result', tool: 'Run tests', result: { exitCode: 1 } });
    });

    it('does not emit a tool_result for a pending/in_progress tool_call_update', async () => {
      registerFakeAgent({
        onPrompt: async (ctx) => {
          await ctx.client.notify(CLIENT_METHODS.session_update, {
            sessionId: ctx.params.sessionId,
            update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Run tests' },
          });
          await ctx.client.notify(CLIENT_METHODS.session_update, {
            sessionId: ctx.params.sessionId,
            update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'in_progress' },
          });
          return { stopReason: 'end_turn' };
        },
      });
      const backend = new AcpAgentBackend(AGENT_ID);
      const events = tokenEvents(await collect(backend, baseRequest()));
      expect(events.some((e) => e.type === 'tool_result')).toBe(false);
    });

    it('accumulates agent_message_chunk text and emits it once as final on end_turn', async () => {
      registerFakeAgent({
        onPrompt: async (ctx) => {
          await ctx.client.notify(CLIENT_METHODS.session_update, {
            sessionId: ctx.params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } },
          });
          await ctx.client.notify(CLIENT_METHODS.session_update, {
            sessionId: ctx.params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } },
          });
          return { stopReason: 'end_turn' };
        },
      });
      const backend = new AcpAgentBackend(AGENT_ID);
      const events = await collect(backend, baseRequest());
      const finals = tokenEvents(events).filter((e) => e.type === 'final');
      expect(finals).toEqual([{ type: 'final', output: 'Hello world' }]);
      expect(events.at(-1)).toEqual({ type: 'done' });
    });
  });

  describe('stopReason', () => {
    it('refusal becomes a coded ERR_AGENT_REFUSED error', async () => {
      registerFakeAgent({ onPrompt: async () => ({ stopReason: 'refusal' }) });
      const backend = new AcpAgentBackend(AGENT_ID);
      const events = await collect(backend, baseRequest());
      expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'ERR_AGENT_REFUSED' } });
    });

    it('max_tokens becomes a coded ERR_AGENT_LIMIT error', async () => {
      registerFakeAgent({ onPrompt: async () => ({ stopReason: 'max_tokens' }) });
      const backend = new AcpAgentBackend(AGENT_ID);
      const events = await collect(backend, baseRequest());
      expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'ERR_AGENT_LIMIT' } });
    });

    it('max_turn_requests becomes a coded ERR_AGENT_LIMIT error', async () => {
      registerFakeAgent({ onPrompt: async () => ({ stopReason: 'max_turn_requests' }) });
      const backend = new AcpAgentBackend(AGENT_ID);
      const events = await collect(backend, baseRequest());
      expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'ERR_AGENT_LIMIT' } });
    });

    it('end_turn emits the accumulated text as final, then done', async () => {
      registerFakeAgent({
        onPrompt: async (ctx) => {
          await ctx.client.notify(CLIENT_METHODS.session_update, {
            sessionId: ctx.params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done!' } },
          });
          return { stopReason: 'end_turn' };
        },
      });
      const backend = new AcpAgentBackend(AGENT_ID);
      const events = await collect(backend, baseRequest());
      expect(tokenEvents(events)).toContainEqual({ type: 'final', output: 'done!' });
      expect(events.at(-1)).toEqual({ type: 'done' });
    });

    it('a cancelled stopReason Harbor did not ask for ends the run normally, with the accumulated text as final', async () => {
      // Codex reports `cancelled` when a single tool call is rejected, even
      // when nothing in Harbor triggered a cancel.
      registerFakeAgent({
        onPrompt: async (ctx) => {
          await ctx.client.notify(CLIENT_METHODS.session_update, {
            sessionId: ctx.params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial answer' } },
          });
          return { stopReason: 'cancelled' };
        },
      });
      const backend = new AcpAgentBackend(AGENT_ID);
      const events = await collect(backend, baseRequest());
      expect(tokenEvents(events)).toContainEqual({ type: 'final', output: 'partial answer' });
      expect(events.at(-1)).toEqual({ type: 'done' });
    });
  });

  describe('permission requests', () => {
    it('answers with the reject_once option when one is offered', async () => {
      let outcome: unknown;
      registerFakeAgent({
        onPrompt: async (ctx) => {
          outcome = await ctx.client.request(CLIENT_METHODS.session_request_permission, {
            sessionId: ctx.params.sessionId,
            toolCall: { toolCallId: 'tc-1' },
            options: [
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
            ],
          });
          return { stopReason: 'end_turn' };
        },
      });
      const backend = new AcpAgentBackend(AGENT_ID);
      await collect(backend, baseRequest());
      expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } });
    });

    it('answers cancelled when no reject_once option is offered', async () => {
      let outcome: unknown;
      registerFakeAgent({
        onPrompt: async (ctx) => {
          outcome = await ctx.client.request(CLIENT_METHODS.session_request_permission, {
            sessionId: ctx.params.sessionId,
            toolCall: { toolCallId: 'tc-1' },
            options: [
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
            ],
          });
          return { stopReason: 'end_turn' };
        },
      });
      const backend = new AcpAgentBackend(AGENT_ID);
      await collect(backend, baseRequest());
      expect(outcome).toEqual({ outcome: { outcome: 'cancelled' } });
    });
  });

  describe('cancellation', () => {
    it('sends session/cancel and ends with ERR_ABORTED when the page aborts mid-prompt', async () => {
      let cancelled: unknown = null;
      let resolvePrompt: ((r: { stopReason: StopReason }) => void) | null = null;
      registerFakeAgent({
        onSessionCancel: (params) => {
          cancelled = params;
          resolvePrompt?.({ stopReason: 'cancelled' });
        },
        onPrompt: () => new Promise((resolve) => { resolvePrompt = resolve; }),
      });

      const backend = new AcpAgentBackend(AGENT_ID);
      const controller = new AbortController();
      const events: StreamToken[] = [];
      const runPromise = backend.run(baseRequest(), (e) => events.push(e), controller.signal);

      await vi.waitFor(() => expect(resolvePrompt).not.toBeNull());
      controller.abort();
      await runPromise;

      expect(cancelled).toEqual({ sessionId: 'sess-1' });
      expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'ERR_ABORTED' } });
    });

    it('re-checks model:prompt before session/prompt and cancels with ERR_PERMISSION_DENIED when it is gone', async () => {
      mocks.hasPermission.mockResolvedValue(false);
      let promptCalled = false;
      registerFakeAgent({
        onPrompt: async () => { promptCalled = true; return { stopReason: 'end_turn' }; },
      });
      const backend = new AcpAgentBackend(AGENT_ID);
      const events = await collect(backend, baseRequest());
      expect(promptCalled).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'ERR_PERMISSION_DENIED' } });
    });

    it('re-checks model:prompt on every tool_call_update, and cancels with ERR_PERMISSION_DENIED once it is revoked', async () => {
      let resolvePrompt: ((r: { stopReason: StopReason }) => void) | null = null;
      registerFakeAgent({
        onSessionCancel: () => resolvePrompt?.({ stopReason: 'cancelled' }),
        onPrompt: async (ctx) => {
          await ctx.client.notify(CLIENT_METHODS.session_update, {
            sessionId: ctx.params.sessionId,
            update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed', rawOutput: 'secret' },
          });
          return new Promise((resolve) => { resolvePrompt = resolve; });
        },
      });
      mocks.hasPermission.mockResolvedValueOnce(true); // the pre-prompt check
      mocks.hasPermission.mockResolvedValueOnce(false); // the tool_call_update check

      const backend = new AcpAgentBackend(AGENT_ID);
      const events = await collect(backend, baseRequest());

      expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'ERR_PERMISSION_DENIED' } });
      // The revoked grant must stop the result from reaching the page.
      expect(tokenEvents(events).some((e) => e.type === 'tool_result')).toBe(false);
    });

    it('cancels and reports ERR_BUDGET_EXCEEDED once tool_call_update count reaches maxToolCalls', async () => {
      let resolvePrompt: ((r: { stopReason: StopReason }) => void) | null = null;
      registerFakeAgent({
        onSessionCancel: () => resolvePrompt?.({ stopReason: 'cancelled' }),
        onPrompt: async (ctx) => {
          for (let i = 0; i < 3; i++) {
            await ctx.client.notify(CLIENT_METHODS.session_update, {
              sessionId: ctx.params.sessionId,
              update: { sessionUpdate: 'tool_call_update', toolCallId: `tc-${i}`, status: 'completed', rawOutput: i },
            });
          }
          return new Promise((resolve) => { resolvePrompt = resolve; });
        },
      });

      const backend = new AcpAgentBackend(AGENT_ID);
      const events = await collect(backend, baseRequest({ maxToolCalls: 2 }));

      expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'ERR_BUDGET_EXCEEDED' } });
      // Only the first two updates (within budget) may have reached the page.
      expect(tokenEvents(events).filter((e) => e.type === 'tool_result')).toHaveLength(2);
    });

    it('counts a tool call once across its progress updates, but trips the budget on a second distinct call', async () => {
      let resolvePrompt: ((r: { stopReason: StopReason }) => void) | null = null;
      registerFakeAgent({
        onSessionCancel: () => resolvePrompt?.({ stopReason: 'cancelled' }),
        onPrompt: async (ctx) => {
          // Three progress updates then completion, all for the same id —
          // none of this should spend more than one unit of budget.
          for (const status of ['in_progress', 'in_progress', 'in_progress', 'completed'] as const) {
            await ctx.client.notify(CLIENT_METHODS.session_update, {
              sessionId: ctx.params.sessionId,
              update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status },
            });
          }
          // A second, distinct call must trip a budget of 1.
          await ctx.client.notify(CLIENT_METHODS.session_update, {
            sessionId: ctx.params.sessionId,
            update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-2', status: 'completed' },
          });
          return new Promise((resolve) => { resolvePrompt = resolve; });
        },
      });

      const backend = new AcpAgentBackend(AGENT_ID);
      const events = await collect(backend, baseRequest({ maxToolCalls: 1 }));

      // tc-1's own completion reached the page; tc-2's never could.
      expect(tokenEvents(events).filter((e) => e.type === 'tool_result')).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'ERR_BUDGET_EXCEEDED' } });
    });

    it('re-checks model:prompt on a tool_call with no update yet, and cancels with ERR_PERMISSION_DENIED', async () => {
      let resolvePrompt: ((r: { stopReason: StopReason }) => void) | null = null;
      registerFakeAgent({
        onSessionCancel: () => resolvePrompt?.({ stopReason: 'cancelled' }),
        onPrompt: async (ctx) => {
          await ctx.client.notify(CLIENT_METHODS.session_update, {
            sessionId: ctx.params.sessionId,
            update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Read file' },
          });
          return new Promise((resolve) => { resolvePrompt = resolve; });
        },
      });
      mocks.hasPermission.mockResolvedValueOnce(true); // the pre-prompt check
      mocks.hasPermission.mockResolvedValueOnce(false); // the tool_call check

      const backend = new AcpAgentBackend(AGENT_ID);
      const events = await collect(backend, baseRequest());

      expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'ERR_PERMISSION_DENIED' } });
      // The denied call must never reach the page.
      expect(tokenEvents(events).some((e) => e.type === 'tool_call')).toBe(false);
    });

    it('cancels and reports ERR_TIMEOUT once the overall run timeout elapses', async () => {
      vi.useFakeTimers();
      let cancelled = false;
      let resolvePrompt: ((r: { stopReason: StopReason }) => void) | null = null;
      registerFakeAgent({
        onSessionCancel: () => { cancelled = true; resolvePrompt?.({ stopReason: 'cancelled' }); },
        onPrompt: () => new Promise((resolve) => { resolvePrompt = resolve; }),
      });

      const backend = new AcpAgentBackend(AGENT_ID);
      const events: StreamToken[] = [];
      const runPromise = backend.run(baseRequest(), (e) => events.push(e), new AbortController().signal);

      await vi.waitFor(() => expect(resolvePrompt).not.toBeNull(), { timeout: 2000 });
      await vi.advanceTimersByTimeAsync(ACP_RUN_TIMEOUT_MS);
      await runPromise;

      expect(cancelled).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'ERR_TIMEOUT' } });
    });
  });

  describe('transport and agent failures', () => {
    it('reports ERR_AGENT_FAILED when acp.open fails fatally before any channel exists', async () => {
      registerFakeAgent({ failToStart: 'agent binary not found', onPrompt: async () => ({ stopReason: 'end_turn' }) });
      const backend = new AcpAgentBackend(AGENT_ID);
      const events = await collect(backend, baseRequest());
      expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'ERR_AGENT_FAILED' } });
    });

    it('reports ERR_AGENT_FAILED when the agent exits before the prompt resolves', async () => {
      const fakeBridge = createFakeAcpBridge();
      mocks.bridge.current = fakeBridge;
      let channelForTest: string | null = null;
      const app = buildAgentApp({ name: 'fake-agent' })
        .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }))
        .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 'sess-1' }))
        .onRequest(AGENT_METHODS.session_prompt, () => new Promise(() => { /* never resolves; the agent dies instead */ }));
      fakeBridge.registerAgent(AGENT_ID, app, {});

      // Observe the channel id the backend opened, so the test can crash it.
      const realOpen = fakeBridge.acpOpenStream;
      fakeBridge.acpOpenStream = (agentId: string, workspace: string) => {
        const result = realOpen(agentId, workspace);
        const originalNext = result.stream.next.bind(result.stream);
        result.stream.next = (async () => {
          const r = await originalNext();
          if (!r.done && (r.value as { type: string; channel?: string }).type === 'open') {
            channelForTest = (r.value as { channel: string }).channel;
          }
          return r;
        }) as typeof result.stream.next;
        return result;
      };

      const backend = new AcpAgentBackend(AGENT_ID);
      const events: StreamToken[] = [];
      const runPromise = backend.run(baseRequest(), (e) => events.push(e), new AbortController().signal);

      await vi.waitFor(() => expect(channelForTest).not.toBeNull());
      fakeBridge.crashChannel(channelForTest!, 1);
      await runPromise;

      expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'ERR_AGENT_FAILED' } });
    });
  });

  describe('channel lifecycle', () => {
    it('closes the channel after a normal end_turn run', async () => {
      const fakeBridge = registerFakeAgent({ onPrompt: async () => ({ stopReason: 'end_turn' }) });
      const closeSpy = vi.spyOn(fakeBridge, 'acpClose');
      const backend = new AcpAgentBackend(AGENT_ID);
      await collect(backend, baseRequest());
      expect(closeSpy).toHaveBeenCalledTimes(1);
    });

    it('closes the channel when the agent refuses', async () => {
      const fakeBridge = registerFakeAgent({ onPrompt: async () => ({ stopReason: 'refusal' }) });
      const closeSpy = vi.spyOn(fakeBridge, 'acpClose');
      const backend = new AcpAgentBackend(AGENT_ID);
      await collect(backend, baseRequest());
      expect(closeSpy).toHaveBeenCalledTimes(1);
    });

    it('closes the channel when the page aborts', async () => {
      let resolvePrompt: ((r: { stopReason: StopReason }) => void) | null = null;
      const fakeBridge = registerFakeAgent({
        onSessionCancel: () => resolvePrompt?.({ stopReason: 'cancelled' }),
        onPrompt: () => new Promise((resolve) => { resolvePrompt = resolve; }),
      });
      const closeSpy = vi.spyOn(fakeBridge, 'acpClose');
      const backend = new AcpAgentBackend(AGENT_ID);
      const controller = new AbortController();
      const runPromise = backend.run(baseRequest(), () => {}, controller.signal);
      await vi.waitFor(() => expect(resolvePrompt).not.toBeNull());
      controller.abort();
      await runPromise;
      expect(closeSpy).toHaveBeenCalledTimes(1);
    });

    it('does not call acp.close when acp.open never produced a channel', async () => {
      const fakeBridge = registerFakeAgent({ failToStart: 'boom', onPrompt: async () => ({ stopReason: 'end_turn' }) });
      const closeSpy = vi.spyOn(fakeBridge, 'acpClose');
      const backend = new AcpAgentBackend(AGENT_ID);
      await collect(backend, baseRequest());
      expect(closeSpy).not.toHaveBeenCalled();
    });
  });
});
