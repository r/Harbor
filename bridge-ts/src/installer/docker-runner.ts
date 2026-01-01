/**
 * Docker-based MCP server runner.
 * 
 * Runs MCP servers inside Docker containers, providing:
 * - Bypass of macOS Gatekeeper for binaries
 * - Isolated execution environment
 * - Consistent runtime regardless of host system
 */

import { spawn, ChildProcess, execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { log } from '../native-messaging.js';
import { ProcessState, ServerProcess } from '../types.js';
import { getDockerExec, DockerInfo } from './docker-exec.js';
import { getDockerImageManager, DockerImageType } from './docker-images.js';
import { getBinaryPath } from './binary-downloader.js';

interface DockerProcess {
  serverId: string;
  packageType: string;
  packageId: string;
  containerId: string | null;
  containerName: string;
  state: ProcessState;
  startedAt: number | null;
  stoppedAt: number | null;
  exitCode: number | null;
  errorMessage: string | null;
  process: ChildProcess | null;
  logBuffer: string[];
}

export interface DockerRunnerOptions {
  /** Environment variables to pass to the container */
  env?: Record<string, string>;
  /** Additional arguments for the MCP server */
  args?: string[];
  /** Volume mounts (host:container format) */
  volumes?: string[];
  /** Callback for output from the container */
  onOutput?: (stream: 'stdout' | 'stderr', line: string) => void;
  /** Progress callback for image building */
  onProgress?: (message: string) => void;
}

/**
 * Docker-based MCP server runner.
 */
export class DockerRunner {
  private processes: Map<string, DockerProcess> = new Map();
  private dockerExec = getDockerExec();
  private imageManager = getDockerImageManager();
  
  /**
   * Check if Docker is available and ready.
   */
  async checkDocker(): Promise<DockerInfo> {
    return this.dockerExec.checkDocker();
  }
  
  /**
   * Check if we should prefer Docker for a given package type.
   * Returns true if Docker would be beneficial (e.g., for binaries on macOS).
   */
  async shouldPreferDocker(packageType: string): Promise<{ prefer: boolean; reason?: string }> {
    const dockerInfo = await this.dockerExec.checkDocker();
    
    if (!dockerInfo.available) {
      return { prefer: false, reason: 'Docker not available' };
    }
    
    // Always prefer Docker for binaries on macOS (Gatekeeper issues)
    if (packageType === 'binary' && process.platform === 'darwin') {
      return { 
        prefer: true, 
        reason: 'Recommended: Docker bypasses macOS Gatekeeper security restrictions for downloaded binaries'
      };
    }
    
    // Docker is optional for npm/pypi but can provide isolation
    return { prefer: false };
  }
  
  /**
   * Start an MCP server in a Docker container.
   */
  async startServer(
    serverId: string,
    packageType: string,
    packageId: string,
    options: DockerRunnerOptions = {}
  ): Promise<ServerProcess> {
    // Check Docker availability
    const dockerInfo = await this.dockerExec.checkDocker();
    if (!dockerInfo.available) {
      throw new Error(dockerInfo.error || 'Docker is not available');
    }
    
    // Check if already running
    const existing = this.processes.get(serverId);
    if (existing && existing.state === ProcessState.RUNNING) {
      return this.toServerProcess(existing);
    }
    
    // Create process record
    const containerName = `harbor-mcp-${serverId.replace(/[^a-zA-Z0-9-]/g, '-')}`;
    const proc: DockerProcess = {
      serverId,
      packageType,
      packageId,
      containerId: null,
      containerName,
      state: ProcessState.STARTING,
      startedAt: null,
      stoppedAt: null,
      exitCode: null,
      errorMessage: null,
      process: null,
      logBuffer: [],
    };
    this.processes.set(serverId, proc);
    
    try {
      // Stop any existing container with same name
      await this.cleanupContainer(containerName);
      
      // Ensure the appropriate Docker image is built
      const imageType = this.imageManager.getImageTypeForPackage(packageType);
      options.onProgress?.(`Preparing Docker environment for ${packageType}...`);
      
      const imageName = await this.imageManager.ensureImage(imageType, options.onProgress);
      
      // Build Docker run command
      const dockerArgs = this.buildDockerArgs(
        containerName,
        imageName,
        packageType,
        packageId,
        options
      );
      
      log(`[DockerRunner] Starting: docker ${dockerArgs.join(' ')}`);
      proc.logBuffer.push(`$ docker ${dockerArgs.join(' ')}`);
      
      // Start container
      const child = spawn('docker', dockerArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      
      proc.process = child;
      proc.startedAt = Date.now();
      proc.state = ProcessState.RUNNING;
      
      // Handle stdout
      child.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString('utf-8').split('\n');
        for (const line of lines) {
          if (line.trim()) {
            proc.logBuffer.push(`[stdout] ${line}`);
            if (proc.logBuffer.length > 1000) {
              proc.logBuffer = proc.logBuffer.slice(-500);
            }
            options.onOutput?.('stdout', line);
          }
        }
      });
      
      // Handle stderr
      child.stderr?.on('data', (data: Buffer) => {
        const lines = data.toString('utf-8').split('\n');
        for (const line of lines) {
          if (line.trim()) {
            proc.logBuffer.push(`[stderr] ${line}`);
            if (proc.logBuffer.length > 1000) {
              proc.logBuffer = proc.logBuffer.slice(-500);
            }
            options.onOutput?.('stderr', line);
          }
        }
      });
      
      // Handle exit
      child.on('exit', (code, signal) => {
        proc.exitCode = code;
        proc.stoppedAt = Date.now();
        
        if (proc.state === ProcessState.STOPPING) {
          proc.state = ProcessState.STOPPED;
        } else if (code !== 0) {
          proc.state = ProcessState.CRASHED;
          proc.errorMessage = `Container exited with code ${code}${signal ? ` (signal: ${signal})` : ''}`;
        } else {
          proc.state = ProcessState.STOPPED;
        }
        
        log(`[DockerRunner] Container ${containerName} exited with code ${code}`);
      });
      
      child.on('error', (err) => {
        proc.state = ProcessState.ERROR;
        proc.errorMessage = err.message;
        log(`[DockerRunner] Container error: ${err.message}`);
      });
      
      // Get container ID
      setTimeout(async () => {
        try {
          const containerId = execSync(
            `docker inspect -f '{{.Id}}' ${containerName}`,
            { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
          ).trim().substring(0, 12);
          proc.containerId = containerId;
          log(`[DockerRunner] Container ID: ${containerId}`);
        } catch {
          // Container might not be fully started yet
        }
      }, 500);
      
      log(`[DockerRunner] Started container ${containerName}`);
      return this.toServerProcess(proc);
      
    } catch (error) {
      log(`[DockerRunner] Failed to start: ${error}`);
      proc.state = ProcessState.ERROR;
      proc.errorMessage = error instanceof Error ? error.message : String(error);
      return this.toServerProcess(proc);
    }
  }
  
  /**
   * Stop a Docker container running an MCP server.
   */
  async stopServer(serverId: string, timeout: number = 10000): Promise<boolean> {
    const proc = this.processes.get(serverId);
    if (!proc) {
      return false;
    }
    
    if (proc.state !== ProcessState.RUNNING && proc.state !== ProcessState.STARTING) {
      return true; // Already stopped
    }
    
    proc.state = ProcessState.STOPPING;
    
    try {
      // Try graceful stop first
      execSync(`docker stop -t ${Math.floor(timeout / 1000)} ${proc.containerName}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: timeout + 2000,
      });
      
      proc.state = ProcessState.STOPPED;
      proc.stoppedAt = Date.now();
      log(`[DockerRunner] Stopped container ${proc.containerName}`);
      return true;
    } catch (e) {
      // Force kill
      try {
        execSync(`docker kill ${proc.containerName}`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        proc.state = ProcessState.STOPPED;
        proc.stoppedAt = Date.now();
        return true;
      } catch {
        // Container might already be dead
        if (proc.process) {
          proc.process.kill('SIGKILL');
        }
        proc.state = ProcessState.STOPPED;
        return true;
      }
    }
  }
  
  /**
   * Get the stdin/stdout streams for communicating with the MCP server.
   */
  getStreams(serverId: string): { stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream } | null {
    const proc = this.processes.get(serverId);
    if (!proc?.process) {
      return null;
    }
    
    return {
      stdin: proc.process.stdin!,
      stdout: proc.process.stdout!,
    };
  }
  
  /**
   * Check if a server is running in Docker.
   */
  isRunning(serverId: string): boolean {
    const proc = this.processes.get(serverId);
    return proc?.state === ProcessState.RUNNING;
  }
  
  /**
   * Get process info for a server.
   */
  getProcess(serverId: string): ServerProcess | null {
    const proc = this.processes.get(serverId);
    return proc ? this.toServerProcess(proc) : null;
  }
  
  /**
   * Get all Docker-managed processes.
   */
  getAllProcesses(): ServerProcess[] {
    return Array.from(this.processes.values()).map(p => this.toServerProcess(p));
  }
  
  /**
   * Stop all Docker containers.
   */
  async stopAll(): Promise<void> {
    const running = Array.from(this.processes.values())
      .filter(p => p.state === ProcessState.RUNNING);
    
    await Promise.all(running.map(p => this.stopServer(p.serverId)));
  }
  
  /**
   * Cleanup a container by name.
   */
  private async cleanupContainer(containerName: string): Promise<void> {
    try {
      // Check if container exists
      execSync(`docker inspect ${containerName}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      
      // Stop and remove
      try {
        execSync(`docker stop ${containerName}`, {
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        // Ignore
      }
      
      try {
        execSync(`docker rm ${containerName}`, {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        // Ignore
      }
    } catch {
      // Container doesn't exist
    }
  }
  
  /**
   * Build Docker run arguments.
   */
  private buildDockerArgs(
    containerName: string,
    imageName: string,
    packageType: string,
    packageId: string,
    options: DockerRunnerOptions
  ): string[] {
    const args = [
      'run',
      '--rm',           // Remove container when it exits
      '-i',             // Keep stdin open for MCP communication
      '--name', containerName,
    ];
    
    // Add environment variables
    if (options.env) {
      for (const [key, value] of Object.entries(options.env)) {
        args.push('-e', `${key}=${value}`);
      }
    }
    
    // Add volume mounts
    if (options.volumes) {
      for (const vol of options.volumes) {
        args.push('-v', vol);
      }
    }
    
    // For binary packages, mount the binary
    if (packageType === 'binary') {
      const binaryPath = getBinaryPath(packageId);
      if (existsSync(binaryPath)) {
        args.push('-v', `${binaryPath}:/app/server:ro`);
      }
    }
    
    // Add the image
    args.push(imageName);
    
    // Add command based on package type
    if (packageType === 'npm') {
      args.push(packageId);
    } else if (packageType === 'pypi') {
      args.push(packageId);
    } else if (packageType === 'binary') {
      // Binary is mounted at /app/server, entrypoint handles it
    }
    
    // Add additional arguments
    if (options.args) {
      args.push(...options.args);
    }
    
    return args;
  }
  
  private toServerProcess(proc: DockerProcess): ServerProcess {
    return {
      serverId: proc.serverId,
      packageType: proc.packageType,
      packageId: proc.packageId,
      state: proc.state,
      pid: null, // Docker container, not a direct PID
      startedAt: proc.startedAt,
      stoppedAt: proc.stoppedAt,
      exitCode: proc.exitCode,
      errorMessage: proc.errorMessage,
      recentLogs: proc.logBuffer.slice(-50),
    };
  }
}

// Singleton
let _dockerRunner: DockerRunner | null = null;

export function getDockerRunner(): DockerRunner {
  if (!_dockerRunner) {
    _dockerRunner = new DockerRunner();
  }
  return _dockerRunner;
}

