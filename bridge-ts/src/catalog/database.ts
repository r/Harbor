/**
 * SQLite database for persistent catalog storage using Drizzle ORM.
 */

import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq, like, or, desc, asc, and, ne, sql, notInArray } from 'drizzle-orm';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { CatalogServer } from '../types.js';
import { log } from '../native-messaging.js';
import * as schema from './schema.js';
import { servers, providerStatus, Server } from './schema.js';

const DB_DIR = join(homedir(), '.harbor');
const DB_PATH = join(DB_DIR, 'catalog.db');

// Priority scoring weights
const SCORE_REMOTE_ENDPOINT = 1000;
const SCORE_REMOTE_CAPABLE = 400;
const SCORE_FEATURED = 500;
const SCORE_OFFICIAL_TAG = 300;
const SCORE_OFFICIAL_SOURCE = 200;
const SCORE_HAS_DESCRIPTION = 50;
const SCORE_HAS_REPO = 25;
const SCORE_RECENT_UPDATE = 100;

// Staleness threshold
const STALE_THRESHOLD_HOURS = 1;

export interface ServerChange {
  serverId: string;
  changeType: 'added' | 'updated' | 'removed' | 'restored';
  fieldChanges?: Record<string, unknown>;
}

function computePriorityScore(
  endpointUrl: string,
  source: string,
  isFeatured: boolean,
  description: string,
  repositoryUrl: string,
  tags: string[],
  popularityScore: number = 0,
  lastUpdatedAt?: number
): number {
  let score = 0;

  if (endpointUrl) {
    score += SCORE_REMOTE_ENDPOINT;
  } else if (tags.includes('remote_capable')) {
    score += SCORE_REMOTE_CAPABLE;
  }

  if (isFeatured || tags.includes('featured')) {
    score += SCORE_FEATURED;
  }

  if (tags.includes('official')) {
    score += SCORE_OFFICIAL_TAG;
  }

  if (source === 'official_registry') {
    score += SCORE_OFFICIAL_SOURCE;
  }

  if (description) {
    score += SCORE_HAS_DESCRIPTION;
  }
  if (repositoryUrl) {
    score += SCORE_HAS_REPO;
  }

  score += Math.min(popularityScore, 500);

  if (lastUpdatedAt) {
    const daysAgo = (Date.now() - lastUpdatedAt) / 86400000;
    if (daysAgo < 7) {
      score += SCORE_RECENT_UPDATE;
    }
  }

  return score;
}

export class CatalogDatabase {
  private sqlite: Database.Database;
  private db: BetterSQLite3Database<typeof schema>;

  constructor() {
    mkdirSync(DB_DIR, { recursive: true });
    this.sqlite = new Database(DB_PATH);
    this.db = drizzle(this.sqlite, { schema });
    this.initDatabase();
    log('[CatalogDatabase] Initialized with Drizzle ORM');
  }

  private initDatabase(): void {
    // Create tables if they don't exist
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source TEXT NOT NULL,
        endpoint_url TEXT DEFAULT '',
        installable_only INTEGER DEFAULT 1,
        description TEXT DEFAULT '',
        homepage_url TEXT DEFAULT '',
        repository_url TEXT DEFAULT '',
        tags TEXT DEFAULT '[]',
        packages TEXT DEFAULT '[]',
        first_seen_at REAL NOT NULL,
        last_seen_at REAL NOT NULL,
        last_updated_at REAL,
        is_removed INTEGER DEFAULT 0,
        removed_at REAL,
        is_featured INTEGER DEFAULT 0,
        popularity_score INTEGER DEFAULT 0,
        priority_score INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_servers_source ON servers(source);
      CREATE INDEX IF NOT EXISTS idx_servers_priority ON servers(priority_score DESC);
      CREATE INDEX IF NOT EXISTS idx_servers_removed ON servers(is_removed);
      CREATE INDEX IF NOT EXISTS idx_servers_endpoint ON servers(endpoint_url);

      CREATE TABLE IF NOT EXISTS provider_status (
        provider_id TEXT PRIMARY KEY,
        provider_name TEXT NOT NULL,
        last_fetch_at REAL,
        last_success_at REAL,
        last_error TEXT,
        server_count INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
  }

  getAllServers(options: {
    includeRemoved?: boolean;
    remoteOnly?: boolean;
    source?: string;
    limit?: number;
  } = {}): CatalogServer[] {
    const conditions = [];
    
    if (!options.includeRemoved) {
      conditions.push(eq(servers.isRemoved, false));
    }
    
    if (options.remoteOnly) {
      conditions.push(ne(servers.endpointUrl, ''));
    }
    
    if (options.source) {
      conditions.push(eq(servers.source, options.source));
    }

    let query = this.db
      .select()
      .from(servers)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(servers.priorityScore), asc(servers.name));

    if (options.limit) {
      query = query.limit(options.limit) as typeof query;
    }

    const rows = query.all();
    return rows.map(row => this.rowToServer(row));
  }

  searchServers(query: string, limit: number = 100): CatalogServer[] {
    const searchTerm = `%${query}%`;
    
    const rows = this.db
      .select()
      .from(servers)
      .where(
        and(
          eq(servers.isRemoved, false),
          or(
            like(servers.name, searchTerm),
            like(servers.description, searchTerm)
          )
        )
      )
      .orderBy(desc(servers.priorityScore))
      .limit(limit)
      .all();

    return rows.map(row => this.rowToServer(row));
  }

  upsertServers(catalogServers: CatalogServer[], source: string): ServerChange[] {
    const changes: ServerChange[] = [];
    const now = Date.now();

    for (const server of catalogServers) {
      const existing = this.db
        .select()
        .from(servers)
        .where(eq(servers.id, server.id))
        .get();

      const tags = server.tags;
      const priority = computePriorityScore(
        server.endpointUrl,
        source,
        server.isFeatured || false,
        server.description,
        server.repositoryUrl,
        tags,
        0,
        now
      );

      if (!existing) {
        // New server - insert
        this.db.insert(servers).values({
          id: server.id,
          name: server.name,
          source,
          endpointUrl: server.endpointUrl,
          installableOnly: server.installableOnly,
          description: server.description,
          homepageUrl: server.homepageUrl,
          repositoryUrl: server.repositoryUrl,
          tags,
          packages: server.packages,
          firstSeenAt: now,
          lastSeenAt: now,
          lastUpdatedAt: now,
          isFeatured: server.isFeatured || false,
          popularityScore: 0,
          priorityScore: priority,
        }).run();

        changes.push({ serverId: server.id, changeType: 'added' });
      } else {
        // Existing server - check for changes and update
        const wasRemoved = existing.isRemoved;
        const fieldChanges: Record<string, unknown> = {};

        if (existing.name !== server.name) {
          fieldChanges.name = server.name;
        }
        if (existing.endpointUrl !== server.endpointUrl) {
          fieldChanges.endpointUrl = server.endpointUrl;
        }
        if (existing.description !== server.description) {
          fieldChanges.description = server.description;
        }

        const hasChanges = Object.keys(fieldChanges).length > 0;

        this.db.update(servers)
          .set({
            name: server.name,
            endpointUrl: server.endpointUrl,
            installableOnly: server.installableOnly,
            description: server.description,
            homepageUrl: server.homepageUrl,
            repositoryUrl: server.repositoryUrl,
            tags,
            packages: server.packages,
            lastSeenAt: now,
            lastUpdatedAt: hasChanges ? now : existing.lastUpdatedAt,
            isRemoved: false,
            removedAt: null,
            isFeatured: server.isFeatured || false,
            popularityScore: 0,
            priorityScore: priority,
          })
          .where(eq(servers.id, server.id))
          .run();

        if (wasRemoved) {
          changes.push({ serverId: server.id, changeType: 'restored' });
        } else if (hasChanges) {
          changes.push({ serverId: server.id, changeType: 'updated', fieldChanges });
        }
      }
    }

    return changes;
  }

  markRemoved(source: string, seenIds: Set<string>): ServerChange[] {
    const changes: ServerChange[] = [];
    const now = Date.now();

    // Find servers from this source that weren't seen
    const seenArray = Array.from(seenIds);
    
    let toRemove: { id: string }[];
    if (seenArray.length > 0) {
      toRemove = this.db
        .select({ id: servers.id })
        .from(servers)
        .where(
          and(
            eq(servers.source, source),
            eq(servers.isRemoved, false),
            notInArray(servers.id, seenArray)
          )
        )
        .all();
    } else {
      toRemove = this.db
        .select({ id: servers.id })
        .from(servers)
        .where(
          and(
            eq(servers.source, source),
            eq(servers.isRemoved, false)
          )
        )
        .all();
    }

    for (const row of toRemove) {
      this.db.update(servers)
        .set({ isRemoved: true, removedAt: now })
        .where(eq(servers.id, row.id))
        .run();
      
      changes.push({ serverId: row.id, changeType: 'removed' });
    }

    return changes;
  }

  updateProviderStatus(
    providerId: string,
    providerName: string,
    success: boolean,
    serverCount: number = 0,
    error: string | null = null
  ): void {
    const now = Date.now();

    // Upsert using INSERT OR REPLACE
    this.db.insert(providerStatus)
      .values({
        providerId,
        providerName,
        lastFetchAt: now,
        lastSuccessAt: success ? now : null,
        lastError: error,
        serverCount: success ? serverCount : 0,
      })
      .onConflictDoUpdate({
        target: providerStatus.providerId,
        set: {
          lastFetchAt: now,
          lastSuccessAt: success ? now : sql`last_success_at`,
          lastError: error,
          serverCount: success ? serverCount : sql`server_count`,
        },
      })
      .run();
  }

  getProviderStatus(): Array<Record<string, unknown>> {
    return this.db.select().from(providerStatus).all();
  }

  isCacheStale(): boolean {
    const threshold = Date.now() - (STALE_THRESHOLD_HOURS * 3600 * 1000);

    const result = this.db
      .select({ count: sql<number>`count(*)` })
      .from(providerStatus)
      .where(
        or(
          sql`${providerStatus.lastSuccessAt} IS NULL`,
          sql`${providerStatus.lastSuccessAt} < ${threshold}`
        )
      )
      .get();

    return result ? result.count > 0 : true;
  }

  getStats(): { total: number; remote: number; removed: number; featured: number } {
    const result = this.db
      .select({
        total: sql<number>`count(*)`,
        remote: sql<number>`sum(case when ${servers.endpointUrl} != '' then 1 else 0 end)`,
        removed: sql<number>`sum(case when ${servers.isRemoved} = 1 then 1 else 0 end)`,
        featured: sql<number>`sum(case when ${servers.isFeatured} = 1 then 1 else 0 end)`,
      })
      .from(servers)
      .get();

    return {
      total: result?.total || 0,
      remote: result?.remote || 0,
      removed: result?.removed || 0,
      featured: result?.featured || 0,
    };
  }

  private rowToServer(row: Server): CatalogServer {
    // Map packages to the correct type
    const packages = (row.packages || []).map(p => ({
      registryType: p.registryType as 'npm' | 'pypi' | 'oci',
      identifier: p.identifier,
      environmentVariables: p.environmentVariables,
    }));

    return {
      id: row.id,
      name: row.name,
      source: row.source,
      endpointUrl: row.endpointUrl || '',
      installableOnly: row.installableOnly ?? true,
      packages,
      description: row.description || '',
      homepageUrl: row.homepageUrl || '',
      repositoryUrl: row.repositoryUrl || '',
      tags: row.tags || [],
      fetchedAt: row.lastSeenAt || Date.now(),
      isRemoved: row.isRemoved ?? false,
      isFeatured: row.isFeatured ?? false,
      priorityScore: row.priorityScore || 0,
    };
  }

  close(): void {
    this.sqlite.close();
  }
}

// Singleton
let _db: CatalogDatabase | null = null;

export function getCatalogDb(): CatalogDatabase {
  if (!_db) {
    _db = new CatalogDatabase();
  }
  return _db;
}
