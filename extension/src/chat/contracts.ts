export type RecoveryAction =
  | { kind: 'open-connections'; label: string }
  | { kind: 'retry'; label: string }
  | { kind: 'reload'; label: string };

export type ChatPermissionScope =
  | 'model:prompt'
  | 'model:tools'
  | 'mcp:tools.list'
  | 'mcp:tools.call'
  | 'browser:activeTab.read';

export type ChatReadiness = {
  api: 'available' | 'missing';
  bridge: 'checking' | 'ready' | 'offline';
  model: {
    state: 'checking' | 'ready' | 'unconfigured' | 'unavailable';
    provider?: string;
    model?: string;
    locality?: 'local' | 'cloud';
  };
  tools: {
    state: 'checking' | 'ready' | 'empty' | 'unavailable';
    count: number;
  };
  blockers: RecoveryAction[];
};

export type SourceTabReference = {
  tabId: number;
  windowId: number;
  url: string;
  title: string;
  origin: string;
};

export type SourceTabLaunchEnvelope = {
  version: 1;
  launchId: string;
  source: SourceTabReference;
  createdAt: number;
  expiresAt: number;
};

export type SourceContextPreview = {
  title: string;
  origin: string;
};

export type CapturedPageContext = {
  title: string;
  url: string;
  text: string;
  capturedAt: number;
};

export type SourceContextResult =
  | { kind: 'captured'; context: CapturedPageContext }
  | { kind: 'denied' }
  | { kind: 'dismissed' }
  | {
    kind: 'unavailable';
    reason: 'missing' | 'closed' | 'unsupported';
  }
  | { kind: 'stale'; reason: 'navigated' | 'expired' }
  | { kind: 'failed'; message: string };

export type ChatIntent = {
  context:
    | { mode: 'off' }
    | { mode: 'source'; preview: SourceContextPreview };
  tools:
    | { mode: 'off' }
    | { mode: 'approved'; toolNames: string[] };
};

export type PermissionPlan = {
  scopes: ChatPermissionScope[];
  reason: string;
  toolAllowlist: string[];
};

export type PermissionDecision =
  | { kind: 'granted'; scopes: ChatPermissionScope[] }
  | {
    kind: 'partial';
    granted: ChatPermissionScope[];
    denied: ChatPermissionScope[];
  }
  | { kind: 'denied'; scopes: ChatPermissionScope[] }
  | { kind: 'dismissed' }
  | { kind: 'unavailable'; message: string };

export type ApprovedChatIntent = {
  intent: ChatIntent;
  scopes: ChatPermissionScope[];
  context?: CapturedPageContext;
  expiresAt?: string;
};

export type ChatRunRequest = {
  prompt: string;
  approval: ApprovedChatIntent;
};

export type ToolCallReceipt = {
  callId: string;
  tool: string;
  status: 'completed' | 'failed' | 'denied';
  startedOffsetMs: number;
  durationMs?: number;
  errorCode?: string;
  argumentSummary: {
    fieldCount: number;
    sensitiveFieldCount: number;
  };
  resultSummary?: {
    kind: string;
    size?: number;
  };
};

export type ExecutionReceipt = {
  version: 1;
  id: string;
  runId: string;
  status: 'completed' | 'failed' | 'cancelled';
  mode: 'model' | 'agent';
  provider?: string;
  model?: string;
  locality?: 'local' | 'cloud';
  source?: SourceContextPreview;
  scopes: ChatPermissionScope[];
  toolCalls: ToolCallReceipt[];
  startedAt: string;
  completedAt: string;
  durationMs: number;
  citations: Array<{ source: string; ref: string }>;
  error?: {
    category: ChatRunErrorCategory;
    code?: string;
  };
};

export type ChatRunErrorCategory =
  | 'permission'
  | 'model'
  | 'tool'
  | 'transport'
  | 'configuration'
  | 'protocol'
  | 'cancelled'
  | 'unknown';

export type ChatRunError = {
  category: ChatRunErrorCategory;
  code?: string;
  message: string;
  recovery?: RecoveryAction;
};

export type ChatRunEvent =
  | {
    type: 'started';
    runId: string;
    mode: 'model' | 'agent';
    at: string;
  }
  | { type: 'status'; message: string }
  | { type: 'content-delta'; text: string }
  | { type: 'tool-started'; callId: string; tool: string }
  | { type: 'tool-completed'; receipt: ToolCallReceipt }
  | { type: 'completed'; output: string; receipt: ExecutionReceipt }
  | { type: 'failed'; error: ChatRunError; receipt: ExecutionReceipt }
  | { type: 'cancelled'; receipt: ExecutionReceipt };

export type ChatPhase =
  | { kind: 'checking' }
  | { kind: 'blocked'; blockers: RecoveryAction[] }
  | { kind: 'ready' }
  | { kind: 'running'; runId: string }
  | { kind: 'failed'; error: ChatRunError };
