/**
 * Browser API handlers for same-tab operations.
 */

import type { RequestContext, ResponseSender } from './router-types';
import { requirePermission } from './helpers';
import {
  getTabReadability,
  clickElement,
  fillInput,
  selectOption,
  scrollPage,
  getElementInfo,
  waitForSelector,
  takeScreenshot,
} from '../browser-api';

/**
 * Handle agent.browser.activeTab.readability - Get readable content from current tab.
 */
export async function handleActiveTabReadability(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'browser:activeTab.read'))) {
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

  try {
    const result = await getTabReadability(ctx.tabId);
    sender.sendResponse({ id: ctx.id, ok: true, result });
  } catch (error) {
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
 * Handle agent.browser.activeTab.click - Click an element.
 */
export async function handleActiveTabClick(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'browser:activeTab.interact'))) {
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

  const payload = ctx.payload as { selector: string; options?: { button?: string; clickCount?: number } };

  try {
    await clickElement(ctx.tabId, payload.selector, payload.options);
    sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: (error as { code?: string }).code || 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Click failed',
      },
    });
  }
}

/**
 * Handle agent.browser.activeTab.fill - Fill an input element.
 */
export async function handleActiveTabFill(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'browser:activeTab.interact'))) {
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

  const payload = ctx.payload as { selector: string; value: string };

  try {
    await fillInput(ctx.tabId, payload.selector, payload.value);
    sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: (error as { code?: string }).code || 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Fill failed',
      },
    });
  }
}

/**
 * Handle agent.browser.activeTab.select - Select an option.
 */
export async function handleActiveTabSelect(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'browser:activeTab.interact'))) {
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

  const payload = ctx.payload as { selector: string; value: string };

  try {
    await selectOption(ctx.tabId, payload.selector, payload.value);
    sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: (error as { code?: string }).code || 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Select failed',
      },
    });
  }
}

/**
 * Handle agent.browser.activeTab.scroll - Scroll the page.
 */
export async function handleActiveTabScroll(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'browser:activeTab.interact'))) {
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

  const payload = ctx.payload as { x?: number; y?: number; selector?: string; behavior?: 'auto' | 'smooth' };

  try {
    await scrollPage(ctx.tabId, payload);
    sender.sendResponse({ id: ctx.id, ok: true, result: undefined });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: (error as { code?: string }).code || 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Scroll failed',
      },
    });
  }
}

/**
 * Handle agent.browser.activeTab.getElement - Get element info.
 */
export async function handleActiveTabGetElement(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'browser:activeTab.read'))) {
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

  const payload = ctx.payload as { selector: string };

  try {
    const result = await getElementInfo(ctx.tabId, payload.selector);
    sender.sendResponse({ id: ctx.id, ok: true, result });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: (error as { code?: string }).code || 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Get element failed',
      },
    });
  }
}

/**
 * Handle agent.browser.activeTab.waitForSelector - Wait for an element.
 */
export async function handleActiveTabWaitForSelector(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'browser:activeTab.read'))) {
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

  const payload = ctx.payload as { selector: string; options?: { timeout?: number; visible?: boolean } };

  try {
    const result = await waitForSelector(ctx.tabId, payload.selector, payload.options);
    sender.sendResponse({ id: ctx.id, ok: true, result });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: (error as { code?: string }).code || 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Wait failed',
      },
    });
  }
}

/**
 * Handle agent.browser.activeTab.screenshot - Take a screenshot.
 */
export async function handleActiveTabScreenshot(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'browser:activeTab.screenshot'))) {
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

  const payload = ctx.payload as { format?: 'png' | 'jpeg'; quality?: number } | undefined;

  try {
    const result = await takeScreenshot(ctx.tabId, payload);
    sender.sendResponse({ id: ctx.id, ok: true, result });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: (error as { code?: string }).code || 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Screenshot failed',
      },
    });
  }
}
