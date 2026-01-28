/**
 * Browser API
 *
 * Implements browser-related APIs for page interaction.
 * 
 * SECURITY MODEL:
 * - Same-Tab Only: Web pages can only interact with their own tab
 * - The tabId comes from the message sender, not from user selection
 * - This prevents malicious pages from controlling other tabs
 */

import { browserAPI } from '../browser-compat';
import type { ActiveTabReadability } from './types';

const MAX_TEXT_LENGTH = 50000;

const PRIVILEGED_PROTOCOLS = [
  'about:',
  'chrome:',
  'chrome-extension:',
  'moz-extension:',
  'edge:',
  'brave:',
  'opera:',
  'file:',
];

// =============================================================================
// Tab Validation
// =============================================================================

/**
 * Get and validate tab info for the requesting tab.
 * This ensures we only operate on the tab that made the request.
 */
async function getRequestingTab(tabId: number): Promise<ReturnType<typeof browserAPI.tabs.get> extends Promise<infer T> ? T : never> {
  const tab = await browserAPI.tabs.get(tabId);

  if (!tab || !tab.url) {
    throw Object.assign(
      new Error('Tab not found or has no URL'),
      { code: 'ERR_INTERNAL' }
    );
  }

  // Check for privileged pages
  for (const protocol of PRIVILEGED_PROTOCOLS) {
    if (tab.url.startsWith(protocol)) {
      throw Object.assign(
        new Error(`Cannot interact with privileged page: ${protocol}`),
        { code: 'ERR_PERMISSION_DENIED' }
      );
    }
  }

  return tab;
}

// =============================================================================
// Readability (Read-Only)
// =============================================================================

/**
 * Extract readable text content from the requesting tab.
 * 
 * @param tabId - The tab ID of the requesting page (from sender)
 */
export async function getTabReadability(tabId: number): Promise<ActiveTabReadability> {
  const tab = await getRequestingTab(tabId);

  // Execute content extraction script in the requesting tab
  try {
    const results = await browserAPI.scripting.executeScript({
      target: { tabId },
      func: extractReadableContent,
    });

    if (!results || results.length === 0 || !results[0].result) {
      throw new Error('Failed to extract content');
    }

    const { text, title } = results[0].result as { text: string; title: string };

    return {
      url: tab.url!,
      title: title || tab.title || 'Untitled',
      text: text.slice(0, MAX_TEXT_LENGTH),
    };
  } catch (error) {
    // Handle common errors
    if (error instanceof Error) {
      if (error.message.includes('Cannot access')) {
        throw Object.assign(
          new Error('Cannot read content from this page'),
          { code: 'ERR_PERMISSION_DENIED' }
        );
      }
      if (error.message.includes('No frame with id')) {
        throw Object.assign(
          new Error('Page is not accessible'),
          { code: 'ERR_INTERNAL' }
        );
      }
    }

    throw Object.assign(
      new Error(`Content extraction failed: ${error instanceof Error ? error.message : 'Unknown error'}`),
      { code: 'ERR_INTERNAL' }
    );
  }
}

// =============================================================================
// Page Interaction (Same-Tab Only)
// =============================================================================

export interface ClickOptions {
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
}

export interface ElementInfo {
  tagName: string;
  id?: string;
  className?: string;
  textContent?: string;
  isVisible: boolean;
  isEnabled: boolean;
  boundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

/**
 * Click an element in the requesting tab.
 */
export async function clickElement(tabId: number, selector: string, options?: ClickOptions): Promise<void> {
  await getRequestingTab(tabId);

  const results = await browserAPI.scripting.executeScript({
    target: { tabId },
    func: (sel: string, opts: ClickOptions | undefined) => {
      const element = document.querySelector(sel) as HTMLElement | null;
      if (!element) {
        throw new Error(`Element not found: ${sel}`);
      }

      // Check if element is visible
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        throw new Error(`Element is not visible: ${sel}`);
      }

      // Check if element is disabled
      if ((element as HTMLButtonElement).disabled) {
        throw new Error(`Element is disabled: ${sel}`);
      }

      // Create and dispatch click event
      const clickEvent = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window,
        button: opts?.button === 'right' ? 2 : opts?.button === 'middle' ? 1 : 0,
      });

      // For multiple clicks
      const clickCount = opts?.clickCount || 1;
      for (let i = 0; i < clickCount; i++) {
        element.dispatchEvent(clickEvent);
      }

      // Also call click() for form elements
      if (typeof element.click === 'function') {
        element.click();
      }
    },
    args: [selector, options],
  });

  // Check for errors
  if (results[0]?.error) {
    throw Object.assign(
      new Error(results[0].error.message || 'Click failed'),
      { code: 'ERR_INTERNAL' }
    );
  }
}

/**
 * Fill an input element in the requesting tab.
 */
export async function fillInput(tabId: number, selector: string, value: string): Promise<void> {
  await getRequestingTab(tabId);

  const results = await browserAPI.scripting.executeScript({
    target: { tabId },
    func: (sel: string, val: string) => {
      const element = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
      if (!element) {
        throw new Error(`Element not found: ${sel}`);
      }

      // Check if it's an input-like element
      if (!('value' in element)) {
        throw new Error(`Element is not fillable: ${sel}`);
      }

      // Check if element is disabled or readonly
      if (element.disabled || element.readOnly) {
        throw new Error(`Element is disabled or read-only: ${sel}`);
      }

      // Focus the element
      element.focus();

      // Clear existing value
      element.value = '';

      // Set new value
      element.value = val;

      // Dispatch input events to trigger any listeners
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    },
    args: [selector, value],
  });

  if (results[0]?.error) {
    throw Object.assign(
      new Error(results[0].error.message || 'Fill failed'),
      { code: 'ERR_INTERNAL' }
    );
  }
}

/**
 * Select an option in a select element.
 */
export async function selectOption(tabId: number, selector: string, value: string): Promise<void> {
  await getRequestingTab(tabId);

  const results = await browserAPI.scripting.executeScript({
    target: { tabId },
    func: (sel: string, val: string) => {
      const element = document.querySelector(sel) as HTMLSelectElement | null;
      if (!element) {
        throw new Error(`Element not found: ${sel}`);
      }

      if (element.tagName !== 'SELECT') {
        throw new Error(`Element is not a select: ${sel}`);
      }

      if (element.disabled) {
        throw new Error(`Select is disabled: ${sel}`);
      }

      // Find and select the option
      const option = Array.from(element.options).find(
        opt => opt.value === val || opt.textContent === val
      );

      if (!option) {
        throw new Error(`Option not found: ${val}`);
      }

      element.value = option.value;
      element.dispatchEvent(new Event('change', { bubbles: true }));
    },
    args: [selector, value],
  });

  if (results[0]?.error) {
    throw Object.assign(
      new Error(results[0].error.message || 'Select failed'),
      { code: 'ERR_INTERNAL' }
    );
  }
}

/**
 * Scroll the page or a specific element.
 */
export async function scrollPage(
  tabId: number, 
  options: { x?: number; y?: number; selector?: string; behavior?: 'auto' | 'smooth' }
): Promise<void> {
  await getRequestingTab(tabId);

  await browserAPI.scripting.executeScript({
    target: { tabId },
    func: (opts: { x?: number; y?: number; selector?: string; behavior?: 'auto' | 'smooth' }) => {
      if (opts.selector) {
        const element = document.querySelector(opts.selector);
        if (!element) {
          throw new Error(`Element not found: ${opts.selector}`);
        }
        element.scrollIntoView({ behavior: opts.behavior || 'smooth' });
      } else {
        window.scrollTo({
          left: opts.x ?? window.scrollX,
          top: opts.y ?? window.scrollY,
          behavior: opts.behavior || 'smooth',
        });
      }
    },
    args: [options],
  });
}

/**
 * Get information about an element.
 */
export async function getElementInfo(tabId: number, selector: string): Promise<ElementInfo | null> {
  await getRequestingTab(tabId);

  const results = await browserAPI.scripting.executeScript({
    target: { tabId },
    func: (sel: string): ElementInfo | null => {
      const element = document.querySelector(sel) as HTMLElement | null;
      if (!element) {
        return null;
      }

      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);

      return {
        tagName: element.tagName.toLowerCase(),
        id: element.id || undefined,
        className: element.className || undefined,
        textContent: element.textContent?.slice(0, 500) || undefined,
        isVisible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden',
        isEnabled: !(element as HTMLButtonElement).disabled,
        boundingBox: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
      };
    },
    args: [selector],
  });

  return results[0]?.result ?? null;
}

/**
 * Wait for an element to appear using MutationObserver (not polling).
 */
export async function waitForSelector(
  tabId: number, 
  selector: string, 
  options?: { timeout?: number; visible?: boolean }
): Promise<ElementInfo> {
  await getRequestingTab(tabId);

  const timeout = options?.timeout ?? 30000;
  const checkVisible = options?.visible ?? false;

  // Inject a script that uses MutationObserver to efficiently wait for the element
  const results = await browserAPI.scripting.executeScript({
    target: { tabId },
    func: (sel: string, timeoutMs: number, mustBeVisible: boolean) => {
      return new Promise<{
        tag: string;
        id: string | null;
        className: string;
        textContent: string | null;
        isVisible: boolean;
        rect: { x: number; y: number; width: number; height: number };
      } | null>((resolve, reject) => {
        const getElementInfo = (el: Element) => {
          const rect = el.getBoundingClientRect();
          const isVisible = rect.width > 0 && rect.height > 0 && 
            window.getComputedStyle(el).visibility !== 'hidden' &&
            window.getComputedStyle(el).display !== 'none';
          return {
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            className: el.className || '',
            textContent: el.textContent?.slice(0, 100) || null,
            isVisible,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          };
        };

        const checkElement = () => {
          const el = document.querySelector(sel);
          if (el) {
            const info = getElementInfo(el);
            if (!mustBeVisible || info.isVisible) {
              return info;
            }
          }
          return null;
        };

        // Check immediately
        const immediate = checkElement();
        if (immediate) {
          resolve(immediate);
          return;
        }

        // Set up MutationObserver
        let observer: MutationObserver | null = null;
        let timeoutId: number | null = null;

        const cleanup = () => {
          if (observer) {
            observer.disconnect();
            observer = null;
          }
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
        };

        observer = new MutationObserver(() => {
          const result = checkElement();
          if (result) {
            cleanup();
            resolve(result);
          }
        });

        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'style', 'hidden'],
        });

        // Timeout
        timeoutId = window.setTimeout(() => {
          cleanup();
          reject(new Error(`Timeout waiting for selector: ${sel}`));
        }, timeoutMs);
      });
    },
    args: [selector, timeout, checkVisible],
  });

  const result = results[0]?.result;
  if (!result) {
    throw Object.assign(
      new Error(`Timeout waiting for selector: ${selector}`),
      { code: 'ERR_TIMEOUT' }
    );
  }

  return result;
}

/**
 * Take a screenshot of the tab.
 */
export async function takeScreenshot(tabId: number, options?: { 
  format?: 'png' | 'jpeg'; 
  quality?: number;
}): Promise<string> {
  // Verify tab is accessible
  await getRequestingTab(tabId);

  // Make sure the tab is active for screenshot
  const tab = await browserAPI.tabs.get(tabId);
  
  // captureVisibleTab requires the tab to be in the current window
  const dataUrl = await browserAPI.tabs.captureVisibleTab(tab.windowId, {
    format: options?.format || 'png',
    quality: options?.quality,
  });

  return dataUrl;
}

/**
 * Content extraction function that runs in the page context.
 * This function is injected into the target page.
 */
function extractReadableContent(): { text: string; title: string } {
  const title = document.title;

  // Remove unwanted elements
  const elementsToRemove = [
    'script',
    'style',
    'noscript',
    'iframe',
    'object',
    'embed',
    'nav',
    'header',
    'footer',
    'aside',
    '[role="navigation"]',
    '[role="banner"]',
    '[role="contentinfo"]',
    '[aria-hidden="true"]',
    '.ad',
    '.ads',
    '.advertisement',
    '.social-share',
    '.comments',
    '.related-posts',
    '.sidebar',
    '.cookie-banner',
    '.popup',
    '.modal',
  ];

  // Clone the document to avoid modifying the actual page
  const clone = document.body.cloneNode(true) as HTMLElement;

  // Remove unwanted elements from clone
  for (const selector of elementsToRemove) {
    const elements = clone.querySelectorAll(selector);
    elements.forEach((el) => el.remove());
  }

  // Try to find main content area
  const mainSelectors = [
    'main',
    'article',
    '[role="main"]',
    '.content',
    '.post-content',
    '.article-content',
    '.entry-content',
    '#content',
    '#main',
  ];

  let contentElement: HTMLElement | null = null;
  for (const selector of mainSelectors) {
    contentElement = clone.querySelector(selector);
    if (contentElement) break;
  }

  // Fall back to body if no main content found
  const targetElement = contentElement || clone;

  // Extract text
  let text = extractTextFromElement(targetElement);

  // Clean up whitespace
  text = text
    .replace(/\s+/g, ' ')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();

  return { text, title };
}

/**
 * Extract text content from an element, preserving structure.
 */
function extractTextFromElement(element: HTMLElement): string {
  const textParts: string[] = [];

  function walk(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim();
      if (text) {
        textParts.push(text);
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      const tagName = el.tagName.toLowerCase();

      // Skip hidden elements
      const style = window.getComputedStyle?.(el);
      if (style?.display === 'none' || style?.visibility === 'hidden') {
        return;
      }

      // Add newlines for block elements
      const blockElements = [
        'p', 'div', 'section', 'article', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'li', 'br', 'hr', 'blockquote', 'pre', 'table', 'tr',
      ];

      if (blockElements.includes(tagName)) {
        textParts.push('\n');
      }

      // Process children
      for (const child of el.childNodes) {
        walk(child);
      }

      if (blockElements.includes(tagName)) {
        textParts.push('\n');
      }
    }
  }

  walk(element);
  return textParts.join(' ');
}
