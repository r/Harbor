/**
 * Shared helper functions for request handlers.
 *
 * The single entry point handlers use is `requireAction(ctx, sender,
 * action, options)`, which routes through the PolicyEngine. The engine
 * walks the tier ladder and returns a decision; on `ask` or `preview`
 * we surface the existing prompt UI; on `allow` the handler proceeds; on
 * `deny` the handler emits a structured error response.
 */

import type { ApiErrorCode, PermissionScope } from '../types';
import type { RequestContext, ResponseSender } from './router-types';
import { evaluate, type PolicyResource, type PolicyDecision } from '../../policy/engine';
import type { TypedAction } from '../../policy/actions';
import type { LabelSet } from '../../policy/labels';
import { showPermissionPrompt } from '../../policy/permissions';
import { grantPermissions } from '../../policy/permissions';
import { Audit } from '../../policy/audit';

const DEBUG = false;

export function log(...args: unknown[]): void {
  if (DEBUG) {
    console.log('[Harbor Router]', ...args);
  }
}

// =============================================================================
// requireAction — the new typed-action gate
// =============================================================================

export interface RequireActionOptions {
  /** Resource descriptor for the action (host, server, tool, etc.). */
  resource?: PolicyResource;
  /** Labels carried on the input (from prior reads). */
  inputLabels?: LabelSet;
  /**
   * If the engine returns `ask` or `preview`, fall back to the legacy
   * prompt with this scope. When omitted, we derive a default from the
   * typed-action → legacy mapping; pass an explicit scope for handlers
   * whose prompt should ask the user about a different surface (e.g.
   * `agent.run` prompting for `model:tools`).
   */
  promptAsScope?: PermissionScope;
  /** Optional human-readable reason surfaced in the prompt. */
  reason?: string;
  /**
   * The caller already checked the origin's grant upstream. When the
   * verdict is an ask/preview that a per-origin grant would settle (Tier 8
   * or the Tier 9 default), proceed without a Harbor prompt and record the
   * upstream consent in the audit log. `deny` is still enforced, and so are
   * the asks that consent can't stand in for: a watchdog restriction and a
   * policy rule that says ask or preview. Those prompt as usual.
   *
   * Used for page calls, which the page API gates against Harbor's own
   * origin-grant store (`permissions.check`) before this second,
   * typed-action check runs.
   */
  upstreamConsent?: 'origin-grant';
  /** Record and match `resource.host` without classifying it (see PolicyRequest.classifyHost). */
  classifyHost?: boolean;
  /** Mark the audit record as a page's own fetch (see AuditRecord.pageFetch). */
  pageFetch?: boolean;
  /**
   * Never show a prompt: an ask or preview is a refusal. For a check with no
   * one to ask about, such as one site among a broadcast's recipients.
   */
  noPrompt?: boolean;
}

/** A permission refusal, in the shape a handler sends as its error. */
export interface ActionDenial {
  code: ApiErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * The single chokepoint the rest of the codebase calls. Returns `true` if
 * the action is allowed (either by the engine or after a successful
 * prompt). Returns `false` and sends an error response when the action is
 * denied, or when the caller stopped waiting before it could proceed.
 * Either way, after `requireAction` returns the handler's obligation
 * regarding permissioning is complete.
 */
export async function requireAction(
  ctx: RequestContext,
  sender: ResponseSender,
  action: TypedAction,
  options: RequireActionOptions = {},
): Promise<boolean> {
  const denial = await checkAction(ctx, action, options);
  if (!denial) return true;
  sender.sendResponse({ id: ctx.id, ok: false, error: denial });
  return false;
}

/**
 * The same check as `requireAction`, for a handler that runs several gated
 * steps inside one request. Returns `null` when the action may proceed, or
 * the refusal, without sending anything, so the handler can report it as
 * that step's failure.
 */
export async function checkAction(
  ctx: RequestContext,
  action: TypedAction,
  options: RequireActionOptions = {},
): Promise<ActionDenial | null> {
  log('requireAction', { origin: ctx.origin, action, options });

  const request = {
    origin: ctx.origin,
    action,
    resource: options.resource,
    inputLabels: options.inputLabels,
    reason: options.reason,
    correlationId: ctx.id,
    tabId: ctx.tabId,
    classifyHost: options.classifyHost,
  };
  const decision = await evaluate(request);
  const proceedsOnUpstreamConsent =
    options.upstreamConsent !== undefined &&
    decision.effect !== 'allow' &&
    decision.effect !== 'deny' &&
    upstreamConsentCovers(decision);
  // Every gated decision lands in the audit log. The activity feed,
  // watchdog, and decision simulator all read from here.
  Audit.record(
    request,
    decision,
    {
      ...(proceedsOnUpstreamConsent ? { consent: options.upstreamConsent } : {}),
      ...(options.pageFetch ? { pageFetch: true as const } : {}),
    },
  );

  log('requireAction decision', decision);

  // The caller may have stopped waiting while the check ran (a prompt can
  // stay open longer than a page's request timeout). Such a call isn't
  // performed, even if the person then allowed it.
  const proceed = (): ActionDenial | null => (ctx.signal?.aborted ? ABANDONED : null);

  if (decision.effect === 'allow') return proceed();

  if (decision.effect === 'deny') {
    return denialFor(decision);
  }

  if (proceedsOnUpstreamConsent) return proceed();
  if (options.noPrompt) return denialFor(decision);

  // ask | preview — surface the prompt via the existing flow.
  // We use the typed action's primary legacy scope unless the caller
  // overrides via options.promptAsScope.
  const scopeForPrompt = options.promptAsScope ?? primaryLegacyScope(action);
  if (!scopeForPrompt) {
    // No legacy mapping; treat as deny since we can't prompt yet.
    return denialFor(decision);
  }

  // agents:crossOrigin is granted per target site, so the prompt names the
  // site and a grant must cover it. With no target site there is nothing the
  // person could allow.
  const targetSite = scopeForPrompt === 'agents:crossOrigin' ? options.resource?.agentOrigin : undefined;
  if (scopeForPrompt === 'agents:crossOrigin' && !targetSite) {
    return denialFor(decision);
  }

  const promptReason = options.reason ?? decision.reason;
  const promptTools = options.resource?.tool ? [options.resource.tool] : undefined;
  const promptResult = targetSite
    ? await showPermissionPrompt(ctx.origin, [scopeForPrompt], promptReason, promptTools, undefined, [targetSite])
    : await showPermissionPrompt(ctx.origin, [scopeForPrompt], promptReason, promptTools);

  const coversTarget = !targetSite || (promptResult.agentOrigins ?? []).includes(targetSite);
  if (promptResult.granted && promptResult.grantType && coversTarget) {
    await grantPermissions(
      ctx.origin,
      [scopeForPrompt],
      promptResult.grantType,
      ctx.tabId,
      promptResult.allowedTools,
      // The backend the prompt itself named (model:prompt/model:tools
      // only; ignored for every other scope) — see
      // policy/permissions.ts's requestPermissions.
      promptResult.backendTag,
      // Only the site this call asked about: a merged prompt may have shown
      // other sites, which their own callers grant for their own tabs.
      targetSite ? [targetSite] : promptResult.agentOrigins,
    );
    return proceed();
  }

  // User dismissed or denied.
  return {
    code: 'ERR_PERMISSION_DENIED',
    message: promptResult.explicitDeny
      ? `User denied ${action}.`
      : `Permission "${action}" required.`,
    details: {
      action,
      tier: decision.tier,
      source: decision.source,
      reason: decision.reason,
    },
  };
}

const ABANDONED: ActionDenial = { code: 'ERR_ABORTED', message: 'The page stopped waiting for this call' };

/**
 * Whether consent obtained upstream can stand in for this verdict. It can
 * for a grant-level ask (no grant yet, or the default for the action's
 * effect). It can't when the watchdog has restricted the origin or a policy
 * rule asked for confirmation: the user or their admin wanted those seen.
 */
function upstreamConsentCovers(decision: PolicyDecision): boolean {
  if (decision.trace.some((step) => step.tier === 4 && step.outcome === 'ask')) return false;
  if (decision.rule) {
    // Judge the matched rule by its own effect: an allow rule can still end
    // in `preview` when the sensitivity gate forces one for irreversible
    // writes. The engine carries the effect, so ids needn't be unique.
    return decision.rule.effect === 'allow';
  }
  return true;
}


function denialFor(decision: PolicyDecision): ActionDenial {
  return {
    code: decision.errorCode ?? 'ERR_PERMISSION_DENIED',
    message: decision.reason,
    details: {
      tier: decision.tier,
      source: decision.source,
      rule: decision.rule,
    },
  };
}

// =============================================================================
// Typed-action → legacy-scope (for the prompt fallback)
// =============================================================================

/**
 * The primary legacy scope used to prompt for a typed action. Inverse of
 * the typed-to-legacy table in `policy/origin-grants.ts`, picking one
 * canonical scope per action.
 *
 * Returns `null` for typed actions that have no equivalent legacy scope
 * (e.g. `model.prompt.local` doesn't need a separate prompt; it inherits
 * the same UX as `model:prompt`).
 */
function primaryLegacyScope(action: TypedAction): PermissionScope | null {
  switch (action) {
    case 'model.list':
      return 'model:list';
    case 'model.prompt.local':
    case 'model.prompt.remote.firstParty':
    case 'model.prompt.remote.thirdParty':
    case 'model.prompt.agent':
      return 'model:prompt';

    case 'tool.list':
      return 'mcp:tools.list';
    case 'tool.call':
      return 'mcp:tools.call';
    case 'mcp.server.register':
      return 'mcp:servers.register';

    case 'browser.read.activeTab':
    case 'browser.read.element':
      return 'browser:activeTab.read';
    case 'browser.read.screenshot':
      return 'browser:activeTab.screenshot';
    case 'browser.read.tabs':
      return 'browser:tabs.read';
    case 'browser.write.interact':
      return 'browser:activeTab.interact';
    case 'browser.write.navigate':
      return 'browser:navigate';
    case 'browser.write.tabsCreate':
      return 'browser:tabs.create';

    case 'network.egress.same_origin':
    case 'network.egress.cross_origin':
      return 'web:fetch';

    case 'agent.register':
      return 'agents:register';
    case 'agent.discover':
      return 'agents:discover';
    case 'agent.invoke':
      return 'agents:invoke';
    case 'agent.message':
      return 'agents:message';
    case 'agent.delegate.crossOrigin':
      return 'agents:crossOrigin';
    case 'agent.delegate.remote':
      return 'agents:remote';
    case 'agent.run':
      return 'model:tools';

    case 'chat.open':
      return 'chat:open';
  }
}

