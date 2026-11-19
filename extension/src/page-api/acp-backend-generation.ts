/**
 * Switching `harbor_agent_backend` must end work still running on the old
 * agent, not just change what a *new* `agent.run` uses
 * (docs/ACP_BACKEND_DESIGN.md). page-api/background.ts combines every
 * ACP-backed run's own page-abort signal with `acpBackendChangeSignal()`
 * before handing it to `AcpAgentBackend.run()`; a switch aborts that
 * signal with `BACKEND_CHANGED_REASON`, which acp-connection.ts's
 * `cancelReasonForSignal` recognizes to report `ERR_AGENT_FAILED` /
 * "The agent was changed." instead of an ordinary `ERR_ABORTED`.
 *
 * A no-dependency leaf module (like acp-agent-limits.ts), so it can be
 * imported from both background.ts (to invalidate on a switch) and
 * acp-backend.ts (to combine into each run's signal) without coupling
 * either to the other.
 */

/** `AbortSignal.reason` for an abort caused by a backend switch, not a page-initiated cancel. */
export const BACKEND_CHANGED_REASON = 'harbor:acp-backend-changed';

let currentGeneration = new AbortController();

/** The signal every new ACP agent.run should combine with its own page-abort signal. */
export function acpBackendChangeSignal(): AbortSignal {
  return currentGeneration.signal;
}

/**
 * Called when `harbor_agent_backend` changes: aborts every signal
 * `acpBackendChangeSignal()` has handed out so far (ending every ACP
 * agent.run still using the old agent), and starts a fresh generation for
 * runs begun after this point.
 */
export function invalidateAcpBackendGeneration(): void {
  currentGeneration.abort(BACKEND_CHANGED_REASON);
  currentGeneration = new AbortController();
}

/** For tests only. */
export function resetAcpBackendGenerationForTests(): void {
  currentGeneration = new AbortController();
}
