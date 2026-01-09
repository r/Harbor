/**
 * Catalog Client
 * 
 * Used by the main bridge process to communicate with the catalog worker.
 * This client provides a simple API for:
 * - Reading from the catalog database (direct access)
 * - Sending commands to the worker (via IPC)
 * - Receiving status updates from the worker
 * 
 * The main bridge should use this instead of CatalogManager when running
 * with the worker architecture.
 * 
 * PKG COMPATIBILITY:
 * Instead of forking a separate worker.js file (which doesn't work in pkg binaries),
 * we fork the same executable with a special flag (--catalog-worker).
 * The main.ts entry point detects this flag and runs in worker mode.
 */

import { fork, ChildProcess } from 'child_process';
import { log } from '../native-messaging.js';
import { getCatalogDb, CatalogDatabase } from './database.js';
import { CatalogServer, CatalogResult, ProviderStatus } from '../types.js';

export interface CatalogClientOptions {
  /** Start worker automatically on client creation */
  autoStart?: boolean;
  /** Refresh interval in ms (passed to worker) */
  refreshIntervalMs?: number;
  /** Callback for worker status updates */
  onStatus?: (status: string, data?: Record<string, unknown>) => void;
}

export type WorkerStatus = 'stopped' | 'starting' | 'running' | 'error';

export class CatalogClient {
  private db: CatalogDatabase;
  private worker: ChildProcess | null = null;
  private workerStatus: WorkerStatus = 'stopped';
  private pendingRequests = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();
  private requestIdCounter = 0;
  private options: CatalogClientOptions;
  
  constructor(options: CatalogClientOptions = {}) {
    this.options = {
      autoStart: true,
      refreshIntervalMs: 60 * 60 * 1000, // 1 hour
      ...options,
    };
    
    this.db = getCatalogDb();
    
    if (this.options.autoStart) {
      this.startWorker();
    }
  }
  
  // ===========================================================================
  // Worker Lifecycle
  // ===========================================================================
  
  startWorker(): void {
    if (this.worker) {
      log('[CatalogClient] Worker already running');
      return;
    }
    
    log('[CatalogClient] Starting catalog worker...');
    this.workerStatus = 'starting';
    
    // Fork the worker process using pkg-compatible approach:
    // Instead of forking worker.js (which doesn't exist in pkg binaries),
    // we fork the same script with a special flag.
    // Main.ts detects --catalog-worker and runs in worker mode.
    // fork(modulePath, args) - modulePath is the script to run, NOT the node executable
    const scriptPath = process.argv[1]; // e.g., /path/to/main.js
    this.worker = fork(scriptPath, ['--catalog-worker'], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      // Ensure proper environment for pkg
      env: {
        ...process.env,
        // Prevent nested worker spawning
        HARBOR_CATALOG_WORKER: '0',
      },
    });
    
    // Handle worker messages
    this.worker.on('message', (message: { type: string; id?: string; success?: boolean; data?: unknown; error?: string }) => {
      this.handleWorkerMessage(message);
    });
    
    // Handle worker stdout/stderr (for logging)
    this.worker.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        log(`[CatalogWorker] ${line}`);
      }
    });
    
    this.worker.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        log(`[CatalogWorker:err] ${line}`);
      }
    });
    
    // Handle worker exit
    this.worker.on('exit', (code) => {
      log(`[CatalogClient] Worker exited with code ${code}`);
      this.worker = null;
      this.workerStatus = code === 0 ? 'stopped' : 'error';
      
      // Reject pending requests
      for (const [id, pending] of this.pendingRequests) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Worker exited'));
        this.pendingRequests.delete(id);
      }
    });
    
    this.worker.on('error', (error) => {
      log(`[CatalogClient] Worker error: ${error}`);
      this.workerStatus = 'error';
    });
    
    // Set refresh interval
    this.sendToWorker({
      type: 'set_interval',
      intervalMs: this.options.refreshIntervalMs,
    });
    
    this.workerStatus = 'running';
  }
  
  stopWorker(): void {
    if (!this.worker) {
      return;
    }
    
    log('[CatalogClient] Stopping catalog worker...');
    this.sendToWorker({ type: 'shutdown' });
    
    // Force kill after timeout
    setTimeout(() => {
      if (this.worker) {
        this.worker.kill();
        this.worker = null;
      }
    }, 5000);
    
    this.workerStatus = 'stopped';
  }
  
  getWorkerStatus(): WorkerStatus {
    return this.workerStatus;
  }
  
  // ===========================================================================
  // IPC Communication
  // ===========================================================================
  
  private sendToWorker(message: { type: string; [key: string]: unknown }): void {
    if (!this.worker) {
      throw new Error('Worker not running');
    }
    this.worker.send(message);
  }
  
  private async sendRequest<T>(
    type: string, 
    data?: Record<string, unknown>,
    timeoutMs = 30000
  ): Promise<T> {
    if (!this.worker) {
      throw new Error('Worker not running');
    }
    
    const id = String(++this.requestIdCounter);
    
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${type} timed out`));
      }, timeoutMs);
      
      this.pendingRequests.set(id, { resolve: resolve as (v: unknown) => void, reject, timeout });
      this.sendToWorker({ type, id, ...data });
    });
  }
  
  private handleWorkerMessage(message: { type: string; id?: string; success?: boolean; data?: unknown; error?: string }): void {
    // Handle status updates
    if (message.type === 'status') {
      if (this.options.onStatus && message.data) {
        const data = message.data as Record<string, unknown>;
        this.options.onStatus(data.status as string, data);
      }
      return;
    }
    
    // Handle request responses
    if (message.id && this.pendingRequests.has(message.id)) {
      const pending = this.pendingRequests.get(message.id)!;
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(message.id);
      
      if (message.success) {
        pending.resolve(message.data);
      } else {
        pending.reject(new Error(message.error || 'Unknown error'));
      }
    }
  }
  
  // ===========================================================================
  // Catalog API (Read-Only, Direct DB Access)
  // ===========================================================================
  
  /**
   * Get all servers from the catalog.
   * This reads directly from the database (fast).
   */
  getServers(options?: { includeRemoved?: boolean }): CatalogServer[] {
    return this.db.getAllServers({ includeRemoved: options?.includeRemoved });
  }
  
  /**
   * Search servers by query.
   * This reads directly from the database (fast).
   */
  searchServers(query: string): CatalogServer[] {
    return this.db.search(query);
  }
  
  /**
   * Get a single server by ID.
   */
  getServer(id: string): CatalogServer | undefined {
    return this.db.getAllServers().find(s => s.id === id);
  }
  
  /**
   * Get provider status.
   */
  getProviderStatus(): ProviderStatus[] {
    const rows = this.db.getProviderStatus();
    return rows.map(row => ({
      id: row.providerId as string,
      name: row.providerName as string,
      ok: !!row.lastSuccessAt,
      count: row.serverCount as number | null,
      error: row.lastError as string | null,
      fetchedAt: row.lastFetchAt as number | null,
    }));
  }
  
  /**
   * Get catalog stats.
   */
  getStats(): { total: number; removed: number; bySource: Record<string, number> } {
    return this.db.getStats();
  }
  
  /**
   * Check if cache is stale.
   */
  isCacheStale(): boolean {
    return this.db.isCacheStale();
  }
  
  /**
   * Get full catalog result (for extension API compatibility).
   */
  getCatalog(): CatalogResult {
    const servers = this.db.getAllServers();
    const providerStatus = this.getProviderStatus();
    
    return {
      servers,
      providerStatus,
      fetchedAt: this.db.getLastFetchTime() || Date.now(),
      isStale: this.db.isCacheStale(),
      changes: [],
    };
  }
  
  // ===========================================================================
  // Catalog API (Commands to Worker)
  // ===========================================================================
  
  /**
   * Request a catalog refresh.
   * Returns after the refresh is complete.
   */
  async refresh(force = false): Promise<{ changes: number; serverCount: number }> {
    const result = await this.sendRequest<{ changes: { length: number }; serverCount: number }>(
      'refresh',
      { force }
    );
    return { changes: result.changes?.length || 0, serverCount: result.serverCount };
  }
  
  /**
   * Request enrichment of servers without popularity data.
   */
  async enrich(): Promise<{ enriched: number; failed: number }> {
    return this.sendRequest<{ enriched: number; failed: number }>('enrich');
  }
  
  /**
   * Request a full refresh + enrichment.
   */
  async fullRefresh(): Promise<{ serverCount: number }> {
    return this.sendRequest<{ serverCount: number }>('full_refresh', {}, 120000); // 2 min timeout
  }
  
  /**
   * Get worker status.
   */
  async getWorkerInfo(): Promise<{
    isRunning: boolean;
    stats: { total: number; removed: number };
    providers: ProviderStatus[];
    cacheStale: boolean;
  }> {
    return this.sendRequest('get_status');
  }
  
  /**
   * Pause automatic refresh.
   */
  async pauseAutoRefresh(): Promise<void> {
    await this.sendRequest('stop');
  }
  
  /**
   * Resume automatic refresh.
   */
  async resumeAutoRefresh(intervalMs?: number): Promise<void> {
    await this.sendRequest('set_interval', { 
      intervalMs: intervalMs || this.options.refreshIntervalMs,
    });
  }
  
  // ===========================================================================
  // Cleanup
  // ===========================================================================
  
  close(): void {
    this.stopWorker();
    this.db.close();
  }
}

// Singleton
let _client: CatalogClient | null = null;

export function getCatalogClient(options?: CatalogClientOptions): CatalogClient {
  if (!_client) {
    _client = new CatalogClient(options);
  }
  return _client;
}

export function resetCatalogClient(): void {
  if (_client) {
    _client.close();
    _client = null;
  }
}

