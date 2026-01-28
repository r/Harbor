/**
 * Feature Flags for Web Agents API
 * 
 * Controls which APIs are exposed to web pages.
 * These flags are managed via the sidebar UI.
 * 
 * ## API Categories
 * 
 * **Text Generation (textGeneration):**
 * - window.ai - LLM prompts and text sessions
 * 
 * **Tool Calling (toolCalling):**
 * - agent.run() - LLM-driven tool calling loops
 * 
 * **Tool Access (toolAccess):**
 * - agent.tools.list() / agent.tools.call() - Manual MCP tool access
 * 
 * **Browser Interaction (browserInteraction):**
 * - agent.browser.activeTab.click/fill/scroll/select
 * - Same-tab page manipulation
 * 
 * **Browser Control (browserControl):**
 * - agent.browser.navigate/tabs/fetch
 * - Multi-tab control and web fetch
 * 
 * **Multi-Agent (multiAgent):**
 * - agent.agents.* - Agent-to-agent communication
 */

export const STORAGE_KEY = 'web-agents-api-flags';

export interface FeatureFlags {
  /**
   * Enable text generation APIs (window.ai).
   * Default: true
   */
  textGeneration: boolean;

  /**
   * Enable tool calling APIs (agent.run).
   * LLM-driven tool calling loops.
   * Default: false
   */
  toolCalling: boolean;

  /**
   * Enable manual MCP tool access (agent.tools.*).
   * Default: true
   */
  toolAccess: boolean;

  /**
   * Enable browser interaction APIs (click, fill, scroll, select).
   * Same-tab page manipulation only.
   * Default: false
   */
  browserInteraction: boolean;

  /**
   * Enable browser control APIs (navigate, tabs, fetch).
   * Multi-tab and navigation control.
   * Default: false
   */
  browserControl: boolean;

  /**
   * Enable multi-agent APIs (agent.agents.*).
   * Agent-to-agent communication and orchestration.
   * Default: false
   */
  multiAgent: boolean;
}

export const DEFAULT_FLAGS: FeatureFlags = {
  textGeneration: true,
  toolCalling: false,
  toolAccess: true,
  browserInteraction: false,
  browserControl: false,
  multiAgent: false,
};

let cachedFlags: FeatureFlags | null = null;

/**
 * Get current feature flags.
 */
export async function getFeatureFlags(): Promise<FeatureFlags> {
  if (cachedFlags) {
    return cachedFlags;
  }

  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    cachedFlags = { ...DEFAULT_FLAGS, ...result[STORAGE_KEY] };
    return cachedFlags;
  } catch {
    return DEFAULT_FLAGS;
  }
}

/**
 * Get feature flags synchronously from cache.
 * Returns defaults if not yet loaded.
 */
export function getFeatureFlagsSync(): FeatureFlags {
  return cachedFlags || DEFAULT_FLAGS;
}

/**
 * Update feature flags.
 */
export async function setFeatureFlags(flags: Partial<FeatureFlags>): Promise<void> {
  const current = await getFeatureFlags();
  const updated = { ...current, ...flags };
  
  await chrome.storage.local.set({ [STORAGE_KEY]: updated });
  cachedFlags = updated;
}

/**
 * Check if a specific feature is enabled.
 */
export async function isFeatureEnabled(feature: keyof FeatureFlags): Promise<boolean> {
  const flags = await getFeatureFlags();
  return flags[feature];
}

/**
 * Reset all flags to defaults.
 */
export async function resetFeatureFlags(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
  cachedFlags = null;
}

/**
 * Initialize flags cache on module load.
 */
export async function initFeatureFlags(): Promise<FeatureFlags> {
  return getFeatureFlags();
}

// Listen for storage changes to invalidate cache
if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes[STORAGE_KEY]) {
      cachedFlags = null;
    }
  });
}
