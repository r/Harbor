import type {
  ChatRunError,
  ExecutionReceipt,
  ToolCallReceipt,
} from '../../contracts';

export type ConversationMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  state: 'complete' | 'streaming' | 'failed' | 'cancelled';
  runId?: string;
};

export type ConversationToolActivity = {
  callId: string;
  tool: string;
  state: 'running' | 'completed' | 'failed' | 'denied';
  receipt?: ToolCallReceipt;
};

export type ConversationState = {
  messages: ConversationMessage[];
  activeAssistantMessageId?: string;
  activeRunId?: string;
  statusMessage?: string;
  toolActivity: ConversationToolActivity[];
  lastError?: ChatRunError;
};

export type BeginConversationRun = {
  userMessage: ConversationMessage;
  assistantMessage: ConversationMessage;
};

export type ConversationAction =
  | { type: 'begin'; value: BeginConversationRun }
  | { type: 'started'; runId: string }
  | { type: 'status'; message: string }
  | { type: 'content-delta'; text: string }
  | { type: 'tool-started'; callId: string; tool: string }
  | { type: 'tool-completed'; receipt: ToolCallReceipt }
  | {
    type: 'completed';
    output: string;
    receipt: ExecutionReceipt;
  }
  | {
    type: 'failed';
    error: ChatRunError;
    receipt: ExecutionReceipt;
  }
  | { type: 'cancelled'; receipt: ExecutionReceipt }
  | { type: 'clear' };
