import { describe, it, expect } from 'vitest';

import {
  type Rule,
  type RuleMatchInput,
  compileRule,
  ruleMatches,
  findFirstMatchingRule,
  globToRegExp,
  parseDSLString,
} from '../rules';

function compile(rule: Rule) {
  return compileRule(rule);
}

const githubInput: RuleMatchInput = {
  principal: { origin: 'https://github.com' },
  action: 'tool.call',
  resource: {
    server: 'github',
    tool: 'create_pr',
    toolTags: ['remote_write'],
    host: 'api.github.com',
  },
  context: {
    destinationLocality: 'cross_origin',
    reversible: false,
    trustedManifest: true,
  },
};

describe('globToRegExp', () => {
  it('matches "*" against everything', () => {
    expect(globToRegExp('*').test('anything')).toBe(true);
    expect(globToRegExp('*').test('')).toBe(true);
  });

  it('respects suffix wildcards like *.github.com', () => {
    const re = globToRegExp('*.github.com');
    expect(re.test('api.github.com')).toBe(true);
    expect(re.test('foo.github.com')).toBe(true);
    expect(re.test('github.com')).toBe(false);
    expect(re.test('githubXcom')).toBe(false);
  });

  it('escapes regex metacharacters that are not "*"', () => {
    const re = globToRegExp('a.b+c');
    expect(re.test('a.b+c')).toBe(true);
    expect(re.test('aXbXc')).toBe(false);
  });
});

describe('Action selectors', () => {
  it('a literal typed-action string matches that action only', () => {
    const rule = compile({ id: 'r1', effect: 'allow', principal: { origin: '*' }, action: 'tool.call' });
    expect(rule.matchesAction('tool.call')).toBe(true);
    expect(rule.matchesAction('tool.list')).toBe(false);
  });

  it('an array selector matches any action in it', () => {
    const rule = compile({
      id: 'r1',
      effect: 'allow',
      principal: { origin: '*' },
      action: ['tool.list', 'tool.call'],
    });
    expect(rule.matchesAction('tool.list')).toBe(true);
    expect(rule.matchesAction('tool.call')).toBe(true);
    expect(rule.matchesAction('model.list')).toBe(false);
  });

  it('a glob selector matches by pattern', () => {
    const rule = compile({
      id: 'r1',
      effect: 'allow',
      principal: { origin: '*' },
      action: 'browser.read.*',
    });
    expect(rule.matchesAction('browser.read.activeTab')).toBe(true);
    expect(rule.matchesAction('browser.read.tabs')).toBe(true);
    expect(rule.matchesAction('browser.write.interact')).toBe(false);
  });

  it('an effect-class selector matches every action with that effect', () => {
    const rule = compile({
      id: 'r1',
      effect: 'ask',
      principal: { origin: '*' },
      action: { effect: 'egress' },
    });
    expect(rule.matchesAction('network.egress.cross_origin')).toBe(true);
    expect(rule.matchesAction('model.prompt.remote.thirdParty')).toBe(true);
    expect(rule.matchesAction('browser.read.activeTab')).toBe(false);
  });

  it('an unknown literal action selector never matches', () => {
    const rule = compile({
      id: 'r1',
      effect: 'allow',
      principal: { origin: '*' },
      action: 'something.fake',
    });
    expect(rule.matchesAction('tool.call')).toBe(false);
  });
});

describe('Rule matching', () => {
  it('matches when principal, action, and resource align', () => {
    const rule = compile({
      id: 'preview-github-writes',
      effect: 'preview',
      principal: { origin: 'https://github.com' },
      action: 'tool.call',
      resource: { server: 'github', toolTags: ['remote_write'] },
    });
    expect(ruleMatches(rule, githubInput)).toBe(true);
  });

  it('rejects when origin does not match', () => {
    const rule = compile({
      id: 'r1',
      effect: 'allow',
      principal: { origin: 'https://example.com' },
      action: 'tool.call',
    });
    expect(ruleMatches(rule, githubInput)).toBe(false);
  });

  it('respects suffix wildcards on origin', () => {
    const rule = compile({
      id: 'r1',
      effect: 'allow',
      principal: { origin: 'https://*.github.com' },
      action: 'tool.call',
    });
    expect(
      ruleMatches(rule, {
        ...githubInput,
        principal: { origin: 'https://api.github.com' },
      }),
    ).toBe(true);
  });

  it('rejects when toolTags do not overlap', () => {
    const rule = compile({
      id: 'r1',
      effect: 'preview',
      principal: { origin: '*' },
      action: 'tool.call',
      resource: { toolTags: ['destructive_write'] },
    });
    expect(ruleMatches(rule, githubInput)).toBe(false);
  });

  it('hasAnyLabel matches if at least one label is present on the input', () => {
    const rule = compile({
      id: 'sensitive-egress',
      effect: 'deny',
      principal: { origin: '*' },
      action: { effect: 'egress' },
      context: { hasAnyLabel: ['credentials', 'payments'] },
    });
    const labeled: RuleMatchInput = {
      principal: { origin: 'https://example.com' },
      action: 'network.egress.cross_origin',
      context: {
        labels: ['credentials'],
        destinationLocality: 'cross_origin',
      },
    };
    expect(ruleMatches(rule, labeled)).toBe(true);

    const unlabeled: RuleMatchInput = {
      ...labeled,
      context: { ...labeled.context, labels: [] },
    };
    expect(ruleMatches(rule, unlabeled)).toBe(false);
  });

  it('hasAllLabels requires every label to be present', () => {
    const rule = compile({
      id: 'r1',
      effect: 'deny',
      principal: { origin: '*' },
      action: { effect: 'egress' },
      context: { hasAllLabels: ['credentials', 'identity'] },
    });
    const partial: RuleMatchInput = {
      principal: { origin: 'https://example.com' },
      action: 'network.egress.cross_origin',
      context: { labels: ['credentials'] },
    };
    expect(ruleMatches(rule, partial)).toBe(false);

    const full: RuleMatchInput = {
      ...partial,
      context: { labels: ['credentials', 'identity'] },
    };
    expect(ruleMatches(rule, full)).toBe(true);
  });

  it('subagent flag distinguishes principals', () => {
    const rule = compile({
      id: 'no-subagent-writes',
      effect: 'deny',
      principal: { origin: '*', isSubagent: true },
      action: { effect: 'write' },
    });
    expect(ruleMatches(rule, githubInput)).toBe(false);
    expect(
      ruleMatches(rule, {
        ...githubInput,
        principal: { ...githubInput.principal, isSubagent: true },
        action: 'browser.write.interact',
      }),
    ).toBe(true);
  });

  it('a stored rule scoped to a removed session mode keeps its old reach', () => {
    // Every request used to run as 'execute'. A rule scoped to 'plan' or
    // 'watch' never matched one, and must not start matching everything.
    const legacy = (mode: string) =>
      compile({
        id: `legacy-${mode}`,
        effect: 'allow',
        principal: { origin: '*' },
        action: 'tool.call',
        context: { mode } as unknown as Rule['context'],
      });
    expect(ruleMatches(legacy('plan'), githubInput)).toBe(false);
    expect(ruleMatches(legacy('watch'), githubInput)).toBe(false);
    expect(ruleMatches(legacy('execute'), githubInput)).toBe(true);
  });
});

describe('findFirstMatchingRule', () => {
  it('returns the first matching rule by order', () => {
    const r1 = compile({ id: 'a', effect: 'deny', principal: { origin: '*' }, action: 'tool.call' });
    const r2 = compile({ id: 'b', effect: 'allow', principal: { origin: '*' }, action: 'tool.call' });
    const found = findFirstMatchingRule([r1, r2], githubInput);
    expect(found?.id).toBe('a');
  });

  it('returns null when nothing matches', () => {
    const r1 = compile({
      id: 'a',
      effect: 'deny',
      principal: { origin: 'https://other.com' },
      action: 'tool.call',
    });
    expect(findFirstMatchingRule([r1], githubInput)).toBeNull();
  });
});

describe('String DSL parser', () => {
  it('Tool(server.tool) compiles to a tool.call rule on that server/tool', () => {
    const rule = parseDSLString('Tool(github.create_pr)', 'preview', 'r1');
    expect(rule).not.toBeNull();
    expect(rule!.action).toBe('tool.call');
    expect(rule!.resource?.server).toBe('github');
    expect(rule!.resource?.tool).toBe('create_pr');
    expect(rule!.effect).toBe('preview');
  });

  it('Tool(*) compiles to any tool.call', () => {
    const rule = parseDSLString('Tool(*)', 'allow', 'r2');
    expect(rule).not.toBeNull();
    expect(rule!.action).toBe('tool.call');
    expect(rule!.resource).toBeUndefined();
  });

  it('Tool(*:remote_write) tags-based selector', () => {
    const rule = parseDSLString('Tool(*:remote_write)', 'preview', 'r3');
    expect(rule).not.toBeNull();
    expect(rule!.action).toBe('tool.call');
    expect(rule!.resource?.toolTags).toEqual(['remote_write']);
  });

  it('Egress(cross_origin) compiles to an egress effect rule with locality', () => {
    const rule = parseDSLString('Egress(cross_origin)', 'ask', 'r4');
    expect(rule).not.toBeNull();
    expect(typeof rule!.action).toBe('object');
    expect(rule!.context?.destinationLocality).toEqual(['cross_origin']);
  });

  it('Prompt(local) compiles to model.prompt.local', () => {
    const rule = parseDSLString('Prompt(local)', 'allow', 'r5');
    expect(rule).not.toBeNull();
    expect(rule!.action).toBe('model.prompt.local');
  });

  // A person's "deny every prompt" rule (Prompt(*), or any unrecognized
  // Prompt(...) argument) must cover model.prompt.agent too — otherwise a
  // blanket deny-all-prompts rule would silently exempt prompts sent to
  // their own ACP agent.
  it('Prompt(*) covers model.prompt.agent along with the three model-call actions', () => {
    const rule = parseDSLString('Prompt(*)', 'deny', 'r6');
    expect(rule).not.toBeNull();
    expect(rule!.action).toEqual([
      'model.prompt.local',
      'model.prompt.remote.firstParty',
      'model.prompt.remote.thirdParty',
      'model.prompt.agent',
    ]);
  });

  it('a deny-all-prompts rule actually denies a prompt sent to the agent', async () => {
    const { evaluate } = await import('../engine');
    const { Policy } = await import('../store');
    Policy.__setForTesting([compileRule({ ...(parseDSLString('Prompt(*)', 'deny', 'r7') as Rule), source: 'user' })]);
    const decision = await evaluate({ origin: 'https://example.com', action: 'model.prompt.agent' });
    expect(decision.effect).toBe('deny');
    Policy.__reset();
  });

  it('returns null for unrecognized DSL', () => {
    expect(parseDSLString('Whatever(x)', 'allow', 'r')).toBeNull();
    expect(parseDSLString('not even close', 'allow', 'r')).toBeNull();
  });

  it('compiles and matches end-to-end', () => {
    const rule = parseDSLString('Tool(github.create_pr)', 'preview', 'tg');
    expect(rule).not.toBeNull();
    const compiled = compile(rule!);
    expect(ruleMatches(compiled, githubInput)).toBe(true);
  });
});
