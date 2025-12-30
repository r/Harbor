/**
 * Base classes and types for catalog providers.
 */

import { createHash } from 'node:crypto';
import { PackageInfo, CatalogServer } from '../types.js';

export { PackageInfo, CatalogServer };

export interface ProviderResult {
  providerId: string;
  providerName: string;
  ok: boolean;
  servers: CatalogServer[];
  error: string | null;
  fetchedAt: number;
}

/**
 * Generate a stable ID for a server based on source and key parts.
 */
export function generateServerId(source: string, ...parts: string[]): string {
  const key = `${source}:${parts.filter(p => p).join(':')}`;
  return createHash('sha256').update(key).digest('hex').substring(0, 16);
}

/**
 * Abstract base class for catalog providers.
 */
export abstract class CatalogProvider {
  abstract get id(): string;
  abstract get name(): string;

  abstract fetch(query?: string): Promise<ProviderResult>;

  protected makeResult(
    servers: CatalogServer[],
    error: string | null = null
  ): ProviderResult {
    return {
      providerId: this.id,
      providerName: this.name,
      ok: error === null,
      servers,
      error,
      fetchedAt: Date.now(),
    };
  }
}





