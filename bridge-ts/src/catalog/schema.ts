/**
 * Drizzle ORM schema for catalog database.
 */

import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';

// =============================================================================
// Servers Table
// =============================================================================

export const servers = sqliteTable('servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  source: text('source').notNull(),
  endpointUrl: text('endpoint_url').default(''),
  installableOnly: integer('installable_only', { mode: 'boolean' }).default(true),
  description: text('description').default(''),
  homepageUrl: text('homepage_url').default(''),
  repositoryUrl: text('repository_url').default(''),
  tags: text('tags', { mode: 'json' }).$type<string[]>().default([]),
  packages: text('packages', { mode: 'json' }).$type<Array<{
    registryType: string;
    identifier: string;
    environmentVariables: Array<{ name: string; description?: string; isSecret?: boolean }>;
  }>>().default([]),
  
  // Metadata
  firstSeenAt: real('first_seen_at').notNull(),
  lastSeenAt: real('last_seen_at').notNull(),
  lastUpdatedAt: real('last_updated_at'),
  
  // Status
  isRemoved: integer('is_removed', { mode: 'boolean' }).default(false),
  removedAt: real('removed_at'),
  
  // Scoring factors
  isFeatured: integer('is_featured', { mode: 'boolean' }).default(false),
  popularityScore: integer('popularity_score').default(0),
  priorityScore: integer('priority_score').default(0),
}, (table) => ({
  sourceIdx: index('idx_servers_source').on(table.source),
  priorityIdx: index('idx_servers_priority').on(table.priorityScore),
  removedIdx: index('idx_servers_removed').on(table.isRemoved),
  endpointIdx: index('idx_servers_endpoint').on(table.endpointUrl),
}));

// =============================================================================
// Provider Status Table
// =============================================================================

export const providerStatus = sqliteTable('provider_status', {
  providerId: text('provider_id').primaryKey(),
  providerName: text('provider_name').notNull(),
  lastFetchAt: real('last_fetch_at'),
  lastSuccessAt: real('last_success_at'),
  lastError: text('last_error'),
  serverCount: integer('server_count').default(0),
});

// =============================================================================
// Metadata Table
// =============================================================================

export const metadata = sqliteTable('metadata', {
  key: text('key').primaryKey(),
  value: text('value'),
});

// =============================================================================
// Type Exports
// =============================================================================

export type Server = typeof servers.$inferSelect;
export type NewServer = typeof servers.$inferInsert;
export type ProviderStatusRow = typeof providerStatus.$inferSelect;

