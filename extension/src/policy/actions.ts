/**
 * Typed Action Registry
 *
 * The PolicyEngine evaluates every API call as a *typed action* of the form
 * `verb.noun.qualifier`. This file is the single source of truth for the set
 * of typed actions Harbor knows about and the metadata each action carries.
 *
 * See `docs/PERMISSIONS.md` (Part 1: How it works → "Typed actions and effects")
 * for the conceptual model. The fields here mirror the `ActionMeta` shape
 * documented there.
 */

import type { DataLabel } from './labels';

// =============================================================================
// Effect, Locality, Sensitivity dimensions
// =============================================================================

/**
 * What kind of state change does this action produce?
 *
 * Tiers below `egress` are bounded to the user's device or to the calling
 * origin. Tiers `egress` and above can change something the user observes
 * outside Harbor's process.
 */
export type ActionEffect =
  /** No risk per call (listing, discovery). Defaults toward `allow`. */
  | 'metadata'
  /** Read content. Origin-bound by default. */
  | 'read'
  /** Send data off-device or cross-origin. Always label-checked. */
  | 'egress'
  /** Change state on the user's device or in the user's session. Defaults to preview. */
  | 'write'
  /** Not reversible — destructive writes (delete, send, transfer). */
  | 'destructive'
  /** Claims something about who the user is — login, signature, identity assertion. */
  | 'identity';

/**
 * Where does this action's data flow live?
 *
 * `local` and `same_origin` never leave the device or the calling origin's
 * boundary. `network_first_party` contacts the *user's* configured provider
 * (e.g. Ollama, the user's OpenAI account). `network_third_party` contacts a
 * provider chosen by the page (the asymmetric case the threat model cares
 * about most).
 */
export type ActionLocality =
  | 'local'
  | 'same_origin'
  | 'cross_origin'
  | 'network_first_party'
  | 'network_third_party';

/**
 * Lifetime of a default grant for this action when the user says "yes".
 *
 * `one_call` means a fresh prompt every invocation. `session` lasts only
 * until the agent session ends. `until_origin_unloads` lasts as long as the
 * page is open. `until_user_revokes` is what we used to call "Allow always".
 *
 * Read-class actions default to `session` — the doc explicitly calls out
 * that we no longer make persistent grants the easy default for reads.
 */
export type ActionDefaultTTL =
  | 'one_call'
  | 'session'
  | 'until_origin_unloads'
  | 'until_user_revokes';

// =============================================================================
// ActionMeta
// =============================================================================

/**
 * Metadata carried by every typed action.
 */
export interface ActionMeta {
  /** Short title shown in prompts and the policy editor. */
  title: string;
  /** One-sentence explanation aimed at end users. */
  description: string;
  /** What kind of state change this action produces. */
  effect: ActionEffect;
  /** Where the data flow lives. */
  locality: ActionLocality;
  /**
   * Whether the side effect is reversible.
   * `null` for actions that have no side effect (`metadata`, `read`).
   */
  reversible: boolean | null;
  /**
   * Labels this action can *attach* to data it produces. For example,
   * `browser.read.activeTab` may attach `confidential` if the page is
   * recognized as a private workspace.
   */
  defaultDataLabels: readonly DataLabel[];
  /**
   * Labels the action accepts on input. If a request carries a label not in
   * this set, the engine treats it as `ERR_LABEL_FLOW_BLOCKED` at Tier 3.
   */
  acceptsLabels: readonly DataLabel[];
  /** TTL applied to a default `Allow` grant for this action. */
  defaultTTL: ActionDefaultTTL;
}

// =============================================================================
// Registry
// =============================================================================

/**
 * The typed-action registry. Adding a new action is a code change in this
 * file, plus a `requireAction(...)` call in the handler. See
 * `docs/PERMISSIONS.md` → "Adding a new typed action" for the recipe.
 */
export const TYPED_ACTIONS = {
  // ---------------------------------------------------------------------------
  // model.* — the LLM surface
  // ---------------------------------------------------------------------------
  'model.list': {
    title: 'List configured providers',
    description: 'See which AI providers and models are available on this device.',
    effect: 'metadata',
    locality: 'local',
    reversible: null,
    defaultDataLabels: [],
    acceptsLabels: [],
    defaultTTL: 'until_user_revokes',
  },
  'model.prompt.local': {
    title: 'Prompt a local model',
    description: 'Run a prompt against a model running on this device. No network egress.',
    effect: 'read',
    locality: 'local',
    reversible: null,
    defaultDataLabels: [],
    // Local prompts can carry confidential / regulated input safely; they don't egress.
    acceptsLabels: ['credentials', 'payments', 'identity', 'regulated', 'confidential'],
    defaultTTL: 'session',
  },
  'model.prompt.remote.firstParty': {
    title: 'Prompt a first-party remote model',
    description: 'Run a prompt against a remote model the user configured (their own provider account).',
    effect: 'egress',
    locality: 'network_first_party',
    reversible: null,
    defaultDataLabels: [],
    // First-party providers are trusted by the user — confidential allowed, but not credentials.
    acceptsLabels: ['confidential'],
    defaultTTL: 'session',
  },
  'model.prompt.remote.thirdParty': {
    title: 'Prompt a third-party remote model',
    description: 'Run a prompt against a remote model the *page* chose. Data leaves the user\'s control.',
    effect: 'egress',
    locality: 'network_third_party',
    reversible: null,
    defaultDataLabels: [],
    // Third-party providers should never see labeled content by default.
    acceptsLabels: [],
    defaultTTL: 'one_call',
  },

  // ---------------------------------------------------------------------------
  // tool.* — MCP tool surface
  // ---------------------------------------------------------------------------
  'tool.list': {
    title: 'List available tools',
    description: 'See the list of tools from connected MCP servers.',
    effect: 'metadata',
    locality: 'local',
    reversible: null,
    defaultDataLabels: [],
    acceptsLabels: [],
    defaultTTL: 'until_user_revokes',
  },
  'tool.call': {
    title: 'Call a tool',
    description: 'Invoke a specific MCP tool. Effect depends on the tool itself.',
    // Worst case is destructive; specific tools narrow this via manifest meta.
    effect: 'write',
    locality: 'cross_origin',
    reversible: false,
    defaultDataLabels: [],
    acceptsLabels: [],
    defaultTTL: 'session',
  },
  'mcp.server.register': {
    title: 'Register an MCP server',
    description: 'Allow this site to register its own MCP server with Harbor.',
    effect: 'write',
    locality: 'local',
    reversible: true,
    defaultDataLabels: [],
    acceptsLabels: [],
    defaultTTL: 'until_user_revokes',
  },

  // ---------------------------------------------------------------------------
  // browser.* — browser surface
  // ---------------------------------------------------------------------------
  'browser.read.activeTab': {
    title: 'Read the current page',
    description: 'Extract readable text content from the page the user is on.',
    effect: 'read',
    locality: 'same_origin',
    reversible: null,
    // Reading can attach labels — the sensitivity classifier decides which.
    defaultDataLabels: ['confidential'],
    acceptsLabels: [],
    defaultTTL: 'session',
  },
  'browser.read.element': {
    title: 'Inspect an element',
    description: 'Read a specific DOM element by selector. Used by `agent.inspectElement()`.',
    effect: 'read',
    locality: 'same_origin',
    reversible: null,
    defaultDataLabels: ['confidential'],
    acceptsLabels: [],
    defaultTTL: 'session',
  },
  'browser.read.screenshot': {
    title: 'Take a screenshot',
    description: 'Capture an image of the current tab.',
    effect: 'read',
    locality: 'same_origin',
    reversible: null,
    defaultDataLabels: ['confidential'],
    acceptsLabels: [],
    defaultTTL: 'session',
  },
  'browser.read.tabs': {
    title: 'List open tabs',
    description: 'See URLs and titles of open tabs (metadata only, not content).',
    effect: 'read',
    locality: 'local',
    reversible: null,
    defaultDataLabels: [],
    acceptsLabels: [],
    defaultTTL: 'session',
  },
  'browser.write.interact': {
    title: 'Interact with the page',
    description: 'Click, fill forms, scroll, and select on the current page.',
    effect: 'write',
    locality: 'same_origin',
    reversible: false,
    defaultDataLabels: [],
    // Interaction can carry credentials onto the page (autofill-style flows).
    acceptsLabels: ['credentials', 'payments'],
    defaultTTL: 'session',
  },
  'browser.write.navigate': {
    title: 'Navigate this tab',
    description: 'Change the URL of the current tab.',
    effect: 'write',
    locality: 'same_origin',
    reversible: true,
    defaultDataLabels: [],
    acceptsLabels: [],
    defaultTTL: 'session',
  },
  'browser.write.tabsCreate': {
    title: 'Open and control new tabs',
    description: 'Create a new tab and operate on tabs it created (read, interact, navigate, close).',
    effect: 'write',
    locality: 'cross_origin',
    reversible: true,
    defaultDataLabels: [],
    acceptsLabels: [],
    defaultTTL: 'session',
  },

  // ---------------------------------------------------------------------------
  // network.egress.* — network surface
  // ---------------------------------------------------------------------------
  'network.egress.same_origin': {
    title: 'Fetch from same origin',
    description: 'Make a network request to the calling origin.',
    effect: 'egress',
    locality: 'same_origin',
    reversible: null,
    defaultDataLabels: [],
    acceptsLabels: ['confidential'],
    defaultTTL: 'session',
  },
  'network.egress.cross_origin': {
    title: 'Fetch from another origin',
    description: 'Make a network request to a different origin via the extension proxy.',
    effect: 'egress',
    locality: 'cross_origin',
    reversible: null,
    defaultDataLabels: [],
    acceptsLabels: [],
    defaultTTL: 'one_call',
  },

  // ---------------------------------------------------------------------------
  // agent.* — multi-agent surface
  // ---------------------------------------------------------------------------
  'agent.register': {
    title: 'Register as an agent',
    description: 'Make this page discoverable as an agent that other agents can call.',
    effect: 'write',
    locality: 'local',
    reversible: true,
    defaultDataLabels: [],
    acceptsLabels: [],
    defaultTTL: 'until_origin_unloads',
  },
  'agent.discover': {
    title: 'Discover other agents',
    description: 'List registered agents.',
    effect: 'metadata',
    locality: 'local',
    reversible: null,
    defaultDataLabels: [],
    acceptsLabels: [],
    defaultTTL: 'session',
  },
  'agent.invoke': {
    title: 'Invoke another agent',
    description: 'Call another registered agent on this device.',
    effect: 'write',
    locality: 'local',
    reversible: false,
    defaultDataLabels: [],
    acceptsLabels: [],
    defaultTTL: 'session',
  },
  'agent.message': {
    title: 'Message another agent',
    description: 'Send and receive messages with another agent.',
    effect: 'write',
    locality: 'local',
    reversible: false,
    defaultDataLabels: [],
    acceptsLabels: [],
    defaultTTL: 'session',
  },
  'agent.delegate.crossOrigin': {
    title: 'Delegate to a cross-origin agent',
    description: 'Hand work to an agent registered by a different site.',
    effect: 'egress',
    locality: 'cross_origin',
    reversible: false,
    defaultDataLabels: [],
    acceptsLabels: [],
    defaultTTL: 'one_call',
  },
  'agent.delegate.remote': {
    title: 'Delegate to a remote agent',
    description: 'Hand work to an A2A agent running on a remote server.',
    effect: 'egress',
    locality: 'network_third_party',
    reversible: false,
    defaultDataLabels: [],
    acceptsLabels: [],
    defaultTTL: 'one_call',
  },
  'agent.run': {
    title: 'Run an autonomous agent loop',
    description: 'Let the model decide which tools to call to accomplish a task.',
    // The loop itself is metadata-ish; individual tool calls inside it are gated.
    effect: 'metadata',
    locality: 'local',
    reversible: null,
    defaultDataLabels: [],
    acceptsLabels: [],
    defaultTTL: 'session',
  },

  // ---------------------------------------------------------------------------
  // chat.* — chat surface
  // ---------------------------------------------------------------------------
  'chat.open': {
    title: 'Open the chat UI',
    description: 'Open the browser\'s chat surface.',
    effect: 'write',
    locality: 'local',
    reversible: true,
    defaultDataLabels: [],
    acceptsLabels: [],
    defaultTTL: 'session',
  },

  // ---------------------------------------------------------------------------
  // addressBar.* — address-bar surface
  // ---------------------------------------------------------------------------
  'addressBar.suggest': {
    title: 'Suggest in the address bar',
    description: 'Provide AI-powered suggestions in the browser address bar.',
    effect: 'metadata',
    locality: 'local',
    reversible: null,
    defaultDataLabels: [],
    acceptsLabels: [],
    defaultTTL: 'until_user_revokes',
  },
  'addressBar.read.context': {
    title: 'Read current-tab context',
    description: 'Use information about the current tab to improve suggestions.',
    effect: 'read',
    locality: 'local',
    reversible: null,
    defaultDataLabels: ['confidential'],
    acceptsLabels: [],
    defaultTTL: 'session',
  },
  'addressBar.read.history': {
    title: 'Read browsing history',
    description: 'Use recent browsing history for personalized suggestions.',
    effect: 'read',
    locality: 'local',
    reversible: null,
    defaultDataLabels: ['confidential'],
    acceptsLabels: [],
    defaultTTL: 'session',
  },
  'addressBar.execute': {
    title: 'Execute from the address bar',
    description: 'Run tools or actions directly from address-bar commands.',
    effect: 'write',
    locality: 'local',
    reversible: false,
    defaultDataLabels: [],
    acceptsLabels: [],
    defaultTTL: 'session',
  },
} as const satisfies Record<string, ActionMeta>;

// =============================================================================
// Derived types and helpers
// =============================================================================

/**
 * The full set of typed actions Harbor knows about.
 */
export type TypedAction = keyof typeof TYPED_ACTIONS;

/**
 * Get metadata for a typed action. Returns `undefined` if the name isn't known.
 */
export function getActionMeta(action: string): ActionMeta | undefined {
  // The cast is safe: `TYPED_ACTIONS` is `as const` so `Object.hasOwn` is a
  // sufficient discriminator.
  if (Object.hasOwn(TYPED_ACTIONS, action)) {
    return TYPED_ACTIONS[action as TypedAction];
  }
  return undefined;
}

/**
 * Whether a string names a known typed action.
 */
export function isTypedAction(action: string): action is TypedAction {
  return Object.hasOwn(TYPED_ACTIONS, action);
}

/**
 * All registered typed action names.
 */
export function listTypedActions(): TypedAction[] {
  return Object.keys(TYPED_ACTIONS) as TypedAction[];
}

/**
 * Filter typed actions by effect tier.
 */
export function actionsByEffect(effect: ActionEffect): TypedAction[] {
  return listTypedActions().filter((a) => TYPED_ACTIONS[a].effect === effect);
}

/**
 * Whether an action's locality keeps data on-device or in the same origin.
 */
export function isOnDeviceLocality(locality: ActionLocality): boolean {
  return locality === 'local' || locality === 'same_origin';
}

/**
 * Whether an action's effect is allowed to escape the device or origin.
 */
export function effectCanEgress(effect: ActionEffect): boolean {
  return effect === 'egress' || effect === 'destructive' || effect === 'identity';
}

/**
 * The typed prompt action for a model name. Locality isn't knowable from an
 * arbitrary name without a registry lookup, so any named model outside the
 * known on-device prefixes counts as the user's first-party remote account.
 * No model selection rides the local path.
 */
export function promptActionForModel(
  model: unknown,
): 'model.prompt.local' | 'model.prompt.remote.firstParty' {
  const name = typeof model === 'string' ? model.toLowerCase() : '';
  const looksLocal =
    !name ||
    name.startsWith('ollama:') ||
    name.startsWith('apple:') ||
    name.startsWith('local:') ||
    name.startsWith('firefox-ml:') ||
    name.startsWith('chrome-ai:');
  return looksLocal ? 'model.prompt.local' : 'model.prompt.remote.firstParty';
}
