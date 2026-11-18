/**
 * Capability Tokens
 *
 * The runtime unit of authority. A token is opaque to callers — they hold
 * an ID; the engine resolves the token's contents internally. Tokens are
 * minted when a session is created or upgraded, attenuated when a session
 * delegates to a subagent, and validated on every gated action.
 *
 * Attenuation is the one operation worth dwelling on. A child token MUST
 * be a *strict subset* of its parent on every dimension: smaller (or
 * equal) `allowedActions`, smaller (or equal) `acceptedLabels`, smaller
 * (or equal) budgets, shorter (or equal) TTL. The engine refuses to mint
 * a child that widens any of these.
 *
 * See `docs/PERMISSIONS.md` (Part 1: How it works → "Sessions, capability
 * tokens, and modes") for the conceptual model.
 */

import type { TypedAction } from './actions';
import { isTypedAction } from './actions';
import type { DataLabel } from './labels';
import { isDataLabel } from './labels';

// =============================================================================
// Types
// =============================================================================

/**
 * Budgets that travel with the token. The engine decrements live counters
 * as actions occur; a token with an exhausted budget refuses further
 * actions in that category.
 *
 * Every budget field is optional: omitted means "no Harbor-imposed limit".
 */
export interface TokenBudgets {
  /** Maximum number of MCP tool calls. */
  toolCalls?: number;
  /** Maximum number of remote prompt tokens. */
  remotePromptTokens?: number;
  /** Maximum estimated USD spend on remote prompts. */
  remotePromptUsd?: number;
  /** Maximum number of navigations / new tabs. */
  navigations?: number;
  /** Maximum wall-clock duration the token is valid for, in ms. */
  wallClockMs?: number;
}

export interface CapabilityToken {
  /** Unforgeable identifier. */
  id: string;
  /** The session that holds this token. */
  sessionId: string;
  /** The origin this token is bound to. */
  origin: string;
  /** Parent token id (for delegation chains). Undefined for root tokens. */
  parentId?: string;
  /** Set of typed actions this token authorizes. */
  allowedActions: ReadonlySet<TypedAction>;
  /** Set of data labels this token's holder may handle. */
  acceptedLabels: ReadonlySet<DataLabel>;
  /** Budgets for this token. */
  budgets: TokenBudgets;
  /** Issuance timestamp (ms since epoch). */
  issuedAt: number;
  /** Expiration timestamp (ms since epoch). `Infinity` is permitted. */
  expiresAt: number;
  /** How many delegation links above the root. 0 for root, +1 each child. */
  attenuationDepth: number;
  /** Whether this token has been revoked. Set to true by revoke(). */
  revoked: boolean;
}

/**
 * Public, serializable view of a token. Tokens themselves never leave the
 * background context — handlers receive a `tokenId` from the session
 * registry and ask the engine to resolve it.
 */
export interface CapabilityTokenView {
  id: string;
  sessionId: string;
  origin: string;
  parentId?: string;
  allowedActions: TypedAction[];
  acceptedLabels: DataLabel[];
  budgets: TokenBudgets;
  issuedAt: number;
  expiresAt: number;
  attenuationDepth: number;
  revoked: boolean;
}

export interface MintTokenOptions {
  sessionId: string;
  origin: string;
  allowedActions: readonly TypedAction[];
  acceptedLabels: readonly DataLabel[];
  budgets?: TokenBudgets;
  /** TTL in ms; default 30 minutes. Pass `Infinity` for no expiration. */
  ttlMs?: number;
}

/**
 * Restrictions to apply when attenuating a parent token. Every field is
 * "intersect with parent": the engine intersects the requested set with
 * what the parent already had.
 */
export interface AttenuationRequest {
  sessionId: string;
  allowedActions?: readonly TypedAction[];
  acceptedLabels?: readonly DataLabel[];
  budgets?: TokenBudgets;
  /** TTL in ms relative to now. Cannot exceed parent's remaining TTL. */
  ttlMs?: number;
}

// =============================================================================
// Errors
// =============================================================================

export class TokenError extends Error {
  code: TokenErrorCode;
  constructor(code: TokenErrorCode, message: string) {
    // Prefix the message with the code so callers can match on either.
    super(`${code}: ${message}`);
    this.name = 'TokenError';
    this.code = code;
  }
}

export type TokenErrorCode =
  | 'ERR_TOKEN_NOT_FOUND'
  | 'ERR_TOKEN_EXPIRED'
  | 'ERR_TOKEN_REVOKED'
  | 'ERR_TOKEN_NOT_FOR_ORIGIN'
  | 'ERR_ATTENUATION_NOT_SUBSET';

// =============================================================================
// Validation helpers
// =============================================================================

function sanitizeBudgets(input: TokenBudgets | undefined): TokenBudgets {
  if (!input) return {};
  const out: TokenBudgets = {};
  if (input.toolCalls !== undefined && input.toolCalls >= 0) out.toolCalls = input.toolCalls;
  if (input.remotePromptTokens !== undefined && input.remotePromptTokens >= 0) {
    out.remotePromptTokens = input.remotePromptTokens;
  }
  if (input.remotePromptUsd !== undefined && input.remotePromptUsd >= 0) {
    out.remotePromptUsd = input.remotePromptUsd;
  }
  if (input.navigations !== undefined && input.navigations >= 0) out.navigations = input.navigations;
  if (input.wallClockMs !== undefined && input.wallClockMs >= 0) out.wallClockMs = input.wallClockMs;
  return out;
}

/** Intersect two budget objects: take the lower of each defined key. */
function intersectBudgets(parent: TokenBudgets, child: TokenBudgets): TokenBudgets {
  const out: TokenBudgets = { ...parent };
  for (const key of [
    'toolCalls',
    'remotePromptTokens',
    'remotePromptUsd',
    'navigations',
    'wallClockMs',
  ] as const) {
    const childVal = child[key];
    const parentVal = parent[key];
    if (childVal !== undefined) {
      if (parentVal !== undefined) {
        out[key] = Math.min(parentVal, childVal);
      } else {
        out[key] = childVal;
      }
    }
  }
  return out;
}

/** Whether `child` is a subset of `parent` for typed actions. */
function actionsSubset(parent: ReadonlySet<TypedAction>, child: ReadonlySet<TypedAction>): boolean {
  for (const a of child) {
    if (!parent.has(a)) return false;
  }
  return true;
}

/** Whether `child` is a subset of `parent` for data labels. */
function labelsSubset(parent: ReadonlySet<DataLabel>, child: ReadonlySet<DataLabel>): boolean {
  for (const l of child) {
    if (!parent.has(l)) return false;
  }
  return true;
}

// =============================================================================
// Registry
// =============================================================================

/**
 * In-memory token store. Tokens are ephemeral by design — agents must
 * re-request capabilities on extension restart.
 */
class TokenRegistry {
  private tokens = new Map<string, CapabilityToken>();

  /** Generate an unforgeable token id. */
  private newId(): string {
    return `tok_${crypto.randomUUID()}`;
  }

  /**
   * Mint a fresh root token.
   */
  mint(options: MintTokenOptions): CapabilityToken {
    const now = Date.now();
    const ttl = options.ttlMs ?? 30 * 60 * 1000;
    const token: CapabilityToken = {
      id: this.newId(),
      sessionId: options.sessionId,
      origin: options.origin,
      parentId: undefined,
      allowedActions: new Set(options.allowedActions.filter(isTypedAction)),
      acceptedLabels: new Set(options.acceptedLabels.filter(isDataLabel)),
      budgets: sanitizeBudgets(options.budgets),
      issuedAt: now,
      expiresAt: ttl === Infinity ? Number.POSITIVE_INFINITY : now + ttl,
      attenuationDepth: 0,
      revoked: false,
    };
    this.tokens.set(token.id, token);
    return token;
  }

  /**
   * Attenuate an existing token. The new token is always a strict subset
   * of the parent on every dimension. Throws `ERR_ATTENUATION_NOT_SUBSET`
   * if the request widens any dimension.
   */
  attenuate(parentId: string, req: AttenuationRequest): CapabilityToken {
    const parent = this.requireValid(parentId);

    let childActions: ReadonlySet<TypedAction>;
    if (req.allowedActions !== undefined) {
      const requested = new Set(req.allowedActions.filter(isTypedAction));
      if (!actionsSubset(parent.allowedActions, requested)) {
        throw new TokenError(
          'ERR_ATTENUATION_NOT_SUBSET',
          'Child token requests actions not granted by parent.',
        );
      }
      childActions = requested;
    } else {
      childActions = new Set(parent.allowedActions);
    }

    let childLabels: ReadonlySet<DataLabel>;
    if (req.acceptedLabels !== undefined) {
      const requested = new Set(req.acceptedLabels.filter(isDataLabel));
      if (!labelsSubset(parent.acceptedLabels, requested)) {
        throw new TokenError(
          'ERR_ATTENUATION_NOT_SUBSET',
          'Child token requests labels not accepted by parent.',
        );
      }
      childLabels = requested;
    } else {
      childLabels = new Set(parent.acceptedLabels);
    }

    const sanitizedReqBudgets = sanitizeBudgets(req.budgets);
    const childBudgets = intersectBudgets(parent.budgets, sanitizedReqBudgets);

    const now = Date.now();
    const parentRemaining = Math.max(0, parent.expiresAt - now);
    const requestedTtl = req.ttlMs ?? parentRemaining;
    const childTtl = Math.min(parentRemaining, requestedTtl);

    const child: CapabilityToken = {
      id: this.newId(),
      sessionId: req.sessionId,
      origin: parent.origin,
      parentId: parent.id,
      allowedActions: childActions,
      acceptedLabels: childLabels,
      budgets: childBudgets,
      issuedAt: now,
      expiresAt: now + childTtl,
      attenuationDepth: parent.attenuationDepth + 1,
      revoked: false,
    };
    this.tokens.set(child.id, child);
    return child;
  }

  /**
   * Validate that a token is usable for an origin / action. Returns the
   * token on success; throws `TokenError` otherwise.
   */
  validate(tokenId: string, origin: string, action: TypedAction): CapabilityToken {
    const token = this.requireValid(tokenId);
    if (token.origin !== origin) {
      throw new TokenError('ERR_TOKEN_NOT_FOR_ORIGIN', `Token bound to ${token.origin}, not ${origin}.`);
    }
    if (!token.allowedActions.has(action)) {
      throw new TokenError(
        'ERR_TOKEN_NOT_FOR_ORIGIN',
        `Token does not authorize ${action}.`,
      );
    }
    return token;
  }

  /** Look up a token by id. */
  get(tokenId: string): CapabilityToken | undefined {
    return this.tokens.get(tokenId);
  }

  /**
   * Revoke a token. Children are NOT automatically revoked here; callers
   * should revoke the chain explicitly via `revokeWithDescendants`. The
   * optional `reason` is purely advisory — it's logged and ignored by the
   * engine — so callers can label "why" without changing semantics.
   */
  revoke(tokenId: string, reason?: string): boolean {
    const token = this.tokens.get(tokenId);
    if (!token) return false;
    token.revoked = true;
    if (reason) {
      console.log('[TokenRegistry] Revoked', tokenId, 'reason:', reason);
    }
    return true;
  }

  /** Revoke a token and every descendant. */
  revokeWithDescendants(tokenId: string): number {
    const token = this.tokens.get(tokenId);
    if (!token) return 0;
    let count = 0;
    const queue: string[] = [tokenId];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const t = this.tokens.get(current);
      if (!t) continue;
      if (!t.revoked) {
        t.revoked = true;
        count++;
      }
      // Find children.
      for (const candidate of this.tokens.values()) {
        if (candidate.parentId === current && !seen.has(candidate.id)) {
          queue.push(candidate.id);
        }
      }
    }
    return count;
  }

  /**
   * Drop expired tokens from the registry. Returns the number removed.
   */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, token] of this.tokens) {
      if (token.expiresAt <= now || token.revoked) {
        this.tokens.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /** Number of live tokens. For diagnostics and tests. */
  size(): number {
    return this.tokens.size;
  }

  /** Convert a token to its serializable view. */
  toView(token: CapabilityToken): CapabilityTokenView {
    return {
      id: token.id,
      sessionId: token.sessionId,
      origin: token.origin,
      parentId: token.parentId,
      allowedActions: [...token.allowedActions].sort() as TypedAction[],
      acceptedLabels: [...token.acceptedLabels].sort() as DataLabel[],
      budgets: { ...token.budgets },
      issuedAt: token.issuedAt,
      expiresAt: token.expiresAt,
      attenuationDepth: token.attenuationDepth,
      revoked: token.revoked,
    };
  }

  /** Reset the registry. Used in tests. */
  __reset(): void {
    this.tokens.clear();
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  private requireValid(tokenId: string): CapabilityToken {
    const token = this.tokens.get(tokenId);
    if (!token) throw new TokenError('ERR_TOKEN_NOT_FOUND', `No such token: ${tokenId}`);
    if (token.revoked) throw new TokenError('ERR_TOKEN_REVOKED', `Token ${tokenId} has been revoked.`);
    if (Date.now() > token.expiresAt) {
      throw new TokenError('ERR_TOKEN_EXPIRED', `Token ${tokenId} has expired.`);
    }
    return token;
  }
}

// =============================================================================
// Singleton
// =============================================================================

export const Tokens = new TokenRegistry();
