/**
 * `cancelReasonForSignal` tells an ordinary page/tab abort apart from a
 * backend switch (page-api/acp-backend-generation.ts's
 * `BACKEND_CHANGED_REASON`), so acp-backend.ts and acp-text-session.ts
 * report the right coded error for each — ERR_ABORTED for the former,
 * ERR_AGENT_FAILED / "The agent was changed." for the latter — from the
 * same abort-listener code that used to always assume 'aborted'.
 */
import { describe, expect, it } from 'vitest';
import { BACKEND_CHANGED_REASON } from '../acp-backend-generation';
import { cancelReasonEvent, cancelReasonForSignal } from '../acp-connection';

describe('cancelReasonForSignal', () => {
  it('is "aborted" for a signal with no special reason', () => {
    const controller = new AbortController();
    controller.abort();
    expect(cancelReasonForSignal(controller.signal)).toBe('aborted');
  });

  it('is "aborted" for a signal aborted with some other reason', () => {
    const controller = new AbortController();
    controller.abort('something else entirely');
    expect(cancelReasonForSignal(controller.signal)).toBe('aborted');
  });

  it('is "backend-changed" for a signal aborted with BACKEND_CHANGED_REASON', () => {
    const controller = new AbortController();
    controller.abort(BACKEND_CHANGED_REASON);
    expect(cancelReasonForSignal(controller.signal)).toBe('backend-changed');
  });
});

describe('cancelReasonEvent("backend-changed")', () => {
  it('reports ERR_AGENT_FAILED with "The agent was changed."', () => {
    expect(cancelReasonEvent('backend-changed')).toEqual({
      type: 'error',
      error: { code: 'ERR_AGENT_FAILED', message: 'The agent was changed.' },
    });
  });
});
