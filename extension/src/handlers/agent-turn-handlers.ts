/**
 * Sidebar-facing handlers for Harbor's record of turns on the person's own
 * agent (page-api/agent-turns.ts). Only Harbor's own extension pages may
 * read the record or clear the toolbar badge: a page's content script must
 * not be able to read other sites' prompts, or hide what its agent did.
 */

import { registerExtensionPageHandler } from './extension-page-sender';
import { listAgentTurns, markAgentTurnsSeen } from '../page-api/agent-turns';

export function registerAgentTurnHandlers(): void {
  registerExtensionPageHandler('agent_turns.list', async () => {
    const turns = await listAgentTurns();
    return { ok: true, turns, unseen: turns.filter((t) => t.unseen).length };
  });

  registerExtensionPageHandler('agent_turns.mark_seen', async () => {
    await markAgentTurnsSeen();
    return { ok: true };
  });
}
