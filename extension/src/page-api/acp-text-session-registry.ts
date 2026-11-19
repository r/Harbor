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
 * registered, so it marks the pending open cancelled instead — once `open()`
 * settles, `createAcpTextSession` checks that flag and tears the session
 * down immediately rather than registering it.
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

interface PendingOpen {
  tabId?: number;
  cancelled: boolean;
}

const pendingOpens = new Map<string, PendingOpen>();

/** @internal acp-text-session.ts only. Call before starting `AcpTextSession.open()`. */
export function registerPendingOpen(sessionId: string, tabId: number | undefined): void {
  pendingOpens.set(sessionId, { tabId, cancelled: false });
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
 * settles, instead of registering. Returns nothing: unlike
 * `acpTextSessionIdsForTab`, the caller has no live session object yet to
 * act on directly — `createAcpTextSession` is what finishes the job.
 */
export function cancelPendingOpensForTab(tabId: number): void {
  for (const pending of pendingOpens.values()) {
    if (pending.tabId === tabId) pending.cancelled = true;
  }
}
