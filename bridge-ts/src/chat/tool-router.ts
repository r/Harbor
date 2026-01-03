/**
 * Tool Router - Dynamically selects which MCP servers to use based on the user's message.
 * 
 * This reduces cognitive load on local LLMs by only presenting relevant tools
 * instead of overwhelming them with 40+ tools from multiple servers.
 * 
 * Unlike a hardcoded approach, this router:
 * 1. Dynamically indexes tools from connected MCP servers
 * 2. Extracts keywords from tool names and descriptions
 * 3. Matches user messages against the keyword index
 * 4. Works automatically with any MCP server - no configuration needed
 */

import { log } from '../native-messaging.js';

/**
 * A tool indexed for routing.
 */
interface IndexedTool {
  serverId: string;
  toolName: string;
  keywords: Set<string>;
}

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
 * Common stop words to exclude from keyword extraction.
 * These are words that don't help distinguish between tools.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought', 'used',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into',
  'through', 'during', 'before', 'after', 'above', 'below', 'between',
  'and', 'but', 'or', 'nor', 'so', 'yet', 'both', 'either', 'neither',
  'not', 'only', 'own', 'same', 'than', 'too', 'very', 'just',
  'that', 'this', 'these', 'those', 'what', 'which', 'who', 'whom',
  'it', 'its', 'he', 'she', 'they', 'them', 'his', 'her', 'their',
  'i', 'we', 'us', 'our', 'you', 'your',
]);

/**
 * Tool Router class - dynamically indexes and routes based on tool metadata.
 */
export class ToolRouter {
  /** Index of keywords to server IDs */
  private keywordIndex: Map<string, Set<string>> = new Map();
  
  /** All indexed tools */
  private indexedTools: IndexedTool[] = [];
  
  /** Server ID to tool count */
  private serverToolCount: Map<string, number> = new Map();
  
  /**
   * Index tools from an MCP server.
   * Call this when a server connects or its tools change.
   * 
   * @param serverId - The server ID
   * @param tools - Array of tools with name and description
   */
  indexServer(serverId: string, tools: Array<{ name: string; description?: string }>): void {
    // Remove old entries for this server
    this.removeServer(serverId);
    
    log(`[ToolRouter] Indexing ${tools.length} tools from server: ${serverId}`);
    
    for (const tool of tools) {
      const keywords = this.extractKeywords(tool.name, tool.description);
      
      const indexed: IndexedTool = {
        serverId,
        toolName: tool.name,
        keywords,
      };
      
      this.indexedTools.push(indexed);
      
      // Add to keyword index
      for (const keyword of keywords) {
        if (!this.keywordIndex.has(keyword)) {
          this.keywordIndex.set(keyword, new Set());
        }
        this.keywordIndex.get(keyword)!.add(serverId);
      }
    }
    
    this.serverToolCount.set(serverId, tools.length);
    log(`[ToolRouter] Indexed ${tools.length} tools, extracted ${this.keywordIndex.size} unique keywords`);
  }
  
  /**
   * Remove a server from the index.
   */
  removeServer(serverId: string): void {
    // Remove tools for this server
    this.indexedTools = this.indexedTools.filter(t => t.serverId !== serverId);
    
    // Rebuild keyword index without this server
    const newKeywordIndex = new Map<string, Set<string>>();
    for (const tool of this.indexedTools) {
      for (const keyword of tool.keywords) {
        if (!newKeywordIndex.has(keyword)) {
          newKeywordIndex.set(keyword, new Set());
        }
        newKeywordIndex.get(keyword)!.add(tool.serverId);
      }
    }
    this.keywordIndex = newKeywordIndex;
    this.serverToolCount.delete(serverId);
  }
  
  /**
   * Extract keywords from a tool name and description.
   */
  private extractKeywords(name: string, description?: string): Set<string> {
    const keywords = new Set<string>();
    
    // Extract from name (split on underscores, camelCase, etc.)
    const nameWords = this.tokenize(name);
    for (const word of nameWords) {
      if (word.length >= 2 && !STOP_WORDS.has(word)) {
        keywords.add(word);
      }
    }
    
    // Extract from description
    if (description) {
      const descWords = this.tokenize(description);
      for (const word of descWords) {
        if (word.length >= 3 && !STOP_WORDS.has(word)) {
          keywords.add(word);
        }
      }
    }
    
    return keywords;
  }
  
  /**
   * Tokenize text into words.
   */
  private tokenize(text: string): string[] {
    // Split on non-alphanumeric, handle camelCase and snake_case
    return text
      .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase → camel Case
      .replace(/[_-]/g, ' ')               // snake_case → snake case
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(w => w.length > 0);
  }
  
  /**
   * Analyze a user message and determine which servers to use.
   * 
   * @param message - The user's message
   * @param availableServers - List of currently connected server IDs
   * @returns Routing result with selected servers
   */
  route(message: string, availableServers: string[]): RoutingResult {
    log(`[ToolRouter] Analyzing message: "${message.substring(0, 100)}..."`);
    log(`[ToolRouter] Available servers: ${availableServers.join(', ')}`);
    log(`[ToolRouter] Index has ${this.keywordIndex.size} keywords from ${this.serverToolCount.size} servers`);
    
    // If index is empty, use all servers
    if (this.keywordIndex.size === 0) {
      log('[ToolRouter] Index is empty, using all servers');
      return {
        selectedServers: availableServers,
        matchedKeywords: [],
        wasRouted: false,
        reason: 'No tools indexed yet, using all available servers',
      };
    }
    
    // Tokenize user message
    const messageWords = this.tokenize(message);
    log(`[ToolRouter] Message words: ${messageWords.join(', ')}`);
    
    // Find matching servers and keywords
    const serverScores = new Map<string, number>();
    const matchedKeywords: string[] = [];
    
    for (const word of messageWords) {
      // Direct keyword match
      if (this.keywordIndex.has(word)) {
        matchedKeywords.push(word);
        for (const serverId of this.keywordIndex.get(word)!) {
          serverScores.set(serverId, (serverScores.get(serverId) || 0) + 1);
        }
      }
      
      // Partial match for longer words (e.g., "username" matches "user")
      if (word.length >= 4) {
        for (const [keyword, servers] of this.keywordIndex) {
          if (keyword.length >= 3 && (word.includes(keyword) || keyword.includes(word))) {
            if (!matchedKeywords.includes(keyword)) {
              matchedKeywords.push(keyword);
            }
            for (const serverId of servers) {
              serverScores.set(serverId, (serverScores.get(serverId) || 0) + 0.5);
            }
          }
        }
      }
    }
    
    log(`[ToolRouter] Matched keywords: ${matchedKeywords.join(', ')}`);
    log(`[ToolRouter] Server scores: ${JSON.stringify(Object.fromEntries(serverScores))}`);
    
    // If no matches, use all servers
    if (serverScores.size === 0) {
      log('[ToolRouter] No keyword matches, using all servers');
      return {
        selectedServers: availableServers,
        matchedKeywords: [],
        wasRouted: false,
        reason: 'No keyword matches found, using all available servers',
      };
    }
    
    // Filter to only available servers and sort by score
    const selectedServers = availableServers
      .filter(s => serverScores.has(s))
      .sort((a, b) => (serverScores.get(b) || 0) - (serverScores.get(a) || 0));
    
    // If no available servers matched, use all
    if (selectedServers.length === 0) {
      log('[ToolRouter] No available servers matched, using all servers');
      return {
        selectedServers: availableServers,
        matchedKeywords,
        wasRouted: false,
        reason: `Keywords matched (${matchedKeywords.join(', ')}) but no matching servers are connected`,
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
   * Get debug info about the current index.
   */
  getDebugInfo(): { keywords: number; tools: number; servers: string[] } {
    return {
      keywords: this.keywordIndex.size,
      tools: this.indexedTools.length,
      servers: [...this.serverToolCount.keys()],
    };
  }
  
  /**
   * Clear the entire index.
   */
  clear(): void {
    this.keywordIndex.clear();
    this.indexedTools = [];
    this.serverToolCount.clear();
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
