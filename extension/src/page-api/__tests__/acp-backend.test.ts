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
  askAgentQuestion: vi.fn(),
  bridge: { current: null as null | ReturnType<typeof import('./support/fake-acp-bridge').createFakeAcpBridge> },
}));

vi.mock('../handlers', () => ({ hasPermission: mocks.hasPermission }));
vi.mock('../harbor-core', () => ({
  siteToolsForAgent: vi.fn(async () => []),
  openPageToolEndpointForAcp: vi.fn(async () => null), closePageToolEndpoint: vi.fn(async () => {}),
  syncPageTools: vi.fn(), resolvePageToolResult: vi.fn(), forgetPageToolsForConnection: vi.fn(), forgetPageToolsInTab: vi.fn(),
  pageToolsForAgent: vi.fn(async () => null),
  acpOpenStream: (agentId: string, workspace: string) => mocks.bridge.current!.acpOpenStream(agentId, workspace),
  acpSend: (channel: string, message: unknown) => mocks.bridge.current!.acpSend(channel, message),
  acpClose: (channel: string) => mocks.bridge.current!.acpClose(channel),
  // The model.prompt.agent policy gate itself is covered, driven through
  // the real port and the real policy engine, in
  // acp-model-prompt-agent-policy.test.ts; here it's a pass-through so
  // these tests keep exercising everything else unchanged.
  requireAgentPromptAction: async () => true,
}));
// The dialog itself (the popup window, its message validation, the
// liveness timeout, window-closed handling) is covered on its own, without
// a fake agent, in agent-question.test.ts. Here the whole module is mocked
// at this seam so these tests can drive what it resolves with — and when —
// and check only that AcpAgentBackend wires it correctly: the exact request
// it's handed, the signal that cancels it, and the outcome it sends back to
// the agent unchanged.
vi.mock('../agent-question', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-question')>()),
  askAgentQuestion: mocks.askAgentQuestion,
}));

import { createFakeAcpBridge } from './support/fake-acp-bridge';
import { AcpAgentBackend, ACP_RUN_TIMEOUT_MS, answerPermissionRequest, combineAbortSignals } from '../acp-backend';
import { AGENT_QUESTION_TIMEOUT_MS } from '../agent-question';
import type { AgentRunRequest } from '../agent-backend';
import type { StreamToken } from '../types';

const AGENT_ID = 'test-agent';

interface FakeAgentOptions {
  cwd?: string;
  failToStart?: string;
  onInitialize?: (params: unknown) => void;
  /**
   * Overrides the `initialize` response, e.g. to simulate a protocol
   * mismatch, or to advertise `mcpCapabilities` for the site-registered
   * MCP server tests below.
   */
  initializeResponse?: { protocolVersion: number; agentCapabilities?: { mcpCapabilities?: { http?: boolean; sse?: boolean } } };
  onSessionNew?: (params: unknown) => void;
  onSessionCancel?: (params: unknown) => void;
  onPrompt: (ctx: { params: { sessionId: string; prompt: unknown }; client: { notify: (method: string, params: unknown) => Promise<void>; request: (method: string, params: unknown, options?: { cancellationSignal?: AbortSignal; stopWaitingOnCancel?: boolean }) => Promise<unknown> } }) => Promise<{ stopReason: StopReason }>;
}

function buildFakeAgent(opts: FakeAgentOptions): AgentApp {
  return buildAgentApp({ name: 'fake-agent' })
    .onRequest(AGENT_METHODS.initialize, async (ctx) => {
      opts.onInitialize?.(ctx.params);
      return opts.initializeResponse ?? { protocolVersion: 1 };
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
  mocks.askAgentQuestion.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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

  it('sends mcpServers: [] on session/new when the origin/tab has no site-registered servers', async () => {
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

  it('sends provenance _meta on session/prompt, for an agent that reads it instead of the labelled text', async () => {
    let promptMeta: unknown;
    registerFakeAgent({
      onPrompt: async (ctx) => {
        promptMeta = (ctx.params as { _meta?: unknown })._meta;
        return { stopReason: 'end_turn' };
      },
    });

    const backend = new AcpAgentBackend(AGENT_ID);
    await collect(backend, baseRequest({ origin: 'https://site.example', task: 't' }));

    expect(promptMeta).toEqual({
      'harbor/provenance': { source: 'website', origin: 'https://site.example' },
    });
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
    // Harbor's own framing, then the task: no site-instructions block.
    expect(promptBlocks).toHaveLength(2);
    expect(promptBlocks[0].text).toMatch(/working for the person/i);
    expect(promptBlocks.some((b) => b.text.startsWith('Instructions from'))).toBe(false);
    expect(promptBlocks[1].text).toBe('hello');
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
          await ctx.client.notify(CLIENT_METHODS.session_update, {
            sessionId: ctx.params.sessionId,
            update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed' },
          });
          return { stopReason: 'end_turn' };
        },
      });
      const backend = new AcpAgentBackend(AGENT_ID);
      const events = tokenEvents(await collect(backend, baseRequest()));
      expect(events).toContainEqual({ type: 'tool_call', tool: 'execute', args: {} });
    });

    it.each([undefined, {}])('announces one call when pending input %j arrives in a later update', async (rawInput) => {
      registerFakeAgent({
        onPrompt: async (ctx) => {
          const sessionId = ctx.params.sessionId;
          const toolCallId = 'echo-1';
          await ctx.client.notify(CLIENT_METHODS.session_update, {
            sessionId, update: { sessionUpdate: 'tool_call', toolCallId, title: 'Echo', status: 'pending', rawInput },
          });
          await ctx.client.notify(CLIENT_METHODS.session_update, {
            sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId, rawInput: { text: 'hello' } },
          });
          await ctx.client.notify(CLIENT_METHODS.session_update, {
            sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', rawOutput: 'hello' },
          });
          return { stopReason: 'end_turn' };
        },
      });
      const events = tokenEvents(await collect(new AcpAgentBackend(AGENT_ID), baseRequest()));
      expect(events.filter(event => event.type === 'tool_call' || event.type === 'tool_result')).toEqual([
        { type: 'tool_call', tool: 'Echo', args: { text: 'hello' } },
        { type: 'tool_result', tool: 'Echo', result: 'hello' },
      ]);
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

  describe('permission requests: relayed to askAgentQuestion, the agent gets its answer back unchanged', () => {
    /** Spies on chrome.windows so these tests can assert a real window opened and closed, even though askAgentQuestion itself is mocked: the mock performs the window calls itself, standing in for the real module's behaviour, while this suite drives *what* it resolves with and *when*. */
    function mockDialogWithWindow() {
      const createSpy = vi.spyOn(chrome.windows, 'create');
      const removeSpy = vi.spyOn(chrome.windows, 'remove');
      let settle: ((outcome: unknown) => void) | null = null;
      mocks.askAgentQuestion.mockImplementation(async (_request: unknown, signal: AbortSignal) => {
        if (signal.aborted) return { outcome: 'cancelled' }; // matches the real module: never opens a window for an already-aborted signal
        const win = await chrome.windows.create({ url: 'chrome-extension://harbor-test/agent-question.html?id=test' }) as { id: number };
        return new Promise((resolve) => {
          const onAbort = () => { settle = null; chrome.windows.remove(win.id); resolve({ outcome: 'cancelled' }); };
          signal.addEventListener('abort', onAbort);
          settle = (outcome) => {
            signal.removeEventListener('abort', onAbort);
            chrome.windows.remove(win.id);
            resolve(outcome);
          };
        });
      });
      return { createSpy, removeSpy, answerWith: (outcome: unknown) => settle?.(outcome) };
    }

    it('passes the origin, agent id, tool call and options through unchanged, in the agent’s own order', async () => {
      const { answerWith } = mockDialogWithWindow();
      registerFakeAgent({
        onPrompt: async (ctx) => {
          void ctx.client.request(CLIENT_METHODS.session_request_permission, {
            sessionId: ctx.params.sessionId,
            toolCall: {
              toolCallId: 'tc-1', title: 'Delete file', kind: 'delete',
              rawInput: { path: '/tmp/a.txt' }, locations: [{ path: '/tmp/a.txt', line: 3 }],
            },
            options: [
              { optionId: 'always', name: 'Always Allow', kind: 'allow_always' },
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
            ],
          });
          await vi.waitFor(() => expect(mocks.askAgentQuestion).toHaveBeenCalled());
          answerWith({ outcome: 'selected', optionId: 'allow' });
          return { stopReason: 'end_turn' };
        },
      });
      const backend = new AcpAgentBackend(AGENT_ID);
      await collect(backend, baseRequest({ origin: 'https://site.example' }));

      expect(mocks.askAgentQuestion).toHaveBeenCalledTimes(1);
      const [request] = mocks.askAgentQuestion.mock.calls[0];
      expect(request).toEqual({
        origin: 'https://site.example',
        agentName: AGENT_ID,
        toolCall: { title: 'Delete file', kind: 'delete', rawInput: { path: '/tmp/a.txt' }, locations: [{ path: '/tmp/a.txt', line: 3 }] },
        options: [
          { optionId: 'always', name: 'Always Allow', kind: 'allow_always' },
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      });
    });

    it('opens a window for the question, and sends the person’s selected option back to the agent unchanged, closing the window', async () => {
      const { createSpy, removeSpy, answerWith } = mockDialogWithWindow();
      let outcome: unknown;
      registerFakeAgent({
        onPrompt: async (ctx) => {
          const resultPromise = ctx.client.request(CLIENT_METHODS.session_request_permission, {
            sessionId: ctx.params.sessionId,
            toolCall: { toolCallId: 'tc-1', title: 'Run command' },
            options: [
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
            ],
          });
          await vi.waitFor(() => expect(createSpy).toHaveBeenCalled());
          expect(removeSpy).not.toHaveBeenCalled();
          answerWith({ outcome: 'selected', optionId: 'reject' });
          outcome = await resultPromise;
          return { stopReason: 'end_turn' };
        },
      });
      const backend = new AcpAgentBackend(AGENT_ID);
      await collect(backend, baseRequest());

      expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } });
      expect(removeSpy).toHaveBeenCalledTimes(1);
    });

    it('a cancelled outcome from the dialog (window closed, or the agent offered no reject option) is sent back unchanged', async () => {
      const { answerWith } = mockDialogWithWindow();
      let outcome: unknown;
      registerFakeAgent({
        onPrompt: async (ctx) => {
          const resultPromise = ctx.client.request(CLIENT_METHODS.session_request_permission, {
            sessionId: ctx.params.sessionId,
            toolCall: { toolCallId: 'tc-1', title: 'Run command' },
            options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
          });
          await vi.waitFor(() => expect(mocks.askAgentQuestion).toHaveBeenCalled());
          answerWith({ outcome: 'cancelled' });
          outcome = await resultPromise;
          return { stopReason: 'end_turn' };
        },
      });
      const backend = new AcpAgentBackend(AGENT_ID);
      await collect(backend, baseRequest());
      expect(outcome).toEqual({ outcome: { outcome: 'cancelled' } });
    });

    it('passes the run’s own cancellation signal to the dialog, which answers cancelled and closes its window once the run is cancelled while the question is open', async () => {
      // A live round trip for this is impractical to engineer
      // deterministically: aborting also tears down the ACP connection
      // itself (the same `requestAbort.abort()` that cancels the dialog's
      // signal also stops the backend waiting on `session/prompt`'s
      // response), so whether the agent's `session_request_permission`
      // call ever observes a reply is a race, not a contract. What *is*
      // guaranteed, and what this asserts: the backend hands the dialog
      // the exact signal that its own cancellation fires, so the dialog
      // (the mock standing in for it here) answers and closes its window
      // without needing anything else from the backend.
      const { removeSpy } = mockDialogWithWindow();
      registerFakeAgent({
        onPrompt: async (ctx) => {
          void ctx.client.request(CLIENT_METHODS.session_request_permission, {
            sessionId: ctx.params.sessionId,
            toolCall: { toolCallId: 'tc-1', title: 'Run command' },
            options: [{ optionId: 'reject', name: 'Reject', kind: 'reject_once' }],
          }).catch(() => { /* the connection tearing down on abort may reject this; not what's under test */ });
          await vi.waitFor(() => expect(mocks.askAgentQuestion).toHaveBeenCalled());
          return new Promise(() => { /* the run's own abort ends this turn, not a response here */ });
        },
      });
      const backend = new AcpAgentBackend(AGENT_ID);
      const controller = new AbortController();
      const events: StreamToken[] = [];
      const runPromise = backend.run(baseRequest(), (e) => events.push(e), controller.signal);

      await vi.waitFor(() => expect(mocks.askAgentQuestion).toHaveBeenCalled());
      const [, dialogSignal] = mocks.askAgentQuestion.mock.calls[0];
      controller.abort();
      await runPromise;

      expect(dialogSignal.aborted).toBe(true);
      await vi.waitFor(() => expect(removeSpy).toHaveBeenCalledTimes(1));
      expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'ERR_ABORTED' } });
    });

    it('a dialog that takes a while to resolve (its own liveness timeout) does not trip the run’s own 10-minute timeout', async () => {
      vi.useFakeTimers();
      mocks.askAgentQuestion.mockImplementation(() => new Promise((resolve) => {
        setTimeout(() => resolve({ outcome: 'selected', optionId: 'reject' }), AGENT_QUESTION_TIMEOUT_MS);
      }));
      let outcome: unknown;
      registerFakeAgent({
        onPrompt: async (ctx) => {
          outcome = await ctx.client.request(CLIENT_METHODS.session_request_permission, {
            sessionId: ctx.params.sessionId,
            toolCall: { toolCallId: 'tc-1', title: 'Run command' },
            options: [{ optionId: 'reject', name: 'Reject', kind: 'reject_once' }],
          });
          return { stopReason: 'end_turn' };
        },
      });
      const backend = new AcpAgentBackend(AGENT_ID);
      const events: StreamToken[] = [];
      const runPromise = backend.run(baseRequest(), (e) => events.push(e), new AbortController().signal);

      await vi.waitFor(() => expect(mocks.askAgentQuestion).toHaveBeenCalled(), { timeout: 2000 });
      await vi.advanceTimersByTimeAsync(AGENT_QUESTION_TIMEOUT_MS);
      await runPromise;

      expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } });
      expect(events.at(-1)).toEqual({ type: 'done' }); // not ERR_TIMEOUT: the dialog answered well within 10 minutes
    });

    describe('closing the dialog when the run ends for reasons other than Harbor’s own cancellation', () => {
      // Bug this guards against: the dialog used to get only `requestAbort.signal`
      // (Harbor's own cancellation — page abort, revoked grant, the run's own
      // timeout). The agent's own `session/request_permission` is answered by
      // *Harbor*, so none of those three fire just because the agent's run
      // ends on its own: end_turn with the question still open, the agent
      // erroring out of session/prompt, or the agent withdrawing the request
      // with `$/cancel_request`. Without also combining in `ctx.signal` (the
      // SDK's per-request signal, aborted on `$/cancel_request` or the
      // connection closing) and the run's own terminal event, the window used
      // to stay open — answering nothing — for up to the 5-minute liveness
      // timeout.

      it('end_turn while the question is still open closes the dialog (cancelled)', async () => {
        const { removeSpy } = mockDialogWithWindow();
        let resolvePrompt: ((r: { stopReason: StopReason }) => void) | null = null;
        let outcome: unknown;
        registerFakeAgent({
          onPrompt: async (ctx) => {
            ctx.client.request(CLIENT_METHODS.session_request_permission, {
              sessionId: ctx.params.sessionId,
              toolCall: { toolCallId: 'tc-1', title: 'Run command' },
              options: [{ optionId: 'reject', name: 'Reject', kind: 'reject_once' }],
            }).then((r) => { outcome = r; }).catch(() => { /* not expected here */ });
            return new Promise((resolve) => { resolvePrompt = resolve; });
          },
        });
        const backend = new AcpAgentBackend(AGENT_ID);
        const events: StreamToken[] = [];
        const runPromise = backend.run(baseRequest(), (e) => events.push(e), new AbortController().signal);

        await vi.waitFor(() => expect(mocks.askAgentQuestion).toHaveBeenCalled());
        resolvePrompt!({ stopReason: 'end_turn' });
        await runPromise;

        await vi.waitFor(() => expect(removeSpy).toHaveBeenCalledTimes(1));
        expect(outcome).toEqual({ outcome: { outcome: 'cancelled' } });
        expect(events.at(-1)).toEqual({ type: 'done' });
      });

      it('the agent erroring out of session/prompt while the question is still open closes the dialog (cancelled)', async () => {
        const { removeSpy } = mockDialogWithWindow();
        let rejectPrompt: ((e: Error) => void) | null = null;
        registerFakeAgent({
          onPrompt: async (ctx) => {
            void ctx.client.request(CLIENT_METHODS.session_request_permission, {
              sessionId: ctx.params.sessionId,
              toolCall: { toolCallId: 'tc-1', title: 'Run command' },
              options: [{ optionId: 'reject', name: 'Reject', kind: 'reject_once' }],
            }).catch(() => { /* the connection tearing down may reject this; not what's under test */ });
            return new Promise((_resolve, reject) => { rejectPrompt = reject; });
          },
        });
        const backend = new AcpAgentBackend(AGENT_ID);
        const events: StreamToken[] = [];
        const runPromise = backend.run(baseRequest(), (e) => events.push(e), new AbortController().signal);

        await vi.waitFor(() => expect(mocks.askAgentQuestion).toHaveBeenCalled());
        rejectPrompt!(new Error('agent crashed'));
        await runPromise;

        await vi.waitFor(() => expect(removeSpy).toHaveBeenCalledTimes(1));
        expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'ERR_AGENT_FAILED' } });
      });

      it('the agent withdrawing its own request ($/cancel_request) while session/prompt is still pending closes the dialog, via ctx.signal specifically', async () => {
        // Isolates ctx.signal: session/prompt itself never resolves in this
        // test, so neither `requestAbort` (Harbor's own cancellation) nor
        // `runEnded` (the run's terminal event) ever fires — only the SDK's
        // per-request signal does, from the agent's own `$/cancel_request`.
        const { removeSpy } = mockDialogWithWindow();
        let outcome: unknown;
        registerFakeAgent({
          onPrompt: async (ctx) => {
            const withdrawn = new AbortController();
            ctx.client.request(CLIENT_METHODS.session_request_permission, {
              sessionId: ctx.params.sessionId,
              toolCall: { toolCallId: 'tc-1', title: 'Run command' },
              options: [{ optionId: 'reject', name: 'Reject', kind: 'reject_once' }],
            }, { cancellationSignal: withdrawn.signal }).then((r) => { outcome = r; }).catch((e) => { outcome = e; });
            await vi.waitFor(() => expect(mocks.askAgentQuestion).toHaveBeenCalled());
            withdrawn.abort(); // the agent withdraws its own permission request
            return new Promise(() => { /* session/prompt itself stays pending */ });
          },
        });
        const backend = new AcpAgentBackend(AGENT_ID);
        const controller = new AbortController();
        const runPromise = backend.run(baseRequest(), () => {}, controller.signal);

        await vi.waitFor(() => expect(removeSpy).toHaveBeenCalledTimes(1));
        expect(outcome).toEqual({ outcome: { outcome: 'cancelled' } });

        controller.abort(); // session/prompt never resolves on its own in this test; clean up
        await runPromise;
      });

      it('a request_permission that arrives once the run is already terminal gets a combined signal that is already aborted, so the dialog never opens a window', async () => {
        // A live round trip that reliably lands a request *after* Harbor's
        // side has already marked the run terminal is impractical to
        // engineer deterministically: both the prompt's own response and
        // any further message from the agent travel the same async
        // pipeline, so there's no ordering guarantee to hang a test on (as
        // with the pre-existing "already cancelled" case below). What *is*
        // guaranteed, and what this tests directly: `combineAbortSignals`
        // produces an already-aborted signal the instant any input already
        // is (see the describe block below) — which is exactly the state
        // `runEnded.signal` is in once the run is terminal — and
        // `askAgentQuestion` never opens a window for an already-aborted
        // signal (see agent-question.test.ts). Composed, a handler built
        // after the terminal event can only ever answer `cancelled` without
        // a dialog, whatever mock is standing in for askAgentQuestion here.
        const { createSpy } = mockDialogWithWindow();
        const alreadyAborted = new AbortController();
        alreadyAborted.abort();
        const combined = combineAbortSignals([new AbortController().signal, alreadyAborted.signal]);
        expect(combined.aborted).toBe(true);

        await expect(answerPermissionRequest(() => false, {
          origin: 'https://example.test', agentName: 'test-agent',
          toolCall: { title: 'Run command' },
          options: [{ optionId: 'reject', name: 'Reject', kind: 'reject_once' }],
        }, combined)).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
        expect(createSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe('combineAbortSignals', () => {
    it('does not abort while none of the inputs have', () => {
      const a = new AbortController();
      const b = new AbortController();
      expect(combineAbortSignals([a.signal, b.signal]).aborted).toBe(false);
    });

    it('aborts once any one input aborts, using the platform AbortSignal.any when available', () => {
      const a = new AbortController();
      const b = new AbortController();
      const combined = combineAbortSignals([a.signal, b.signal]);
      b.abort();
      expect(combined.aborted).toBe(true);
    });

    it('is already aborted when any input already is, without waiting for a later event', () => {
      const a = new AbortController();
      const alreadyAborted = new AbortController();
      alreadyAborted.abort();
      expect(combineAbortSignals([a.signal, alreadyAborted.signal]).aborted).toBe(true);
    });

    describe('the manual fallback (AbortSignal.any unavailable)', () => {
      let realAny: typeof AbortSignal.any;
      beforeEach(() => {
        realAny = AbortSignal.any;
        // @ts-expect-error - simulating a target without AbortSignal.any
        delete AbortSignal.any;
      });
      afterEach(() => {
        AbortSignal.any = realAny;
      });

      it('does not abort while none of the inputs have', () => {
        const a = new AbortController();
        const b = new AbortController();
        expect(combineAbortSignals([a.signal, b.signal]).aborted).toBe(false);
      });

      it('aborts once any one input aborts', () => {
        const a = new AbortController();
        const b = new AbortController();
        const combined = combineAbortSignals([a.signal, b.signal]);
        b.abort();
        expect(combined.aborted).toBe(true);
      });

      it('is already aborted when any input already is', () => {
        const a = new AbortController();
        const alreadyAborted = new AbortController();
        alreadyAborted.abort();
        expect(combineAbortSignals([a.signal, alreadyAborted.signal]).aborted).toBe(true);
      });
    });
  });

  // A live round trip for "cancelled already, what does a permission
  // request get" is impractical to engineer deterministically: by the
  // time `cancelReason` is set, the connection is already tearing down
  // (the same `requestAbort.abort()` that sets it also rejects the
  // in-flight session/prompt wait), so a request sent after that point
  // either races the teardown or just hangs. `answerPermissionRequest` is
  // the guard itself, pulled out so it's testable without that race.
  describe('answerPermissionRequest (the session/request_permission guard)', () => {
    const request = {
      origin: 'https://example.test',
      agentName: 'test-agent',
      toolCall: { title: 'Run command' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    };

    it('answers cancelled once the run is already cancelled, and never opens the dialog at all', async () => {
      const signal = new AbortController().signal;
      await expect(answerPermissionRequest(() => true, request, signal)).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
      expect(mocks.askAgentQuestion).not.toHaveBeenCalled();
    });

    it('relays the dialog’s outcome unchanged when the run is not cancelled', async () => {
      mocks.askAgentQuestion.mockResolvedValue({ outcome: 'selected', optionId: 'allow' });
      const signal = new AbortController().signal;
      await expect(answerPermissionRequest(() => false, request, signal)).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
      expect(mocks.askAgentQuestion).toHaveBeenCalledWith(request, signal);
    });

    it('relays a cancelled outcome from the dialog unchanged too', async () => {
      mocks.askAgentQuestion.mockResolvedValue({ outcome: 'cancelled' });
      await expect(answerPermissionRequest(() => false, request, new AbortController().signal))
        .resolves.toEqual({ outcome: { outcome: 'cancelled' } });
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
      // Scope-aware, not a positional mockResolvedValueOnce queue: the
      // site-servers grant/policy check (siteServersAllowedForAcp) also
      // calls hasPermission, for mcp:tools.list/call, before the
      // pre-prompt model:prompt check this test cares about — a queue
      // keyed only by call order would answer the wrong check.
      let modelPromptGranted = true;
      mocks.hasPermission.mockImplementation(async (_origin: string, scope: string) => scope !== 'model:prompt' || modelPromptGranted);
      registerFakeAgent({
        onSessionCancel: () => resolvePrompt?.({ stopReason: 'cancelled' }),
        onPrompt: async (ctx) => {
          modelPromptGranted = false; // revoked once the agent starts working, before its first update
          await ctx.client.notify(CLIENT_METHODS.session_update, {
            sessionId: ctx.params.sessionId,
            update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed', rawOutput: 'secret' },
          });
          return new Promise((resolve) => { resolvePrompt = resolve; });
        },
      });

      const backend = new AcpAgentBackend(AGENT_ID);
      const events = await collect(backend, baseRequest());

      expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'ERR_PERMISSION_DENIED' } });
      // The revoked grant must stop the result from reaching the page.
      expect(tokenEvents(events).some((e) => e.type === 'tool_result')).toBe(false);
    });

    it('ignores maxToolCalls entirely: many distinct tool calls never trip a budget error', async () => {
      // Harbor gates whether a site may use the agent at all; it doesn't
      // constrain how the agent works once it's running. The page's
      // maxToolCalls is a builtinAgentBackend concept and does nothing here.
      registerFakeAgent({
        onPrompt: async (ctx) => {
          for (let i = 0; i < 10; i++) {
            await ctx.client.notify(CLIENT_METHODS.session_update, {
              sessionId: ctx.params.sessionId,
              update: { sessionUpdate: 'tool_call_update', toolCallId: `tc-${i}`, status: 'completed', rawOutput: i },
            });
          }
          return { stopReason: 'end_turn' };
        },
      });

      const backend = new AcpAgentBackend(AGENT_ID);
      const events = await collect(backend, baseRequest({ maxToolCalls: 1 }));

      expect(tokenEvents(events).filter((e) => e.type === 'tool_result')).toHaveLength(10);
      expect(events.at(-1)).toEqual({ type: 'done' });
    });

    it('re-checks model:prompt on a tool_call with no update yet, and cancels with ERR_PERMISSION_DENIED', async () => {
      let resolvePrompt: ((r: { stopReason: StopReason }) => void) | null = null;
      // Scope-aware, not a positional mockResolvedValueOnce queue — see
      // the comment on the equivalent tool_call_update test above.
      let modelPromptGranted = true;
      mocks.hasPermission.mockImplementation(async (_origin: string, scope: string) => scope !== 'model:prompt' || modelPromptGranted);
      registerFakeAgent({
        onSessionCancel: () => resolvePrompt?.({ stopReason: 'cancelled' }),
        onPrompt: async (ctx) => {
          modelPromptGranted = false;
          await ctx.client.notify(CLIENT_METHODS.session_update, {
            sessionId: ctx.params.sessionId,
            update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Read file' },
          });
          return new Promise((resolve) => { resolvePrompt = resolve; });
        },
      });

      const backend = new AcpAgentBackend(AGENT_ID);
      const events = await collect(backend, baseRequest());

      expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'ERR_PERMISSION_DENIED' } });
      expect(tokenEvents(events).some((e) => e.type === 'tool_call')).toBe(false);
      expect(tokenEvents(events).some((e) => e.type === 'tool_result')).toBe(false);
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
    it('reports ERR_AGENT_FAILED and closes the channel when initialize answers an unsupported protocolVersion', async () => {
      let promptCalled = false;
      const fakeBridge = registerFakeAgent({
        initializeResponse: { protocolVersion: 2 },
        onPrompt: async () => { promptCalled = true; return { stopReason: 'end_turn' }; },
      });
      const closeSpy = vi.spyOn(fakeBridge, 'acpClose');
      const backend = new AcpAgentBackend(AGENT_ID);
      const events = await collect(backend, baseRequest());
      expect(promptCalled).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'ERR_AGENT_FAILED' } });
      expect(closeSpy).toHaveBeenCalledTimes(1);
    });

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

  describe('an abort that lands before acp.open resolves', () => {
    it('ends with exactly one ERR_ABORTED once the open event arrives, closes the channel, and never sends initialize or a prompt', async () => {
      const fakeBridge = createFakeAcpBridge();
      mocks.bridge.current = fakeBridge;
      let initializeCalled = false;
      let promptCalled = false;
      const app = buildAgentApp({ name: 'fake-agent' })
        .onRequest(AGENT_METHODS.initialize, async () => { initializeCalled = true; return { protocolVersion: 1 }; })
        .onRequest(AGENT_METHODS.session_new, async () => ({ sessionId: 'sess-1' }))
        .onRequest(AGENT_METHODS.session_prompt, async () => { promptCalled = true; return { stopReason: 'end_turn' as StopReason }; });
      fakeBridge.registerAgent(AGENT_ID, app, {});
      const closeSpy = vi.spyOn(fakeBridge, 'acpClose');

      // Delay the bridge's first event (`open`) so the abort can land
      // while `acp.open` is still pending, before any channel exists yet.
      const realOpen = fakeBridge.acpOpenStream;
      let releaseOpen!: () => void;
      const openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
      fakeBridge.acpOpenStream = (agentId: string, workspace: string) => {
        const result = realOpen(agentId, workspace);
        const originalNext = result.stream.next.bind(result.stream);
        let first = true;
        result.stream.next = (async () => {
          if (first) { first = false; await openGate; }
          return originalNext();
        }) as typeof result.stream.next;
        return result;
      };

      const backend = new AcpAgentBackend(AGENT_ID);
      const events: StreamToken[] = [];
      const controller = new AbortController();
      const runPromise = backend.run(baseRequest(), (e) => events.push(e), controller.signal);

      await new Promise((r) => setTimeout(r, 10));
      controller.abort();
      releaseOpen();
      await runPromise;

      expect(initializeCalled).toBe(false);
      expect(promptCalled).toBe(false);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'error', error: { code: 'ERR_ABORTED' } });
      expect(closeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('event ordering and the terminal event', () => {
    it('emits tool_call before awaiting the grant re-check, matching the agent’s own order', async () => {
      // hasPermission is also called for mcp:tools.list/call
      // (siteServersAllowedForAcp) and once more for model:prompt before
      // session/prompt is even sent (unrelated to this tool_call); only
      // the tool_call's own model:prompt re-check — its *second*
      // model:prompt call — counts here.
      const order: string[] = [];
      let modelPromptCalls = 0;
      mocks.hasPermission.mockImplementation(async (_origin: string, scope: string) => {
        if (scope === 'model:prompt') {
          modelPromptCalls++;
          if (modelPromptCalls === 2) order.push('grant-checked');
        }
        return true;
      });
      registerFakeAgent({
        onPrompt: async (ctx) => {
          await ctx.client.notify(CLIENT_METHODS.session_update, {
            sessionId: ctx.params.sessionId,
            update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Read file', rawInput: {} },
          });
          return { stopReason: 'end_turn' };
        },
      });
      const backend = new AcpAgentBackend(AGENT_ID);
      await backend.run(baseRequest(), (e) => {
        if (e.type === 'token' && typeof e.token === 'string' && JSON.parse(e.token).type === 'tool_call') {
          order.push('tool_call');
        }
      }, new AbortController().signal);
      expect(order).toEqual(['tool_call', 'grant-checked']);
    });

    it('drops every emit after the terminal event, even from a notification handler still awaiting a grant check', async () => {
      // hasPermission is also called for mcp:tools.list/call
      // (siteServersAllowedForAcp), resolved normally — unrelated to this
      // test. The pre-prompt model:prompt check (the first *model:prompt*
      // call) resolves normally too; the tool_call_update's own re-check
      // (the second model:prompt call) hangs until the test releases it —
      // long after session/prompt's response (and the final/done it
      // produces) has already arrived.
      let releaseGate!: (value: boolean) => void;
      let modelPromptCalls = 0;
      mocks.hasPermission.mockImplementation((_origin: string, scope: string) => {
        if (scope !== 'model:prompt') return Promise.resolve(true);
        modelPromptCalls++;
        if (modelPromptCalls === 1) return Promise.resolve(true);
        return new Promise((resolve) => { releaseGate = resolve; });
      });
      registerFakeAgent({
        onPrompt: async (ctx) => {
          // Fire-and-forget: the agent doesn't wait for this notification
          // to be processed before answering the prompt.
          void ctx.client.notify(CLIENT_METHODS.session_update, {
            sessionId: ctx.params.sessionId,
            update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed', rawOutput: 'late' },
          });
          return { stopReason: 'end_turn' };
        },
      });
      const backend = new AcpAgentBackend(AGENT_ID);
      const events: StreamToken[] = [];
      let terminalSeen = false;
      const runPromise = backend.run(baseRequest(), (e) => {
        events.push(e);
        if (e.type === 'done' || e.type === 'error') terminalSeen = true;
      }, new AbortController().signal);

      // The run already ended with exactly one terminal event, while the
      // tool_call_update handler is still awaiting its grant check...
      await vi.waitFor(() => expect(terminalSeen).toBe(true));
      expect(events.at(-1)).toEqual({ type: 'done' });
      expect(events.filter((e) => e.type === 'done' || e.type === 'error')).toHaveLength(1);

      // ...and the slow grant check's eventual answer no longer matters:
      // releasing it now must not add a late tool_result after the fact.
      releaseGate(true);
      await runPromise;
      await new Promise((r) => setTimeout(r, 10));
      expect(tokenEvents(events).some((e) => e.type === 'tool_result')).toBe(false);
    });
  });

  describe('scrubbing the working directory and home path from page-visible content', () => {
    const CWD = '/Users/testuser/.harbor/acp/workspaces/abc123hash';
    const HOME = '/Users/testuser';

    it('replaces the cwd with "." and the home prefix with "~", including inside nested tool args/results', async () => {
      registerFakeAgent({
        cwd: CWD,
        onPrompt: async (ctx) => {
          await ctx.client.notify(CLIENT_METHODS.session_update, {
            sessionId: ctx.params.sessionId,
            update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: `looking in ${CWD}` } },
          });
          await ctx.client.notify(CLIENT_METHODS.session_update, {
            sessionId: ctx.params.sessionId,
            update: {
              sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Read file',
              rawInput: { path: `${CWD}/notes.txt`, nested: { other: `${HOME}/Desktop/x` } },
            },
          });
          await ctx.client.notify(CLIENT_METHODS.session_update, {
            sessionId: ctx.params.sessionId,
            update: {
              sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed',
              content: [{ type: 'content', content: { type: 'text', text: `found it in ${CWD}, home is ${HOME}` } }],
            },
          });
          await ctx.client.notify(CLIENT_METHODS.session_update, {
            sessionId: ctx.params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `done, see ${CWD}/notes.txt` } },
          });
          return { stopReason: 'end_turn' };
        },
      });

      const backend = new AcpAgentBackend(AGENT_ID);
      const events = tokenEvents(await collect(backend, baseRequest()));

      expect(events).toContainEqual({ type: 'thinking', content: 'looking in .' });
      expect(events).toContainEqual({
        type: 'tool_call', tool: 'Read file',
        args: { path: './notes.txt', nested: { other: '~/Desktop/x' } },
      });
      expect(events).toContainEqual({
        type: 'tool_result', tool: 'Read file',
        result: [{ type: 'content', content: { type: 'text', text: 'found it in ., home is ~' } }],
      });
      expect(events).toContainEqual({ type: 'final', output: 'done, see ./notes.txt' });
    });

    it('also scrubs the non-canonical /var alias of a canonicalized /private/var cwd', async () => {
      const privateCwd = '/private/var/folders/XX/T/x/.harbor/acp/workspaces/hash2';
      const varAlias = '/var/folders/XX/T/x/.harbor/acp/workspaces/hash2';
      const homeAlias = '/var/folders/XX/T/x';
      registerFakeAgent({
        cwd: privateCwd,
        onPrompt: async (ctx) => {
          await ctx.client.notify(CLIENT_METHODS.session_update, {
            sessionId: ctx.params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${varAlias} and ${homeAlias}/x.txt` } },
          });
          return { stopReason: 'end_turn' };
        },
      });
      const backend = new AcpAgentBackend(AGENT_ID);
      const events = tokenEvents(await collect(backend, baseRequest()));
      expect(events).toContainEqual({ type: 'final', output: '. and ~/x.txt' });
    });
  });

  describe('acp.open workspace', () => {
    it('passes the run origin as the workspace', async () => {
      const fakeBridge = registerFakeAgent({ onPrompt: async () => ({ stopReason: 'end_turn' }) });
      const backend = new AcpAgentBackend(AGENT_ID);
      await collect(backend, baseRequest({ origin: 'https://site.example' }));
      expect(fakeBridge.openCalls).toEqual([{ agentId: AGENT_ID, workspace: 'https://site.example' }]);
    });
  });
});
