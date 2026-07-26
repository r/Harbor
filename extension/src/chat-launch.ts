import type { SourceTabLaunchEnvelope } from './chat/contracts';

const CHAT_LAUNCH_STORAGE_PREFIX = 'harbor-chat-launch:';
const CHAT_LAUNCH_TTL_MS = 10 * 60 * 1000;

export type ChatLaunchTab = {
  id?: number;
  windowId?: number;
  url?: string;
  title?: string;
};

export type ChatLaunchStorage = {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
};

export type ChatLaunchBrowser = {
  getChatUrl(): string;
  queryActiveTab(): Promise<ChatLaunchTab | undefined>;
  openTab(url: string): Promise<void>;
  storage?: ChatLaunchStorage;
};

export async function launchHarborChat(
  browser: ChatLaunchBrowser,
  options: {
    createId?: () => string;
    now?: () => number;
  } = {},
): Promise<void> {
  const chatUrl = new URL(browser.getChatUrl());
  const sourceTab = await browser.queryActiveTab();
  const envelope = sourceTab
    ? createSourceTabLaunchEnvelope(
      sourceTab,
      options.createId ?? (() => crypto.randomUUID()),
      options.now ?? Date.now,
    )
    : null;

  if (envelope && browser.storage) {
    await browser.storage.set({
      [chatLaunchStorageKey(envelope.launchId)]: envelope,
    });
    chatUrl.searchParams.set('launch', envelope.launchId);
  }

  await browser.openTab(chatUrl.toString());
}

export function createSourceTabLaunchEnvelope(
  tab: ChatLaunchTab,
  createId: () => string,
  now: () => number,
): SourceTabLaunchEnvelope | null {
  if (
    tab.id === undefined
    || tab.windowId === undefined
    || !tab.url
    || !isSupportedSourceUrl(tab.url)
  ) {
    return null;
  }

  const createdAt = now();
  const url = new URL(tab.url);
  return {
    version: 1,
    launchId: createId(),
    source: {
      tabId: tab.id,
      windowId: tab.windowId,
      url: url.toString(),
      title: tab.title?.trim() || url.hostname,
      origin: url.origin,
    },
    createdAt,
    expiresAt: createdAt + CHAT_LAUNCH_TTL_MS,
  };
}

export async function consumeSourceTabLaunchEnvelope(
  storage: ChatLaunchStorage,
  launchId: string,
  now: () => number = Date.now,
): Promise<SourceTabLaunchEnvelope | null> {
  const storageKey = chatLaunchStorageKey(launchId);
  const stored = await storage.get(storageKey);
  await storage.remove(storageKey);
  const envelope = stored[storageKey];

  if (!isSourceTabLaunchEnvelope(envelope) || envelope.expiresAt <= now()) {
    return null;
  }
  return envelope;
}

export function chatLaunchStorageKey(launchId: string): string {
  return `${CHAT_LAUNCH_STORAGE_PREFIX}${launchId}`;
}

function isSupportedSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isSourceTabLaunchEnvelope(
  value: unknown,
): value is SourceTabLaunchEnvelope {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<SourceTabLaunchEnvelope>;
  return candidate.version === 1
    && typeof candidate.launchId === 'string'
    && typeof candidate.createdAt === 'number'
    && typeof candidate.expiresAt === 'number'
    && isSourceTabReference(candidate.source);
}

function isSourceTabReference(
  value: unknown,
): value is SourceTabLaunchEnvelope['source'] {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<SourceTabLaunchEnvelope['source']>;
  return typeof candidate.tabId === 'number'
    && typeof candidate.windowId === 'number'
    && typeof candidate.url === 'string'
    && isSupportedSourceUrl(candidate.url)
    && typeof candidate.title === 'string'
    && typeof candidate.origin === 'string';
}
