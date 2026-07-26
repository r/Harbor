import { describe, expect, it, vi } from 'vitest';
import { initializePanelLauncher, type PanelLauncherAPI } from '../panel-launcher';

describe('initializePanelLauncher', () => {
  it('configures toolbar clicks to open the Chrome side panel', () => {
    const setPanelBehavior = vi.fn();
    const addListener = vi.fn();

    initializePanelLauncher({
      action: { onClicked: { addListener } },
      sidePanel: { setPanelBehavior },
    });

    expect(setPanelBehavior).toHaveBeenCalledWith({
      openPanelOnActionClick: true,
    });
    expect(addListener).not.toHaveBeenCalled();
  });

  it('toggles the Firefox sidebar directly from the toolbar click', () => {
    let toolbarClick: (() => void) | undefined;
    const toggle = vi.fn();

    initializePanelLauncher({
      action: {
        onClicked: {
          addListener(listener) {
            toolbarClick = listener;
          },
        },
      },
      sidebarAction: { toggle },
    });

    expect(toggle).not.toHaveBeenCalled();
    toolbarClick?.();
    expect(toggle).toHaveBeenCalledOnce();
  });

  it('does nothing when the browser has no panel API', () => {
    const addListener = vi.fn();
    const extensionAPI: PanelLauncherAPI = {
      action: { onClicked: { addListener } },
    };

    expect(() => initializePanelLauncher(extensionAPI)).not.toThrow();
    expect(addListener).not.toHaveBeenCalled();
  });

  it('reports asynchronous panel configuration failures', async () => {
    const error = new Error('configuration failed');
    const logger = { error: vi.fn() };

    initializePanelLauncher(
      {
        sidePanel: {
          setPanelBehavior: () => Promise.reject(error),
        },
      },
      logger,
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(logger.error).toHaveBeenCalledWith(
      '[Harbor] Failed to configure Chrome side panel:',
      error,
    );
  });
});
