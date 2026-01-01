/**
 * Binary Downloader
 * 
 * Downloads and extracts pre-built binaries from GitHub releases.
 */

import { createWriteStream, existsSync, mkdirSync, chmodSync, readdirSync, renameSync, unlinkSync, statSync, rmSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { spawn } from 'node:child_process';
import { log } from '../native-messaging.js';

const BIN_DIR = join(homedir(), '.harbor', 'bin');

/**
 * Ensure the bin directory exists.
 */
function ensureBinDir(): void {
  if (!existsSync(BIN_DIR)) {
    mkdirSync(BIN_DIR, { recursive: true });
  }
}

/**
 * Get the path where a binary should be stored.
 */
export function getBinaryPath(serverId: string, binaryName?: string): string {
  ensureBinDir();
  const name = binaryName || serverId;
  // On Windows, add .exe extension if not present
  if (platform() === 'win32' && !name.endsWith('.exe')) {
    return join(BIN_DIR, `${name}.exe`);
  }
  return join(BIN_DIR, name);
}

/**
 * Check if a binary is already downloaded.
 */
export function isBinaryDownloaded(serverId: string): boolean {
  const binPath = getBinaryPath(serverId);
  return existsSync(binPath);
}

/**
 * Download a file from a URL.
 */
async function downloadFile(url: string, destPath: string): Promise<void> {
  log(`[BinaryDownloader] Downloading: ${url}`);
  log(`[BinaryDownloader] To: ${destPath}`);
  
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Harbor-MCP-Manager',
    },
    redirect: 'follow',
  });
  
  if (!response.ok) {
    throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
  }
  
  if (!response.body) {
    throw new Error('No response body');
  }
  
  // Create write stream
  const fileStream = createWriteStream(destPath);
  
  // Convert web ReadableStream to Node stream and pipe
  const reader = response.body.getReader();
  
  try {
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      fileStream.write(Buffer.from(value));
      totalBytes += value.length;
      
      // Log progress every ~1MB
      if (totalBytes % (1024 * 1024) < value.length) {
        log(`[BinaryDownloader] Downloaded ${Math.round(totalBytes / 1024 / 1024)}MB...`);
      }
    }
    
    fileStream.end();
    
    // Wait for file to be written
    await new Promise<void>((resolve, reject) => {
      fileStream.on('finish', resolve);
      fileStream.on('error', reject);
    });
    
    log(`[BinaryDownloader] Download complete: ${totalBytes} bytes`);
  } finally {
    reader.releaseLock();
  }
}

/**
 * Extract a .tar.gz archive.
 */
async function extractTarGz(archivePath: string, destDir: string): Promise<void> {
  log(`[BinaryDownloader] Extracting tar.gz: ${archivePath}`);
  
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-xzf', archivePath, '-C', destDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    
    let stderr = '';
    tar.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    
    tar.on('exit', (code) => {
      if (code === 0) {
        log(`[BinaryDownloader] Extraction complete`);
        resolve();
      } else {
        reject(new Error(`tar extraction failed: ${stderr}`));
      }
    });
    
    tar.on('error', reject);
  });
}

/**
 * Extract a .zip archive.
 */
async function extractZip(archivePath: string, destDir: string): Promise<void> {
  log(`[BinaryDownloader] Extracting zip: ${archivePath}`);
  
  return new Promise((resolve, reject) => {
    const unzip = spawn('unzip', ['-o', archivePath, '-d', destDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    
    let stderr = '';
    unzip.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    
    unzip.on('exit', (code) => {
      if (code === 0) {
        log(`[BinaryDownloader] Extraction complete`);
        resolve();
      } else {
        reject(new Error(`unzip failed: ${stderr}`));
      }
    });
    
    unzip.on('error', reject);
  });
}

/**
 * Find the executable binary in an extracted directory.
 */
function findExecutable(dir: string, expectedName?: string): string | null {
  const files = readdirSync(dir, { withFileTypes: true });
  
  for (const file of files) {
    const fullPath = join(dir, file.name);
    
    if (file.isDirectory()) {
      // Recursively search subdirectories
      const found = findExecutable(fullPath, expectedName);
      if (found) return found;
    } else if (file.isFile()) {
      const stats = statSync(fullPath);
      
      // Check if it's executable (on Unix) or has .exe extension (on Windows)
      const isExecutable = 
        platform() === 'win32' 
          ? file.name.endsWith('.exe')
          : (stats.mode & 0o111) !== 0;
      
      // Skip common non-binary files
      const skip = ['.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.sh', '.ps1', '.bat'];
      if (skip.some(ext => file.name.toLowerCase().endsWith(ext))) {
        continue;
      }
      
      // If we have an expected name, prefer that
      if (expectedName && file.name.toLowerCase().includes(expectedName.toLowerCase())) {
        return fullPath;
      }
      
      // Otherwise return first executable
      if (isExecutable && !file.name.startsWith('.')) {
        return fullPath;
      }
    }
  }
  
  return null;
}

/**
 * Remove macOS quarantine attribute from a file.
 * This helps avoid Gatekeeper prompts for downloaded binaries.
 */
async function removeQuarantine(filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const xattr = spawn('xattr', ['-d', 'com.apple.quarantine', filePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    
    xattr.on('exit', (code) => {
      if (code === 0) {
        log(`[BinaryDownloader] Removed quarantine attribute from ${filePath}`);
        resolve(true);
      } else {
        // This is not fatal - the file might not have the attribute
        // or we might not have permission
        log(`[BinaryDownloader] Could not remove quarantine (code ${code})`);
        resolve(false);
      }
    });
    
    xattr.on('error', () => {
      log(`[BinaryDownloader] xattr command not available`);
      resolve(false);
    });
  });
}

/**
 * Check if a binary needs macOS security approval.
 * Returns true if the binary has quarantine attribute or has never been run.
 */
export async function needsSecurityApproval(serverId: string): Promise<boolean> {
  if (platform() !== 'darwin') {
    return false;
  }
  
  const binPath = getBinaryPath(serverId);
  if (!existsSync(binPath)) {
    return false;
  }
  
  // Check if file has quarantine attribute
  return new Promise((resolve) => {
    const xattr = spawn('xattr', ['-l', binPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    
    let output = '';
    xattr.stdout?.on('data', (data) => {
      output += data.toString();
    });
    
    xattr.on('exit', () => {
      // If quarantine attribute exists, needs approval
      resolve(output.includes('com.apple.quarantine'));
    });
    
    xattr.on('error', () => {
      resolve(false);
    });
  });
}

/**
 * Download and install a binary from a URL.
 */
export async function downloadBinary(
  serverId: string,
  binaryUrl: string,
  options?: {
    expectedBinaryName?: string;
  }
): Promise<string> {
  ensureBinDir();
  
  const urlFilename = basename(new URL(binaryUrl).pathname);
  const tempDir = join(BIN_DIR, `temp_${serverId}_${Date.now()}`);
  const archivePath = join(tempDir, urlFilename);
  const finalBinaryPath = getBinaryPath(serverId);
  
  try {
    // Create temp directory
    mkdirSync(tempDir, { recursive: true });
    
    // Download the file
    await downloadFile(binaryUrl, archivePath);
    
    // Determine if it's an archive
    const isArchive = 
      urlFilename.endsWith('.tar.gz') || 
      urlFilename.endsWith('.tgz') || 
      urlFilename.endsWith('.zip');
    
    if (isArchive) {
      // Extract the archive
      if (urlFilename.endsWith('.tar.gz') || urlFilename.endsWith('.tgz')) {
        await extractTarGz(archivePath, tempDir);
      } else if (urlFilename.endsWith('.zip')) {
        await extractZip(archivePath, tempDir);
      }
      
      // Remove the archive file
      unlinkSync(archivePath);
      
      // Find the executable
      const executable = findExecutable(tempDir, options?.expectedBinaryName || serverId);
      if (!executable) {
        throw new Error('Could not find executable in archive');
      }
      
      log(`[BinaryDownloader] Found executable: ${executable}`);
      
      // Move to final location
      renameSync(executable, finalBinaryPath);
    } else {
      // Direct binary download
      renameSync(archivePath, finalBinaryPath);
    }
    
    // Make executable (Unix only)
    if (platform() !== 'win32') {
      chmodSync(finalBinaryPath, 0o755);
      log(`[BinaryDownloader] Made executable: ${finalBinaryPath}`);
    }
    
    // On macOS, try to remove quarantine attribute to avoid Gatekeeper prompts
    if (platform() === 'darwin') {
      await removeQuarantine(finalBinaryPath);
    }
    
    log(`[BinaryDownloader] Binary installed: ${finalBinaryPath}`);
    return finalBinaryPath;
    
  } finally {
    // Clean up temp directory
    try {
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    } catch (e) {
      log(`[BinaryDownloader] Failed to clean up temp dir: ${e}`);
    }
  }
}

/**
 * Remove a downloaded binary.
 */
export function removeBinary(serverId: string): boolean {
  const binPath = getBinaryPath(serverId);
  if (existsSync(binPath)) {
    try {
      unlinkSync(binPath);
      log(`[BinaryDownloader] Removed binary: ${binPath}`);
      return true;
    } catch (e) {
      log(`[BinaryDownloader] Failed to remove binary: ${e}`);
      return false;
    }
  }
  return false;
}

/**
 * List all downloaded binaries.
 */
export function listBinaries(): string[] {
  ensureBinDir();
  try {
    return readdirSync(BIN_DIR);
  } catch {
    return [];
  }
}

