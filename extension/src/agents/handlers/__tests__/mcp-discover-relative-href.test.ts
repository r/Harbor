/**
 * agent.mcp.discover reports each `<link rel="mcp-server">` URL resolved
 * against the page, so a relative href (valid HTML, and what a site uses to
 * name its own preview builds) can be passed straight to agent.mcp.register,
 * which needs an absolute same-origin URL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockBrowser } from '../../../__tests__/test-setup';

const BASE = 'https://tale.example/books/moby-dick';

function fakeLink(attrs: Record<string, string>) {
  return {
    getAttribute: (name: string) => attrs[name] ?? null,
    // What the browser's HTMLLinkElement.href gives: resolved against the document.
    get href() { return attrs.href === undefined ? '' : new URL(attrs.href, BASE).href; },
  };
}

let links: ReturnType<typeof fakeLink>[] = [];

beforeEach(() => {
  resetMockBrowser();
  const g = globalThis as unknown as { chrome: Record<string, unknown>; document?: unknown };
  g.document = { querySelectorAll: () => links };
  g.chrome.scripting = {
    executeScript: vi.fn(async ({ func }: { func: () => unknown }) => [{ result: func() }]),
  };
});

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
});

async function discover() {
  const { handleMcpDiscover } = await import('../mcp-website');
  let response: { ok: boolean; result?: { servers: Array<{ url: string }> } } | undefined;
  await handleMcpDiscover(
    { id: 'r1', type: 'agent.mcp.discover', origin: 'https://tale.example', tabId: 3, payload: {} } as never,
    { sendResponse: (r: never) => { response = r; }, sendStreamEvent: () => {} } as never,
  );
  return response!;
}

describe('agent.mcp.discover', () => {
  it('resolves a relative href against the page', async () => {
    links = [fakeLink({ href: '/api/mcp', title: 'tale.fyi', 'data-transport': 'streamable-http' })];
    const res = await discover();
    expect(res.ok).toBe(true);
    expect(res.result!.servers).toEqual([
      expect.objectContaining({ url: 'https://tale.example/api/mcp', name: 'tale.fyi', transport: 'streamable-http' }),
    ]);
  });

  it('keeps an absolute href as is', async () => {
    links = [fakeLink({ href: 'https://tale.example/mcp' })];
    expect((await discover()).result!.servers[0].url).toBe('https://tale.example/mcp');
  });

  it('reports an empty url for a link with no href, not the page URL', async () => {
    links = [fakeLink({ title: 'broken' }), fakeLink({ href: '' })];
    expect((await discover()).result!.servers.map((s) => s.url)).toEqual(['', '']);
  });
});
