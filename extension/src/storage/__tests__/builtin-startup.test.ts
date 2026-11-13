import { beforeEach, expect, it, vi } from 'vitest';
import { resetMockBrowser } from '../../__tests__/test-setup';
import { ensureBuiltinServers, saveInstalledServers } from '../servers';
import { initializeMcpHost } from '../../mcp/host';
import { registerMcpServer, startMcpServer } from '../../wasm/runtime';

vi.mock('../../wasm/runtime', () => ({
  initializeMcpRuntime: vi.fn(),
  registerMcpServer: vi.fn(),
  startMcpServer: vi.fn(async () => true),
}));

beforeEach(() => {
  resetMockBrowser();
  vi.clearAllMocks();
});

it('starts the newly installed time server through host initialization', async () => {
  initializeMcpHost();
  await vi.waitFor(() => expect(startMcpServer).toHaveBeenCalledWith('time-wasm'));
  expect(startMcpServer).toHaveBeenCalledTimes(1);
  expect(registerMcpServer).toHaveBeenCalledWith(expect.objectContaining({ id: 'time-wasm', autostart: true }));
});

it('does not restart a time server the user stopped', async () => {
  const servers = await ensureBuiltinServers();
  servers.find(server => server.id === 'time-wasm')!.autostart = false;
  await saveInstalledServers(servers);
  initializeMcpHost();
  await vi.waitFor(() => expect(registerMcpServer).toHaveBeenCalledTimes(2));
  expect(startMcpServer).not.toHaveBeenCalled();
});
