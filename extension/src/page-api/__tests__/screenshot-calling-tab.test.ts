import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// activeTab.screenshot must show the calling page, never another tab. The
// handler refuses unless the caller is the visible tab in its own window, and
// captures that window rather than whichever window has focus.

const mocks = vi.hoisted(() => ({ hasPermission: vi.fn() }));

vi.mock('../handlers/permission-handlers', async (importOriginal) => ({
  ...(await importOriginal<object>()), hasPermission: mocks.hasPermission,
}));

const CALLER_TAB = 7;
const CALLER_WINDOW = 3;

type Tab = { id: number; windowId: number; active: boolean };
let tabs: Map<number, Tab>;
let captureVisibleTab: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.hasPermission.mockResolvedValue(true);
  tabs = new Map();
  captureVisibleTab = vi.fn(async () => 'data:image/png;base64,AAAA');
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        set: vi.fn(async () => {}),
        // agent.browser.activeTab.screenshot is gated by Browser Interaction.
        get: vi.fn(async () => ({ 'harbor-page-api-flags': { browserInteraction: true } })),
      },
    },
    tabs: {
      get: vi.fn(async (id: number) => {
        const tab = tabs.get(id);
        if (!tab) throw new Error(`No tab with id: ${id}`);
        return { ...tab };
      }),
      captureVisibleTab,
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

async function screenshot() {
  const { routeMessage } = await import('../handlers');
  return routeMessage({
    id: 'r1',
    type: 'agent.browser.activeTab.screenshot',
    payload: {},
    origin: 'https://news.example',
    tabId: CALLER_TAB,
  });
}

describe('activeTab.screenshot captures only the calling tab', () => {
  it('refuses when the calling tab is not the visible tab in its window', async () => {
    tabs.set(CALLER_TAB, { id: CALLER_TAB, windowId: CALLER_WINDOW, active: false });

    const res = await screenshot();

    expect(res.ok).toBe(false);
    expect(captureVisibleTab).not.toHaveBeenCalled();
  });

  it("captures the caller's own window when the caller is visible", async () => {
    tabs.set(CALLER_TAB, { id: CALLER_TAB, windowId: CALLER_WINDOW, active: true });

    const res = await screenshot();

    expect(res.ok).toBe(true);
    expect(captureVisibleTab).toHaveBeenCalledTimes(1);
    expect(captureVisibleTab.mock.calls[0][0]).toBe(CALLER_WINDOW);
    expect((res as { result: { dataUrl: string } }).result.dataUrl).toMatch(/^data:image\/png/);
  });

  it('discards the image if the caller stopped being visible during capture', async () => {
    tabs.set(CALLER_TAB, { id: CALLER_TAB, windowId: CALLER_WINDOW, active: true });
    captureVisibleTab.mockImplementation(async () => {
      tabs.get(CALLER_TAB)!.active = false; // user switched tabs mid-capture
      return 'data:image/png;base64,OTHER';
    });

    const res = await screenshot();

    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain('OTHER');
  });

  it('refuses when the calling tab no longer exists', async () => {
    const res = await screenshot();

    expect(res.ok).toBe(false);
    expect(captureVisibleTab).not.toHaveBeenCalled();
  });
});
