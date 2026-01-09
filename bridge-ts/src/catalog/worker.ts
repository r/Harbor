/**
 * Catalog Worker Process
 * 
 * This runs as a separate process from the main bridge, handling:
 * - Scraping from catalog providers (Official Registry, GitHub Awesome)
 * - Enrichment (GitHub stars, npm downloads)
 * - Database writes
 * 
 * The main bridge only reads from the database - this worker is the sole writer.
 * 
 * Communication:
 * - Receives commands via IPC from parent process
 * - Sends status updates back via IPC
 * - Database is the shared state (SQLite handles concurrent reads)
 */

import { getCatalogDb, CatalogDatabase } from './database.js';
import { getProviderRegistry, ProviderRegistry } from './provider-registry.js';
import { getEnrichmentManager, EnrichmentManager } from './enrichment.js';
import { CatalogServer } from '../types.js';
import { ServerChange } from './database.js';

// Worker-local log function (writes to stdout, captured by parent)
function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// Worker state
let db: CatalogDatabase;
let providerRegistry: ProviderRegistry;
let enrichmentManager: EnrichmentManager;
let isRunning = false;
let refreshInterval: NodeJS.Timeout | null = null;

// Configuration
const DEFAULT_REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MAX_ENRICHMENT_PER_REFRESH = 50;
const ENRICHMENT_CONCURRENCY = 3;
const ENRICHMENT_BATCH_DELAY_MS = 300;

interface WorkerMessage {
  type: string;
  id?: string;
  [key: string]: unknown;
}

interface WorkerResponse {
  type: string;
  id?: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

function sendToParent(message: WorkerResponse): void {
  if (process.send) {
    process.send(message);
  }
}

function sendStatus(status: string, data?: Record<string, unknown>): void {
  sendToParent({
    type: 'status',
    success: true,
    data: { status, ...data },
  });
}

// =============================================================================
// Refresh Logic (moved from CatalogManager)
// =============================================================================

async function refreshFromProviders(force = false): Promise<{
  changes: ServerChange[];
  serverCount: number;
}> {
  if (!force && !db.isCacheStale()) {
    log('[CatalogWorker] Cache is fresh, skipping refresh');
    return { changes: [], serverCount: db.getStats().total };
  }

  log('[CatalogWorker] Refreshing from providers...');
  sendStatus('refreshing', { message: 'Fetching from providers...' });

  const allChanges: ServerChange[] = [];
  const enabledProviders = providerRegistry.getEnabled();

  // Fetch from all providers concurrently
  const results = await Promise.allSettled(
    enabledProviders.map(async (provider) => {
      sendStatus('fetching', { provider: provider.id });
      
      try {
        const result = await provider.fetch();
        
        if (!result.ok) {
          db.updateProviderStatus(provider.id, provider.name, false, 0, result.error);
          return { changes: [], count: 0 };
        }

        // Upsert servers and track changes
        const changes = db.upsertServers(result.servers, provider.id);

        // Mark servers not seen in this fetch as removed
        const seenIds = new Set(result.servers.map(s => s.id));
        const removalChanges = db.markRemoved(provider.id, seenIds);
        changes.push(...removalChanges);

        // Update provider status
        db.updateProviderStatus(provider.id, provider.name, true, result.servers.length);

        log(`[CatalogWorker] ${provider.id}: ${result.servers.length} servers, ${changes.length} changes`);
        sendStatus('provider_done', { 
          provider: provider.id, 
          count: result.servers.length,
          changes: changes.length,
        });

        return { changes, count: result.servers.length };
      } catch (error) {
        log(`[CatalogWorker] ${provider.id} error: ${error}`);
        db.updateProviderStatus(provider.id, provider.name, false, 0, String(error));
        return { changes: [], count: 0 };
      }
    })
  );

  // Collect all changes
  for (const result of results) {
    if (result.status === 'fulfilled') {
      allChanges.push(...result.value.changes);
    }
  }

  const stats = db.getStats();
  log(`[CatalogWorker] Refresh complete: ${stats.total} total servers, ${allChanges.length} changes`);
  sendStatus('refresh_done', { 
    serverCount: stats.total, 
    changes: allChanges.length,
  });

  return { changes: allChanges, serverCount: stats.total };
}

async function runEnrichment(serverIds?: Set<string>): Promise<{
  enriched: number;
  failed: number;
}> {
  let servers: CatalogServer[];
  
  if (serverIds && serverIds.size > 0) {
    // Enrich specific servers
    servers = db.getAllServers().filter(s => serverIds.has(s.id));
  } else {
    // Enrich servers missing enrichment data
    servers = db.getAllServers().filter(s => !s.popularityScore);
  }
  
  servers = servers.slice(0, MAX_ENRICHMENT_PER_REFRESH);
  
  if (servers.length === 0) {
    return { enriched: 0, failed: 0 };
  }

  log(`[CatalogWorker] Enriching ${servers.length} servers...`);
  sendStatus('enriching', { count: servers.length });

  const stats = await enrichmentManager.enrichBatch(servers, {
    concurrency: ENRICHMENT_CONCURRENCY,
    batchDelay: ENRICHMENT_BATCH_DELAY_MS,
  });

  // Save enrichment results to database
  const updates: Array<{
    serverId: string;
    githubStars?: number;
    npmDownloads?: number;
    lastCommitAt?: number;
    popularityScore?: number;
  }> = [];

  for (const server of servers) {
    const enrichment = enrichmentManager.getResult(server.id);
    if (enrichment && !enrichment.error) {
      const popularityScore = enrichmentManager.computePopularityScore(enrichment);
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
    db.updateEnrichmentBatch(updates);
  }

  log(`[CatalogWorker] Enrichment complete: ${stats.enriched}/${stats.total}`);
  sendStatus('enrichment_done', { 
    enriched: stats.enriched, 
    failed: stats.failed,
  });

  return { enriched: stats.enriched, failed: stats.failed };
}

async function fullRefresh(): Promise<void> {
  const { changes } = await refreshFromProviders(true);
  
  // Enrich new/updated servers
  const newServerIds = new Set(
    changes
      .filter(c => c.changeType === 'added' || c.changeType === 'updated')
      .map(c => c.serverId)
  );
  
  if (newServerIds.size > 0) {
    await runEnrichment(newServerIds);
  }
}

// =============================================================================
// IPC Message Handling
// =============================================================================

async function handleMessage(message: WorkerMessage): Promise<void> {
  const { type, id } = message;
  
  try {
    switch (type) {
      case 'refresh': {
        const force = message.force === true;
        const result = await refreshFromProviders(force);
        sendToParent({
          type: 'refresh_result',
          id,
          success: true,
          data: result,
        });
        break;
      }
      
      case 'enrich': {
        const result = await runEnrichment();
        sendToParent({
          type: 'enrich_result',
          id,
          success: true,
          data: result,
        });
        break;
      }
      
      case 'full_refresh': {
        await fullRefresh();
        const stats = db.getStats();
        sendToParent({
          type: 'full_refresh_result',
          id,
          success: true,
          data: { serverCount: stats.total },
        });
        break;
      }
      
      case 'get_status': {
        const stats = db.getStats();
        const providers = db.getProviderStatus();
        sendToParent({
          type: 'status_result',
          id,
          success: true,
          data: {
            isRunning,
            stats,
            providers,
            cacheStale: db.isCacheStale(),
          },
        });
        break;
      }
      
      case 'set_interval': {
        const intervalMs = (message.intervalMs as number) || DEFAULT_REFRESH_INTERVAL_MS;
        startRefreshInterval(intervalMs);
        sendToParent({
          type: 'set_interval_result',
          id,
          success: true,
          data: { intervalMs },
        });
        break;
      }
      
      case 'stop': {
        stopRefreshInterval();
        sendToParent({
          type: 'stop_result',
          id,
          success: true,
        });
        break;
      }
      
      case 'shutdown': {
        log('[CatalogWorker] Shutting down...');
        stopRefreshInterval();
        db.close();
        process.exit(0);
        break;
      }
      
      default:
        sendToParent({
          type: `${type}_result`,
          id,
          success: false,
          error: `Unknown message type: ${type}`,
        });
    }
  } catch (error) {
    log(`[CatalogWorker] Error handling ${type}: ${error}`);
    sendToParent({
      type: `${type}_result`,
      id,
      success: false,
      error: String(error),
    });
  }
}

// =============================================================================
// Refresh Interval
// =============================================================================

function startRefreshInterval(intervalMs: number = DEFAULT_REFRESH_INTERVAL_MS): void {
  stopRefreshInterval();
  
  log(`[CatalogWorker] Starting refresh interval: ${intervalMs / 1000}s`);
  
  refreshInterval = setInterval(async () => {
    if (db.isCacheStale()) {
      log('[CatalogWorker] Cache stale, running scheduled refresh');
      await fullRefresh();
    }
  }, intervalMs);
}

function stopRefreshInterval(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
    log('[CatalogWorker] Stopped refresh interval');
  }
}

// =============================================================================
// Worker Entry Point
// =============================================================================

/**
 * Run the catalog worker.
 * This is called from main.ts when the --catalog-worker flag is passed.
 * 
 * This design allows the worker to be run from a pkg-compiled binary,
 * where we can't fork separate .js files.
 */
export async function runCatalogWorker(): Promise<void> {
  log('[CatalogWorker] Starting catalog worker process...');
  
  // Initialize components
  db = getCatalogDb();
  providerRegistry = getProviderRegistry();
  enrichmentManager = getEnrichmentManager();
  
  isRunning = true;
  
  // Listen for messages from parent
  process.on('message', (message: WorkerMessage) => {
    handleMessage(message).catch(err => {
      log(`[CatalogWorker] Message handler error: ${err}`);
    });
  });
  
  // Handle parent disconnect
  process.on('disconnect', () => {
    log('[CatalogWorker] Parent disconnected, shutting down');
    stopRefreshInterval();
    db.close();
    process.exit(0);
  });
  
  // Initial refresh if cache is stale
  if (db.isCacheStale()) {
    log('[CatalogWorker] Cache is stale, running initial refresh');
    sendStatus('initial_refresh', { message: 'Running initial catalog refresh...' });
    await fullRefresh();
  } else {
    const stats = db.getStats();
    log(`[CatalogWorker] Cache is fresh: ${stats.total} servers`);
    sendStatus('ready', { serverCount: stats.total });
  }
  
  // Start periodic refresh
  startRefreshInterval();
  
  log('[CatalogWorker] Worker ready');
  sendStatus('ready', { message: 'Catalog worker initialized' });
  
  // Keep the process alive - wait for parent to disconnect
  await new Promise<void>(() => {
    // This promise never resolves - we exit via the disconnect handler
  });
}

