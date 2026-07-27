import type { SourceTabReference } from '../contracts';

export type ChatTransportTab = {
  id?: number;
  windowId?: number;
  url?: string;
};

export type ChatTransportIdentity = {
  origin: string;
  tabId?: number;
};

export function isTrustedChatPage(
  senderUrl: string | undefined,
  chatPageUrl: string,
): boolean {
  if (!senderUrl) {
    return false;
  }

  try {
    const sender = new URL(senderUrl);
    const chatPage = new URL(chatPageUrl);
    return sender.protocol === chatPage.protocol
      && sender.host === chatPage.host
      && sender.pathname === chatPage.pathname;
  } catch {
    return false;
  }
}

export async function resolveChatTransportIdentity(
  source: SourceTabReference | undefined,
  chatPageUrl: string,
  chatTabId: number | undefined,
  getTab: (tabId: number) => Promise<ChatTransportTab>,
): Promise<ChatTransportIdentity> {
  if (!source) {
    return {
      origin: getSecurityOrigin(new URL(chatPageUrl)),
      tabId: chatTabId,
    };
  }

  const currentTab = await getTab(source.tabId);
  if (
    currentTab.id !== source.tabId
    || currentTab.windowId !== source.windowId
    || currentTab.url !== source.url
    || new URL(currentTab.url).origin !== source.origin
  ) {
    throw createStaleSourceError();
  }

  return {
    origin: source.origin,
    tabId: source.tabId,
  };
}

function getSecurityOrigin(url: URL): string {
  return url.origin === 'null'
    ? `${url.protocol}//${url.host}`
    : url.origin;
}

function createStaleSourceError(): Error {
  return Object.assign(
    new Error('The source page has closed or navigated'),
    { code: 'ERR_SOURCE_TAB_STALE' },
  );
}
