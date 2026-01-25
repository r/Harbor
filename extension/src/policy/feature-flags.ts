/**
 * Feature Flags
 * 
 * Gates experimental and advanced features behind toggles.
 * By default, Harbor exposes the conservative Web Agent API:
 * - LLM access (window.ai)
 * - MCP tools (agent.tools)
 * - Page readability (agent.browser.activeTab.readability)
 * - Agent run loop (agent.run)
 * - BYOC/Chat APIs
 * 
 * Advanced features require explicit opt-in:
 * - Browser interaction (click, fill, scroll)
 * - Screenshots
 * - Future: Navigation, tab management, multi-agent
 */

const STORAGE_KEY = 'harbor_feature_flags';

export interface FeatureFlags {
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
}

const DEFAULT_FLAGS: FeatureFlags = {
  browserInteraction: false,
  screenshots: false,
  experimental: false,
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

// Listen for storage changes to invalidate cache
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[STORAGE_KEY]) {
    cachedFlags = null;
  }
});
