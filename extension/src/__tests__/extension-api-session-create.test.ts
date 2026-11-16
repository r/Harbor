import { describe, expect, it, vi } from 'vitest';
import { routeExtensionApiMessage } from '../extension-api';

// HBR-13: an explicit session gets the tools the origin was granted that it
// also requested, never the request alone.

vi.mock('../llm/bridge-client', () => ({ bridgeRequest: vi.fn(), bridgeStreamRequest: vi.fn() }));
vi.mock('../mcp/host', () => ({}));
vi.mock('../agents/background-router', () => ({ routeExternalMessage: vi.fn() }));
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
