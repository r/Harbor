/**
 * Docker image management for MCP servers.
 * 
 * Provides pre-built Dockerfiles and image management for running
 * MCP servers in containers, bypassing macOS Gatekeeper issues.
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { log } from '../native-messaging.js';
import { resolveExecutable, getEnhancedPath } from '../utils/resolve-executable.js';

// Base directory for Harbor Docker assets
const DOCKER_ASSETS_DIR = join(homedir(), '.harbor', 'docker');

/**
 * Dockerfile templates for different package types.
 */
const DOCKERFILES = {
  // Node.js/npm MCP server runner
  node: `
FROM node:20-alpine

# Install common tools
RUN apk add --no-cache git

# Create app directory
WORKDIR /app

# The package to run will be passed as an argument
# Example: docker run -i harbor-mcp-node npx -y @modelcontextprotocol/server-filesystem /tmp

ENTRYPOINT ["npx", "-y"]
`,

  // Python/pypi MCP server runner
  python: `
FROM python:3.12-slim

# Install common tools and uv for faster package management
RUN apt-get update && apt-get install -y --no-install-recommends \\
    git \\
    && rm -rf /var/lib/apt/lists/* \\
    && pip install --no-cache-dir uv

# Create app directory
WORKDIR /app

# The package to run will be passed as an argument
# Example: docker run -i harbor-mcp-python uvx mcp-server-time

ENTRYPOINT ["uvx"]
`,

  // Go/Binary runner - for pre-compiled binaries
  binary: `
FROM alpine:latest

# Install common runtime dependencies
RUN apk add --no-cache ca-certificates libc6-compat libstdc++

WORKDIR /app

# Binary will be mounted or copied at runtime
# Example: docker run -i -v /path/to/binary:/app/server harbor-mcp-binary /app/server

ENTRYPOINT ["/app/server"]
`,

  // Generic runner with multiple runtimes
  multi: `
FROM ubuntu:22.04

# Install Node.js, Python, and common tools
RUN apt-get update && apt-get install -y --no-install-recommends \\
    curl \\
    git \\
    ca-certificates \\
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \\
    && apt-get install -y nodejs \\
    && apt-get install -y python3 python3-pip python3-venv \\
    && pip3 install --no-cache-dir uv \\
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# This image can run either npm or pypi packages
# Usage: docker run -i harbor-mcp-multi npx -y @package
# Usage: docker run -i harbor-mcp-multi uvx package
`,
};

export type DockerImageType = keyof typeof DOCKERFILES;

/**
 * Docker image manager for Harbor MCP servers.
 */
export class DockerImageManager {
  private builtImages: Set<string> = new Set();
  
  constructor() {
    this.ensureAssetDir();
    this.loadBuiltImagesCache();
  }
  
  private ensureAssetDir(): void {
    if (!existsSync(DOCKER_ASSETS_DIR)) {
      mkdirSync(DOCKER_ASSETS_DIR, { recursive: true });
    }
  }
  
  private loadBuiltImagesCache(): void {
    const cacheFile = join(DOCKER_ASSETS_DIR, 'built-images.json');
    if (existsSync(cacheFile)) {
      try {
        const data = JSON.parse(readFileSync(cacheFile, 'utf-8'));
        this.builtImages = new Set(data.images || []);
      } catch {
        // Ignore cache errors
      }
    }
  }
  
  private saveBuiltImagesCache(): void {
    const cacheFile = join(DOCKER_ASSETS_DIR, 'built-images.json');
    writeFileSync(cacheFile, JSON.stringify({
      images: Array.from(this.builtImages),
      updatedAt: Date.now(),
    }));
  }
  
  /**
   * Get the image name for a given type.
   */
  getImageName(type: DockerImageType): string {
    return `harbor-mcp-${type}`;
  }
  
  /**
   * Get the Dockerfile content for a type.
   */
  getDockerfile(type: DockerImageType): string {
    return DOCKERFILES[type];
  }
  
  /**
   * Check if a Harbor image exists locally.
   */
  async imageExists(type: DockerImageType): Promise<boolean> {
    const imageName = this.getImageName(type);
    
    try {
      const dockerPath = resolveExecutable('docker');
      execSync(`"${dockerPath}" image inspect ${imageName}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PATH: getEnhancedPath() },
      });
      return true;
    } catch {
      return false;
    }
  }
  
  /**
   * Build a Harbor Docker image.
   */
  async buildImage(
    type: DockerImageType,
    onProgress?: (message: string) => void
  ): Promise<boolean> {
    const imageName = this.getImageName(type);
    const dockerfile = this.getDockerfile(type);
    const dockerfilePath = join(DOCKER_ASSETS_DIR, `Dockerfile.${type}`);
    
    // Write Dockerfile
    writeFileSync(dockerfilePath, dockerfile.trim());
    log(`[DockerImages] Building image ${imageName}...`);
    onProgress?.(`Building ${imageName} image...`);
    
    return new Promise((resolve, reject) => {
      const dockerPath = resolveExecutable('docker');
      const proc = spawn(dockerPath, [
        'build',
        '-t', imageName,
        '-f', dockerfilePath,
        DOCKER_ASSETS_DIR,
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: getEnhancedPath() },
      });
      
      let output = '';
      
      proc.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        output += text;
        // Parse Docker build output for progress
        const stepMatch = text.match(/Step (\d+)\/(\d+)/);
        if (stepMatch) {
          onProgress?.(`Building ${imageName}: step ${stepMatch[1]}/${stepMatch[2]}`);
        }
      });
      
      proc.stderr?.on('data', (data: Buffer) => {
        output += data.toString();
      });
      
      proc.on('close', (code) => {
        if (code === 0) {
          log(`[DockerImages] Built image ${imageName}`);
          this.builtImages.add(imageName);
          this.saveBuiltImagesCache();
          onProgress?.(`${imageName} image ready`);
          resolve(true);
        } else {
          log(`[DockerImages] Failed to build ${imageName}: ${output}`);
          reject(new Error(`Failed to build ${imageName}: ${output.slice(-500)}`));
        }
      });
      
      proc.on('error', (err) => {
        reject(new Error(`Docker build failed: ${err.message}`));
      });
    });
  }
  
  /**
   * Ensure an image is built and ready.
   */
  async ensureImage(
    type: DockerImageType,
    onProgress?: (message: string) => void
  ): Promise<string> {
    const imageName = this.getImageName(type);
    
    // Check if already built in this session
    if (this.builtImages.has(imageName)) {
      return imageName;
    }
    
    // Check if exists locally
    if (await this.imageExists(type)) {
      this.builtImages.add(imageName);
      return imageName;
    }
    
    // Need to build
    await this.buildImage(type, onProgress);
    return imageName;
  }
  
  /**
   * Get the appropriate image type for a package type.
   */
  getImageTypeForPackage(packageType: string): DockerImageType {
    switch (packageType.toLowerCase()) {
      case 'npm':
      case 'git':  // git packages use npm/node for installation
        return 'node';
      case 'pypi':
        return 'python';
      case 'binary':
        return 'binary';
      default:
        return 'multi';
    }
  }
  
  /**
   * Rebuild all images (useful for updates).
   */
  async rebuildAllImages(
    onProgress?: (message: string) => void
  ): Promise<void> {
    const types: DockerImageType[] = ['node', 'python', 'binary', 'multi'];
    
    for (const type of types) {
      await this.buildImage(type, onProgress);
    }
  }
  
  /**
   * Remove a Harbor image.
   */
  async removeImage(type: DockerImageType): Promise<boolean> {
    const imageName = this.getImageName(type);
    
    try {
      const dockerPath = resolveExecutable('docker');
      execSync(`"${dockerPath}" rmi ${imageName}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PATH: getEnhancedPath() },
      });
      this.builtImages.delete(imageName);
      this.saveBuiltImagesCache();
      return true;
    } catch {
      return false;
    }
  }
  
  /**
   * Get status of all Harbor images.
   */
  async getImagesStatus(): Promise<Record<DockerImageType, { exists: boolean; size?: string }>> {
    const types: DockerImageType[] = ['node', 'python', 'binary', 'multi'];
    const status: Record<string, { exists: boolean; size?: string }> = {};
    
    const dockerPath = resolveExecutable('docker');
    const dockerEnv = { ...process.env, PATH: getEnhancedPath() };
    
    for (const type of types) {
      const imageName = this.getImageName(type);
      try {
        const result = execSync(
          `"${dockerPath}" image inspect ${imageName} --format '{{.Size}}'`,
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: dockerEnv }
        ).trim();
        
        const sizeBytes = parseInt(result, 10);
        const sizeMB = (sizeBytes / 1024 / 1024).toFixed(1);
        
        status[type] = { exists: true, size: `${sizeMB} MB` };
      } catch {
        status[type] = { exists: false };
      }
    }
    
    return status as Record<DockerImageType, { exists: boolean; size?: string }>;
  }
}

// Singleton
let _imageManager: DockerImageManager | null = null;

export function getDockerImageManager(): DockerImageManager {
  if (!_imageManager) {
    _imageManager = new DockerImageManager();
  }
  return _imageManager;
}

