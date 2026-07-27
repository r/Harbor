import type {
  ChatIntent,
  ChatPermissionScope,
  PermissionDecision,
  PermissionPlan,
} from '../../contracts';
import type { ChatPermissionPort } from '../../services';
import { buildPermissionPlan } from './permission-plan';

export type PermissionApprovalOutcome =
  | { kind: 'granted'; scopes: ChatPermissionScope[] }
  | {
    kind: 'partial';
    granted: ChatPermissionScope[];
    denied: ChatPermissionScope[];
  }
  | { kind: 'denied'; scopes: ChatPermissionScope[] }
  | { kind: 'dismissed'; granted: ChatPermissionScope[] }
  | {
    kind: 'unavailable';
    granted: ChatPermissionScope[];
    message: string;
  };

export async function requestIntentPermissions(
  intent: ChatIntent,
  permissionPort: ChatPermissionPort,
): Promise<PermissionApprovalOutcome> {
  const plan = buildPermissionPlan(intent);

  let currentPermissions: Awaited<ReturnType<ChatPermissionPort['list']>>;
  try {
    currentPermissions = await permissionPort.list();
  } catch {
    return {
      kind: 'unavailable',
      granted: [],
      message: 'Harbor could not check access for this request.',
    };
  }

  const grantedScopes = plan.scopes.filter(
    (scope) => currentPermissions[scope] === 'granted',
  );
  const deniedScopes = plan.scopes.filter(
    (scope) => currentPermissions[scope] === 'denied',
  );

  if (deniedScopes.length > 0) {
    return grantedScopes.length > 0
      ? {
        kind: 'partial',
        granted: grantedScopes,
        denied: deniedScopes,
      }
      : {
        kind: 'denied',
        scopes: deniedScopes,
      };
  }

  const missingScopes = plan.scopes.filter(
    (scope) => currentPermissions[scope] !== 'granted',
  );
  const mustVerifyToolAllowlist = plan.toolAllowlist.length > 0;

  if (missingScopes.length === 0 && !mustVerifyToolAllowlist) {
    return {
      kind: 'granted',
      scopes: plan.scopes,
    };
  }

  const requestPlan: PermissionPlan = {
    ...plan,
    scopes: missingScopes.length > 0
      ? missingScopes
      : ['mcp:tools.call'],
  };

  let decision: PermissionDecision;
  try {
    decision = await permissionPort.request(requestPlan);
  } catch {
    return {
      kind: 'unavailable',
      granted: grantedScopes,
      message: 'Harbor could not request access for this action.',
    };
  }

  return mergePermissionDecision(plan, grantedScopes, decision);
}

function mergePermissionDecision(
  plan: PermissionPlan,
  previouslyGranted: ChatPermissionScope[],
  decision: PermissionDecision,
): PermissionApprovalOutcome {
  switch (decision.kind) {
    case 'granted':
      return {
        kind: 'granted',
        scopes: plan.scopes,
      };

    case 'partial': {
      const granted = uniquePlanScopes(
        plan,
        previouslyGranted,
        decision.granted,
      );
      const denied = uniquePlanScopes(plan, decision.denied);
      return denied.length === 0
        ? { kind: 'granted', scopes: granted }
        : { kind: 'partial', granted, denied };
    }

    case 'denied': {
      const denied = uniquePlanScopes(plan, decision.scopes);
      return previouslyGranted.length > 0
        ? {
          kind: 'partial',
          granted: uniquePlanScopes(plan, previouslyGranted),
          denied,
        }
        : {
          kind: 'denied',
          scopes: denied,
        };
    }

    case 'dismissed':
      return {
        kind: 'dismissed',
        granted: uniquePlanScopes(plan, previouslyGranted),
      };

    case 'unavailable':
      return {
        kind: 'unavailable',
        granted: uniquePlanScopes(plan, previouslyGranted),
        message: decision.message,
      };
  }
}

function uniquePlanScopes(
  plan: PermissionPlan,
  ...scopeGroups: ChatPermissionScope[][]
): ChatPermissionScope[] {
  const requestedScopes = new Set(plan.scopes);
  const includedScopes = new Set(scopeGroups.flat());
  return plan.scopes.filter(
    (scope) => requestedScopes.has(scope) && includedScopes.has(scope),
  );
}
