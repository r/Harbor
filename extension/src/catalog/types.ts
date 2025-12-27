// Catalog data model for Harbor Directory

export type CatalogSourceId = 
  | 'official_registry' 
  | 'github_awesome';

export interface CatalogServer {
  id: string;                    // stable hash of (source + canonicalUrl or homepageUrl + name)
  name: string;
  endpointUrl: string;           // remote MCP base URL if available, else ""
  installableOnly: boolean;
  description?: string;
  homepageUrl?: string;
  tags: string[];
  source: CatalogSourceId;
  fetchedAt: number;
}

export interface ProviderStatus {
  id: CatalogSourceId;
  ok: boolean;
  fetchedAt?: number;
  error?: string;
  count?: number;
}

export interface CatalogResponse {
  servers: CatalogServer[];
  providerStatus: ProviderStatus[];
  fetchedAt: number;
}

export interface CacheEntry {
  servers: CatalogServer[];
  fetchedAt: number;
}

// Cache keys for each provider
export const CACHE_KEYS: Record<CatalogSourceId, string> = {
  official_registry: 'catalog.cache.official_registry.v1',
  github_awesome: 'catalog.cache.github_awesome.v1',
};

// Cache TTL: 10 minutes
export const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Canonicalize a URL for deduplication
 * - trim whitespace
 * - lowercase scheme and host
 * - remove trailing slashes
 */
export function canonicalizeUrl(url: string): string {
  if (!url) return '';
  try {
    const trimmed = url.trim();
    const parsed = new URL(trimmed);
    // Lowercase scheme and host
    const scheme = parsed.protocol.toLowerCase();
    const host = parsed.host.toLowerCase();
    // Remove trailing slash from pathname unless it's just "/"
    let pathname = parsed.pathname;
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    return `${scheme}//${host}${pathname}${parsed.search}`;
  } catch {
    // If URL parsing fails, just return trimmed lowercase
    return url.trim().toLowerCase().replace(/\/+$/, '');
  }
}

/**
 * Generate a stable ID for a catalog server
 */
export function generateServerId(
  source: CatalogSourceId, 
  endpointUrl: string, 
  homepageUrl: string, 
  name: string
): string {
  const canonical = endpointUrl 
    ? canonicalizeUrl(endpointUrl) 
    : `${canonicalizeUrl(homepageUrl || '')}::${name.toLowerCase()}`;
  
  // Simple hash function
  let hash = 0;
  const str = `${source}:${canonical}`;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return `${source}:${Math.abs(hash).toString(36)}`;
}

/**
 * Dedupe servers from multiple sources
 * - Dedupe by canonical endpointUrl if present, else by homepageUrl+name
 * - When duplicates: prefer official_registry record for description/tags
 */
export function dedupeServers(servers: CatalogServer[]): CatalogServer[] {
  const seen = new Map<string, CatalogServer>();
  
  // Sort to process official_registry first (higher priority)
  const sorted = [...servers].sort((a, b) => {
    const priority: Record<CatalogSourceId, number> = {
      official_registry: 0,
      github_awesome: 1,
      mcpservers_org: 2,
    };
    return priority[a.source] - priority[b.source];
  });

  for (const server of sorted) {
    // Generate dedup key
    const key = server.endpointUrl 
      ? canonicalizeUrl(server.endpointUrl)
      : `name:${server.name.toLowerCase()}:${canonicalizeUrl(server.homepageUrl || '')}`;
    
    if (!seen.has(key)) {
      seen.set(key, server);
    } else {
      // Merge: keep existing (higher priority) but maybe enhance
      const existing = seen.get(key)!;
      // If existing lacks endpoint but new has it, use new's endpoint
      if (!existing.endpointUrl && server.endpointUrl) {
        existing.endpointUrl = server.endpointUrl;
        existing.installableOnly = false;
      }
      // Merge tags
      const allTags = new Set([...existing.tags, ...server.tags]);
      existing.tags = Array.from(allTags);
    }
  }

  return Array.from(seen.values());
}


