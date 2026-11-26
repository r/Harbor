/**
 * Harbor's own record of each turn on the person's own agent.
 *
 * When a site prompts the person's own agent (`window.ai`, `agent.sessions`
 * or `agent.run` on the ACP backend), the agent can use its own tools during
 * the turn. The page decides what, if anything, to show of that, and a page
 * that leaves or cancels mid-turn shows nothing. So Harbor records every
 * turn itself: the site, which API started it, the prompt, the agent's tool
 * calls (by title and kind), and how it ended. The sidebar's activity feed
 * lists these records.
 *
 * A turn that used tools and didn't end with the page getting its answer is
 * "unseen": nobody saw the result of what the agent did. Unseen turns put a
 * count on Harbor's toolbar button until the person opens the feed.
 *
 * A turn is recorded from the moment its prompt is sent to the agent. A
 * request refused before that never reached the agent, so there's nothing to
 * record. Turns from Harbor's own page chat are not recorded here: the
 * person is the one typing there, in Harbor's own UI.
 *
 * Records are kept in `storage.local`, so they survive the background page
 * being suspended. Only the newest `MAX_TURNS` are kept.
 */

import type { CancelReason } from './acp-connection';

export type AgentTurnApi = 'window.ai' | 'agent.sessions' | 'agent.run';
export type AgentTurnOutcome = 'answered' | 'failed' | 'cancelled' | 'timed-out';

export interface AgentTurnToolCall {
  title: string;
  kind?: string;
}

export interface AgentTurnRecord {
  id: string;
  startedAt: number;
  endedAt?: number;
  origin: string;
  api: AgentTurnApi;
  agentId: string;
  prompt: string;
  tools: AgentTurnToolCall[];
  /** Tool calls left out of `tools` once it reached `MAX_TOOLS_PER_TURN`. */
  moreTools?: number;
  /** Unset while the turn is still running. */
  outcome?: AgentTurnOutcome;
  /** The turn used tools and ended without the page getting its answer, and the person hasn't opened the feed since. */
  unseen: boolean;
}

export interface AgentTurnRecorder {
  /** Records one tool call. A later call with the same id only fills in a title or kind the first one lacked. */
  toolCall(toolCallId: string, title: string | null | undefined, kind: string | null | undefined): void;
  /** Ends the turn. Only the first call counts. */
  end(outcome: AgentTurnOutcome): void;
}

export const AGENT_TURNS_STORAGE_KEY = 'harbor_agent_turns';
export const MAX_TURNS = 200;
/** Longer prompts are cut to this many characters in the record. */
export const MAX_PROMPT_CHARS = 4_000;
/** Tool calls kept per turn; the rest are only counted. The agent decides how many it makes. */
export const MAX_TOOLS_PER_TURN = 100;
/** Longer tool titles and kinds, which come from the agent, are cut to this many characters. */
export const MAX_TOOL_TITLE_CHARS = 200;

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

type ExtensionApi = {
  storage?: { local?: { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> } };
  action?: {
    setBadgeText?(details: { text: string }): Promise<void> | void;
    setBadgeBackgroundColor?(details: { color: string }): Promise<void> | void;
  };
};

/** Looked up on each use, not at import: tests (and Safari's late globals) can swap the extension API in after this module loads. */
function api(): ExtensionApi | undefined {
  const g = globalThis as { browser?: ExtensionApi; chrome?: ExtensionApi };
  return g.browser ?? g.chrome;
}

let turns: AgentTurnRecord[] = [];
let loaded: Promise<void> | null = null;
/** Every write goes through this chain, so they land in order. */
let writes: Promise<void> = Promise.resolve();

function load(): Promise<void> {
  if (!loaded) {
    loaded = (async () => {
      try {
        const stored = (await api()?.storage?.local?.get(AGENT_TURNS_STORAGE_KEY))?.[AGENT_TURNS_STORAGE_KEY];
        if (Array.isArray(stored)) {
          // A turn still marked running was cut off when the background
          // page stopped; it can't be running now.
          turns = (stored as AgentTurnRecord[]).map((t) => (t.outcome ? t : endRecord(t, 'cancelled')));
        }
      } catch {
        // No stored record to read; start empty.
      }
    })();
  }
  return loaded;
}

function endRecord(turn: AgentTurnRecord, outcome: AgentTurnOutcome): AgentTurnRecord {
  return {
    ...turn,
    outcome,
    endedAt: turn.endedAt ?? Date.now(),
    unseen: outcome !== 'answered' && (turn.tools.length > 0 || (turn.moreTools ?? 0) > 0),
  };
}

function persist(): Promise<void> {
  writes = writes.then(async () => {
    await load();
    try {
      await api()?.storage?.local?.set({ [AGENT_TURNS_STORAGE_KEY]: turns });
    } catch {
      // Best-effort: the in-memory record still stands.
    }
    await updateBadge();
  });
  return writes;
}

async function updateBadge(): Promise<void> {
  const action = api()?.action;
  if (!action?.setBadgeText) return;
  const count = turns.filter((t) => t.unseen).length;
  try {
    await action.setBadgeBackgroundColor?.({ color: '#b45309' });
    await action.setBadgeText({ text: count > 0 ? String(count) : '' });
  } catch {
    // Some browsers have no badge; the feed still lists the turn.
  }
}

/** Mutates the record for `id` once the stored list has loaded, then persists. */
function update(id: string, fn: (turn: AgentTurnRecord) => AgentTurnRecord): void {
  void load().then(() => {
    const index = turns.findIndex((t) => t.id === id);
    if (index === -1) return;
    turns[index] = fn(turns[index]);
    return persist();
  });
}

/** How a turn that didn't answer ended, from why Harbor cancelled it (`null`: it wasn't cancelled, so it failed). */
export function unansweredTurnOutcome(reason: CancelReason | null): AgentTurnOutcome {
  if (reason === 'timeout') return 'timed-out';
  return reason ? 'cancelled' : 'failed';
}

/** Starts recording a turn whose prompt is about to be sent to the agent. */
export function startAgentTurn(info: { origin: string; api: AgentTurnApi; agentId: string; prompt: string }): AgentTurnRecorder {
  const id = `turn_${crypto.randomUUID()}`;
  const record: AgentTurnRecord = {
    id,
    startedAt: Date.now(),
    origin: info.origin,
    api: info.api,
    agentId: info.agentId,
    prompt: cut(info.prompt, MAX_PROMPT_CHARS),
    tools: [],
    unseen: false,
  };
  const toolIndex = new Map<string, number>();
  const omitted = new Set<string>();
  let ended = false;

  void load().then(() => {
    turns.push(record);
    if (turns.length > MAX_TURNS) turns.splice(0, turns.length - MAX_TURNS);
    return persist();
  });

  return {
    toolCall(toolCallId, rawTitle, rawKind) {
      if (ended) return;
      const title = rawTitle ? cut(rawTitle, MAX_TOOL_TITLE_CHARS) : rawTitle;
      const kind = rawKind ? cut(rawKind, MAX_TOOL_TITLE_CHARS) : rawKind;
      const known = toolIndex.get(toolCallId);
      if (known === undefined) {
        if (toolIndex.size >= MAX_TOOLS_PER_TURN) {
          if (!omitted.has(toolCallId)) {
            omitted.add(toolCallId);
            update(id, (t) => ({ ...t, moreTools: (t.moreTools ?? 0) + 1 }));
          }
          return;
        }
        toolIndex.set(toolCallId, toolIndex.size);
        const call: AgentTurnToolCall = { title: title || kind || 'Tool call' };
        if (kind) call.kind = kind;
        update(id, (t) => ({ ...t, tools: [...t.tools, call] }));
        return;
      }
      if (!title && !kind) return;
      update(id, (t) => {
        const tools = t.tools.slice();
        const call = { ...tools[known] };
        if (title && call.title === (call.kind || 'Tool call')) call.title = title;
        if (kind && !call.kind) call.kind = kind;
        tools[known] = call;
        return { ...t, tools };
      });
    },
    end(outcome) {
      if (ended) return;
      ended = true;
      update(id, (t) => endRecord(t, outcome));
    },
  };
}

/** Every kept record, oldest first. Waits for pending writes, so a caller sees what has been recorded so far. */
export async function listAgentTurns(): Promise<AgentTurnRecord[]> {
  await load();
  await writes;
  return turns.map((t) => ({ ...t, tools: t.tools.slice() }));
}

export async function unseenAgentTurnCount(): Promise<number> {
  return (await listAgentTurns()).filter((t) => t.unseen).length;
}

/** The person opened the feed: nothing is unseen any more. */
export async function markAgentTurnsSeen(): Promise<void> {
  await load();
  turns = turns.map((t) => (t.unseen ? { ...t, unseen: false } : t));
  await persist();
}

/** Test hook: forget everything, including what was loaded from storage. */
export async function __resetAgentTurnsForTests(): Promise<void> {
  await writes.catch(() => {});
  turns = [];
  loaded = null;
  writes = Promise.resolve();
}
