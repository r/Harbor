/**
 * Browser Compatibility Layer
 *
 * Provides a unified API for browser extension functionality across
 * Firefox, Chrome, and Safari.
 *
 * Firefox uses `browser.*` APIs with native Promise support.
 * Chrome uses `chrome.*` APIs (Promise-based in MV3).
 * Safari uses `browser.*` APIs similar to Firefox.
 */

// Detect environment and provide unified API
declare const browser: typeof chrome | undefined;

/**
 * Unified browser API that works across Firefox, Chrome, and Safari.
 * Prefers `browser` namespace (Firefox/Safari) but falls back to `chrome` (Chrome).
 */
export const browserAPI = (typeof browser !== 'undefined' ? browser : chrome) as typeof chrome;

/**
 * Get the URL for an extension resource.
 * Safari doesn't have runtime.getURL in all contexts, so we fall back to relative URLs.
 */
export function getExtensionURL(path: string): string {
  // Try runtime.getURL first (works in Firefox, Chrome, and Safari background)
  if (browserAPI.runtime?.getURL) {
    return browserAPI.runtime.getURL(path);
  }
  
  // Fallback for Safari popup/sidebar where runtime.getURL doesn't exist
  // Use relative URL from the extension's base
  return path;
}

/**
 * Check if running in Firefox.
 */
export function isFirefox(): boolean {
  return typeof browser !== 'undefined' && navigator.userAgent.includes('Firefox');
}

/**
 * Check if running in Chrome.
 */
export function isChrome(): boolean {
  return typeof browser === 'undefined' && typeof chrome !== 'undefined';
}

/**
 * Check if running in Safari.
 */
export function isSafari(): boolean {
  return typeof browser !== 'undefined' && navigator.userAgent.includes('Safari') && !navigator.userAgent.includes('Chrome');
}

/**
 * Check if the Firefox ML API (browser.trial.ml) is available.
 * Only available in Firefox 134+ with the trialML permission.
 */
export function hasFirefoxML(): boolean {
  if (typeof browser === 'undefined') return false;
  const trial = (browser as unknown as { trial?: { ml?: unknown } }).trial;
  return !!trial && !!trial.ml;
}

/**
 * Check if the Firefox wllama API is available.
 * Only available in Firefox 142+ with the trialML permission.
 */
export function hasFirefoxWllama(): boolean {
  if (typeof browser === 'undefined') return false;
  const trial = (browser as unknown as { trial?: { ml?: { wllama?: unknown } } }).trial;
  return !!trial?.ml?.wllama;
}

/**
 * Check if the sidebar_action API is available.
 * Only available in Firefox.
 */
export function hasSidebar(): boolean {
  return typeof browser !== 'undefined' && 'sidebarAction' in browser;
}

/**
 * Check if running in a service worker context.
 * Chrome MV3 uses service workers for the background script.
 */
export function isServiceWorker(): boolean {
  return typeof ServiceWorkerGlobalScope !== 'undefined' &&
    self instanceof ServiceWorkerGlobalScope;
}

/**
 * Check if the scripting API is available.
 * Available in MV3 extensions on both Chrome and Firefox.
 */
export function hasScriptingAPI(): boolean {
  return 'scripting' in browserAPI;
}

/**
 * Execute a script in a tab, compatible with both Chrome and Firefox.
 * Falls back to tabs.executeScript for older Firefox versions.
 */
export async function executeScriptInTab<T>(
  tabId: number,
  func: (...args: unknown[]) => T,
  args: unknown[] = []
): Promise<T | undefined> {
  // Try chrome.scripting first (Chrome MV3, Firefox MV3 with scripting)
  if (browserAPI.scripting?.executeScript) {
    const results = await browserAPI.scripting.executeScript({
      target: { tabId },
      func: func as () => T,
      args,
    });
    return results?.[0]?.result as T | undefined;
  }

  // Fallback: browser.tabs.executeScript (Firefox MV2 style)
  if (typeof browser !== 'undefined' && browser.tabs?.executeScript) {
    // For this fallback, we need to serialize the function
    const code = `(${func.toString()}).apply(null, ${JSON.stringify(args)})`;
    const results = await browser.tabs.executeScript(tabId, { code });
    return results?.[0] as T | undefined;
  }

  throw new Error('No script execution API available');
}

/**
 * Execute script in a tab in ALL frames (main + iframes). Returns the first result
 * for which the value matches the predicate (e.g. form was found and submitted).
 * Use when the login form may be inside an iframe.
 */
export async function executeScriptInTabAllFrames<T>(
  tabId: number,
  func: (...args: unknown[]) => T,
  args: unknown[] = [],
  predicate?: (value: T) => boolean
): Promise<T | undefined> {
  if (browserAPI.scripting?.executeScript) {
    const results = await browserAPI.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: func as () => T,
      args,
    });
    if (!results?.length) return undefined;
    for (const r of results) {
      const value = r.result as T;
      if (value !== undefined && value !== null && (!predicate || predicate(value))) return value;
    }
    return (results[0]?.result as T) ?? undefined;
  }
  return executeScriptInTab(tabId, func, args);
}

/**
 * Get the current browser name for logging and debugging.
 */
export function getBrowserName(): 'firefox' | 'chrome' | 'safari' | 'unknown' {
  if (isFirefox()) return 'firefox';
  if (isSafari()) return 'safari';
  if (isChrome()) return 'chrome';
  return 'unknown';
}

/**
 * Log with browser context for debugging.
 */
export function logWithBrowser(prefix: string, ...args: unknown[]): void {
  console.log(`[${prefix}:${getBrowserName()}]`, ...args);
}

/**
 * Check if the omnibox API is available.
 * Available in Firefox and Chrome, but may have different features.
 */
export function hasOmnibox(): boolean {
  return 'omnibox' in browserAPI;
}

/**
 * Check if externally_connectable is available.
 * Only Chrome supports onMessageExternal/onConnectExternal.
 */
export function hasExternalMessaging(): boolean {
  return 'onMessageExternal' in browserAPI.runtime;
}

/**
 * Check if web navigation API is available.
 */
export function hasWebNavigation(): boolean {
  return 'webNavigation' in browserAPI;
}

/**
 * Check if this is MV3 (Manifest Version 3).
 */
export function isManifestV3(): boolean {
  return browserAPI.runtime.getManifest().manifest_version === 3;
}

/**
 * Service worker lifecycle handlers for Chrome MV3.
 * These help maintain state across service worker restarts.
 */
export const serviceWorkerLifecycle = {
  /**
   * Register a startup handler that runs when the service worker starts.
   * This is useful for restoring state in Chrome MV3.
   */
  onStartup(handler: () => void): void {
    if (browserAPI.runtime.onStartup) {
      browserAPI.runtime.onStartup.addListener(handler);
    }
  },

  /**
   * Register an install/update handler.
   * Runs on first install or extension update.
   */
  onInstalled(handler: (details: { reason: string; previousVersion?: string }) => void): void {
    if (browserAPI.runtime.onInstalled) {
      browserAPI.runtime.onInstalled.addListener(handler);
    }
  },

  /**
   * Register a suspend handler (Chrome MV3 only).
   * Called when the service worker is about to be terminated.
   */
  onSuspend(handler: () => void): void {
    if (isServiceWorker() && 'onSuspend' in browserAPI.runtime) {
      (browserAPI.runtime as { onSuspend: { addListener: (h: () => void) => void } }).onSuspend.addListener(handler);
    }
  },

  /**
   * Keep the service worker alive (Chrome MV3).
   * Use sparingly - Chrome will still terminate after 5 minutes.
   */
  keepAlive(): void {
    if (isServiceWorker()) {
      // Accessing chrome.storage periodically can help keep the worker alive
      // but this should be used sparingly
      setInterval(() => {
        browserAPI.storage.local.get(null);
      }, 20000); // Every 20 seconds
    }
  }
};

/**
 * Browser feature summary for debugging.
 */
export function getFeatureSummary(): Record<string, boolean | string> {
  return {
    browser: getBrowserName(),
    isServiceWorker: isServiceWorker(),
    isManifestV3: isManifestV3(),
    hasSidebar: hasSidebar(),
    hasOmnibox: hasOmnibox(),
    hasFirefoxML: hasFirefoxML(),
    hasFirefoxWllama: hasFirefoxWllama(),
    hasScriptingAPI: hasScriptingAPI(),
    hasExternalMessaging: hasExternalMessaging(),
    hasWebNavigation: hasWebNavigation(),
  };
}
