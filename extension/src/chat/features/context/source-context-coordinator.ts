import type {
  CapturedPageContext,
  ChatPermissionScope,
  SourceContextResult,
  SourceTabLaunchEnvelope,
  SourceTabReference,
} from '../../contracts';
import type { SourceTabPort } from '../../services';
import type {
  AvailableSourceContext,
  SourceContextResolution,
} from './source-context-state';

export const MAX_SOURCE_CONTEXT_CHARACTERS = 12_000;

const approvedSourceContexts = new WeakSet<SourceContextApproval>();

export type SourceContextApproval = {
  readonly envelope: SourceTabLaunchEnvelope;
};

export async function resolveSourceContext(
  launchId: string,
  sourceTabPort: SourceTabPort,
  now: () => number = Date.now,
): Promise<SourceContextResolution> {
  if (!launchId) {
    return {
      kind: 'unavailable',
      reason: 'missing',
    };
  }

  let envelope: SourceTabLaunchEnvelope | null;
  try {
    envelope = await sourceTabPort.resolveLaunch(launchId);
  } catch {
    return {
      kind: 'failed',
      message: 'Harbor could not resolve the page that opened this chat.',
    };
  }

  if (!envelope || !isValidLaunchEnvelope(envelope, launchId)) {
    return {
      kind: 'unavailable',
      reason: 'missing',
    };
  }

  const trustedEnvelope = freezeLaunchEnvelope(envelope);

  if (trustedEnvelope.expiresAt <= now()) {
    return {
      kind: 'stale',
      reason: 'expired',
    };
  }

  if (!isSupportedSource(trustedEnvelope.source)) {
    return {
      kind: 'unavailable',
      reason: 'unsupported',
    };
  }

  let currentSource: SourceTabReference | null;
  try {
    currentSource = await sourceTabPort.inspect(trustedEnvelope.source);
  } catch {
    return {
      kind: 'failed',
      message: 'Harbor could not inspect the approved page.',
    };
  }

  if (!currentSource) {
    return {
      kind: 'unavailable',
      reason: 'closed',
    };
  }

  if (!matchesSourceFingerprint(trustedEnvelope.source, currentSource)) {
    return {
      kind: 'stale',
      reason: 'navigated',
    };
  }

  return {
    kind: 'available',
    envelope: trustedEnvelope,
    preview: {
      title: currentSource.title || trustedEnvelope.source.title,
      origin: trustedEnvelope.source.origin,
    },
  };
}

export function approveSourceContext(
  sourceContext: AvailableSourceContext,
  scopes: ChatPermissionScope[],
): SourceContextApproval | null {
  if (!scopes.includes('browser:activeTab.read')) {
    return null;
  }

  const approval: SourceContextApproval = {
    envelope: sourceContext.envelope,
  };
  approvedSourceContexts.add(approval);
  return approval;
}

export async function captureApprovedSourceContext(
  approval: SourceContextApproval,
  sourceTabPort: SourceTabPort,
  now: () => number = Date.now,
): Promise<SourceContextResult> {
  if (!approvedSourceContexts.has(approval)) {
    return {
      kind: 'denied',
    };
  }

  const { envelope } = approval;
  if (envelope.expiresAt <= now()) {
    approvedSourceContexts.delete(approval);
    return {
      kind: 'stale',
      reason: 'expired',
    };
  }

  const beforeCapture = await safelyInspectSource(
    sourceTabPort,
    envelope.source,
  );
  if (beforeCapture.kind !== 'available') {
    approvedSourceContexts.delete(approval);
    return beforeCapture.result;
  }

  let capturedContext: CapturedPageContext;
  try {
    capturedContext = await sourceTabPort.capture(envelope.source);
  } catch {
    const failureState = await classifyCaptureFailure(
      sourceTabPort,
      envelope.source,
    );
    if (failureState.kind !== 'failed') {
      approvedSourceContexts.delete(approval);
    }
    return failureState;
  }

  if (capturedContext.url !== envelope.source.url) {
    approvedSourceContexts.delete(approval);
    return {
      kind: 'stale',
      reason: 'navigated',
    };
  }

  const afterCapture = await safelyInspectSource(
    sourceTabPort,
    envelope.source,
  );
  if (afterCapture.kind !== 'available') {
    approvedSourceContexts.delete(approval);
    return afterCapture.result;
  }

  return {
    kind: 'captured',
    context: normalizeCapturedContext(capturedContext, now()),
  };
}

function isSupportedSource(source: SourceTabReference): boolean {
  if (
    !Number.isInteger(source.tabId)
    || !Number.isInteger(source.windowId)
    || source.tabId < 0
    || source.windowId < 0
  ) {
    return false;
  }

  try {
    const parsedUrl = new URL(source.url);
    return (
      (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:')
      && parsedUrl.origin === source.origin
    );
  } catch {
    return false;
  }
}

function isValidLaunchEnvelope(
  envelope: SourceTabLaunchEnvelope,
  launchId: string,
): boolean {
  return (
    envelope.version === 1
    && envelope.launchId === launchId
    && Number.isFinite(envelope.createdAt)
    && Number.isFinite(envelope.expiresAt)
    && envelope.createdAt <= envelope.expiresAt
  );
}

function freezeLaunchEnvelope(
  envelope: SourceTabLaunchEnvelope,
): SourceTabLaunchEnvelope {
  const source = Object.freeze({ ...envelope.source });
  return Object.freeze({
    ...envelope,
    source,
  });
}

function matchesSourceFingerprint(
  approvedSource: SourceTabReference,
  currentSource: SourceTabReference,
): boolean {
  return (
    approvedSource.tabId === currentSource.tabId
    && approvedSource.windowId === currentSource.windowId
    && approvedSource.url === currentSource.url
    && approvedSource.origin === currentSource.origin
  );
}

async function safelyInspectSource(
  sourceTabPort: SourceTabPort,
  approvedSource: SourceTabReference,
): Promise<
  | { kind: 'available' }
  | {
    kind: 'unavailable';
    result: Extract<SourceContextResult, { kind: 'unavailable' | 'stale' | 'failed' }>;
  }
> {
  let inspectedSource: SourceTabReference | null;
  try {
    inspectedSource = await sourceTabPort.inspect(approvedSource);
  } catch {
    return {
      kind: 'unavailable',
      result: {
        kind: 'failed',
        message: 'Harbor could not inspect the approved page.',
      },
    };
  }

  if (!inspectedSource) {
    return {
      kind: 'unavailable',
      result: {
        kind: 'unavailable',
        reason: 'closed',
      },
    };
  }

  if (!matchesSourceFingerprint(approvedSource, inspectedSource)) {
    return {
      kind: 'unavailable',
      result: {
        kind: 'stale',
        reason: 'navigated',
      },
    };
  }

  return { kind: 'available' };
}

async function classifyCaptureFailure(
  sourceTabPort: SourceTabPort,
  approvedSource: SourceTabReference,
): Promise<SourceContextResult> {
  const inspectedSource = await safelyInspectSource(
    sourceTabPort,
    approvedSource,
  );

  if (inspectedSource.kind !== 'available') {
    return inspectedSource.result;
  }

  return {
    kind: 'failed',
    message: 'Harbor could not read the approved page.',
  };
}

function normalizeCapturedContext(
  capturedContext: CapturedPageContext,
  fallbackCapturedAt: number,
): CapturedPageContext {
  return {
    title: capturedContext.title.trim(),
    url: capturedContext.url,
    text: capturedContext.text
      .replace(/\u0000/g, '')
      .trim()
      .slice(0, MAX_SOURCE_CONTEXT_CHARACTERS),
    capturedAt: Number.isFinite(capturedContext.capturedAt)
      ? capturedContext.capturedAt
      : fallbackCapturedAt,
  };
}
