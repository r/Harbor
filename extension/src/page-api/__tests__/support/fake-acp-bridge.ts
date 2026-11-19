/**
 * A fake bridge for the ACP backend's tests.
 *
 * Implements the `acp.open` / `acp.send` / `acp.close` contract documented
 * in bridge-rs/README.md "ACP agents" (open -> message* -> exit, or a
 * fatal error before any channel exists), but runs the "agent" side with
 * the real ACP SDK's `AgentApp` over an in-process duplex stream, so the
 * backend under test talks real ACP JSON-RPC, not a hand-rolled stand-in.
 *
 * Tests get `acpOpenStream`/`acpSend`/`acpClose` with the same signatures
 * as page-api/harbor-core.ts's real wrappers, to use in a
 * `vi.mock('../harbor-core', ...)`.
 */
import type { AgentApp, AnyMessage } from '@agentclientprotocol/sdk';

export type FakeAcpEvent =
  | { type: 'open'; channel: string; cwd?: string }
  | { type: 'message'; message: unknown }
  | { type: 'exit'; code: number | null }
  | { type: 'error'; fatal?: boolean; message: string };

export interface RegisterAgentOptions {
  /** `cwd` the fake `open` event reports. Defaults to a fake workspace path. */
  cwd?: string;
  /** When set, `acp.open` fails before any channel exists (a fatal error, per the real bridge's contract). */
  failToStart?: string;
}

interface OpenChannel {
  push: (event: FakeAcpEvent) => void;
  writer: WritableStreamDefaultWriter<AnyMessage>;
  closed: boolean;
}

export function createFakeAcpBridge() {
  const registry = new Map<string, { app: AgentApp; options: RegisterAgentOptions }>();
  const channels = new Map<string, OpenChannel>();
  /** Every `acp.open` call this bridge has seen, in order, so a test can
   * assert what the backend actually passed as `workspace`. */
  const openCalls: Array<{ agentId: string; workspace: string }> = [];
  let nextChannel = 0;

  function registerAgent(agentId: string, app: AgentApp, options: RegisterAgentOptions = {}): void {
    registry.set(agentId, { app, options });
  }

  function acpOpenStream(agentId: string, workspace: string): { stream: AsyncGenerator<FakeAcpEvent>; cancel: () => void } {
    openCalls.push({ agentId, workspace });
    const queue: FakeAcpEvent[] = [];
    let resolveWaiting: ((event: FakeAcpEvent) => void) | null = null;
    let ended = false;

    function push(event: FakeAcpEvent): void {
      if (resolveWaiting) {
        const resolve = resolveWaiting;
        resolveWaiting = null;
        resolve(event);
      } else {
        queue.push(event);
      }
    }

    async function* generate(): AsyncGenerator<FakeAcpEvent> {
      const reg = registry.get(agentId);
      if (!reg) {
        yield { type: 'error', fatal: true, message: `unknown agent: ${agentId}` };
        return;
      }
      if (reg.options.failToStart) {
        yield { type: 'error', fatal: true, message: reg.options.failToStart };
        return;
      }

      const channel = `ch-${nextChannel++}`;

      let ctrlToClient!: ReadableStreamDefaultController<AnyMessage>;
      let ctrlToAgent!: ReadableStreamDefaultController<AnyMessage>;
      const toClient = new ReadableStream<AnyMessage>({ start(c) { ctrlToClient = c; } });
      const toAgent = new ReadableStream<AnyMessage>({ start(c) { ctrlToAgent = c; } });
      const agentWritable = new WritableStream<AnyMessage>({ write(chunk) { ctrlToClient.enqueue(chunk); } });
      const clientWritable = new WritableStream<AnyMessage>({ write(chunk) { ctrlToAgent.enqueue(chunk); } });

      channels.set(channel, { push, writer: clientWritable.getWriter(), closed: false });

      // The real agent side, over the SDK, as a genuine ACP peer.
      reg.app.connect({ readable: toAgent, writable: agentWritable });

      yield { type: 'open', channel, cwd: reg.options.cwd ?? '/fake/workspace' };

      // Pump every message the "agent" wrote into `message` events.
      const reader = toClient.getReader();
      (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            push({ type: 'message', message: value });
          }
        } catch {
          // The channel closed; nothing more to forward.
        }
      })();

      for (;;) {
        if (queue.length > 0) {
          const event = queue.shift()!;
          yield event;
          if (event.type === 'exit') return;
          continue;
        }
        if (ended) return;
        const event = await new Promise<FakeAcpEvent>((resolve) => {
          resolveWaiting = resolve;
        });
        yield event;
        if (event.type === 'exit') return;
      }
    }

    return {
      stream: generate(),
      cancel: () => {
        ended = true;
      },
    };
  }

  async function acpSend(channel: string, message: unknown): Promise<void> {
    const ch = channels.get(channel);
    if (!ch) throw new Error(`unknown channel: ${channel}`);
    await ch.writer.write(message as AnyMessage);
  }

  async function acpClose(channel: string): Promise<void> {
    const ch = channels.get(channel);
    if (!ch || ch.closed) return;
    ch.closed = true;
    ch.push({ type: 'exit', code: 0 });
  }

  /** Simulates the agent's process dying on its own (not via `acp.close`). */
  function crashChannel(channel: string, code: number | null = 1): void {
    const ch = channels.get(channel);
    ch?.push({ type: 'exit', code });
  }

  return { acpOpenStream, acpSend, acpClose, registerAgent, crashChannel, openCalls };
}
