/**
 * The "Check" flow for a configured ACP agent: `acp.open` with a fixed
 * check workspace, `initialize`, then `acp.close` — never `session/new`,
 * since checking an agent isn't running a turn on it. This must never
 * touch the per-site agent cap (acp-agent-limits.ts): it isn't a site's
 * agent, it's the person checking their own setup from the sidebar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent as buildAgentApp, AGENT_METHODS, RequestError } from '@agentclientprotocol/sdk';

const mocks = vi.hoisted(() => ({
  bridge: { current: null as null | ReturnType<typeof import('../../page-api/__tests__/support/fake-acp-bridge').createFakeAcpBridge> },
}));
vi.mock('../../page-api/harbor-core', () => ({
  acpOpenStream: (agentId: string, workspace: string) => mocks.bridge.current!.acpOpenStream(agentId, workspace),
  acpSend: (channel: string, message: unknown) => mocks.bridge.current!.acpSend(channel, message),
  acpClose: (channel: string) => mocks.bridge.current!.acpClose(channel),
}));

import { createFakeAcpBridge } from '../../page-api/__tests__/support/fake-acp-bridge';
import {
  AGENT_CHECK_WORKSPACE,
  checkAcpAgent,
  classifyAgentOpenError,
  formatAgentCheckSuccess,
  formatAgentCheckSpawnFailure,
  resetAcpAgentChecksForTests,
} from '../acp-agent-check';
import { liveAgentCountForOrigin, resetAgentSlotsForTests, tryAcquireAgentSlot } from '../../page-api/acp-agent-limits';

const AGENT_ID = 'goose';

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  resetAgentSlotsForTests();
  resetAcpAgentChecksForTests();
  mocks.bridge.current = createFakeAcpBridge();
});

describe('formatAgentCheckSuccess', () => {
  it('reports the agent\'s own reported name and version when the agent sends one', () => {
    expect(formatAgentCheckSuccess('goose', { name: 'goose', version: '1.2.3' })).toBe('Ready (goose v1.2.3)');
  });

  it('falls back to the configured name when the agent reports no agentInfo', () => {
    expect(formatAgentCheckSuccess('goose', undefined)).toBe('Ready (goose)');
  });
});

describe('formatAgentCheckSpawnFailure', () => {
  it('names the command and tells the person to set the full path', () => {
    expect(formatAgentCheckSpawnFailure('npx')).toBe('Command not found: npx. Set the full path.');
  });
});

describe('classifyAgentOpenError: "Command not found" only for an actual spawn ENOENT', () => {
  it('maps an ENOENT message to the spawn-failure wording', () => {
    expect(classifyAgentOpenError('spawn npx ENOENT', 'npx', AGENT_ID)).toBe('Command not found: npx. Set the full path.');
  });

  it('gives an unknown-agent error its own plain message, not "Command not found"', () => {
    expect(classifyAgentOpenError(`unknown agent: ${AGENT_ID}`, 'npx', AGENT_ID))
      .toBe(`Unknown agent: ${AGENT_ID}. Save it before checking it.`);
  });

  it('gives a permission error its own plain message, not "Command not found"', () => {
    expect(classifyAgentOpenError('spawn npx EACCES', 'npx', AGENT_ID)).toBe('Permission denied running npx.');
    expect(classifyAgentOpenError('permission denied', 'npx', AGENT_ID)).toBe('Permission denied running npx.');
  });

  it('falls back to a plain message carrying the raw reason for anything else', () => {
    expect(classifyAgentOpenError('agent binary crashed on startup', 'npx', AGENT_ID))
      .toBe('Could not start npx: agent binary crashed on startup');
  });

  // The real Rust bridge's own wording (bridge-rs), recorded verbatim —
  // it never says "ENOENT"/"EACCES" on their own.
  describe('against the real bridge\'s own wording', () => {
    it('maps "failed to start agent: No such file or directory (os error 2)" to the spawn-failure wording', () => {
      expect(classifyAgentOpenError('failed to start agent: No such file or directory (os error 2)', 'npx', AGENT_ID))
        .toBe('Command not found: npx. Set the full path.');
    });

    it('maps "failed to start agent: Permission denied (os error 13)" to the permission wording', () => {
      expect(classifyAgentOpenError('failed to start agent: Permission denied (os error 13)', 'npx', AGENT_ID))
        .toBe('Permission denied running npx.');
    });
  });
});

describe('checkAcpAgent', () => {
  it('opens with the fixed check workspace, runs initialize, and reports Ready with the agent\'s name and version', async () => {
    const app = buildAgentApp({ name: 'fake-agent' })
      .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1, agentInfo: { name: 'goose', version: '9.9.9' } }));
    mocks.bridge.current!.registerAgent(AGENT_ID, app, {});

    const result = await checkAcpAgent(AGENT_ID, 'goose', 'goose');

    expect(result).toEqual({ ok: true, message: 'Ready (goose v9.9.9)' });
    expect(mocks.bridge.current!.openCalls).toEqual([{ agentId: AGENT_ID, workspace: AGENT_CHECK_WORKSPACE }]);
  });

  it('never calls session/new', async () => {
    let sessionNewCalled = false;
    const app = buildAgentApp({ name: 'fake-agent' })
      .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }))
      .onRequest(AGENT_METHODS.session_new, async () => { sessionNewCalled = true; return { sessionId: 'sess-1' }; });
    mocks.bridge.current!.registerAgent(AGENT_ID, app, {});

    await checkAcpAgent(AGENT_ID, 'goose', 'goose');
    expect(sessionNewCalled).toBe(false);
  });

  it('closes the channel after a successful check', async () => {
    const app = buildAgentApp({ name: 'fake-agent' })
      .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }));
    mocks.bridge.current!.registerAgent(AGENT_ID, app, {});
    const closeSpy = vi.spyOn(mocks.bridge.current!, 'acpClose');

    await checkAcpAgent(AGENT_ID, 'goose', 'goose');
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('reports a spawn failure as "Command not found", using the configured command', async () => {
    mocks.bridge.current!.registerAgent(AGENT_ID, buildAgentApp({ name: 'x' }), { failToStart: 'spawn npx ENOENT' });

    const result = await checkAcpAgent(AGENT_ID, 'goose', 'npx');

    expect(result).toEqual({ ok: false, error: 'Command not found: npx. Set the full path.' });
  });

  it('reports an unknown agent (acp.open never configured for this id) with its own message, not "Command not found"', async () => {
    // registerAgent was never called for AGENT_ID, so the fake bridge's own
    // "unknown agent" fatal error is what acp.open reports.
    const result = await checkAcpAgent(AGENT_ID, 'goose', 'goose');
    expect(result).toEqual({ ok: false, error: `Unknown agent: ${AGENT_ID}. Save it before checking it.` });
  });

  it('reports the bridge\'s own global-cap error distinctly from a spawn failure', async () => {
    // registerAgent has no direct way to produce a coded "agent_cap" fatal
    // error, so this drives the bridge's acpOpenStream wrapper directly.
    const realOpen = mocks.bridge.current!.acpOpenStream;
    mocks.bridge.current!.acpOpenStream = () => ({
      stream: (async function* () {
        yield { type: 'error' as const, fatal: true, code: 'agent_cap', message: 'too many' };
      })(),
      cancel: () => {},
    });
    const result = await checkAcpAgent(AGENT_ID, 'goose', 'goose');
    expect(result).toEqual({ ok: false, error: 'Too many agents are running' });
    mocks.bridge.current!.acpOpenStream = realOpen;
  });

  it('surfaces the protocol error unchanged when the handshake itself fails', async () => {
    const app = buildAgentApp({ name: 'fake-agent' })
      .onRequest(AGENT_METHODS.initialize, async () => { throw RequestError.invalidParams(undefined, 'unsupported capability'); });
    mocks.bridge.current!.registerAgent(AGENT_ID, app, {});

    const result = await checkAcpAgent(AGENT_ID, 'goose', 'goose');
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('unsupported capability');
  });

  it('reports an unsupported protocol version', async () => {
    const app = buildAgentApp({ name: 'fake-agent' })
      .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 2 }));
    mocks.bridge.current!.registerAgent(AGENT_ID, app, {});

    const result = await checkAcpAgent(AGENT_ID, 'goose', 'goose');
    expect(result.ok).toBe(false);
  });

  it('does not touch any site\'s per-site agent cap: running the check twice never trips it', async () => {
    const origin = 'https://example.test';
    // Fill the site's own cap entirely with its own (unrelated) agents.
    expect(tryAcquireAgentSlot(origin)).toBe(true);
    expect(tryAcquireAgentSlot(origin)).toBe(true);
    expect(liveAgentCountForOrigin(origin)).toBe(2);

    const app = buildAgentApp({ name: 'fake-agent' })
      .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }));
    mocks.bridge.current!.registerAgent(AGENT_ID, app, {});

    await checkAcpAgent(AGENT_ID, 'goose', 'goose');
    await checkAcpAgent(AGENT_ID, 'goose', 'goose');

    // The site's own slots are untouched by two unrelated checks.
    expect(liveAgentCountForOrigin(origin)).toBe(2);
  });

  describe('the overall timeout', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('settles with the timeout message and closes the agent exactly once when initialize hangs', async () => {
      const app = buildAgentApp({ name: 'fake-agent' })
        .onRequest(AGENT_METHODS.initialize, () => new Promise(() => { /* never resolves */ }));
      mocks.bridge.current!.registerAgent(AGENT_ID, app, {});
      const closeSpy = vi.spyOn(mocks.bridge.current!, 'acpClose');

      const resultPromise = checkAcpAgent(AGENT_ID, 'goose', 'goose');
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await resultPromise;

      expect(result).toEqual({ ok: false, error: 'Timed out waiting for goose to start (30 s).' });
      expect(closeSpy).toHaveBeenCalledTimes(1);
    });

    it('closes the agent right away if acp.open itself only resolves after the timeout already fired', async () => {
      const app = buildAgentApp({ name: 'fake-agent' })
        .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }));
      mocks.bridge.current!.registerAgent(AGENT_ID, app, {});
      const closeSpy = vi.spyOn(mocks.bridge.current!, 'acpClose');

      // Delays the bridge's first event ('open') behind a gate this test
      // controls, so the timeout can fire *before* checkAcpAgent ever
      // learns a channel exists — and models the real ordering exactly:
      // the open event arrives only *after* the timeout has already given
      // up and called `cancel()`, never before. The real native-bridge.ts
      // `cancel()` (llm/native-bridge.ts's `rpcStreamRequest`) works by
      // deleting its pending-stream registration — it has no way to tell
      // the bridge itself to stop — so any event the bridge still goes on
      // to send afterward (including a late `open`) is silently dropped by
      // the dispatcher, not merely delayed: a real cancelled stream's
      // first `.next()` call never resolves at all once that's happened.
      // A fake whose own `cancel()` doesn't drop anything (as this file's
      // fake-acp-bridge.ts's does — it only ends its *own* loop, and
      // doesn't affect an event already in flight) would let `releaseOpen`
      // below still deliver the event even post-cancel, which is exactly
      // how this test passed before this round's fix even with the
      // leak still in production code — so this wraps `cancel` here too,
      // to actually drop the event once called, matching the real bridge.
      const realOpen = mocks.bridge.current!.acpOpenStream;
      let releaseOpen!: () => void;
      const openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
      let cancelled = false;
      mocks.bridge.current!.acpOpenStream = (agentId: string, workspace: string) => {
        const result = realOpen(agentId, workspace);
        const originalNext = result.stream.next.bind(result.stream);
        let first = true;
        result.stream.next = (async () => {
          if (first) {
            first = false;
            await openGate;
            if (cancelled) {
              // The real bridge's dropped event: this `.next()` call never
              // resolves, because nothing is left registered to deliver it.
              return new Promise<never>(() => { /* never resolves */ });
            }
          }
          return originalNext();
        }) as typeof result.stream.next;
        return { ...result, cancel: () => { cancelled = true; result.cancel(); } };
      };

      const resultPromise = checkAcpAgent(AGENT_ID, 'goose', 'goose');
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await resultPromise;
      expect(result).toEqual({ ok: false, error: 'Timed out waiting for goose to start (30 s).' });
      // Nothing to close yet — acp.open hasn't resolved, so no channel
      // exists at the moment the timeout settled this check.
      expect(closeSpy).not.toHaveBeenCalled();

      // acp.open resolves late, well after the timeout already settled
      // this check's own result — the channel it only now reveals must
      // still be closed, not leaked, even though the timeout path already
      // ran its own cleanup once with nothing yet to close.
      releaseOpen();
      await vi.advanceTimersByTimeAsync(0);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    });

    it('does not time out a check that finishes well within 30s', async () => {
      const app = buildAgentApp({ name: 'fake-agent' })
        .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }));
      mocks.bridge.current!.registerAgent(AGENT_ID, app, {});

      const result = await checkAcpAgent(AGENT_ID, 'goose', 'goose');
      expect(result).toEqual({ ok: true, message: 'Ready (goose)' });
    });
  });

  describe('one check per agent at a time (deduped)', () => {
    it('a second concurrent check for the same agent reuses the first call, opening only one channel', async () => {
      let initializeCalls = 0;
      const app = buildAgentApp({ name: 'fake-agent' })
        .onRequest(AGENT_METHODS.initialize, async () => { initializeCalls++; return { protocolVersion: 1 }; });
      mocks.bridge.current!.registerAgent(AGENT_ID, app, {});

      const [first, second] = await Promise.all([
        checkAcpAgent(AGENT_ID, 'goose', 'goose'),
        checkAcpAgent(AGENT_ID, 'goose', 'goose'),
      ]);

      expect(first).toEqual(second);
      expect(mocks.bridge.current!.openCalls).toHaveLength(1);
      expect(initializeCalls).toBe(1);
    });

    it('a concurrent check for a different agent is not deduped', async () => {
      const app = buildAgentApp({ name: 'fake-agent' })
        .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }));
      mocks.bridge.current!.registerAgent(AGENT_ID, app, {});
      mocks.bridge.current!.registerAgent('other-agent', app, {});

      await Promise.all([
        checkAcpAgent(AGENT_ID, 'goose', 'goose'),
        checkAcpAgent('other-agent', 'other', 'other'),
      ]);

      expect(mocks.bridge.current!.openCalls).toHaveLength(2);
    });

    it('a later check for the same agent, after the first finished, runs again rather than reusing a stale result', async () => {
      const app = buildAgentApp({ name: 'fake-agent' })
        .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1 }));
      mocks.bridge.current!.registerAgent(AGENT_ID, app, {});

      await checkAcpAgent(AGENT_ID, 'goose', 'goose');
      await checkAcpAgent(AGENT_ID, 'goose', 'goose');

      expect(mocks.bridge.current!.openCalls).toHaveLength(2);
    });
  });
});
