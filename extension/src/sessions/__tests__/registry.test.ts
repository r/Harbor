/**
 * Session Registry tests
 *
 * Covers the integration between sessions and capability tokens: every
 * session created by the registry must mint a token; every termination
 * must revoke it; subagent delegation must always strictly attenuate the
 * parent.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SessionRegistry } from '../registry';
import { Tokens } from '../../policy/tokens';

describe('SessionRegistry', () => {
  beforeEach(() => {
    // The registry is a singleton; reset by destroying everything we've
    // created in prior tests. We can't reach into private state here, so
    // each test uses an origin namespaced to its name.
    Tokens.__reset();
  });

  describe('createImplicitSession', () => {
    it('mints a capability token bound to the session', () => {
      const session = SessionRegistry.createImplicitSession('https://impl.example');
      expect(session.tokenId).toBeDefined();

      const token = Tokens.get(session.tokenId!);
      expect(token).toBeDefined();
      expect(token!.sessionId).toBe(session.sessionId);
      expect(token!.origin).toBe('https://impl.example');
      expect(token!.allowedActions.has('model.prompt.local')).toBe(true);
      // Implicit sessions don't get tools or browser by default.
      expect(token!.allowedActions.has('tool.call')).toBe(false);
      expect(token!.allowedActions.has('browser.read.activeTab')).toBe(false);
    });

    it('binds same-origin egress and remote first-party LLM as baseline', () => {
      const session = SessionRegistry.createImplicitSession('https://baseline.example');
      const token = Tokens.get(session.tokenId!)!;
      expect(token.allowedActions.has('network.egress.same_origin')).toBe(true);
      expect(token.allowedActions.has('model.prompt.remote.firstParty')).toBe(true);
      // Cross-origin egress is never auto-granted; it always goes through policy.
      expect(token.allowedActions.has('network.egress.cross_origin')).toBe(false);
    });
  });

  describe('createExplicitSession', () => {
    it('mints a token reflecting the requested capabilities', () => {
      const result = SessionRegistry.createExplicitSession(
        'https://explicit.example',
        {
          name: 'Test agent',
          capabilities: {
            llm: { provider: 'openai', model: 'gpt-4' },
            tools: ['fs/read', 'fs/write'],
            browser: ['read', 'screenshot'],
          },
          limits: { maxToolCalls: 10, ttlMinutes: 5 },
        },
        ['fs/read', 'fs/write'],
      );

      expect(result.success).toBe(true);
      const session = SessionRegistry.getSession(result.sessionId!)!;
      const token = Tokens.get(session.tokenId!)!;

      expect(token.allowedActions.has('model.prompt.local')).toBe(true);
      expect(token.allowedActions.has('model.prompt.remote.firstParty')).toBe(true);
      expect(token.allowedActions.has('tool.call')).toBe(true);
      expect(token.allowedActions.has('tool.list')).toBe(true);
      expect(token.allowedActions.has('browser.read.activeTab')).toBe(true);
      expect(token.allowedActions.has('browser.read.screenshot')).toBe(true);
      expect(token.allowedActions.has('browser.write.interact')).toBe(false);

      expect(token.budgets.toolCalls).toBe(10);
      // TTL was 5 minutes => wallClockMs ≤ 5 * 60 * 1000.
      expect(token.budgets.wallClockMs).toBeDefined();
      expect(token.budgets.wallClockMs!).toBeLessThanOrEqual(5 * 60 * 1000);
    });

    it('accepts the identity label, unlike implicit sessions', () => {
      const explicitResult = SessionRegistry.createExplicitSession(
        'https://explicit-labels.example',
        { capabilities: { browser: ['read'] } },
      );
      const implicitSession = SessionRegistry.createImplicitSession('https://implicit-labels.example');

      const explicitToken = Tokens.get(SessionRegistry.getSession(explicitResult.sessionId!)!.tokenId!)!;
      const implicitToken = Tokens.get(implicitSession.tokenId!)!;

      expect(implicitToken.acceptedLabels.has('identity')).toBe(false);
      expect(explicitToken.acceptedLabels.has('identity')).toBe(true);
    });
  });

  describe('attenuateForSubagent', () => {
    it('mints a strictly-narrower child token', () => {
      const parent = SessionRegistry.createExplicitSession(
        'https://parent.example',
        {
          capabilities: {
            llm: { provider: 'openai' },
            tools: ['fs/read'],
            browser: ['read'],
          },
          limits: { maxToolCalls: 100, ttlMinutes: 10 },
        },
        ['fs/read'],
      );

      const childId = crypto.randomUUID();
      const child = SessionRegistry.attenuateForSubagent(
        parent.sessionId!,
        'https://parent.example',
        childId,
        {
          allowedActions: ['tool.call', 'tool.list'],
          maxToolCalls: 5,
        },
      );

      expect(child).not.toBeNull();
      expect(child!.sessionId).toBe(childId);
      expect(child!.parentId).toBeDefined();
      expect(child!.allowedActions.has('browser.read.activeTab')).toBe(false);
      expect(child!.budgets.toolCalls).toBe(5);
    });

    it('returns null on widening request', () => {
      const parent = SessionRegistry.createExplicitSession(
        'https://parent2.example',
        { capabilities: { browser: ['read'] } },
      );
      const child = SessionRegistry.attenuateForSubagent(
        parent.sessionId!,
        'https://parent2.example',
        crypto.randomUUID(),
        // Try to escalate beyond what the parent allows — must be refused.
        { allowedActions: ['tool.call'] },
      );
      expect(child).toBeNull();
    });
  });

  describe('terminateSession / destroySession', () => {
    it('revokes the capability token on terminate', () => {
      const session = SessionRegistry.createImplicitSession('https://term.example');
      const tokenId = session.tokenId!;
      expect(Tokens.get(tokenId)!.revoked).toBe(false);

      SessionRegistry.terminateSession(session.sessionId, 'https://term.example');
      expect(Tokens.get(tokenId)!.revoked).toBe(true);
    });

    it('revokes the capability token on destroy', () => {
      const session = SessionRegistry.createImplicitSession('https://destroy.example');
      const tokenId = session.tokenId!;
      SessionRegistry.destroySession(session.sessionId, 'https://destroy.example');
      // After destroy the token is still in the registry but revoked.
      expect(Tokens.get(tokenId)?.revoked ?? true).toBe(true);
    });
  });
});
