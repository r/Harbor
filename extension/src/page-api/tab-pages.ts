/**
 * The page each tab shows now, as the page API sees it: every page
 * connection is numbered, and each tab keeps its latest one with when it
 * connected. A reloaded or navigated page's old connection can close after
 * the new one opens, so "latest" is what tells the two apart.
 */
const latestPages = new Map<number, { connection: number; at: number }>();

export function notePageConnected(tabId: number, connection: number, at = Date.now()): void {
  latestPages.set(tabId, { connection, at });
}

export function latestPage(tabId: number): { connection: number; at: number } | undefined {
  return latestPages.get(tabId);
}

/** The tab's page went and no newer one has connected. */
export function forgetLatestPage(tabId: number): void {
  latestPages.delete(tabId);
}
