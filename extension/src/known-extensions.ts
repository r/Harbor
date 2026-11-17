/**
 * Extensions Harbor trusts to send it cross-extension messages.
 *
 * Harbor's external API (llm.*, mcp.*, session.*, system.*, permissions.*, agent.*) is for
 * the Web Agents API extension only. Every onMessageExternal and
 * onConnectExternal listener checks the sender against this list before
 * reading anything else from the message.
 *
 * Chrome's `externally_connectable.ids` in manifest.chrome.json must list the
 * same Chrome ID. Firefox ignores `externally_connectable`, so this runtime
 * check is the only enforcement there.
 */

/** Web Agents API's Firefox (gecko) ID, from web-agents-api/manifest.json. */
export const WEB_AGENTS_API_FIREFOX_ID = 'web-agents@krikorian.co';

/** Web Agents API's Chrome ID, derived from the key in web-agents-api/manifest.chrome.json. */
export const WEB_AGENTS_API_CHROME_ID = 'ogmmelahbpdfnmgemkcbpoaekdnfdapn';

export const WEB_AGENTS_API_EXTENSION_IDS: readonly string[] = [
  WEB_AGENTS_API_FIREFOX_ID,
  WEB_AGENTS_API_CHROME_ID,
];

/** True only when the message or port comes from the Web Agents API extension. */
export function isTrustedExtensionSender(sender: { id?: string } | undefined | null): boolean {
  const id = sender?.id;
  return typeof id === 'string' && WEB_AGENTS_API_EXTENSION_IDS.includes(id);
}
