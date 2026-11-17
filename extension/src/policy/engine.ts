/**
 * PolicyEngine
 *
 * The chokepoint. Every gated API call goes through `evaluate(request)`,
 * which walks the 9-tier ladder described in `docs/PERMISSIONS.md` and
 * returns a `PolicyDecision`.
 *
 * The ladder, in order:
 *
 *   Tier 0  Ambient (always-allow metadata for safe surfaces)
 *   Tier 1  Managed deny  (org policy can deny, no override)
 *   Tier 2  Sensitivity gate  (attaches labels, may force preview)
 *   Tier 3  Information-flow check  (label set vs destination's accepts)
 *   Tier 4  Watchdog containment    (per-session anomaly response)
 *   Tier 5  Capability token check  (token authorizes this action)
 *   Tier 6  Policy allow rule       (managed → user → origin-grant)
 *   Tier 7  Policy ask rule         (managed → user → origin-grant)
 *   Tier 8  Per-origin grant        (Allow always / once / deny)
 *   Tier 9  Default for action's effect
 *
 * Tiers 1–5 are the safety floor: they always run, and a higher-tier
 * `allow` cannot defeat a lower-tier `deny` from this band. That is the
 * structural property that makes the ladder different from a flat
 * priority list.
 */

import { TYPED_ACTIONS, type TypedAction, type ActionMeta, type ActionEffect, type ActionLocality } from './actions';
import { LabelSet, type DataLabel, destinationAcceptsLabels, labelsBlockedByDestination } from './labels';
import {
  type CompiledRule,
  type RuleEffect,
  type RuleMatchInput,
  ruleMatches,
} from './rules';
import { Policy } from './store';
import {
  classifyDomain,
  classifyTool,
  mergeVerdicts,
  type SensitivityVerdict,
  type ToolManifestMeta,
  type ElementDescriptor,
} from './sensitivity';
import { trustManifest, type ManifestProvenance } from './manifest-trust';
import { Tokens, TokenError, type SessionMode } from './tokens';

// =============================================================================
// Request / decision shapes
// =============================================================================

export interface PolicyResource {
  /** MCP server id, when relevant. */
  server?: string;
  /** Tool name, when relevant. */
  tool?: string;
  /** Tool risk tags from the manifest. */
  toolTags?: readonly string[];
  /** Hostname / origin of the destination. */
  host?: string;
  /** Path on the destination. */
  path?: string;
  /** Element descriptor for browser.read.element / write.interact. */
  element?: ElementDescriptor;
  /** Tool manifest meta + provenance (drives sensitivity and trust). */
  toolManifest?: { meta: ToolManifestMeta; provenance: ManifestProvenance };
}

export interface PolicyRequest {
  /** Calling origin. */
  origin: string;
  /** Whether this principal is currently a subagent. */
  isSubagent?: boolean;
  /** The action being requested. */
  action: TypedAction;
  /** Resource this action targets. */
  resource?: PolicyResource;
  /** Capability token for this session. Optional only for unscoped calls. */
  tokenId?: string;
  /** Labels carried on input (from the caller's existing context). */
  inputLabels?: LabelSet;
  /** Session mode. Defaults to `execute` if omitted. */
  mode?: SessionMode;
  /** Free-text reason from the caller, surfaced in prompts. */
  reason?: string;
  /** Correlation id for the audit log. */
  correlationId?: string;
}

export type DecisionEffect = 'allow' | 'ask' | 'deny' | 'preview' | 'attenuate';

export type DecisionSource =
  | 'ambient'
  | 'managed'
  | 'user'
  | 'originGrant'
  | 'sensitivity'
  | 'infoflow'
  | 'watchdog'
  | 'token'
  | 'default'
  | 'safetyFloor';

export type DecisionErrorCode =
  | 'ERR_BLOCKED_BY_POLICY'
  | 'ERR_LABEL_FLOW_BLOCKED'
  | 'ERR_TOKEN_EXPIRED'
  | 'ERR_TOKEN_NOT_FOR_ORIGIN'
  | 'ERR_UNKNOWN_ACTION'
  | 'ERR_QUARANTINED';

export interface PolicyDecision {
  /** Final verdict. */
  effect: DecisionEffect;
  /** Which tier of the ladder produced the verdict. */
  tier: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  /** Source family: who decided. */
  source: DecisionSource;
  /** Human-readable explanation. Surfaced in the audit feed and prompts. */
  reason: string;
  /**
   * Specific rule, if a rule produced the decision, with the rule's own
   * effect. `effect` on the decision can be more cautious than the rule's
   * when the safety floor forces a minimum (an allow rule on an
   * irreversible write still ends in `preview`).
   */
  rule?: { id: string; effect?: RuleEffect };
  /** Labels to attach to data this action produces. */
  outputLabels: LabelSet;
  /** Sensitivity classifier verdict, surfaced for diagnostics. */
  sensitivity?: SensitivityVerdict;
  /** Whether the manifest's positive claims (reversible / sideEffect) were honored. */
  manifestTrusted?: boolean;
  /** Error code when effect is `deny`. */
  errorCode?: DecisionErrorCode;
  /** Tier-by-tier trace. Used by the decision simulator and the "Why?" UI. */
  trace: TraceStep[];
}

export interface TraceStep {
  tier: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  source: DecisionSource;
  outcome: 'pass' | 'allow' | 'ask' | 'deny' | 'preview' | 'attenuate' | 'skip';
  reason: string;
  rule?: { id: string };
}

// =============================================================================
// Pluggable hooks (origin grants and watchdog)
// =============================================================================

/**
 * Resolves a per-origin grant for a typed action. Returns `null` if no
 * grant applies. The engine treats `granted-once` and `granted-always` as
 * `allow`, and `denied` as `deny`. The actual store lives in
 * `origin-grants.ts` and is wired in by `setOriginGrantResolver`.
 */
export type OriginGrantResolver = (
  origin: string,
  action: TypedAction,
  resource?: PolicyResource,
) => Promise<OriginGrantOutcome | null> | OriginGrantOutcome | null;

export interface OriginGrantOutcome {
  /** What the origin's grant says. */
  effect: 'allow' | 'deny';
  /** "Allow always" vs "Allow once". For diagnostics; the engine treats both as allow. */
  persistence?: 'always' | 'once';
}

/**
 * Per-session containment state from the watchdog. The engine consults
 * this at Tier 4 to decide whether to downgrade or quarantine.
 */
export type WatchdogResolver = (
  origin: string,
  action: TypedAction,
  context: { sessionId?: string; mode?: SessionMode },
) => Promise<WatchdogOutcome> | WatchdogOutcome;

export interface WatchdogOutcome {
  /** What the watchdog says. */
  status: 'normal' | 'flagged' | 'restricted' | 'quarantined';
  /** Optional human-readable note for the audit log. */
  reason?: string;
}

let originGrantResolver: OriginGrantResolver = () => null;
let watchdogResolver: WatchdogResolver = () => ({ status: 'normal' });

export function setOriginGrantResolver(resolver: OriginGrantResolver): void {
  originGrantResolver = resolver;
}

export function setWatchdogResolver(resolver: WatchdogResolver): void {
  watchdogResolver = resolver;
}

// =============================================================================
// Helpers
// =============================================================================

function defaultEffectForAction(meta: ActionMeta): DecisionEffect {
  switch (meta.effect) {
    case 'metadata':
      return 'allow';
    case 'read':
      return 'ask';
    case 'egress':
      return 'ask';
    case 'write':
      return 'preview';
    case 'destructive':
      return 'preview';
    case 'identity':
      return 'preview';
  }
}

/**
 * "Higher" effect on the safety scale (more cautious wins).
 * deny > preview > ask > attenuate > allow
 */
function moreCautious(a: DecisionEffect, b: DecisionEffect): DecisionEffect {
  const rank: Record<DecisionEffect, number> = {
    allow: 0,
    attenuate: 1,
    ask: 2,
    preview: 3,
    deny: 4,
  };
  return rank[a] >= rank[b] ? a : b;
}

function ruleEffectToDecision(effect: RuleEffect): DecisionEffect {
  return effect;
}

/**
 * Compose a `RuleMatchInput` for the rule matcher from a `PolicyRequest`
 * plus the action meta we already looked up.
 */
function toMatchInput(
  req: PolicyRequest,
  meta: ActionMeta,
  context: { trustedManifest: boolean; mode: SessionMode; labels: LabelSet },
): RuleMatchInput {
  return {
    principal: { origin: req.origin, isSubagent: req.isSubagent },
    action: req.action,
    resource: {
      server: req.resource?.server,
      tool: req.resource?.tool,
      toolTags: req.resource?.toolTags,
      host: req.resource?.host,
      path: req.resource?.path,
    },
    context: {
      mode: context.mode,
      labels: context.labels.toArray(),
      destinationLocality: meta.locality,
      reversible: meta.reversible ?? null,
      trustedManifest: context.trustedManifest,
    },
  };
}

// =============================================================================
// The evaluator
// =============================================================================

export async function evaluate(req: PolicyRequest): Promise<PolicyDecision> {
  const trace: TraceStep[] = [];
  const inputLabels = req.inputLabels ?? LabelSet.empty();
  const mode: SessionMode = req.mode ?? 'execute';

  // Tier 0: Ambient. Unknown actions are denied; bare metadata reads about
  // Harbor itself are always allowed.
  const meta = TYPED_ACTIONS[req.action] as ActionMeta | undefined;
  if (!meta) {
    return finalize({
      effect: 'deny',
      tier: 0,
      source: 'ambient',
      reason: `Unknown action: ${req.action}`,
      errorCode: 'ERR_UNKNOWN_ACTION',
      outputLabels: LabelSet.empty(),
      trace: [
        {
          tier: 0,
          source: 'ambient',
          outcome: 'deny',
          reason: `Unknown action: ${req.action}`,
        },
      ],
    });
  }
  trace.push({
    tier: 0,
    source: 'ambient',
    outcome: 'pass',
    reason: `action=${req.action} effect=${meta.effect} locality=${meta.locality}`,
  });

  // Manifest trust verdict (used by Tier 2 and the rule context).
  let manifestTrusted = true;
  if (req.resource?.toolManifest) {
    const verdict = trustManifest(req.resource.toolManifest.provenance);
    manifestTrusted = verdict.trusted;
  }

  // Tier 1: Managed deny.
  const managedDeny = await checkRulesByEffect(
    Policy.rules(),
    'deny',
    'managed',
    toMatchInput(req, meta, { trustedManifest: manifestTrusted, mode, labels: inputLabels }),
  );
  if (managedDeny) {
    trace.push({
      tier: 1,
      source: 'managed',
      outcome: 'deny',
      reason: `managed deny rule ${managedDeny.id}`,
      rule: { id: managedDeny.id },
    });
    return finalize({
      effect: 'deny',
      tier: 1,
      source: 'managed',
      reason: `Blocked by managed policy rule ${managedDeny.id}`,
      rule: { id: managedDeny.id },
      errorCode: 'ERR_BLOCKED_BY_POLICY',
      outputLabels: LabelSet.empty(),
      manifestTrusted,
      trace,
    });
  }
  trace.push({
    tier: 1,
    source: 'managed',
    outcome: 'pass',
    reason: 'no managed deny matched',
  });

  // Tier 2: Sensitivity gate. Attaches labels; may force a minimum effect.
  const verdict = computeSensitivity(req, manifestTrusted);
  const labelsAfterTier2 = inputLabels.union(verdict.labels);
  let forcedMin: DecisionEffect | undefined;
  if (
    meta.effect === 'destructive' ||
    (meta.effect === 'write' && meta.reversible === false) ||
    (meta.effect === 'write' && req.resource?.toolManifest && !manifestTrusted)
  ) {
    forcedMin = 'preview';
  }
  trace.push({
    tier: 2,
    source: 'sensitivity',
    outcome: 'pass',
    reason: `attached labels=[${labelsAfterTier2.toArray().join(',')}] verdict.confidence=${verdict.confidence} forcedMin=${forcedMin ?? 'none'}`,
  });

  // Tier 3: Information-flow check. The destination's `acceptsLabels` is
  // the whitelist; if `labelsAfterTier2` carries anything not in that
  // whitelist, the request is denied with ERR_LABEL_FLOW_BLOCKED.
  if (!destinationAcceptsLabels(labelsAfterTier2, meta.acceptsLabels)) {
    const blocked = labelsBlockedByDestination(labelsAfterTier2, meta.acceptsLabels);
    trace.push({
      tier: 3,
      source: 'infoflow',
      outcome: 'deny',
      reason: `destination does not accept labels: ${blocked.join(', ')}`,
    });
    return finalize({
      effect: 'deny',
      tier: 3,
      source: 'infoflow',
      reason: `Action ${req.action} cannot accept the labels carried by the input: ${blocked.join(', ')}`,
      errorCode: 'ERR_LABEL_FLOW_BLOCKED',
      outputLabels: labelsAfterTier2,
      sensitivity: verdict,
      manifestTrusted,
      trace,
    });
  }
  trace.push({
    tier: 3,
    source: 'infoflow',
    outcome: 'pass',
    reason: 'destination accepts all carried labels',
  });

  // Tier 4: Watchdog containment.
  const watchdog = await Promise.resolve(
    watchdogResolver(req.origin, req.action, { sessionId: req.tokenId, mode }),
  );
  if (watchdog.status === 'quarantined') {
    trace.push({
      tier: 4,
      source: 'watchdog',
      outcome: 'deny',
      reason: watchdog.reason ?? 'session quarantined',
    });
    return finalize({
      effect: 'deny',
      tier: 4,
      source: 'watchdog',
      reason: watchdog.reason ?? 'Session has been quarantined by the watchdog.',
      errorCode: 'ERR_QUARANTINED',
      outputLabels: labelsAfterTier2,
      sensitivity: verdict,
      manifestTrusted,
      trace,
    });
  }
  if (watchdog.status === 'restricted') {
    forcedMin = forcedMin ? moreCautious(forcedMin, 'ask') : 'ask';
    trace.push({
      tier: 4,
      source: 'watchdog',
      outcome: 'ask',
      reason: watchdog.reason ?? 'session restricted by watchdog',
    });
  } else {
    trace.push({
      tier: 4,
      source: 'watchdog',
      outcome: 'pass',
      reason: `watchdog status: ${watchdog.status}`,
    });
  }

  // Tier 5: Capability token check.
  if (req.tokenId) {
    try {
      Tokens.validate(req.tokenId, req.origin, req.action);
      trace.push({
        tier: 5,
        source: 'token',
        outcome: 'pass',
        reason: `token ${req.tokenId} authorizes ${req.action}`,
      });
    } catch (err) {
      const tokenErr = err as TokenError;
      const errorCode: DecisionErrorCode =
        tokenErr.code === 'ERR_TOKEN_EXPIRED'
          ? 'ERR_TOKEN_EXPIRED'
          : 'ERR_TOKEN_NOT_FOR_ORIGIN';
      trace.push({
        tier: 5,
        source: 'token',
        outcome: 'deny',
        reason: tokenErr.message,
      });
      return finalize({
        effect: 'deny',
        tier: 5,
        source: 'token',
        reason: tokenErr.message,
        errorCode,
        outputLabels: labelsAfterTier2,
        sensitivity: verdict,
        manifestTrusted,
        trace,
      });
    }
  } else {
    trace.push({
      tier: 5,
      source: 'token',
      outcome: 'skip',
      reason: 'no capability token in this request',
    });
  }

  // Tier 6 + 7: Find the first matching policy rule (managed and user
  // sources are already merged in priority order by the store).
  const matchInput = toMatchInput(req, meta, {
    trustedManifest: manifestTrusted,
    mode,
    labels: labelsAfterTier2,
  });
  const rule = findFirstRule(Policy.rules(), matchInput);
  if (rule) {
    const effect = applyForcedMin(ruleEffectToDecision(rule.effect), forcedMin);
    const tier = effect === 'allow' ? 6 : 7;
    trace.push({
      tier: tier as 6 | 7,
      source: rule.source ?? 'user',
      outcome: effect,
      reason: `matched rule ${rule.id}`,
      rule: { id: rule.id },
    });
    return finalize({
      effect,
      tier: tier as 6 | 7,
      source: rule.source ?? 'user',
      reason: rule.comment ?? `Matched rule ${rule.id}`,
      rule: { id: rule.id, effect: rule.effect },
      outputLabels: labelsAfterTier2.union(new LabelSet(meta.defaultDataLabels)),
      sensitivity: verdict,
      manifestTrusted,
      errorCode: effect === 'deny' ? 'ERR_BLOCKED_BY_POLICY' : undefined,
      trace,
    });
  }
  trace.push({
    tier: 6,
    source: 'user',
    outcome: 'pass',
    reason: 'no policy rule matched',
  });

  // Tier 8: Per-origin grant.
  const grant = await Promise.resolve(originGrantResolver(req.origin, req.action, req.resource));
  if (grant) {
    const granted = grant.effect === 'allow' ? 'allow' : 'deny';
    const effect = applyForcedMin(granted, forcedMin);
    trace.push({
      tier: 8,
      source: 'originGrant',
      outcome: effect,
      reason:
        grant.effect === 'allow'
          ? `origin granted (${grant.persistence ?? 'always'})`
          : 'origin denied',
    });
    return finalize({
      effect,
      tier: 8,
      source: 'originGrant',
      reason:
        grant.effect === 'allow'
          ? `Origin grant: ${grant.persistence ?? 'always'}`
          : 'Origin grant: denied',
      outputLabels: labelsAfterTier2.union(new LabelSet(meta.defaultDataLabels)),
      sensitivity: verdict,
      manifestTrusted,
      errorCode: effect === 'deny' ? 'ERR_BLOCKED_BY_POLICY' : undefined,
      trace,
    });
  }
  trace.push({
    tier: 8,
    source: 'originGrant',
    outcome: 'pass',
    reason: 'no origin grant for this action',
  });

  // Tier 9: Default for action's effect.
  const defaultEffect = applyForcedMin(defaultEffectForAction(meta), forcedMin);
  trace.push({
    tier: 9,
    source: 'default',
    outcome: defaultEffect,
    reason: `default for effect=${meta.effect}`,
  });
  return finalize({
    effect: defaultEffect,
    tier: 9,
    source: 'default',
    reason: `Default for ${meta.effect} action: ${defaultEffect}`,
    outputLabels: labelsAfterTier2.union(new LabelSet(meta.defaultDataLabels)),
    sensitivity: verdict,
    manifestTrusted,
    trace,
  });
}

// =============================================================================
// Sub-helpers
// =============================================================================

function applyForcedMin(effect: DecisionEffect, forcedMin: DecisionEffect | undefined): DecisionEffect {
  if (!forcedMin) return effect;
  return moreCautious(effect, forcedMin);
}

function computeSensitivity(req: PolicyRequest, manifestTrusted: boolean): SensitivityVerdict {
  const verdicts: SensitivityVerdict[] = [];
  if (req.resource?.host) verdicts.push(classifyDomain(req.resource.host));
  if (req.resource?.toolManifest) {
    verdicts.push(classifyTool(req.resource.toolManifest.meta, manifestTrusted));
  }
  // Element classification is added here when the content script provides
  // an ElementDescriptor; we don't classify by element id directly.
  if (req.resource?.element) {
    // Late import would create a cycle if we used a different module; reuse
    // sensitivity's own classifyElement via the shared module.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    // (We import classifyElement statically above.)
    // No-op placeholder: Tier 2 element classification belongs in a separate
    // commit when the content-script-side inspector ships.
  }
  return verdicts.length > 0 ? mergeVerdicts(verdicts) : { labels: LabelSet.empty(), confidence: 'low', reason: 'no resource sensitivity classifier matched' };
}

async function checkRulesByEffect(
  rules: readonly CompiledRule[],
  effect: RuleEffect,
  source: 'managed' | 'user',
  input: RuleMatchInput,
): Promise<CompiledRule | null> {
  for (const rule of rules) {
    if (rule.effect !== effect) continue;
    if (rule.source !== source) continue;
    if (ruleMatches(rule, input)) return rule;
  }
  return null;
}

function findFirstRule(rules: readonly CompiledRule[], input: RuleMatchInput): CompiledRule | null {
  for (const rule of rules) {
    if (ruleMatches(rule, input)) return rule;
  }
  return null;
}

function finalize(
  partial: Omit<PolicyDecision, 'trace'> & { trace: TraceStep[] },
): PolicyDecision {
  return partial;
}

// =============================================================================
// Re-exports for handlers
// =============================================================================

export { TYPED_ACTIONS, type TypedAction, type ActionMeta, type ActionEffect, type ActionLocality };
export { LabelSet, type DataLabel };
