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
