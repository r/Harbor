/**
 * Harbor Plugin: Decode - Background Script
 *
 * Provides decoding and formatting tools to Harbor.
 */

import {
  base64Encode,
  base64Decode,
  jsonPretty,
  jwtDecodeUnsafe,
  BASE64_ENCODE_DEFINITION,
  BASE64_DECODE_DEFINITION,
  JSON_PRETTY_DEFINITION,
  JWT_DECODE_DEFINITION,
  Base64EncodeInput,
  Base64DecodeInput,
  JsonPrettyInput,
  JwtDecodeInput,
} from '../tools/decode';
import { ToolError, toolNotFound } from '../errors';

// =============================================================================
// Constants
// =============================================================================

const HARBOR_HUB_EXTENSION_ID = 'raffi.krikorian.harbor@gmail.com';
const PLUGIN_ID = 'harbor-plugin-decode@local';
const PLUGIN_NAME = 'Harbor Plugin: Decode';
const PLUGIN_VERSION = '1.0.0';

const PLUGIN_NAMESPACE = 'harbor-plugin';
const PLUGIN_PROTOCOL_VERSION = 'harbor-plugin/v1';

const startupTime = Date.now();

// =============================================================================
// Types
// =============================================================================

interface PluginMessageEnvelope {
  namespace: string;
  protocolVersion: string;
  type: string;
  requestId: string;
  timestamp: number;
  payload: unknown;
}

interface ToolCallPayload {
  toolName: string;
  arguments: Record<string, unknown>;
  callingOrigin?: string;
}

// =============================================================================
// Tool Registry
// =============================================================================

const TOOLS = [
  BASE64_ENCODE_DEFINITION,
  BASE64_DECODE_DEFINITION,
  JSON_PRETTY_DEFINITION,
  JWT_DECODE_DEFINITION,
];

function executeTool(
  toolName: string,
  args: Record<string, unknown>
): unknown {
  switch (toolName) {
    case 'decode.base64_encode':
      return base64Encode(args as Base64EncodeInput);

    case 'decode.base64_decode':
      return base64Decode(args as Base64DecodeInput);

    case 'decode.json_pretty':
      return jsonPretty(args as JsonPrettyInput);

    case 'decode.jwt_decode_unsafe':
      return jwtDecodeUnsafe(args as JwtDecodeInput);

    default:
      throw toolNotFound(toolName);
  }
}

// =============================================================================
// Message Helpers
// =============================================================================

function generateRequestId(): string {
  return `decode-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function createMessage(
  type: string,
  payload: unknown,
  requestId?: string
): PluginMessageEnvelope {
  return {
    namespace: PLUGIN_NAMESPACE,
    protocolVersion: PLUGIN_PROTOCOL_VERSION,
    type,
    requestId: requestId ?? generateRequestId(),
    timestamp: Date.now(),
    payload,
  };
}

async function sendToHub(message: PluginMessageEnvelope): Promise<void> {
  try {
    await browser.runtime.sendMessage(HARBOR_HUB_EXTENSION_ID, message);
  } catch (err) {
    console.error('[DecodePlugin] Failed to send message to Hub:', err);
  }
}

// =============================================================================
// Message Handlers
// =============================================================================

async function handleToolCall(
  requestId: string,
  payload: ToolCallPayload
): Promise<void> {
  console.log('[DecodePlugin] Tool call:', payload.toolName);
  const startTime = Date.now();

  try {
    const result = executeTool(payload.toolName, payload.arguments);
    const executionTimeMs = Date.now() - startTime;

    await sendToHub(
      createMessage(
        'PLUGIN_TOOL_RESULT',
        { result, executionTimeMs },
        requestId
      )
    );
  } catch (err) {
    const toolError = err instanceof ToolError ? err : new ToolError(
      'EXECUTION_FAILED',
      err instanceof Error ? err.message : String(err)
    );

    await sendToHub(
      createMessage(
        'PLUGIN_TOOL_ERROR',
        {
          code: toolError.code,
          message: toolError.message,
          details: toolError.details,
        },
        requestId
      )
    );
  }
}

async function handlePing(requestId: string): Promise<void> {
  console.log('[DecodePlugin] Ping received');

  await sendToHub(
    createMessage(
      'PLUGIN_PONG',
      {
        healthy: true,
        uptime: Math.floor((Date.now() - startupTime) / 1000),
      },
      requestId
    )
  );
}

// =============================================================================
// External Message Listener
// =============================================================================

browser.runtime.onMessageExternal.addListener(
  (message: unknown, sender: browser.Runtime.MessageSender) => {
    if (sender.id !== HARBOR_HUB_EXTENSION_ID) {
      console.warn('[DecodePlugin] Ignoring message from unknown sender:', sender.id);
      return;
    }

    const envelope = message as PluginMessageEnvelope;

    if (envelope.namespace !== PLUGIN_NAMESPACE) {
      console.warn('[DecodePlugin] Ignoring message with wrong namespace:', envelope.namespace);
      return;
    }

    console.log('[DecodePlugin] Received message:', envelope.type);

    switch (envelope.type) {
      case 'PLUGIN_TOOL_CALL':
        handleToolCall(envelope.requestId, envelope.payload as ToolCallPayload);
        break;

      case 'PLUGIN_PING':
        handlePing(envelope.requestId);
        break;

      case 'PLUGIN_REGISTER_ACK': {
        const ack = envelope.payload as { success: boolean; error?: string };
        if (ack.success) {
          console.log('[DecodePlugin] Registration successful');
        } else {
          console.error('[DecodePlugin] Registration failed:', ack.error);
        }
        break;
      }

      default:
        console.warn('[DecodePlugin] Unknown message type:', envelope.type);
    }
  }
);

// =============================================================================
// Registration
// =============================================================================

async function registerWithHub(): Promise<void> {
  console.log('[DecodePlugin] Registering with Harbor Hub...');

  const registerMessage = createMessage('PLUGIN_REGISTER', {
    plugin: {
      extensionId: PLUGIN_ID,
      pluginId: PLUGIN_ID,
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      description: 'Decoding and formatting tools for Harbor',
      tools: TOOLS,
    },
  });

  try {
    await browser.runtime.sendMessage(HARBOR_HUB_EXTENSION_ID, registerMessage);
    console.log('[DecodePlugin] Registration message sent');
  } catch (err) {
    console.error('[DecodePlugin] Failed to register with Hub:', err);
    console.log('[DecodePlugin] Hub may not be installed. Will retry on Hub startup.');
  }
}

// Register on startup
registerWithHub();

console.log('[DecodePlugin] Background script initialized');
