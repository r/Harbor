import type {
  ApprovedChatIntent,
  ChatIntent,
  ChatPermissionScope,
  ChatReadiness,
  ChatRunEvent,
  ChatRunRequest,
  CapturedPageContext,
  PermissionDecision,
  PermissionPlan,
  SourceContextPreview,
  SourceTabLaunchEnvelope,
  SourceTabReference,
} from './contracts';

export type ReadinessService = {
  check(): Promise<ChatReadiness>;
};

export type ConsentContextService = {
  previewSource(): Promise<SourceContextPreview | null>;
  approve(intent: ChatIntent): Promise<ApprovedChatIntent>;
};

export type ChatPermissionPort = {
  list(): Promise<Partial<Record<ChatPermissionScope, 'granted' | 'denied'>>>;
  request(plan: PermissionPlan): Promise<PermissionDecision>;
};

export type SourceTabPort = {
  resolveLaunch(launchId: string): Promise<SourceTabLaunchEnvelope | null>;
  inspect(source: SourceTabReference): Promise<SourceTabReference | null>;
  capture(source: SourceTabReference): Promise<CapturedPageContext>;
};

export type RunService = {
  run(request: ChatRunRequest): AsyncIterable<ChatRunEvent>;
};

export type ChatServices = {
  readiness: ReadinessService;
  consentContext: ConsentContextService;
  run: RunService;
};
