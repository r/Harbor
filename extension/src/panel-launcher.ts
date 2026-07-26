interface ToolbarAction {
  onClicked: {
    addListener(listener: () => void): void;
  };
}

interface ChromeSidePanel {
  setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void> | void;
}

interface FirefoxSidebarAction {
  toggle(): Promise<void> | void;
}

export interface PanelLauncherAPI {
  action?: ToolbarAction;
  sidePanel?: ChromeSidePanel;
  sidebarAction?: FirefoxSidebarAction;
}

type PanelLauncherLogger = Pick<Console, 'error'>;

function reportPanelError(logger: PanelLauncherLogger, message: string, error: unknown): void {
  logger.error(message, error);
}

export function initializePanelLauncher(
  extensionAPI: PanelLauncherAPI,
  logger: PanelLauncherLogger = console,
): void {
  if (extensionAPI.sidePanel?.setPanelBehavior) {
    try {
      const result = extensionAPI.sidePanel.setPanelBehavior({
        openPanelOnActionClick: true,
      });
      void Promise.resolve(result).catch((error) => {
        reportPanelError(logger, '[Harbor] Failed to configure Chrome side panel:', error);
      });
    } catch (error) {
      reportPanelError(logger, '[Harbor] Failed to configure Chrome side panel:', error);
    }
    return;
  }

  if (!extensionAPI.sidebarAction?.toggle || !extensionAPI.action?.onClicked) {
    return;
  }

  extensionAPI.action.onClicked.addListener(() => {
    try {
      const result = extensionAPI.sidebarAction?.toggle();
      void Promise.resolve(result).catch((error) => {
        reportPanelError(logger, '[Harbor] Failed to toggle Firefox sidebar:', error);
      });
    } catch (error) {
      reportPanelError(logger, '[Harbor] Failed to toggle Firefox sidebar:', error);
    }
  });
}
