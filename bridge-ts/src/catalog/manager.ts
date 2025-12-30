/**
 * Catalog Manager - orchestrates providers, caching, and database.
 */

import { log } from '../native-messaging.js';
import { CatalogResult, ProviderStatus } from '../types.js';
import { CatalogProvider } from './base.js';
import { CatalogDatabase, getCatalogDb, ServerChange } from './database.js';
import { OfficialRegistryProvider } from './official-registry.js';
import { GitHubAwesomeProvider } from './github-awesome.js';

export class CatalogManager {
  private providers: CatalogProvider[];
  private db: CatalogDatabase;

  constructor() {
    // Register all available providers
    this.providers = [
      new OfficialRegistryProvider(),
      new GitHubAwesomeProvider(),
      // Add new providers here
    ];
    
    this.db = getCatalogDb();
  }

  getProvider(providerId: string): CatalogProvider | undefined {
    return this.providers.find(p => p.id === providerId);
  }

  /**
   * Get servers from cache (fast, synchronous read from SQLite).
   */
  async getCached(options: {
    remoteOnly?: boolean;
    source?: string;
    limit?: number;
  } = {}): Promise<CatalogResult> {
    const servers = this.db.getAllServers(options);
    const providerStatus = this.db.getProviderStatus();
    const isStale = this.db.isCacheStale();
    const stats = this.db.getStats();

    return {
      servers,
      providerStatus: providerStatus.map(p => ({
        id: p.provider_id as string,
        name: p.provider_name as string,
        ok: p.last_success_at !== null,
        count: p.server_count as number | null,
        error: p.last_error as string | null,
        fetchedAt: p.last_fetch_at ? Math.floor(p.last_fetch_at as number) : null,
      })),
      fetchedAt: Date.now(),
      isStale,
      stats,
      changes: [],
    };
  }

  /**
   * Refresh catalog from all providers.
   */
  async refresh(options: {
    force?: boolean;
    query?: string;
  } = {}): Promise<CatalogResult> {
    if (!options.force && !this.db.isCacheStale()) {
      log('[CatalogManager] Cache is fresh, returning cached data');
      return this.getCached();
    }

    log('[CatalogManager] Refreshing from providers...');

    const allChanges: Array<{
      serverId: string;
      type: string;
      source: string;
      fieldChanges?: Record<string, unknown>;
    }> = [];

    // Fetch from all providers concurrently
    const results = await Promise.allSettled(
      this.providers.map(provider => this.fetchProvider(provider, options.query))
    );

    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i];
      const result = results[i];

      if (result.status === 'rejected') {
        log(`[${provider.id}] Failed: ${result.reason}`);
        this.db.updateProviderStatus(
          provider.id,
          provider.name,
          false,
          0,
          String(result.reason)
        );
      } else if (result.value) {
        for (const change of result.value.changes) {
          allChanges.push({
            serverId: change.serverId,
            type: change.changeType,
            source: provider.id,
            fieldChanges: change.fieldChanges,
          });
        }
      }
    }

    // Get updated data from DB
    const cached = await this.getCached();
    cached.changes = allChanges as CatalogResult['changes'];

    log(`[CatalogManager] Refresh complete. ${allChanges.length} changes.`);
    return cached;
  }

  private async fetchProvider(
    provider: CatalogProvider,
    query?: string
  ): Promise<{ changes: ServerChange[] }> {
    try {
      const result = await provider.fetch(query);

      if (!result.ok) {
        this.db.updateProviderStatus(
          provider.id,
          provider.name,
          false,
          0,
          result.error
        );
        return { changes: [] };
      }

      // Upsert servers and track changes
      const changes = this.db.upsertServers(result.servers, provider.id);

      // Mark servers not seen in this fetch as removed
      const seenIds = new Set(result.servers.map(s => s.id));
      const removalChanges = this.db.markRemoved(provider.id, seenIds);
      changes.push(...removalChanges);

      // Update provider status
      this.db.updateProviderStatus(
        provider.id,
        provider.name,
        true,
        result.servers.length
      );

      log(`[${provider.id}] Updated ${result.servers.length} servers, ${changes.length} changes`);
      return { changes };

    } catch (error) {
      log(`[${provider.id}] Fetch error: ${error}`);
      this.db.updateProviderStatus(
        provider.id,
        provider.name,
        false,
        0,
        String(error)
      );
      return { changes: [] };
    }
  }

  /**
   * Search servers by name or description.
   */
  async search(query: string, limit: number = 100): Promise<CatalogResult> {
    const servers = this.db.searchServers(query, limit);

    return {
      servers,
      providerStatus: [],
      fetchedAt: Date.now(),
    };
  }

  /**
   * Main entry point - get catalog data.
   */
  async fetchAll(options: {
    forceRefresh?: boolean;
    query?: string;
  } = {}): Promise<CatalogResult> {
    if (options.query) {
      return this.search(options.query);
    }

    if (options.forceRefresh) {
      return this.refresh({ force: true });
    }

    // Return cached data, but note if stale
    const cached = await this.getCached();

    // If stale, trigger background refresh
    if (cached.isStale) {
      log('[CatalogManager] Cache is stale, triggering background refresh');
      // Don't await - let it run in background
      this.refresh().catch(e => log(`[CatalogManager] Background refresh error: ${e}`));
    }

    return cached;
  }
}

// Singleton
let _manager: CatalogManager | null = null;

export function getCatalogManager(): CatalogManager {
  if (!_manager) {
    _manager = new CatalogManager();
  }
  return _manager;
}





