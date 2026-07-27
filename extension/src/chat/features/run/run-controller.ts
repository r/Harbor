import type {
  ChatRunError,
  ChatRunEvent,
  ChatRunRequest,
  ExecutionReceipt,
} from '../../contracts';
import type { RunService } from '../../services';
import { createExecutionReceiptBuilder } from '../receipts/receipt-builder';
import { normalizeAgentStream } from './normalize-agent-stream';
import { normalizeTextStream } from './normalize-text-stream';
import {
  cancelledRunError,
  normalizeRunError,
  protocolRunError,
} from './run-error';
import type {
  RunEnvironmentSnapshot,
  RunServiceDependencies,
  TextSessionPort,
} from './run-types';

export type ControllableRunService = RunService & {
  cancel(runId?: string): void;
};

const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.';

function defaultCreateId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function promptForRequest(request: ChatRunRequest): string {
  const context = request.approval.context;
  if (!context) {
    return request.prompt;
  }

  return [
    'The user explicitly approved the following source-page context for this request.',
    `Title: ${context.title}`,
    `URL: ${context.url}`,
    '',
    context.text,
    '',
    'User request:',
    request.prompt,
  ].join('\n');
}

function modeForRequest(request: ChatRunRequest): ExecutionReceipt['mode'] {
  return request.approval.intent.tools.mode === 'approved'
    ? 'agent'
    : 'model';
}

function createAbortError(): Error {
  const error = new Error('The run was cancelled.');
  error.name = 'AbortError';
  return error;
}

function abortableSource(
  source: AsyncIterable<unknown>,
  signal: AbortSignal,
): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      const iterator = source[Symbol.asyncIterator]();
      try {
        while (true) {
          if (signal.aborted) {
            throw createAbortError();
          }

          let removeAbortListener = (): void => {};
          const aborted = new Promise<never>((_resolve, reject) => {
            const onAbort = (): void => reject(createAbortError());
            signal.addEventListener('abort', onAbort, { once: true });
            removeAbortListener = () => signal.removeEventListener('abort', onAbort);
          });

          try {
            const result = await Promise.race([iterator.next(), aborted]);
            if (result.done) {
              return;
            }
            yield result.value;
          } finally {
            removeAbortListener();
          }
        }
      } finally {
        const closeResult = iterator.return?.();
        if (closeResult && !signal.aborted) {
          await closeResult;
        } else {
          void closeResult?.catch(() => {});
        }
      }
    },
  };
}

async function safeEnvironmentSnapshot(
  dependencies: RunServiceDependencies,
  request: ChatRunRequest,
): Promise<RunEnvironmentSnapshot> {
  try {
    return await dependencies.environment?.(request) ?? {};
  } catch {
    return {};
  }
}

export function createChatRunService(
  dependencies: RunServiceDependencies,
): ControllableRunService {
  const clock = dependencies.clock ?? { now: () => Date.now() };
  const createId = dependencies.createId ?? defaultCreateId;
  const activeRuns = new Map<string, AbortController>();

  function run(request: ChatRunRequest): AsyncIterable<ChatRunEvent> {
    const runId = createId();
    const abortController = new AbortController();
    activeRuns.set(runId, abortController);

    return {
      async *[Symbol.asyncIterator]() {
        const startedAt = clock.now();
        const mode = modeForRequest(request);
        const environment = await safeEnvironmentSnapshot(dependencies, request);
        const receiptBuilder = createExecutionReceiptBuilder({
          runId,
          receiptId: createId(),
          mode,
          request,
          environment,
          startedAt,
        });
        let textSession: TextSessionPort | undefined;
        let terminalEventEmitted = false;

        yield {
          type: 'started',
          runId,
          mode,
          at: new Date(startedAt).toISOString(),
        };

        try {
          if (abortController.signal.aborted) {
            throw createAbortError();
          }

          const prompt = promptForRequest(request);
          if (mode === 'model') {
            textSession = await dependencies.ai.createTextSession({
              systemPrompt: DEFAULT_SYSTEM_PROMPT,
            });
            const source = abortableSource(
              textSession.promptStreaming(prompt),
              abortController.signal,
            );
            let output = '';

            for await (const event of normalizeTextStream(source)) {
              if (event.type === 'content-delta') {
                output += event.text;
                yield event;
              } else if (event.type === 'error') {
                const receipt = receiptBuilder.fail(clock.now(), event.error);
                terminalEventEmitted = true;
                yield { type: 'failed', error: event.error, receipt };
                return;
              } else if (event.type === 'done') {
                break;
              }
            }

            const receipt = receiptBuilder.complete(clock.now(), []);
            terminalEventEmitted = true;
            yield { type: 'completed', output, receipt };
            return;
          }

          const approvedTools = request.approval.intent.tools.mode === 'approved'
            ? request.approval.intent.tools.toolNames
            : [];
          const source = abortableSource(
            dependencies.agent.run({
              task: prompt,
              tools: approvedTools,
              maxToolCalls: 5,
              useAllTools: false,
              signal: abortController.signal,
            }),
            abortController.signal,
          );
          let finalEventReceived = false;

          for await (const event of normalizeAgentStream(source, {
            runId,
            clock,
          })) {
            if (event.type === 'status' || event.type === 'content-delta') {
              yield event;
              continue;
            }
            if (event.type === 'tool-started') {
              receiptBuilder.toolStarted(event);
              yield {
                type: 'tool-started',
                callId: event.callId,
                tool: event.tool,
              };
              continue;
            }
            if (event.type === 'tool-completed') {
              const toolReceipt = receiptBuilder.toolCompleted(event);
              yield { type: 'tool-completed', receipt: toolReceipt };
              continue;
            }
            if (event.type === 'error') {
              const receipt = receiptBuilder.fail(clock.now(), event.error);
              terminalEventEmitted = true;
              yield { type: 'failed', error: event.error, receipt };
              return;
            }
            if (event.type === 'final') {
              finalEventReceived = true;
              const receipt = receiptBuilder.complete(
                clock.now(),
                event.citations,
              );
              terminalEventEmitted = true;
              yield { type: 'completed', output: event.output, receipt };
              return;
            }
          }

          if (!finalEventReceived) {
            const error = protocolRunError('ERR_AGENT_FINAL_MISSING');
            const receipt = receiptBuilder.fail(clock.now(), error);
            terminalEventEmitted = true;
            yield { type: 'failed', error, receipt };
          }
        } catch (error) {
          const normalizedError: ChatRunError = abortController.signal.aborted
            ? cancelledRunError()
            : normalizeRunError(error);
          if (!terminalEventEmitted) {
            terminalEventEmitted = true;
            if (normalizedError.category === 'cancelled') {
              yield {
                type: 'cancelled',
                receipt: receiptBuilder.cancel(clock.now()),
              };
            } else {
              yield {
                type: 'failed',
                error: normalizedError,
                receipt: receiptBuilder.fail(clock.now(), normalizedError),
              };
            }
          }
        } finally {
          await textSession?.destroy();
          if (activeRuns.get(runId) === abortController) {
            activeRuns.delete(runId);
          }
        }
      },
    };
  }

  function cancel(runId?: string): void {
    if (runId) {
      activeRuns.get(runId)?.abort();
      return;
    }
    for (const controller of activeRuns.values()) {
      controller.abort();
    }
  }

  return { run, cancel };
}
