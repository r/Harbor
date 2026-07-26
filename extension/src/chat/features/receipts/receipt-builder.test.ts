import { describe, expect, it } from 'vitest';
import type { ChatRunRequest } from '../../contracts';
import { createExecutionReceiptBuilder } from './receipt-builder';

const request: ChatRunRequest = {
  prompt: 'Summarize my private page text',
  approval: {
    intent: {
      context: {
        mode: 'source',
        preview: {
          title: 'Private page',
          origin: 'https://example.com',
        },
      },
      tools: {
        mode: 'approved',
        toolNames: ['server/search'],
      },
    },
    scopes: ['model:prompt', 'model:tools', 'mcp:tools.call'],
    context: {
      title: 'Private page',
      url: 'https://example.com/private?token=secret',
      text: 'private source content',
      capturedAt: 1,
    },
  },
};

describe('createExecutionReceiptBuilder', () => {
  it('creates metadata-only receipts and closes missing tool results', () => {
    const builder = createExecutionReceiptBuilder({
      runId: 'run-1',
      receiptId: 'receipt-1',
      mode: 'agent',
      request,
      environment: {
        provider: 'local-provider',
        model: 'small-model',
        locality: 'local',
      },
      startedAt: 1_000,
    });
    builder.toolStarted({
      callId: 'call-1',
      tool: 'server/search',
      startedAt: 1_010,
      argumentSummary: {
        fieldCount: 2,
        sensitiveFieldCount: 1,
      },
    });

    const receipt = builder.complete(1_100, [{
      source: 'tool',
      ref: 'https://docs.example/private?token=secret',
    }]);
    const serialized = JSON.stringify(receipt);

    expect(receipt).toMatchObject({
      status: 'completed',
      source: {
        title: 'Private page',
        origin: 'https://example.com/',
      },
      toolCalls: [{
        callId: 'call-1',
        status: 'failed',
        errorCode: 'ERR_TOOL_RESULT_MISSING',
      }],
      citations: [{
        source: 'tool',
        ref: 'https://docs.example/',
      }],
    });
    expect(serialized).not.toContain(request.prompt);
    expect(serialized).not.toContain('private source content');
    expect(serialized).not.toContain('?token=');
    expect(serialized).not.toContain('secret');
  });

  it('records failed tool metadata without result payloads', () => {
    const builder = createExecutionReceiptBuilder({
      runId: 'run-2',
      receiptId: 'receipt-2',
      mode: 'agent',
      request,
      environment: {},
      startedAt: 2_000,
    });
    builder.toolStarted({
      callId: 'call-2',
      tool: 'server/search',
      startedAt: 2_010,
      argumentSummary: {
        fieldCount: 1,
        sensitiveFieldCount: 0,
      },
    });
    const toolReceipt = builder.toolCompleted({
      callId: 'call-2',
      tool: 'server/search',
      completedAt: 2_030,
      resultSummary: { kind: 'object', size: 3 },
      error: {
        category: 'tool',
        code: 'ERR_TOOL_FAILED',
        message: 'A tool could not complete this request.',
      },
    });

    expect(toolReceipt).toEqual({
      callId: 'call-2',
      tool: 'server/search',
      status: 'failed',
      startedOffsetMs: 10,
      durationMs: 20,
      argumentSummary: {
        fieldCount: 1,
        sensitiveFieldCount: 0,
      },
      resultSummary: { kind: 'object', size: 3 },
      errorCode: 'ERR_TOOL_FAILED',
    });
  });
});
