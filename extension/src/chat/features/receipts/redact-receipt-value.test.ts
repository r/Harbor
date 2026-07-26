import { describe, expect, it } from 'vitest';
import {
  redactTransientValue,
  sanitizeReceiptReference,
  summarizeArguments,
} from './redact-receipt-value';

describe('receipt redaction', () => {
  it('redacts nested sensitive fields and handles cycles', () => {
    const input: Record<string, unknown> = {
      profile: {
        name: 'Ada',
        accessToken: 'token-value',
      },
    };
    input.self = input;

    expect(redactTransientValue(input)).toEqual({
      profile: {
        name: 'Ada',
        accessToken: '[redacted]',
      },
      self: '[circular]',
    });
  });

  it('summarizes argument fields without retaining their values', () => {
    expect(summarizeArguments({
      query: 'harbor',
      nested: {
        password: 'secret',
        page: 1,
      },
    })).toEqual({
      fieldCount: 4,
      sensitiveFieldCount: 1,
    });
  });

  it('reduces credential-bearing URLs to origins', () => {
    expect(sanitizeReceiptReference(
      'https://user:secret@example.com/private?token=secret#fragment',
    )).toBe('https://example.com/');
  });

  it('bounds deeply nested and oversized transient values', () => {
    const redacted = redactTransientValue(
      {
        one: {
          two: {
            three: {
              four: {
                five: 'unreachable',
              },
            },
          },
        },
        long: 'abcdefghijk',
      },
      { maxDepth: 3, maxStringLength: 5 },
    );

    expect(redacted).toEqual({
      one: {
        two: {
          three: '[depth-limited]',
        },
      },
      long: 'abcde…',
    });
  });
});
