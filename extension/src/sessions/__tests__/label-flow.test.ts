import { describe, expect, it } from 'vitest';
import { SessionRegistry } from '../registry';
import { LabelSet } from '../../policy/labels';

const ORIGIN = 'https://dummy.example';

function create() {
  return SessionRegistry.createExplicitSession(ORIGIN, { capabilities: { llm: {} } }).sessionId!;
}

describe('session-owned flow state', () => {
  it('unions labels only within one validated session and keeps them out of summaries', () => {
    const first = create();
    const second = create();
    try {
      const flow = SessionRegistry.getLabelFlow(first, ORIGIN);
      flow.add(new LabelSet(['credentials']));
      flow.add(new LabelSet(['confidential']));
      expect(SessionRegistry.getLabelFlow(first, ORIGIN)).toBe(flow);
      expect(flow.labels.toArray()).toEqual(['confidential', 'credentials']);
      expect(SessionRegistry.getLabelFlow(second, ORIGIN).labels.isEmpty()).toBe(true);
      expect(SessionRegistry.listSessions({ origin: ORIGIN }).every(s => !('labelFlow' in s) && !('labels' in s))).toBe(true);
      expect(() => SessionRegistry.getLabelFlow(first, 'https://other.example')).toThrow('different origin');
    } finally {
      SessionRegistry.destroySession(first, ORIGIN);
      SessionRegistry.destroySession(second, ORIGIN);
    }
  });

  it.each(['expired', 'terminated', 'destroyed'] as const)('refuses flow access for a %s session', (state) => {
    const id = create();
    SessionRegistry.getLabelFlow(id, ORIGIN).add(new LabelSet(['credentials']));
    if (state === 'expired') SessionRegistry.getValidatedSession(id, ORIGIN).capabilities.limits = { expiresAt: Date.now() - 1 };
    if (state === 'terminated') SessionRegistry.terminateSession(id, ORIGIN);
    if (state === 'destroyed') SessionRegistry.destroySession(id, ORIGIN);
    expect(() => SessionRegistry.getLabelFlow(id, ORIGIN)).toThrow();
    SessionRegistry.destroySession(id, ORIGIN);
  });
});
