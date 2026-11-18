/**
 * Page calls into the rest of Harbor keep the time limits they had when they
 * crossed extensions: 30 seconds by default, and longer where the caller asks
 * (a permission prompt waits on the user for up to 10 minutes). Without a
 * limit, a page waiting on a prompt the user leaves open would wait forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../extension-api', () => ({
  routeExtensionApiMessage: vi.fn(() => new Promise(() => {})),
  streamLlmChat: vi.fn(),
}));
vi.mock('../../agents/background-router', () => ({
  routeAgentMessage: vi.fn(),
}));

import { harborRequest } from '../harbor-core';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('harborRequest time limits', () => {
  it('gives up after 30 seconds by default', async () => {
    const call = harborRequest('llm.chat', {});
    const outcome = expect(call).rejects.toThrow('Request timed out after 30000ms');
    await vi.advanceTimersByTimeAsync(30_000);
    await outcome;
  });

  it('waits as long as the caller asks, and no longer', async () => {
    const call = harborRequest('permissions.request', {}, { timeoutMs: 600_000 });
    let settled = false;
    call.catch(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(599_000);
    expect(settled).toBe(false);
    const outcome = expect(call).rejects.toThrow('Request timed out after 600000ms');
    await vi.advanceTimersByTimeAsync(1_000);
    await outcome;
  });

  it('applies to agent-router calls too', async () => {
    const call = harborRequest('agents.list', {});
    const outcome = expect(call).rejects.toThrow('Request timed out after 30000ms');
    await vi.advanceTimersByTimeAsync(30_000);
    await outcome;
  });
});
