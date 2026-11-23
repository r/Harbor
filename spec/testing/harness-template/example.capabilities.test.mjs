/**
 * Example tests for sessions and policy refusals with the Web Agent API mock.
 * Run with: npx vitest run example.capabilities.test.mjs
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installWebAgentsMock } from './mock.js';

describe('agent.requestCapabilities() in the mock', () => {
  let mock;

  beforeEach(() => {
    mock = installWebAgentsMock(globalThis);
    mock.ai.textSessionResponse = 'Hello from a session';
  });

  afterEach(() => {
    mock.uninstall();
  });

  it('makes a session from what the site holds, leaving out optional capabilities it lacks', async () => {
    mock.permissions.grantScopes(['model:prompt']);
    const session = await globalThis.agent.requestCapabilities({
      require: [{ action: 'model.prompt.local' }],
      optional: [
        { action: 'browser.write.interact' },
        { action: 'tool.call', server: 'github', toolNames: ['create_issue'] },
      ],
      reason: 'Draft a reply',
    });
    expect(session.capabilities.llm.allowed).toBe(true);
    expect(session.capabilities.browser.interact).toBe(false);
    expect(session.listAllowedTools()).toEqual([]);
    expect(await session.prompt('Hi')).toBe('Hello from a session');
  });

  it('keeps optional capabilities the site holds', async () => {
    mock.permissions.grantScopes(['model:prompt', 'mcp:tools.call', 'browser:activeTab.interact']);
    const session = await globalThis.agent.requestCapabilities({
      require: [{ action: 'model.prompt.local' }],
      optional: [
        { action: 'browser.write.interact' },
        { action: 'tool.call', server: 'github', toolNames: ['create_issue'] },
      ],
    });
    expect(session.capabilities.browser.interact).toBe(true);
    expect(session.listAllowedTools()).toEqual(['github/create_issue']);
    await expect(session.callTool('github/delete_repo', {})).rejects.toThrow(/not allowed in this session/);
  });

  it('refuses the session when a required capability is missing', async () => {
    mock.permissions.grantScopes(['model:prompt']);
    await expect(globalThis.agent.requestCapabilities({
      require: [{ action: 'tool.call', server: 'github' }],
    })).rejects.toMatchObject({ code: 'ERR_PERMISSION_DENIED' });
  });

  it('refuses the session when a required browser capability is missing', async () => {
    await expect(globalThis.agent.requestCapabilities({
      require: [{ action: 'browser.read.activeTab' }],
    })).rejects.toMatchObject({ code: 'ERR_PERMISSION_DENIED' });
  });

  it('makes a session when the required browser capability is held', async () => {
    mock.permissions.grantScopes(['browser:activeTab.interact']);
    const session = await globalThis.agent.requestCapabilities({
      require: [{ action: 'browser.write.interact' }],
    });
    expect(session.capabilities.browser.interact).toBe(true);
  });
});

describe('policy refusals in the mock', () => {
  let mock;

  beforeEach(() => {
    mock = installWebAgentsMock(globalThis);
    mock.permissions.grantAll();
  });

  afterEach(() => {
    mock.uninstall();
  });

  it('refuses a call the way a policy rule would', async () => {
    mock.policy.refuse('ERR_BLOCKED_BY_POLICY');
    await expect(globalThis.agent.tools.call({ tool: 'mock-server/echo', args: {} }))
      .rejects.toMatchObject({ code: 'ERR_BLOCKED_BY_POLICY' });
  });

  it('quarantines the site until reset', async () => {
    mock.policy.refuse('ERR_QUARANTINED');
    const text = await globalThis.ai.createTextSession();
    await expect(text.prompt('Hi')).rejects.toMatchObject({ code: 'ERR_QUARANTINED' });
    const events = [];
    for await (const event of globalThis.agent.run({ task: 'Anything' })) events.push(event);
    expect(events).toEqual([{ type: 'error', error: expect.objectContaining({ code: 'ERR_QUARANTINED' }) }]);

    mock.policy.reset();
    expect(await text.prompt('Hi')).toBe('Mocked response');
  });
});

describe('requestCapabilities checks grants before policy, as Harbor does', () => {
  let mock;
  beforeEach(() => { mock = installWebAgentsMock(globalThis); });
  afterEach(() => { mock.uninstall(); });

  it('reports a missing grant even while policy would refuse', async () => {
    mock.policy.refuse('ERR_QUARANTINED');
    await expect(globalThis.agent.requestCapabilities({ require: [{ action: 'model.prompt.local' }] }))
      .rejects.toMatchObject({ code: 'ERR_PERMISSION_DENIED' });
  });

  it('reports the policy refusal once the grants are there', async () => {
    mock.permissions.grantScopes(['model:prompt']);
    mock.policy.refuse('ERR_QUARANTINED');
    await expect(globalThis.agent.requestCapabilities({ require: [{ action: 'model.prompt.local' }] }))
      .rejects.toMatchObject({ code: 'ERR_QUARANTINED' });
  });
});

describe('screenshots in the mock', () => {
  let mock;
  beforeEach(() => { mock = installWebAgentsMock(globalThis); });
  afterEach(() => { mock.uninstall(); });

  it('makes a screenshot session from the screenshot grant alone', async () => {
    mock.permissions.grantScopes(['browser:activeTab.screenshot']);
    const session = await globalThis.agent.requestCapabilities({ require: [{ action: 'browser.read.screenshot' }] });
    expect(session.capabilities.browser).toEqual({ readActiveTab: false, interact: false, screenshot: true });
  });
});
