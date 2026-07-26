import type {
  ApprovedChatIntent,
  ChatIntent,
  ChatPermissionScope,
  SourceContextPreview,
  SourceContextResult,
} from '../../contracts';
import type {
  ChatPermissionPort,
  SourceTabPort,
} from '../../services';
import {
  removeDeniedCapabilities,
} from '../intent/intent-state';
import {
  requestIntentPermissions,
  type PermissionApprovalOutcome,
} from '../intent/permission-coordinator';
import { buildPermissionPlan } from '../intent/permission-plan';
import {
  approveSourceContext,
  captureApprovedSourceContext,
  resolveSourceContext,
} from './source-context-coordinator';
import type { AvailableSourceContext } from './source-context-state';

export type ChatConsentOutcome =
  | { kind: 'approved'; approval: ApprovedChatIntent }
  | {
    kind: 'fallback';
    approval: ApprovedChatIntent;
    omitted: Array<'context' | 'tools'>;
    cause: 'denied' | 'dismissed' | 'unavailable' | 'stale';
  }
  | { kind: 'denied'; scopes: ChatPermissionScope[] }
  | { kind: 'dismissed' }
  | { kind: 'unavailable'; message: string }
  | { kind: 'stale'; reason: 'navigated' | 'expired' }
  | { kind: 'failed'; message: string };

export type ConsentContextCoordinator = {
  previewSource(): Promise<SourceContextPreview | null>;
  approveIntent(intent: ChatIntent): Promise<ChatConsentOutcome>;
};

export function createConsentContextCoordinator(options: {
  launchId: string;
  permissionPort: ChatPermissionPort;
  sourceTabPort: SourceTabPort;
  now?: () => number;
}): ConsentContextCoordinator {
  const now = options.now ?? Date.now;

  return {
    async previewSource() {
      const resolution = await resolveSourceContext(
        options.launchId,
        options.sourceTabPort,
        now,
      );
      return resolution.kind === 'available'
        ? resolution.preview
        : null;
    },

    async approveIntent(intent) {
      let sourceContext: AvailableSourceContext | null = null;
      let preflightFallback:
        | Extract<ChatConsentOutcome, { kind: 'fallback' }>
        | null = null;

      if (intent.context.mode === 'source') {
        const resolution = await resolveSourceContext(
          options.launchId,
          options.sourceTabPort,
          now,
        );

        if (resolution.kind === 'available') {
          sourceContext = resolution;
        } else {
          const fallbackResult = await approveWithoutSource(
            intent,
            resolution,
            options.permissionPort,
          );
          if (fallbackResult.kind !== 'approved') {
            return fallbackResult;
          }
          preflightFallback = {
            kind: 'fallback',
            approval: fallbackResult.approval,
            omitted: ['context'],
            cause: resolution.kind === 'stale' ? 'stale' : 'unavailable',
          };
        }
      }

      if (preflightFallback) {
        return preflightFallback;
      }

      const permissionOutcome = await requestIntentPermissions(
        intent,
        options.permissionPort,
      );
      const permissionResolution = resolvePermissionOutcome(
        intent,
        permissionOutcome,
      );

      if (permissionResolution.kind !== 'approved') {
        return permissionResolution;
      }

      if (
        permissionResolution.approval.intent.context.mode !== 'source'
        || !sourceContext
      ) {
        return permissionResolution;
      }

      const contextApproval = approveSourceContext(
        sourceContext,
        permissionResolution.approval.scopes,
      );
      if (!contextApproval) {
        return fallbackFromContextFailure(
          permissionResolution.approval,
          { kind: 'denied' },
        );
      }

      const contextResult = await captureApprovedSourceContext(
        contextApproval,
        options.sourceTabPort,
        now,
      );

      if (contextResult.kind === 'captured') {
        return {
          kind: 'approved',
          approval: {
            ...permissionResolution.approval,
            context: contextResult.context,
          },
        };
      }

      return fallbackFromContextFailure(
        permissionResolution.approval,
        contextResult,
      );
    },
  };
}

async function approveWithoutSource(
  intent: ChatIntent,
  sourceFailure: Exclude<
    Awaited<ReturnType<typeof resolveSourceContext>>,
    AvailableSourceContext
  >,
  permissionPort: ChatPermissionPort,
): Promise<ChatConsentOutcome> {
  const fallbackIntent: ChatIntent = {
    ...intent,
    context: { mode: 'off' },
  };
  const permissionOutcome = await requestIntentPermissions(
    fallbackIntent,
    permissionPort,
  );
  const resolvedPermission = resolvePermissionOutcome(
    fallbackIntent,
    permissionOutcome,
  );

  if (resolvedPermission.kind === 'approved') {
    return resolvedPermission;
  }

  if (sourceFailure.kind === 'failed') {
    return {
      kind: 'failed',
      message: sourceFailure.message,
    };
  }

  return resolvedPermission;
}

function resolvePermissionOutcome(
  intent: ChatIntent,
  permissionOutcome: PermissionApprovalOutcome,
): ChatConsentOutcome {
  switch (permissionOutcome.kind) {
    case 'granted':
      return {
        kind: 'approved',
        approval: createApprovedIntent(intent, permissionOutcome.scopes),
      };

    case 'partial': {
      if (!permissionOutcome.granted.includes('model:prompt')) {
        return {
          kind: 'denied',
          scopes: permissionOutcome.denied,
        };
      }

      const fallback = removeDeniedCapabilities(
        intent,
        permissionOutcome.denied,
      );
      const approvedScopes = scopesForIntent(
        fallback.intent,
        permissionOutcome.granted,
      );

      return {
        kind: 'fallback',
        approval: createApprovedIntent(fallback.intent, approvedScopes),
        omitted: fallback.omitted,
        cause: 'denied',
      };
    }

    case 'denied':
      return {
        kind: 'denied',
        scopes: permissionOutcome.scopes,
      };

    case 'dismissed':
      return fallbackFromInterruptedPermission(
        intent,
        permissionOutcome.granted,
        'dismissed',
      );

    case 'unavailable':
      return fallbackFromInterruptedPermission(
        intent,
        permissionOutcome.granted,
        'unavailable',
        permissionOutcome.message,
      );
  }
}

function fallbackFromInterruptedPermission(
  intent: ChatIntent,
  grantedScopes: ChatPermissionScope[],
  cause: 'dismissed' | 'unavailable',
  unavailableMessage?: string,
): ChatConsentOutcome {
  if (!grantedScopes.includes('model:prompt')) {
    return cause === 'dismissed'
      ? { kind: 'dismissed' }
      : {
        kind: 'unavailable',
        message: unavailableMessage
          ?? 'Harbor could not request access for this action.',
      };
  }

  const deniedScopes = buildPermissionPlan(intent).scopes.filter(
    (scope) => !grantedScopes.includes(scope),
  );
  const fallback = removeDeniedCapabilities(intent, deniedScopes);

  return {
    kind: 'fallback',
    approval: createApprovedIntent(
      fallback.intent,
      scopesForIntent(fallback.intent, grantedScopes),
    ),
    omitted: fallback.omitted,
    cause,
  };
}

function fallbackFromContextFailure(
  approval: ApprovedChatIntent,
  contextResult: Exclude<SourceContextResult, { kind: 'captured' }>,
): ChatConsentOutcome {
  const fallbackIntent: ChatIntent = {
    ...approval.intent,
    context: { mode: 'off' },
  };
  const fallbackApproval = createApprovedIntent(
    fallbackIntent,
    approval.scopes.filter(
      (scope) => scope !== 'browser:activeTab.read',
    ),
  );

  switch (contextResult.kind) {
    case 'denied':
      return {
        kind: 'fallback',
        approval: fallbackApproval,
        omitted: ['context'],
        cause: 'denied',
      };
    case 'dismissed':
      return {
        kind: 'fallback',
        approval: fallbackApproval,
        omitted: ['context'],
        cause: 'dismissed',
      };
    case 'unavailable':
      return {
        kind: 'fallback',
        approval: fallbackApproval,
        omitted: ['context'],
        cause: 'unavailable',
      };
    case 'stale':
      return {
        kind: 'fallback',
        approval: fallbackApproval,
        omitted: ['context'],
        cause: 'stale',
      };
    case 'failed':
      return {
        kind: 'failed',
        message: contextResult.message,
      };
  }
}

function createApprovedIntent(
  intent: ChatIntent,
  scopes: ChatPermissionScope[],
): ApprovedChatIntent {
  return {
    intent,
    scopes,
  };
}

function scopesForIntent(
  intent: ChatIntent,
  availableScopes: ChatPermissionScope[],
): ChatPermissionScope[] {
  const requiredScopes = new Set(buildPermissionPlan(intent).scopes);
  return availableScopes.filter((scope) => requiredScopes.has(scope));
}
