/**
 * Integration test: full permission flow.
 *
 * The unit tests in policy/__tests__ verify each module in isolation.
 * This test wires the modules together and walks the path a real
 * page-side `agent.requestCapabilities()` call would take:
 *
 *   1. Create an explicit session.
 *   2. Run a typed-action request through the PolicyEngine.
 *   3. Confirm the audit log records the decision.
 *   4. Replay the decision using the simulator and confirm it produces
 *      a result.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { SessionRegistry } from '../sessions';
import {
  evaluate,
  setOriginGrantResolver,
  setWatchdogResolver,
  type PolicyRequest,
} from '../policy/engine';
import { Policy } from '../policy/store';
import { compileRule, type Rule } from '../policy/rules';
import { Audit } from '../policy/audit';
import { simulate, replay } from '../policy/simulator';

beforeEach(() => {
  Policy.__reset();
  Audit.__reset();
  setOriginGrantResolver(() => null);
  setWatchdogResolver(() => ({ status: 'normal' }));
});

function loadRules(rules: Rule[]): void {
  Policy.__setForTesting(
    rules.map((r) => compileRule({ ...r, source: r.source ?? 'user' })),
  );
}

describe('permission flow integration', () => {
  it('mints a session, evaluates an action, records audit, simulates replay', async () => {
    const origin = 'https://flow.example';

    const created = SessionRegistry.createExplicitSession(origin, {
      name: 'Article assistant',
      capabilities: { llm: {}, tools: [], browser: ['read'] },
    });
    expect(created.success).toBe(true);
    const sessionId = created.sessionId!;
    expect(SessionRegistry.getSession(sessionId)).toBeDefined();

    // Run a request that the typed-action defaults allow (tool.list is
    // metadata-only, defaults to allow at Tier 9).
    const request: PolicyRequest = {
      origin,
      action: 'tool.list',
    };
    const decision = await evaluate(request);
    expect(decision.effect).toBe('allow');

    // Manually record the decision so the simulator's replay() has
    // something to find. (In production the engine wrapper does this;
    // calling evaluate() directly skips that step.)
    const record = Audit.record(request, decision);
    expect(record.id).toBeDefined();

    // Replay the decision and verify the simulator finds the record and
    // produces a result.
    const replayResult = await replay(record.id, {});
    expect(replayResult.decision.effect).toBeDefined();
  });

  it('honors a deny rule even when the user has otherwise allowed the action', async () => {
    loadRules([
      {
        id: 'block-cross-origin-fetch',
        effect: 'deny',
        principal: { origin: '*' },
        action: 'network.egress.cross_origin',
        source: 'user',
      } as Rule,
    ]);

    const decision = await evaluate({
      origin: 'https://lab.example',
      action: 'network.egress.cross_origin',
      resource: { host: 'evil.example' },
    });
    expect(decision.effect).toBe('deny');
    expect(decision.errorCode).toBe('ERR_BLOCKED_BY_POLICY');
  });

  it('routes simulator output for a fresh request through the engine', async () => {
    const result = await simulate({
      origin: 'https://sim.example',
      action: 'model.prompt.local',
    });
    expect(result.decision.effect).toBeDefined();
    // simulate() must not pollute the audit log.
    expect(Audit.list().length).toBe(0);
  });
});
