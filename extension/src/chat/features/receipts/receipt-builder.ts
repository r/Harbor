import type {
  ChatRunError,
  ChatRunRequest,
  ExecutionReceipt,
  ToolCallReceipt,
} from '../../contracts';
import type {
  NormalizedCitation,
  RunEnvironmentSnapshot,
} from '../run/run-types';
import { sanitizeReceiptReference } from './redact-receipt-value';

type ReceiptBuilderOptions = {
  runId: string;
  receiptId: string;
  mode: ExecutionReceipt['mode'];
  request: ChatRunRequest;
  environment: RunEnvironmentSnapshot;
  startedAt: number;
};

type PendingToolCall = {
  receipt: ToolCallReceipt;
  startedAt: number;
};

export type ExecutionReceiptBuilder = {
  toolStarted(input: {
    callId: string;
    tool: string;
    startedAt: number;
    argumentSummary: ToolCallReceipt['argumentSummary'];
  }): void;
  toolCompleted(input: {
    callId: string;
    tool: string;
    completedAt: number;
    resultSummary?: ToolCallReceipt['resultSummary'];
    error?: ChatRunError;
  }): ToolCallReceipt;
  complete(completedAt: number, citations: NormalizedCitation[]): ExecutionReceipt;
  fail(completedAt: number, error: ChatRunError): ExecutionReceipt;
  cancel(completedAt: number): ExecutionReceipt;
};

function sourceFromRequest(
  request: ChatRunRequest,
): ExecutionReceipt['source'] {
  if (request.approval.intent.context.mode === 'source') {
    return {
      title: sanitizeReceiptReference(
        request.approval.intent.context.preview.title,
      ),
      origin: sanitizeReceiptReference(
        request.approval.intent.context.preview.origin,
      ),
    };
  }
  return undefined;
}

function terminalToolStatus(error: ChatRunError | undefined): ToolCallReceipt['status'] {
  if (!error) {
    return 'completed';
  }
  return error.category === 'permission' ? 'denied' : 'failed';
}

export function createExecutionReceiptBuilder(
  options: ReceiptBuilderOptions,
): ExecutionReceiptBuilder {
  const toolCalls = new Map<string, PendingToolCall>();

  function toolStarted(input: {
    callId: string;
    tool: string;
    startedAt: number;
    argumentSummary: ToolCallReceipt['argumentSummary'];
  }): void {
    toolCalls.set(input.callId, {
      startedAt: input.startedAt,
      receipt: {
        callId: input.callId,
        tool: sanitizeReceiptReference(input.tool),
        status: 'failed',
        startedOffsetMs: Math.max(0, input.startedAt - options.startedAt),
        argumentSummary: { ...input.argumentSummary },
      },
    });
  }

  function toolCompleted(input: {
    callId: string;
    tool: string;
    completedAt: number;
    resultSummary?: ToolCallReceipt['resultSummary'];
    error?: ChatRunError;
  }): ToolCallReceipt {
    const pendingCall = toolCalls.get(input.callId) ?? {
      startedAt: input.completedAt,
      receipt: {
        callId: input.callId,
        tool: sanitizeReceiptReference(input.tool),
        status: 'failed' as const,
        startedOffsetMs: Math.max(0, input.completedAt - options.startedAt),
        argumentSummary: {
          fieldCount: 0,
          sensitiveFieldCount: 0,
        },
      },
    };

    const completedReceipt: ToolCallReceipt = {
      ...pendingCall.receipt,
      status: terminalToolStatus(input.error),
      durationMs: Math.max(0, input.completedAt - pendingCall.startedAt),
      resultSummary: input.resultSummary
        ? { ...input.resultSummary }
        : undefined,
      errorCode: input.error?.code,
    };

    toolCalls.set(input.callId, {
      startedAt: pendingCall.startedAt,
      receipt: completedReceipt,
    });
    return { ...completedReceipt };
  }

  function finalizePendingTools(completedAt: number): ToolCallReceipt[] {
    return Array.from(toolCalls.values(), ({ startedAt, receipt }) => {
      if (receipt.durationMs !== undefined) {
        return { ...receipt };
      }
      return {
        ...receipt,
        status: 'failed',
        durationMs: Math.max(0, completedAt - startedAt),
        errorCode: 'ERR_TOOL_RESULT_MISSING',
      };
    });
  }

  function build(
    status: ExecutionReceipt['status'],
    completedAt: number,
    citations: NormalizedCitation[],
    error?: ChatRunError,
  ): ExecutionReceipt {
    return {
      version: 1,
      id: options.receiptId,
      runId: options.runId,
      status,
      mode: options.mode,
      provider: options.environment.provider,
      model: options.environment.model,
      locality: options.environment.locality,
      source: sourceFromRequest(options.request),
      scopes: [...options.request.approval.scopes],
      toolCalls: finalizePendingTools(completedAt),
      startedAt: new Date(options.startedAt).toISOString(),
      completedAt: new Date(completedAt).toISOString(),
      durationMs: Math.max(0, completedAt - options.startedAt),
      citations: citations.map((citation) => ({
        source: sanitizeReceiptReference(citation.source),
        ref: sanitizeReceiptReference(citation.ref),
      })),
      error: error
        ? { category: error.category, code: error.code }
        : undefined,
    };
  }

  return {
    toolStarted,
    toolCompleted,
    complete: (completedAt, citations) => build(
      'completed',
      completedAt,
      citations,
    ),
    fail: (completedAt, error) => build(
      'failed',
      completedAt,
      [],
      error,
    ),
    cancel: (completedAt) => build(
      'cancelled',
      completedAt,
      [],
      {
        category: 'cancelled',
        code: 'ERR_CANCELLED',
        message: 'This request was cancelled.',
      },
    ),
  };
}
