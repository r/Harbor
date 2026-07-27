import type {
  SourceContextPreview,
  SourceContextResult,
  SourceTabLaunchEnvelope,
} from '../../contracts';

export type AvailableSourceContext = {
  kind: 'available';
  envelope: SourceTabLaunchEnvelope;
  preview: SourceContextPreview;
};

export type SourceContextResolution =
  | AvailableSourceContext
  | Extract<SourceContextResult, { kind: 'unavailable' | 'stale' | 'failed' }>;

export type SourceContextHookState =
  | { kind: 'idle' }
  | { kind: 'resolving' }
  | AvailableSourceContext
  | {
    kind: 'capturing';
    envelope: SourceTabLaunchEnvelope;
    preview: SourceContextPreview;
  }
  | SourceContextResult;
