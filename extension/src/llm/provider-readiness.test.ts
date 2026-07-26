import { describe, expect, it } from 'vitest';

import {
  isConfiguredProviderInstance,
  isProviderConfigurationReady,
} from './provider-readiness';

describe('isConfiguredProviderInstance', () => {
  it('uses the explicit bridge marker when available', () => {
    expect(isConfiguredProviderInstance({
      id: 'ollama',
      type: 'ollama',
      base_url: 'https://ollama.example.com',
      is_configured_instance: false,
    })).toBe(false);
  });

  it('recognizes a remote provider returned by an older bridge', () => {
    expect(isConfiguredProviderInstance({
      id: 'ollama-24194f',
      type: 'ollama',
      base_url: 'https://ollama.example.com',
    })).toBe(true);
  });

  it('does not treat an auto-detected local provider as persisted', () => {
    expect(isConfiguredProviderInstance({
      id: 'ollama',
      type: 'ollama',
      available: true,
    })).toBe(false);
  });
});

describe('isProviderConfigurationReady', () => {
  it('allows provider configuration after model discovery completes', () => {
    expect(isProviderConfigurationReady(true, [])).toBe(true);
  });

  it('allows provider configuration when a configured provider is connected', () => {
    expect(isProviderConfigurationReady(false, [
      {
        available: true,
        is_configured_instance: true,
      },
    ])).toBe(true);
  });

  it('does not treat an auto-detected provider as a connected configuration', () => {
    expect(isProviderConfigurationReady(false, [
      {
        available: true,
        is_configured_instance: false,
      },
    ])).toBe(false);
  });

  it('accepts a connected provider returned by an older bridge', () => {
    expect(isProviderConfigurationReady(false, [
      {
        id: 'ollama-24194f',
        type: 'ollama',
        base_url: 'https://ollama.example.com',
        available: true,
      },
    ])).toBe(true);
  });

  it('keeps provider configuration disabled while discovery is unavailable', () => {
    expect(isProviderConfigurationReady(false, [
      {
        available: false,
        is_configured_instance: true,
      },
    ])).toBe(false);
  });
});
