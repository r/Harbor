/**
 * Origin Grants
 *
 * Per-origin "Allow always / once / deny" decisions remembered from
 * prompts. The engine consults this at Tier 8 of the ladder; both the
 * policy file (Tiers 6–7) and the safety floor (Tiers 1–5) take precedence.
 *
 * Scope of this module:
 *   - Read: typed-action lookup, used by the engine's Tier 8 resolver.
 *   - Write: not handled here. Grants are written by the existing prompt
 *     flow in `permissions.ts`, which is migrated incrementally in
 *     subsequent commits.
 *
 * Storage compatibility: this module reads from the same
 * `harbor_origin_permissions` key as the legacy `permissions.ts`. We map
 * each typed action to one or more legacy scope strings; if any legacy
 * scope mapped to that typed action is granted, the action is granted.
 *
 * The mapping is intentionally one-way (typed → legacy[]): we know which
 * legacy scopes contributed to which typed action, but the engine never
 * thinks in legacy scopes again.
 */

import { browserAPI } from '../browser-compat';
import type { TypedAction } from './actions';
import type { OriginGrantOutcome, OriginGrantResolver, PolicyResource } from './engine';

// =============================================================================
// Storage shape (matches the legacy `permissions.ts` layout)
// =============================================================================

const PERMISSIONS_STORAGE_KEY = 'harbor_origin_permissions';

interface StoredPermission {
  grant: 'granted-once' | 'granted-always' | 'denied' | 'not-granted';
  grantedAt: number;
  expiresAt?: number;
  tabId?: number;
}

interface StoredOriginPermissions {
  origin: string;
  scopes: Record<string, StoredPermission>;
  allowedTools: string[];
}

// =============================================================================
// typed-action → legacy-scope mapping
// =============================================================================

/**
 * Each typed action maps to one or more legacy scope strings. If *any* of
 * the legacy scopes is granted, the typed action is treated as granted.
 *
 * This direction (typed → legacy) is the only one we need: the engine
 * works in typed actions, and the storage uses legacy scopes for now.
 *
 * Note: actions whose legacy form was never gated (e.g. local prompts,
 * which the legacy system did not distinguish from remote) map to the
 * closest equivalent. The `model.prompt.local` action maps to
 * `model:prompt`, but in practice the engine prefers info-flow checks
 * over origin grants for prompts so this rarely matters.
 */
const TYPED_TO_LEGACY: Partial<Record<TypedAction, readonly string[]>> = {
  'model.list': ['model:list'],
  'model.prompt.local': ['model:prompt'],
  'model.prompt.remote.firstParty': ['model:prompt'],
  'model.prompt.remote.thirdParty': ['model:prompt'],

  'tool.list': ['mcp:tools.list'],
  'tool.call': ['mcp:tools.call'],
  'mcp.server.register': ['mcp:servers.register'],

  'browser.read.activeTab': ['browser:activeTab.read'],
  'browser.read.element': ['browser:activeTab.read'],
  'browser.read.screenshot': ['browser:activeTab.screenshot'],
  'browser.read.tabs': ['browser:tabs.read'],
  'browser.write.interact': ['browser:activeTab.interact'],
  'browser.write.navigate': ['browser:navigate'],
  'browser.write.tabsCreate': ['browser:tabs.create'],

  'network.egress.same_origin': ['web:fetch'],
  'network.egress.cross_origin': ['web:fetch'],

  'agent.register': ['agents:register'],
  'agent.discover': ['agents:discover'],
  'agent.invoke': ['agents:invoke'],
  'agent.message': ['agents:message'],
  'agent.delegate.crossOrigin': ['agents:crossOrigin'],
  'agent.delegate.remote': ['agents:remote'],
  'agent.run': ['model:tools'],

  'chat.open': ['chat:open'],
};

// =============================================================================
// Lookup
// =============================================================================

async function loadOriginPermissions(origin: string): Promise<StoredOriginPermissions | null> {
  try {
    const result = await browserAPI.storage.local.get(PERMISSIONS_STORAGE_KEY);
    const all = (result[PERMISSIONS_STORAGE_KEY] || {}) as Record<string, StoredOriginPermissions>;
    return all[origin] || null;
  } catch {
    return null;
  }
}

function isStoredGrantLive(stored: StoredPermission, now: number, tabId?: number): boolean {
  if (stored.grant === 'granted-always') return true;
  if (stored.grant === 'granted-once') {
    if (stored.expiresAt && now > stored.expiresAt) return false;
    // "Allow once" covers only the tab that granted it (as isGrantValid in permissions.ts).
    if (stored.tabId !== undefined && tabId !== undefined && stored.tabId !== tabId) return false;
    return true;
  }
  return false;
}

/**
 * The engine's Tier 8 resolver. Returns:
 *   - { effect: 'allow', persistence } when any mapped legacy scope is granted
 *   - { effect: 'deny' } when any mapped legacy scope is explicitly denied
 *   - null when there's no opinion
 *
 * For `tool.call`, this also requires the specific tool to be in the
 * origin's `allowedTools` list — the legacy semantics carries through.
 */
export async function lookupOriginGrant(
  origin: string,
  action: TypedAction,
  resource?: PolicyResource,
  tabId?: number,
): Promise<OriginGrantOutcome | null> {
  const legacy = TYPED_TO_LEGACY[action];
  if (!legacy) return null;

  const stored = await loadOriginPermissions(origin);
  if (!stored) return null;

  const now = Date.now();

  // Tool-call short-circuit: if the tool isn't in the allowlist, we don't
  // grant regardless of the umbrella `mcp:tools.call` scope.
  if (action === 'tool.call' && resource?.tool) {
    if (!stored.allowedTools.includes(resource.tool)) {
      // If `mcp:tools.call` is denied at the origin, surface that;
      // otherwise just say "no opinion" so the engine continues to ask.
      const callScope = stored.scopes['mcp:tools.call'];
      if (callScope?.grant === 'denied') return { effect: 'deny' };
      return null;
    }
  }

  let sawDeny = false;
  let sawAllow = false;
  let persistence: 'always' | 'once' = 'once';

  for (const scope of legacy) {
    const entry = stored.scopes[scope];
    if (!entry) continue;
    if (entry.grant === 'denied') {
      sawDeny = true;
      continue;
    }
    if (isStoredGrantLive(entry, now, tabId)) {
      sawAllow = true;
      if (entry.grant === 'granted-always') persistence = 'always';
    }
  }

  if (sawDeny && !sawAllow) return { effect: 'deny' };
  if (sawAllow) return { effect: 'allow', persistence };
  return null;
}

/**
 * Convenience: the resolver function the engine wires up via
 * setOriginGrantResolver().
 */
export const originGrantResolver: OriginGrantResolver = (origin, action, resource, tabId) =>
  lookupOriginGrant(origin, action, resource, tabId);

// =============================================================================
// Test helpers
// =============================================================================

export const __testing = {
  TYPED_TO_LEGACY,
  PERMISSIONS_STORAGE_KEY,
};
