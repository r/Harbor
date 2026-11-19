/**
 * `askAgentQuestion` relays one ACP `session/request_permission` to the
 * person, in a popup window of its own, and answers with the agent's own
 * reject option when nobody answers in time (acp-backend.test.ts mocks
 * this whole module at its seam and only checks the wiring; this file
 * drives the real implementation: the window it opens, the messages its
 * page is allowed to send it, and the three ways a question can end
 * without an explicit answer).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type AgentQuestionModule = typeof import('../agent-question');
let askAgentQuestion: AgentQuestionModule['askAgentQuestion'];
let AGENT_QUESTION_TIMEOUT_MS: AgentQuestionModule['AGENT_QUESTION_TIMEOUT_MS'];

type Listener = (message: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean | undefined;
let onMessage: Listener;
let onWindowRemoved: (windowId: number) => void;

const AGENT_QUESTION_URL = 'chrome-extension://harbor-test/agent-question.html';

function pageSender(id: string): { id: string; url: string; tab: { id: number } } {
  return { id: 'harbor-test', url: `${AGENT_QUESTION_URL}?id=${id}`, tab: { id: 1 } };
}

const contentScriptSender = { id: 'harbor-test', url: 'https://evil.example/', tab: { id: 2 } };

const OPTIONS = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];
const REQUEST = { origin: 'https://site.example', agentName: 'goose', toolCall: { title: 'Run tests' }, options: OPTIONS };

/** Calls the background's message listener and returns whatever it passed to `sendResponse` (undefined if it never did). */
function send(message: unknown, sender: unknown): unknown {
  let response: unknown;
  let responded = false;
  onMessage(message, sender, (r) => { response = r; responded = true; });
  return responded ? response : undefined;
}

function spyWindowsCreate() {
  let nextWindowId = 100;
  return vi.spyOn(chrome.windows, 'create').mockImplementation((() => Promise.resolve({ id: nextWindowId++ })) as never);
}

function spyWindowsRemove() {
  return vi.spyOn(chrome.windows, 'remove').mockImplementation((() => Promise.resolve()) as never);
}

describe('askAgentQuestion', () => {
  let createSpy: ReturnType<typeof spyWindowsCreate>;
  let removeSpy: ReturnType<typeof spyWindowsRemove>;

  beforeEach(async () => {
    vi.resetModules();
    createSpy = spyWindowsCreate();
    removeSpy = spyWindowsRemove();
    vi.spyOn(chrome.windows.onRemoved, 'addListener').mockImplementation((listener) => {
      onWindowRemoved = listener as (windowId: number) => void;
    });
    vi.spyOn(chrome.runtime.onMessage, 'addListener').mockImplementation((listener) => {
      onMessage = listener as Listener;
    });

    ({ askAgentQuestion, AGENT_QUESTION_TIMEOUT_MS } = await import('../agent-question'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function openedUrl(): URL {
    return new URL((createSpy.mock.calls.at(-1)![0] as { url: string }).url);
  }

  /**
   * `askAgentQuestion` records the window's id only once its own
   * `windows.create(...).then(...)` runs, a microtask after `create` is
   * called. `vi.waitFor` only proves `create` was *called*; this flushes
   * the microtask queue so that follow-on assignment has definitely run
   * before a test acts on the window id (answering, or simulating it
   * closing). A pure microtask flush, so it works under fake timers too.
   */
  async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  it('opens agent-question.html with only the opaque id as a query param — never the request itself', async () => {
    const promise = askAgentQuestion(REQUEST, new AbortController().signal);
    await vi.waitFor(() => expect(createSpy).toHaveBeenCalled());
    await flush();

    const url = openedUrl();
    expect(url.pathname).toBe('/agent-question.html');
    expect([...url.searchParams.keys()]).toEqual(['id']);
    const id = url.searchParams.get('id')!;
    expect(id.length).toBeGreaterThan(10);
    expect(url.search).not.toContain('Run tests');

    const fetched = send({ type: 'agent_question_get', id }, pageSender(id));
    expect(fetched).toEqual({ ok: true, request: REQUEST });

    expect(send({ type: 'agent_question_answer', id, optionId: 'reject' }, pageSender(id))).toEqual({ ok: true });
    await expect(promise).resolves.toEqual({ outcome: 'selected', optionId: 'reject' });
    expect(removeSpy).toHaveBeenCalledWith(100);
  });

  it('resolves immediately with cancelled, and never opens a window, when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(askAgentQuestion(REQUEST, controller.signal)).resolves.toEqual({ outcome: 'cancelled' });
    expect(createSpy).not.toHaveBeenCalled();
  });

  describe('the response message is validated on receipt', () => {
    it('ignores a content-script sender: no response, and the question stays open', async () => {
      const promise = askAgentQuestion(REQUEST, new AbortController().signal);
      await vi.waitFor(() => expect(createSpy).toHaveBeenCalled());
      await flush();
      const id = openedUrl().searchParams.get('id')!;

      expect(send({ type: 'agent_question_answer', id, optionId: 'allow' }, contentScriptSender)).toBeUndefined();
      expect(send({ type: 'agent_question_get', id }, contentScriptSender)).toBeUndefined();

      // The question is still open for the legitimate page to answer.
      expect(send({ type: 'agent_question_answer', id, optionId: 'allow' }, pageSender(id))).toEqual({ ok: true });
      await expect(promise).resolves.toEqual({ outcome: 'selected', optionId: 'allow' });
    });

    it('ignores an answer for an unknown (or already-settled) id', async () => {
      const promise = askAgentQuestion(REQUEST, new AbortController().signal);
      await vi.waitFor(() => expect(createSpy).toHaveBeenCalled());
      await flush();
      const id = openedUrl().searchParams.get('id')!;

      expect(send({ type: 'agent_question_answer', id: 'not-a-real-id', optionId: 'allow' }, pageSender('not-a-real-id'))).toBeUndefined();

      expect(send({ type: 'agent_question_answer', id, optionId: 'reject' }, pageSender(id))).toEqual({ ok: true });
      await expect(promise).resolves.toEqual({ outcome: 'selected', optionId: 'reject' });

      // Answering the same id again, now that it's settled, is also ignored.
      expect(send({ type: 'agent_question_answer', id, optionId: 'allow' }, pageSender(id))).toBeUndefined();
    });

    it('ignores an optionId the agent never offered', async () => {
      const promise = askAgentQuestion(REQUEST, new AbortController().signal);
      await vi.waitFor(() => expect(createSpy).toHaveBeenCalled());
      await flush();
      const id = openedUrl().searchParams.get('id')!;

      expect(send({ type: 'agent_question_answer', id, optionId: 'always-allow-everything' }, pageSender(id))).toBeUndefined();

      expect(send({ type: 'agent_question_answer', id, optionId: 'allow' }, pageSender(id))).toEqual({ ok: true });
      await expect(promise).resolves.toEqual({ outcome: 'selected', optionId: 'allow' });
    });
  });

  describe('answering without an explicit choice', () => {
    it('closing the window answers with reject_once, when the agent offered one', async () => {
      const promise = askAgentQuestion(REQUEST, new AbortController().signal);
      await vi.waitFor(() => expect(createSpy).toHaveBeenCalled());
      await flush();
      const windowId = (await createSpy.mock.results[0]!.value).id;

      onWindowRemoved(windowId);
      await expect(promise).resolves.toEqual({ outcome: 'selected', optionId: 'reject' });
    });

    it('closing the window answers with reject_always when that is the only reject option offered', async () => {
      const request = { ...REQUEST, options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'always-reject', name: 'Always Reject', kind: 'reject_always' },
      ] };
      const promise = askAgentQuestion(request, new AbortController().signal);
      await vi.waitFor(() => expect(createSpy).toHaveBeenCalled());
      await flush();
      const windowId = (await createSpy.mock.results[0]!.value).id;

      onWindowRemoved(windowId);
      await expect(promise).resolves.toEqual({ outcome: 'selected', optionId: 'always-reject' });
    });

    it('closing the window answers cancelled when the agent offered no reject option at all', async () => {
      const request = { ...REQUEST, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] };
      const promise = askAgentQuestion(request, new AbortController().signal);
      await vi.waitFor(() => expect(createSpy).toHaveBeenCalled());
      await flush();
      const windowId = (await createSpy.mock.results[0]!.value).id;

      onWindowRemoved(windowId);
      await expect(promise).resolves.toEqual({ outcome: 'cancelled' });
    });

    it('some other window closing leaves the question open', async () => {
      const promise = askAgentQuestion(REQUEST, new AbortController().signal);
      await vi.waitFor(() => expect(createSpy).toHaveBeenCalled());
      await flush();

      onWindowRemoved(999999);
      let settled = false;
      void promise.then(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 0));
      expect(settled).toBe(false);
    });

    it('a liveness timeout answers with the reject option and closes the window', async () => {
      vi.useFakeTimers();
      const promise = askAgentQuestion(REQUEST, new AbortController().signal);
      await vi.waitFor(() => expect(createSpy).toHaveBeenCalled(), { timeout: 2000 });

      await vi.advanceTimersByTimeAsync(AGENT_QUESTION_TIMEOUT_MS);

      await expect(promise).resolves.toEqual({ outcome: 'selected', optionId: 'reject' });
      expect(removeSpy).toHaveBeenCalledTimes(1);
    });

    it('the run being cancelled while the question is open answers cancelled and closes the window, even when a reject option was offered', async () => {
      const controller = new AbortController();
      const promise = askAgentQuestion(REQUEST, controller.signal);
      await vi.waitFor(() => expect(createSpy).toHaveBeenCalled());
      await flush();

      controller.abort();

      await expect(promise).resolves.toEqual({ outcome: 'cancelled' });
      expect(removeSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('several questions can be open at once, each with its own window, answered independently', async () => {
    const requestA = { ...REQUEST, origin: 'https://a.example' };
    const requestB = { ...REQUEST, origin: 'https://b.example' };
    const promiseA = askAgentQuestion(requestA, new AbortController().signal);
    const promiseB = askAgentQuestion(requestB, new AbortController().signal);
    await vi.waitFor(() => expect(createSpy).toHaveBeenCalledTimes(2));
    await flush();

    const idA = new URL((createSpy.mock.calls[0][0] as { url: string }).url).searchParams.get('id')!;
    const idB = new URL((createSpy.mock.calls[1][0] as { url: string }).url).searchParams.get('id')!;
    expect(idA).not.toBe(idB);

    expect(send({ type: 'agent_question_get', id: idA }, pageSender(idA))).toEqual({ ok: true, request: requestA });
    expect(send({ type: 'agent_question_get', id: idB }, pageSender(idB))).toEqual({ ok: true, request: requestB });

    expect(send({ type: 'agent_question_answer', id: idA, optionId: 'reject' }, pageSender(idA))).toEqual({ ok: true });
    await expect(promiseA).resolves.toEqual({ outcome: 'selected', optionId: 'reject' });

    let bSettled = false;
    void promiseB.then(() => { bSettled = true; });
    await new Promise((r) => setTimeout(r, 0));
    expect(bSettled).toBe(false); // answering A must not answer B

    expect(send({ type: 'agent_question_answer', id: idB, optionId: 'allow' }, pageSender(idB))).toEqual({ ok: true });
    await expect(promiseB).resolves.toEqual({ outcome: 'selected', optionId: 'allow' });
  });
});
