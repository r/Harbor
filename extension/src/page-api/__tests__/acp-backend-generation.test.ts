/**
 * The signal every in-flight ACP agent.run combines with its own page-abort
 * signal (page-api/background.ts), so switching `harbor_agent_backend`
 * cancels every run still going on the old agent — see
 * docs/ACP_BACKEND_DESIGN.md and the "the agent was changed" wording in
 * acp-connection.ts's cancelReasonEvent.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  BACKEND_CHANGED_REASON,
  acpBackendChangeSignal,
  invalidateAcpBackendGeneration,
  resetAcpBackendGenerationForTests,
} from '../acp-backend-generation';

afterEach(() => {
  resetAcpBackendGenerationForTests();
});

describe('acpBackendChangeSignal / invalidateAcpBackendGeneration', () => {
  it('is not aborted before any switch', () => {
    expect(acpBackendChangeSignal().aborted).toBe(false);
  });

  it('aborts every signal handed out before the switch, with the sentinel reason', () => {
    const signal = acpBackendChangeSignal();
    expect(signal.aborted).toBe(false);
    invalidateAcpBackendGeneration();
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(BACKEND_CHANGED_REASON);
  });

  it('starts a fresh, non-aborted signal for runs started after the switch', () => {
    const before = acpBackendChangeSignal();
    invalidateAcpBackendGeneration();
    const after = acpBackendChangeSignal();
    expect(after).not.toBe(before);
    expect(after.aborted).toBe(false);
  });

  it('a second switch only aborts signals handed out since the first', () => {
    const first = acpBackendChangeSignal();
    invalidateAcpBackendGeneration();
    const second = acpBackendChangeSignal();
    invalidateAcpBackendGeneration();
    expect(first.aborted).toBe(true);
    expect(second.aborted).toBe(true); // also aborted by the second switch
    expect(acpBackendChangeSignal().aborted).toBe(false);
  });
});
