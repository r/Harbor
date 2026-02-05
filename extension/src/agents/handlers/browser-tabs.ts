/**
 * Browser tabs handlers - navigation and tab management.
 */

import type { RequestContext, ResponseSender } from './router-types';
import { log, requirePermission } from './helpers';
import {
  getTabReadability,
  getTabHtml,
  clickElement,
  fillInput,
  scrollPage,
  takeScreenshot,
} from '../browser-api';
import {
  listTabs,
  getTab,
  createTab,
  closeTab,
  navigateTab,
  waitForNavigation,
  canOriginControlTab,
} from '../../tabs/manager';

// =============================================================================
// Navigation Handlers
// =============================================================================

/**
 * Handle agent.browser.navigate - Navigate current tab to a URL.
 */
export async function handleBrowserNavigate(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'browser:navigate'))) {
    return;
  }

  if (!ctx.tabId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: 'No tab ID available' },
    });
    return;
  }

  const payload = ctx.payload as { url: string };

  try {
    await navigateTab(ctx.origin, ctx.tabId, payload.url, true);
    sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Navigation failed',
      },
    });
  }
}

/**
 * Handle agent.browser.waitForNavigation - Wait for navigation to complete.
 */
export async function handleBrowserWaitForNavigation(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'browser:navigate'))) {
    return;
  }

  if (!ctx.tabId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: 'No tab ID available' },
    });
    return;
  }

  const payload = ctx.payload as { timeout?: number } | undefined;

  try {
    await waitForNavigation(ctx.tabId, payload?.timeout);
    sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_TIMEOUT',
        message: error instanceof Error ? error.message : 'Navigation timeout',
      },
    });
  }
}

// =============================================================================
// Tab Management Handlers
// =============================================================================

/**
 * Handle agent.browser.tabs.list - List tabs.
 */
export async function handleTabsList(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'browser:tabs.read'))) {
    return;
  }

  try {
    const tabs = await listTabs(ctx.origin);
    sender.sendResponse({ id: ctx.id, ok: true, result: tabs });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Failed to list tabs',
      },
    });
  }
}

/**
 * Handle agent.browser.tabs.get - Get tab info.
 */
export async function handleTabsGet(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'browser:tabs.read'))) {
    return;
  }

  const payload = ctx.payload as { tabId: number };

  try {
    const tab = await getTab(ctx.origin, payload.tabId);
    sender.sendResponse({ id: ctx.id, ok: true, result: tab });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Failed to get tab',
      },
    });
  }
}

/**
 * Handle agent.browser.tabs.create - Create a new tab.
 */
export async function handleTabsCreate(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  console.log('[Harbor Router] handleTabsCreate - origin:', ctx.origin, 'cookieStoreId:', ctx.cookieStoreId, 'payload:', ctx.payload);
  
  if (!(await requirePermission(ctx, sender, 'browser:tabs.create'))) {
    return;
  }

  const payload = ctx.payload as { url: string; active?: boolean; index?: number; windowId?: number };

  try {
    // Pass cookieStoreId to ensure new tab opens in the same Firefox container as the parent
    const tab = await createTab(ctx.origin, { ...payload, cookieStoreId: ctx.cookieStoreId }, ctx.tabId);
    console.log('[Harbor Router] handleTabsCreate - created tab:', tab.id, 'for origin:', ctx.origin);
    sender.sendResponse({ id: ctx.id, ok: true, result: tab });
  } catch (error) {
    console.log('[Harbor Router] handleTabsCreate - error:', error);
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Failed to create tab',
      },
    });
  }
}

/**
 * Handle agent.browser.tabs.close - Close a tab.
 */
export async function handleTabsClose(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'browser:tabs.create'))) {
    return;
  }

  const payload = ctx.payload as { tabId: number };

  // Check if origin can control this tab
  if (!canOriginControlTab(ctx.origin, payload.tabId)) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_PERMISSION_DENIED',
        message: 'Cannot close tab: origin did not create this tab',
      },
    });
    return;
  }

  try {
    const result = await closeTab(ctx.origin, payload.tabId);
    sender.sendResponse({ id: ctx.id, ok: true, result });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Failed to close tab',
      },
    });
  }
}

// =============================================================================
// Spawned Tab Operations (operations on tabs the origin created)
// =============================================================================

/**
 * Handle agent.browser.tab.readability - Read content from a spawned tab.
 */
export async function handleSpawnedTabReadability(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  log('handleSpawnedTabReadability - origin:', ctx.origin, 'tabId:', ctx.tabId, 'payload:', ctx.payload);
  
  if (!(await requirePermission(ctx, sender, 'browser:tabs.create'))) {
    return;
  }

  const payload = ctx.payload as { tabId: number };

  if (!canOriginControlTab(ctx.origin, payload.tabId)) {
    console.log('[Harbor Router] handleSpawnedTabReadability: canOriginControlTab failed for origin:', ctx.origin, 'tabId:', payload.tabId);
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_PERMISSION_DENIED',
        message: 'Cannot read tab: origin did not create this tab',
      },
    });
    return;
  }

  try {
    const result = await getTabReadability(payload.tabId);
    sender.sendResponse({ id: ctx.id, ok: true, result });
  } catch (error) {
    console.log('[Harbor Router] handleSpawnedTabReadability: getTabReadability failed for tabId:', payload.tabId, 'error:', error);
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: (error as { code?: string }).code || 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Failed to read tab',
      },
    });
  }
}

/**
 * Handle agent.browser.tab.getHtml - Get HTML from a spawned tab.
 */
export async function handleSpawnedTabGetHtml(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'browser:tabs.create'))) {
    return;
  }

  const payload = ctx.payload as { tabId: number; selector?: string };

  if (!canOriginControlTab(ctx.origin, payload.tabId)) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_PERMISSION_DENIED',
        message: 'Cannot read tab: origin did not create this tab',
      },
    });
    return;
  }

  try {
    const result = await getTabHtml(payload.tabId, payload.selector);
    sender.sendResponse({ id: ctx.id, ok: true, result });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Failed to get HTML from tab',
      },
    });
  }
}

/**
 * Handle agent.browser.tab.click - Click element in a spawned tab.
 */
export async function handleSpawnedTabClick(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'browser:tabs.create'))) {
    return;
  }

  const payload = ctx.payload as { tabId: number; selector: string; options?: { button?: string; clickCount?: number } };

  if (!canOriginControlTab(ctx.origin, payload.tabId)) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_PERMISSION_DENIED',
        message: 'Cannot interact with tab: origin did not create this tab',
      },
    });
    return;
  }

  try {
    await clickElement(payload.tabId, payload.selector, payload.options);
    sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Click failed',
      },
    });
  }
}

/**
 * Handle agent.browser.tab.fill - Fill input in a spawned tab.
 */
export async function handleSpawnedTabFill(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'browser:tabs.create'))) {
    return;
  }

  const payload = ctx.payload as { tabId: number; selector: string; value: string };

  if (!canOriginControlTab(ctx.origin, payload.tabId)) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_PERMISSION_DENIED',
        message: 'Cannot interact with tab: origin did not create this tab',
      },
    });
    return;
  }

  try {
    await fillInput(payload.tabId, payload.selector, payload.value);
    sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Fill failed',
      },
    });
  }
}

/**
 * Handle agent.browser.tab.scroll - Scroll in a spawned tab.
 */
export async function handleSpawnedTabScroll(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'browser:tabs.create'))) {
    return;
  }

  const payload = ctx.payload as { tabId: number; x?: number; y?: number; selector?: string; behavior?: 'auto' | 'smooth' };

  if (!canOriginControlTab(ctx.origin, payload.tabId)) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_PERMISSION_DENIED',
        message: 'Cannot interact with tab: origin did not create this tab',
      },
    });
    return;
  }

  try {
    await scrollPage(payload.tabId, payload);
    sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Scroll failed',
      },
    });
  }
}

/**
 * Handle agent.browser.tab.screenshot - Take screenshot of a spawned tab.
 */
export async function handleSpawnedTabScreenshot(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'browser:tabs.create'))) {
    return;
  }

  const payload = ctx.payload as { tabId: number; format?: 'png' | 'jpeg'; quality?: number };

  if (!canOriginControlTab(ctx.origin, payload.tabId)) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_PERMISSION_DENIED',
        message: 'Cannot screenshot tab: origin did not create this tab',
      },
    });
    return;
  }

  try {
    const result = await takeScreenshot(payload.tabId, payload);
    sender.sendResponse({ id: ctx.id, ok: true, result });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Screenshot failed',
      },
    });
  }
}

/**
 * Handle agent.browser.tab.navigate - Navigate a spawned tab.
 */
export async function handleSpawnedTabNavigate(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'browser:tabs.create'))) {
    return;
  }

  const payload = ctx.payload as { tabId: number; url: string };

  if (!canOriginControlTab(ctx.origin, payload.tabId)) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_PERMISSION_DENIED',
        message: 'Cannot navigate tab: origin did not create this tab',
      },
    });
    return;
  }

  try {
    await navigateTab(ctx.origin, payload.tabId, payload.url, false);
    sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Navigation failed',
      },
    });
  }
}

/**
 * Handle agent.browser.tab.waitForNavigation - Wait for navigation in a spawned tab.
 */
export async function handleSpawnedTabWaitForNavigation(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'browser:tabs.create'))) {
    return;
  }

  const payload = ctx.payload as { tabId: number; timeout?: number };

  if (!canOriginControlTab(ctx.origin, payload.tabId)) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_PERMISSION_DENIED',
        message: 'Cannot wait on tab: origin did not create this tab',
      },
    });
    return;
  }

  try {
    await waitForNavigation(payload.tabId, payload.timeout);
    sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_TIMEOUT',
        message: error instanceof Error ? error.message : 'Navigation timeout',
      },
    });
  }
}
