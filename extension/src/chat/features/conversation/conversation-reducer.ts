import type {
  ConversationAction,
  ConversationMessage,
  ConversationState,
} from './conversation-types';

export const INITIAL_CONVERSATION_STATE: ConversationState = {
  messages: [],
  toolActivity: [],
};

function updateActiveAssistant(
  state: ConversationState,
  update: (message: ConversationMessage) => ConversationMessage,
): ConversationMessage[] {
  if (!state.activeAssistantMessageId) {
    return state.messages;
  }
  return state.messages.map((message) => (
    message.id === state.activeAssistantMessageId
      ? update(message)
      : message
  ));
}

export function conversationReducer(
  state: ConversationState,
  action: ConversationAction,
): ConversationState {
  if (action.type === 'clear') {
    return INITIAL_CONVERSATION_STATE;
  }
  if (action.type === 'begin') {
    return {
      messages: [
        ...state.messages,
        action.value.userMessage,
        action.value.assistantMessage,
      ],
      activeAssistantMessageId: action.value.assistantMessage.id,
      toolActivity: [],
    };
  }
  if (!state.activeAssistantMessageId) {
    return state;
  }
  if (action.type === 'started') {
    return {
      ...state,
      activeRunId: action.runId,
      messages: updateActiveAssistant(state, (message) => ({
        ...message,
        runId: action.runId,
      })),
    };
  }
  if (action.type === 'status') {
    return { ...state, statusMessage: action.message };
  }
  if (action.type === 'content-delta') {
    return {
      ...state,
      messages: updateActiveAssistant(state, (message) => ({
        ...message,
        content: message.content + action.text,
        state: 'streaming',
      })),
    };
  }
  if (action.type === 'tool-started') {
    return {
      ...state,
      toolActivity: [
        ...state.toolActivity,
        {
          callId: action.callId,
          tool: action.tool,
          state: 'running',
        },
      ],
    };
  }
  if (action.type === 'tool-completed') {
    const matchingTool = state.toolActivity.some(
      (activity) => activity.callId === action.receipt.callId,
    );
    return {
      ...state,
      toolActivity: matchingTool
        ? state.toolActivity.map((activity) => (
          activity.callId === action.receipt.callId
            ? {
              ...activity,
              state: action.receipt.status,
              receipt: action.receipt,
            }
            : activity
        ))
        : [
          ...state.toolActivity,
          {
            callId: action.receipt.callId,
            tool: action.receipt.tool,
            state: action.receipt.status,
            receipt: action.receipt,
          },
        ],
    };
  }
  if (action.type === 'completed') {
    if (state.activeRunId && state.activeRunId !== action.receipt.runId) {
      return state;
    }
    return {
      ...state,
      messages: updateActiveAssistant(state, (message) => ({
        ...message,
        content: action.output,
        state: 'complete',
      })),
      activeAssistantMessageId: undefined,
      activeRunId: undefined,
      statusMessage: undefined,
      lastError: undefined,
    };
  }
  if (action.type === 'failed') {
    if (state.activeRunId && state.activeRunId !== action.receipt.runId) {
      return state;
    }
    return {
      ...state,
      messages: updateActiveAssistant(state, (message) => ({
        ...message,
        content: message.content || action.error.message,
        state: 'failed',
      })),
      activeAssistantMessageId: undefined,
      activeRunId: undefined,
      statusMessage: undefined,
      lastError: action.error,
    };
  }
  if (state.activeRunId && state.activeRunId !== action.receipt.runId) {
    return state;
  }
  return {
    ...state,
    messages: updateActiveAssistant(state, (message) => ({
      ...message,
      content: message.content || 'Request cancelled.',
      state: 'cancelled',
    })),
    activeAssistantMessageId: undefined,
    activeRunId: undefined,
    statusMessage: undefined,
  };
}
