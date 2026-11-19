import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { lookupOriginGrant, __testing } from '../origin-grants';
import { getMockStorage, resetMockBrowser } from '../../__tests__/test-setup';
import { writeAgentBackendSetting } from '../../page-api/agent-backend-setting';

const storage = getMockStorage();

beforeEach(() => {
  resetMockBrowser();
});

function seedGrant(
  origin: string,
  scope: string,
  grant: 'granted-always' | 'granted-once' | 'denied',
  options: {
    expiresAt?: number;
    allowedTools?: string[];
    tabId?: number;
    backend?: string;
    allows?: Record<string, { grant: 'granted-once' | 'granted-always'; grantedAt: number }>;
  } = {},
) {
  const all =
    (storage.local.data[__testing.PERMISSIONS_STORAGE_KEY] as Record<string, unknown>) ?? {};
  const existing = (all[origin] as { scopes: Record<string, unknown>; allowedTools: string[] }) ?? {
    origin,
    scopes: {},
    allowedTools: options.allowedTools ?? [],
  };
  existing.scopes[scope] = {
    grant,
    grantedAt: Date.now(),
    ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
    ...(options.tabId !== undefined ? { tabId: options.tabId } : {}),
    ...(options.backend !== undefined ? { backend: options.backend } : {}),
    ...(options.allows !== undefined ? { allows: options.allows } : {}),
  };
  if (options.allowedTools) existing.allowedTools = options.allowedTools;
  storage.local.data[__testing.PERMISSIONS_STORAGE_KEY] = { ...all, [origin]: existing };
}

describe('lookupOriginGrant', () => {
  it('returns null when nothing is stored', async () => {
    const result = await lookupOriginGrant('https://example.com', 'tool.list');
    expect(result).toBeNull();
  });

  it('maps tool.list to mcp:tools.list and reports allow', async () => {
    seedGrant('https://example.com', 'mcp:tools.list', 'granted-always');
    const result = await lookupOriginGrant('https://example.com', 'tool.list');
    expect(result?.effect).toBe('allow');
    expect(result?.persistence).toBe('always');
  });

  it('reports deny when the legacy scope is denied', async () => {
    seedGrant('https://example.com', 'mcp:tools.list', 'denied');
    const result = await lookupOriginGrant('https://example.com', 'tool.list');
    expect(result?.effect).toBe('deny');
  });

  it('treats expired granted-once as no opinion', async () => {
    seedGrant('https://example.com', 'mcp:tools.list', 'granted-once', { expiresAt: Date.now() - 1 });
    const result = await lookupOriginGrant('https://example.com', 'tool.list');
    expect(result).toBeNull();
  });

  it('returns once-persistence for live granted-once', async () => {
    seedGrant('https://example.com', 'mcp:tools.list', 'granted-once', {
      expiresAt: Date.now() + 60_000,
    });
    const result = await lookupOriginGrant('https://example.com', 'tool.list');
    expect(result?.effect).toBe('allow');
    expect(result?.persistence).toBe('once');
  });

  // "Allow once" is stored for the tab that granted it, as in
  // permissions.ts isGrantValid. Another tab on the origin doesn't inherit it.
  describe('granted-once is scoped to its tab', () => {
    const later = () => Date.now() + 60_000;

    it('covers the tab that granted it', async () => {
      seedGrant('https://example.com', 'agents:invoke', 'granted-once', { expiresAt: later(), tabId: 9 });
      const result = await lookupOriginGrant('https://example.com', 'agent.invoke', undefined, 9);
      expect(result?.effect).toBe('allow');
    });

    it('is no opinion for a different tab', async () => {
      seedGrant('https://example.com', 'agents:invoke', 'granted-once', { expiresAt: later(), tabId: 9 });
      const result = await lookupOriginGrant('https://example.com', 'agent.invoke', undefined, 10);
      expect(result).toBeNull();
    });

    it('still applies when the caller has no tab', async () => {
      seedGrant('https://example.com', 'agents:invoke', 'granted-once', { expiresAt: later(), tabId: 9 });
      const result = await lookupOriginGrant('https://example.com', 'agent.invoke');
      expect(result?.effect).toBe('allow');
    });

    it('does not limit granted-always to a tab', async () => {
      seedGrant('https://example.com', 'agents:invoke', 'granted-always', { tabId: 9 });
      const result = await lookupOriginGrant('https://example.com', 'agent.invoke', undefined, 10);
      expect(result?.effect).toBe('allow');
    });
  });

  it('falls back to null for unknown actions (no mapping)', async () => {
    const result = await lookupOriginGrant('https://example.com', 'something.unknown' as never);
    expect(result).toBeNull();
  });

  describe('tool.call gating', () => {
    it('requires the tool to be in the allowlist', async () => {
      seedGrant('https://example.com', 'mcp:tools.call', 'granted-always', {
        allowedTools: ['github.list_repos'],
      });
      const allowed = await lookupOriginGrant('https://example.com', 'tool.call', {
        tool: 'github.list_repos',
      });
      expect(allowed?.effect).toBe('allow');

      const blocked = await lookupOriginGrant('https://example.com', 'tool.call', {
        tool: 'github.create_pr',
      });
      expect(blocked).toBeNull();
    });

    it('surfaces an explicit deny on mcp:tools.call regardless of allowlist', async () => {
      seedGrant('https://example.com', 'mcp:tools.call', 'denied', {
        allowedTools: [],
      });
      const result = await lookupOriginGrant('https://example.com', 'tool.call', {
        tool: 'github.list_repos',
      });
      expect(result?.effect).toBe('deny');
    });

    it('returns no opinion when no resource.tool is specified', async () => {
      seedGrant('https://example.com', 'mcp:tools.call', 'granted-always', {
        allowedTools: ['github.list_repos'],
      });
      const result = await lookupOriginGrant('https://example.com', 'tool.call');
      // The legacy semantics requires a tool name; absent one we give no
      // opinion (engine falls through to default).
      expect(result?.effect).toBe('allow');
    });
  });

  describe('typed-to-legacy mapping', () => {
    it('exposes the mapping for diagnostic use', () => {
      const map = __testing.TYPED_TO_LEGACY;
      expect(map['model.list']).toEqual(['model:list']);
      expect(map['browser.read.activeTab']).toEqual(['browser:activeTab.read']);
      expect(map['network.egress.cross_origin']).toEqual(['web:fetch']);
      expect(map['model.prompt.agent']).toEqual(['model:prompt']);
    });

    it('maps model.prompt.agent to model:prompt and reports allow', async () => {
      seedGrant('https://example.com', 'model:prompt', 'granted-always', { backend: 'builtin' });
      const result = await lookupOriginGrant('https://example.com', 'model.prompt.agent');
      expect(result?.effect).toBe('allow');
    });
  });

  describe('backend-scoped grants (model:prompt/model:tools; policy/backend-grant.ts)', () => {
    afterEach(async () => {
      await writeAgentBackendSetting(null);
    });

    it('a model:prompt grant recorded for builtin gives no opinion once an ACP agent is selected', async () => {
      seedGrant('https://example.com', 'model:prompt', 'granted-always', { backend: 'builtin' });
      await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });
      const result = await lookupOriginGrant('https://example.com', 'model.prompt.agent');
      expect(result).toBeNull();
    });

    it('a model:tools grant recorded for one agent gives no opinion for a different one', async () => {
      seedGrant('https://example.com', 'model:tools', 'granted-always', { backend: 'acp:goose' });
      await writeAgentBackendSetting({ type: 'acp', agentId: 'codex' });
      const result = await lookupOriginGrant('https://example.com', 'agent.run');
      expect(result).toBeNull();
    });

    it('counts again once the recorded backend is reselected', async () => {
      seedGrant('https://example.com', 'model:prompt', 'granted-always', { backend: 'acp:goose' });
      await writeAgentBackendSetting({ type: 'acp', agentId: 'codex' });
      expect(await lookupOriginGrant('https://example.com', 'model.prompt.agent')).toBeNull();
      await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });
      expect((await lookupOriginGrant('https://example.com', 'model.prompt.agent'))?.effect).toBe('allow');
    });

    it('a stored entry with no backend field counts as builtin', async () => {
      seedGrant('https://example.com', 'model:prompt', 'granted-always'); // no backend option
      expect((await lookupOriginGrant('https://example.com', 'model.prompt.agent'))?.effect).toBe('allow');
      await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });
      expect(await lookupOriginGrant('https://example.com', 'model.prompt.agent')).toBeNull();
    });

    // Maintainer decision, 2026-11-19: a deny is universal (applies under
    // every backend); only allows are per-backend.
    it('a deny applies under every backend, not just the one selected when it was made', async () => {
      seedGrant('https://example.com', 'model:prompt', 'denied', { backend: 'builtin' });
      await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });
      const result = await lookupOriginGrant('https://example.com', 'model.prompt.agent');
      expect(result).toEqual({ effect: 'deny' });
    });

    it('allow under builtin, then allow under goose (both recorded in the allows map): both still count after switching back and forth', async () => {
      seedGrant('https://example.com', 'model:prompt', 'granted-always', {
        allows: {
          builtin: { grant: 'granted-always', grantedAt: Date.now() },
          'acp:goose': { grant: 'granted-always', grantedAt: Date.now() },
        },
      });
      expect((await lookupOriginGrant('https://example.com', 'model.prompt.agent'))?.effect).toBe('allow');
      await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });
      expect((await lookupOriginGrant('https://example.com', 'model.prompt.agent'))?.effect).toBe('allow');
      await writeAgentBackendSetting(null);
      expect((await lookupOriginGrant('https://example.com', 'model.prompt.agent'))?.effect).toBe('allow');
    });

    it('a deny after per-backend allows means denied everywhere, including a backend that had an allow', async () => {
      seedGrant('https://example.com', 'model:prompt', 'denied', {
        allows: { builtin: { grant: 'granted-always', grantedAt: Date.now() } },
      });
      expect((await lookupOriginGrant('https://example.com', 'model.prompt.agent'))?.effect).toBe('deny');
      await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });
      expect((await lookupOriginGrant('https://example.com', 'model.prompt.agent'))?.effect).toBe('deny');
    });

    it('a scope outside model:prompt/model:tools is unaffected by the selected backend', async () => {
      seedGrant('https://example.com', 'mcp:tools.list', 'granted-always', { backend: 'builtin' });
      await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });
      const result = await lookupOriginGrant('https://example.com', 'tool.list');
      expect(result?.effect).toBe('allow');
    });
  });
});
