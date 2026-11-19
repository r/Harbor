import { describe, it, expect, beforeEach } from 'vitest';

import { Policy, saveUserPolicy, type PolicyDocument, __testing } from '../store';
import { ruleMatches, type RuleMatchInput } from '../rules';
import { getMockStorage, resetMockBrowser } from '../../__tests__/test-setup';

const storage = getMockStorage();

beforeEach(() => {
  resetMockBrowser();
  Policy.__reset();
});

// =============================================================================
// Compilation
// =============================================================================

describe('compileDocument', () => {
  it('compiles a typed document with allow/ask/deny arrays into rules', () => {
    const doc: PolicyDocument = {
      version: 2,
      allow: ['Tool(github.list_repos)'],
      ask: ['Tool(github.create_pr)'],
      deny: ['Egress(third_party)'],
    };
    const rules = __testing.compileDocument(doc, 'user');
    // 1 from each array.
    expect(rules.length).toBe(3);
    const denies = rules.filter((r) => r.effect === 'deny');
    const asks = rules.filter((r) => r.effect === 'ask');
    const allows = rules.filter((r) => r.effect === 'allow');
    expect(denies.length).toBe(1);
    expect(asks.length).toBe(1);
    expect(allows.length).toBe(1);
  });

  it('passes through explicit typed `rules` entries', () => {
    const doc: PolicyDocument = {
      version: 2,
      rules: [
        {
          id: 'r1',
          effect: 'preview',
          principal: { origin: '*' },
          action: 'tool.call',
        },
      ],
    };
    const rules = __testing.compileDocument(doc, 'managed');
    expect(rules.length).toBe(1);
    expect(rules[0].id).toBe('r1');
    expect(rules[0].source).toBe('managed');
  });

  it('skips DSL strings it cannot parse but keeps the others', () => {
    const doc: PolicyDocument = {
      version: 2,
      allow: ['Tool(github.list_repos)', 'NotARealForm(xyz)', 'Tool(*)'],
    };
    const rules = __testing.compileDocument(doc, 'user');
    expect(rules.length).toBe(2);
  });

  it('orders rules deny → ask → preview → allow → typed', () => {
    const doc: PolicyDocument = {
      version: 2,
      allow: ['Tool(github.list_repos)'],
      ask: ['Tool(github.create_pr)'],
      deny: ['Egress(third_party)'],
      preview: ['Browser.Write(*)'],
      rules: [
        { id: 'last', effect: 'allow', principal: { origin: '*' }, action: 'tool.list' },
      ],
    };
    const rules = __testing.compileDocument(doc, 'user');
    expect(rules[0].effect).toBe('deny');
    expect(rules[1].effect).toBe('ask');
    expect(rules[2].effect).toBe('preview');
    expect(rules[3].effect).toBe('allow');
    expect(rules[4].id).toBe('last');
  });
});

// =============================================================================
// Loading + merge precedence
// =============================================================================

describe('Policy.load', () => {
  it('loads the user policy from storage', async () => {
    const doc: PolicyDocument = {
      version: 2,
      title: 'My policy',
      allow: ['Tool(github.list_repos)'],
    };
    storage.local.data['harbor_policy_v2'] = doc;
    await Policy.load();
    expect(Policy.rules().length).toBe(1);
    expect(Policy.state().user?.title).toBe('My policy');
  });

  it('ignores user policies with the wrong version', async () => {
    storage.local.data['harbor_policy_v2'] = { version: 1, allow: ['Tool(*)'] };
    await Policy.load();
    expect(Policy.rules().length).toBe(0);
  });

  it('places managed rules ahead of user rules in the merged list', async () => {
    storage.managed.data['policy'] = {
      version: 2,
      deny: ['Tool(*)'],
    } satisfies PolicyDocument;
    storage.local.data['harbor_policy_v2'] = {
      version: 2,
      allow: ['Tool(github.list_repos)'],
    } satisfies PolicyDocument;

    await Policy.load();
    const rules = Policy.rules();
    // The deny from managed must come first.
    expect(rules[0].effect).toBe('deny');
    expect(rules[0].source).toBe('managed');
    expect(rules[1].source).toBe('user');
  });

});

// =============================================================================
// End-to-end: rules from a stored document match real requests
// =============================================================================

describe('End-to-end: stored document → matched rule', () => {
  it('a `deny` rule from managed storage blocks a matching request', async () => {
    storage.managed.data['policy'] = {
      version: 2,
      deny: ['Egress(third_party)'],
    } satisfies PolicyDocument;
    await Policy.load();

    const input: RuleMatchInput = {
      principal: { origin: 'https://example.com' },
      action: 'model.prompt.remote.thirdParty',
      context: { destinationLocality: 'network_third_party' },
    };
    const matched = Policy.rules().find((r) => ruleMatches(r, input));
    expect(matched?.effect).toBe('deny');
  });

  it('an `allow` rule for a specific tool overrides the default', async () => {
    storage.local.data['harbor_policy_v2'] = {
      version: 2,
      allow: ['Tool(github.list_repos)'],
    } satisfies PolicyDocument;
    await Policy.load();

    const input: RuleMatchInput = {
      principal: { origin: 'https://example.com' },
      action: 'tool.call',
      resource: { server: 'github', tool: 'list_repos' },
    };
    const matched = Policy.rules().find((r) => ruleMatches(r, input));
    expect(matched?.effect).toBe('allow');
  });
});

// =============================================================================
// saveUserPolicy
// =============================================================================

describe('saveUserPolicy', () => {
  it('refuses to save a wrong-version document', async () => {
    await expect(saveUserPolicy({ version: 1 } as unknown as PolicyDocument)).rejects.toThrow(
      /version/i,
    );
  });

  it('round-trips a valid document through storage', async () => {
    const doc: PolicyDocument = {
      version: 2,
      allow: ['Tool(github.list_repos)'],
    };
    await saveUserPolicy(doc);
    expect(storage.local.data['harbor_policy_v2']).toEqual(doc);
  });
});

// =============================================================================
// Subscriptions
// =============================================================================

describe('Policy.subscribe', () => {
  it('fires listeners on load', async () => {
    storage.local.data['harbor_policy_v2'] = { version: 2, allow: ['Tool(*)'] } satisfies PolicyDocument;
    let fired = 0;
    Policy.subscribe(() => fired++);
    await Policy.load();
    expect(fired).toBe(1);
    await Policy.load();
    expect(fired).toBe(2);
  });
});
