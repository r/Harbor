export const HARBOR_PANEL_MODES = ['overview', 'connections', 'access'] as const;

export type HarborPanelMode = typeof HARBOR_PANEL_MODES[number];
export type PanelNavigationKey = 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End';
export type PanelAttention = 'none' | 'warning' | 'error';

export function isHarborPanelMode(value: string | null): value is HarborPanelMode {
  return HARBOR_PANEL_MODES.includes(value as HarborPanelMode);
}

export function nextHarborPanelMode(
  currentMode: HarborPanelMode,
  key: PanelNavigationKey,
): HarborPanelMode {
  if (key === 'Home') {
    return HARBOR_PANEL_MODES[0];
  }
  if (key === 'End') {
    return HARBOR_PANEL_MODES[HARBOR_PANEL_MODES.length - 1];
  }

  const currentIndex = HARBOR_PANEL_MODES.indexOf(currentMode);
  const direction = key === 'ArrowRight' ? 1 : -1;
  const nextIndex = (
    currentIndex + direction + HARBOR_PANEL_MODES.length
  ) % HARBOR_PANEL_MODES.length;

  return HARBOR_PANEL_MODES[nextIndex];
}

export function derivePanelAttention(classNames: readonly string[]): PanelAttention {
  if (classNames.some((className) => className.includes('disconnected'))) {
    return 'error';
  }
  if (classNames.some((className) => className.includes('connecting'))) {
    return 'warning';
  }
  return 'none';
}

export function deriveGatewayAttention(status: string): PanelAttention {
  if (status === 'Disconnected') {
    return 'error';
  }
  if (
    status === 'Loading'
    || status === 'Expired'
    || status.endsWith('...')
  ) {
    return 'warning';
  }
  return 'none';
}
