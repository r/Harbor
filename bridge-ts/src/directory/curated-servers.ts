/**
 * Curated MCP Servers
 * 
 * A static list of recommended MCP servers that are known to work well.
 * These are displayed prominently in the sidebar for easy installation.
 */

import { CuratedServer } from '../types.js';

/**
 * Extended curated server with installation details.
 * This is used internally by handlers.ts for the full install flow.
 */
export interface CuratedServerFull extends CuratedServer {
  homepage?: string;
  repository?: string;
  install: 
    | { type: 'npm'; package: string }
    | { type: 'pypi'; package: string }
    | { type: 'binary'; github: string; binaryName: string }
    | { type: 'docker'; image: string };
  dockerAlternative?: {
    image: string;
    command?: string;
  };
  envVars?: Array<{
    name: string;
    description?: string;
    isSecret?: boolean;
    required?: boolean;
  }>;
}

/**
 * Full curated server definitions with installation details.
 */
const CURATED_SERVERS_FULL: CuratedServerFull[] = [
  {
    id: 'curated-filesystem',
    name: 'Filesystem',
    description: 'Read, write, and manage files on your local system.',
    icon: '📁',
    packageType: 'npm',
    packageId: '@modelcontextprotocol/server-filesystem',
    tags: ['files', 'local', 'essential'],
    homepageUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    repository: 'https://github.com/modelcontextprotocol/servers',
    requiresNative: true,
    requiresConfig: true,
    configHint: 'Choose which folders to allow access to',
    install: {
      type: 'npm',
      package: '@modelcontextprotocol/server-filesystem',
    },
  },
  {
    id: 'curated-github',
    name: 'GitHub',
    description: 'Access repositories, issues, pull requests, and more.',
    icon: '🐙',
    packageType: 'npm',
    packageId: '@modelcontextprotocol/server-github',
    tags: ['development', 'git', 'collaboration'],
    homepageUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
    repository: 'https://github.com/modelcontextprotocol/servers',
    requiresNative: true,
    requiresConfig: true,
    configHint: 'Requires a GitHub Personal Access Token',
    install: {
      type: 'npm',
      package: '@modelcontextprotocol/server-github',
    },
    envVars: [
      {
        name: 'GITHUB_PERSONAL_ACCESS_TOKEN',
        description: 'GitHub Personal Access Token with repo access',
        isSecret: true,
        required: true,
      },
    ],
  },
  {
    id: 'curated-time',
    name: 'Time',
    description: 'Get current time, convert timezones, and work with dates.',
    icon: '🕐',
    packageType: 'pypi',
    packageId: 'mcp-server-time',
    tags: ['utility', 'datetime'],
    homepageUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time',
    repository: 'https://github.com/modelcontextprotocol/servers',
    requiresNative: true,
    requiresConfig: false,
    install: {
      type: 'pypi',
      package: 'mcp-server-time',
    },
  },
  {
    id: 'curated-memory',
    name: 'Memory',
    description: 'A simple in-memory key-value store for temporary data.',
    icon: '🧠',
    packageType: 'npm',
    packageId: '@modelcontextprotocol/server-memory',
    tags: ['utility', 'data', 'local'],
    homepageUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    repository: 'https://github.com/modelcontextprotocol/servers',
    requiresNative: true,
    requiresConfig: false,
    install: {
      type: 'npm',
      package: '@modelcontextprotocol/server-memory',
    },
  },
  {
    id: 'curated-fetch',
    name: 'Fetch',
    description: 'Make HTTP requests to fetch web content and APIs.',
    icon: '🌐',
    packageType: 'npm',
    packageId: '@modelcontextprotocol/server-fetch',
    tags: ['web', 'http', 'api'],
    homepageUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    repository: 'https://github.com/modelcontextprotocol/servers',
    requiresNative: true,
    requiresConfig: false,
    install: {
      type: 'npm',
      package: '@modelcontextprotocol/server-fetch',
    },
  },
];

/**
 * Simple curated servers for the extension UI (without internal install details).
 */
export const CURATED_SERVERS: CuratedServer[] = CURATED_SERVERS_FULL.map(s => ({
  id: s.id,
  name: s.name,
  description: s.description,
  icon: s.icon,
  packageType: s.packageType,
  packageId: s.packageId,
  tags: s.tags,
  homepageUrl: s.homepageUrl,
  requiresNative: s.requiresNative,
  requiresConfig: s.requiresConfig,
  configHint: s.configHint,
}));

/**
 * Get a curated server by ID (full version with install details).
 */
export function getCuratedServer(id: string): CuratedServerFull | undefined {
  return CURATED_SERVERS_FULL.find(s => s.id === id);
}

/**
 * Re-export the CuratedServer type.
 */
export type { CuratedServer } from '../types.js';
