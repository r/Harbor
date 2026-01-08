/**
 * Unit tests for decode tools.
 */

import { describe, it, expect } from 'vitest';
import {
  base64Encode,
  base64Decode,
  jsonPretty,
  jwtDecodeUnsafe,
} from './decode';

describe('base64Encode', () => {
  it('encodes simple ASCII text with size info', () => {
    const result = base64Encode({ text: 'Hello, World!' });
    expect(result.base64).toBe('SGVsbG8sIFdvcmxkIQ==');
    expect(result.originalLength).toBe(13);
    expect(result.encodedLength).toBe(20);
  });

  it('encodes empty string', () => {
    const result = base64Encode({ text: '' });
    expect(result.base64).toBe('');
    expect(result.originalLength).toBe(0);
    expect(result.encodedLength).toBe(0);
  });

  it('encodes UTF-8 text with special characters', () => {
    const result = base64Encode({ text: 'Hello 👋 世界' });
    // Decode to verify round-trip
    const decoded = base64Decode({ base64: result.base64 });
    expect(decoded.text).toBe('Hello 👋 世界');
  });

  it('throws for non-string input', () => {
    expect(() => base64Encode({ text: 123 as unknown as string })).toThrow(
      'text must be a string'
    );
  });
});

describe('base64Decode', () => {
  it('decodes valid base64 with size info', () => {
    const result = base64Decode({ base64: 'SGVsbG8sIFdvcmxkIQ==' });
    expect(result.text).toBe('Hello, World!');
    expect(result.encodedLength).toBe(20);
    expect(result.decodedLength).toBe(13);
  });

  it('decodes empty string', () => {
    const result = base64Decode({ base64: '' });
    expect(result.text).toBe('');
    expect(result.encodedLength).toBe(0);
    expect(result.decodedLength).toBe(0);
  });

  it('throws for invalid base64', () => {
    expect(() => base64Decode({ base64: '!!!invalid!!!' })).toThrow(
      'Invalid base64 string'
    );
  });

  it('throws for non-string input', () => {
    expect(() => base64Decode({ base64: null as unknown as string })).toThrow(
      'base64 must be a string'
    );
  });

  it('handles base64 with padding', () => {
    // "a" encodes to "YQ=="
    const result = base64Decode({ base64: 'YQ==' });
    expect(result.text).toBe('a');
  });

  it('handles base64 without padding (when valid)', () => {
    // Some base64 strings are valid without padding
    const result = base64Decode({ base64: 'SGVsbG8' }); // "Hello" without padding
    expect(result.text).toBe('Hello');
  });
});

describe('jsonPretty', () => {
  it('formats compact JSON with default indent', () => {
    const result = jsonPretty({ json: '{"a":1,"b":2}' });
    expect(result.pretty).toBe('{\n  "a": 1,\n  "b": 2\n}');
  });

  it('formats with custom indent', () => {
    const result = jsonPretty({ json: '{"a":1}', indent: 4 });
    expect(result.pretty).toBe('{\n    "a": 1\n}');
  });

  it('formats with zero indent (minified output)', () => {
    const result = jsonPretty({ json: '{"a":1}', indent: 0 });
    expect(result.pretty).toBe('{"a":1}');
  });

  it('clamps indent to maximum of 8', () => {
    const result = jsonPretty({ json: '{"a":1}', indent: 100 });
    expect(result.pretty).toBe('{\n        "a": 1\n}'); // 8 spaces
  });

  it('handles negative indent as 0 (minified)', () => {
    const result = jsonPretty({ json: '{"a":1}', indent: -5 });
    expect(result.pretty).toBe('{"a":1}');
  });

  it('handles arrays', () => {
    const result = jsonPretty({ json: '[1,2,3]' });
    expect(result.pretty).toBe('[\n  1,\n  2,\n  3\n]');
  });

  it('throws for invalid JSON', () => {
    expect(() => jsonPretty({ json: '{not valid json}' })).toThrow('Invalid JSON');
  });

  it('throws for non-string input', () => {
    expect(() => jsonPretty({ json: {} as unknown as string })).toThrow(
      'json must be a string'
    );
  });

  it('handles non-finite indent gracefully', () => {
    const result = jsonPretty({ json: '{"a":1}', indent: NaN });
    expect(result.pretty).toBe('{\n  "a": 1\n}'); // Falls back to default 2
  });
});

describe('jwtDecodeUnsafe', () => {
  // A valid JWT for testing (expired, but structure is valid)
  // Header: {"alg":"HS256","typ":"JWT"}
  // Payload: {"sub":"1234567890","name":"John Doe","iat":1516239022}
  const validJwt =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

  it('decodes a valid JWT with human-readable info', () => {
    const result = jwtDecodeUnsafe({ jwt: validJwt });
    expect(result.header).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(result.payload).toEqual({
      sub: '1234567890',
      name: 'John Doe',
      iat: 1516239022,
    });
    expect(result.humanReadable).toBeDefined();
    expect(result.humanReadable.subject).toBe('1234567890');
    expect(result.humanReadable.issuedAt).toContain('2018'); // iat: 1516239022 is Jan 2018
  });

  it('provides expiration info for JWT with exp claim', () => {
    // JWT with exp claim set to a past date
    // Payload: {"sub":"test","exp":1516239022,"iat":1516239000}
    const expiredJwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0IiwiZXhwIjoxNTE2MjM5MDIyLCJpYXQiOjE1MTYyMzkwMDB9.sig';
    const result = jwtDecodeUnsafe({ jwt: expiredJwt });
    expect(result.humanReadable.isExpired).toBe(true);
    expect(result.humanReadable.expiresAt).toContain('2018');
    expect(result.humanReadable.expiresIn).toContain('Expired');
  });

  it('includes issuer and audience in human-readable output', () => {
    // Payload: {"iss":"auth.example.com","aud":"api.example.com"}
    const jwtWithIssAud =
      'eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJhdXRoLmV4YW1wbGUuY29tIiwiYXVkIjoiYXBpLmV4YW1wbGUuY29tIn0.sig';
    const result = jwtDecodeUnsafe({ jwt: jwtWithIssAud });
    expect(result.humanReadable.issuer).toBe('auth.example.com');
    expect(result.humanReadable.audience).toBe('api.example.com');
  });

  it('decodes JWT with URL-safe base64 characters', () => {
    // JWT with - and _ characters in base64
    // This is a made-up JWT with URL-safe encoding
    const urlSafeJwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJ0ZXN0IjoidmFsdWUifQ.signature';
    const result = jwtDecodeUnsafe({ jwt: urlSafeJwt });
    expect(result.header).toEqual({ alg: 'HS256' });
    expect(result.payload).toEqual({ test: 'value' });
  });

  it('decodes JWT without signature (2 parts)', () => {
    const noSigJwt = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjM0In0';
    const result = jwtDecodeUnsafe({ jwt: noSigJwt });
    expect(result.header).toEqual({ alg: 'none' });
    expect(result.payload).toEqual({ sub: '1234' });
  });

  it('throws for JWT with less than 2 parts', () => {
    expect(() => jwtDecodeUnsafe({ jwt: 'onlyonepart' })).toThrow(
      'Invalid JWT format: must have at least 2 dot-separated parts'
    );
  });

  it('throws for empty string', () => {
    expect(() => jwtDecodeUnsafe({ jwt: '' })).toThrow(
      'Invalid JWT format: must have at least 2 dot-separated parts'
    );
  });

  it('throws for invalid header base64', () => {
    expect(() => jwtDecodeUnsafe({ jwt: '!!!.eyJ0ZXN0IjoxfQ.sig' })).toThrow(
      'Invalid base64url encoding'
    );
  });

  it('throws for invalid header JSON', () => {
    // "notjson" base64 encoded
    expect(() =>
      jwtDecodeUnsafe({ jwt: 'bm90anNvbg.eyJ0ZXN0IjoxfQ.sig' })
    ).toThrow('Invalid JWT header');
  });

  it('throws for invalid payload base64', () => {
    expect(() =>
      jwtDecodeUnsafe({ jwt: 'eyJhbGciOiJIUzI1NiJ9.!!!invalid!!!.sig' })
    ).toThrow('Invalid base64url encoding');
  });

  it('throws for invalid payload JSON', () => {
    // Valid header, but payload is "notjson" base64 encoded
    expect(() =>
      jwtDecodeUnsafe({ jwt: 'eyJhbGciOiJIUzI1NiJ9.bm90anNvbg.sig' })
    ).toThrow('Invalid JWT payload');
  });

  it('throws for non-string input', () => {
    expect(() => jwtDecodeUnsafe({ jwt: 12345 as unknown as string })).toThrow(
      'jwt must be a string'
    );
  });

  it('throws when header is not an object', () => {
    // Header is "test" (a string, not object)
    // btoa('"test"') = 'InRlc3Qi'
    expect(() =>
      jwtDecodeUnsafe({ jwt: 'InRlc3Qi.eyJ0ZXN0IjoxfQ.sig' })
    ).toThrow('Invalid JWT header');
  });

  it('throws when payload is not an object', () => {
    // Payload is [1,2,3] (an array, not object)
    // btoa('[1,2,3]') = 'WzEsMiwzXQ=='
    expect(() =>
      jwtDecodeUnsafe({ jwt: 'eyJhbGciOiJIUzI1NiJ9.WzEsMiwzXQ.sig' })
    ).toThrow('Invalid JWT payload');
  });
});
