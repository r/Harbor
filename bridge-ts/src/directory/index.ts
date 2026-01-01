/**
 * Directory Manager
 * 
 * Manages curated servers and provides access to the recommended server list.
 * This replaces the complex catalog auto-discovery system with a simple,
 * reliable static list.
 */

import { CURATED_SERVERS } from './curated-servers.js';
import { CuratedServer } from '../types.js';

export class DirectoryManager {
  /**
   * Get the list of curated servers.
   */
  getCuratedServers(): CuratedServer[] {
    return CURATED_SERVERS;
  }

  /**
   * Get a specific curated server by ID.
   */
  getCuratedServer(id: string): CuratedServer | undefined {
    return CURATED_SERVERS.find(s => s.id === id);
  }

  /**
   * Search curated servers by name, description, or tags.
   */
  searchCuratedServers(query: string): CuratedServer[] {
    const lowerQuery = query.toLowerCase();
    return CURATED_SERVERS.filter(server => {
      return (
        server.name.toLowerCase().includes(lowerQuery) ||
        server.description.toLowerCase().includes(lowerQuery) ||
        server.tags?.some(tag => tag.toLowerCase().includes(lowerQuery))
      );
    });
  }
}

// Singleton instance
let _manager: DirectoryManager | null = null;

export function getDirectoryManager(): DirectoryManager {
  if (!_manager) {
    _manager = new DirectoryManager();
  }
  return _manager;
}

// Re-export curated servers and types
export { CURATED_SERVERS } from './curated-servers.js';
export type { CuratedServer } from '../types.js';
