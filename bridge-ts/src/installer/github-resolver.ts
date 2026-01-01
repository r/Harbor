/**
 * GitHub Package Resolver
 * 
 * Fetches package.json from GitHub repos to determine npm package info.
 * Also supports downloading pre-built binaries from GitHub releases.
 */

import { log } from '../native-messaging.js';
import { platform, arch } from 'node:os';

export interface ResolvedPackage {
  name: string;
  version?: string;
  bin?: Record<string, string> | string;
  main?: string;
  type?: 'npm' | 'python' | 'binary';
  installCommand?: string;
  runCommand?: string;
  // For binary packages
  binaryUrl?: string;
  binaryName?: string;
  githubOwner?: string;
  githubRepo?: string;
}

export interface GitHubRepoInfo {
  owner: string;
  repo: string;
  branch?: string;
  subpath?: string;  // Subdirectory path within the repo
}

export interface GitHubRelease {
  tag_name: string;
  name: string;
  prerelease: boolean;
  draft: boolean;
  assets: GitHubAsset[];
}

export interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
  content_type: string;
}

/**
 * Parse a GitHub URL to extract owner, repo, and optional subdirectory path.
 */
export function parseGitHubUrl(url: string): GitHubRepoInfo | null {
  // Handle various GitHub URL formats:
  // https://github.com/owner/repo
  // https://github.com/owner/repo/tree/branch
  // https://github.com/owner/repo/tree/branch/subdir/path
  // https://github.com/owner/repo/blob/branch/subdir/path
  // https://github.com/owner/repo.git
  // git@github.com:owner/repo.git
  
  let match = url.match(/github\.com[/:]([^/]+)\/([^/\s.#?]+)/i);
  if (!match) {
    return null;
  }
  
  const owner = match[1];
  let repo = match[2].replace(/\.git$/, '');
  
  // Check for branch and subpath in URL
  // Matches: /tree/branch/optional/subdir or /blob/branch/optional/subdir
  let branch: string | undefined;
  let subpath: string | undefined;
  
  const pathMatch = url.match(/\/(tree|blob)\/([^/]+)(\/.*)?/);
  if (pathMatch) {
    branch = pathMatch[2];
    if (pathMatch[3]) {
      // Remove leading slash and clean up the path
      subpath = pathMatch[3].slice(1);
      // Remove file names (like README.md) to get directory path
      // If it ends with a file extension, remove the filename
      if (subpath.includes('.') && !subpath.endsWith('/')) {
        const lastSlash = subpath.lastIndexOf('/');
        if (lastSlash > 0) {
          subpath = subpath.slice(0, lastSlash);
        } else {
          subpath = undefined; // It's just a file at root
        }
      }
    }
  }
  
  return { owner, repo, branch, subpath };
}

/**
 * Fetch package.json from a GitHub repository.
 * If a subpath is provided, ONLY checks that subdirectory (no fallback to root).
 * This prevents picking up the wrong package from a monorepo root.
 */
export async function fetchPackageJson(
  repoInfo: GitHubRepoInfo
): Promise<ResolvedPackage | null> {
  const { owner, repo, branch, subpath } = repoInfo;
  
  // Try main, master, then the specified branch
  const branches = branch ? [branch] : ['main', 'master'];
  
  // If subpath is specified, ONLY check that path (don't fall back to root)
  // This is important for monorepos where root package.json is different from subpackages
  const pathsToTry: string[] = subpath ? [subpath] : [''];
  
  for (const b of branches) {
    for (const path of pathsToTry) {
      const pathPart = path ? `${path}/` : '';
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${b}/${pathPart}package.json`;
      
      try {
        log(`[GitHubResolver] Fetching: ${rawUrl}`);
        const response = await fetch(rawUrl);
        
        if (!response.ok) {
          continue; // Try next path/branch
        }
        
        const packageJson = await response.json() as {
          name?: string;
          version?: string;
          bin?: Record<string, string> | string;
          main?: string;
        };
        
        log(`[GitHubResolver] Found package.json with name: ${packageJson.name}`);
        
        return {
          name: packageJson.name || '',
          version: packageJson.version,
          bin: packageJson.bin,
          main: packageJson.main,
          type: 'npm',
        };
      } catch (e) {
        log(`[GitHubResolver] Failed to fetch ${rawUrl}: ${e}`);
        continue;
      }
    }
  }
  
  return null;
}

/**
 * Check if a repo has a pyproject.toml (Python package).
 * If a subpath is provided, ONLY checks that subdirectory (no fallback to root).
 */
export async function fetchPyprojectToml(
  repoInfo: GitHubRepoInfo
): Promise<ResolvedPackage | null> {
  const { owner, repo, branch, subpath } = repoInfo;
  const branches = branch ? [branch] : ['main', 'master'];
  
  // If subpath is specified, ONLY check that path (don't fall back to root)
  const pathsToTry: string[] = subpath ? [subpath] : [''];
  
  for (const b of branches) {
    for (const path of pathsToTry) {
      const pathPart = path ? `${path}/` : '';
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${b}/${pathPart}pyproject.toml`;
      
      try {
        log(`[GitHubResolver] Fetching: ${rawUrl}`);
        const response = await fetch(rawUrl);
        if (!response.ok) continue;
        
        const toml = await response.text();
        
        // Simple TOML parsing for name
        const nameMatch = toml.match(/name\s*=\s*["']([^"']+)["']/);
        const name = nameMatch ? nameMatch[1] : repo;
        
        log(`[GitHubResolver] Found pyproject.toml with name: ${name}`);
        
        return {
          name,
          type: 'python',
        };
      } catch (e) {
        continue;
      }
    }
  }
  
  return null;
}

/**
 * Check if a repo has a go.mod (Go project).
 */
export async function checkForGoMod(
  repoInfo: GitHubRepoInfo
): Promise<boolean> {
  const { owner, repo, branch, subpath } = repoInfo;
  const branches = branch ? [branch] : ['main', 'master'];
  
  const pathsToTry: string[] = subpath ? [subpath] : [''];
  
  for (const b of branches) {
    for (const path of pathsToTry) {
      const pathPart = path ? `${path}/` : '';
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${b}/${pathPart}go.mod`;
      
      try {
        const response = await fetch(rawUrl);
        if (response.ok) {
          log(`[GitHubResolver] Found go.mod at ${rawUrl}`);
          return true;
        }
      } catch (e) {
        continue;
      }
    }
  }
  
  return false;
}

/**
 * Get platform-specific keywords for finding the right binary.
 */
function getPlatformKeywords(): { os: string[]; arch: string[] } {
  const currentPlatform = platform();
  const currentArch = arch();
  
  let osKeywords: string[];
  let archKeywords: string[];
  
  // OS keywords
  switch (currentPlatform) {
    case 'darwin':
      osKeywords = ['darwin', 'macos', 'osx', 'apple'];
      break;
    case 'win32':
      osKeywords = ['windows', 'win', 'win64', 'win32'];
      break;
    case 'linux':
      osKeywords = ['linux'];
      break;
    default:
      osKeywords = [currentPlatform];
  }
  
  // Architecture keywords
  switch (currentArch) {
    case 'x64':
      archKeywords = ['x86_64', 'amd64', 'x64', '64bit', '64-bit'];
      break;
    case 'arm64':
      archKeywords = ['arm64', 'aarch64'];
      break;
    case 'arm':
      archKeywords = ['arm', 'armv7', 'armhf'];
      break;
    default:
      archKeywords = [currentArch];
  }
  
  return { os: osKeywords, arch: archKeywords };
}

/**
 * Score an asset name for platform match.
 * Higher score = better match.
 */
function scoreAssetForPlatform(assetName: string): number {
  const name = assetName.toLowerCase();
  const { os: osKeywords, arch: archKeywords } = getPlatformKeywords();
  
  let score = 0;
  
  // Check OS match
  for (const osKey of osKeywords) {
    if (name.includes(osKey)) {
      score += 10;
      break;
    }
  }
  
  // Check architecture match
  for (const archKey of archKeywords) {
    if (name.includes(archKey)) {
      score += 5;
      break;
    }
  }
  
  // Prefer non-archive formats (direct executables) slightly less
  // since most are distributed as archives
  if (name.endsWith('.tar.gz') || name.endsWith('.tgz') || name.endsWith('.zip')) {
    score += 2;
  }
  
  // Deprioritize checksum files
  if (name.includes('sha256') || name.includes('checksum') || name.endsWith('.sig') || name.endsWith('.asc')) {
    score = 0;
  }
  
  // Deprioritize source archives
  if (name.includes('source') || name === 'source.tar.gz' || name === 'source.zip') {
    score = 0;
  }
  
  return score;
}

/**
 * Fetch the latest release from a GitHub repository.
 */
export async function fetchLatestRelease(
  owner: string,
  repo: string
): Promise<GitHubRelease | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
  
  try {
    log(`[GitHubResolver] Fetching latest release: ${url}`);
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'Harbor-MCP-Manager',
      },
    });
    
    if (!response.ok) {
      log(`[GitHubResolver] No latest release found (${response.status})`);
      return null;
    }
    
    const release = await response.json() as GitHubRelease;
    log(`[GitHubResolver] Found release: ${release.tag_name} with ${release.assets.length} assets`);
    return release;
  } catch (e) {
    log(`[GitHubResolver] Failed to fetch release: ${e}`);
    return null;
  }
}

/**
 * Find the best matching binary asset for the current platform.
 */
export function findBestBinaryAsset(assets: GitHubAsset[]): GitHubAsset | null {
  if (!assets || assets.length === 0) {
    return null;
  }
  
  // Score all assets
  const scored = assets.map(asset => ({
    asset,
    score: scoreAssetForPlatform(asset.name),
  }));
  
  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);
  
  // Log for debugging
  for (const { asset, score } of scored.slice(0, 5)) {
    log(`[GitHubResolver] Asset: ${asset.name} (score: ${score})`);
  }
  
  // Return best match if score > 0
  if (scored[0] && scored[0].score > 0) {
    log(`[GitHubResolver] Selected: ${scored[0].asset.name}`);
    return scored[0].asset;
  }
  
  return null;
}

/**
 * Resolve a Go project to a binary package by checking GitHub releases.
 */
export async function resolveGoBinary(
  repoInfo: GitHubRepoInfo
): Promise<ResolvedPackage | null> {
  const { owner, repo } = repoInfo;
  
  // Fetch latest release
  const release = await fetchLatestRelease(owner, repo);
  if (!release || release.assets.length === 0) {
    log(`[GitHubResolver] No release with assets found for ${owner}/${repo}`);
    return null;
  }
  
  // Find best matching binary
  const asset = findBestBinaryAsset(release.assets);
  if (!asset) {
    log(`[GitHubResolver] No matching binary found for current platform`);
    return null;
  }
  
  return {
    name: repo,
    version: release.tag_name.replace(/^v/, ''),
    type: 'binary',
    binaryUrl: asset.browser_download_url,
    binaryName: asset.name,
    githubOwner: owner,
    githubRepo: repo,
  };
}

/**
 * Resolve package info from a GitHub URL.
 * Tries package.json first, then pyproject.toml, then Go binaries from releases.
 * Returns null if no supported package type is found.
 */
export async function resolveGitHubPackage(
  githubUrl: string
): Promise<ResolvedPackage | null> {
  const repoInfo = parseGitHubUrl(githubUrl);
  if (!repoInfo) {
    log(`[GitHubResolver] Could not parse GitHub URL: ${githubUrl}`);
    return null;
  }
  
  // Try npm first
  const npmPackage = await fetchPackageJson(repoInfo);
  if (npmPackage) {
    // Generate install and run commands
    npmPackage.installCommand = `npm install -g ${npmPackage.name}`;
    
    // Determine run command
    if (npmPackage.bin) {
      // If bin is a string, use the package name as command
      // If bin is an object, use the first key
      if (typeof npmPackage.bin === 'string') {
        npmPackage.runCommand = npmPackage.name;
      } else {
        npmPackage.runCommand = Object.keys(npmPackage.bin)[0];
      }
    } else if (npmPackage.main) {
      npmPackage.runCommand = `node node_modules/${npmPackage.name}/${npmPackage.main}`;
    }
    
    return npmPackage;
  }
  
  // Try Python
  const pyPackage = await fetchPyprojectToml(repoInfo);
  if (pyPackage) {
    pyPackage.installCommand = `pip install ${pyPackage.name}`;
    pyPackage.runCommand = pyPackage.name;
    return pyPackage;
  }
  
  // Check if it's a Go project with releases
  const isGoProject = await checkForGoMod(repoInfo);
  if (isGoProject) {
    log(`[GitHubResolver] Detected Go project, checking for releases: ${githubUrl}`);
    const goBinary = await resolveGoBinary(repoInfo);
    if (goBinary) {
      return goBinary;
    }
    log(`[GitHubResolver] Go project has no suitable binary releases`);
    return null;
  }
  
  // Even if not a Go project, check for releases (could be Rust or other)
  log(`[GitHubResolver] Checking for binary releases: ${githubUrl}`);
  const binaryPackage = await resolveGoBinary(repoInfo);
  if (binaryPackage) {
    return binaryPackage;
  }
  
  // No supported package type found - return null instead of guessing
  log(`[GitHubResolver] No supported package type found for: ${githubUrl}`);
  return null;
}

/**
 * Get installation commands for a GitHub repo.
 */
export async function getInstallCommands(
  githubUrl: string
): Promise<{ install: string; run: string } | null> {
  const resolved = await resolveGitHubPackage(githubUrl);
  if (!resolved) {
    return null;
  }
  
  return {
    install: resolved.installCommand || `npm install ${resolved.name}`,
    run: resolved.runCommand || resolved.name,
  };
}

