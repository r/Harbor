import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INVOCATION_TIMEOUT_MS,
  MAX_INVOCATION_TIMEOUT_MS,
  invocationTimeoutMs,
} from '../messaging';

describe('invocationTimeoutMs', () => {
  it.each([undefined, null, 0, -5, Number.NaN, '60000', {}])(
    'falls back to the default for %s',
    (requested) => {
      expect(invocationTimeoutMs(requested)).toBe(DEFAULT_INVOCATION_TIMEOUT_MS);
    },
  );

  it('keeps a timeout within the cap', () => {
    expect(invocationTimeoutMs(60_000)).toBe(60_000);
  });

  it.each([MAX_INVOCATION_TIMEOUT_MS + 1, 1e12, Number.POSITIVE_INFINITY])('caps %s at five minutes', (requested) => {
    expect(invocationTimeoutMs(requested)).toBe(MAX_INVOCATION_TIMEOUT_MS);
  });
});
