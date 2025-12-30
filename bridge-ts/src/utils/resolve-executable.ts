/**
 * Utility to resolve full paths to executables.
 * 
 * When Firefox starts the bridge via native messaging, it often
 * has a minimal PATH that doesn't include Node.js, Python, etc.
 * This module finds the full path to common executables.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { log } from '../native-messaging.js';

// Common paths where executables might be found
const COMMON_PATHS = [
  // macOS Homebrew
  '/opt/homebrew/bin',
  '/usr/local/bin',
  // Linux common paths
  '/usr/bin',
  '/usr/local/bin',
  // NVM default location
  `${process.env.HOME}/.nvm/versions/node`,
  // fnm default location
  `${process.env.HOME}/.fnm/node-versions`,
  // asdf nodejs
  `${process.env.HOME}/.asdf/shims`,
  // Volta
  `${process.env.HOME}/.volta/bin`,
  // User local bin
  `${process.env.HOME}/.local/bin`,
  // n (node version manager)
  '/usr/local/n/versions/node',
];

// Cache resolved paths
const pathCache: Map<string, string> = new Map();

/**
 * Try to find an executable using 'which' command with enhanced PATH.
 */
function findWithWhich(executable: string): string | null {
  try {
    // Build an enhanced PATH including common locations
    const enhancedPath = [...COMMON_PATHS, process.env.PATH || ''].join(':');
    
    const result = execSync(`which ${executable}`, {
      encoding: 'utf-8',
      env: { ...process.env, PATH: enhancedPath },
      timeout: 5000,
    }).trim();
    
    if (result && existsSync(result)) {
      return result;
    }
  } catch {
    // which failed
  }
  return null;
}

/**
 * Search common paths directly for the executable.
 */
function findInCommonPaths(executable: string): string | null {
  for (const basePath of COMMON_PATHS) {
    // Check if it's a versioned directory (like NVM)
    if (basePath.includes('nvm') || basePath.includes('fnm') || basePath.includes('/n/versions')) {
      try {
        // Try to find the latest version
        const versions = execSync(`ls -1 "${basePath}" 2>/dev/null || true`, {
          encoding: 'utf-8',
          timeout: 2000,
        }).trim().split('\n').filter(Boolean);
        
        // Sort versions and try latest first
        versions.sort().reverse();
        for (const version of versions) {
          const fullPath = `${basePath}/${version}/bin/${executable}`;
          if (existsSync(fullPath)) {
            return fullPath;
          }
        }
      } catch {
        // Continue to next path
      }
    } else {
      // Direct path
      const fullPath = `${basePath}/${executable}`;
      if (existsSync(fullPath)) {
        return fullPath;
      }
    }
  }
  return null;
}

/**
 * Resolve the full path to an executable.
 * 
 * @param executable The executable name (e.g., 'npx', 'node', 'uvx')
 * @returns The full path to the executable
 * @throws Error if the executable cannot be found
 */
export function resolveExecutable(executable: string): string {
  // Check cache first
  const cached = pathCache.get(executable);
  if (cached) {
    return cached;
  }

  log(`[resolveExecutable] Looking for: ${executable}`);

  // Method 1: Try 'which' with enhanced PATH
  let resolved = findWithWhich(executable);
  
  // Method 2: Search common paths directly
  if (!resolved) {
    resolved = findInCommonPaths(executable);
  }

  // Method 3: Check if it's already a full path that exists
  if (!resolved && executable.startsWith('/') && existsSync(executable)) {
    resolved = executable;
  }

  // Method 4: Last resort - just return the executable name and hope for the best
  if (!resolved) {
    log(`[resolveExecutable] WARNING: Could not find ${executable}, using bare name`);
    resolved = executable;
  } else {
    log(`[resolveExecutable] Found ${executable} at: ${resolved}`);
    pathCache.set(executable, resolved);
  }

  return resolved;
}

/**
 * Get an enhanced PATH that includes common Node.js/Python locations.
 * This can be passed to child processes to help them find executables.
 */
export function getEnhancedPath(): string {
  const existingPath = process.env.PATH || '';
  const additionalPaths = COMMON_PATHS.filter(p => existsSync(p));
  return [...additionalPaths, existingPath].join(':');
}

/**
 * Resolve common executables and cache them.
 * Call this at startup to warm the cache.
 */
export function warmExecutableCache(): void {
  const executables = ['node', 'npx', 'npm'];
  for (const exe of executables) {
    try {
      resolveExecutable(exe);
    } catch {
      // Ignore errors during warmup
    }
  }
}


