/**
 * Decode tools implementation.
 */

import { invalidArgument, inputTooLarge } from '../errors';

// Maximum input size (1MB)
const MAX_INPUT_SIZE = 1024 * 1024;

// =============================================================================
// Tool Definitions
// =============================================================================

export const BASE64_ENCODE_DEFINITION = {
  name: 'decode.base64_encode',
  title: 'Base64 Encode',
  description: 'Encodes text to base64. Returns the encoded string along with size information.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      text: {
        type: 'string' as const,
        description: 'Text to encode',
      },
    },
    required: ['text'],
  },
  outputSchema: {
    type: 'object' as const,
    properties: {
      base64: { type: 'string' as const, description: 'Base64 encoded string' },
      originalLength: { type: 'number' as const, description: 'Original text length in characters' },
      encodedLength: { type: 'number' as const, description: 'Encoded string length' },
    },
    required: ['base64', 'originalLength', 'encodedLength'],
  },
};

export const BASE64_DECODE_DEFINITION = {
  name: 'decode.base64_decode',
  title: 'Base64 Decode',
  description: 'Decodes base64 to text. Returns the decoded string along with size information.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      base64: {
        type: 'string' as const,
        description: 'Base64 encoded string',
      },
    },
    required: ['base64'],
  },
  outputSchema: {
    type: 'object' as const,
    properties: {
      text: { type: 'string' as const, description: 'Decoded text' },
      encodedLength: { type: 'number' as const, description: 'Original base64 length' },
      decodedLength: { type: 'number' as const, description: 'Decoded text length in characters' },
    },
    required: ['text', 'encodedLength', 'decodedLength'],
  },
};

export const JSON_PRETTY_DEFINITION = {
  name: 'decode.json_pretty',
  title: 'JSON Pretty Print',
  description: 'Formats JSON with indentation.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      json: {
        type: 'string' as const,
        description: 'JSON string to format',
      },
      indent: {
        type: 'number' as const,
        description: 'Indentation spaces (0-8, default 2)',
        minimum: 0,
        maximum: 8,
        default: 2,
      },
    },
    required: ['json'],
  },
  outputSchema: {
    type: 'object' as const,
    properties: {
      pretty: { type: 'string' as const, description: 'Formatted JSON string' },
    },
    required: ['pretty'],
  },
};

export const JWT_DECODE_DEFINITION = {
  name: 'decode.jwt_decode_unsafe',
  title: 'JWT Decode (Unsafe)',
  description: 'Decodes JWT header and payload WITHOUT signature verification. Returns human-readable timestamps for common claims.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      jwt: {
        type: 'string' as const,
        description: 'JWT string',
      },
    },
    required: ['jwt'],
  },
  outputSchema: {
    type: 'object' as const,
    properties: {
      header: { type: 'object' as const, description: 'Decoded JWT header' },
      payload: { type: 'object' as const, description: 'Decoded JWT payload' },
      humanReadable: {
        type: 'object' as const,
        description: 'Human-readable interpretation of common claims',
        properties: {
          issuedAt: { type: 'string' as const },
          expiresAt: { type: 'string' as const },
          notBefore: { type: 'string' as const },
          isExpired: { type: 'boolean' as const },
          expiresIn: { type: 'string' as const },
        },
      },
    },
    required: ['header', 'payload'],
  },
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check input size and throw if too large.
 */
function checkSize(input: string, fieldName: string): void {
  const size = new Blob([input]).size;
  if (size > MAX_INPUT_SIZE) {
    throw inputTooLarge(size, MAX_INPUT_SIZE);
  }
}

/**
 * Decode base64url to string.
 * Handles URL-safe base64 (replaces - with +, _ with /) and adds padding.
 */
function base64UrlDecode(input: string): string {
  // Replace URL-safe characters
  let base64 = input.replace(/-/g, '+').replace(/_/g, '/');

  // Add padding if needed
  const padding = base64.length % 4;
  if (padding === 2) {
    base64 += '==';
  } else if (padding === 3) {
    base64 += '=';
  }

  try {
    return atob(base64);
  } catch {
    throw invalidArgument('Invalid base64url encoding');
  }
}

// =============================================================================
// Tool Implementations
// =============================================================================

export interface Base64EncodeInput {
  text: string;
}

export interface Base64EncodeResult {
  base64: string;
  originalLength: number;
  encodedLength: number;
}

export function base64Encode(input: Base64EncodeInput): Base64EncodeResult {
  if (typeof input.text !== 'string') {
    throw invalidArgument('text must be a string');
  }

  checkSize(input.text, 'text');

  // Use btoa with UTF-8 encoding support
  const bytes = new TextEncoder().encode(input.text);
  const binary = String.fromCharCode(...bytes);
  const base64 = btoa(binary);

  return {
    base64,
    originalLength: input.text.length,
    encodedLength: base64.length,
  };
}

export interface Base64DecodeInput {
  base64: string;
}

export interface Base64DecodeResult {
  text: string;
  encodedLength: number;
  decodedLength: number;
}

export function base64Decode(input: Base64DecodeInput): Base64DecodeResult {
  if (typeof input.base64 !== 'string') {
    throw invalidArgument('base64 must be a string');
  }

  checkSize(input.base64, 'base64');

  try {
    const binary = atob(input.base64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);
    return {
      text,
      encodedLength: input.base64.length,
      decodedLength: text.length,
    };
  } catch (err) {
    throw invalidArgument(
      'Invalid base64 string',
      { error: err instanceof Error ? err.message : String(err) }
    );
  }
}

export interface JsonPrettyInput {
  json: string;
  indent?: number;
}

export interface JsonPrettyResult {
  pretty: string;
}

export function jsonPretty(input: JsonPrettyInput): JsonPrettyResult {
  if (typeof input.json !== 'string') {
    throw invalidArgument('json must be a string');
  }

  checkSize(input.json, 'json');

  // Validate and clamp indent
  let indent = input.indent ?? 2;
  if (typeof indent !== 'number' || !Number.isFinite(indent)) {
    indent = 2;
  }
  indent = Math.max(0, Math.min(8, Math.floor(indent)));

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.json);
  } catch (err) {
    throw invalidArgument(
      'Invalid JSON',
      { error: err instanceof Error ? err.message : String(err) }
    );
  }

  const pretty = JSON.stringify(parsed, null, indent);
  return { pretty };
}

export interface JwtDecodeInput {
  jwt: string;
}

export interface JwtHumanReadable {
  issuedAt?: string;
  expiresAt?: string;
  notBefore?: string;
  isExpired?: boolean;
  expiresIn?: string;
  subject?: string;
  issuer?: string;
  audience?: string;
}

export interface JwtDecodeResult {
  header: object;
  payload: object;
  humanReadable: JwtHumanReadable;
}

/**
 * Format a Unix timestamp to human-readable string.
 */
function formatTimestamp(ts: number): string {
  const date = new Date(ts * 1000);
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).format(date);
}

/**
 * Format duration to human-readable string.
 */
function formatDuration(ms: number): string {
  const absMs = Math.abs(ms);
  const seconds = Math.floor(absMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    const remainingHours = hours % 24;
    return remainingHours > 0 ? `${days} days, ${remainingHours} hours` : `${days} days`;
  }
  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours} hours, ${remainingMinutes} minutes` : `${hours} hours`;
  }
  if (minutes > 0) {
    return `${minutes} minutes`;
  }
  return `${seconds} seconds`;
}

export function jwtDecodeUnsafe(input: JwtDecodeInput): JwtDecodeResult {
  if (typeof input.jwt !== 'string') {
    throw invalidArgument('jwt must be a string');
  }

  checkSize(input.jwt, 'jwt');

  // Split JWT into parts
  const parts = input.jwt.split('.');
  if (parts.length < 2) {
    throw invalidArgument(
      'Invalid JWT format: must have at least 2 dot-separated parts',
      { partsCount: parts.length }
    );
  }

  // Decode header
  let header: object;
  try {
    const headerJson = base64UrlDecode(parts[0]);
    header = JSON.parse(headerJson);
    if (typeof header !== 'object' || header === null || Array.isArray(header)) {
      throw new Error('Header is not an object');
    }
  } catch (err) {
    if (err instanceof ToolError) throw err;
    throw invalidArgument(
      'Invalid JWT header: ' + (err instanceof Error ? err.message : String(err))
    );
  }

  // Decode payload
  let payload: Record<string, unknown>;
  try {
    const payloadJson = base64UrlDecode(parts[1]);
    payload = JSON.parse(payloadJson);
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new Error('Payload is not an object');
    }
  } catch (err) {
    if (err instanceof ToolError) throw err;
    throw invalidArgument(
      'Invalid JWT payload: ' + (err instanceof Error ? err.message : String(err))
    );
  }

  // Build human-readable interpretation
  const humanReadable: JwtHumanReadable = {};
  const now = Date.now();

  // Standard claims
  if (typeof payload.iat === 'number') {
    humanReadable.issuedAt = formatTimestamp(payload.iat);
  }

  if (typeof payload.exp === 'number') {
    humanReadable.expiresAt = formatTimestamp(payload.exp);
    const expMs = payload.exp * 1000;
    humanReadable.isExpired = now > expMs;
    const diff = expMs - now;
    if (diff > 0) {
      humanReadable.expiresIn = formatDuration(diff);
    } else {
      humanReadable.expiresIn = `Expired ${formatDuration(-diff)} ago`;
    }
  }

  if (typeof payload.nbf === 'number') {
    humanReadable.notBefore = formatTimestamp(payload.nbf);
  }

  if (typeof payload.sub === 'string') {
    humanReadable.subject = payload.sub;
  }

  if (typeof payload.iss === 'string') {
    humanReadable.issuer = payload.iss;
  }

  if (typeof payload.aud === 'string') {
    humanReadable.audience = payload.aud;
  } else if (Array.isArray(payload.aud)) {
    humanReadable.audience = payload.aud.join(', ');
  }

  return { header, payload, humanReadable };
}

// Need ToolError for the type guard
import { ToolError } from '../errors';
