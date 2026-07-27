import type {
  ChatRunError,
  ChatRunRequest,
  ToolCallReceipt,
} from '../../contracts';

export type TextSessionPort = {
  promptStreaming(input: string): AsyncIterable<unknown>;
  destroy(): void | Promise<void>;
};

export type TextGenerationPort = {
  createTextSession(options?: {
    systemPrompt?: string;
  }): Promise<TextSessionPort>;
};

export type AgentRunPort = {
  run(options: {
    task: string;
    tools?: string[];
    maxToolCalls?: number;
    useAllTools?: boolean;
    signal?: AbortSignal;
  }): AsyncIterable<unknown>;
};

export type RunEnvironmentSnapshot = {
  provider?: string;
  model?: string;
  locality?: 'local' | 'cloud';
};

export type RunClock = {
  now(): number;
};

export type RunServiceDependencies = {
  ai: TextGenerationPort;
  agent: AgentRunPort;
  environment?: (
    request: ChatRunRequest,
  ) => RunEnvironmentSnapshot | Promise<RunEnvironmentSnapshot>;
  clock?: RunClock;
  createId?: () => string;
};

export type NormalizedCitation = {
  source: string;
  ref: string;
};

export type NormalizedTextStreamEvent =
  | { type: 'content-delta'; text: string }
  | { type: 'done' }
  | { type: 'error'; error: ChatRunError };

export type NormalizedAgentStreamEvent =
  | { type: 'status'; message: string }
  | { type: 'content-delta'; text: string }
  | {
    type: 'tool-started';
    callId: string;
    tool: string;
    startedAt: number;
    argumentSummary: ToolCallReceipt['argumentSummary'];
  }
  | {
    type: 'tool-completed';
    callId: string;
    tool: string;
    completedAt: number;
    resultSummary?: ToolCallReceipt['resultSummary'];
    error?: ChatRunError;
  }
  | {
    type: 'final';
    output: string;
    citations: NormalizedCitation[];
  }
  | { type: 'error'; error: ChatRunError };
