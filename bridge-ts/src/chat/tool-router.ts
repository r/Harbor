/**
 * Tool Router - Intelligently selects which MCP servers to use based on the user's message.
 * 
 * This reduces cognitive load on local LLMs by only presenting relevant tools
 * instead of overwhelming them with 40+ tools from multiple servers.
 */

import { log } from '../native-messaging.js';

/**
 * Server routing rule - maps keywords to server IDs.
 */
interface RoutingRule {
  /** Keywords that trigger this server */
  keywords: string[];
  /** Server ID patterns to match (supports partial matching) */
  serverPatterns: string[];
  /** Priority (higher = checked first) */
  priority: number;
}

/**
 * Default routing rules for common MCP servers.
 */
const DEFAULT_RULES: RoutingRule[] = [
  // GitHub
  {
    keywords: ['github', 'repo', 'repository', 'repositories', 'commit', 'commits', 'pull request', 'pr', 'issue', 'issues', 'branch', 'branches', 'fork', 'star', 'gist'],
    serverPatterns: ['github'],
    priority: 10,
  },
  // Filesystem
  {
    keywords: ['file', 'files', 'folder', 'folders', 'directory', 'directories', 'read', 'write', 'create', 'delete', 'move', 'copy', 'path', 'disk', 'storage', 'document', 'documents'],
    serverPatterns: ['filesystem', 'fs'],
    priority: 10,
  },
  // Memory/Knowledge
  {
    keywords: ['remember', 'memory', 'memories', 'recall', 'forget', 'knowledge', 'store', 'stored', 'save', 'saved', 'entity', 'entities', 'relation', 'relations', 'graph'],
    serverPatterns: ['memory', 'knowledge'],
    priority: 10,
  },
  // Slack
  {
    keywords: ['slack', 'channel', 'channels', 'message', 'messages', 'dm', 'workspace'],
    serverPatterns: ['slack'],
    priority: 10,
  },
  // Database
  {
    keywords: ['database', 'db', 'sql', 'query', 'table', 'tables', 'postgres', 'postgresql', 'mysql', 'sqlite', 'mongo', 'mongodb'],
    serverPatterns: ['database', 'postgres', 'mysql', 'sqlite', 'mongo', 'db'],
    priority: 10,
  },
  // Web/Browser
  {
    keywords: ['web', 'website', 'url', 'browse', 'browser', 'scrape', 'fetch', 'http', 'html', 'page', 'search online'],
    serverPatterns: ['web', 'browser', 'puppeteer', 'playwright'],
    priority: 10,
  },
  // Search
  {
    keywords: ['search', 'find', 'lookup', 'google', 'brave', 'bing'],
    serverPatterns: ['search', 'brave', 'google'],
    priority: 5, // Lower priority - many things involve "search"
  },
];

/**
 * Result of routing analysis.
 */
export interface RoutingResult {
  /** Server IDs that should be used */
  selectedServers: string[];
  /** Keywords that were matched */
  matchedKeywords: string[];
  /** Whether routing was applied (false = use all servers) */
  wasRouted: boolean;
  /** Reason for the routing decision */
  reason: string;
}

/**
 * Tool Router class.
 */
export class ToolRouter {
  private rules: RoutingRule[];
  
  constructor(customRules?: RoutingRule[]) {
    this.rules = customRules || DEFAULT_RULES;
    // Sort by priority (highest first)
    this.rules.sort((a, b) => b.priority - a.priority);
  }
  
  /**
   * Analyze a user message and determine which servers to use.
   * 
   * @param message - The user's message
   * @param availableServers - List of currently connected server IDs
   * @returns Routing result with selected servers
   */
  route(message: string, availableServers: string[]): RoutingResult {
    const messageLower = message.toLowerCase();
    const matchedKeywords: string[] = [];
    const matchedServerPatterns: Set<string> = new Set();
    
    log(`[ToolRouter] Analyzing message: "${message.substring(0, 100)}..."`);
    log(`[ToolRouter] Available servers: ${availableServers.join(', ')}`);
    
    // Check each rule for keyword matches
    for (const rule of this.rules) {
      for (const keyword of rule.keywords) {
        if (messageLower.includes(keyword.toLowerCase())) {
          matchedKeywords.push(keyword);
          rule.serverPatterns.forEach(p => matchedServerPatterns.add(p));
        }
      }
    }
    
    log(`[ToolRouter] Matched keywords: ${matchedKeywords.join(', ')}`);
    log(`[ToolRouter] Matched patterns: ${[...matchedServerPatterns].join(', ')}`);
    
    // If no keywords matched, use all servers
    if (matchedServerPatterns.size === 0) {
      log('[ToolRouter] No keywords matched, using all servers');
      return {
        selectedServers: availableServers,
        matchedKeywords: [],
        wasRouted: false,
        reason: 'No specific keywords detected, using all available servers',
      };
    }
    
    // Match patterns to actual server IDs
    const selectedServers: string[] = [];
    for (const serverId of availableServers) {
      const serverIdLower = serverId.toLowerCase();
      for (const pattern of matchedServerPatterns) {
        if (serverIdLower.includes(pattern.toLowerCase())) {
          selectedServers.push(serverId);
          break;
        }
      }
    }
    
    // If no servers matched the patterns, use all servers
    if (selectedServers.length === 0) {
      log('[ToolRouter] No servers matched patterns, using all servers');
      return {
        selectedServers: availableServers,
        matchedKeywords,
        wasRouted: false,
        reason: `Keywords matched (${matchedKeywords.join(', ')}) but no matching servers found`,
      };
    }
    
    log(`[ToolRouter] Selected servers: ${selectedServers.join(', ')}`);
    
    return {
      selectedServers,
      matchedKeywords,
      wasRouted: true,
      reason: `Routed to ${selectedServers.join(', ')} based on keywords: ${matchedKeywords.join(', ')}`,
    };
  }
  
  /**
   * Add a custom routing rule.
   */
  addRule(rule: RoutingRule): void {
    this.rules.push(rule);
    this.rules.sort((a, b) => b.priority - a.priority);
  }
}

// Singleton instance
let routerInstance: ToolRouter | null = null;

export function getToolRouter(): ToolRouter {
  if (!routerInstance) {
    routerInstance = new ToolRouter();
  }
  return routerInstance;
}


