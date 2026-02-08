/**
 * Harbor-owned browser capture for MCP host_request.
 * Opens tabs, captures content/cookies locally. No dependency on Web Agents.
 * See docs/MCP_BROWSER_CAPTURE_DESIGN.md §10.
 */

import { browserAPI, executeScriptInTab, executeScriptInTabAllFrames } from '../browser-compat';

const HARBOR_EXTENSION_ORIGIN = 'harbor-extension';

export function isAllowedOrigin(origin: string | undefined): boolean {
  return !origin || origin === HARBOR_EXTENSION_ORIGIN;
}

export type LinkWithText = { text: string; url: string };

/** One article extracted from a search results page (e.g. Atlantic) in a single DOM pass. */
export type SearchResultItem = {
  title: string;
  url: string;
  author?: string;
  date?: string;
  snippet?: string;
};

/** Extracted from an article page (e.g. Atlantic) in one DOM pass: text, byline, date, image URLs. */
export type ArticleDetail = {
  text: string;
  author?: string;
  date?: string;
  imageUrls?: string[];
};

export type CapturePageResult = {
  content: string;
  title?: string;
  url?: string;
  cookies?: string;
  links?: string[];
  linksWithText?: LinkWithText[];
  /** When on a known search page (e.g. Atlantic), articles extracted in one DOM pass. */
  searchResults?: SearchResultItem[];
  /** When on an Atlantic article page, structured article data from one DOM pass. */
  articleDetail?: ArticleDetail;
};
export type GetCookiesResult = { cookies: string };

/** Default selectors for login form (override via params). Try multiple so we match Atlantic etc. */
const DEFAULT_LOGIN = {
  emailSelector:
    'input[type="email"], input[name="email"], input[id="email"], input[autocomplete="email"], input[type="text"][name="email"], input[type="text"][id="email"]',
  passwordSelector:
    'input[type="password"], input[name="password"], input[id="password"], input[autocomplete="current-password"], input[name*="pass"], input[id*="pass"], input[type="text"][name*="pass"], input[type="text"][id*="pass"]',
  submitSelector:
    'button[type="submit"], input[type="submit"], [type="submit"], button[type="button"]',
};

const LOG_PREFIX = '[Harbor:capture]';

function isStillOnLoginPage(loginPath: string, currentPath: string): boolean {
  return currentPath === loginPath || currentPath.startsWith(loginPath + '/');
}

/** Run in tab to get login-page diagnostics when form not found. */
async function getLoginPageDiagnostics(
  tabId: number,
  selector1: string,
  selector2: string
): Promise<{ url: string; readyState: string; selector1Found: boolean; selector2Found: boolean; details: string }> {
  try {
    const result = await executeScriptInTab<{ url: string; readyState: string; selector1Found: boolean; selector2Found: boolean; details: string }>(
      tabId,
      (sel1: string, sel2: string) => {
        const queryFirst = (selList: string) => {
          const parts = selList.split(',').map((p) => p.trim()).filter(Boolean);
          for (const p of parts) {
            const el = document.querySelector(p);
            if (el) return el;
          }
          return null;
        };
        const forms = document.querySelectorAll('form');
        const inputs = document.querySelectorAll('input');
        return {
          url: window.location.href,
          readyState: document.readyState,
          selector1Found: !!queryFirst(sel1),
          selector2Found: !!queryFirst(sel2),
          details: `forms=${forms.length} inputs=${inputs.length}`,
        };
      },
      [selector1, selector2]
    );
    return result ?? { url: 'unknown', readyState: 'unknown', selector1Found: false, selector2Found: false, details: 'script returned nothing' };
  } catch (e) {
    return {
      url: 'unknown',
      readyState: 'unknown',
      selector1Found: false,
      selector2Found: false,
      details: String(e),
    };
  }
}

/**
 * Run login flow only (open login URL, fill form, submit, wait). Does not capture.
 * Call this at the start of a session so subsequent capturePage calls use the logged-in session.
 */
export async function runEnsureLogin(params: Record<string, unknown>): Promise<{ ok: boolean }> {
  const loginUrl = params.loginUrl as string | undefined;
  const email = params.email as string | undefined;
  const password = params.password as string | undefined;
  const thenNavigateTo = params.thenNavigateTo as string | undefined;
  if (!loginUrl || typeof loginUrl !== 'string') throw new Error('Missing or invalid loginUrl');
  if (!email || !password) throw new Error('Missing email or password');

  const emailSel = (params.emailSelector as string) || DEFAULT_LOGIN.emailSelector;
  const passwordSel = (params.passwordSelector as string) || DEFAULT_LOGIN.passwordSelector;
  const submitSel = (params.submitSelector as string) || DEFAULT_LOGIN.submitSelector;
  const timeout = Math.min(Math.max(Number(params.timeout) || 20000, 5000), 60000);
  const navWait = Math.min(15000, Math.max(3000, timeout - 2000));

  const tab = await browserAPI.tabs.create({ url: loginUrl, active: false });
  if (!tab?.id) throw new Error('Failed to create tab');

  console.log(LOG_PREFIX, 'ensureLogin: start', { loginUrl: loginUrl.slice(0, 50), tabId: tab.id });

  try {
    await waitForTabLoadAndInjectable(tab.id, timeout);
    const tabAfterLoad = await browserAPI.tabs.get(tab.id);
    const currentUrl = tabAfterLoad.url ?? '';
    console.log(LOG_PREFIX, 'ensureLogin: tab after load', { url: currentUrl, status: tabAfterLoad.status });

    // If we were redirected off the login page (e.g. to /accounts/details/), we're already logged in
    const loginPath = new URL(loginUrl).pathname.replace(/\/?$/, '') || '/login';
    const currentPath = (() => {
      try {
        return new URL(currentUrl).pathname.replace(/\/?$/, '') || '/';
      } catch {
        return '/';
      }
    })();
    if (!isStillOnLoginPage(loginPath, currentPath)) {
      console.log(LOG_PREFIX, 'ensureLogin: already logged in (redirected to)', currentPath);
      if (thenNavigateTo && typeof thenNavigateTo === 'string') {
        console.log(LOG_PREFIX, 'ensureLogin: navigating to', thenNavigateTo.slice(0, 60));
        await browserAPI.tabs.update(tab.id, { url: thenNavigateTo });
        await waitForTabLoadAndInjectable(tab.id, timeout);
      } else {
        await new Promise((r) => setTimeout(r, 500));
      }
      return { ok: true };
    }

    // Retry once after a short wait in case the form is injected by JS
    let firstStep: { done: boolean; hasPassword: boolean } | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        console.log(LOG_PREFIX, 'ensureLogin: retry attempt', attempt);
        await new Promise((r) => setTimeout(r, 2000));
      }
      firstStep = await executeScriptInTabAllFrames<{ done: boolean; hasPassword: boolean }>(
        tab.id,
        (emSel: string, subSel: string, em: string) => {
          const queryFirst = (selList: string) => {
          const parts = selList.split(',').map((p) => p.trim()).filter(Boolean);
          for (const p of parts) {
            const el = document.querySelector(p);
            if (el) return el as HTMLInputElement | HTMLElement;
          }
          return null;
        };
        const emailEl = queryFirst(emSel) as HTMLInputElement | null;
        const submitEl = queryFirst(subSel);
        const passwordEl = document.querySelector('input[type="password"], input[name="password"], input[autocomplete="current-password"]') as HTMLInputElement | null;
        if (!emailEl) return { done: false, hasPassword: false };
        emailEl.focus();
        emailEl.value = em;
        emailEl.dispatchEvent(new Event('input', { bubbles: true }));
        if (passwordEl) passwordEl.value = '';
        if (submitEl) {
          submitEl.click();
          return { done: true, hasPassword: !!passwordEl };
        }
        emailEl.form?.requestSubmit();
        return { done: true, hasPassword: !!passwordEl };
      },
      [emailSel, submitSel, email],
      (v) => v?.done === true
      );
      console.log(LOG_PREFIX, 'ensureLogin: firstStep', { attempt, done: firstStep?.done, hasPassword: firstStep?.hasPassword });
      if (firstStep?.done) break;
    }
    if (!firstStep?.done) {
      const diag = await getLoginPageDiagnostics(tab.id, emailSel, submitSel);
      const currentPath = (() => {
        try {
          return new URL(diag.url).pathname.replace(/\/?$/, '') || '/';
        } catch {
          return '/';
        }
      })();
      if (!isStillOnLoginPage(loginPath, currentPath)) {
        console.log(LOG_PREFIX, 'ensureLogin: form not found but redirected off login page (already logged in)', currentPath);
        if (thenNavigateTo && typeof thenNavigateTo === 'string') {
          console.log(LOG_PREFIX, 'ensureLogin: navigating to', thenNavigateTo.slice(0, 60));
          await browserAPI.tabs.update(tab.id, { url: thenNavigateTo });
          await waitForTabLoadAndInjectable(tab.id, timeout);
        } else {
          await new Promise((r) => setTimeout(r, 500));
        }
        return { ok: true };
      }
      const msg = `Could not find login form. Page: ${diag.url} readyState=${diag.readyState} emailFound=${diag.selector1Found} submitFound=${diag.selector2Found} (${diag.details}). Check extension console for [Harbor:capture] logs.`;
      console.warn(LOG_PREFIX, 'ensureLogin: form not found (tried main frame and all iframes)', diag);
      throw new Error(msg);
    }
    // Wait for navigation (page state) instead of fixed delay
    await Promise.race([
      waitForTabNavigateAway(tab.id, loginUrl, navWait),
      waitForTabLoadAndInjectable(tab.id, navWait),
    ]).catch(() => {});
    if (!firstStep.hasPassword) {
      await waitForTabLoadAndInjectable(tab.id, timeout);
      // Give SPA time to show password step (Atlantic often updates form in-place without navigation)
      await new Promise((r) => setTimeout(r, 2500));
      const runPasswordStep = () =>
        executeScriptInTabAllFrames<boolean>(
          tab.id,
          (pwSel: string, subSel: string, pw: string) => {
            const queryFirst = (selList: string) => {
              const parts = selList.split(',').map((p) => p.trim()).filter(Boolean);
              for (const p of parts) {
                const el = document.querySelector(p);
                if (el) return el as HTMLInputElement | HTMLElement;
              }
              return null;
            };
            const isEmailLike = (i: HTMLInputElement) =>
              i.type === 'email' ||
              /email/i.test(i.name || '') ||
              /email/i.test(i.id || '') ||
              /email/i.test((i.getAttribute && i.getAttribute('autocomplete')) || '');
            const queryAllInputs = (root: Document | ShadowRoot): HTMLInputElement[] => {
              const out = Array.from(root.querySelectorAll('input')) as HTMLInputElement[];
              root.querySelectorAll('*').forEach((el: Element) => {
                if (el.shadowRoot) out.push(...queryAllInputs(el.shadowRoot));
              });
              return out;
            };
            let passwordEl = queryFirst(pwSel) || document.querySelector('input[type="password"]') as HTMLInputElement | null;
            if (!passwordEl) {
              const allInputs = queryAllInputs(document);
              passwordEl = allInputs.find(
                (i) =>
                  (i.type === 'password' || /pass/i.test(i.name || '') || /pass/i.test(i.id || '') || i.getAttribute?.('autocomplete') === 'current-password') &&
                  !isEmailLike(i)
              ) || null;
            }
            if (!passwordEl) {
              const form = document.querySelector('form');
              if (form) {
                const inputs = form.querySelectorAll('input');
                const textLike = Array.from(inputs).filter(
                  (i) => {
                    if (i.type === 'submit' || i.type === 'button' || i.type === 'hidden') return false;
                    if (i.type === 'password' || i.type === 'text' || !i.type) return !isEmailLike(i as HTMLInputElement);
                    return false;
                  }
                );
                if (textLike.length === 1) passwordEl = textLike[0] as HTMLInputElement;
              }
            }
            const submitEl = queryFirst(subSel);
            if (!passwordEl) return false;
            passwordEl.focus();
            passwordEl.value = pw;
            passwordEl.dispatchEvent(new Event('input', { bubbles: true }));
            if (submitEl) {
              submitEl.click();
              return true;
            }
            passwordEl.form?.requestSubmit();
            return true;
          },
          [passwordSel, submitSel, password],
          (v) => v === true
        );
      let secondStep = await runPasswordStep();
      if (!secondStep) {
        await new Promise((r) => setTimeout(r, 2000));
        secondStep = await runPasswordStep();
      }
      if (!secondStep) {
        const diag = await getLoginPageDiagnostics(tab.id, passwordSel, submitSel);
        const msg = `Could not find password field. Page: ${diag.url} readyState=${diag.readyState} passwordFound=${diag.selector1Found} submitFound=${diag.selector2Found} (${diag.details}). Check extension console for [Harbor:capture] logs.`;
        console.warn(LOG_PREFIX, 'ensureLogin: password field not found', diag);
        throw new Error(msg);
      }
      // Wait for navigation after password submit (page state, not fixed delay)
      await Promise.race([
        waitForTabNavigateAway(tab.id, loginUrl, navWait),
        waitForTabLoadAndInjectable(tab.id, navWait),
      ]).catch(() => {});
    }
    // Optionally navigate to target URL (e.g. search page) so we're on the right page before closing
    if (thenNavigateTo && typeof thenNavigateTo === 'string') {
      console.log(LOG_PREFIX, 'ensureLogin: navigating to', thenNavigateTo.slice(0, 60));
      await browserAPI.tabs.update(tab.id, { url: thenNavigateTo });
      await waitForTabLoadAndInjectable(tab.id, timeout);
    } else {
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.log(LOG_PREFIX, 'ensureLogin: success');
    return { ok: true };
  } finally {
    await browserAPI.tabs.remove(tab.id).catch(() => {});
  }
}

/**
 * Open login page, fill email/password, submit, wait for navigation, then open target URL and capture.
 * Use when the MCP server has credentials and the site requires login for content.
 */
export async function runLoginThenCapture(params: Record<string, unknown>): Promise<CapturePageResult> {
  const loginUrl = params.loginUrl as string | undefined;
  const email = params.email as string | undefined;
  const password = params.password as string | undefined;
  const url = params.url as string | undefined;
  if (!loginUrl || typeof loginUrl !== 'string') throw new Error('Missing or invalid loginUrl parameter');
  if (!url || typeof url !== 'string') throw new Error('Missing or invalid url parameter');
  if (!email || !password) throw new Error('Missing email or password for login');

  const emailSel = (params.emailSelector as string) || DEFAULT_LOGIN.emailSelector;
  const passwordSel = (params.passwordSelector as string) || DEFAULT_LOGIN.passwordSelector;
  const submitSel = (params.submitSelector as string) || DEFAULT_LOGIN.submitSelector;
  const timeout = Math.min(Math.max(Number(params.timeout) || 20000, 5000), 60000);

  const tab = await browserAPI.tabs.create({ url: loginUrl, active: false });
  if (!tab?.id) throw new Error('Failed to create tab');

  try {
    await waitForTabLoad(tab.id, timeout);
    await waitForTabInjectableUrl(tab.id, timeout);

    const firstStep = await executeScriptInTab<{ done: boolean; hasPassword: boolean }>(
      tab.id,
      (emSel: string, subSel: string, em: string) => {
        const queryFirst = (selList: string) => {
          const parts = selList.split(',').map((p) => p.trim()).filter(Boolean);
          for (const p of parts) {
            const el = document.querySelector(p);
            if (el) return el as HTMLInputElement | HTMLElement;
          }
          return null;
        };
        const emailEl = queryFirst(emSel) as HTMLInputElement | null;
        const submitEl = queryFirst(subSel);
        const passwordEl = document.querySelector('input[type="password"], input[name="password"], input[autocomplete="current-password"]') as HTMLInputElement | null;
        if (!emailEl) return { done: false, hasPassword: false };
        emailEl.focus();
        emailEl.value = em;
        emailEl.dispatchEvent(new Event('input', { bubbles: true }));
        if (passwordEl) {
          passwordEl.value = '';
          passwordEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (submitEl) {
          submitEl.click();
          return { done: true, hasPassword: !!passwordEl };
        }
        emailEl.form?.requestSubmit();
        return { done: true, hasPassword: !!passwordEl };
      },
      [emailSel, submitSel, email]
    );

    if (!firstStep?.done) {
      throw new Error('Could not find login form (email field or submit)');
    }

    const navWait = Math.min(15000, Math.max(3000, timeout - 2000));
    await Promise.race([
      waitForTabNavigateAway(tab.id, loginUrl, navWait),
      waitForTabLoadAndInjectable(tab.id, navWait),
    ]).catch(() => {});

    if (!firstStep.hasPassword) {
      await waitForTabLoadAndInjectable(tab.id, timeout);
      await new Promise((r) => setTimeout(r, 2500));
      const runPasswordStep = () =>
        executeScriptInTabAllFrames<boolean>(
          tab.id,
          (pwSel: string, subSel: string, pw: string) => {
            const queryFirst = (selList: string) => {
              const parts = selList.split(',').map((p) => p.trim()).filter(Boolean);
              for (const p of parts) {
                const el = document.querySelector(p);
                if (el) return el as HTMLInputElement | HTMLElement;
              }
              return null;
            };
            const isEmailLike = (i: HTMLInputElement) =>
              i.type === 'email' || /email/i.test(i.name || '') || /email/i.test(i.id || '') || /email/i.test((i.getAttribute && i.getAttribute('autocomplete')) || '');
            const queryAllInputs = (root: Document | ShadowRoot): HTMLInputElement[] => {
              const out = Array.from(root.querySelectorAll('input')) as HTMLInputElement[];
              root.querySelectorAll('*').forEach((el: Element) => {
                if (el.shadowRoot) out.push(...queryAllInputs(el.shadowRoot));
              });
              return out;
            };
            let passwordEl = queryFirst(pwSel) || document.querySelector('input[type="password"]') as HTMLInputElement | null;
            if (!passwordEl) {
              const allInputs = queryAllInputs(document);
              passwordEl = allInputs.find(
                (i) =>
                  (i.type === 'password' || /pass/i.test(i.name || '') || /pass/i.test(i.id || '') || i.getAttribute?.('autocomplete') === 'current-password') &&
                  !isEmailLike(i)
              ) || null;
            }
            if (!passwordEl) {
              const form = document.querySelector('form');
              if (form) {
                const inputs = form.querySelectorAll('input');
                const textLike = Array.from(inputs).filter(
                  (i) => {
                    if (i.type === 'submit' || i.type === 'button' || i.type === 'hidden') return false;
                    if (i.type === 'password' || i.type === 'text' || !i.type) return !isEmailLike(i as HTMLInputElement);
                    return false;
                  }
                );
                if (textLike.length === 1) passwordEl = textLike[0] as HTMLInputElement;
              }
            }
            const submitEl = queryFirst(subSel);
            if (!passwordEl) return false;
            passwordEl.focus();
            passwordEl.value = pw;
            passwordEl.dispatchEvent(new Event('input', { bubbles: true }));
            if (submitEl) { submitEl.click(); return true; }
            passwordEl.form?.requestSubmit();
            return true;
          },
          [passwordSel, submitSel, password],
          (v) => v === true
        );
      let secondStep = await runPasswordStep();
      if (!secondStep) {
        await new Promise((r) => setTimeout(r, 2000));
        secondStep = await runPasswordStep();
      }
      if (!secondStep) throw new Error('Could not find password field on second step');
      await Promise.race([
        waitForTabNavigateAway(tab.id, loginUrl, navWait),
        waitForTabLoadAndInjectable(tab.id, navWait),
      ]).catch(() => {});
    } else {
      await waitForTabLoad(tab.id, timeout).catch(() => {});
    }

    if (url !== loginUrl) {
      await browserAPI.tabs.update(tab.id, { url });
      await waitForTabLoadAndInjectable(tab.id, timeout);
    }

    const result = await executeScriptInTab<{
      title: string;
      url: string;
      content: string;
      text: string;
      cookies?: string;
      links?: string[];
      linksWithText?: LinkWithText[];
    }>(
      tab.id,
      () => {
        const title = document.title;
        const url = window.location.href;
        const mainSelectors = ['main', 'article', '[role="main"]', '.content', '#content', '.post', '.article'];
        let root: Element | null = null;
        for (const selector of mainSelectors) {
          const el = document.querySelector(selector);
          if (el) {
            root = el;
            break;
          }
        }
        if (!root) root = document.body;
        const raw = (root as HTMLElement).innerText?.trim() || (root as HTMLElement).textContent?.trim() || '';
        const lines = raw.split(/\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
        const content = lines.join('\n').slice(0, 50000);
        const links: string[] = [];
        const linksWithText: { text: string; url: string }[] = [];
        const base = window.location.origin;
        document.body.querySelectorAll('a[href]').forEach((a) => {
          const el = a as HTMLAnchorElement;
          const href = el.getAttribute('href') ?? el.href;
          if (!href || typeof href !== 'string' || href.startsWith('javascript:') || href.startsWith('#')) return;
          const absolute = href.startsWith('http') ? href : (href.startsWith('/') ? base + href : base + '/' + href);
          if (!absolute.startsWith('http')) return;
          if (!links.includes(absolute)) links.push(absolute);
          const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 500);
          if (text) linksWithText.push({ text, url: absolute });
        });
        return { title, url, content, text: content, links, linksWithText };
      },
      []
    );

    if (!result) throw new Error('Failed to extract page content after login');
    return {
      content: result.content,
      title: result.title,
      url: result.url,
      ...(result.cookies !== undefined && { cookies: result.cookies }),
      links: result.links ?? [],
      linksWithText: result.linksWithText ?? [],
    };
  } finally {
    await browserAPI.tabs.remove(tab.id).catch(() => {});
  }
}

/** True if URL looks like an Atlantic article (not search/login/section index). Used to scroll-to-end before capture. */
function isAtlanticArticlePageUrl(u: string): boolean {
  if (!u || !u.includes('theatlantic.com') || u.includes('theatlantic.com/search')) return false;
  try {
    const path = new URL(u).pathname.replace(/\/$/, '') || '/';
    if (/^\/(search|most-popular|latest|newsletters|login)(\/|$|\?)/i.test(path)) return false;
    const segs = path.split('/').filter(Boolean);
    return /\d{4}\/\d{1,2}\//.test(path) || segs.length >= 3;
  } catch {
    return false;
  }
}

/** Larger step and shorter pause so we finish within typical MCP/bridge timeout (~30s). */
const SCROLL_STEP_PX = 600;
const SCROLL_PAUSE_MS = 250;
const SCROLL_MAX_STEPS = 50;

/**
 * Harbor-controlled scroll: move the tab's page down by a step and return scroll metrics.
 * Extension runs this in a loop to scroll to the end of the page (no scroll logic in the capture script).
 */
async function scrollTabDownStep(
  tabId: number,
  stepPx: number
): Promise<{ scrollY: number; scrollHeight: number; innerHeight: number } | undefined> {
  return executeScriptInTab<{ scrollY: number; scrollHeight: number; innerHeight: number }>(
    tabId,
    (step: number) => {
      window.scrollBy(0, step);
      return {
        scrollY: window.scrollY,
        scrollHeight: document.documentElement.scrollHeight,
        innerHeight: window.innerHeight,
      };
    },
    [stepPx]
  );
}

/**
 * Scroll the tab to the bottom of the page (Harbor-controlled loop with pauses so lazy-loaded content loads).
 * Only the extension does the scroll; the capture script later just reads the DOM.
 */
async function scrollTabToEnd(tabId: number): Promise<void> {
  for (let i = 0; i < SCROLL_MAX_STEPS; i++) {
    const info = await scrollTabDownStep(tabId, SCROLL_STEP_PX);
    if (!info) break;
    if (info.scrollY + info.innerHeight >= info.scrollHeight - 80) break;
    await new Promise((r) => setTimeout(r, SCROLL_PAUSE_MS));
  }
}

export async function runCapturePage(params: Record<string, unknown>): Promise<CapturePageResult> {
  const url = params.url as string | undefined;
  if (!url || typeof url !== 'string') {
    throw new Error('Missing or invalid url parameter');
  }

  const waitForLoad = (params.waitForLoad as boolean) !== false;
  const timeout = Math.min(Math.max(Number(params.timeout) || 15000, 1000), 60000);
  const captureCookies = (params.captureCookies as boolean) === true;
  const delayBeforeCapture = Math.min(Math.max(Number(params.delayBeforeCapture) || 0, 0), 10000);

  const tab = await browserAPI.tabs.create({ url, active: false });
  if (!tab?.id) {
    throw new Error('Failed to create tab');
  }

  try {
    if (waitForLoad) {
      await waitForTabLoad(tab.id, timeout);
    }
    await waitForTabInjectableUrl(tab.id, timeout);
    if (delayBeforeCapture > 0) {
      await new Promise((r) => setTimeout(r, delayBeforeCapture));
    }

    if (isAtlanticArticlePageUrl(url)) {
      await scrollTabToEnd(tab.id);
    }

    const result = await executeScriptInTab<{
      title: string;
      url: string;
      content: string;
      text: string;
      cookies?: string;
      links?: string[];
      linksWithText?: LinkWithText[];
      searchResults?: SearchResultItem[];
      articleDetail?: ArticleDetail;
    }>(
      tab.id,
      (doCaptureCookies: boolean) => {
        const title = document.title;
        const url = window.location.href;
        const mainSelectors = ['main', 'article', '[role="main"]', '.content', '#content', '.post', '.article'];
        let root: Element | null = null;
        for (const selector of mainSelectors) {
          const el = document.querySelector(selector);
          if (el) {
            root = el;
            break;
          }
        }
        if (!root) root = document.body;
        const raw = (root as HTMLElement).innerText?.trim() || (root as HTMLElement).textContent?.trim() || '';
        const lines = raw.split(/\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
        const content = lines.join('\n').slice(0, 50000);
        const cookies = doCaptureCookies ? document.cookie : undefined;
        const links: string[] = [];
        const linksWithText: { text: string; url: string }[] = [];
        const base = window.location.origin;
        document.body.querySelectorAll('a[href]').forEach((a) => {
          const el = a as HTMLAnchorElement;
          const href = el.getAttribute('href') ?? el.href;
          if (!href || typeof href !== 'string' || href.startsWith('javascript:') || href.startsWith('#')) return;
          const absolute = href.startsWith('http') ? href : (href.startsWith('/') ? base + href : base + '/' + href);
          if (!absolute.startsWith('http')) return;
          if (!links.includes(absolute)) links.push(absolute);
          const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 500);
          if (text) linksWithText.push({ text, url: absolute });
        });

        const isAtlanticArticlePage = (u: string) => {
          if (!u || !u.includes('theatlantic.com') || u.includes('theatlantic.com/search')) return false;
          try {
            const path = new URL(u).pathname.replace(/\/$/, '') || '/';
            if (/^\/(search|most-popular|latest|newsletters|login)(\/|$|\?)/i.test(path)) return false;
            const segs = path.split('/').filter(Boolean);
            if (/\d{4}\/\d{1,2}\//.test(path) || segs.length >= 3) return true;
            return false;
          } catch { return false; }
        };

        let searchResults: SearchResultItem[] | undefined;
        if (url.includes('theatlantic.com/search')) {
          const monthNames = /(?:January|February|March|April|May|June|July|August|September|October|November|December)/i;
          const dateRe = new RegExp(monthNames.source + '\\s+\\d{1,2},?\\s+\\d{4}|' + monthNames.source + '\\s+\\d+\\s+Issue', 'i');
          const navPathRe = /^\/(search|most-popular|latest|newsletters|politics|ideas|technology|science|economy|archive|category|projects|events|family|national-security|progress|games|audio|health|education|international|books|fiction|in-brief)(\/|$|\?)/i;
          const seen = new Set<string>();
          const out: SearchResultItem[] = [];
          root.querySelectorAll('a[href]').forEach((anchor) => {
            const a = anchor as HTMLAnchorElement;
            const href = a.getAttribute('href') ?? a.href;
            if (!href || href.startsWith('javascript:') || href.startsWith('#')) return;
            const absolute = href.startsWith('http') ? href : (href.startsWith('/') ? base + href : base + '/' + href);
            if (!absolute.includes('theatlantic.com/')) return;
            try {
              const path = new URL(absolute).pathname.replace(/\/$/, '') || '/';
              if (navPathRe.test(path)) return;
              const segs = path.split('/').filter(Boolean);
              if (segs.length < 2) return;
            } catch {
              return;
            }
            const titleText = (a.innerText || a.textContent || '').trim().replace(/\s+/g, ' ');
            if (!titleText || titleText.length < 15 || seen.has(absolute)) return;
            if (/^(Read more|Subscribe|Sign in|View article|See more)$/i.test(titleText)) return;
            seen.add(absolute);
            let card: Element | null = a.closest('article') || a.closest('li') || a.parentElement;
            for (let i = 0; i < 8 && card; i++) {
              if (card === root || card === document.body) break;
              const cardText = (card as HTMLElement).innerText || (card as HTMLElement).textContent || '';
              if (cardText.length > 80) break;
              card = card.parentElement;
            }
            if (!card) card = a.parentElement;
            const cardText = (card as HTMLElement)?.innerText?.trim() || (card as HTMLElement)?.textContent?.trim() || '';
            const cardLines = cardText.split(/\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
            let date = '';
            let author = '';
            for (const line of cardLines) {
              const m = line.match(dateRe);
              if (m) {
                date = m[0];
                const before = line.slice(0, m.index).trim();
                if (before.length > 2 && before.length < 60) author = before;
                break;
              }
            }
            const snippetLine = cardLines.find((l) => l.length > 20 && l !== titleText && !dateRe.test(l));
            out.push({
              title: titleText.slice(0, 300),
              url: absolute,
              author: author || undefined,
              date: date || undefined,
              snippet: snippetLine ? snippetLine.slice(0, 250) : undefined,
            });
          });
          searchResults = out.slice(0, 50);
        }

        let articleDetail: ArticleDetail | undefined;
        if (isAtlanticArticlePage(url)) {
          const monthNames = /(?:January|February|March|April|May|June|July|August|September|October|November|December)/i;
          const dateRe = new RegExp(monthNames.source + '\\s+\\d{1,2},?\\s+\\d{4}|' + monthNames.source + '\\s+\\d+\\s+Issue', 'i');
          let author = '';
          let date = '';
          const bylineEl = root.querySelector('[class*="byline"], [class*="Byline"], [class*="author"], [data-testid*="byline"], .ArticleByline, .byline');
          if (bylineEl) {
            const bylineText = (bylineEl as HTMLElement).innerText?.trim() || (bylineEl as HTMLElement).textContent?.trim() || '';
            const byMatch = bylineText.match(/^\s*By\s+(.+?)(?:\s+[\u2022\u00b7]\s+|\s*$)/i) || bylineText.match(/^\s*(.+?)(?:\s+[\u2022\u00b7]\s+|\s*$)/);
            if (byMatch && byMatch[1].length > 2 && byMatch[1].length < 80) author = byMatch[1].trim();
            const d = bylineText.match(dateRe);
            if (d) date = d[0];
          }
          if (!date || !author) {
            for (const line of lines.slice(0, 15)) {
              const d = line.match(dateRe);
              if (d) {
                if (!date) date = d[0];
                const before = line.slice(0, d.index).trim();
                if (before.length > 2 && before.length < 60 && /^By\s+/i.test(before)) author = author || before.replace(/^By\s+/i, '').trim();
                else if (before.length > 2 && before.length < 60 && !author) author = before;
              }
            }
          }
          const imageUrls: string[] = [];
          const seen = new Set<string>();
          const toAbsolute = (s: string) => (!s || s.startsWith('data:')) ? '' : (s.startsWith('http') ? s : (s.startsWith('/') ? base + s : base + '/' + s));
          const addUrl = (u: string) => {
            const abs = toAbsolute(u.trim());
            if (abs && abs.startsWith('http') && !seen.has(abs)) {
              seen.add(abs);
              imageUrls.push(abs);
            }
          };
          const parseSrcset = (srcset: string) => {
            if (!srcset) return;
            srcset.split(',').forEach((part) => {
              const u = part.trim().split(/\s+/)[0];
              if (u) addUrl(u);
            });
          };
          const collectFromImg = (img: Element) => {
            const el = img as HTMLImageElement;
            const src =
              el.getAttribute('src') ||
              el.getAttribute('data-src') ||
              el.getAttribute('data-lazy-src') ||
              el.getAttribute('data-original') ||
              el.src;
            if (src) addUrl(src);
            parseSrcset(el.getAttribute('srcset') || '');
            parseSrcset(el.getAttribute('data-srcset') || '');
          };
          const walkForImgs = (parent: Element | Document | ShadowRoot) => {
            const nodes = parent instanceof Document ? [parent.body] : parent instanceof ShadowRoot ? [parent] : [parent];
            nodes.forEach((container) => {
              if (!container) return;
              (container as Element).querySelectorAll?.('img')?.forEach(collectFromImg);
              (container as Element).querySelectorAll?.('*')?.forEach((el) => {
                if ((el as HTMLElement).shadowRoot) walkForImgs((el as HTMLElement).shadowRoot!);
              });
            });
          };
          walkForImgs(root);
          articleDetail = {
            text: content.slice(0, 300000),
            ...(author && { author }),
            ...(date && { date }),
            ...(imageUrls.length > 0 && { imageUrls }),
          };
        }

        return { title, url, content, text: content, cookies, links, linksWithText, searchResults, articleDetail };
      },
      [captureCookies]
    );

    if (!result) {
      throw new Error('Failed to extract page content');
    }

    return {
      content: result.content,
      title: result.title,
      url: result.url,
      ...(result.cookies !== undefined && { cookies: result.cookies }),
      links: result.links ?? [],
      linksWithText: result.linksWithText ?? [],
      ...(result.searchResults && result.searchResults.length > 0 && { searchResults: result.searchResults }),
      ...(result.articleDetail && { articleDetail: result.articleDetail }),
    };
  } finally {
    await browserAPI.tabs.remove(tab.id).catch(() => {});
  }
}

export async function runGetCookies(params: Record<string, unknown>): Promise<GetCookiesResult> {
  const domain = params.domain as string | undefined;
  const openUrl = params.openUrl as string | undefined;

  if (!domain || typeof domain !== 'string') {
    throw new Error('Missing or invalid domain parameter');
  }

  let tabId: number | undefined;

  if (openUrl) {
    const tab = await browserAPI.tabs.create({ url: openUrl, active: false });
    if (!tab?.id) {
      throw new Error('Failed to create tab');
    }
    await waitForTabLoad(tab.id, 10000);
    await waitForTabInjectableUrl(tab.id, 10000);
    tabId = tab.id;
  } else {
    const tabs = await browserAPI.tabs.query({});
    const found = tabs.find(
      (t) => t.url && (t.url.includes(domain) || new URL(t.url).hostname === domain.replace(/^\./, ''))
    );
    tabId = found?.id;
    if (!tabId) {
      throw new Error(`No open tab found for domain ${domain}. Provide openUrl to open one.`);
    }
  }

  const result = await executeScriptInTab<{ cookies: string }>(
    tabId,
    () => ({ cookies: document.cookie }),
    []
  );

  if (!result) {
    throw new Error('Failed to read cookies');
  }

  if (openUrl && tabId) {
    await browserAPI.tabs.remove(tabId).catch(() => {});
  }

  return { cookies: result.cookies };
}

/** URL schemes we have host_permission for (manifest: localhost and https). */
function isInjectableUrl(url: string | undefined): boolean {
  if (!url) return false;
  return url.startsWith('https://') || url.startsWith('http://localhost');
}

/**
 * Wait until the tab has navigated away from the given URL (or to a different path).
 * Uses polling so we react to actual page state instead of fixed timeouts.
 */
async function waitForTabNavigateAway(
  tabId: number,
  fromUrl: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const fromNorm = fromUrl.split('?')[0];
  while (Date.now() < deadline) {
    const tab = await browserAPI.tabs.get(tabId);
    const current = tab.url ?? '';
    if (!current || current.split('?')[0] !== fromNorm) return;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * Wait for tab load complete then for URL to be injectable.
 * Prefer this over fixed delays after form submit.
 */
async function waitForTabLoadAndInjectable(tabId: number, timeoutMs: number): Promise<void> {
  await waitForTabLoad(tabId, timeoutMs);
  await waitForTabInjectableUrl(tabId, timeoutMs);
}

/**
 * Wait until the tab has navigated to a URL we're allowed to script.
 * Avoids "Missing host permission for the tab" when the tab is still on about:blank.
 */
async function waitForTabInjectableUrl(tabId: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await browserAPI.tabs.get(tabId);
    if (isInjectableUrl(tab.url)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  const tab = await browserAPI.tabs.get(tabId);
  throw new Error(
    `Tab did not navigate to an allowed URL before timeout (current: ${tab.url ?? 'unknown'}). Host permission is required for the tab.`
  );
}

function waitForTabLoad(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      browserAPI.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab load timeout'));
    }, timeoutMs);

    const listener = (updatedTabId: number, changeInfo: { status?: string }) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        browserAPI.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };

    browserAPI.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') {
        clearTimeout(timer);
        browserAPI.tabs.onUpdated.removeListener(listener);
        resolve();
        return;
      }
      browserAPI.tabs.onUpdated.addListener(listener);
    }).catch(reject);
  });
}
