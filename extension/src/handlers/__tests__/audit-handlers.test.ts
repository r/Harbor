/**
 * Tests for the sidebar-facing audit/watchdog handlers.
 *
 * These tests register the handlers, then dispatch chrome.runtime
 * messages through the captured listeners and assert on the responses.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Audit } from '../../policy/audit';
import { Watchdog } from '../../policy/watchdog';
import { LabelSet } from '../../policy/labels';

type Listener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void
) => boolean | void;

const listeners: Listener[] = [];

// Patch the chrome.runtime.onMessage mock to capture listeners before any
// handler module is imported. The default mock from test-setup.ts has a
// no-op addListener; we replace it with one that pushes listeners onto
// our local array.
beforeAll(async () => {
  const chrome = (globalThis as unknown as { chrome: { runtime: { onMessage: { addListener: (l: Listener) => void } } } }).chrome;
  chrome.runtime.onMessage.addListener = (l: Listener) => {
    listeners.push(l);
  };

  // Now import-and-register. (Dynamic import so the patch above is in
  // effect when registerHandler runs.)
  const mod = await import('../audit-handlers');
  mod.registerAuditHandlers();
});

async function dispatch(message: Record<string, unknown>): Promise<unknown> {
  // The handler returns true to keep the channel open for async responses.
  // We simulate that by awaiting a Promise that resolves when sendResponse
  // is called.
  return new Promise((resolve) => {
    let resolved = false;
    const sendResponse = (response: unknown): void => {
      if (resolved) return;
      resolved = true;
      resolve(response);
    };
    let async = false;
    for (const l of listeners) {
      const r = l(message, {} as chrome.runtime.MessageSender, sendResponse);
      if (r === true) async = true;
    }
    // If no listener is keeping the channel open, all of them have already
    // called sendResponse synchronously — resolve with `undefined` to avoid
    // hanging in pathological cases.
    if (!async && !resolved) {
      resolve(undefined);
    }
  });
}

describe('audit-handlers', () => {
  beforeEach(() => {
    Audit.clear();
    // Push a couple of synthetic records so query/summarize have data.
    Audit.record(
      {
        origin: 'https://example.com',
        action: 'model.prompt.local',
        inputLabels: LabelSet.empty(),
      },
      {
        effect: 'allow',
        tier: 9,
        source: 'default',
        reason: 'default-allow',
        outputLabels: LabelSet.empty(),
        trace: [],
      }
    );
    Audit.record(
      {
        origin: 'https://other.example',
        action: 'network.egress.cross_origin',
        inputLabels: LabelSet.empty(),
      },
      {
        effect: 'deny',
        tier: 3,
        source: 'label-flow',
        reason: 'flow-denied',
        outputLabels: LabelSet.empty(),
        trace: [],
        errorCode: 'ERR_LABEL_FLOW_BLOCKED',
      }
    );
  });

  it('audit.query returns recorded entries', async () => {
    const r = (await dispatch({ type: 'audit.query', filters: {} })) as {
      ok: boolean;
      records: { action: string }[];
    };
    expect(r.ok).toBe(true);
    expect(r.records.length).toBeGreaterThanOrEqual(2);
  });

  it('audit.query filters by effect', async () => {
    const r = (await dispatch({
      type: 'audit.query',
      filters: { effect: 'deny' },
    })) as { ok: boolean; records: { effect: string }[] };
    expect(r.ok).toBe(true);
    for (const rec of r.records) expect(rec.effect).toBe('deny');
  });

  it('audit.summarize returns aggregate counts', async () => {
    const r = (await dispatch({ type: 'audit.summarize' })) as {
      ok: boolean;
      summary: {
        totalDecisions: number;
        byEffect: Record<string, number>;
        labelEgressDenials: number;
      };
    };
    expect(r.ok).toBe(true);
    expect(r.summary.totalDecisions).toBeGreaterThanOrEqual(2);
    expect(r.summary.labelEgressDenials).toBeGreaterThanOrEqual(1);
  });

  it('audit.clear empties the log', async () => {
    const r = (await dispatch({ type: 'audit.clear' })) as { ok: boolean };
    expect(r.ok).toBe(true);
    const after = (await dispatch({ type: 'audit.query', filters: {} })) as {
      records: unknown[];
    };
    expect(after.records.length).toBe(0);
  });

  it('watchdog.snapshot without origin returns aggregate state', async () => {
    const r = (await dispatch({ type: 'watchdog.snapshot' })) as {
      ok: boolean;
      thresholds: unknown;
      origins: { origin: string; decisions: number }[];
    };
    expect(r.ok).toBe(true);
    expect(r.thresholds).toBeDefined();
    expect(Array.isArray(r.origins)).toBe(true);
  });

  it('watchdog.resetOrigin resets a specific origin', async () => {
    const r = (await dispatch({
      type: 'watchdog.resetOrigin',
      origin: 'https://example.com',
    })) as { ok: boolean };
    expect(r.ok).toBe(true);
    // After reset, inspect() returns the default 'normal' state with no
    // reason. The internal map no longer contains the origin.
    expect(Watchdog.inspect('https://example.com')).toEqual({ status: 'normal' });
  });

  it('policy.replay re-runs a recorded decision and returns a diff', async () => {
    const records = Audit.list();
    expect(records.length).toBeGreaterThan(0);
    const target = records[0];
    const r = (await dispatch({
      type: 'policy.replay',
      recordId: target.id,
      modifications: {},
    })) as {
      ok: boolean;
      result?: {
        decision: { effect: string };
        diff?: unknown;
      };
    };
    expect(r.ok).toBe(true);
    expect(r.result?.decision.effect).toBeDefined();
  });

  it('policy.replay reports missing recordId', async () => {
    const r = (await dispatch({
      type: 'policy.replay',
      recordId: 'nope',
    })) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no audit record/i);
  });

  it('policy.simulate runs a what-if without recording', async () => {
    const before = Audit.list().length;
    const r = (await dispatch({
      type: 'policy.simulate',
      input: {
        origin: 'https://sim.example',
        action: 'model.prompt.local',
      },
    })) as { ok: boolean; result?: { decision: { effect: string } } };
    expect(r.ok).toBe(true);
    expect(r.result?.decision.effect).toBeDefined();
    // Simulator must not pollute the audit log.
    expect(Audit.list().length).toBe(before);
  });
});
