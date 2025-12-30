/**
 * Native messaging protocol implementation for Firefox extensions.
 * 
 * Messages are framed with a 4-byte little-endian length prefix,
 * followed by JSON-encoded UTF-8 text.
 */

import { stdin, stdout, stderr } from 'node:process';

// Maximum message size (1 MB, Firefox's limit)
const MAX_MESSAGE_SIZE = 1024 * 1024;

export class NativeMessagingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NativeMessagingError';
  }
}

export class MessageTooLargeError extends NativeMessagingError {
  constructor(size: number) {
    super(`Message size ${size} exceeds maximum ${MAX_MESSAGE_SIZE}`);
    this.name = 'MessageTooLargeError';
  }
}

export class InvalidMessageError extends NativeMessagingError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMessageError';
  }
}

/**
 * Encode a message for native messaging.
 */
export function encodeMessage(message: Record<string, unknown>): Buffer {
  const payload = Buffer.from(JSON.stringify(message), 'utf-8');
  
  if (payload.length > MAX_MESSAGE_SIZE) {
    throw new MessageTooLargeError(payload.length);
  }
  
  const lengthPrefix = Buffer.alloc(4);
  lengthPrefix.writeUInt32LE(payload.length, 0);
  
  return Buffer.concat([lengthPrefix, payload]);
}

/**
 * Write a message to stdout.
 */
export function writeMessage(message: Record<string, unknown>): void {
  const encoded = encodeMessage(message);
  stdout.write(encoded);
}

/**
 * Log to stderr (for debugging - doesn't interfere with native messaging).
 */
export function log(...args: unknown[]): void {
  const timestamp = new Date().toISOString();
  stderr.write(`[${timestamp}] ${args.map(a => 
    typeof a === 'object' ? JSON.stringify(a) : String(a)
  ).join(' ')}\n`);
}

/**
 * Read messages from stdin asynchronously.
 * Yields decoded message objects.
 */
export async function* readMessages(): AsyncGenerator<Record<string, unknown>> {
  let buffer = Buffer.alloc(0);
  
  for await (const chunk of stdin) {
    buffer = Buffer.concat([buffer, chunk as Buffer]);
    
    // Process complete messages
    while (buffer.length >= 4) {
      const messageLength = buffer.readUInt32LE(0);
      
      if (messageLength > MAX_MESSAGE_SIZE) {
        throw new MessageTooLargeError(messageLength);
      }
      
      const totalLength = 4 + messageLength;
      if (buffer.length < totalLength) {
        // Wait for more data
        break;
      }
      
      // Extract and parse the message
      const payload = buffer.subarray(4, totalLength);
      buffer = buffer.subarray(totalLength);
      
      try {
        const message = JSON.parse(payload.toString('utf-8'));
        if (typeof message !== 'object' || message === null) {
          throw new InvalidMessageError('Expected JSON object');
        }
        yield message as Record<string, unknown>;
      } catch (e) {
        if (e instanceof SyntaxError) {
          throw new InvalidMessageError(`Invalid JSON: ${e.message}`);
        }
        throw e;
      }
    }
  }
}





