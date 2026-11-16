/**
 * Harbor extension IDs the Web Agents API talks to and accepts messages from.
 *
 * Discovery tries these IDs, and every external listener checks the sender
 * against them before acting on a message.
 *
 * Chrome's `externally_connectable.ids` in manifest.chrome.json must list the
 * same Chrome ID. Firefox ignores `externally_connectable`, so the runtime
 * check is the only enforcement there.
 */
export const KNOWN_HARBOR_IDS: readonly string[] = [
  // Firefox (gecko) ID, from extension/manifest.json
  'harbor@krikorian.co',
  // Chrome ID, derived from the key in extension/manifest.chrome.json.
  // Everyone loading from the repo gets this same ID.
  'ljnciidcajlichemnbohopnlaonhkpgm',
  // Safari extension bundle identifier
  'org.harbor.Extension',
];

/** True only when the message comes from a known Harbor extension. */
export function isHarborSender(sender: { id?: string } | undefined | null): boolean {
  const id = sender?.id;
  return typeof id === 'string' && KNOWN_HARBOR_IDS.includes(id);
}
