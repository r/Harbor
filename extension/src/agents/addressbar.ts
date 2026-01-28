/**
 * Address Bar (Omnibox) Integration Module
 *
 * Manages address bar providers and integrates with Chrome's omnibox API.
 * Supports:
 * - AI-powered search suggestions
 * - Smart navigation
 * - Tool shortcuts (@time, @calc, etc.)
 * - Site-specific providers
 */

import { browserAPI } from '../browser-compat';
import type {
  AddressBarTrigger,
  AddressBarQueryContext,
  AddressBarSuggestion,
  AddressBarAction,
  AddressBarProviderOptions,
  AddressBarProviderInfo,
  StoredAddressBarProvider,
  ToolShortcutsOptions,
  ToolShortcut,
  SiteProviderOptions,
  DeclaredAddressBarProvider,
  RunEvent,
} from './types';

import { runAgent } from './orchestrator';

// =============================================================================
// Storage
// =============================================================================

const STORAGE_KEY = 'harbor_addressbar_providers';
const DEFAULT_PROVIDER_KEY = 'harbor_addressbar_default';

// In-memory provider cache
const providers = new Map<string, StoredAddressBarProvider>();
let defaultProviderId: string | null = null;

// Pending queries from content scripts (for callback-based providers)
const pendingQueries = new Map<string, {
  resolve: (suggestions: AddressBarSuggestion[]) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}>();

// =============================================================================
// Initialization
// =============================================================================

/**
 * Initialize the address bar module.
 */
export async function initializeAddressBar(): Promise<void> {
  // Load stored providers
  const result = await browserAPI.storage.local.get([STORAGE_KEY, DEFAULT_PROVIDER_KEY]);
  const stored = (result[STORAGE_KEY] || []) as StoredAddressBarProvider[];
  defaultProviderId = (result[DEFAULT_PROVIDER_KEY] as string | undefined) || null;

  for (const provider of stored) {
    providers.set(provider.id, provider);
  }

  // Set up omnibox listener
  setupOmniboxListeners();

  console.log('[Harbor] Address bar module initialized with', providers.size, 'providers');
}

/**
 * Set up Chrome omnibox event listeners.
 */
function setupOmniboxListeners(): void {
  // Input started
  browserAPI.omnibox.onInputStarted.addListener(() => {
    console.log('[Harbor] Omnibox input started');
  });

  // Input changed - provide suggestions
  browserAPI.omnibox.onInputChanged.addListener(async (text, suggest) => {
    try {
      const suggestions = await getSuggestions(text);
      suggest(suggestions.map(toOmniboxSuggestion));
    } catch (error) {
      console.error('[Harbor] Omnibox suggestion error:', error);
      suggest([]);
    }
  });

  // Input entered - execute action
  browserAPI.omnibox.onInputEntered.addListener(async (text, disposition) => {
    try {
      await handleSelection(text, disposition as Parameters<Parameters<typeof browserAPI.omnibox.onInputEntered.addListener>[0]>[1]);
    } catch (error) {
      console.error('[Harbor] Omnibox action error:', error);
    }
  });

  // Input cancelled
  browserAPI.omnibox.onInputCancelled.addListener(() => {
    console.log('[Harbor] Omnibox input cancelled');
  });
}

// =============================================================================
// Provider Management
// =============================================================================

/**
 * Check if address bar integration is available.
 */
export function canProvide(): 'readily' | 'no' {
  // Check if omnibox API is available
  return browserAPI.omnibox ? 'readily' : 'no';
}

/**
 * Register an AI-powered provider.
 */
export async function registerProvider(
  origin: string,
  options: AddressBarProviderOptions,
): Promise<{ providerId: string }> {
  const provider: StoredAddressBarProvider = {
    id: options.id,
    name: options.name,
    description: options.description,
    triggers: options.triggers,
    origin,
    type: 'ai',
    createdAt: Date.now(),
  };

  providers.set(provider.id, provider);
  await saveProviders();

  // Update omnibox default suggestion based on triggers
  updateOmniboxDefaultSuggestion();

  return { providerId: provider.id };
}

/**
 * Register tool shortcuts.
 */
export async function registerToolShortcuts(
  origin: string,
  options: ToolShortcutsOptions,
): Promise<{ registered: string[] }> {
  const registered: string[] = [];

  for (const shortcut of options.shortcuts) {
    const providerId = `tool-${shortcut.trigger.replace(/^@/, '')}`;

    const provider: StoredAddressBarProvider = {
      id: providerId,
      name: shortcut.description,
      description: shortcut.description,
      triggers: [
        {
          type: 'prefix',
          value: shortcut.trigger + ' ',
          hint: shortcut.examples?.[0] || `${shortcut.trigger} <query>`,
        },
      ],
      origin,
      type: 'tool',
      shortcuts: [shortcut],
      resultHandler: options.resultHandler,
      createdAt: Date.now(),
    };

    providers.set(providerId, provider);
    registered.push(shortcut.trigger);
  }

  await saveProviders();
  updateOmniboxDefaultSuggestion();

  return { registered };
}

/**
 * Register a site-specific provider.
 */
export async function registerSiteProvider(
  options: SiteProviderOptions,
): Promise<{ providerId: string }> {
  const providerId = `site-${new URL(options.origin).hostname}`;

  const provider: StoredAddressBarProvider = {
    id: providerId,
    name: options.name,
    description: options.description,
    triggers: options.patterns.map((p) => ({
      type: 'prefix' as const,
      value: p.replace('*', ''),
      hint: `Search ${options.name}`,
    })),
    origin: options.origin,
    type: 'site',
    patterns: options.patterns,
    endpoint: options.endpoint,
    createdAt: Date.now(),
  };

  providers.set(providerId, provider);
  await saveProviders();
  updateOmniboxDefaultSuggestion();

  return { providerId };
}

/**
 * List all registered providers.
 */
export function listProviders(): AddressBarProviderInfo[] {
  return Array.from(providers.values()).map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    triggers: p.triggers,
    isDefault: p.id === defaultProviderId,
    origin: p.origin,
    type: p.type,
  }));
}

/**
 * Unregister a provider.
 */
export async function unregisterProvider(providerId: string): Promise<void> {
  providers.delete(providerId);

  if (defaultProviderId === providerId) {
    defaultProviderId = null;
    await browserAPI.storage.local.remove(DEFAULT_PROVIDER_KEY);
  }

  await saveProviders();
  updateOmniboxDefaultSuggestion();
}

/**
 * Set the default provider.
 */
export async function setDefaultProvider(providerId: string): Promise<void> {
  if (!providers.has(providerId)) {
    throw new Error(`Provider not found: ${providerId}`);
  }

  defaultProviderId = providerId;
  await browserAPI.storage.local.set({ [DEFAULT_PROVIDER_KEY]: providerId });
  updateOmniboxDefaultSuggestion();
}

/**
 * Get the default provider ID.
 */
export function getDefaultProvider(): string | null {
  return defaultProviderId;
}

// =============================================================================
// Suggestion Generation
// =============================================================================

// Track last keystroke for debouncing
let lastKeystroke = Date.now();

/**
 * Get suggestions for input text.
 */
async function getSuggestions(text: string): Promise<AddressBarSuggestion[]> {
  const now = Date.now();
  const timeSinceLastKeystroke = now - lastKeystroke;
  lastKeystroke = now;

  const suggestions: AddressBarSuggestion[] = [];

  // Find matching providers
  for (const [, provider] of providers) {
    const matchingTrigger = findMatchingTrigger(text, provider.triggers);

    if (matchingTrigger) {
      const query = extractQuery(text, matchingTrigger);

      if (provider.type === 'tool' && provider.shortcuts) {
        // Handle tool shortcuts
        const toolSuggestions = await getToolSuggestions(provider, query);
        suggestions.push(...toolSuggestions);
      } else if (provider.type === 'site' && provider.endpoint) {
        // Handle site providers with endpoint
        const siteSuggestions = await getSiteEndpointSuggestions(provider, query);
        suggestions.push(...siteSuggestions);
      } else {
        // Handle AI providers - need to call back to content script
        const aiSuggestions = await getAIProviderSuggestions(provider, query, {
          query,
          trigger: matchingTrigger,
          isTyping: timeSinceLastKeystroke < 300,
          timeSinceLastKeystroke,
        });
        suggestions.push(...aiSuggestions);
      }
    }
  }

  // Sort by confidence
  suggestions.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

  return suggestions.slice(0, 8); // Omnibox typically shows ~8 suggestions
}

/**
 * Find a trigger that matches the input.
 */
function findMatchingTrigger(
  text: string,
  triggers: AddressBarTrigger[],
): AddressBarTrigger | null {
  for (const trigger of triggers) {
    switch (trigger.type) {
      case 'prefix':
        if (text.startsWith(trigger.value)) {
          return trigger;
        }
        break;
      case 'keyword':
        if (text.split(/\s+/)[0] === trigger.value) {
          return trigger;
        }
        break;
      case 'regex':
        if (new RegExp(trigger.value).test(text)) {
          return trigger;
        }
        break;
      case 'always':
        return trigger;
    }
  }
  return null;
}

/**
 * Extract the query part from input based on trigger.
 */
function extractQuery(text: string, trigger: AddressBarTrigger): string {
  switch (trigger.type) {
    case 'prefix':
      return text.slice(trigger.value.length).trim();
    case 'keyword':
      return text.split(/\s+/).slice(1).join(' ').trim();
    default:
      return text.trim();
  }
}

/**
 * Get suggestions from tool shortcuts.
 */
async function getToolSuggestions(
  provider: StoredAddressBarProvider,
  query: string,
): Promise<AddressBarSuggestion[]> {
  const suggestions: AddressBarSuggestion[] = [];

  if (!provider.shortcuts) return suggestions;

  for (const shortcut of provider.shortcuts) {
    // If no query yet, show the shortcut itself
    if (!query) {
      suggestions.push({
        id: `${provider.id}-hint`,
        type: 'action',
        title: shortcut.trigger,
        description: shortcut.description,
        provider: provider.id,
        confidence: 1,
        action: { type: 'show', content: shortcut.examples?.join('\n') || '', format: 'text' },
      });
      continue;
    }

    // Parse arguments
    let args: Record<string, unknown> = {};
    
    if (shortcut.useLLMParser) {
      // TODO: Use LLM to parse args
      args = { query };
    } else if (shortcut.argParser) {
      // Use built-in parsers
      args = parseToolArgs(shortcut.argParser, query);
    } else {
      // Default: pass query as first arg
      args = { query };
    }

    suggestions.push({
      id: `${provider.id}-${query}`,
      type: 'tool',
      title: `${shortcut.trigger} ${query}`,
      description: `Run ${shortcut.tool}`,
      provider: provider.id,
      confidence: 0.9,
      tool: {
        name: shortcut.tool,
        args,
      },
    });
  }

  return suggestions;
}

/**
 * Parse tool arguments using built-in parsers.
 */
function parseToolArgs(parserName: string, query: string): Record<string, unknown> {
  // Built-in parsers
  switch (parserName) {
    case 'timezone':
      return { timezone: query || 'local' };
    case 'expression':
      return { expression: query };
    case 'location':
      return { location: query };
    case 'searchQuery':
      return { query, count: 5 };
    case 'content':
      return { content: query, metadata: { source: 'addressbar' } };
    default:
      return { query };
  }
}

/**
 * Get suggestions from a site endpoint.
 */
async function getSiteEndpointSuggestions(
  provider: StoredAddressBarProvider,
  query: string,
): Promise<AddressBarSuggestion[]> {
  if (!provider.endpoint || !query) return [];

  try {
    const response = await fetch(provider.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) return [];

    const suggestions = await response.json() as AddressBarSuggestion[];
    return suggestions.map((s) => ({ ...s, provider: provider.id }));
  } catch {
    return [];
  }
}

/**
 * Get suggestions from an AI provider (via content script callback).
 */
async function getAIProviderSuggestions(
  provider: StoredAddressBarProvider,
  query: string,
  context: Partial<AddressBarQueryContext>,
): Promise<AddressBarSuggestion[]> {
  // For AI providers, we need to communicate back to the content script
  // that registered them. This is done via a pending query system.
  
  // For now, return empty - the full implementation would involve:
  // 1. Sending a message to the tab that registered the provider
  // 2. Waiting for the callback response
  // 3. Returning the suggestions
  
  // This requires tracking which tab registered each provider
  // and maintaining that connection
  
  console.log('[Harbor] AI provider query:', provider.id, query, context);
  return [];
}

// =============================================================================
// Selection Handling
// =============================================================================

// Store for looking up selected suggestions
const recentSuggestions = new Map<string, AddressBarSuggestion>();

/**
 * Handle when user selects a suggestion.
 */
async function handleSelection(
  text: string,
  disposition: Parameters<Parameters<typeof browserAPI.omnibox.onInputEntered.addListener>[0]>[1],
): Promise<void> {
  // Check if this matches a recent suggestion
  const suggestion = recentSuggestions.get(text);

  if (suggestion) {
    await executeSuggestionAction(suggestion, disposition);
  } else {
    // Treat as a search query
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(text)}`;
    await navigateTo(searchUrl, disposition);
  }
}

/**
 * Execute the action for a suggestion.
 */
async function executeSuggestionAction(
  suggestion: AddressBarSuggestion,
  disposition: Parameters<Parameters<typeof browserAPI.omnibox.onInputEntered.addListener>[0]>[1],
): Promise<void> {
  switch (suggestion.type) {
    case 'url':
      if (suggestion.url) {
        await navigateTo(suggestion.url, disposition);
      }
      break;

    case 'search':
      const searchQuery = suggestion.searchQuery || suggestion.title;
      const engine = suggestion.searchEngine || 'google';
      const searchUrl = getSearchUrl(engine, searchQuery);
      await navigateTo(searchUrl, disposition);
      break;

    case 'tool':
      if (suggestion.tool) {
        await executeTool(suggestion.tool.name, suggestion.tool.args, suggestion.provider);
      }
      break;

    case 'action':
      if (suggestion.action) {
        await executeAction(suggestion.action, disposition);
      }
      break;

    case 'answer':
      if (suggestion.answer?.copyable) {
        await copyToClipboard(suggestion.answer.text);
      }
      break;
  }
}

/**
 * Execute a custom action.
 */
async function executeAction(
  action: AddressBarAction,
  disposition: Parameters<Parameters<typeof browserAPI.omnibox.onInputEntered.addListener>[0]>[1],
): Promise<void> {
  switch (action.type) {
    case 'navigate':
      await navigateTo(action.url, disposition);
      break;

    case 'search':
      const searchUrl = getSearchUrl(action.engine || 'google', action.query);
      await navigateTo(searchUrl, disposition);
      break;

    case 'copy':
      await copyToClipboard(action.text);
      if (action.notify) {
        // Could show a notification
      }
      break;

    case 'execute':
      await executeTool(action.tool, action.args, 'action');
      break;

    case 'show':
      // TODO: Show content in popup or panel
      console.log('[Harbor] Show content:', action.content);
      break;

    case 'agent':
      await executeAgentTask(action.task, action.tools);
      break;
  }
}

/**
 * Execute an MCP tool and handle the result.
 */
async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  providerId: string,
): Promise<void> {
  const provider = providers.get(providerId);
  const resultHandler = provider?.resultHandler || 'popup';

  try {
    // Import dynamically to avoid circular dependency
    const { callTool, startServer } = await import('../mcp/host');

    const [serverId, actualToolName] = toolName.split('/');
    await startServer(serverId);
    const result = await callTool(serverId, actualToolName, args);

    if (result.ok) {
      await handleToolResult(result.result, resultHandler);
    } else {
      console.error('[Harbor] Tool error:', result.error);
    }
  } catch (error) {
    console.error('[Harbor] Tool execution error:', error);
  }
}

/**
 * Handle tool result based on result handler setting.
 */
async function handleToolResult(
  result: unknown,
  handler: string,
): Promise<void> {
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

  switch (handler) {
    case 'clipboard':
      await copyToClipboard(text);
      break;

    case 'popup':
      // TODO: Show in popup
      console.log('[Harbor] Tool result:', text);
      break;

    case 'navigate':
      // If result is a URL, navigate to it
      if (typeof result === 'string' && result.startsWith('http')) {
        await navigateTo(result, 'currentTab' as Parameters<Parameters<typeof browserAPI.omnibox.onInputEntered.addListener>[0]>[1]);
      }
      break;

    case 'inline':
    default:
      // Inline results are shown in the omnibox dropdown
      // For entered results, copy to clipboard
      await copyToClipboard(text);
      break;
  }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Navigate to a URL based on disposition.
 */
async function navigateTo(
  url: string,
  disposition: Parameters<Parameters<typeof browserAPI.omnibox.onInputEntered.addListener>[0]>[1],
): Promise<void> {
  switch (disposition) {
    case 'currentTab':
      await browserAPI.tabs.update({ url });
      break;
    case 'newForegroundTab':
      await browserAPI.tabs.create({ url });
      break;
    case 'newBackgroundTab':
      await browserAPI.tabs.create({ url, active: false });
      break;
  }
}

/**
 * Get search URL for an engine.
 */
function getSearchUrl(engine: string, query: string): string {
  const encoded = encodeURIComponent(query);
  switch (engine) {
    case 'duckduckgo':
      return `https://duckduckgo.com/?q=${encoded}`;
    case 'bing':
      return `https://www.bing.com/search?q=${encoded}`;
    case 'google':
    default:
      return `https://www.google.com/search?q=${encoded}`;
  }
}

/**
 * Copy text to clipboard.
 */
async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for service worker context
    // Would need to inject into a tab to use clipboard API
    console.log('[Harbor] Clipboard (fallback):', text);
  }
}

/**
 * Convert our suggestion to Chrome omnibox format.
 */
function toOmniboxSuggestion(
  suggestion: AddressBarSuggestion,
): { content: string; description: string } {
  // Store for later lookup
  const key = suggestion.url || suggestion.title;
  recentSuggestions.set(key, suggestion);

  // Build description with XML formatting
  let description = `<match>${escapeXml(suggestion.title)}</match>`;
  if (suggestion.description) {
    description += ` <dim>- ${escapeXml(suggestion.description)}</dim>`;
  }

  return {
    content: key,
    description,
  };
}

/**
 * Escape XML special characters.
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Save providers to storage.
 */
async function saveProviders(): Promise<void> {
  const stored = Array.from(providers.values());
  await browserAPI.storage.local.set({ [STORAGE_KEY]: stored });
}

/**
 * Update the omnibox default suggestion.
 */
function updateOmniboxDefaultSuggestion(): void {
  // Build hint from all triggers
  const hints: string[] = [];

  for (const [, provider] of providers) {
    for (const trigger of provider.triggers) {
      if (trigger.hint) {
        hints.push(trigger.hint);
      } else if (trigger.type === 'prefix') {
        hints.push(trigger.value + '...');
      }
    }
  }

  const description = hints.length > 0
    ? `Try: ${hints.slice(0, 3).join(', ')}`
    : 'Type to search with Harbor AI';

  browserAPI.omnibox.setDefaultSuggestion({
    description: `<dim>${escapeXml(description)}</dim>`,
  });
}

// =============================================================================
// Agent Task Execution
// =============================================================================

/**
 * Execute an agent task from the address bar.
 * Runs agent.run() and handles the result.
 */
async function executeAgentTask(
  task: string,
  tools?: string[],
): Promise<void> {
  console.log('[Harbor] Running agent task:', task);

  try {
    // Get active tab for context - use its origin for permissions
    const [activeTab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
    const origin = activeTab?.url
      ? new URL(activeTab.url).origin
      : 'chrome-extension://' + browserAPI.runtime.id;

    // Run the agent with the task
    const events = runAgent(origin, {
      task,
      tools,
      maxToolCalls: 10,
    }, activeTab?.id);

    // Collect the final output
    let finalOutput = '';
    let hasError = false;
    let errorMessage = '';

    for await (const event of events) {
      switch (event.type) {
        case 'status':
          console.log('[Harbor] Agent status:', event.message);
          break;
        case 'tool_call':
          console.log('[Harbor] Agent calling tool:', event.tool);
          break;
        case 'tool_result':
          if (event.error) {
            console.log('[Harbor] Tool error:', event.error.message);
          } else {
            console.log('[Harbor] Tool result received');
          }
          break;
        case 'token':
          // Tokens are streamed; we collect them in final
          break;
        case 'final':
          finalOutput = event.output;
          break;
        case 'error':
          hasError = true;
          errorMessage = event.error.message;
          break;
      }
    }

    // Handle the result
    if (hasError) {
      console.error('[Harbor] Agent error:', errorMessage);
      // Could show a notification here
    } else if (finalOutput) {
      await handleAgentResult(finalOutput);
    }
  } catch (error) {
    console.error('[Harbor] Agent task error:', error);
  }
}

/**
 * Handle the result from an agent task.
 * For now, copies to clipboard. Future: show in popup/panel.
 */
async function handleAgentResult(output: string): Promise<void> {
  // Copy to clipboard
  await copyToClipboard(output);
  console.log('[Harbor] Agent result copied to clipboard:', output.slice(0, 100) + '...');

  // TODO: Show in a popup or panel for better UX
  // Could use browser notifications or open a results page
}
