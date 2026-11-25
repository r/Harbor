/**
 * agent.mcp.discover finds the page's `<link rel="mcp-server">` and
 * `<link rel="mcp">` declarations. It reports each URL resolved
 * against the page, so a relative href (valid HTML, and what a site uses to
 * name its own preview builds) can be passed straight to agent.mcp.register,
 * which needs an absolute same-origin URL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockBrowser } from '../../../__tests__/test-setup';

const BASE = 'https://tale.example/books/moby-dick';

function fakeLink(attrs: Record<string, string>) {
  attrs = { rel: 'mcp-server', ...attrs };
  return {
    getAttribute: (name: string) => attrs[name] ?? null,
    // What the browser's HTMLLinkElement.href gives: resolved against the document.
    get href() { return attrs.href === undefined ? '' : new URL(attrs.href, BASE).href; },
  };
}

let links: ReturnType<typeof fakeLink>[] = [];

/**
 * Enough of querySelectorAll for `link[rel="x"]` and `link[rel~="x"]`
 * selector lists. Like the browser, it returns each matching element once,
 * in document order, and compares rel values ASCII case-insensitively (HTML
 * lists rel among the attributes selectors match that way).
 */
function querySelectorAll(selectors: string) {
  const tests = selectors.split(',').map((sel) => {
    const m = sel.trim().match(/^link\[rel(~?=)"([^"]+)"\]$/);
    if (!m) throw new Error(`fake querySelectorAll can't parse ${sel}`);
    const op = m[1];
    const value = m[2].toLowerCase();
    return (rel: string) => {
      const r = rel.toLowerCase();
      return op === '=' ? r === value : r.split(/\s+/).includes(value);
    };
  });
  return links.filter((l) => {
    const rel = l.getAttribute('rel');
    return rel !== null && tests.some((t) => t(rel));
  });
}

beforeEach(() => {
  resetMockBrowser();
  const g = globalThis as unknown as { chrome: Record<string, unknown>; document?: unknown };
  g.document = { querySelectorAll };
  g.chrome.scripting = {
    executeScript: vi.fn(async ({ func }: { func: () => unknown }) => [{ result: func() }]),
  };
});

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
});

async function discover() {
  const { handleMcpDiscover } = await import('../mcp-website');
  let response: { ok: boolean; result?: { servers: Array<{ url: string; name?: string; transport?: string }> } } | undefined;
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

  it('finds rel="mcp" as well as rel="mcp-server", each link once', async () => {
    links = [
      fakeLink({ href: '/a', title: 'a' }),
      fakeLink({ rel: 'mcp', href: '/b', title: 'b' }),
      fakeLink({ rel: 'mcp-server mcp', href: '/c', title: 'c' }),
      fakeLink({ rel: 'stylesheet', href: '/d.css', title: 'd' }),
    ];
    expect((await discover()).result!.servers.map((s) => s.name)).toEqual(['a', 'b', 'c']);
  });

  it('matches mcp-server or mcp as one token of a rel list', async () => {
    links = [
      fakeLink({ rel: 'alternate mcp-server', href: '/a', title: 'a' }),
      fakeLink({ rel: 'MCP', href: '/b', title: 'b' }),
      fakeLink({ rel: 'mcp-servers', href: '/c', title: 'c' }),
    ];
    // Link types are case-insensitive; "mcp-servers" is a different token.
    expect((await discover()).result!.servers.map((s) => s.name)).toEqual(['a', 'b']);
  });

  it('reports streamable-http when a link has no data-transport', async () => {
    links = [fakeLink({ href: '/mcp' }), fakeLink({ href: '/mcp', 'data-transport': '' })];
    expect((await discover()).result!.servers.map((s) => s.transport)).toEqual(['streamable-http', 'streamable-http']);
  });

  it('keeps a transport the link names', async () => {
    links = [fakeLink({ href: '/mcp', 'data-transport': 'sse' })];
    expect((await discover()).result!.servers[0].transport).toBe('sse');
  });
});
