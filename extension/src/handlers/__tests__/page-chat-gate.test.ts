/**
 * Messages typed into the chat a page opens with agent.chat.open are the
 * page's prompts: the page chose the system prompt and tools, and page
 * script can reach the overlay's input. Each one goes through the policy
 * engine under the page's origin, is audited, and runs only in the tab and
 * origin that opened the chat.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetMockBrowser } from '../../__tests__/test-setup';
import type { TypedAction } from '../../policy/actions';
import type { AuditRecord } from '../../policy/audit';

const bridgeChat = vi.fn(async () => ({ content: 'reply from the model' }));
vi.mock('../../llm/chat', () => ({ bridgeChat: (...args: unknown[]) => bridgeChat(...(args as [])) }));

let defaultModel: string | null = 'openai:gpt-test';
vi.mock('../../llm/bridge-client', () => ({
  bridgeRequest: vi.fn(async (method: string) => {
    if (method === 'llm.get_config') return { default_model: defaultModel };
    throw new Error(`unexpected bridge call ${method}`);
  }),
}));

const showPermissionPrompt = vi.fn(async () => ({ granted: false, explicitDeny: true }));
vi.mock('../../policy/permissions', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  showPermissionPrompt: (...args: unknown[]) => showPermissionPrompt(...(args as [])),
}));

type Listener = (message: unknown, sender: unknown, sendResponse: (r: unknown) => void) => unknown;

const SHOP = 'https://shop.example';
const TAB = 7;

let grant: (origin: string, action: TypedAction) => 'allow' | 'deny' | null;

async function setup() {
  const listeners: Listener[] = [];
  vi.spyOn(chrome.runtime.onMessage, 'addListener').mockImplementation((l) => {
    listeners.push(l as Listener);
  });
  (chrome as unknown as { scripting: unknown }).scripting = { executeScript: vi.fn(async () => []) };

  // Fresh modules per test, so the engine, audit log and open chats are
  // the ones the handlers below use.
  vi.resetModules();
  const { Audit } = await import('../../policy/audit');
  const { Policy } = await import('../../policy/store');
  const { setOriginGrantResolver, setWatchdogResolver } = await import('../../policy/engine');
  Policy.__reset();
  Audit.__reset();
  setOriginGrantResolver((origin, action) => {
    const effect = grant(origin, action);
    return effect ? { effect } : null;
  });
  setWatchdogResolver(() => ({ status: 'normal' }));
  promptRecords = () => Audit.list().filter((r) => r.action.startsWith('model.prompt'));

  const { registerPageChatHandlers } = await import('../page-chat-handlers');
  const { handleChatOpen } = await import('../../agents/handlers/chat');
  registerPageChatHandlers();

  async function openChat(origin = SHOP, tabId = TAB): Promise<string> {
    let result: { ok: boolean; result?: { chatId: string } } | undefined;
    await handleChatOpen(
      { id: 'open-1', type: 'agent.chat.open', origin, tabId, payload: { systemPrompt: 'Shop helper' } } as never,
      { sendResponse: (r: unknown) => { result = r as typeof result; }, sendStreamEvent: () => {} },
    );
    if (!result?.ok || !result.result) throw new Error(`chat.open failed: ${JSON.stringify(result)}`);
    return result.result.chatId;
  }

  function send(chatId: string, sender: unknown): Promise<{ ok: boolean; type: string; response?: string; error?: { message: string; code?: string } }> {
    return new Promise((resolve) => {
      let handled = false;
      for (const l of listeners) {
        if (l({ type: 'page_chat_message', chatId, message: 'What is on sale?', systemPrompt: 'Shop helper' }, sender, resolve as never) === true) {
          handled = true;
        }
      }
      if (!handled) throw new Error('page_chat_message was not handled');
    });
  }

  return { openChat, send };
}

let promptRecords: () => readonly AuditRecord[] = () => [];

beforeEach(() => {
  vi.restoreAllMocks();
  resetMockBrowser();
  bridgeChat.mockClear();
  showPermissionPrompt.mockClear();
  defaultModel = 'openai:gpt-test';
  grant = () => 'allow';
});

describe('page chat messages are checked as the page\'s prompts', () => {
  it('checks and audits the message under the page origin before calling the model', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    const { openChat, send } = await setup();
    const chatId = await openChat();

    const response = await send(chatId, { tab: { id: TAB }, url: `${SHOP}/deals`, frameId: 0 });

    // Neither the message nor the reply is logged.
    expect(lines.filter((l) => l.includes('What is on sale?') || l.includes('reply from the model'))).toEqual([]);

    expect(response).toMatchObject({ ok: true, type: 'page_chat_response', response: 'reply from the model' });
    expect(bridgeChat).toHaveBeenCalledTimes(1);
    const records = promptRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ origin: SHOP, action: 'model.prompt.remote.firstParty', effect: 'allow' });
  });

  it('classifies the bridge\'s local default model as a local prompt', async () => {
    defaultModel = 'ollama:llama3';
    const { openChat, send } = await setup();
    const chatId = await openChat();

    await send(chatId, { tab: { id: TAB }, url: `${SHOP}/`, frameId: 0 });

    expect(promptRecords()[0]).toMatchObject({ origin: SHOP, action: 'model.prompt.local' });
  });

  it('refuses the message, and never calls the model, when the origin is denied prompts', async () => {
    grant = (_origin, action) => (action.startsWith('model.prompt') ? 'deny' : 'allow');
    const { openChat, send } = await setup();
    const chatId = await openChat();

    const response = await send(chatId, { tab: { id: TAB }, url: `${SHOP}/`, frameId: 0 });

    expect(response).toMatchObject({ ok: false, type: 'error' });
    expect(response.error?.message).toBeTruthy();
    expect(bridgeChat).not.toHaveBeenCalled();
    expect(promptRecords()[0]).toMatchObject({ origin: SHOP, effect: 'deny' });
  });

  it('asks the person when the origin has no prompt grant, and refuses if they decline', async () => {
    grant = (_origin, action) => (action.startsWith('model.prompt') ? null : 'allow');
    const { openChat, send } = await setup();
    const chatId = await openChat();

    const response = await send(chatId, { tab: { id: TAB }, url: `${SHOP}/`, frameId: 0 });

    expect(showPermissionPrompt).toHaveBeenCalledWith(SHOP, ['model:prompt'], expect.anything(), undefined);
    expect(response).toMatchObject({ ok: false, type: 'error' });
    expect(bridgeChat).not.toHaveBeenCalled();
  });

  it('refuses a message for a chat that was never opened', async () => {
    const { send } = await setup();

    const response = await send('chat-made-up', { tab: { id: TAB }, url: `${SHOP}/`, frameId: 0 });

    expect(response).toMatchObject({ ok: false, type: 'error' });
    expect(bridgeChat).not.toHaveBeenCalled();
  });

  it('refuses a message from a different tab than the one that opened the chat', async () => {
    const { openChat, send } = await setup();
    const chatId = await openChat();

    const response = await send(chatId, { tab: { id: TAB + 1 }, url: `${SHOP}/`, frameId: 0 });

    expect(response).toMatchObject({ ok: false, type: 'error' });
    expect(bridgeChat).not.toHaveBeenCalled();
  });

  it('refuses a message once the tab has moved to another origin', async () => {
    const { openChat, send } = await setup();
    const chatId = await openChat();

    const response = await send(chatId, { tab: { id: TAB }, url: 'https://elsewhere.example/', frameId: 0 });

    expect(response).toMatchObject({ ok: false, type: 'error' });
    expect(bridgeChat).not.toHaveBeenCalled();
  });

  it('refuses a message that arrives without a tab', async () => {
    const { openChat, send } = await setup();
    const chatId = await openChat();

    const response = await send(chatId, {});

    expect(response).toMatchObject({ ok: false, type: 'error' });
    expect(bridgeChat).not.toHaveBeenCalled();
    expect(promptRecords()).toHaveLength(0);
  });
});
