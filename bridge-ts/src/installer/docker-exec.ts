/**
 * Docker execution provider for MCP servers.
 * 
 * Allows running MCP servers in Docker containers, which bypasses
 * macOS Gatekeeper issues with downloaded binaries.
 */

import { execSync, spawn } from 'node:child_process';
import { log } from '../native-messaging.js';

export interface DockerInfo {
  available: boolean;
  version?: string;
  error?: string;
}

export interface DockerRunOptions {
  image: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  volumes?: string[];
  network?: 'host' | 'bridge' | 'none';
  removeOnExit?: boolean;
}

/**
 * Docker execution provider.
 */
export class DockerExec {
  private cachedInfo: DockerInfo | null = null;

  /**
   * Check if Docker is available and running.
   */
  async checkDocker(): Promise<DockerInfo> {
    if (this.cachedInfo) {
      return this.cachedInfo;
    }

    try {
      const versionOutput = execSync('docker --version', { 
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();
      
      // Parse version from output like "Docker version 24.0.7, build afdd53b"
      const versionMatch = versionOutput.match(/Docker version ([0-9.]+)/);
      const version = versionMatch ? versionMatch[1] : 'unknown';
      
      // Check if Docker daemon is running
      try {
        execSync('docker info', { 
          encoding: 'utf-8',
          timeout: 10000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        this.cachedInfo = {
          available: false,
          version,
          error: 'Docker daemon is not running. Please start Docker Desktop.',
        };
        return this.cachedInfo;
      }
      
      this.cachedInfo = {
        available: true,
        version,
      };
      
      return this.cachedInfo;
    } catch (e) {
      this.cachedInfo = {
        available: false,
        error: 'Docker is not installed. Please install Docker Desktop from https://docker.com',
      };
      return this.cachedInfo;
    }
  }

  /**
   * Clear cached Docker info.
   */
  clearCache(): void {
    this.cachedInfo = null;
  }

  /**
   * Pull a Docker image.
   */
  async pullImage(image: string): Promise<boolean> {
    const info = await this.checkDocker();
    if (!info.available) {
      throw new Error(info.error || 'Docker not available');
    }

    return new Promise((resolve, reject) => {
      log(`[Docker] Pulling image: ${image}`);
      
      const proc = spawn('docker', ['pull', image], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          log(`[Docker] Image pulled: ${image}`);
          resolve(true);
        } else {
          reject(new Error(`Failed to pull image: ${stderr}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Docker pull failed: ${err.message}`));
      });
    });
  }

  /**
   * Check if an image exists locally.
   */
  async imageExists(image: string): Promise<boolean> {
    const info = await this.checkDocker();
    if (!info.available) {
      return false;
    }

    try {
      execSync(`docker image inspect ${image}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run a container with stdio communication (for MCP servers).
   * Returns stdin/stdout streams for MCP protocol communication.
   */
  runInteractive(
    serverId: string,
    options: DockerRunOptions,
    onOutput?: (stream: 'stdout' | 'stderr', line: string) => void
  ): {
    stdin: NodeJS.WritableStream;
    stdout: NodeJS.ReadableStream;
    kill: () => void;
  } {
    const containerName = `harbor-mcp-${serverId}`;
    
    const dockerArgs = [
      'run',
      '--rm', // Remove container when it exits
      '-i',   // Keep stdin open
      '--name', containerName,
    ];
    
    // Add environment variables
    if (options.env) {
      for (const [key, value] of Object.entries(options.env)) {
        dockerArgs.push('-e', `${key}=${value}`);
      }
    }
    
    // Add volume mounts
    if (options.volumes) {
      for (const vol of options.volumes) {
        dockerArgs.push('-v', vol);
      }
    }
    
    // Add network mode
    if (options.network) {
      dockerArgs.push('--network', options.network);
    }
    
    // Add image and command
    dockerArgs.push(options.image);
    
    if (options.command) {
      dockerArgs.push(options.command);
    }
    
    if (options.args) {
      dockerArgs.push(...options.args);
    }
    
    log(`[Docker] Starting container: docker ${dockerArgs.join(' ')}`);
    
    const proc = spawn('docker', dockerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    
    // Handle stderr for logging
    proc.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString('utf-8').split('\n');
      for (const line of lines) {
        if (line.trim()) {
          onOutput?.('stderr', line);
        }
      }
    });
    
    proc.on('error', (err) => {
      log(`[Docker] Container error: ${err.message}`);
    });
    
    proc.on('close', (code) => {
      log(`[Docker] Container exited with code ${code}`);
    });
    
    return {
      stdin: proc.stdin!,
      stdout: proc.stdout!,
      kill: () => {
        log(`[Docker] Killing container ${containerName}`);
        try {
          execSync(`docker kill ${containerName}`, { stdio: 'ignore' });
        } catch {
          // Container might already be dead
          proc.kill('SIGKILL');
        }
      },
    };
  }

  /**
   * Stop a running container by server ID.
   */
  async stopContainer(serverId: string): Promise<boolean> {
    const containerName = `harbor-mcp-${serverId}`;
    
    try {
      execSync(`docker stop ${containerName}`, {
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      log(`[Docker] Container stopped: ${containerName}`);
      return true;
    } catch {
      // Container might not be running
      return false;
    }
  }

  /**
   * Check if a container is running.
   */
  isContainerRunning(serverId: string): boolean {
    const containerName = `harbor-mcp-${serverId}`;
    
    try {
      const result = execSync(
        `docker inspect -f '{{.State.Running}}' ${containerName}`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      return result === 'true';
    } catch {
      return false;
    }
  }
}

// Singleton instance
let _dockerExec: DockerExec | null = null;

export function getDockerExec(): DockerExec {
  if (!_dockerExec) {
    _dockerExec = new DockerExec();
  }
  return _dockerExec;
}
