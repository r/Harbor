/**
 * Tab Management Handlers
 * 
 * Handles tab creation, listing, closing, and spawned tab operations.
 */

import type { RequestContext, HandlerResponse } from './types';
import { errorResponse, successResponse } from './types';
import { hasPermission } from './permission-handlers';
import { executeScriptInTab } from './browser-compat';

// =============================================================================
// Spawned Tab Tracking
// =============================================================================

// Track tabs spawned by each origin (origin -> Set<tabId>)
const spawnedTabs = new Map<string, Set<number>>();

// Persist spawnedTabs to storage for survival across background restarts
async function persistSpawnedTabs(): Promise<void> {
  const data: Record<string, number[]> = {};
  for (const [origin, tabs] of spawnedTabs.entries()) {
    data[origin] = Array.from(tabs);
  }
  await chrome.storage.local.set({ spawnedTabs: data });
}

// Restore spawnedTabs from storage on startup
export async function restoreSpawnedTabs(): Promise<void> {
  try {
    const result = await chrome.storage.local.get('spawnedTabs');
    if (result.spawnedTabs) {
      const data = result.spawnedTabs as Record<string, number[]>;
      for (const [origin, tabs] of Object.entries(data)) {
        spawnedTabs.set(origin, new Set(tabs));
      }
      console.log('[Web Agents API] Restored spawnedTabs from storage');
      await verifyTrackedTabs();
    }
  } catch (error) {
    console.log('[Web Agents API] Error restoring spawnedTabs:', error);
  }
}

// Verify tracked tabs still exist
async function verifyTrackedTabs(): Promise<void> {
  for (const [origin, tabs] of spawnedTabs.entries()) {
    for (const tabId of tabs) {
      try {
        await chrome.tabs.get(tabId);
      } catch {
        tabs.delete(tabId);
        console.log('[Web Agents API] Removed stale tab from tracking:', { tabId, origin });
      }
    }
    if (tabs.size === 0) {
      spawnedTabs.delete(origin);
    }
  }
  await persistSpawnedTabs();
}

export function trackSpawnedTab(origin: string, tabId: number): void {
  if (!spawnedTabs.has(origin)) {
    spawnedTabs.set(origin, new Set());
  }
  spawnedTabs.get(origin)!.add(tabId);
  console.log('[Web Agents API] Tracked spawned tab:', { origin, tabId });
  persistSpawnedTabs();
}

export function untrackSpawnedTab(origin: string, tabId: number): boolean {
  const tabs = spawnedTabs.get(origin);
  if (tabs) {
    const result = tabs.delete(tabId);
    console.log('[Web Agents API] Untracked spawned tab:', { origin, tabId, result });
    persistSpawnedTabs();
    return result;
  }
  return false;
}

export function isSpawnedTab(origin: string, tabId: number): boolean {
  return spawnedTabs.get(origin)?.has(tabId) ?? false;
}

export function getAllSpawnedTabs(): Record<string, number[]> {
  const result: Record<string, number[]> = {};
  for (const [origin, tabs] of spawnedTabs.entries()) {
    result[origin] = Array.from(tabs);
  }
  return result;
}

// Handle tab removal - clean up tracking
export function handleTabRemoved(tabId: number): void {
  for (const [origin, tabs] of spawnedTabs.entries()) {
    if (tabs.has(tabId)) {
      tabs.delete(tabId);
      console.log('[Web Agents API] Removed tab from tracking:', { tabId, origin });
    }
  }
  persistSpawnedTabs();
}

// =============================================================================
// Tab Handlers
// =============================================================================

export async function handleTabsCreate(ctx: RequestContext): HandlerResponse {
  console.log('[Web Agents API] handleTabsCreate called:', { origin: ctx.origin, payload: ctx.payload });
  
  if (!await hasPermission(ctx.origin, 'browser:tabs.create')) {
    return errorResponse(ctx.id, 'ERR_PERMISSION_DENIED', 'Permission browser:tabs.create required');
  }

  const payload = ctx.payload as { url: string; active?: boolean; index?: number; windowId?: number };
  
  if (!payload.url) {
    return errorResponse(ctx.id, 'ERR_INVALID_REQUEST', 'Missing url parameter');
  }

  try {
    const createOptions: chrome.tabs.CreateProperties = {
      url: payload.url,
      active: payload.active ?? false,
      index: payload.index,
      windowId: payload.windowId,
    };
    
    const tab = await chrome.tabs.create(createOptions);
    console.log('[Web Agents API] Tab created:', { tabId: tab.id, url: tab.url });

    if (!tab.id) {
      return errorResponse(ctx.id, 'ERR_INTERNAL', 'Failed to create tab');
    }

    trackSpawnedTab(ctx.origin, tab.id);

    return successResponse(ctx.id, {
      id: tab.id,
      url: tab.url || payload.url,
      title: tab.title || '',
      active: tab.active,
      index: tab.index,
      windowId: tab.windowId,
      canControl: true,
    });
  } catch (e) {
    return errorResponse(ctx.id, 'ERR_INTERNAL', e instanceof Error ? e.message : 'Failed to create tab');
  }
}

export async function handleTabsList(ctx: RequestContext): HandlerResponse {
  if (!await hasPermission(ctx.origin, 'browser:tabs.read')) {
    return errorResponse(ctx.id, 'ERR_PERMISSION_DENIED', 'Permission browser:tabs.read required');
  }

  try {
    const tabs = await chrome.tabs.query({});
    const result = tabs.map(tab => ({
      id: tab.id!,
      url: tab.url || '',
      title: tab.title || '',
      active: tab.active,
      index: tab.index,
      windowId: tab.windowId,
      favIconUrl: tab.favIconUrl,
      status: tab.status as 'loading' | 'complete' | undefined,
      canControl: tab.id ? isSpawnedTab(ctx.origin, tab.id) : false,
    }));

    return successResponse(ctx.id, result);
  } catch (e) {
    return errorResponse(ctx.id, 'ERR_INTERNAL', e instanceof Error ? e.message : 'Failed to list tabs');
  }
}

export async function handleTabsClose(ctx: RequestContext): HandlerResponse {
  if (!await hasPermission(ctx.origin, 'browser:tabs.create')) {
    return errorResponse(ctx.id, 'ERR_PERMISSION_DENIED', 'Permission browser:tabs.create required');
  }

  const { tabId } = ctx.payload as { tabId: number };
  
  if (typeof tabId !== 'number') {
    return errorResponse(ctx.id, 'ERR_INVALID_REQUEST', 'Missing tabId parameter');
  }

  if (!isSpawnedTab(ctx.origin, tabId)) {
    return errorResponse(ctx.id, 'ERR_PERMISSION_DENIED', 'Can only close tabs created by this origin');
  }

  try {
    await chrome.tabs.remove(tabId);
    untrackSpawnedTab(ctx.origin, tabId);
    return successResponse(ctx.id, true);
  } catch (e) {
    return errorResponse(ctx.id, 'ERR_INTERNAL', e instanceof Error ? e.message : 'Failed to close tab');
  }
}

// =============================================================================
// Spawned Tab Operations
// =============================================================================

export async function handleSpawnedTabReadability(ctx: RequestContext): HandlerResponse {
  if (!await hasPermission(ctx.origin, 'browser:tabs.create')) {
    return errorResponse(ctx.id, 'ERR_PERMISSION_DENIED', 'Permission browser:tabs.create required');
  }

  const { tabId } = ctx.payload as { tabId: number };
  
  if (typeof tabId !== 'number') {
    return errorResponse(ctx.id, 'ERR_INVALID_REQUEST', 'Missing tabId parameter');
  }

  if (!isSpawnedTab(ctx.origin, tabId)) {
    return errorResponse(ctx.id, 'ERR_PERMISSION_DENIED', 'Can only read from tabs created by this origin');
  }

  try {
    const result = await executeScriptInTab<{
      title: string;
      url: string;
      content: string;
      text: string;
      html?: string;
      length: number;
    }>(
      tabId,
      () => {
        const title = document.title;
        const url = window.location.href;
        const mainSelectors = ['main', 'article', '[role="main"]', '.content', '#content', '.post', '.article'];
        let content = '';
        let html = '';

        for (const selector of mainSelectors) {
          const el = document.querySelector(selector);
          if (el) {
            content = el.textContent?.trim() || '';
            html = el.innerHTML || '';
            break;
          }
        }

        if (!content) {
          content = document.body.textContent?.trim() || '';
          html = document.body.innerHTML || '';
        }

        content = content.replace(/\s+/g, ' ').trim();
        const htmlSlice = html ? html.slice(0, 150000) : '';

        return {
          title,
          url,
          content: content.slice(0, 50000),
          text: content.slice(0, 50000),
          html: htmlSlice || undefined,
          length: content.length,
        };
      },
      []
    );

    if (!result) {
      return errorResponse(ctx.id, 'ERR_INTERNAL', 'Script execution failed');
    }
    return successResponse(ctx.id, result);
  } catch (e) {
    return errorResponse(ctx.id, 'ERR_INTERNAL', e instanceof Error ? e.message : 'Readability extraction failed');
  }
}

export async function handleSpawnedTabGetHtml(ctx: RequestContext): HandlerResponse {
  if (!await hasPermission(ctx.origin, 'browser:tabs.create')) {
    return errorResponse(ctx.id, 'ERR_PERMISSION_DENIED', 'Permission browser:tabs.create required');
  }

  const { tabId, selector } = ctx.payload as { tabId: number; selector?: string };
  
  if (typeof tabId !== 'number') {
    return errorResponse(ctx.id, 'ERR_INVALID_REQUEST', 'Missing tabId parameter');
  }

  if (!isSpawnedTab(ctx.origin, tabId)) {
    return errorResponse(ctx.id, 'ERR_PERMISSION_DENIED', 'Can only read from tabs created by this origin');
  }

  try {
    const result = await executeScriptInTab<{ html: string; url: string; title: string }>(
      tabId,
      (containerSelector: string | null) => {
        const container = containerSelector 
          ? document.querySelector(containerSelector) 
          : document.body;
        
        return {
          html: container?.outerHTML || document.body.outerHTML,
          url: window.location.href,
          title: document.title,
        };
      },
      [selector || null]
    );

    if (!result) {
      return errorResponse(ctx.id, 'ERR_INTERNAL', 'Script execution failed');
    }
    return successResponse(ctx.id, result);
  } catch (e) {
    return errorResponse(ctx.id, 'ERR_INTERNAL', e instanceof Error ? e.message : 'Get HTML failed');
  }
}

export async function handleSpawnedTabWaitForLoad(ctx: RequestContext): HandlerResponse {
  if (!await hasPermission(ctx.origin, 'browser:tabs.create')) {
    return errorResponse(ctx.id, 'ERR_PERMISSION_DENIED', 'Permission browser:tabs.create required');
  }

  const { tabId, timeout = 30000 } = ctx.payload as { tabId: number; timeout?: number };
  
  if (typeof tabId !== 'number') {
    return errorResponse(ctx.id, 'ERR_INVALID_REQUEST', 'Missing tabId parameter');
  }

  if (!isSpawnedTab(ctx.origin, tabId)) {
    return errorResponse(ctx.id, 'ERR_PERMISSION_DENIED', 'Can only wait for tabs created by this origin');
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') {
      return successResponse(ctx.id, undefined);
    }

    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error('Navigation timeout'));
      }, timeout);

      const listener = (
        updatedTabId: number,
        changeInfo: chrome.tabs.TabChangeInfo,
      ) => {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          clearTimeout(timeoutId);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };

      chrome.tabs.onUpdated.addListener(listener);
    });

    return successResponse(ctx.id, undefined);
  } catch (e) {
    return errorResponse(ctx.id, 'ERR_INTERNAL', e instanceof Error ? e.message : 'Wait for load failed');
  }
}
