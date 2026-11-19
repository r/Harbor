/**
 * Backend-scoped grants (docs/ACP_BACKEND_DESIGN.md, docs/PERMISSIONS.md):
 * a `model:prompt` or `model:tools` *allow* records which backend —
 * Harbor's built-in model, or a configured ACP agent — it was given for,
 * and counts only while that backend is selected. A *deny* for these two
 * scopes is universal (maintainer decision, 2026-11-19): it applies
 * whatever backend is selected, including one that never had an allow of
 * its own. Every other scope is unaffected by any of this.
 *
 * Because a deny is universal but allows are per-backend, allows for a
 * backend-scoped scope are stored one per backend (`StoredPermissionLike.
 * allows`, keyed by backend tag) rather than as the single flat
 * `grant`/`backend` pair every other scope uses — switching to a second
 * backend and granting there must not overwrite the first backend's own
 * allow, and switching back must restore it. A deny clears every backend's
 * allow for that scope (`withUniversalDeny`): granting again under any one
 * backend starts that scope over from a clean slate (see `withBackendAllow`,
 * which only ever adds to, never resurrects, an existing `allows` map).
 *
 * A grant made before any of this existed (round 2) used the single flat
 * `backend` field — `effectiveGrantForBackend` reads that correctly, as
 * the given backend's own allow, for a stored entry that has no `allows`
 * map yet at all; and `withBackendAllow` migrates it into the map, under
 * the backend it actually names, the first time a *different* backend's
 * allow is granted — otherwise that first per-backend write would reset
 * the flat field and silently lose it.
 */
import type { PermissionGrant, PermissionScope } from '../agents/types';
import { readAgentBackendSetting } from '../page-api/agent-backend-setting';
import { browserAPI } from '../browser-compat';

/** `'builtin'`, or `acp:<agentId>` for a configured ACP agent. */
export type BackendTag = string;

const BACKEND_SCOPED_SCOPES: ReadonlySet<PermissionScope> = new Set(['model:prompt', 'model:tools']);

/** Whether a grant for `scope` is backend-scoped at all. */
export function isBackendScopedScope(scope: PermissionScope): boolean {
  return BACKEND_SCOPED_SCOPES.has(scope);
}

/** The tag to record for (or compare against) the currently selected backend. */
export function backendTagForSetting(setting: { type: 'acp'; agentId: string } | null): BackendTag {
  return setting ? `acp:${setting.agentId}` : 'builtin';
}

/** Reads `harbor_agent_backend` and returns the current backend's tag. */
export async function currentBackendTag(): Promise<BackendTag> {
  return backendTagForSetting(await readAgentBackendSetting());
}

/**
 * Whether a stored grant for `scope`, recorded under `storedBackend` (or
 * `undefined` for one made before this existed, which counts as
 * `'builtin'`), still counts given `currentBackend`. Always `true` for a
 * scope `isBackendScopedScope` says this doesn't apply to.
 */
export function grantMatchesBackend(
  scope: PermissionScope,
  storedBackend: BackendTag | undefined,
  currentBackend: BackendTag,
): boolean {
  if (!isBackendScopedScope(scope)) return true;
  return (storedBackend ?? 'builtin') === currentBackend;
}

// =============================================================================
// Per-backend allows, universal denies
// =============================================================================

export interface BackendAllowEntry {
  grant: 'granted-once' | 'granted-always';
  grantedAt: number;
  expiresAt?: number;
  tabId?: number;
}

/**
 * The shape both `policy/permissions.ts` and `policy/origin-grants.ts`
 * store under `harbor_origin_permissions`, widened just enough for this
 * module's own functions — each file keeps its own full interface (they
 * predate this module) but both satisfy this one.
 */
export interface StoredPermissionLike {
  grant: PermissionGrant;
  grantedAt: number;
  expiresAt?: number;
  tabId?: number;
  /** Round 2's single-backend field. Still read (as that backend's own allow) when `allows` is absent; never written by `withBackendAllow`. */
  backend?: string;
  /** Round 3+: one allow per backend, for `model:prompt`/`model:tools` only. */
  allows?: Record<string, BackendAllowEntry>;
}

/**
 * `'granted-always'` never expires and is never scoped to one tab — only
 * `'granted-once'` is (docs/PERMISSIONS.md). Matches the pre-existing
 * `isGrantValid`/`isStoredGrantLive` behaviour both permissions.ts and
 * origin-grants.ts had before they delegated here.
 */
function isLiveEntry(
  entry: { grant: 'granted-once' | 'granted-always'; expiresAt?: number; tabId?: number },
  now: number,
  tabId?: number,
): boolean {
  if (entry.grant === 'granted-always') return true;
  if (entry.expiresAt && now > entry.expiresAt) return false;
  if (entry.tabId !== undefined && tabId !== undefined && entry.tabId !== tabId) return false;
  return true;
}

/**
 * The effective grant for `scope` under `backendTag`, from the raw stored
 * entry (or `undefined` if there's none at all):
 *   - A universal deny (`stored.grant === 'denied'`) always applies,
 *     regardless of `scope` or `backendTag`.
 *   - For a scope `isBackendScopedScope` doesn't cover, this is exactly
 *     the old flat-grant behaviour — backend is never consulted.
 *   - For a backend-scoped scope, `backendTag`'s own entry in `allows` is
 *     read first; a stored entry with no `allows` map at all falls back
 *     to the round-2 flat `backend` field, treated as that one backend's
 *     own allow.
 */
export function effectiveGrantForBackend(
  stored: StoredPermissionLike | undefined,
  scope: PermissionScope,
  backendTag: BackendTag,
  now: number,
  tabId?: number,
): PermissionGrant {
  if (!stored) return 'not-granted';
  if (stored.grant === 'denied') return 'denied';

  if (!isBackendScopedScope(scope)) {
    const grant = stored.grant;
    if (grant !== 'granted-once' && grant !== 'granted-always') return 'not-granted';
    return isLiveEntry({ grant, expiresAt: stored.expiresAt, tabId: stored.tabId }, now, tabId) ? grant : 'not-granted';
  }

  const perBackend = stored.allows?.[backendTag];
  if (perBackend) {
    return isLiveEntry(perBackend, now, tabId) ? perBackend.grant : 'not-granted';
  }
  const grant = stored.grant;
  if (!stored.allows && (grant === 'granted-once' || grant === 'granted-always')) {
    if ((stored.backend ?? 'builtin') !== backendTag) return 'not-granted';
    return isLiveEntry({ grant, expiresAt: stored.expiresAt, tabId: stored.tabId }, now, tabId) ? grant : 'not-granted';
  }
  return 'not-granted';
}

/**
 * The updated stored entry after granting `scope` under `backendTag`. For
 * a scope `isBackendScopedScope` doesn't cover, this is the old flat
 * shape, unchanged. For a backend-scoped scope, the new allow is added to
 * `allows` (keeping every other backend's own entry exactly as it was),
 * and the top-level `grant` is reset to `'not-granted'`: for these two
 * scopes it no longer carries the allow itself, only a universal deny
 * ever will.
 *
 * The *first* write into the map migrates a still-live round-2 flat allow
 * (one with no `allows` map yet at all) into it, under the backend it was
 * actually given for — not the backend being granted now. Without this,
 * granting under a second backend for the first time would reset the flat
 * `grant` field to `'not-granted'` with nothing carried over, silently
 * losing the first backend's own allow: switching back to it would then
 * find neither the (now-cleared) flat field nor an `allows` entry of its
 * own. A deny, or an already-expired/never-granted flat entry, has
 * nothing worth migrating.
 */
export function withBackendAllow(
  existing: StoredPermissionLike | undefined,
  scope: PermissionScope,
  backendTag: BackendTag,
  grant: 'granted-once' | 'granted-always',
  now: number,
  options: { expiresAt?: number; tabId?: number } = {},
): StoredPermissionLike {
  if (!isBackendScopedScope(scope)) {
    return { grant, grantedAt: now, expiresAt: options.expiresAt, tabId: options.tabId };
  }
  const allows: Record<string, BackendAllowEntry> = { ...(existing?.allows ?? {}) };

  if (existing && !existing.allows) {
    const legacyGrant = existing.grant;
    if (legacyGrant === 'granted-once' || legacyGrant === 'granted-always') {
      const legacyTag = existing.backend ?? 'builtin';
      if (isLiveEntry({ grant: legacyGrant, expiresAt: existing.expiresAt, tabId: existing.tabId }, now) && !(legacyTag in allows)) {
        allows[legacyTag] = { grant: legacyGrant, grantedAt: existing.grantedAt, expiresAt: existing.expiresAt, tabId: existing.tabId };
      }
    }
  }

  allows[backendTag] = { grant, grantedAt: now, expiresAt: options.expiresAt, tabId: options.tabId };
  return { grant: 'not-granted', grantedAt: now, allows };
}

/**
 * The updated stored entry after denying `scope`: a universal deny, with
 * no per-backend allows left — a later grant under any one backend starts
 * that scope over from a clean slate, matching `withBackendAllow`'s own
 * initial-allow shape.
 */
export function withUniversalDeny(now: number): StoredPermissionLike {
  return { grant: 'denied', grantedAt: now };
}

// =============================================================================
// A direct, explicit-backend grant check (defence in depth)
// =============================================================================

const PERMISSIONS_STORAGE_KEY = 'harbor_origin_permissions';

/**
 * Whether `scope` is granted for `origin` under exactly `backendTag` —
 * never the backend currently selected, which a long-lived caller (an
 * open ACP text session, bound to one agent for its whole life) may have
 * long since moved on from. page-api/harbor-core.ts's
 * `isModelPromptGrantedForAgent` wraps this for acp-text-session.ts's own
 * per-turn check, alongside (not instead of) destroying every live ACP
 * text session on a backend switch (page-api/background.ts) — that's the
 * primary fix; this is the backstop if one somehow survives it.
 */
export async function isGrantedForBackend(
  origin: string,
  scope: PermissionScope,
  backendTag: BackendTag,
  tabId?: number,
): Promise<boolean> {
  try {
    const result = await browserAPI.storage.local.get(PERMISSIONS_STORAGE_KEY);
    const all = (result[PERMISSIONS_STORAGE_KEY] || {}) as Record<string, { scopes?: Record<string, StoredPermissionLike> }>;
    const entry = all[origin]?.scopes?.[scope];
    const effective = effectiveGrantForBackend(entry, scope, backendTag, Date.now(), tabId);
    return effective === 'granted-once' || effective === 'granted-always';
  } catch {
    return false;
  }
}
