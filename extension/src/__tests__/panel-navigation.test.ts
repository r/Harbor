import { describe, expect, it } from 'vitest';
import {
  deriveGatewayAttention,
  derivePanelAttention,
  isHarborPanelMode,
  nextHarborPanelMode,
} from '../panel-navigation';

describe('Harbor panel navigation', () => {
  it('recognizes supported modes', () => {
    expect(isHarborPanelMode('overview')).toBe(true);
    expect(isHarborPanelMode('connections')).toBe(true);
    expect(isHarborPanelMode('access')).toBe(true);
    expect(isHarborPanelMode('settings')).toBe(false);
    expect(isHarborPanelMode(null)).toBe(false);
  });

  it('wraps arrow-key navigation across the three modes', () => {
    expect(nextHarborPanelMode('overview', 'ArrowLeft')).toBe('access');
    expect(nextHarborPanelMode('overview', 'ArrowRight')).toBe('connections');
    expect(nextHarborPanelMode('access', 'ArrowRight')).toBe('overview');
  });

  it('supports Home and End navigation', () => {
    expect(nextHarborPanelMode('connections', 'Home')).toBe('overview');
    expect(nextHarborPanelMode('connections', 'End')).toBe('access');
  });

  it('prioritizes errors over warnings for attention signals', () => {
    expect(derivePanelAttention(['status-text connected'])).toBe('none');
    expect(derivePanelAttention(['status-text connecting'])).toBe('warning');
    expect(derivePanelAttention([
      'status-text connecting',
      'status-text disconnected',
    ])).toBe('error');
  });

  it('only flags gateway states that need intervention or are in flight', () => {
    expect(deriveGatewayAttention('Disconnected')).toBe('error');
    expect(deriveGatewayAttention('Loading')).toBe('warning');
    expect(deriveGatewayAttention('Pairing...')).toBe('warning');
    expect(deriveGatewayAttention('Expired')).toBe('warning');
    expect(deriveGatewayAttention('Enabled')).toBe('none');
    expect(deriveGatewayAttention('Paused')).toBe('none');
    expect(deriveGatewayAttention('Active')).toBe('none');
  });
});
