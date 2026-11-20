/**
 * The one set of page-API feature flags, and which transport messages each
 * one gates. No side effects, so the content script can import it as well
 * as the background.
 *
 * The injected page script keeps its own copy of the flags and defaults,
 * because it has to run standalone in the page; a test keeps that copy
 * matching this one.
 */

export const STORAGE_KEY = 'harbor-page-api-flags';

export interface FeatureFlags {
  /** window.ai: text sessions, prompts and provider info. Default: true */
  textGeneration: boolean;
  /** agent.run(): LLM-driven tool calling loops. Websites still need permission. Default: true */
  toolCalling: boolean;
  /** agent.tools.*: manual MCP tool access. Default: true */
  toolAccess: boolean;
  /** agent.browser.activeTab.*: click, fill, scroll, select on the calling tab. Default: false */
  browserInteraction: boolean;
  /** agent.browser.navigate/fetch/tabs/tab: multi-tab control and web fetch. Default: false */
  browserControl: boolean;
  /** agent.agents.*: agent-to-agent communication. Default: false */
  multiAgent: boolean;
}

export const DEFAULT_FLAGS: FeatureFlags = {
  textGeneration: true,
  toolCalling: true,
  toolAccess: true,
  browserInteraction: false,
  browserControl: false,
  multiAgent: false,
};

/** Names the sidebar shows for each flag. */
export const FEATURE_LABELS: Record<keyof FeatureFlags, string> = {
  textGeneration: 'Text Generation',
  toolCalling: 'Agentic Tool Use',
  toolAccess: 'Tool Access',
  browserInteraction: 'Browser Interaction',
  browserControl: 'Browser Control',
  multiAgent: 'Multi-Agent',
};

/**
 * The flags that can enable a transport message: it is allowed if any one of
 * them is on. An empty list means no flag gates the message.
 *
 * `session.prompt` and `session.promptStreaming` aren't listed: they serve
 * both window.ai text sessions (Text Generation) and explicit agent sessions
 * (not gated), so their handlers check the session's kind.
 */
export function featuresForMessage(type: string): Array<keyof FeatureFlags> {
  if (type.startsWith('ai.')) return ['textGeneration'];
  if (type === 'agent.run') return ['toolCalling'];
  if (type.startsWith('agent.tools.')) return ['toolAccess'];
  // agent.mcp.register follows Tool Access, the same as manual tool
  // access — discover and unregister don't (HBR-134, D3).
  if (type === 'agent.mcp.register') return ['toolAccess'];
  // The injected API offers readability with either browser setting.
  if (type === 'agent.browser.activeTab.readability') return ['browserInteraction', 'browserControl'];
  if (type.startsWith('agent.browser.activeTab.')) return ['browserInteraction'];
  if (type === 'agent.browser.navigate'
    || type === 'agent.browser.fetch'
    || type.startsWith('agent.browser.tabs.')
    || type.startsWith('agent.browser.tab.')) return ['browserControl'];
  if (type.startsWith('agent.agents.')) return ['multiAgent'];
  return [];
}

/** Why `type` is refused under `flags`, or null if it is allowed. */
export function featureRefusal(
  type: string,
  flags: FeatureFlags,
): { code: 'ERR_FEATURE_DISABLED'; message: string } | null {
  const features = featuresForMessage(type);
  if (features.length === 0 || features.some((f) => flags[f])) return null;
  return { code: 'ERR_FEATURE_DISABLED', message: `${FEATURE_LABELS[features[0]]} is disabled` };
}
