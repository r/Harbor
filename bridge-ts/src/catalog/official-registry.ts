/**
 * Official MCP Registry provider.
 * 
 * Fetches server listings from the official MCP registry API at:
 * https://registry.modelcontextprotocol.io/v0/servers
 */

import { log } from '../native-messaging.js';
import { CatalogServer, PackageInfo } from '../types.js';
import { CatalogProvider, ProviderResult, generateServerId } from './base.js';

const REGISTRY_BASE_URL = 'https://registry.modelcontextprotocol.io';
const SERVERS_ENDPOINT = '/v0/servers';
const DEFAULT_LIMIT = 100;
const MAX_PAGES = 10;

interface RegistryEntry {
  server?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

interface RegistryResponse {
  servers?: RegistryEntry[];
  cursor?: string;
}

export class OfficialRegistryProvider extends CatalogProvider {
  get id(): string {
    return 'official_registry';
  }

  get name(): string {
    return 'Official MCP Registry';
  }

  async fetch(query?: string): Promise<ProviderResult> {
    const servers: CatalogServer[] = [];
    let cursor: string | undefined;
    let pagesFetched = 0;

    try {
      while (pagesFetched < MAX_PAGES) {
        const params = new URLSearchParams({ limit: String(DEFAULT_LIMIT) });
        if (cursor) params.set('cursor', cursor);
        if (query) params.set('search', query);

        const url = `${REGISTRY_BASE_URL}${SERVERS_ENDPOINT}?${params}`;
        log(`[${this.name}] Fetching: ${url} (page ${pagesFetched + 1})`);

        const response = await fetch(url);
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`HTTP ${response.status}: ${errorText.substring(0, 200)}`);
        }

        const data: RegistryResponse = await response.json() as RegistryResponse;
        const rawServers = data.servers || [];

        for (const entry of rawServers) {
          const server = this.parseEntry(entry);
          if (server) {
            servers.push(server);
          }
        }

        pagesFetched++;
        log(`[${this.name}] Page ${pagesFetched}: got ${rawServers.length} servers`);

        cursor = data.cursor;
        if (!cursor) break;
      }

      log(`[${this.name}] Total: ${servers.length} servers from ${pagesFetched} pages`);
      return this.makeResult(servers);

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[${this.name}] Fetch error: ${message}`);
      return this.makeResult([], message);
    }
  }

  private parseEntry(entry: RegistryEntry): CatalogServer | null {
    try {
      const serverData = entry.server || entry;
      const name = serverData.name as string || '';
      if (!name) return null;

      const description = serverData.description as string || '';

      // Repository can be string or dict
      let repository = '';
      const repoData = serverData.repository;
      if (typeof repoData === 'string') {
        repository = repoData;
      } else if (repoData && typeof repoData === 'object') {
        repository = (repoData as Record<string, unknown>).url as string || '';
      }

      // Homepage can also be string or dict
      let homepage = '';
      const homepageData = serverData.homepage;
      if (typeof homepageData === 'string') {
        homepage = homepageData;
      } else if (homepageData && typeof homepageData === 'object') {
        homepage = (homepageData as Record<string, unknown>).url as string || '';
      }

      // Extract packages and endpoint URL
      const packages = (serverData.packages || []) as Array<Record<string, unknown>>;
      let endpointUrl = '';
      const packageInfos: PackageInfo[] = [];

      for (const pkg of packages) {
        // Get transports
        const transports = this.getTransports(pkg);
        const remoteTransports = transports.filter(t => 
          ['sse', 'http', 'streamable-http'].includes(t)
        );

        if (remoteTransports.length > 0) {
          // Try to extract endpoint URL
          const ep = pkg.endpoint || pkg.url || pkg.baseUrl || '';
          if (typeof ep === 'string' && ep) {
            endpointUrl = ep;
          } else if (typeof ep === 'object' && ep) {
            endpointUrl = (ep as Record<string, unknown>).url as string || '';
          }
        }

        // Extract package info
        const registryType = (pkg.registryType as string) || 'npm';
        const identifier = pkg.identifier as string || '';
        const envVars = (pkg.environmentVariables || []) as Array<{
          name: string;
          description?: string;
          isSecret?: boolean;
        }>;

        if (identifier) {
          packageInfos.push({
            registryType: registryType as 'npm' | 'pypi' | 'oci',
            identifier,
            environmentVariables: envVars,
          });
        }
      }

      // Determine if supports remote
      const supportsRemote = packages.some(pkg => {
        const transports = this.getTransports(pkg);
        return transports.some(t => ['sse', 'http', 'streamable-http'].includes(t));
      });

      // Build tags
      const tags: string[] = [];
      if (endpointUrl) {
        tags.push('remote');
      } else if (supportsRemote) {
        tags.push('remote_capable');
      } else {
        tags.push('installable_only');
      }

      // Check for official status
      const meta = entry._meta || {};
      const registryMeta = meta['io.modelcontextprotocol.registry/official'] as Record<string, unknown> | undefined;
      if (registryMeta?.status === 'active') {
        tags.push('official');
      }

      // Add existing tags (filter non-strings)
      const existingTags = serverData.tags as unknown[];
      if (Array.isArray(existingTags)) {
        for (const tag of existingTags) {
          if (typeof tag === 'string') {
            tags.push(tag);
          }
        }
      }

      return {
        id: generateServerId(this.id, endpointUrl, repository, name),
        name,
        source: this.id,
        endpointUrl,
        installableOnly: !endpointUrl,
        packages: packageInfos,
        description,
        homepageUrl: homepage || repository,
        repositoryUrl: repository,
        tags,
        fetchedAt: Date.now(),
      };

    } catch (error) {
      log(`[${this.name}] Failed to parse entry: ${error}`);
      return null;
    }
  }

  private getTransports(pkg: Record<string, unknown>): string[] {
    const transportData = pkg.transport;
    const transports: string[] = [];

    if (typeof transportData === 'string') {
      transports.push(transportData);
    } else if (typeof transportData === 'object' && transportData) {
      if (Array.isArray(transportData)) {
        for (const t of transportData) {
          if (typeof t === 'string') {
            transports.push(t);
          } else if (typeof t === 'object' && t) {
            const tt = (t as Record<string, unknown>).type as string;
            if (tt) transports.push(tt);
          }
        }
      } else {
        const tt = (transportData as Record<string, unknown>).type as string;
        if (tt) transports.push(tt);
      }
    }

    return transports;
  }
}





