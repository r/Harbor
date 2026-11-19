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
  /** Firefox container ID - used to open new tabs in the same container as the parent */
  cookieStoreId?: string;
  /**
   * Aborts when the caller stops waiting (a page's request timed out, or
   * Harbor's own request timer ran out). `requireAction` refuses a call
   * whose signal aborted while its policy check ran.
   */
  signal?: AbortSignal;
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
