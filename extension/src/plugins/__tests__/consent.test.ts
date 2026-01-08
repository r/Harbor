/**
 * Plugin Consent Tests
 *
 * Tests for plugin tool permission management.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { __mockStorage, __clearMockStorage } from '../../provider/__tests__/__mocks__/webextension-polyfill';
import {
  hasPluginToolPermission,
  hasAnyPluginPermission,
  getAllowedPluginTools,
  getPluginConsentStatus,
  grantPluginPermission,
  revokePluginPermissions,
  clearPluginTabGrants,
  checkPluginConsent,
  getAllPluginPermissions,
  __clearTemporaryGrants,
  __getTemporaryGrants,
} from '../consent';

describe('Plugin Consent', () => {
  const TEST_ORIGIN = 'https://example.com';
  const TEST_TOOL = 'test-plugin@example.com::echo';

  beforeEach(() => {
    __clearMockStorage();
    __clearTemporaryGrants();
  });

  describe('hasPluginToolPermission', () => {
    it('should return false when no permission granted', async () => {
      const result = await hasPluginToolPermission(TEST_ORIGIN, TEST_TOOL);
      expect(result).toBe(false);
    });

    it('should return true when specific tool is allowed', async () => {
      await grantPluginPermission(TEST_ORIGIN, {
        mode: 'always',
        tools: [TEST_TOOL],
      });

      const result = await hasPluginToolPermission(TEST_ORIGIN, TEST_TOOL);
      expect(result).toBe(true);
    });

    it('should return true when allowAll is granted', async () => {
      await grantPluginPermission(TEST_ORIGIN, {
        mode: 'always',
        allowAll: true,
      });

      const result = await hasPluginToolPermission(TEST_ORIGIN, TEST_TOOL);
      expect(result).toBe(true);
    });

    it('should return false for non-allowed tool', async () => {
      await grantPluginPermission(TEST_ORIGIN, {
        mode: 'always',
        tools: ['other-plugin@example.com::other'],
      });

      const result = await hasPluginToolPermission(TEST_ORIGIN, TEST_TOOL);
      expect(result).toBe(false);
    });

    it('should return true for extension origin', async () => {
      const result = await hasPluginToolPermission('extension', TEST_TOOL);
      expect(result).toBe(true);
    });
  });

  describe('hasAnyPluginPermission', () => {
    it('should return false when no permissions exist', async () => {
      const result = await hasAnyPluginPermission(TEST_ORIGIN);
      expect(result).toBe(false);
    });

    it('should return true when allowAll is granted', async () => {
      await grantPluginPermission(TEST_ORIGIN, {
        mode: 'always',
        allowAll: true,
      });

      const result = await hasAnyPluginPermission(TEST_ORIGIN);
      expect(result).toBe(true);
    });

    it('should return true when specific tools are allowed', async () => {
      await grantPluginPermission(TEST_ORIGIN, {
        mode: 'always',
        tools: [TEST_TOOL],
      });

      const result = await hasAnyPluginPermission(TEST_ORIGIN);
      expect(result).toBe(true);
    });

    it('should return true for extension origin', async () => {
      const result = await hasAnyPluginPermission('extension');
      expect(result).toBe(true);
    });
  });

  describe('getAllowedPluginTools', () => {
    it('should return empty tools when no permissions', async () => {
      const result = await getAllowedPluginTools(TEST_ORIGIN);
      expect(result.allowAll).toBe(false);
      expect(result.tools).toEqual([]);
    });

    it('should return allowAll: true when granted', async () => {
      await grantPluginPermission(TEST_ORIGIN, {
        mode: 'always',
        allowAll: true,
      });

      const result = await getAllowedPluginTools(TEST_ORIGIN);
      expect(result.allowAll).toBe(true);
    });

    it('should return specific tools when granted', async () => {
      await grantPluginPermission(TEST_ORIGIN, {
        mode: 'always',
        tools: [TEST_TOOL, 'other-tool'],
      });

      const result = await getAllowedPluginTools(TEST_ORIGIN);
      expect(result.allowAll).toBe(false);
      expect(result.tools).toContain(TEST_TOOL);
      expect(result.tools).toContain('other-tool');
    });

    it('should merge temporary and persistent grants', async () => {
      await grantPluginPermission(TEST_ORIGIN, {
        mode: 'always',
        tools: ['tool1'],
      });
      await grantPluginPermission(TEST_ORIGIN, {
        mode: 'once',
        tools: ['tool2'],
      });

      const result = await getAllowedPluginTools(TEST_ORIGIN);
      expect(result.tools).toContain('tool1');
      expect(result.tools).toContain('tool2');
    });
  });

  describe('getPluginConsentStatus', () => {
    it('should return no consent for new origin', async () => {
      const status = await getPluginConsentStatus(TEST_ORIGIN);

      expect(status.hasConsent).toBe(false);
      expect(status.allowAll).toBe(false);
      expect(status.allowedTools).toEqual([]);
      expect(status.grantType).toBe('none');
    });

    it('should return consent status for persistent grant', async () => {
      await grantPluginPermission(TEST_ORIGIN, {
        mode: 'always',
        tools: [TEST_TOOL],
      });

      const status = await getPluginConsentStatus(TEST_ORIGIN);

      expect(status.hasConsent).toBe(true);
      expect(status.grantType).toBe('always');
      expect(status.allowedTools).toContain(TEST_TOOL);
    });

    it('should return consent status for temporary grant', async () => {
      await grantPluginPermission(TEST_ORIGIN, {
        mode: 'once',
        allowAll: true,
      });

      const status = await getPluginConsentStatus(TEST_ORIGIN);

      expect(status.hasConsent).toBe(true);
      expect(status.grantType).toBe('once');
      expect(status.allowAll).toBe(true);
    });

    it('should prioritize temporary grants over persistent', async () => {
      await grantPluginPermission(TEST_ORIGIN, {
        mode: 'always',
        tools: ['persistent-tool'],
      });
      await grantPluginPermission(TEST_ORIGIN, {
        mode: 'once',
        tools: ['temp-tool'],
      });

      const status = await getPluginConsentStatus(TEST_ORIGIN);
      expect(status.grantType).toBe('once');
    });
  });

  describe('grantPluginPermission', () => {
    describe('mode: always', () => {
      it('should persist permission to storage', async () => {
        await grantPluginPermission(TEST_ORIGIN, {
          mode: 'always',
          tools: [TEST_TOOL],
        });

        // Verify it persisted
        const stored = __mockStorage['harbor_plugin_permissions'] as any;
        expect(stored.permissions[TEST_ORIGIN]).toBeDefined();
        expect(stored.permissions[TEST_ORIGIN].allowedTools).toContain(TEST_TOOL);
      });

      it('should merge with existing permissions', async () => {
        await grantPluginPermission(TEST_ORIGIN, {
          mode: 'always',
          tools: ['tool1'],
        });
        await grantPluginPermission(TEST_ORIGIN, {
          mode: 'always',
          tools: ['tool2'],
        });

        const result = await getAllowedPluginTools(TEST_ORIGIN);
        expect(result.tools).toContain('tool1');
        expect(result.tools).toContain('tool2');
      });
    });

    describe('mode: once', () => {
      it('should store in temporary grants', async () => {
        await grantPluginPermission(TEST_ORIGIN, {
          mode: 'once',
          tools: [TEST_TOOL],
        });

        const tempGrants = __getTemporaryGrants();
        const grant = tempGrants.get(`plugin-temp:${TEST_ORIGIN}`);
        expect(grant).toBeDefined();
        expect(grant?.allowedTools).toContain(TEST_TOOL);
      });

      it('should set expiry time', async () => {
        const before = Date.now();
        await grantPluginPermission(TEST_ORIGIN, {
          mode: 'once',
          tools: [TEST_TOOL],
        });
        const after = Date.now();

        const tempGrants = __getTemporaryGrants();
        const grant = tempGrants.get(`plugin-temp:${TEST_ORIGIN}`);

        // Should expire in ~10 minutes
        const TTL = 10 * 60 * 1000;
        expect(grant?.expiresAt).toBeGreaterThanOrEqual(before + TTL);
        expect(grant?.expiresAt).toBeLessThanOrEqual(after + TTL + 100);
      });

      it('should store tabId when provided', async () => {
        const TAB_ID = 12345;
        await grantPluginPermission(TEST_ORIGIN, {
          mode: 'once',
          tools: [TEST_TOOL],
          tabId: TAB_ID,
        });

        const tempGrants = __getTemporaryGrants();
        const grant = tempGrants.get(`plugin-temp:${TEST_ORIGIN}`);
        expect(grant?.tabId).toBe(TAB_ID);
      });
    });
  });

  describe('revokePluginPermissions', () => {
    it('should remove persistent permissions', async () => {
      await grantPluginPermission(TEST_ORIGIN, {
        mode: 'always',
        tools: [TEST_TOOL],
      });

      await revokePluginPermissions(TEST_ORIGIN);

      const result = await hasAnyPluginPermission(TEST_ORIGIN);
      expect(result).toBe(false);
    });

    it('should remove temporary grants', async () => {
      await grantPluginPermission(TEST_ORIGIN, {
        mode: 'once',
        tools: [TEST_TOOL],
      });

      await revokePluginPermissions(TEST_ORIGIN);

      const tempGrants = __getTemporaryGrants();
      expect(tempGrants.has(`plugin-temp:${TEST_ORIGIN}`)).toBe(false);
    });

    it('should not affect other origins', async () => {
      const OTHER_ORIGIN = 'https://other.com';
      await grantPluginPermission(TEST_ORIGIN, {
        mode: 'always',
        tools: [TEST_TOOL],
      });
      await grantPluginPermission(OTHER_ORIGIN, {
        mode: 'always',
        tools: [TEST_TOOL],
      });

      await revokePluginPermissions(TEST_ORIGIN);

      expect(await hasAnyPluginPermission(TEST_ORIGIN)).toBe(false);
      expect(await hasAnyPluginPermission(OTHER_ORIGIN)).toBe(true);
    });
  });

  describe('clearPluginTabGrants', () => {
    it('should remove temporary grants for specific tab', async () => {
      const TAB_ID = 12345;
      await grantPluginPermission(TEST_ORIGIN, {
        mode: 'once',
        tools: [TEST_TOOL],
        tabId: TAB_ID,
      });

      clearPluginTabGrants(TAB_ID);

      const tempGrants = __getTemporaryGrants();
      expect(tempGrants.has(`plugin-temp:${TEST_ORIGIN}`)).toBe(false);
    });

    it('should not remove grants from other tabs', async () => {
      const TAB_1 = 111;
      const TAB_2 = 222;
      const ORIGIN_1 = 'https://site1.com';
      const ORIGIN_2 = 'https://site2.com';

      await grantPluginPermission(ORIGIN_1, {
        mode: 'once',
        tools: ['tool1'],
        tabId: TAB_1,
      });
      await grantPluginPermission(ORIGIN_2, {
        mode: 'once',
        tools: ['tool2'],
        tabId: TAB_2,
      });

      clearPluginTabGrants(TAB_1);

      expect(await hasPluginToolPermission(ORIGIN_1, 'tool1')).toBe(false);
      expect(await hasPluginToolPermission(ORIGIN_2, 'tool2')).toBe(true);
    });

    it('should not affect persistent grants', async () => {
      const TAB_ID = 12345;
      await grantPluginPermission(TEST_ORIGIN, {
        mode: 'always',
        tools: ['persistent-tool'],
      });
      await grantPluginPermission(TEST_ORIGIN, {
        mode: 'once',
        tools: ['temp-tool'],
        tabId: TAB_ID,
      });

      clearPluginTabGrants(TAB_ID);

      expect(await hasPluginToolPermission(TEST_ORIGIN, 'persistent-tool')).toBe(true);
      expect(await hasPluginToolPermission(TEST_ORIGIN, 'temp-tool')).toBe(false);
    });
  });

  describe('checkPluginConsent', () => {
    it('should return granted for extension origin', async () => {
      const result = await checkPluginConsent('extension');
      expect(result.granted).toBe(true);
      expect(result.missingTools).toEqual([]);
    });

    it('should return not granted when no consent exists', async () => {
      const result = await checkPluginConsent(TEST_ORIGIN, [TEST_TOOL]);
      expect(result.granted).toBe(false);
      expect(result.missingTools).toContain(TEST_TOOL);
    });

    it('should return granted when all requested tools are allowed', async () => {
      await grantPluginPermission(TEST_ORIGIN, {
        mode: 'always',
        tools: [TEST_TOOL, 'other-tool'],
      });

      const result = await checkPluginConsent(TEST_ORIGIN, [TEST_TOOL]);
      expect(result.granted).toBe(true);
      expect(result.missingTools).toEqual([]);
    });

    it('should return missing tools when some are not allowed', async () => {
      await grantPluginPermission(TEST_ORIGIN, {
        mode: 'always',
        tools: [TEST_TOOL],
      });

      const result = await checkPluginConsent(TEST_ORIGIN, [TEST_TOOL, 'other-tool']);
      expect(result.granted).toBe(false);
      expect(result.missingTools).toEqual(['other-tool']);
    });

    it('should return granted when allowAll is set', async () => {
      await grantPluginPermission(TEST_ORIGIN, {
        mode: 'always',
        allowAll: true,
      });

      const result = await checkPluginConsent(TEST_ORIGIN, ['any-tool', 'another-tool']);
      expect(result.granted).toBe(true);
      expect(result.missingTools).toEqual([]);
    });
  });

  describe('getAllPluginPermissions', () => {
    it('should return empty array when no permissions', async () => {
      const permissions = await getAllPluginPermissions();
      expect(permissions).toEqual([]);
    });

    it('should return persistent permissions', async () => {
      await grantPluginPermission(TEST_ORIGIN, {
        mode: 'always',
        tools: [TEST_TOOL],
      });

      const permissions = await getAllPluginPermissions();
      expect(permissions.length).toBe(1);
      expect(permissions[0].origin).toBe(TEST_ORIGIN);
      expect(permissions[0].grantType).toBe('always');
    });

    it('should return temporary permissions', async () => {
      await grantPluginPermission(TEST_ORIGIN, {
        mode: 'once',
        allowAll: true,
      });

      const permissions = await getAllPluginPermissions();
      expect(permissions.length).toBe(1);
      expect(permissions[0].grantType).toBe('once');
      expect(permissions[0].expiresAt).toBeDefined();
    });

    it('should merge permissions from same origin', async () => {
      await grantPluginPermission(TEST_ORIGIN, {
        mode: 'always',
        tools: ['tool1'],
      });
      await grantPluginPermission(TEST_ORIGIN, {
        mode: 'once',
        tools: ['tool2'],
      });

      const permissions = await getAllPluginPermissions();
      expect(permissions.length).toBe(1);
      expect(permissions[0].allowedTools).toContain('tool1');
      expect(permissions[0].allowedTools).toContain('tool2');
    });

    it('should list multiple origins', async () => {
      const ORIGIN_1 = 'https://site1.com';
      const ORIGIN_2 = 'https://site2.com';

      await grantPluginPermission(ORIGIN_1, {
        mode: 'always',
        tools: ['tool1'],
      });
      await grantPluginPermission(ORIGIN_2, {
        mode: 'once',
        allowAll: true,
      });

      const permissions = await getAllPluginPermissions();
      expect(permissions.length).toBe(2);

      const origins = permissions.map((p) => p.origin);
      expect(origins).toContain(ORIGIN_1);
      expect(origins).toContain(ORIGIN_2);
    });
  });

  describe('Origin Isolation', () => {
    it('should maintain separate permissions per origin', async () => {
      const ORIGIN_A = 'https://app-a.com';
      const ORIGIN_B = 'https://app-b.com';

      await grantPluginPermission(ORIGIN_A, {
        mode: 'always',
        tools: ['toolA'],
      });
      await grantPluginPermission(ORIGIN_B, {
        mode: 'always',
        tools: ['toolB'],
      });

      expect(await hasPluginToolPermission(ORIGIN_A, 'toolA')).toBe(true);
      expect(await hasPluginToolPermission(ORIGIN_A, 'toolB')).toBe(false);
      expect(await hasPluginToolPermission(ORIGIN_B, 'toolA')).toBe(false);
      expect(await hasPluginToolPermission(ORIGIN_B, 'toolB')).toBe(true);
    });
  });
});
