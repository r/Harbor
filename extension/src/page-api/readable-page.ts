/**
 * Harbor's one way to read a page: its URL, title and main text.
 *
 * Used by agent.browser.activeTab.readability(), agent.browser.tab.readability()
 * and browser capture for MCP host requests.
 */

import type { ActiveTabReadability } from '../agents/types';

export type ReadablePage = ActiveTabReadability;
export type OriginMismatch = { originMismatch: true };

export function isOriginMismatch(value: unknown): value is OriginMismatch {
  return typeof value === 'object' && value !== null && (value as OriginMismatch).originMismatch === true;
}

/**
 * Runs inside the tab through executeScriptInTab, which serializes it. It must
 * not refer to anything outside its own body, including module constants.
 *
 * With `expectedOrigin`, it reads nothing unless the page is still on that
 * origin, because the tab can navigate between a caller's check and this run.
 */
export function extractReadablePage(expectedOrigin?: unknown): ReadablePage | OriginMismatch {
  if (typeof expectedOrigin === 'string' && window.location.origin !== expectedOrigin) {
    return { originMismatch: true };
  }

  const maxChars = 50000;
  const mainSelectors = ['main', 'article', '[role="main"]', '.content', '#content', '.post', '.article'];
  let root: Element | null = null;
  for (const selector of mainSelectors) {
    root = document.querySelector(selector);
    if (root) break;
  }
  const el = (root ?? document.body) as HTMLElement | null;
  const raw = el ? (el.innerText?.trim() || el.textContent?.trim() || '') : '';
  const text = raw
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, maxChars);

  return { url: window.location.href, title: document.title, text };
}
