import { beforeEach, describe, expect, it } from 'vitest';
import { resetMockBrowser } from '../../__tests__/test-setup';
import { ensureBuiltinServers, saveInstalledServers } from '../servers';

describe('built-in server defaults', () => {
  beforeEach(() => resetMockBrowser());

  it('starts the bundled time tool on a fresh install without enabling other servers', async () => {
    const servers = await ensureBuiltinServers();
    expect(servers.find(server => server.id === 'time-wasm')?.autostart).toBe(true);
    expect(servers.find(server => server.id === 'echo-js')?.autostart).not.toBe(true);
    expect(await ensureBuiltinServers()).toEqual(servers);
  });

  it('does not ask the model to invent the current time', async () => {
    const servers = await ensureBuiltinServers();
    expect(servers.find(server => server.id === 'time-wasm')?.tools?.[0].inputSchema).toEqual({ type: 'object', properties: {}, required: [] });
  });

  it.each([false, undefined, true])('preserves an existing time server with autostart=%s', async autostart => {
    const servers = await ensureBuiltinServers();
    const time = servers.find(server => server.id === 'time-wasm')!;
    time.autostart = autostart;
    await saveInstalledServers(servers);
    expect((await ensureBuiltinServers()).find(server => server.id === 'time-wasm')?.autostart).toBe(autostart);
  });
});
