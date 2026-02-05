/**
 * Router-specific types for request/response handling.
 */

import type {
  MessageType,
  TransportResponse,
  TransportStreamEvent,
  PermissionScope,
} from '../types';

/**
 * Context for an incoming request from a web page or extension.
 */
export interface RequestContext {
  id: string;
  type: MessageType;
  payload: unknown;
  origin: string;
  tabId?: number;
  /** The extension ID of the sender (for cross-extension messaging) */
  senderExtensionId?: string;
  /** Firefox container ID - used to open new tabs in the same container as the parent */
  cookieStoreId?: string;
}

/**
 * Interface for sending responses back to the requester.
 */
export type ResponseSender = {
  sendResponse: (response: TransportResponse) => void;
  sendStreamEvent: (event: TransportStreamEvent) => void;
};

/**
 * Type for handler functions.
 */
export type RequestHandler = (
  ctx: RequestContext,
  sender: ResponseSender,
) => Promise<void> | void;
