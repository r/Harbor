/**
 * Example unit test using the Web Agent API mock.
 * Run with: npx vitest run example.test.mjs
 * (or copy to your test dir and use your runner)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installWebAgentsMock } from './mock.js';

describe('Web Agent API mock', () => {
  let mock;

  beforeEach(() => {
    mock = installWebAgentsMock(globalThis);
    mock.permissions.grantAll();
    mock.ai.textSessionResponse = 'Hello from mock';
    mock.agent.runOutput = 'Task completed.';
  });

  afterEach(() => {
    mock.uninstall();
  });

  it('requestPermissions returns granted when grantAll() was called', async () => {
    const result = await globalThis.agent.requestPermissions({
      scopes: ['model:prompt'],
      reason: 'Test',
    });
    expect(result.granted).toBe(true);
    expect(result.scopes['model:prompt']).toBe('granted-always');
  });

  it('createTextSession().prompt() returns configured response', async () => {
    const session = await globalThis.ai.createTextSession();
    try {
      const reply = await session.prompt('Hi');
      expect(reply).toBe('Hello from mock');
    } finally {
      await session.destroy();
    }
  });

  it('agent.run() yields final event with configured output', async () => {
    const events = [];
    for await (const e of globalThis.agent.run({ task: 'Do something' })) {
      events.push(e);
    }
    const final = events.find((e) => e.type === 'final');
    expect(final).toBeDefined();
    expect(final.output).toBe('Task completed.');
  });

  it('tools.list() returns configured tools', async () => {
    const tools = await globalThis.agent.tools.list();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools[0].name).toBe('mock-server/echo');
  });

  it('tools.call() returns configured result', async () => {
    const result = await globalThis.agent.tools.call({
      tool: 'mock-server/echo',
      args: { message: 'hi' },
    });
    expect(result).toEqual({ result: 'mock result' });
  });
});
