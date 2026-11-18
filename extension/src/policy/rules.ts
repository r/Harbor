/**
 * Typed Policy Rules
 *
 * The PolicyEngine evaluates each request against an ordered list of rules.
 * A rule has an `effect` (allow / ask / deny / preview / attenuate), a
 * `principal` (who is asking), an `action` or set of actions, an optional
 * `resource` predicate, and an optional `context` predicate.
 *
 * Rules can be authored in two equivalent forms:
 *
 *   - **Typed JSON**, the canonical form. Stored in `harbor-policy.json`,
 *     emitted by the sidebar editor, evaluated as-is by the engine.
 *   - **String DSL**, syntactic sugar like `Tool(github.create_pr)` or
 *     `Egress(cross_origin)`. Compiled into typed rules on load.
 *
 * See `docs/PERMISSIONS.md` (Part 1: How it works → "The policy file") for
 * the user-facing description.
 */

import type { TypedAction } from './actions';
import { getActionMeta, isTypedAction, listTypedActions } from './actions';
import type { DataLabel } from './labels';

// =============================================================================
// Rule effect
// =============================================================================

/**
 * What does a matching rule do?
 *
 *   - `allow`: skip the prompt; the action proceeds.
 *   - `ask`: force a prompt even if other rules would have allowed.
 *   - `deny`: refuse, no prompt. The engine emits ERR_BLOCKED_BY_POLICY.
 *   - `preview`: show the user a diff of what's about to happen, then ask.
 *     Used for write/destructive actions where seeing the change matters
 *     more than seeing the request.
 *   - `attenuate`: allow, but downgrade the session's capability token
 *     (e.g. drop a label, shorten TTL, reduce budget).
 */
export type RuleEffect = 'allow' | 'ask' | 'deny' | 'preview' | 'attenuate';

// =============================================================================
// Principals, resources, contexts
// =============================================================================

/**
 * Who is making the request? At minimum we know the origin; future fields
 * can carry e.g. "subagent of session X" or "managed by org Y".
 */
export interface Principal {
  /** The origin asking. Supports `*` and suffix wildcards like `*.github.com`. */
  origin: string;
  /**
   * Whether the principal is currently a subagent delegated from another
   * session. Used by rules that want to be stricter about delegation.
   */
  isSubagent?: boolean;
}

/**
 * Action selector for a rule.
 *
 *   - A bare typed-action string (`"tool.call"`).
 *   - An array (`["tool.list", "tool.call"]`).
 *   - A glob (`"browser.read.*"`, `"*"`).
 *   - An effect-class shorthand (`{ effect: "egress" }`).
 */
export type ActionSelector =
  | TypedAction
  | TypedAction[]
  | string // wildcard / glob
  | { effect: 'metadata' | 'read' | 'egress' | 'write' | 'destructive' | 'identity' };

/**
 * Resource predicate. Action-specific keys; the matcher checks each
 * present key against the request's resource descriptor.
 *
 * Examples:
 *   - For `tool.call`: `{ server: "github", tool: "create_pr" }` or
 *     `{ server: "github", toolTags: ["remote_write"] }`.
 *   - For `browser.write.navigate`: `{ host: "*.example.com" }`.
 *   - For `network.egress.cross_origin`: `{ host: "api.openai.com" }`.
 */
export interface ResourcePredicate {
  /** MCP server id, supports wildcards. */
  server?: string;
  /** Specific tool name. */
  tool?: string;
  /** Match if any of these tags is present in the manifest's `riskTags`. */
  toolTags?: readonly string[];
  /** Host pattern, supports wildcards. */
  host?: string;
  /** Path pattern, supports wildcards. */
  path?: string;
  /** Other arbitrary keys for forward compatibility. */
  [key: string]: unknown;
}

/**
 * Context predicate. Conditions evaluated against the live request.
 *
 * The engine populates the `context` of every request with information like
 * the labels on the input, the destination locality, and so on. A rule can
 * match on any of those.
 */
export interface ContextPredicate {
  /** Match only if the input carries any of these labels. */
  hasAnyLabel?: readonly DataLabel[];
  /** Match only if the input carries all of these labels. */
  hasAllLabels?: readonly DataLabel[];
  /** Match only if the destination locality is one of these. */
  destinationLocality?: readonly (
    | 'local'
    | 'same_origin'
    | 'cross_origin'
    | 'network_first_party'
    | 'network_third_party'
  )[];
  /** Match only if the action's reversibility matches. */
  reversible?: boolean;
  /** Match only if the manifest source is trusted. */
  trustedManifest?: boolean;
}

// =============================================================================
// Rule
// =============================================================================

export interface Rule {
  /** Stable identifier, used in audit logs and the simulator. */
  id: string;
  /** What happens when this rule matches. */
  effect: RuleEffect;
  /** Whom this rule applies to. */
  principal: Principal;
  /** Which action(s) this rule applies to. */
  action: ActionSelector;
  /** Resource predicate; if absent, matches any resource. */
  resource?: ResourcePredicate;
  /** Context predicate; if absent, matches any context. */
  context?: ContextPredicate;
  /** When the rule was authored / loaded. Used for diagnostics. */
  loadedAt?: number;
  /** Where this rule came from — `managed`, `user`, `originGrant`. */
  source?: 'managed' | 'user' | 'originGrant';
  /** Optional human comment, surfaced in the activity feed. */
  comment?: string;
}

/**
 * The compiled, regex-friendly form the matcher uses internally.
 */
export interface CompiledRule extends Omit<Rule, 'principal' | 'action' | 'resource'> {
  principal: Principal & { originRegex: RegExp };
  /** Predicate over a typed action; compiled from `ActionSelector`. */
  matchesAction: (action: TypedAction) => boolean;
  resource?: ResourcePredicate & {
    serverRegex?: RegExp;
    toolRegex?: RegExp;
    hostRegex?: RegExp;
    pathRegex?: RegExp;
  };
}

// =============================================================================
// Compilation
// =============================================================================

/** Convert a glob (`*`, `*.example.com`) to an anchored RegExp. */
export function globToRegExp(pattern: string): RegExp {
  if (pattern === '*' || pattern === '') return /.*/;
  // Escape regex metacharacters EXCEPT `*`, then turn `*` into `.*`.
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function compileActionSelector(sel: ActionSelector): (action: TypedAction) => boolean {
  if (typeof sel === 'string') {
    if (sel === '*' || sel === '') return () => true;
    if (sel.includes('*')) {
      const re = globToRegExp(sel);
      return (a) => re.test(a);
    }
    if (isTypedAction(sel)) return (a) => a === sel;
    // Unknown literal — never matches. The store should warn at load time.
    return () => false;
  }
  if (Array.isArray(sel)) {
    const set = new Set(sel);
    return (a) => set.has(a);
  }
  // { effect: ... }
  const wantedEffect = sel.effect;
  const matching = new Set(
    listTypedActions().filter((a) => getActionMeta(a)?.effect === wantedEffect),
  );
  return (a) => matching.has(a);
}

/** Compile a rule for matching. */
export function compileRule(rule: Rule): CompiledRule {
  const originRegex = globToRegExp(rule.principal.origin);
  const matchesAction = compileActionSelector(rule.action);
  const resource = rule.resource
    ? {
        ...rule.resource,
        serverRegex: rule.resource.server ? globToRegExp(rule.resource.server) : undefined,
        toolRegex: rule.resource.tool ? globToRegExp(rule.resource.tool) : undefined,
        hostRegex: rule.resource.host ? globToRegExp(rule.resource.host) : undefined,
        pathRegex: rule.resource.path ? globToRegExp(rule.resource.path) : undefined,
      }
    : undefined;

  return {
    ...rule,
    principal: { ...rule.principal, originRegex },
    matchesAction,
    resource,
  };
}

// =============================================================================
// Matching
// =============================================================================

/**
 * The shape the engine produces for each request. The matcher consumes a
 * subset of these fields. Future commits flesh out the engine's full
 * `PolicyRequest`; this type is intentionally minimal here.
 */
export interface RuleMatchInput {
  principal: Principal;
  action: TypedAction;
  resource?: {
    server?: string;
    tool?: string;
    toolTags?: readonly string[];
    host?: string;
    path?: string;
  };
  context?: {
    labels?: readonly DataLabel[];
    destinationLocality?:
      | 'local'
      | 'same_origin'
      | 'cross_origin'
      | 'network_first_party'
      | 'network_third_party';
    reversible?: boolean | null;
    trustedManifest?: boolean;
  };
}

/** Whether a compiled rule matches a request. */
export function ruleMatches(rule: CompiledRule, input: RuleMatchInput): boolean {
  // Principal.
  if (!rule.principal.originRegex.test(input.principal.origin)) return false;
  if (rule.principal.isSubagent !== undefined) {
    if ((input.principal.isSubagent ?? false) !== rule.principal.isSubagent) return false;
  }

  // Action.
  if (!rule.matchesAction(input.action)) return false;

  // Resource.
  if (rule.resource) {
    const r = input.resource ?? {};
    if (rule.resource.serverRegex && !rule.resource.serverRegex.test(r.server ?? '')) {
      return false;
    }
    if (rule.resource.toolRegex && !rule.resource.toolRegex.test(r.tool ?? '')) {
      return false;
    }
    if (rule.resource.hostRegex && !rule.resource.hostRegex.test(r.host ?? '')) {
      return false;
    }
    if (rule.resource.pathRegex && !rule.resource.pathRegex.test(r.path ?? '')) {
      return false;
    }
    if (rule.resource.toolTags && rule.resource.toolTags.length > 0) {
      const have = new Set(r.toolTags ?? []);
      const overlap = rule.resource.toolTags.some((t) => have.has(t));
      if (!overlap) return false;
    }
  }

  // Context.
  if (rule.context) {
    const c = input.context ?? {};
    // Policy files can predate the removal of session modes. Every request
    // ran as 'execute' then, so a rule scoped to any other mode never
    // matched. Keep it that way rather than let it match everything.
    const staleMode = (rule.context as { mode?: unknown }).mode;
    if (staleMode !== undefined && staleMode !== 'execute') return false;
    if (rule.context.destinationLocality && c.destinationLocality) {
      if (!rule.context.destinationLocality.includes(c.destinationLocality)) return false;
    } else if (rule.context.destinationLocality) {
      return false;
    }
    if (rule.context.reversible !== undefined) {
      if (c.reversible !== rule.context.reversible) return false;
    }
    if (rule.context.trustedManifest !== undefined) {
      if ((c.trustedManifest ?? false) !== rule.context.trustedManifest) return false;
    }
    if (rule.context.hasAnyLabel && rule.context.hasAnyLabel.length > 0) {
      const have = new Set<string>(c.labels ?? []);
      const overlap = rule.context.hasAnyLabel.some((l) => have.has(l));
      if (!overlap) return false;
    }
    if (rule.context.hasAllLabels && rule.context.hasAllLabels.length > 0) {
      const have = new Set<string>(c.labels ?? []);
      const all = rule.context.hasAllLabels.every((l) => have.has(l));
      if (!all) return false;
    }
  }

  return true;
}

/**
 * Find the first matching rule from an ordered list, or `null`.
 * Order matters: managed → user → originGrant; within each tier, source order.
 */
export function findFirstMatchingRule(
  rules: readonly CompiledRule[],
  input: RuleMatchInput,
): CompiledRule | null {
  for (const rule of rules) {
    if (ruleMatches(rule, input)) return rule;
  }
  return null;
}

// =============================================================================
// String DSL parser
// =============================================================================

/**
 * Parse a string-DSL form into a typed `Rule`. Returns `null` if the input
 * doesn't match a known DSL pattern; callers should treat that as "use as
 * a typed rule directly".
 *
 * Recognized patterns:
 *
 *   - `Tool(server.tool)`              → `tool.call` on that server/tool
 *   - `Tool(server.*)`                  → any tool from that server
 *   - `Tool(*)`                         → any tool call
 *   - `Tool(*:remote_write)`            → any tool with the remote_write tag
 *   - `Read(*)`                         → any read effect
 *   - `Read(host)`                      → any read scoped to host
 *   - `Egress(local|same_origin|cross_origin|first_party|third_party)`
 *   - `Prompt(local|first_party|third_party)`
 *   - `Browser.Write(*)`                → any browser write effect
 *
 * The DSL is intentionally restrictive — anything more complex should be
 * authored as a typed rule.
 */
export function parseDSLString(input: string, baseEffect: RuleEffect, idHint: string): Rule | null {
  const trimmed = input.trim();
  const match = trimmed.match(/^(\w[\w.]*)\((.*)\)$/);
  if (!match) return null;

  const [, head, argRaw] = match;
  const arg = argRaw.trim();

  const id = `${idHint}:${trimmed}`;
  const principal: Principal = { origin: '*' };

  if (head === 'Tool') {
    return parseToolDSL(id, baseEffect, principal, arg);
  }
  if (head === 'Read') {
    return parseReadDSL(id, baseEffect, principal, arg);
  }
  if (head === 'Egress') {
    return parseEgressDSL(id, baseEffect, principal, arg);
  }
  if (head === 'Prompt') {
    return parsePromptDSL(id, baseEffect, principal, arg);
  }
  if (head === 'Browser.Write') {
    return parseBrowserWriteDSL(id, baseEffect, principal, arg);
  }
  return null;
}

function parseToolDSL(id: string, effect: RuleEffect, principal: Principal, arg: string): Rule {
  // arg forms:
  //   *           → all tool calls
  //   server.tool → specific server.tool
  //   server.*    → all tools from server
  //   *:tag       → any tool with this tag
  if (arg === '*' || arg === '') {
    return { id, effect, principal, action: 'tool.call' };
  }
  if (arg.includes(':')) {
    const [serverPart, tag] = arg.split(':', 2);
    return {
      id,
      effect,
      principal,
      action: 'tool.call',
      resource: {
        server: serverPart === '*' ? '*' : serverPart,
        toolTags: tag ? [tag] : undefined,
      },
    };
  }
  if (arg.includes('.')) {
    const dot = arg.lastIndexOf('.');
    const server = arg.slice(0, dot);
    const tool = arg.slice(dot + 1);
    return {
      id,
      effect,
      principal,
      action: 'tool.call',
      resource: { server, tool },
    };
  }
  return {
    id,
    effect,
    principal,
    action: 'tool.call',
    resource: { server: arg },
  };
}

function parseReadDSL(id: string, effect: RuleEffect, principal: Principal, arg: string): Rule {
  if (arg === '*' || arg === '') {
    return { id, effect, principal, action: { effect: 'read' } };
  }
  return {
    id,
    effect,
    principal,
    action: { effect: 'read' },
    resource: { host: arg },
  };
}

function parseEgressDSL(id: string, effect: RuleEffect, principal: Principal, arg: string): Rule {
  const localityMap: Record<string, NonNullable<ContextPredicate['destinationLocality']>[number]> = {
    local: 'local',
    same_origin: 'same_origin',
    cross_origin: 'cross_origin',
    first_party: 'network_first_party',
    third_party: 'network_third_party',
  };
  const locality = localityMap[arg];
  return {
    id,
    effect,
    principal,
    action: { effect: 'egress' },
    context: locality ? { destinationLocality: [locality] } : undefined,
  };
}

function parsePromptDSL(id: string, effect: RuleEffect, principal: Principal, arg: string): Rule {
  if (arg === 'local') {
    return { id, effect, principal, action: 'model.prompt.local' };
  }
  if (arg === 'first_party') {
    return { id, effect, principal, action: 'model.prompt.remote.firstParty' };
  }
  if (arg === 'third_party') {
    return { id, effect, principal, action: 'model.prompt.remote.thirdParty' };
  }
  return {
    id,
    effect,
    principal,
    action: ['model.prompt.local', 'model.prompt.remote.firstParty', 'model.prompt.remote.thirdParty'],
  };
}

function parseBrowserWriteDSL(
  id: string,
  effect: RuleEffect,
  principal: Principal,
  arg: string,
): Rule {
  if (arg === '*' || arg === '') {
    return { id, effect, principal, action: 'browser.write.interact' };
  }
  return {
    id,
    effect,
    principal,
    action: ['browser.write.interact', 'browser.write.navigate', 'browser.write.tabsCreate'],
    resource: { host: arg },
  };
}
