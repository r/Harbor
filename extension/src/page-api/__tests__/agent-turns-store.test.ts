import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMockStorage, resetMockBrowser } from '../../__tests__/test-setup';

// The store behind Harbor's record of turns on the person's own agent
// (agent-turns.ts): the toolbar badge, the size bound, what survives the
// background page stopping, and who may read or clear it. How each page API
// feeds it is covered in agent-turn-record.test.ts.

type Listener = (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void) => boolean | void;
const listeners: Listener[] = [];
const setBadgeText = vi.fn(async (_d: { text: string }) => {});

let turns: typeof import('../agent-turns');

beforeAll(async () => {
  const chrome = (globalThis as unknown as { chrome: Record<string, unknown> & { runtime: { onMessage: { addListener: (l: Listener) => void } } } }).chrome;
  chrome.runtime.onMessage.addListener = (l: Listener) => { listeners.push(l); };
  chrome.action = { setBadgeText, setBadgeBackgroundColor: vi.fn(async () => {}) };
  turns = await import('../agent-turns');
  const { registerAgentTurnHandlers } = await import('../../handlers/agent-turn-handlers');
  registerAgentTurnHandlers();
});

beforeEach(async () => {
  resetMockBrowser();
  setBadgeText.mockClear();
  await turns.__resetAgentTurnsForTests();
});

function lastBadge(): string | undefined {
  return setBadgeText.mock.calls.at(-1)?.[0].text;
}

function turn(outcome: Parameters<import('../agent-turns').AgentTurnRecorder['end']>[0], tools = 1) {
  const r = turns.startAgentTurn({ origin: 'https://a.test', api: 'agent.run', agentId: 'agent', prompt: 'p' });
  for (let i = 0; i < tools; i++) r.toolCall(`c${i}`, `Tool ${i}`, 'execute');
  r.end(outcome);
  return r;
}

async function send(type: string, url: string, tab?: { id: number }): Promise<{ ok: boolean; [k: string]: unknown }> {
  return new Promise((resolve) => {
    for (const l of listeners) {
      if (l({ type }, { id: "harbor-test", url, tab } as chrome.runtime.MessageSender, resolve as (r: unknown) => void) === true) return;
    }
  });
}

describe('the toolbar badge', () => {
  it('counts turns that used tools and ended without an answer, and clears once the feed is opened', async () => {
    turn('cancelled');
    turn('timed-out');
    turn('answered');
    turn('failed', 0);
    expect(await turns.unseenAgentTurnCount()).toBe(2);
    expect(lastBadge()).toBe('2');

    await turns.markAgentTurnsSeen();
    expect(await turns.unseenAgentTurnCount()).toBe(0);
    expect(lastBadge()).toBe('');
  });

  it('ignores a tool call reported after the turn ended', async () => {
    const r = turn('answered', 0);
    r.toolCall('late', 'Late tool', 'execute');
    const [only] = await turns.listAgentTurns();
    expect(only.tools).toEqual([]);
    expect(only.unseen).toBe(false);
  });
});

describe('a tool call reported twice', () => {
  it('is recorded once, and a later title fills in a missing one', async () => {
    const r = turns.startAgentTurn({ origin: 'https://a.test', api: 'window.ai', agentId: 'agent', prompt: 'p' });
    r.toolCall('c1', '', 'edit');
    r.toolCall('c1', 'Edit notes.md', null);
    r.toolCall('c1', 'Something else', null);
    r.end('answered');
    const [only] = await turns.listAgentTurns();
    expect(only.tools).toEqual([{ title: 'Edit notes.md', kind: 'edit' }]);
  });
});

describe('the stored record', () => {
  it('keeps only the newest turns', async () => {
    for (let i = 0; i < turns.MAX_TURNS + 5; i++) turn('answered', 0);
    expect(await turns.listAgentTurns()).toHaveLength(turns.MAX_TURNS);
  });

  it('cuts a very long prompt', async () => {
    turns.startAgentTurn({ origin: 'https://a.test', api: 'agent.run', agentId: 'agent', prompt: 'x'.repeat(turns.MAX_PROMPT_CHARS + 50) }).end('answered');
    const [only] = await turns.listAgentTurns();
    expect(only.prompt.length).toBe(turns.MAX_PROMPT_CHARS + 1);
  });

  it('survives the background page stopping, and a turn cut off mid-run comes back as cancelled and unseen', async () => {
    const r = turns.startAgentTurn({ origin: 'https://a.test', api: 'agent.run', agentId: 'agent', prompt: 'p' });
    r.toolCall('c1', 'Run tests', 'execute');
    await turns.listAgentTurns();
    const stored = (await getMockStorage().local.get(turns.AGENT_TURNS_STORAGE_KEY))[turns.AGENT_TURNS_STORAGE_KEY];

    // A fresh background page: nothing in memory, only what was stored.
    await turns.__resetAgentTurnsForTests();
    await getMockStorage().local.set({ [turns.AGENT_TURNS_STORAGE_KEY]: stored });

    const [back] = await turns.listAgentTurns();
    expect(back).toMatchObject({ prompt: 'p', tools: [{ title: 'Run tests', kind: 'execute' }], outcome: 'cancelled', unseen: true });
  });
});

describe('who can read the record or clear the badge', () => {
  it('refuses a web page, even one that claims no tab', async () => {
    turn('cancelled');
    expect(await send('agent_turns.list', 'https://evil.test/page', { id: 3 })).toMatchObject({ ok: false });
    expect(await send('agent_turns.mark_seen', 'https://evil.test/page')).toMatchObject({ ok: false });
    expect(await turns.unseenAgentTurnCount()).toBe(1);
  });

  it("answers Harbor's own sidebar", async () => {
    turn('cancelled');
    const sidebar = 'chrome-extension://harbor-test/dist/sidebar.html';
    expect(await send('agent_turns.list', sidebar)).toMatchObject({ ok: true, unseen: 1, turns: [{ outcome: 'cancelled' }] });
    expect(await send('agent_turns.mark_seen', sidebar)).toMatchObject({ ok: true });
    expect(await turns.unseenAgentTurnCount()).toBe(0);
  });
});
