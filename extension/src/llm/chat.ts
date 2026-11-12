/** Native bridge chat adapter; response parsing is shared with extension pages. */
import { bridgeRequest } from './bridge-client';
import { normalizeChatResponse, type BridgeChatRequest, type ChatCompletion } from './chat-response';
export type { BridgeChatRequest } from './chat-response';

export async function bridgeChat(request: BridgeChatRequest): Promise<ChatCompletion> {
  return normalizeChatResponse(await bridgeRequest<unknown>('llm.chat', request));
}
