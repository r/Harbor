#!/usr/bin/env node
/**
 * Harbor Bridge - Native messaging bridge for Harbor Firefox extension.
 * 
 * This is the main entry point that runs the bridge loop,
 * reading messages from stdin and writing responses to stdout.
 */

import { readMessages, writeMessage, log, NativeMessagingError, MessageTooLargeError, InvalidMessageError } from './native-messaging.js';
import { dispatchMessage } from './handlers.js';
import { Message } from './types.js';
import { warmExecutableCache } from './utils/resolve-executable.js';

const VERSION = '0.1.0';

async function runBridge(): Promise<void> {
  log(`Harbor Bridge v${VERSION} starting...`);
  
  // Warm up executable cache (find npx, node, etc.)
  warmExecutableCache();

  try {
    for await (const message of readMessages()) {
      try {
        log(`Received: type=${message.type}, request_id=${message.request_id}`);

        const response = await dispatchMessage(message as Message);
        writeMessage(response as Record<string, unknown>);

        log(`Sent: type=${response.type}`);
      } catch (error) {
        log(`Error processing message: ${error}`);
        
        if (error instanceof MessageTooLargeError) {
          writeMessage({
            type: 'error',
            request_id: '',
            error: {
              code: 'message_too_large',
              message: error.message,
            },
          });
        } else if (error instanceof InvalidMessageError) {
          writeMessage({
            type: 'error',
            request_id: '',
            error: {
              code: 'invalid_message',
              message: error.message,
            },
          });
        } else if (error instanceof NativeMessagingError) {
          // Connection error, break the loop
          break;
        } else {
          writeMessage({
            type: 'error',
            request_id: (message as Message).request_id || '',
            error: {
              code: 'internal_error',
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }
    }
  } catch (error) {
    log(`Fatal error: ${error}`);
    if (error instanceof Error && error.message.includes('EOF')) {
      log('EOF received, shutting down');
    } else {
      throw error;
    }
  }

  log('Harbor Bridge shutting down');
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  log('Interrupted by user');
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('Terminated');
  process.exit(0);
});

// Run the bridge
runBridge().catch((error) => {
  log(`Fatal error: ${error}`);
  process.exit(1);
});

