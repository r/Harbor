/**
 * Policy Store
 *
 * Loads and merges declarative policy documents from up to three sources:
 *
 *   1. **Managed** — `browser.storage.managed`, populated by an enterprise
 *      admin via Firefox `policies.json` or Chrome's enterprise policies.
 *      Firefox delivers `policy` as an object; Chrome's managed-storage
 *      schema format can't describe a rule document (no union types, and
 *      a rule's `action` is a string, array or object), so Chrome
 *      delivers it as a JSON string instead, which `loadManaged` parses.
 *      Highest precedence; cannot be overridden by the user.
 *   2. **User** — `browser.storage.local` under `harbor_policy_v2`,
 *      authored via the sidebar editor or imported as JSON.
 *   3. **Origin grants** (legacy "Allow always / once / deny" decisions).
 *      Lowest precedence. Compiled from `origin-grants.ts` into typed
 *      rules on load.
 *
 * The merge order is the same as the precedence order: managed first,
 * user second, origin grants third. The PolicyEngine evaluates rules
 * top-down within and across sources; the first match wins.
 *
 * See `docs/PERMISSIONS.md` (Part 1: How it works → "The policy file").
 */

import { browserAPI } from '../browser-compat';
import type { Rule, RuleEffect, CompiledRule } from './rules';
import { compileRule, parseDSLString } from './rules';

// =============================================================================
// Document schema
// =============================================================================

/**
 * The on-disk policy document. Both managed and user sources use this
 * schema; the engine merges them on load.
 */
export interface PolicyDocument {
  /** Schema version, for forward compatibility. */
  version: 2;
  /** Optional human-readable title. */
  title?: string;
  /** Rules in priority order. The first match wins. */
  rules?: Rule[];
  /** Convenience arrays — compiled to rules at load time. */
  allow?: (string | Rule)[];
  ask?: (string | Rule)[];
  deny?: (string | Rule)[];
  preview?: (string | Rule)[];
  /** Trusted-manifest pins. Loaded into the Pin registry by the engine. */
  pinnedManifests?: { serverId: string; hash: string }[];
  /** Publisher keys the user has accepted. */
  trustedPublishers?: {
    name: string;
    publicKey: string;
    algorithm: 'ed25519';
    allowedServerGlob?: string;
  }[];
}

// =============================================================================
// Storage keys
// =============================================================================

const USER_POLICY_KEY = 'harbor_policy_v2';

// =============================================================================
// Source loading
// =============================================================================

/**
 * Load the managed policy document. Returns `null` if no managed policy is
 * present. Errors are swallowed and treated as "no policy" — managed
 * storage may not be available in all browser contexts.
 *
 * Firefox's `policies.json` delivers `policy` as an object. Chrome's
 * `storage.managed_schema` has no way to describe a rule document (no
 * union types, and a rule's `action` can be a string, an array or an
 * object), so Chrome's schema (`extension/managed-schema.json`) declares
 * `policy` as a plain string, and an admin sets it to the document
 * serialized with `JSON.stringify`. A string that fails to parse, or
 * parses to something that isn't a version-2 document, is handled the
 * same as an invalid object document: treated as "no managed policy".
 */
async function loadManaged(): Promise<PolicyDocument | null> {
  try {
    if (!browserAPI.storage.managed) return null;
    const result = await browserAPI.storage.managed.get('policy');
    const raw = result.policy;
    const policy = (typeof raw === 'string' ? JSON.parse(raw) : raw ?? null) as PolicyDocument | null;
    return policy && policy.version === 2 ? policy : null;
  } catch {
    return null;
  }
}

/**
 * Load the user policy document from local storage.
 */
async function loadUser(): Promise<PolicyDocument | null> {
  try {
    const result = await browserAPI.storage.local.get(USER_POLICY_KEY);
    const raw = result[USER_POLICY_KEY];
    if (!raw) return null;
    if (typeof raw === 'string') {
      const parsed = JSON.parse(raw) as PolicyDocument;
      return parsed.version === 2 ? parsed : null;
    }
    const parsed = raw as PolicyDocument;
    return parsed.version === 2 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Save a user policy document. Validates the version field.
 */
export async function saveUserPolicy(doc: PolicyDocument): Promise<void> {
  if (doc.version !== 2) {
    throw new Error(`Unsupported policy version: ${doc.version}`);
  }
  await browserAPI.storage.local.set({ [USER_POLICY_KEY]: doc });
}

// =============================================================================
// Compilation
// =============================================================================

/**
 * Compile a "convenience array" entry to a typed rule. The entry may be
 * a string DSL form (`Tool(github.create_pr)`) or already a typed rule.
 */
function compileShorthand(
  entry: string | Rule,
  effect: RuleEffect,
  source: 'managed' | 'user' | 'originGrant',
  index: number,
): Rule | null {
  if (typeof entry === 'string') {
    const rule = parseDSLString(entry, effect, `${source}-${effect}-${index}`);
    if (!rule) {
      console.warn(`[Harbor Policy] Could not parse DSL string: ${entry}`);
      return null;
    }
    rule.source = source;
    rule.loadedAt = Date.now();
    return rule;
  }
  const rule: Rule = {
    ...entry,
    effect: entry.effect ?? effect,
    source,
    loadedAt: Date.now(),
  };
  return rule;
}

/**
 * Compile a `PolicyDocument` to an ordered array of compiled rules.
 *
 * Order within a source:
 *   1. `deny` array (typed `deny`)
 *   2. `ask` array
 *   3. `preview` array
 *   4. `allow` array
 *   5. Explicit `rules` array (in document order)
 *
 * The convenience arrays come first because they're the most common case
 * for site-author quick-fix rules. Explicit `rules` come last so they can
 * override the broader policy patterns.
 */
function compileDocument(
  doc: PolicyDocument,
  source: 'managed' | 'user' | 'originGrant',
): CompiledRule[] {
  const rules: Rule[] = [];

  if (doc.deny) {
    doc.deny.forEach((entry, i) => {
      const r = compileShorthand(entry, 'deny', source, i);
      if (r) rules.push(r);
    });
  }
  if (doc.ask) {
    doc.ask.forEach((entry, i) => {
      const r = compileShorthand(entry, 'ask', source, i);
      if (r) rules.push(r);
    });
  }
  if (doc.preview) {
    doc.preview.forEach((entry, i) => {
      const r = compileShorthand(entry, 'preview', source, i);
      if (r) rules.push(r);
    });
  }
  if (doc.allow) {
    doc.allow.forEach((entry, i) => {
      const r = compileShorthand(entry, 'allow', source, i);
      if (r) rules.push(r);
    });
  }
  if (doc.rules) {
    doc.rules.forEach((rule) => {
      rules.push({ ...rule, source, loadedAt: Date.now() });
    });
  }

  return rules.map(compileRule);
}

// =============================================================================
// Merged store
// =============================================================================

interface LoadedPolicy {
  managed: PolicyDocument | null;
  user: PolicyDocument | null;
  rules: CompiledRule[];
  loadedAt: number;
}

class PolicyStore {
  private loaded: LoadedPolicy = {
    managed: null,
    user: null,
    rules: [],
    loadedAt: 0,
  };

  private listeners = new Set<() => void>();

  /**
   * Load (or reload) policy from disk. Origin-grant rules are appended
   * separately by `appendOriginGrantRules` because they're computed
   * dynamically from the origin-grant store.
   */
  async load(): Promise<void> {
    const [managed, user] = await Promise.all([loadManaged(), loadUser()]);
    const compiled: CompiledRule[] = [];
    if (managed) compiled.push(...compileDocument(managed, 'managed'));
    if (user) compiled.push(...compileDocument(user, 'user'));

    this.loaded = {
      managed,
      user,
      rules: compiled,
      loadedAt: Date.now(),
    };

    this.notify();
  }

  /**
   * Replace the user policy document and reload.
   */
  async setUserPolicy(doc: PolicyDocument): Promise<void> {
    await saveUserPolicy(doc);
    await this.load();
  }

  /**
   * Get the merged, compiled rule list. Origin-grant rules are appended at
   * the end by the engine itself; this returns only the document rules.
   */
  rules(): readonly CompiledRule[] {
    return this.loaded.rules;
  }

  /** Subscribe to policy reloads. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Useful for diagnostics: the raw loaded documents and timing. */
  state(): Readonly<LoadedPolicy> {
    return this.loaded;
  }

  /** Test escape hatch: replace the loaded state without touching storage. */
  __setForTesting(rules: CompiledRule[]): void {
    this.loaded = {
      managed: null,
      user: null,
      rules,
      loadedAt: Date.now(),
    };
    this.notify();
  }

  /** Test escape hatch: clear the store. */
  __reset(): void {
    this.loaded = { managed: null, user: null, rules: [], loadedAt: 0 };
    this.listeners.clear();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        console.error('[Harbor Policy] Listener error:', err);
      }
    }
  }
}

// =============================================================================
// Singleton
// =============================================================================

export const Policy = new PolicyStore();

/**
 * Initialize the policy store. Called once from the background entry point.
 * Listens for storage changes so external edits (sidebar, MDM push) reload
 * automatically.
 */
export async function initializePolicyStore(): Promise<void> {
  await Policy.load();

  if (browserAPI.storage?.onChanged) {
    browserAPI.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && USER_POLICY_KEY in changes) {
        void Policy.load();
      }
      if (area === 'managed' && 'policy' in changes) {
        void Policy.load();
      }
    });
  }

  // Wire the origin-grant store into the engine's Tier 8 resolver. Done
  // here rather than at the engine module level to avoid a circular import
  // between the engine and the origin-grants module.
  const { setOriginGrantResolver, setWatchdogResolver } = await import('./engine');
  const { originGrantResolver } = await import('./origin-grants');
  setOriginGrantResolver(originGrantResolver);

  // Wire the watchdog into the engine's Tier 4 resolver and into the
  // audit log so it observes every decision the engine makes.
  const { Watchdog, attachWatchdogToAudit } = await import('./watchdog');
  setWatchdogResolver(Watchdog.resolve);
  attachWatchdogToAudit();

  console.log('[Harbor Policy] Loaded', Policy.rules().length, 'rules');
}

// =============================================================================
// Helpers exposed for testing
// =============================================================================

export const __testing = {
  compileDocument,
  compileShorthand,
};
