import { describe, expect, it } from 'vitest';
import type {
  ChatRunError,
  ExecutionReceipt,
} from '../../contracts';
import {
  conversationReducer,
  INITIAL_CONVERSATION_STATE,
} from './conversation-reducer';
import type { ConversationState } from './conversation-types';

const receipt: ExecutionReceipt = {
  version: 1,
  id: 'receipt-1',
  runId: 'run-1',
  status: 'completed',
  mode: 'model',
  scopes: ['model:prompt'],
  toolCalls: [],
  startedAt: new Date(0).toISOString(),
  completedAt: new Date(10).toISOString(),
  durationMs: 10,
  citations: [],
};

function begin(): ConversationState {
  return conversationReducer(INITIAL_CONVERSATION_STATE, {
    type: 'begin',
    value: {
      userMessage: {
        id: 'user-1',
        role: 'user',
        content: 'Hello',
        createdAt: new Date(0).toISOString(),
        state: 'complete',
      },
      assistantMessage: {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        createdAt: new Date(0).toISOString(),
        state: 'streaming',
      },
    },
  });
}

describe('conversationReducer', () => {
  it('replaces streamed draft content with authoritative final output', () => {
    let state = begin();
    state = conversationReducer(state, {
      type: 'started',
      runId: 'run-1',
    });
    state = conversationReducer(state, {
      type: 'content-delta',
      text: 'Draft ',
    });
    state = conversationReducer(state, {
      type: 'content-delta',
      text: 'answer',
    });
    state = conversationReducer(state, {
      type: 'completed',
      output: 'Final answer',
      receipt,
    });

    expect(state.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'Final answer',
      state: 'complete',
      runId: 'run-1',
    });
    expect(state.activeRunId).toBeUndefined();
  });

  it('ignores late terminal events for another run', () => {
    let state = begin();
    state = conversationReducer(state, {
      type: 'started',
      runId: 'run-1',
    });
    const staleReceipt = { ...receipt, runId: 'run-old' };

    expect(conversationReducer(state, {
      type: 'completed',
      output: 'Stale',
      receipt: staleReceipt,
    })).toEqual(state);
  });

  it('keeps safe partial output and exposes a normalized failure', () => {
    const error: ChatRunError = {
      category: 'model',
      code: 'ERR_MODEL_FAILED',
      message: 'The model could not complete this request.',
    };
    let state = begin();
    state = conversationReducer(state, {
      type: 'started',
      runId: 'run-1',
    });
    state = conversationReducer(state, {
      type: 'content-delta',
      text: 'Partial answer',
    });
    state = conversationReducer(state, {
      type: 'failed',
      error,
      receipt: {
        ...receipt,
        status: 'failed',
        error: {
          category: 'model',
          code: 'ERR_MODEL_FAILED',
        },
      },
    });

    expect(state.messages.at(-1)).toMatchObject({
      content: 'Partial answer',
      state: 'failed',
    });
    expect(state.lastError).toEqual(error);
  });

  it('tracks tool calls by distinct call IDs', () => {
    let state = begin();
    state = conversationReducer(state, {
      type: 'tool-started',
      callId: 'call-1',
      tool: 'server/search',
    });
    state = conversationReducer(state, {
      type: 'tool-started',
      callId: 'call-2',
      tool: 'server/search',
    });
    state = conversationReducer(state, {
      type: 'tool-completed',
      receipt: {
        callId: 'call-1',
        tool: 'server/search',
        status: 'completed',
        startedOffsetMs: 1,
        durationMs: 2,
        argumentSummary: {
          fieldCount: 1,
          sensitiveFieldCount: 0,
        },
      },
    });

    expect(state.toolActivity).toEqual([
      expect.objectContaining({
        callId: 'call-1',
        state: 'completed',
      }),
      expect.objectContaining({
        callId: 'call-2',
        state: 'running',
      }),
    ]);
  });

  it('shows a tool result even when its start event was unavailable', () => {
    const state = conversationReducer(begin(), {
      type: 'tool-completed',
      receipt: {
        callId: 'orphan-call',
        tool: 'server/search',
        status: 'failed',
        startedOffsetMs: 0,
        durationMs: 0,
        errorCode: 'ERR_TOOL_RESULT_MISSING',
        argumentSummary: {
          fieldCount: 0,
          sensitiveFieldCount: 0,
        },
      },
    });

    expect(state.toolActivity).toEqual([
      expect.objectContaining({
        callId: 'orphan-call',
        state: 'failed',
      }),
    ]);
  });
});
