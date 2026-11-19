/**
 * Harbor Page API - Per-site ACP agent concurrency cap
 *
 * Counts live ACP agent processes per site origin — a `window.agent.run`
 * while it's running, and a `window.ai` text session for its whole life,
 * together — and refuses a new one past the cap with `ERR_AGENT_BUSY`,
 * before `acp.open` is ever called (a maintainer decision; see
 * docs/ACP_BACKEND_DESIGN.md sections 2 and 3). A no-dependency leaf
 * module, so both acp-backend.ts (agent.run) and acp-text-session.ts
 * (text sessions) can import it directly without pulling either backend
 * into the other.
 *
 * A slot is acquired right before the bridge is asked to open a channel,
 * and released on every path that ends the agent: `destroy()`, a tab
 * closing, its port disconnecting, `open()` itself failing, and a run or a
 * turn's own timeout (which already triggers the same cleanup that calls
 * `acp.close`). Each caller acquires and releases at most once per
 * agent — see acp-backend.ts's `run()` and acp-text-session.ts's `open()`/
 * `destroy()` for where.
 */
export const PER_SITE_AGENT_LIMIT = 2;

const liveAgentsByOrigin = new Map<string, number>();

/**
 * Reserves one of `origin`'s agent slots. Returns `false`, reserving
 * nothing, once `origin` already holds `PER_SITE_AGENT_LIMIT` — the caller
 * must not call `acp.open` in that case.
 */
export function tryAcquireAgentSlot(origin: string): boolean {
  const count = liveAgentsByOrigin.get(origin) ?? 0;
  if (count >= PER_SITE_AGENT_LIMIT) return false;
  liveAgentsByOrigin.set(origin, count + 1);
  return true;
}

/**
 * Frees one of `origin`'s agent slots. A no-op once `origin` holds none,
 * so a defensive double release (two cleanup paths both reacting to the
 * same end) can never go negative or free a slot it doesn't own.
 */
export function releaseAgentSlot(origin: string): void {
  const count = liveAgentsByOrigin.get(origin) ?? 0;
  if (count <= 1) liveAgentsByOrigin.delete(origin);
  else liveAgentsByOrigin.set(origin, count - 1);
}

/** For tests only — the rest of the extension never needs to read this. */
export function liveAgentCountForOrigin(origin: string): number {
  return liveAgentsByOrigin.get(origin) ?? 0;
}

/**
 * For tests only. Without `vi.resetModules()` between tests (which many of
 * this module's callers' own test files avoid — see
 * acp-text-session.test.ts's `connectPort` comment for why), this map
 * otherwise accumulates slots across every test in a file that creates
 * sessions/runs without destroying all of them.
 */
export function resetAgentSlotsForTests(): void {
  liveAgentsByOrigin.clear();
}
