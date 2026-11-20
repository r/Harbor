/**
 * Sender check shared by every handler that reads or writes ACP agent
 * configuration (`handlers/acp-agent-handlers.ts`): acp_get_agents,
 * acp_save_agents, acp_resolve_command, acp_check_agent, agent_backend_get
 * and agent_backend_set. `handlers/types.ts`'s `registerHandler` has no
 * sender check at all, so without this, any page or content script could
 * reach these the same way an extension page does.
 *
 * `acp_save_agents` controls what program the bridge spawns, so this
 * matters more than an ordinary permission check: a page that could call it
 * could make the bridge run an arbitrary command on the next `acp.open`.
 */
import { browserAPI } from '../browser-compat';
import { errorResponse, registerHandler, type HandlerResponse } from './types';

/**
 * True only for a message from one of Harbor's own extension pages (the
 * sidebar, a popup, agent-question.html, ...).
 *
 * A content script's `sender.id` is also Harbor's own extension id (it's
 * the content script that *Harbor* injected), so checking `sender.id`
 * alone would accept it. What tells the two apart is `sender.url`: a
 * content script reports the site's own URL (e.g. `https://example.com/`),
 * together with a `sender.tab` — never an extension-page URL. So this
 * checks the URL itself, not `sender.tab`'s presence or absence, and never
 * trusts `sender.tab` being unset as a proxy for "this is our own page".
 */
export function isExtensionPageSender(
  sender: { id?: string; url?: string } | null | undefined,
): boolean {
  if (!sender) return false;
  if (sender.id !== browserAPI.runtime.id) return false;
  if (typeof sender.url !== 'string' || sender.url.length === 0) return false;
  return sender.url.startsWith(browserAPI.runtime.getURL(''));
}

/**
 * Registers an async handler for `type`, refusing any sender that isn't
 * one of Harbor's own extension pages (see `isExtensionPageSender`). The
 * refusal carries no detail beyond "not available to this sender" — it's
 * not a permission the person can grant, so there's nothing more useful to
 * say than for an unknown message type.
 */
export function registerExtensionPageHandler(
  type: string,
  handler: (
    message: Record<string, unknown>,
    sender: chrome.runtime.MessageSender,
  ) => Promise<HandlerResponse>,
): void {
  registerHandler(type, (message, sender, sendResponse) => {
    if (!isExtensionPageSender(sender)) {
      sendResponse({ ok: false, error: 'Not available to this sender' });
      return true;
    }
    handler(message, sender)
      .then(sendResponse)
      .catch((error) => sendResponse(errorResponse(error)));
    return true;
  });
}
