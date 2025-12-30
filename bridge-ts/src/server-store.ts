/**
 * Server store - manages MCP server configurations.
 * 
 * Stores server configurations in a SQLite database.
 */

import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ServerConfig, ServerStatus } from './types.js';
import { log } from './native-messaging.js';

const DATA_DIR = join(homedir(), '.harbor');
const DB_PATH = join(DATA_DIR, 'harbor.db');

function generateId(): string {
  return Math.random().toString(36).substring(2, 10) + 
         Math.random().toString(36).substring(2, 10);
}

export class ServerStore {
  private db: Database.Database;

  constructor() {
    mkdirSync(DATA_DIR, { recursive: true });
    this.db = new Database(DB_PATH);
    this.initDatabase();
    log('[ServerStore] Initialized');
  }

  private initDatabase(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS servers (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        base_url TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'disconnected',
        last_error TEXT,
        added_at INTEGER NOT NULL,
        last_connected_at INTEGER
      );
    `);
  }

  async addServer(label: string, baseUrl: string): Promise<ServerConfig> {
    const id = generateId();
    const addedAt = Date.now();

    const stmt = this.db.prepare(`
      INSERT INTO servers (id, label, base_url, status, added_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(id, label, baseUrl, ServerStatus.DISCONNECTED, addedAt);

    return {
      id,
      label,
      baseUrl,
      status: ServerStatus.DISCONNECTED,
      addedAt,
    };
  }

  async removeServer(serverId: string): Promise<boolean> {
    const stmt = this.db.prepare('DELETE FROM servers WHERE id = ?');
    const result = stmt.run(serverId);
    return result.changes > 0;
  }

  async getServer(serverId: string): Promise<ServerConfig | null> {
    const stmt = this.db.prepare('SELECT * FROM servers WHERE id = ?');
    const row = stmt.get(serverId) as Record<string, unknown> | undefined;
    
    if (!row) return null;
    
    return this.rowToConfig(row);
  }

  async listServers(): Promise<ServerConfig[]> {
    const stmt = this.db.prepare('SELECT * FROM servers ORDER BY added_at DESC');
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map(row => this.rowToConfig(row));
  }

  async updateStatus(
    serverId: string, 
    status: ServerStatus, 
    error?: string
  ): Promise<void> {
    const updates: string[] = ['status = ?'];
    const params: unknown[] = [status];

    if (error !== undefined) {
      updates.push('last_error = ?');
      params.push(error);
    } else if (status !== ServerStatus.ERROR) {
      updates.push('last_error = NULL');
    }

    if (status === ServerStatus.CONNECTED) {
      updates.push('last_connected_at = ?');
      params.push(Date.now());
    }

    params.push(serverId);

    const stmt = this.db.prepare(`
      UPDATE servers SET ${updates.join(', ')} WHERE id = ?
    `);
    stmt.run(...params);
  }

  private rowToConfig(row: Record<string, unknown>): ServerConfig {
    return {
      id: row.id as string,
      label: row.label as string,
      baseUrl: row.base_url as string,
      status: row.status as ServerStatus,
      lastError: row.last_error as string | undefined,
      addedAt: row.added_at as number,
      lastConnectedAt: row.last_connected_at as number | undefined,
    };
  }

  close(): void {
    this.db.close();
  }
}

// Singleton
let _store: ServerStore | null = null;

export function getServerStore(): ServerStore {
  if (!_store) {
    _store = new ServerStore();
  }
  return _store;
}





