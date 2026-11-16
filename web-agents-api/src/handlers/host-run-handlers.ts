/**
 * Host Run Handlers
 *
 * Invoked by Harbor when the bridge sends a host_request (MCP server asked the
 * host to open a tab and return content/cookies). We require the request
 * context's origin to have browser:tabs.create (and we use spawned-tab semantics).
 *
 * When a page started the tool call, the capture is limited to that page's own
 * origin, like the page-facing spawned-tab reads. Only the Harbor sidebar
 * (origin 'harbor-extension') can capture other sites.
 *
 * See harbor/docs/MCP_BROWSER_CAPTURE_DESIGN.md.
 */

import { hasPermission } from './permission-handlers';
import { trackSpawnedTab, originOf } from './tab-handlers';
import { executeScriptInTab } from './browser-compat';

export type HostRunPayload = {
  method: string;
  params: Record<string, unknown>;
  context: { origin?: string; tabId?: number };
};

export type HostRunResult = { ok: true; result: unknown } | { ok: false; error: string };

/**
 * Run a host method (browser.capturePage, browser.getCookies) on behalf of an
 * origin. Called when Harbor forwards a host_request from the bridge.
 */
/** Sentinel origin when the tool is run from Harbor UI (e.g. Tool Tester) with no page context. */
const HARBOR_EXTENSION_ORIGIN = 'harbor-extension';

const OTHER_ORIGIN_ERROR = "A page can only capture its own origin";

/** The origin a capture must stay on, or null when any origin is allowed. */
function requiredOrigin(origin: string): string | null {
  return origin === HARBOR_EXTENSION_ORIGIN ? null : origin;
}

export async function handleHostRun(payload: HostRunPayload): Promise<HostRunResult> {
  const { method, params, context } = payload;
  const origin = context?.origin || '';

  if (!origin) {
    return { ok: false, error: 'Missing origin in host request context' };
  }

  // Harbor sends origin 'harbor-extension' when the tool is run from the sidebar (no page origin)
  const effectiveOrigin = origin === HARBOR_EXTENSION_ORIGIN ? HARBOR_EXTENSION_ORIGIN : origin;

  if (method === 'browser.capturePage') {
    return runCapturePage(effectiveOrigin, params);
  }
  if (method === 'browser.getCookies') {
    return runGetCookies(effectiveOrigin, params);
  }

  // Lightweight ping for Harbor to detect that Web Agents is installed and running
  if (method === 'ping') {
    return { ok: true, result: { pong: true } };
  }

  return { ok: false, error: `Unknown host method: ${method}` };
}

async function runCapturePage(
  origin: string,
  params: Record<string, unknown>
): Promise<HostRunResult> {
  const allowed =
    origin === HARBOR_EXTENSION_ORIGIN || (await hasPermission(origin, 'browser:tabs.create'));
  if (!allowed) {
    return { ok: false, error: 'Permission browser:tabs.create required' };
  }

  const url = params.url as string | undefined;
  if (!url || typeof url !== 'string') {
    return { ok: false, error: 'Missing or invalid url parameter' };
  }

  const mustMatch = requiredOrigin(origin);
  if (mustMatch && originOf(url) !== mustMatch) {
    return { ok: false, error: OTHER_ORIGIN_ERROR };
  }

  const waitForLoad = (params.waitForLoad as boolean) !== false;
  const timeout = Math.min(Math.max(Number(params.timeout) || 15000, 1000), 60000);
  const captureCookies = (params.captureCookies as boolean) === true;

  try {
    const tab = await chrome.tabs.create({ url, active: false });
    if (!tab?.id) {
      return { ok: false, error: 'Failed to create tab' };
    }

    trackSpawnedTab(origin, tab.id);

    if (waitForLoad) {
      await waitForTabLoad(tab.id, timeout);
    }

    const result = await executeScriptInTab<{
      title: string;
      url: string;
      content: string;
      text: string;
      cookies?: string;
    } | { originMismatch: true }>(
      tab.id,
      (expectedOrigin: unknown, doCaptureCookies: unknown) => {
        if (expectedOrigin && window.location.origin !== expectedOrigin) {
          return { originMismatch: true as const };
        }
        const title = document.title;
        const url = window.location.href;
        const mainSelectors = ['main', 'article', '[role="main"]', '.content', '#content', '.post', '.article'];
        let content = '';
        for (const selector of mainSelectors) {
          const el = document.querySelector(selector);
          if (el) {
            content = el.textContent?.trim() || '';
            break;
          }
        }
        if (!content) {
          content = document.body?.textContent?.trim() || '';
        }
        content = content.replace(/\s+/g, ' ').trim().slice(0, 50000);
        const cookies = doCaptureCookies === true ? document.cookie : undefined;
        return { title, url, content, text: content, cookies };
      },
      [mustMatch, captureCookies]
    );

    if (!result) {
      return { ok: false, error: 'Failed to extract page content' };
    }
    if ('originMismatch' in result) {
      return { ok: false, error: OTHER_ORIGIN_ERROR };
    }

    return {
      ok: true,
      result: {
        content: result.content,
        title: result.title,
        url: result.url,
        ...(result.cookies !== undefined && { cookies: result.cookies }),
      },
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'browser.capturePage failed',
    };
  }
}

async function runGetCookies(
  origin: string,
  params: Record<string, unknown>
): Promise<HostRunResult> {
  const allowed =
    origin === HARBOR_EXTENSION_ORIGIN || (await hasPermission(origin, 'browser:tabs.create'));
  if (!allowed) {
    return { ok: false, error: 'Permission browser:tabs.create required' };
  }

  const domain = params.domain as string | undefined;
  const openUrl = params.openUrl as string | undefined;

  if (!domain || typeof domain !== 'string') {
    return { ok: false, error: 'Missing or invalid domain parameter' };
  }

  const mustMatch = requiredOrigin(origin);
  if (mustMatch && openUrl && originOf(openUrl) !== mustMatch) {
    return { ok: false, error: OTHER_ORIGIN_ERROR };
  }

  try {
    let tabId: number | undefined;

    if (openUrl) {
      const tab = await chrome.tabs.create({ url: openUrl, active: false });
      if (!tab?.id) {
        return { ok: false, error: 'Failed to create tab' };
      }
      trackSpawnedTab(origin, tab.id);
      await waitForTabLoad(tab.id, 10000);
      tabId = tab.id;
    } else {
      const tabs = await chrome.tabs.query({});
      const found = tabs.find(
        (t) => t.url
          && (!mustMatch || originOf(t.url) === mustMatch)
          && (t.url.includes(domain) || new URL(t.url).hostname === domain.replace(/^\./, ''))
      );
      tabId = found?.id;
      if (!tabId) {
        return { ok: false, error: `No open tab found for domain ${domain}. Provide openUrl to open one.` };
      }
    }

    const result = await executeScriptInTab<{ cookies: string } | { originMismatch: true }>(
      tabId,
      (expectedOrigin: unknown) => {
        if (expectedOrigin && window.location.origin !== expectedOrigin) {
          return { originMismatch: true as const };
        }
        return { cookies: document.cookie };
      },
      [mustMatch]
    );

    if (!result) {
      return { ok: false, error: 'Failed to read cookies' };
    }
    if ('originMismatch' in result) {
      return { ok: false, error: OTHER_ORIGIN_ERROR };
    }

    return { ok: true, result: { cookies: result.cookies } };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'browser.getCookies failed',
    };
  }
}

function waitForTabLoad(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab load timeout'));
    }, timeoutMs);

    const listener = (
      updatedTabId: number,
      changeInfo: chrome.tabs.TabChangeInfo
    ) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };

    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
        return;
      }
      chrome.tabs.onUpdated.addListener(listener);
    }).catch(reject);
  });
}
