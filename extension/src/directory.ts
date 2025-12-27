import browser from 'webextension-polyfill';

// Types
export interface CatalogServer {
  id: string;
  name: string;
  description: string;
  endpointUrl: string;
  homepage?: string;
  repository?: string;
  tags: string[];
  source: 'registry' | 'github_awesome' | 'manual_seed';
}

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

interface RegistryServerEntry {
  server: {
    name: string;
    description?: string;
    repository?: string;
    homepage?: string;
    packages?: Array<{
      transport?: string[];
      registry_config?: {
        url?: string;
      };
    }>;
    [key: string]: unknown;
  };
  _meta?: unknown;
}

interface RegistryResponse {
  servers: RegistryServerEntry[];
  cursor?: string;
}

// Cache configuration
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CACHE_KEYS = {
  registry: 'catalog.cache.registry.v1',
  githubAwesome: 'catalog.cache.githubawesome.v1',
  manualSeed: 'catalog.cache.manualseed.v1',
} as const;

// Proxy fetch through background script to avoid CORS issues
interface ProxyFetchResponse {
  ok: boolean;
  status: number;
  data?: string | object;
  error?: string;
}

async function proxyFetch(url: string): Promise<ProxyFetchResponse> {
  return browser.runtime.sendMessage({
    type: 'proxy_fetch',
    url,
    method: 'GET',
  }) as Promise<ProxyFetchResponse>;
}

// Provider base class
abstract class CatalogProvider {
  abstract name: string;
  abstract cacheKey: string;
  abstract fetchServers(query?: string): Promise<CatalogServer[]>;

  async getCachedOrFetch(query?: string): Promise<CatalogServer[]> {
    const cacheKey = query ? `${this.cacheKey}:${query}` : this.cacheKey;
    
    try {
      const cached = await browser.storage.local.get(cacheKey);
      const entry = cached[cacheKey] as CacheEntry<CatalogServer[]> | undefined;
      
      if (entry && Date.now() - entry.timestamp < CACHE_TTL_MS) {
        console.log(`[${this.name}] Using cached data`);
        return entry.data;
      }
    } catch (e) {
      console.warn(`[${this.name}] Cache read error:`, e);
    }

    console.log(`[${this.name}] Fetching fresh data...`);
    const servers = await this.fetchServers(query);
    
    try {
      await browser.storage.local.set({
        [cacheKey]: {
          data: servers,
          timestamp: Date.now(),
        } as CacheEntry<CatalogServer[]>,
      });
    } catch (e) {
      console.warn(`[${this.name}] Cache write error:`, e);
    }

    return servers;
  }

  async clearCache(): Promise<void> {
    try {
      const allStorage = await browser.storage.local.get(null);
      const keysToRemove = Object.keys(allStorage).filter(k => k.startsWith(this.cacheKey));
      if (keysToRemove.length > 0) {
        await browser.storage.local.remove(keysToRemove);
      }
    } catch (e) {
      console.warn(`[${this.name}] Cache clear error:`, e);
    }
  }
}

// Provider 1: Official Registry (REAL API)
export class OfficialRegistryProvider extends CatalogProvider {
  name = 'Official Registry';
  cacheKey = CACHE_KEYS.registry;
  
  private baseUrl = 'https://registry.modelcontextprotocol.io';

  async fetchServers(query?: string): Promise<CatalogServer[]> {
    const servers: CatalogServer[] = [];
    let cursor: string | undefined;
    const limit = 100;

    try {
      do {
        const params = new URLSearchParams({ limit: String(limit) });
        if (query) {
          params.set('search', query);
        }
        if (cursor) {
          params.set('cursor', cursor);
        }

        const url = `${this.baseUrl}/v0/servers?${params}`;
        console.log(`[${this.name}] Fetching: ${url}`);
        
        const response = await proxyFetch(url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.error || 'Unknown error'}`);
        }

        const data = response.data as RegistryResponse;
        
        for (const entry of data.servers || []) {
          const server = this.parseRegistryEntry(entry);
          if (server) {
            servers.push(server);
          }
        }

        cursor = data.cursor;
      } while (cursor && servers.length < 500); // Safety limit

    } catch (error) {
      console.error(`[${this.name}] Fetch error:`, error);
      // Return empty on error - other providers may still work
    }

    return servers;
  }

  private parseRegistryEntry(entry: RegistryServerEntry): CatalogServer | null {
    const { server } = entry;
    if (!server?.name) return null;

    // Try to find a remote endpoint URL
    let endpointUrl = '';
    const tags: string[] = [];
    let hasRemoteTransport = false;

    if (server.packages && Array.isArray(server.packages)) {
      for (const pkg of server.packages) {
        // Check for remote transports (SSE, HTTP, streamable-http)
        // transport can be an array or a single string
        const transports = Array.isArray(pkg.transport) 
          ? pkg.transport 
          : (typeof pkg.transport === 'string' ? [pkg.transport] : []);
        
        const remoteTransports = transports.filter(
          (t: string) => t === 'sse' || t === 'http' || t === 'streamable-http'
        );
        
        if (remoteTransports.length > 0) {
          hasRemoteTransport = true;
          // Check if there's a URL in registry_config
          if (pkg.registry_config?.url) {
            endpointUrl = pkg.registry_config.url;
            break;
          }
        }
      }
    }

    // Tag entries appropriately
    if (!endpointUrl) {
      tags.push('installable_only');
      if (!hasRemoteTransport) {
        tags.push('local_only');
      }
    }

    return {
      id: `registry:${server.name}`,
      name: server.name,
      description: server.description || '',
      endpointUrl,
      homepage: server.homepage,
      repository: server.repository,
      tags,
      source: 'registry',
    };
  }
}

// Provider 2: GitHub Awesome list (BEST EFFORT)
export class GitHubAwesomeProvider extends CatalogProvider {
  name = 'GitHub Awesome MCP';
  cacheKey = CACHE_KEYS.githubAwesome;
  
  private rawUrl = 'https://raw.githubusercontent.com/wong2/awesome-mcp-servers/main/README.md';

  async fetchServers(_query?: string): Promise<CatalogServer[]> {
    const servers: CatalogServer[] = [];

    try {
      console.log(`[${this.name}] Fetching: ${this.rawUrl}`);
      const response = await proxyFetch(this.rawUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.error || 'Unknown error'}`);
      }

      const markdown = response.data as string;
      servers.push(...this.parseMarkdown(markdown));

    } catch (error) {
      console.error(`[${this.name}] Fetch error:`, error);
    }

    return servers;
  }

  private parseMarkdown(markdown: string): CatalogServer[] {
    const servers: CatalogServer[] = [];
    const lines = markdown.split('\n');
    
    let inRelevantSection = false;
    let currentSection = '';

    // Match markdown links: [text](url) - description
    const linkPattern = /^\s*[-*]\s*\[([^\]]+)\]\(([^)]+)\)\s*[-–—:]?\s*(.*)/;
    
    for (const line of lines) {
      // Track section headers
      if (line.startsWith('#')) {
        const headerMatch = line.match(/^#+\s+(.+)/);
        if (headerMatch) {
          currentSection = headerMatch[1].toLowerCase();
          // Focus on server sections
          inRelevantSection = 
            currentSection.includes('server') ||
            currentSection.includes('official') ||
            currentSection.includes('tool') ||
            currentSection.includes('resource');
        }
        continue;
      }

      // Skip if not in a relevant section
      if (!inRelevantSection) continue;

      // Parse list items with links
      const match = line.match(linkPattern);
      if (match) {
        const [, name, href, rest] = match;
        
        // Clean up description - remove badges, extra links, etc.
        let description = rest
          .replace(/!\[.*?\]\([^)]*\)/g, '') // Remove image badges
          .replace(/\[.*?\]\([^)]*\)/g, '') // Remove additional links
          .replace(/<[^>]*>/g, '') // Remove HTML tags
          .replace(/\s+/g, ' ')
          .trim();

        // Skip entries that are just navigation or categories
        if (name.toLowerCase().includes('table of contents')) continue;
        if (name.toLowerCase().includes('contributing')) continue;
        if (!href.startsWith('http')) continue;

        servers.push({
          id: `github:${this.slugify(name)}`,
          name: name.trim(),
          description,
          endpointUrl: '', // No remote endpoint from markdown
          homepage: href.includes('github.com') ? undefined : href,
          repository: href.includes('github.com') ? href : undefined,
          tags: ['installable_only'],
          source: 'github_awesome',
        });
      }
    }

    return servers;
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }
}

// Provider 3: Manual Seed (FOR TESTING)
export class ManualSeedProvider extends CatalogProvider {
  name = 'Manual Seed';
  cacheKey = CACHE_KEYS.manualSeed;

  async fetchServers(_query?: string): Promise<CatalogServer[]> {
    // These are hardcoded test entries
    return [
      {
        id: 'seed:demo-server',
        name: 'Harbor Demo Server',
        description: 'Local demo MCP server for testing Harbor functionality',
        endpointUrl: 'http://localhost:8765',
        tags: ['demo', 'local'],
        source: 'manual_seed',
      },
      {
        id: 'seed:example-server-1',
        name: 'Example SSE Server',
        description: 'Placeholder for a remote SSE-based MCP server endpoint',
        endpointUrl: 'https://mcp.example.com/sse',
        tags: ['placeholder', 'sse'],
        source: 'manual_seed',
      },
      {
        id: 'seed:example-server-2',
        name: 'Example HTTP Server',
        description: 'Placeholder for a remote HTTP-based MCP server endpoint',
        endpointUrl: 'https://api.example.com/mcp',
        tags: ['placeholder', 'http'],
        source: 'manual_seed',
      },
    ];
  }
}

// Directory Manager - aggregates all providers
export class DirectoryManager {
  private providers: CatalogProvider[];

  constructor() {
    this.providers = [
      new ManualSeedProvider(), // Fast, always works
      new OfficialRegistryProvider(), // Real API
      new GitHubAwesomeProvider(), // Best effort markdown parsing
    ];
  }

  async getAllServers(forceRefresh = false): Promise<CatalogServer[]> {
    if (forceRefresh) {
      await Promise.all(this.providers.map(p => p.clearCache()));
    }

    const results = await Promise.allSettled(
      this.providers.map(p => p.getCachedOrFetch())
    );

    const allServers: CatalogServer[] = [];
    const seenIds = new Set<string>();

    for (const result of results) {
      if (result.status === 'fulfilled') {
        for (const server of result.value) {
          // Deduplicate by id
          if (!seenIds.has(server.id)) {
            seenIds.add(server.id);
            allServers.push(server);
          }
        }
      }
    }

    // Sort: entries with endpoints first, then by name
    allServers.sort((a, b) => {
      if (a.endpointUrl && !b.endpointUrl) return -1;
      if (!a.endpointUrl && b.endpointUrl) return 1;
      return a.name.localeCompare(b.name);
    });

    return allServers;
  }

  async searchServers(query: string): Promise<CatalogServer[]> {
    const queryLower = query.toLowerCase().trim();
    if (!queryLower) {
      return this.getAllServers();
    }

    // For registry, use the search endpoint
    const registryProvider = this.providers.find(
      p => p instanceof OfficialRegistryProvider
    ) as OfficialRegistryProvider | undefined;

    const results = await Promise.allSettled([
      // Registry search via API
      registryProvider?.getCachedOrFetch(query) || Promise.resolve([]),
      // Other providers: fetch all then filter client-side
      ...this.providers
        .filter(p => !(p instanceof OfficialRegistryProvider))
        .map(async p => {
          const servers = await p.getCachedOrFetch();
          return servers.filter(
            s =>
              s.name.toLowerCase().includes(queryLower) ||
              s.description.toLowerCase().includes(queryLower) ||
              s.tags.some(t => t.toLowerCase().includes(queryLower))
          );
        }),
    ]);

    const allServers: CatalogServer[] = [];
    const seenIds = new Set<string>();

    for (const result of results) {
      if (result.status === 'fulfilled') {
        for (const server of result.value) {
          if (!seenIds.has(server.id)) {
            seenIds.add(server.id);
            allServers.push(server);
          }
        }
      }
    }

    allServers.sort((a, b) => {
      if (a.endpointUrl && !b.endpointUrl) return -1;
      if (!a.endpointUrl && b.endpointUrl) return 1;
      return a.name.localeCompare(b.name);
    });

    return allServers;
  }

  async clearAllCaches(): Promise<void> {
    await Promise.all(this.providers.map(p => p.clearCache()));
  }
}

// Singleton instance
export const directoryManager = new DirectoryManager();

