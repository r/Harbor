/**
 * Harbor Page API - ACP-backed text session registry
 *
 * Just the "is this window.ai sessionId backed by an ACP agent?" lookup,
 * with no dependency on the ACP connection machinery itself
 * (acp-text-session.ts, which pulls in the ACP SDK and
 * agent-question.ts's module-level listener registration). ai-handlers.ts
 * checks `isAcpTextSession` on every `session.prompt`/`session.destroy` —
 * including for every session on the built-in backend — so that check has
 * to stay cheap and side-effect-free; the heavier module is only loaded
 * (dynamically) once a sessionId actually is one of these.
 *
 * Also tracks sessions whose agent is still starting (`createAcpTextSession`
 * hasn't resolved yet): a tab closing, or its port disconnecting, while
 * `open()` is still in flight can't destroy a session that was never
 * registered. `cancelPendingOpensForTab` both marks the pending open
 * cancelled (for `createAcpTextSession` to check once `open()` settles on
 * its own) and, if the open already registered an abort callback, calls it
 * immediately — otherwise an agent hanging at `initialize` (never settling
 * on its own) would keep the open running, and its slot held, forever: a
 * tab closing has to be able to interrupt it, not just flag it for later.
 */

interface RegistryEntry {
  tabId?: number;
}

const registry = new Map<string, RegistryEntry>();

export function isAcpTextSession(sessionId: string): boolean {
  return registry.has(sessionId);
}

/** @internal acp-text-session.ts only. */
export function registerAcpTextSession(sessionId: string, tabId: number | undefined): void {
  registry.set(sessionId, { tabId });
}

/** @internal acp-text-session.ts only. */
export function unregisterAcpTextSession(sessionId: string): void {
  registry.delete(sessionId);
}

/** @internal acp-text-session.ts only. */
export function acpTextSessionIdsForTab(tabId: number): string[] {
  return [...registry.entries()].filter(([, entry]) => entry.tabId === tabId).map(([sessionId]) => sessionId);
}

/** @internal acp-text-session.ts only. Every registered session, regardless of tab — for destroying all of them at once (a backend switch, not a per-tab event). */
export function allAcpTextSessionIds(): string[] {
  return [...registry.keys()];
}

interface PendingOpen {
  tabId?: number;
  cancelled: boolean;
  /** Set by `createAcpTextSession` once it has a signal it can abort to interrupt the in-flight `open()`. Called immediately by `cancelPendingOpensForTab` if it's already set; called by `setPendingOpenAbort` itself if cancellation was requested first. */
  abort?: () => void;
}

const pendingOpens = new Map<string, PendingOpen>();

/** @internal acp-text-session.ts only. Call before starting `AcpTextSession.open()`. */
export function registerPendingOpen(sessionId: string, tabId: number | undefined): void {
  pendingOpens.set(sessionId, { tabId, cancelled: false });
}

/**
 * @internal acp-text-session.ts only. Gives this pending open a way to
 * interrupt itself — called right away if `cancelPendingOpensForTab`
 * already marked it cancelled before this was set (the tab closed before
 * `createAcpTextSession` got this far).
 */
export function setPendingOpenAbort(sessionId: string, abort: () => void): void {
  const pending = pendingOpens.get(sessionId);
  if (!pending) return;
  pending.abort = abort;
  if (pending.cancelled) abort();
}

/** @internal acp-text-session.ts only. Call once `open()` has settled, success or not. */
export function clearPendingOpen(sessionId: string): void {
  pendingOpens.delete(sessionId);
}

/** @internal acp-text-session.ts only. */
export function isPendingOpenCancelled(sessionId: string): boolean {
  return pendingOpens.get(sessionId)?.cancelled ?? false;
}

/**
 * Marks every still-opening session for `tabId` cancelled, so each one
 * tears itself down (and calls `acp.close`) as soon as its `open()` call
 * settles, instead of registering — and, for one that already registered
 * an abort callback, calls it now, so an agent hanging at `initialize`
 * (which would otherwise never let `open()` settle on its own) is
 * interrupted immediately rather than holding its slot forever.
 */
export function cancelPendingOpensForTab(tabId: number): void {
  for (const pending of pendingOpens.values()) {
    if (pending.tabId !== tabId) continue;
    pending.cancelled = true;
    pending.abort?.();
  }
}

/** Same as `cancelPendingOpensForTab`, but every still-opening session — for a backend switch, which ends work on every tab's session, not just one. */
export function cancelAllPendingOpens(): void {
  for (const pending of pendingOpens.values()) {
    pending.cancelled = true;
    pending.abort?.();
  }
}
