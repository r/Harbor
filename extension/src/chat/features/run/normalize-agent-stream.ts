import {
  sanitizeReceiptReference,
  summarizeArguments,
  summarizeResult,
} from '../receipts/redact-receipt-value';
import { normalizeRunError, protocolRunError } from './run-error';
import type {
  NormalizedAgentStreamEvent,
  RunClock,
} from './run-types';

type AgentStreamEventShape = {
  type?: unknown;
  message?: unknown;
  content?: unknown;
  token?: unknown;
  tool?: unknown;
  args?: unknown;
  result?: unknown;
  output?: unknown;
  citations?: unknown;
  error?: unknown;
};

type AgentNormalizerOptions = {
  runId: string;
  clock: RunClock;
};

function normalizeToolName(value: unknown): string {
  return sanitizeReceiptReference(value);
}

function normalizeCitations(value: unknown): Array<{ source: string; ref: string }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((citation) => {
    if (!citation || typeof citation !== 'object') {
      return [];
    }
    const possibleCitation = citation as { source?: unknown; ref?: unknown };
    return [{
      source: sanitizeReceiptReference(possibleCitation.source),
      ref: sanitizeReceiptReference(possibleCitation.ref),
    }];
  });
}

export async function* normalizeAgentStream(
  source: AsyncIterable<unknown>,
  options: AgentNormalizerOptions,
): AsyncIterable<NormalizedAgentStreamEvent> {
  const outstandingCalls = new Map<string, string[]>();
  let toolCallOrdinal = 0;

  function createCallId(tool: string): string {
    toolCallOrdinal += 1;
    const safeTool = tool.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'tool';
    return `${options.runId}:tool:${toolCallOrdinal}:${safeTool}`;
  }

  for await (const rawEvent of source) {
    if (!rawEvent || typeof rawEvent !== 'object') {
      yield { type: 'error', error: protocolRunError('ERR_INVALID_AGENT_EVENT') };
      return;
    }

    const event = rawEvent as AgentStreamEventShape;
    if (event.type === 'status' || event.type === 'thinking') {
      const message = event.type === 'thinking' ? event.content : event.message;
      if (typeof message === 'string' && message) {
        yield { type: 'status', message };
      }
      continue;
    }
    if (event.type === 'token') {
      if (typeof event.token === 'string' && event.token) {
        yield { type: 'content-delta', text: event.token };
      }
      continue;
    }
    if (event.type === 'tool_call') {
      const tool = normalizeToolName(event.tool);
      const callId = createCallId(tool);
      const callsForTool = outstandingCalls.get(tool) ?? [];
      callsForTool.push(callId);
      outstandingCalls.set(tool, callsForTool);
      yield {
        type: 'tool-started',
        callId,
        tool,
        startedAt: options.clock.now(),
        argumentSummary: summarizeArguments(event.args),
      };
      continue;
    }
    if (event.type === 'tool_result') {
      const tool = normalizeToolName(event.tool);
      const callsForTool = outstandingCalls.get(tool) ?? [];
      const callId = callsForTool.shift() ?? createCallId(tool);
      if (callsForTool.length > 0) {
        outstandingCalls.set(tool, callsForTool);
      } else {
        outstandingCalls.delete(tool);
      }
      yield {
        type: 'tool-completed',
        callId,
        tool,
        completedAt: options.clock.now(),
        resultSummary: summarizeResult(event.result),
        error: event.error === undefined ? undefined : normalizeRunError(event.error),
      };
      continue;
    }
    if (event.type === 'final') {
      yield {
        type: 'final',
        output: typeof event.output === 'string' ? event.output : '',
        citations: normalizeCitations(event.citations),
      };
      return;
    }
    if (event.type === 'error') {
      yield { type: 'error', error: normalizeRunError(event.error) };
      return;
    }

    yield { type: 'error', error: protocolRunError('ERR_INVALID_AGENT_EVENT') };
    return;
  }
}
