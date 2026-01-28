/**
 * Tab Manager
 * 
 * Manages browser tabs for the Web Agents API Extension 2.
 * 
 * Key concepts:
 * - Origins can read metadata (URL, title) of ALL tabs via browser:tabs.read
 * - Origins can create new tabs via browser:tabs.create
 * - Origins have FULL control over tabs they spawned (read, interact, navigate, close)
 * - Origins CANNOT control tabs they didn't spawn (only read metadata)
 */

import { browserAPI } from '../browser-compat';

// Track which tabs were spawned by which origin
interface SpawnedTabInfo {
  tabId: number;
  origin: string;
  createdAt: number;
  parentTabId?: number;  // The tab that spawned this one
  url: string;
}

// In-memory store of spawned tabs (cleared on extension reload)
const spawnedTabs = new Map<number, SpawnedTabInfo>();

// Track by origin for quick lookup
const tabsByOrigin = new Map<string, Set<number>>();

/**
 * Tab metadata returned to web pages
 */
export interface TabMetadata {
  id: number;
  url: string;
  title: string;
  active: boolean;
  index: number;
  windowId: number;
  favIconUrl?: string;
  status?: 'loading' | 'complete';
  /** True if this origin spawned this tab (and can control it) */
  canControl: boolean;
}

/**
 * Options for creating a new tab
 */
export interface CreateTabOptions {
  url: string;
  active?: boolean;
  index?: number;
  windowId?: number;
}

/**
 * Register a tab as spawned by an origin.
 */
export function registerSpawnedTab(
  tabId: number,
  origin: string,
  url: string,
  parentTabId?: number,
): void {
  const info: SpawnedTabInfo = {
    tabId,
    origin,
    createdAt: Date.now(),
    parentTabId,
    url,
  };
  
  spawnedTabs.set(tabId, info);
  
  // Track by origin
  if (!tabsByOrigin.has(origin)) {
    tabsByOrigin.set(origin, new Set());
  }
  tabsByOrigin.get(origin)!.add(tabId);
  
  console.log('[TabManager] Registered spawned tab:', tabId, 'for origin:', origin);
}

/**
 * Check if an origin can control a specific tab.
 * An origin can control a tab if it spawned it.
 */
export function canOriginControlTab(origin: string, tabId: number): boolean {
  const info = spawnedTabs.get(tabId);
  return info !== undefined && info.origin === origin;
}

/**
 * Get all tabs spawned by an origin.
 */
export function getSpawnedTabIds(origin: string): number[] {
  return Array.from(tabsByOrigin.get(origin) || []);
}

/**
 * Unregister a tab when it's closed.
 */
export function unregisterTab(tabId: number): void {
  const info = spawnedTabs.get(tabId);
  if (info) {
    spawnedTabs.delete(tabId);
    tabsByOrigin.get(info.origin)?.delete(tabId);
    console.log('[TabManager] Unregistered tab:', tabId);
  }
}

/**
 * Clean up all tabs for an origin (e.g., when the page is unloaded).
 */
export function cleanupOriginTabs(origin: string): void {
  const tabs = tabsByOrigin.get(origin);
  if (tabs) {
    for (const tabId of tabs) {
      spawnedTabs.delete(tabId);
    }
    tabsByOrigin.delete(origin);
    console.log('[TabManager] Cleaned up tabs for origin:', origin);
  }
}

// =============================================================================
// Tab Operations
// =============================================================================

/**
 * List all tabs with metadata.
 * Returns metadata for all tabs, with canControl indicating which ones
 * the origin can interact with.
 */
export async function listTabs(origin: string): Promise<TabMetadata[]> {
  const tabs = await browserAPI.tabs.query({});
  
  return tabs.map((tab) => ({
    id: tab.id!,
    url: tab.url || '',
    title: tab.title || '',
    active: tab.active,
    index: tab.index,
    windowId: tab.windowId,
    favIconUrl: tab.favIconUrl,
    status: tab.status as 'loading' | 'complete' | undefined,
    canControl: canOriginControlTab(origin, tab.id!),
  }));
}

/**
 * Get metadata for a specific tab.
 */
export async function getTab(origin: string, tabId: number): Promise<TabMetadata | null> {
  try {
    const tab = await browserAPI.tabs.get(tabId);
    return {
      id: tab.id!,
      url: tab.url || '',
      title: tab.title || '',
      active: tab.active,
      index: tab.index,
      windowId: tab.windowId,
      favIconUrl: tab.favIconUrl,
      status: tab.status as 'loading' | 'complete' | undefined,
      canControl: canOriginControlTab(origin, tabId),
    };
  } catch {
    return null;
  }
}

/**
 * Create a new tab. The tab will be registered as spawned by the origin.
 */
export async function createTab(
  origin: string,
  options: CreateTabOptions,
  parentTabId?: number,
): Promise<TabMetadata> {
  const tab = await browserAPI.tabs.create({
    url: options.url,
    active: options.active ?? false,  // Default to background
    index: options.index,
    windowId: options.windowId,
  });
  
  // Register as spawned by this origin
  registerSpawnedTab(tab.id!, origin, options.url, parentTabId);
  
  return {
    id: tab.id!,
    url: tab.url || options.url,
    title: tab.title || '',
    active: tab.active,
    index: tab.index,
    windowId: tab.windowId,
    favIconUrl: tab.favIconUrl,
    status: tab.status as 'loading' | 'complete' | undefined,
    canControl: true,  // Origin just created it
  };
}

/**
 * Close a tab. Only allowed if the origin spawned the tab.
 */
export async function closeTab(origin: string, tabId: number): Promise<boolean> {
  if (!canOriginControlTab(origin, tabId)) {
    throw new Error('Cannot close tab: origin did not spawn this tab');
  }
  
  try {
    await browserAPI.tabs.remove(tabId);
    unregisterTab(tabId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Navigate a tab to a new URL. 
 * - For the active tab: requires browser:navigate permission
 * - For spawned tabs: allowed if origin created the tab
 */
export async function navigateTab(
  origin: string,
  tabId: number,
  url: string,
  isActiveTab: boolean,
): Promise<void> {
  // If it's not the active tab, must be a spawned tab
  if (!isActiveTab && !canOriginControlTab(origin, tabId)) {
    throw new Error('Cannot navigate tab: origin did not spawn this tab');
  }
  
  await browserAPI.tabs.update(tabId, { url });
  
  // Update the URL in our records if it's a spawned tab
  const info = spawnedTabs.get(tabId);
  if (info) {
    info.url = url;
  }
}

/**
 * Wait for a tab to finish loading.
 */
export function waitForNavigation(
  tabId: number,
  timeoutMs: number = 30000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      browserAPI.tabs.onUpdated.removeListener(listener);
      reject(new Error('Navigation timeout'));
    }, timeoutMs);
    
    const listener = (
      updatedTabId: number,
      changeInfo: browserAPI.tabs.TabChangeInfo,
    ) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout);
        browserAPI.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    
    browserAPI.tabs.onUpdated.addListener(listener);
  });
}

// =============================================================================
// Initialization
// =============================================================================

/**
 * Initialize the tab manager.
 * Sets up listeners to track tab closures.
 */
export function initializeTabManager(): void {
  // Clean up when tabs are closed
  browserAPI.tabs.onRemoved.addListener((tabId) => {
    unregisterTab(tabId);
  });
  
  console.log('[TabManager] Initialized');
}
