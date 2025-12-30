/**
 * Chat Session Store - persists chat sessions to disk.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ChatSession, serializeSession, deserializeSession } from './session.js';
import { log } from '../native-messaging.js';

/**
 * Get the sessions directory path.
 */
function getSessionsDir(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
  return path.join(homeDir, '.harbor', 'sessions');
}

/**
 * Ensure the sessions directory exists.
 */
function ensureSessionsDir(): void {
  const dir = getSessionsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Get the file path for a session.
 */
function getSessionPath(sessionId: string): string {
  return path.join(getSessionsDir(), `${sessionId}.json`);
}

/**
 * Chat Session Store.
 */
export class ChatSessionStore {
  private sessions: Map<string, ChatSession> = new Map();
  private loaded: boolean = false;
  
  /**
   * Load all sessions from disk.
   */
  load(): void {
    if (this.loaded) return;
    
    try {
      ensureSessionsDir();
      const dir = getSessionsDir();
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
      
      for (const file of files) {
        try {
          const filePath = path.join(dir, file);
          const data = fs.readFileSync(filePath, 'utf-8');
          const session = deserializeSession(data);
          this.sessions.set(session.id, session);
        } catch (error) {
          log(`[ChatSessionStore] Failed to load session ${file}: ${error}`);
        }
      }
      
      log(`[ChatSessionStore] Loaded ${this.sessions.size} sessions`);
      this.loaded = true;
    } catch (error) {
      log(`[ChatSessionStore] Failed to load sessions: ${error}`);
    }
  }
  
  /**
   * Save a session to disk.
   */
  save(session: ChatSession): void {
    this.sessions.set(session.id, session);
    
    try {
      ensureSessionsDir();
      const filePath = getSessionPath(session.id);
      fs.writeFileSync(filePath, serializeSession(session), 'utf-8');
    } catch (error) {
      log(`[ChatSessionStore] Failed to save session ${session.id}: ${error}`);
    }
  }
  
  /**
   * Get a session by ID.
   */
  get(sessionId: string): ChatSession | undefined {
    this.load();
    return this.sessions.get(sessionId);
  }
  
  /**
   * Check if a session exists.
   */
  has(sessionId: string): boolean {
    this.load();
    return this.sessions.has(sessionId);
  }
  
  /**
   * Get all sessions.
   */
  getAll(): ChatSession[] {
    this.load();
    return Array.from(this.sessions.values())
      .sort((a, b) => b.updatedAt - a.updatedAt); // Most recent first
  }
  
  /**
   * Delete a session.
   */
  delete(sessionId: string): boolean {
    this.load();
    
    const existed = this.sessions.delete(sessionId);
    if (existed) {
      try {
        const filePath = getSessionPath(sessionId);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (error) {
        log(`[ChatSessionStore] Failed to delete session file ${sessionId}: ${error}`);
      }
    }
    
    return existed;
  }
  
  /**
   * Get recent sessions.
   */
  getRecent(count: number): ChatSession[] {
    return this.getAll().slice(0, count);
  }
  
  /**
   * Clear all sessions.
   */
  clearAll(): void {
    this.load();
    
    for (const sessionId of this.sessions.keys()) {
      try {
        const filePath = getSessionPath(sessionId);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (error) {
        log(`[ChatSessionStore] Failed to delete session file ${sessionId}: ${error}`);
      }
    }
    
    this.sessions.clear();
  }
}

// Singleton instance
let _store: ChatSessionStore | null = null;

export function getChatSessionStore(): ChatSessionStore {
  if (!_store) {
    _store = new ChatSessionStore();
  }
  return _store;
}


