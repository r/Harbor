import type { SourceTabReference } from '../contracts';

export const CHAT_TRANSPORT_PORT_NAME = 'harbor-chat-transport';

export type ChatTransportRequest = {
  id: string;
  type: string;
  payload?: unknown;
  source?: SourceTabReference;
};

export type ChatTransportMessage = ChatTransportRequest;

export type ChatTransportError = {
  code: string;
  message: string;
};

export type ChatTransportResponse = {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: ChatTransportError;
};

export type ChatTransportStreamEvent = {
  id: string;
  event: unknown;
  done?: boolean;
};
