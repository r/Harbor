import { describe, expect, it, vi } from 'vitest';
import { routeExtensionApiMessage } from '../extension-api';

// HBR-13: an explicit session gets the tools the origin was granted that it
// also requested, never the request alone.

vi.mock('../llm/bridge-client', () => ({ bridgeRequest: vi.fn(), bridgeStreamRequest: vi.fn() }));
vi.mock('../mcp/host', () => ({}));
vi.mock('../llm/native-bridge', () => ({}));
vi.mock('../llm/provider-registry', () => ({}));

const origin = 'https://example.test';

async function create(payload: Record<string, unknown>) {
  const res = await routeExtensionApiMessage({
    type: 'session.create',
    payload: { origin, options: { capabilities: { llm: {}, tools: ['time/now', 'fs/write'] } }, ...payload },
  }, {}) as { ok: boolean; result: { sessionId: string } };
  expect(res.ok).toBe(true);
  const got = await routeExtensionApiMessage({
    type: 'session.get', payload: { sessionId: res.result.sessionId, origin },
  }, {}) as { ok: boolean; result: { session: { capabilities: { toolCount: number } } } };
  return got.result.session.capabilities.toolCount;
}

describe('session.create tool grants', () => {
  it('keeps only requested tools the origin was granted', async () => {
    expect(await create({ allowedTools: ['time/now', 'other/tool'] })).toBe(1);
  });

  it('grants no tools when the caller sends no grant', async () => {
    expect(await create({})).toBe(0);
  });
});

describe('session.recordUsage', () => {
  const record = (sessionId: string, from: string | undefined) => routeExtensionApiMessage({
    type: 'session.recordUsage',
    payload: { sessionId, origin: from, type: 'prompt', detail: { userMessage: 'u', assistantMessage: 'a' } },
  }, {}) as Promise<{ ok: boolean }>;

  async function newSession() {
    const res = await routeExtensionApiMessage({
      type: 'session.create', payload: { origin, options: { capabilities: { llm: {} } } },
    }, {}) as { result: { sessionId: string } };
    return res.result.sessionId;
  }
  const promptCount = async (sessionId: string) => ((await routeExtensionApiMessage({
    type: 'session.get', payload: { sessionId, origin },
  }, {})) as { result: { session: { usage: { promptCount: number } } } }).result.session.usage.promptCount;

  it("records a prompt for the session's own origin", async () => {
    const id = await newSession();
    expect((await record(id, origin)).ok).toBe(true);
    expect(await promptCount(id)).toBe(1);
  });

  it('refuses another origin, or no origin', async () => {
    const id = await newSession();
    expect((await record(id, 'https://evil.test')).ok).toBe(false);
    expect((await record(id, undefined)).ok).toBe(false);
    expect(await promptCount(id)).toBe(0);
  });

  it('refuses a terminated session', async () => {
    const id = await newSession();
    await routeExtensionApiMessage({ type: 'session.terminate', payload: { sessionId: id, origin } }, {});
    expect((await record(id, origin)).ok).toBe(false);
  });
});
