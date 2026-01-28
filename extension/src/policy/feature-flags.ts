/**
 * Feature Flags
 * 
 * Gates experimental and advanced features behind toggles.
 * 
 * ## API Tiers
 * 
 * **Core Web Agents API (always enabled):**
 * - LLM access (window.ai)
 * - MCP tools (agent.tools)
 * - Page readability (agent.browser.activeTab.readability)
 * - Agent run loop (agent.run)
 * - BYOC/Chat APIs
 * 
 * **Browser Control (Extension 2 - opt-in via `browserControl`):**
 * - Navigation (agent.browser.navigate)
 * - Tab management (agent.browser.tabs.*)
 * - Spawned tab control (agent.browser.tab.*)
 * - Web fetch proxy (agent.fetch)
 * 
 * **Multi-Agent (Extension 3 - opt-in via `multiAgent`):**
 * - Agent registration (agent.agents.register)
 * - Agent discovery (agent.agents.discover)
 * - A2A communication (agent.agents.invoke, send)
 * - Orchestration (agent.agents.orchestrate.*)
 * - Remote agents (agent.agents.remote.*)
 * 
 * Advanced features within Core require explicit opt-in:
 * - Browser interaction (click, fill, scroll) via `browserInteraction`
 * - Screenshots via `screenshots`
 */

import { browserAPI } from '../browser-compat';

const STORAGE_KEY = 'harbor_feature_flags';

export interface FeatureFlags {
  // =========================================================================
  // Core API Feature Flags (granular control within Extension 1)
  // =========================================================================

  /**
   * Enable browser interaction APIs (click, fill, scroll, select).
   * When disabled, these APIs return ERR_FEATURE_DISABLED.
   * Default: false
   */
  browserInteraction: boolean;

  /**
   * Enable screenshot API.
   * When disabled, screenshot() returns ERR_FEATURE_DISABLED.
   * Default: false
   */
  screenshots: boolean;

  /**
   * Enable experimental/unstable APIs.
   * This is a catch-all for features in active development.
   * Default: false
   */
  experimental: boolean;

  // =========================================================================
  // Extension 2: Browser Control
  // =========================================================================

  /**
   * Enable Browser Control APIs (Extension 2).
   * When enabled, exposes:
   * - agent.browser.navigate(url)
   * - agent.browser.waitForNavigation()
   * - agent.browser.tabs.* (list, get, create, close)
   * - agent.browser.tab.* (control spawned tabs)
   * - agent.fetch() (CORS-bypassing fetch)
   * Default: false
   */
  browserControl: boolean;

  // =========================================================================
  // Extension 3: Multi-Agent
  // =========================================================================

  /**
   * Enable Multi-Agent APIs (Extension 3).
   * When enabled, exposes:
   * - agent.agents.register/unregister
   * - agent.agents.discover/list
   * - agent.agents.invoke/send
   * - agent.agents.orchestrate.* (pipeline, parallel, route)
   * - agent.agents.remote.* (connect, disconnect, list, ping, discover)
   * Default: false
   */
  multiAgent: boolean;
}

const DEFAULT_FLAGS: FeatureFlags = {
  // Core API flags
  browserInteraction: false,
  screenshots: false,
  experimental: false,
  // Extension 2
  browserControl: false,
  // Extension 3
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
    const result = await browserAPI.storage.local.get(STORAGE_KEY);
    cachedFlags = { ...DEFAULT_FLAGS, ...result[STORAGE_KEY] };
    return cachedFlags;
  } catch {
    return DEFAULT_FLAGS;
  }
}

/**
 * Update feature flags.
 */
export async function setFeatureFlags(flags: Partial<FeatureFlags>): Promise<void> {
  const current = await getFeatureFlags();
  const updated = { ...current, ...flags };
  
  await browserAPI.storage.local.set({ [STORAGE_KEY]: updated });
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
  await browserAPI.storage.local.remove(STORAGE_KEY);
  cachedFlags = null;
}

// Listen for storage changes to invalidate cache
browserAPI.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[STORAGE_KEY]) {
    cachedFlags = null;
  }
});
