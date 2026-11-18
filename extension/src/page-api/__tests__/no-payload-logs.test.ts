import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Harbor must not write what a page sends (prompts, tasks, system prompts,
// URLs, whole messages) to the console. Logs may name the request, its IDs,
// the origin and sizes, but never the content.

const SECRET = 'MARKER-7f3a-private-content';

const mocks = vi.hoisted(() => ({ hasPermission: vi.fn() }));
vi.mock('../handlers/permission-handlers', async (importOriginal) => ({
  ...(await importOriginal<object>()), hasPermission: mocks.hasPermission,
}));
vi.mock('../harbor-core', () => ({
  harborRequest: vi.fn(async (method: string) => method === 'mcp.listTools'
    ? { tools: [] } : { content: 'ok' }),
  harborStreamRequest: vi.fn(),
}));
vi.mock('../policy/feature-flags', () => ({
  getFeatureFlags: async () => ({ toolCalling: true, browserControl: true }),
}));

let logged: string[];

function captureConsole() {
  logged = [];
  for (const level of ['log', 'debug', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
}

function expectNoSecretLogged() {
  expect(logged.filter((line) => line.includes(SECRET))).toEqual([]);
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.hasPermission.mockResolvedValue(true);
  vi.stubGlobal('chrome', {
    storage: { local: { set: vi.fn(async () => {}), get: vi.fn(async () => ({})) } },
    tabs: {
      create: vi.fn(async ({ url }: { url: string }) => ({ id: 7, url, status: 'complete' })),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    },
    windows: { onRemoved: { addListener: vi.fn() } },
    runtime: {
      onConnect: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn() },
      onMessageExternal: { addListener: vi.fn() },
    },
  });
  captureConsole();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const ctx = (type: string, payload: unknown) => ({
  id: 'req-1', type, origin: 'https://site.example', tabId: 3, payload,
});

describe('page requests are not logged with their content', () => {
  it('ai.createTextSession does not log the system prompt', async () => {
    const { handleAiCreateTextSession } = await import('../handlers/ai-handlers');
    await handleAiCreateTextSession(ctx('ai.createTextSession', { systemPrompt: SECRET }) as never);
    expectNoSecretLogged();
  });

  it('tabs.create does not log the URL the page asked for', async () => {
    const { handleTabsCreate } = await import('../handlers/tab-handlers');
    const response = await handleTabsCreate(
      ctx('tabs.create', { url: `https://dest.example/?q=${SECRET}` }) as never,
    );
    expect(response).toMatchObject({ ok: true });
    expectNoSecretLogged();
  });

  it('agent.run does not log the task', async () => {
    const { initializePageApi } = await import('../background');
    initializePageApi();
    const onConnect = (chrome.runtime.onConnect.addListener as ReturnType<typeof vi.fn>);
    let receive!: (message: unknown) => Promise<void>;
    onConnect.mock.calls[0][0]({
      name: 'harbor-page-api', sender: { url: 'https://site.example/page', tab: { id: 3 } },
      postMessage: vi.fn(),
      onMessage: { addListener: (listener: typeof receive) => { receive = listener; } },
    });
    await receive({ id: 'run-1', type: 'agent.run', payload: { task: SECRET } });
    expectNoSecretLogged();
  });
});

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

describe('message logging at the extension boundaries', () => {
  it("Harbor's background has no listener that logs every runtime message", () => {
    expect(read('../../background.ts')).not.toMatch(/Incoming message:/);
  });

  it('the content script does not log an invocation task', () => {
    expect(read('../content-script.ts')).not.toMatch(/console\.\w+\([^;]*message\.task/);
  });

  it('the multi-agent invoke path does not log the task', () => {
    expect(read('../../multi-agent/messaging.ts')).not.toMatch(/console\.\w+\([^;]*request\.task/);
  });

  it("the permission prompt is not logged with the page's reason or the prompt URL", () => {
    const source = read('../../policy/permissions.ts');
    expect(source).not.toMatch(/console\.\w+\([^;]*\breason\b/);
    expect(source).not.toMatch(/console\.\w+\([^;]*promptUrl/);
  });
});
