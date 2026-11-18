/**
 * Feature flags for the page API, as the user set them in the sidebar.
 *
 * This module reads and caches the saved flags. The flag set itself, and which
 * transport messages each flag gates, live in ./feature-flag-set.ts.
 */

import { DEFAULT_FLAGS, STORAGE_KEY, type FeatureFlags } from './feature-flag-set';

export { DEFAULT_FLAGS, FEATURE_LABELS, STORAGE_KEY, featureRefusal, featuresForMessage } from './feature-flag-set';
export type { FeatureFlags } from './feature-flag-set';

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
