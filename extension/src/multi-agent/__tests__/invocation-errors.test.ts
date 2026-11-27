import { beforeEach, describe, expect, it, vi } from 'vitest';

// When Harbor answers an invocation itself, because the target can't take it
// or Harbor's own delivery failed, the caller gets one of the documented
// codes, and the answer carries no provenance (no agent gave it).

let messaging: typeof import('../messaging');
let registry: typeof import('../registry');

beforeEach(async () => {
  vi.resetModules();
  messaging = await import('../messaging');
  registry = await import('../registry');
});

function agents(target: { acceptsInvocations?: boolean } = {}) {
  const from = registry.registerAgent({ name: 'caller' }, 'https://b.example', 2);
  const to = registry.registerAgent({ name: 'target', ...target }, 'https://a.example', 1);
  return { from: from.id, to: to.id };
}

describe("Harbor's answers for an invocation it couldn't deliver", () => {
  it("is ERR_AGENT_NOT_ACCEPTING when the target doesn't accept invocations", async () => {
    const { from, to } = agents({ acceptsInvocations: false });
    const response = await messaging.invokeAgent({ agentId: to, task: 't' }, from);
    expect(response).toMatchObject({ success: false, error: { code: 'ERR_AGENT_NOT_ACCEPTING' } });
    expect(response.provenance).toBeUndefined();
  });

  it('is ERR_AGENT_NOT_ACCEPTING when the target has no invocation handler', async () => {
    const { from, to } = agents();
    const response = await messaging.invokeAgent({ agentId: to, task: 't' }, from);
    expect(response).toMatchObject({ success: false, error: { code: 'ERR_AGENT_NOT_ACCEPTING' } });
    expect(response.provenance).toBeUndefined();
  });

  it("is ERR_INTERNAL when Harbor's delivery throws", async () => {
    const { from, to } = agents();
    messaging.registerInvocationHandler(to, async () => { throw new Error('boom'); });
    const response = await messaging.invokeAgent({ agentId: to, task: 't' }, from);
    expect(response).toMatchObject({ success: false, error: { code: 'ERR_INTERNAL', message: 'boom' } });
    expect(response.provenance).toBeUndefined();
  });
});
