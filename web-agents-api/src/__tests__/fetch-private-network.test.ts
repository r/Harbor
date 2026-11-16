import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// agent.browser.fetch must not let a page read responses from the user's
// machine or local network: not by address, not after a redirect, and (where
// the browser can resolve names) not through a hostname that points there.

const mocks = vi.hoisted(() => ({ hasPermission: vi.fn() }));

vi.mock('../handlers/permission-handlers', async (importOriginal) => ({
  ...(await importOriginal<object>()), hasPermission: mocks.hasPermission,
}));

const fetchMock = vi.fn();

function response(url: string, body = 'secret', status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    url,
    type: 'basic',
    redirected: false,
    headers: new Headers({ 'content-type': 'text/plain' }),
    text: async () => body,
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.hasPermission.mockResolvedValue(true);
  fetchMock.mockImplementation(async (url: string) => response(url, 'public page'));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('chrome', { storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } }, tabs: {}, runtime: {} });
});

afterEach(() => vi.unstubAllGlobals());

async function callFetch(url: string) {
  const { handleBrowserFetch } = await import('../handlers/browser-handlers');
  return handleBrowserFetch({ id: 'r1', type: 'agent.browser.fetch', payload: { url }, origin: 'https://news.example' });
}

function stubDns(table: Record<string, string[]>) {
  vi.stubGlobal('browser', {
    dns: {
      resolve: vi.fn(async (host: string) => {
        if (!(host in table)) throw new Error('NS_ERROR_UNKNOWN_HOST');
        return { addresses: table[host], canonicalName: host, isTRR: false };
      }),
    },
  });
}

describe('fetch refuses local and private-network addresses', () => {
  for (const url of [
    'http://127.0.0.2/',
    'http://127.1/',
    'http://2130706433/',
    'http://0.0.0.0/',
    'http://[::1]/',
    'http://[::]/',
    'http://[0:0:0:0:0:0:0:1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:192.168.1.1]/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
    'http://10.1.2.3/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://198.18.0.1/',
    'http://224.0.0.1/',
    'http://255.255.255.255/',
    'http://localhost/',
    'http://localhost./',
    'http://LOCALHOST/',
    'http://app.localhost/',
    'http://printer.local/',
    'http://printer.local./',
    'http://router.home.arpa/',
    'http://db.internal/',
  ]) {
    it(`refuses ${url}`, async () => {
      const res = await callFetch(url);
      expect(res.ok).toBe(false);
      expect((res as { error: { code: string } }).error.code).toBe('ERR_PERMISSION_DENIED');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it('still allows public addresses and names', async () => {
    for (const url of ['https://example.com/', 'https://8.8.8.8/', 'https://[2606:4700::1111]/', 'https://172.32.0.1/', 'https://localhost.example.com/']) {
      const res = await callFetch(url);
      expect(res.ok, url).toBe(true);
    }
  });
});

describe('fetch refuses a redirect that ends on a local address', () => {
  for (const finalUrl of ['http://127.0.0.1:8080/admin', 'http://[::1]/', 'http://192.168.1.1/', 'http://localhost/']) {
    it(`discards the response when the final URL is ${finalUrl}`, async () => {
      fetchMock.mockImplementation(async () => ({ ...response(finalUrl), redirected: true }));
      const res = await callFetch('https://public.example/redirect');
      expect(res.ok).toBe(false);
      expect((res as { error: { code: string } }).error.code).toBe('ERR_PERMISSION_DENIED');
      expect(JSON.stringify(res)).not.toContain('secret');
    });
  }

  it('returns a redirect that stays public', async () => {
    fetchMock.mockImplementation(async () => ({ ...response('https://www.example.com/', 'public page'), redirected: true }));
    const res = await callFetch('http://example.com/');
    expect(res.ok).toBe(true);
    expect(JSON.stringify(res)).toContain('public page');
  });
});

describe('where the browser can resolve names, fetch refuses names that point at local addresses', () => {
  it('refuses a public name that resolves to loopback, without fetching', async () => {
    stubDns({ 'evil.example': ['127.0.0.1'] });
    const res = await callFetch('https://evil.example/');
    expect(res.ok).toBe(false);
    expect((res as { error: { code: string } }).error.code).toBe('ERR_PERMISSION_DENIED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses when any resolved address is private', async () => {
    stubDns({ 'mixed.example': ['93.184.216.34', '10.0.0.5'] });
    const res = await callFetch('https://mixed.example/');
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses when a redirect ends on a name that resolves locally', async () => {
    stubDns({ 'public.example': ['93.184.216.34'], 'sneaky.example': ['192.168.0.10'] });
    fetchMock.mockImplementation(async () => ({ ...response('https://sneaky.example/'), redirected: true }));
    const res = await callFetch('https://public.example/');
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain('secret');
  });

  it('allows a name that resolves to public addresses', async () => {
    stubDns({ 'example.com': ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'] });
    const res = await callFetch('https://example.com/');
    expect(res.ok).toBe(true);
  });

  it('lets fetch report the error when the name does not resolve', async () => {
    stubDns({});
    fetchMock.mockRejectedValue(new TypeError('NetworkError when attempting to fetch resource.'));
    const res = await callFetch('https://nonexistent.example/');
    expect(res.ok).toBe(false);
    expect((res as { error: { code: string } }).error.code).toBe('ERR_INTERNAL');
  });
});
