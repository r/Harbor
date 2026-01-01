/**
 * Catalog Manager - orchestrates providers, enrichment, and database.
 * 
 * This is the main entry point for the catalog system.
 * 
 * Architecture:
 * - Discovery: ProviderRegistry manages multiple data sources
 * - Enrichment: EnrichmentManager adds popularity data
 * - Storage: CatalogDatabase persists everything to SQLite
 * 
 * The layers are cleanly separated so any can be replaced:
 * - Replace providers with a cloud registry service
 * - Replace enrichment with a hosted popularity API
 * - Replace storage with a remote database
 */

import { log, pushStatus } from '../native-messaging.js';
import { CatalogResult, ProviderStatus } from '../types.js';
import { CatalogProvider } from './base.js';
import { CatalogDatabase, getCatalogDb, ServerChange } from './database.js';
import { getProviderRegistry, ProviderRegistry } from './provider-registry.js';
import { getEnrichmentManager, EnrichmentManager } from './enrichment.js';

export interface CatalogManagerOptions {
  /** Enable enrichment (GitHub stars, npm downloads). Default: true */
  enableEnrichment?: boolean;
  /** Maximum servers to enrich per refresh (to avoid rate limits). Default: 50 */
  maxEnrichmentPerRefresh?: number;
}

export class CatalogManager {
  private providerRegistry: ProviderRegistry;
  private enrichmentManager: EnrichmentManager;
  private db: CatalogDatabase;
  private options: Required<CatalogManagerOptions>;

  constructor(options: CatalogManagerOptions = {}) {
    this.options = {
      enableEnrichment: options.enableEnrichment ?? true,
      maxEnrichmentPerRefresh: options.maxEnrichmentPerRefresh ?? 50,
    };

    // Use the singleton registries (can be configured externally)
    this.providerRegistry = getProviderRegistry();
    this.enrichmentManager = getEnrichmentManager();
    this.db = getCatalogDb();
    
    log(`[CatalogManager] Initialized with ${this.providerRegistry.getIds().length} providers, enrichment: ${this.options.enableEnrichment}`);
  }

  /**
   * Get the provider registry for external configuration.
   */
  getProviderRegistry(): ProviderRegistry {
    return this.providerRegistry;
  }

  /**
   * Get the enrichment manager for external configuration.
   */
  getEnrichmentManager(): EnrichmentManager {
    return this.enrichmentManager;
  }

  /**
   * Get the catalog database for direct access.
   */
  getDatabase(): CatalogDatabase {
    return this.db;
  }

  getProvider(providerId: string): CatalogProvider | undefined {
    return this.providerRegistry.get(providerId);
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
    skipEnrichment?: boolean;
  } = {}): Promise<CatalogResult> {
    if (!options.force && !this.db.isCacheStale()) {
      log('[CatalogManager] Cache is fresh, returning cached data');
      pushStatus('catalog', 'ready', { message: 'Using cached catalog' });
      return this.getCached();
    }

    log('[CatalogManager] Refreshing from providers...');
    pushStatus('catalog', 'fetching', { message: 'Fetching server listings...' });

    const allChanges: Array<{
      serverId: string;
      type: string;
      source: string;
      fieldChanges?: Record<string, unknown>;
    }> = [];

    // Fetch from all enabled providers via registry
    const enabledProviders = this.providerRegistry.getEnabled();
    
    pushStatus('catalog', 'fetching', { 
      message: `Fetching from ${enabledProviders.length} providers...`,
      providers: enabledProviders.map(p => p.id),
    });
    
    const results = await Promise.allSettled(
      enabledProviders.map(provider => this.fetchProvider(provider, options.query))
    );

    let totalServers = 0;
    for (let i = 0; i < enabledProviders.length; i++) {
      const provider = enabledProviders[i];
      const result = results[i];

      if (result.status === 'rejected') {
        log(`[${provider.id}] Failed: ${result.reason}`);
        pushStatus('catalog', 'provider_error', { 
          provider: provider.id, 
          error: String(result.reason),
        });
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
        totalServers += result.value.changes.length;
      }
    }

    const stats = this.db.getStats();
    pushStatus('catalog', 'fetched', { 
      message: `Found ${stats.total} servers`,
      serverCount: stats.total,
      changes: allChanges.length,
    });

    // Run enrichment for new/updated servers (in background)
    if (this.options.enableEnrichment && !options.skipEnrichment) {
      const newServerIds = new Set(
        allChanges
          .filter(c => c.type === 'added' || c.type === 'updated')
          .map(c => c.serverId)
      );
      
      if (newServerIds.size > 0) {
        // Don't await - run in background
        this.enrichNewServers(newServerIds).catch(err => {
          log(`[CatalogManager] Background enrichment failed: ${err}`);
          pushStatus('catalog', 'enrichment_error', { error: String(err) });
        });
      }
    }

    // Get updated data from DB
    const cached = await this.getCached();
    cached.changes = allChanges as CatalogResult['changes'];

    log(`[CatalogManager] Refresh complete. ${allChanges.length} changes.`);
    pushStatus('catalog', 'ready', { 
      message: `Catalog ready: ${stats.total} servers`,
      serverCount: stats.total,
    });
    
    return cached;
  }

  /**
   * Enrich newly discovered servers in the background.
   */
  private async enrichNewServers(serverIds: Set<string>): Promise<void> {
    const servers = this.db.getAllServers()
      .filter(s => serverIds.has(s.id))
      .slice(0, this.options.maxEnrichmentPerRefresh);
    
    if (servers.length === 0) return;

    log(`[CatalogManager] Enriching ${servers.length} new servers...`);
    pushStatus('catalog', 'enriching', { 
      message: `Getting popularity data for ${servers.length} servers...`,
      count: servers.length,
    });
    
    const stats = await this.enrichmentManager.enrichBatch(servers, {
      concurrency: 3,
      batchDelay: 200, // Avoid rate limits
    });

    // Update popularity scores in database
    const updates: Array<{
      serverId: string;
      githubStars?: number;
      npmDownloads?: number;
      lastCommitAt?: number;
      popularityScore?: number;
    }> = [];

    for (const server of servers) {
      const enrichment = this.enrichmentManager.getResult(server.id);
      if (enrichment) {
        const popularityScore = this.enrichmentManager.computePopularityScore(enrichment);
        updates.push({
          serverId: server.id,
          githubStars: enrichment.githubStars,
          npmDownloads: enrichment.npmDownloads,
          lastCommitAt: enrichment.lastCommitAt,
          popularityScore,
        });
        log(`[CatalogManager] ${server.name}: ⭐${enrichment.githubStars || 0} 📦${enrichment.npmDownloads || 0} score=${popularityScore}`);
      }
    }

    // Batch update database
    if (updates.length > 0) {
      this.db.updateEnrichmentBatch(updates);
      log(`[CatalogManager] Saved ${updates.length} enrichment results to database`);
    }

    log(`[CatalogManager] Enrichment complete: ${stats.enriched}/${stats.total} in ${stats.duration}ms`);
    pushStatus('catalog', 'enrichment_done', { 
      message: `Enriched ${stats.enriched} servers`,
      enriched: stats.enriched,
      failed: stats.failed,
    });
  }

  /**
   * Force enrichment of all servers (useful for initial population).
   */
  async enrichAll(): Promise<{ enriched: number; failed: number }> {
    const servers = this.db.getAllServers();
    log(`[CatalogManager] Enriching all ${servers.length} servers...`);

    const stats = await this.enrichmentManager.enrichBatch(servers, {
      concurrency: 3,
      batchDelay: 300, // Be careful with rate limits
    });

    // Update database
    const updates: Array<{
      serverId: string;
      githubStars?: number;
      npmDownloads?: number;
      lastCommitAt?: number;
      popularityScore?: number;
    }> = [];

    for (const server of servers) {
      const enrichment = this.enrichmentManager.getResult(server.id);
      if (enrichment && !enrichment.error) {
        const popularityScore = this.enrichmentManager.computePopularityScore(enrichment);
        updates.push({
          serverId: server.id,
          githubStars: enrichment.githubStars,
          npmDownloads: enrichment.npmDownloads,
          lastCommitAt: enrichment.lastCommitAt,
          popularityScore,
        });
      }
    }

    if (updates.length > 0) {
      this.db.updateEnrichmentBatch(updates);
    }

    return { enriched: stats.enriched, failed: stats.failed };
  }

  private async fetchProvider(
    provider: CatalogProvider,
    query?: string
  ): Promise<{ changes: ServerChange[] }> {
    const providerLabel = provider.name || provider.id;
    
    try {
      pushStatus('catalog', 'provider_fetch', { 
        message: `Fetching from ${providerLabel}...`,
        provider: provider.id,
      });
      
      const result = await provider.fetch(query);

      if (!result.ok) {
        pushStatus('catalog', 'provider_error', { 
          message: `${providerLabel}: ${result.error}`,
          provider: provider.id,
          error: result.error,
        });
        this.db.updateProviderStatus(
          provider.id,
          provider.name,
          false,
          0,
          result.error
        );
        return { changes: [] };
      }

      pushStatus('catalog', 'provider_done', { 
        message: `${providerLabel}: ${result.servers.length} servers`,
        provider: provider.id,
        count: result.servers.length,
      });

      // Upsert servers and track changes
      pushStatus('catalog', 'saving', { 
        message: `Saving ${result.servers.length} servers to database...`,
      });
      
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
      pushStatus('catalog', 'provider_error', { 
        message: `${providerLabel} failed: ${String(error).substring(0, 50)}`,
        provider: provider.id,
        error: String(error),
      });
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

    // If cache is EMPTY and stale, actually wait for refresh (first load case)
    if (cached.servers.length === 0 && cached.isStale) {
      log('[CatalogManager] Cache is empty, doing blocking refresh for first load...');
      pushStatus('catalog', 'initializing', { 
        message: 'Building catalog for first time...',
      });
      return this.refresh({ force: true });
    }

    // If stale but has data, trigger background refresh
    if (cached.isStale) {
      log('[CatalogManager] Cache is stale, triggering background refresh');
      pushStatus('catalog', 'background_refresh', { 
        message: 'Updating catalog in background...',
        serverCount: cached.servers.length,
      });
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





