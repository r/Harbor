/**
 * The sender check every acp_ and agent_backend_ handler uses. The mock
 * `chrome.runtime` in test-setup.ts has `id: 'harbor-test'` and
 * `getURL(path) => chrome-extension://harbor-test/${path}`.
 */
import { describe, expect, it } from 'vitest';
import { isExtensionPageSender, registerExtensionPageHandler } from '../extension-page-sender';

type Listener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => boolean | void;

function captureListener(): { listeners: Listener[] } {
  const listeners: Listener[] = [];
  const chromeGlobal = (globalThis as unknown as { chrome: { runtime: { onMessage: { addListener: (l: Listener) => void } } } }).chrome;
  chromeGlobal.runtime.onMessage.addListener = (l: Listener) => { listeners.push(l); };
  return { listeners };
}

async function dispatch(listeners: Listener[], message: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
  return new Promise((resolve) => {
    let resolved = false;
    const sendResponse = (response: unknown): void => {
      if (resolved) return;
      resolved = true;
      resolve(response);
    };
    for (const l of listeners) l(message, sender, sendResponse);
  });
}

describe('isExtensionPageSender', () => {
  it('accepts Harbor\'s own extension page', () => {
    expect(isExtensionPageSender({ id: 'harbor-test', url: 'chrome-extension://harbor-test/sidebar.html' })).toBe(true);
  });

  it('rejects a content script reporting the site\'s URL, even though its sender.id is Harbor\'s own', () => {
    // A content script's sender.id is Harbor's own extension id (Harbor
    // injected it) — only the URL tells it apart from a real extension page.
    expect(isExtensionPageSender({ id: 'harbor-test', url: 'https://example.com/' })).toBe(false);
  });

  it('rejects another extension entirely', () => {
    expect(isExtensionPageSender({ id: 'some-other-extension', url: 'chrome-extension://some-other-extension/page.html' })).toBe(false);
  });

  it('rejects a sender with no url at all', () => {
    expect(isExtensionPageSender({ id: 'harbor-test' })).toBe(false);
  });

  it('rejects a missing sender', () => {
    expect(isExtensionPageSender(null)).toBe(false);
    expect(isExtensionPageSender(undefined)).toBe(false);
  });
});

describe('registerExtensionPageHandler', () => {
  it('runs the handler for a real extension-page sender', async () => {
    const { listeners } = captureListener();
    registerExtensionPageHandler('test_type', async () => ({ ok: true, ran: true }));

    const response = await dispatch(listeners, { type: 'test_type' }, {
      id: 'harbor-test', url: 'chrome-extension://harbor-test/sidebar.html',
    } as chrome.runtime.MessageSender);

    expect(response).toEqual({ ok: true, ran: true });
  });

  it('refuses a content-script sender with a tab and an https URL, without running the handler', async () => {
    const { listeners } = captureListener();
    let ran = false;
    registerExtensionPageHandler('test_type', async () => { ran = true; return { ok: true }; });

    const response = await dispatch(listeners, { type: 'test_type' }, {
      id: 'harbor-test', url: 'https://example.com/page', tab: { id: 7 },
    } as chrome.runtime.MessageSender);

    expect(response).toEqual({ ok: false, error: 'Not available to this sender' });
    expect(ran).toBe(false);
  });

  it('refuses another extension', async () => {
    const { listeners } = captureListener();
    let ran = false;
    registerExtensionPageHandler('test_type', async () => { ran = true; return { ok: true }; });

    const response = await dispatch(listeners, { type: 'test_type' }, {
      id: 'some-other-extension', url: 'chrome-extension://some-other-extension/page.html',
    } as chrome.runtime.MessageSender);

    expect(response).toEqual({ ok: false, error: 'Not available to this sender' });
    expect(ran).toBe(false);
  });
});
