import { describe, expect, it } from 'vitest';
import {
  adaptNativeAgentGatewayClients,
  normalizeApprovalScopes,
  toRegistryClientMetadata,
} from '../approval';

describe('Agent Gateway approval metadata adapter', () => {
  it('maps native metadata without inventing scopes', () => {
    const clients = adaptNativeAgentGatewayClients(
      [{
        id: 'client_1',
        displayName: 'Coding Agent',
        clientVersion: '1.2.0',
        createdAt: '2026-07-25T12:00:00.000Z',
        revoked: false,
      }],
      new Map(),
    );

    expect(clients).toEqual([{
      clientId: 'client_1',
      displayName: 'Coding Agent',
      clientVersion: '1.2.0',
      pairedAt: '2026-07-25T12:00:00.000Z',
      scopes: [],
    }]);
  });

  it('allows only explicit tabs:list and page:observe approvals', () => {
    const clients = adaptNativeAgentGatewayClients(
      [{
        id: 'client_1',
        displayName: 'Coding Agent',
        createdAt: '2026-07-25T12:00:00.000Z',
        revoked: true,
        revokedAt: '2026-07-25T13:00:00.000Z',
      }],
      new Map([[
        'client_1',
        normalizeApprovalScopes([
          'page:observe',
          'admin:everything',
          'tabs:list',
        ]),
      ]]),
    );

    expect(clients[0].scopes).toEqual(['tabs:list', 'page:observe']);
    expect(clients[0].revokedAt).toBe('2026-07-25T13:00:00.000Z');
    expect(toRegistryClientMetadata(clients[0]).scopes).toEqual([
      'gateway:tabs.read',
      'gateway:page.read',
    ]);
  });
});
