/**
 * Time tools tests.
 */

import { describe, it, expect } from 'vitest';
import { timeNow, timeFormat } from './time';
import { ToolError } from '../errors';

describe('time.now', () => {
  it('should return current time with human-readable fields', () => {
    const before = Date.now();
    const result = timeNow();
    const after = Date.now();

    expect(result.epochMs).toBeGreaterThanOrEqual(before);
    expect(result.epochMs).toBeLessThanOrEqual(after);
    expect(result.iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(result.dayOfWeek).toMatch(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/);
    expect(result.formatted).toBeTruthy();
    expect(result.timezone).toBeTruthy();
  });

  it('should return consistent iso and epochMs', () => {
    const result = timeNow();
    const dateFromIso = new Date(result.iso);
    expect(dateFromIso.getTime()).toBe(result.epochMs);
  });

  it('should use specified timezone', () => {
    const result = timeNow({ timezone: 'America/New_York' });
    expect(result.timezone).toBe('America/New_York');
    // Should contain EST or EDT depending on daylight saving
    expect(result.formatted).toMatch(/E[SD]T/);
  });

  it('should throw for invalid timezone', () => {
    expect(() => timeNow({ timezone: 'Invalid/Zone' })).toThrow(ToolError);
  });
});

describe('time.format', () => {
  const testEpoch = 1704067200000; // 2024-01-01T00:00:00.000Z

  it('should format with defaults (UTC, en-US)', () => {
    const result = timeFormat({ epochMs: testEpoch });

    expect(result.iso).toBe('2024-01-01T00:00:00.000Z');
    expect(result.localeString).toContain('2024');
    expect(result.localeString).toContain('January');
  });

  it('should use specified timeZone', () => {
    const result = timeFormat({
      epochMs: testEpoch,
      timeZone: 'America/New_York',
    });

    // New York is UTC-5 in winter
    expect(result.localeString).toContain('December');
    expect(result.localeString).toContain('2023');
  });

  it('should use specified locale', () => {
    const result = timeFormat({
      epochMs: testEpoch,
      locale: 'de-DE',
    });

    expect(result.localeString).toContain('Januar');
  });

  it('should throw for non-finite epochMs', () => {
    expect(() => timeFormat({ epochMs: Infinity })).toThrow(ToolError);
    expect(() => timeFormat({ epochMs: -Infinity })).toThrow(ToolError);
    expect(() => timeFormat({ epochMs: NaN })).toThrow(ToolError);
  });

  it('should throw for non-number epochMs', () => {
    expect(() => timeFormat({ epochMs: 'invalid' as any })).toThrow(ToolError);
    expect(() => timeFormat({ epochMs: null as any })).toThrow(ToolError);
    expect(() => timeFormat({ epochMs: undefined as any })).toThrow(ToolError);
  });

  it('should throw for invalid timeZone', () => {
    expect(() =>
      timeFormat({ epochMs: testEpoch, timeZone: 'Invalid/Zone' })
    ).toThrow(ToolError);
  });

  it('should include INVALID_ARGUMENTS code in error', () => {
    try {
      timeFormat({ epochMs: NaN });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe('INVALID_ARGUMENTS');
    }
  });
});
