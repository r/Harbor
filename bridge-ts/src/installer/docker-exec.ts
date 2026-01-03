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

    // Try multiple possible Docker paths (native host may have limited PATH)
    const dockerPaths = [
      'docker',                           // System PATH
      '/usr/local/bin/docker',            // macOS Intel
      '/opt/homebrew/bin/docker',         // macOS Apple Silicon
      '/usr/bin/docker',                  // Linux
      '/Applications/Docker.app/Contents/Resources/bin/docker', // Docker Desktop macOS
    ];
    
    let dockerCmd: string | null = null;
    let versionOutput = '';
    
    for (const path of dockerPaths) {
      try {
        versionOutput = execSync(`${path} --version`, { 
          encoding: 'utf-8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        dockerCmd = path;
        log(`[Docker] Found Docker at: ${path}`);
        break;
      } catch {
        // Try next path
      }
    }
    
    if (!dockerCmd) {
      // Don't cache failure - Docker might be started later
      return {
        available: false,
        error: 'Docker not found. Please install Docker Desktop from https://docker.com and ensure it is running.',
      };
    }
      
    // Parse version from output like "Docker version 24.0.7, build afdd53b"
    const versionMatch = versionOutput.match(/Docker version ([0-9.]+)/);
    const version = versionMatch ? versionMatch[1] : 'unknown';
    
    // Check if Docker daemon is running
    try {
      execSync(`${dockerCmd} info`, { 
        encoding: 'utf-8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      // Don't cache this - daemon might be started later
      return {
        available: false,
        version,
        error: 'Docker daemon is not running. Please start Docker Desktop.',
      };
    }
    
    this.cachedInfo = {
      available: true,
      version,
    };
    
    log(`[Docker] Docker available: v${version}`);
    return this.cachedInfo;
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

  /**
   * List all Harbor MCP containers (running and stopped).
   */
  listHarborContainers(): HarborContainer[] {
    try {
      // List containers with harbor-mcp prefix
      const output = execSync(
        `docker ps -a --filter "name=harbor-mcp-" --format "{{.ID}}|{{.Names}}|{{.Status}}|{{.Image}}|{{.CreatedAt}}|{{.Ports}}"`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      
      if (!output) {
        return [];
      }
      
      const containers: HarborContainer[] = [];
      
      for (const line of output.split('\n')) {
        if (!line.trim()) continue;
        
        const [id, name, status, image, createdAt, ports] = line.split('|');
        
        // Extract server ID from container name (harbor-mcp-<serverId>)
        const serverId = name.replace('harbor-mcp-', '');
        
        // Parse status to determine running state
        const isRunning = status.toLowerCase().startsWith('up');
        
        // Parse uptime from status if running
        let uptime: string | undefined;
        if (isRunning) {
          const uptimeMatch = status.match(/Up\s+(.+?)(?:\s+\(|$)/i);
          uptime = uptimeMatch ? uptimeMatch[1].trim() : undefined;
        }
        
        containers.push({
          id: id.substring(0, 12),
          name,
          serverId,
          image,
          status: isRunning ? 'running' : 'stopped',
          statusText: status,
          uptime,
          createdAt,
          ports: ports || undefined,
        });
      }
      
      return containers;
    } catch (e) {
      log(`[Docker] Failed to list containers: ${e}`);
      return [];
    }
  }

  /**
   * Get stats for running Harbor containers.
   */
  getContainerStats(): ContainerStats[] {
    try {
      const output = execSync(
        `docker stats --no-stream --filter "name=harbor-mcp-" --format "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.NetIO}}"`,
        { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      
      if (!output) {
        return [];
      }
      
      const stats: ContainerStats[] = [];
      
      for (const line of output.split('\n')) {
        if (!line.trim()) continue;
        
        const [name, cpu, memory, network] = line.split('|');
        const serverId = name.replace('harbor-mcp-', '');
        
        stats.push({
          serverId,
          cpu: cpu || '0%',
          memory: memory || '0B / 0B',
          network: network || '0B / 0B',
        });
      }
      
      return stats;
    } catch (e) {
      log(`[Docker] Failed to get container stats: ${e}`);
      return [];
    }
  }
}

export interface HarborContainer {
  id: string;
  name: string;
  serverId: string;
  image: string;
  status: 'running' | 'stopped';
  statusText: string;
  uptime?: string;
  createdAt: string;
  ports?: string;
}

export interface ContainerStats {
  serverId: string;
  cpu: string;
  memory: string;
  network: string;
}

// Singleton instance
let _dockerExec: DockerExec | null = null;

export function getDockerExec(): DockerExec {
  if (!_dockerExec) {
    _dockerExec = new DockerExec();
  }
  return _dockerExec;
}
