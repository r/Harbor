/**
 * Installed Server Manager - tracks installed MCP servers and their configs.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { log } from '../native-messaging.js';
import { InstalledServer, ServerProcess, ProcessState, CatalogServer } from '../types.js';
import { getRuntimeManager, RuntimeManager } from './runtime.js';
import { getPackageRunner, PackageRunner } from './runner.js';
import { getSecretStore, SecretStore } from './secrets.js';
import { downloadBinary, removeBinary, isBinaryDownloaded } from './binary-downloader.js';
import { getDockerRunner, DockerRunner } from './docker-runner.js';
import { getDockerExec } from './docker-exec.js';

const CONFIG_DIR = join(homedir(), '.harbor');
const INSTALLED_FILE = join(CONFIG_DIR, 'installed_servers.json');

export class InstalledServerManager {
  private servers: Map<string, InstalledServer> = new Map();
  private runtimeManager: RuntimeManager;
  private runner: PackageRunner;
  private dockerRunner: DockerRunner;
  private secrets: SecretStore;

  constructor() {
    mkdirSync(CONFIG_DIR, { recursive: true });
    this.runtimeManager = getRuntimeManager();
    this.runner = getPackageRunner();
    this.dockerRunner = getDockerRunner();
    this.secrets = getSecretStore();
    this.load();
  }

  private load(): void {
    if (existsSync(INSTALLED_FILE)) {
      try {
        const data = JSON.parse(readFileSync(INSTALLED_FILE, 'utf-8'));
        for (const serverData of data.servers || []) {
          const server: InstalledServer = {
            id: serverData.id,
            name: serverData.name,
            packageType: serverData.packageType,
            packageId: serverData.packageId,
            autoStart: serverData.autoStart || false,
            args: serverData.args || [],
            requiredEnvVars: serverData.requiredEnvVars || [],
            installedAt: serverData.installedAt || Date.now(),
            catalogSource: serverData.catalogSource || null,
            homepageUrl: serverData.homepageUrl || null,
            description: serverData.description || null,
            // Binary package fields
            binaryUrl: serverData.binaryUrl,
            binaryPath: serverData.binaryPath,
            // Remote HTTP/SSE server fields
            remoteUrl: serverData.remoteUrl,
            remoteHeaders: serverData.remoteHeaders,
            // Docker fields
            useDocker: serverData.useDocker || false,
            dockerVolumes: serverData.dockerVolumes || [],
          };
          this.servers.set(server.id, server);
        }
        log(`[InstalledServerManager] Loaded ${this.servers.size} installed servers`);
      } catch (e) {
        log(`[InstalledServerManager] Failed to load installed servers: ${e}`);
      }
    }
  }

  private save(): void {
    try {
      const data = {
        version: 1,
        servers: Array.from(this.servers.values()),
      };
      writeFileSync(INSTALLED_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
      log(`[InstalledServerManager] Failed to save installed servers: ${e}`);
    }
  }

  async install(
    catalogEntry: CatalogServer,
    packageIndex: number = 0
  ): Promise<InstalledServer> {
    const serverId = catalogEntry.id;
    const name = catalogEntry.name || serverId;

    // Get package info
    const packages = catalogEntry.packages || [];
    let packageType = 'npm';
    let packageId = name;
    let requiredEnvVars: InstalledServer['requiredEnvVars'] = [];
    let binaryUrl: string | undefined;
    let binaryPath: string | undefined;

    if (packages.length > 0 && packageIndex < packages.length) {
      const pkg = packages[packageIndex];
      packageType = pkg.registryType || 'npm';
      // Use identifier if it's a non-empty string, otherwise fall back to name
      packageId = (pkg.identifier && typeof pkg.identifier === 'string' && pkg.identifier.trim()) 
        ? pkg.identifier.trim() 
        : name;
      requiredEnvVars = pkg.environmentVariables || [];
      
      // Check for binary URL in package info
      if (packageType === 'binary' && pkg.binaryUrl) {
        binaryUrl = pkg.binaryUrl;
      }
      
      log(`[InstalledServerManager] Package info: type=${packageType}, identifier="${pkg.identifier}", using="${packageId}"`);
    } else {
      log(`[InstalledServerManager] No package info found, using name as packageId: ${packageId}`);
    }

    // For binary packages, download the binary now
    if (packageType === 'binary') {
      if (!binaryUrl) {
        log(`[InstalledServerManager] ERROR: Binary package but no binaryUrl provided!`);
        throw new Error('Binary package requires a download URL. The GitHub release may not have been found.');
      }
      log(`[InstalledServerManager] Downloading binary from: ${binaryUrl}`);
      try {
        binaryPath = await downloadBinary(serverId, binaryUrl, {
          expectedBinaryName: name,
        });
        // For binaries, packageId is the serverId (we run the local binary)
        packageId = serverId;
        log(`[InstalledServerManager] Binary downloaded to: ${binaryPath}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`[InstalledServerManager] Binary download failed: ${msg}`);
        throw new Error(`Failed to download binary: ${msg}`);
      }
    }

    const server: InstalledServer = {
      id: serverId,
      name,
      packageType,
      packageId,
      autoStart: false,
      args: [],
      requiredEnvVars,
      installedAt: Date.now(),
      catalogSource: catalogEntry.source || null,
      homepageUrl: catalogEntry.homepageUrl || null,
      description: catalogEntry.description || null,
      binaryUrl,
      binaryPath,
    };

    this.servers.set(serverId, server);
    this.save();

    log(`[InstalledServerManager] Installed server: ${name} (${packageType}:${packageId})`);
    return server;
  }

  /**
   * Add a remote HTTP/SSE MCP server.
   * 
   * @param name Display name for the server
   * @param url The URL of the remote MCP server
   * @param type Transport type: 'http' for StreamableHTTP, 'sse' for SSE
   * @param headers Optional HTTP headers to include with requests
   * @returns The installed server configuration
   */
  addRemoteServer(
    name: string,
    url: string,
    type: 'http' | 'sse' = 'http',
    headers?: Record<string, string>
  ): InstalledServer {
    // Generate a human-readable ID from the URL hostname
    // e.g., "https://api.github.com/mcp" -> "github" or "github-mcp"
    const urlObj = new URL(url);
    let serverId = urlObj.hostname
      .replace(/^(www|api)\./, '') // Remove www. or api. prefix
      .replace(/\.(com|org|net|io|dev|ai)$/, '') // Remove common TLDs
      .replace(/[^a-zA-Z0-9-]/g, '-') // Replace special chars with hyphens
      .toLowerCase();
    
    // Add a short hash if there's a path to differentiate multiple endpoints on same host
    if (urlObj.pathname && urlObj.pathname !== '/' && urlObj.pathname !== '/mcp') {
      const pathPart = urlObj.pathname.split('/').filter(Boolean)[0];
      if (pathPart && pathPart !== 'mcp') {
        serverId = `${serverId}-${pathPart}`;
      }
    }
    
    // Ensure uniqueness by adding a suffix if this ID already exists
    let finalId = serverId;
    let counter = 2;
    while (this.servers.has(finalId)) {
      finalId = `${serverId}-${counter}`;
      counter++;
    }

    const server: InstalledServer = {
      id: finalId,
      name,
      packageType: type,
      packageId: url, // Store URL as packageId for display
      autoStart: false,
      args: [],
      requiredEnvVars: [],
      installedAt: Date.now(),
      catalogSource: 'remote',
      homepageUrl: null,
      description: `Remote ${type.toUpperCase()} server`,
      remoteUrl: url,
      remoteHeaders: headers,
    };

    this.servers.set(finalId, server);
    this.save();

    log(`[InstalledServerManager] Added remote server: ${name} as ${finalId} (${type}:${url})`);
    return server;
  }

  uninstall(serverId: string): boolean {
    const server = this.servers.get(serverId);
    if (!server) {
      return false;
    }

    // Stop if running
    const proc = this.runner.getProcess(serverId);
    if (proc && proc.state === ProcessState.RUNNING) {
      this.runner.stopServer(serverId);
    }

    // If it's a binary package, remove the downloaded binary
    if (server.packageType === 'binary') {
      removeBinary(serverId);
    }

    // Remove config and secrets
    this.servers.delete(serverId);
    this.secrets.delete(serverId);
    this.save();

    log(`[InstalledServerManager] Uninstalled server: ${serverId}`);
    return true;
  }

  getServer(serverId: string): InstalledServer | undefined {
    return this.servers.get(serverId);
  }

  getAllServers(): InstalledServer[] {
    return Array.from(this.servers.values());
  }

  isInstalled(serverId: string): boolean {
    return this.servers.has(serverId);
  }

  async start(
    serverId: string,
    options?: { 
      useDocker?: boolean; 
      onProgress?: (message: string) => void;
    }
  ): Promise<ServerProcess> {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`Server not installed: ${serverId}`);
    }

    // Check for required secrets
    const missing = this.secrets.getMissingSecrets(
      serverId,
      server.requiredEnvVars
    );
    if (missing.length > 0) {
      const names = missing.map(m => m.name);
      throw new Error(`Missing required secrets: ${names.join(', ')}`);
    }

    // Get secrets as env vars
    const envVars = this.secrets.getAll(serverId);

    // Determine if we should use Docker
    const useDocker = options?.useDocker ?? server.useDocker ?? false;
    
    if (useDocker) {
      log(`[InstalledServerManager] Starting ${serverId} in Docker mode`);
      return this.dockerRunner.startServer(
        serverId,
        server.packageType,
        server.packageId,
        {
          env: envVars,
          args: server.args.length > 0 ? server.args : undefined,
          volumes: server.dockerVolumes,
          onProgress: options?.onProgress,
        }
      );
    }

    // Start the server natively
    return this.runner.startServer(
      serverId,
      server.packageType,
      server.packageId,
      envVars,
      server.args.length > 0 ? server.args : undefined
    );
  }

  async stop(serverId: string): Promise<boolean> {
    // Try to stop Docker container first
    if (this.dockerRunner.isRunning(serverId)) {
      return this.dockerRunner.stopServer(serverId);
    }
    // Fall back to native runner
    return this.runner.stopServer(serverId);
  }

  async restart(
    serverId: string,
    options?: { useDocker?: boolean; onProgress?: (message: string) => void }
  ): Promise<ServerProcess> {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`Server not installed: ${serverId}`);
    }

    await this.stop(serverId);
    return this.start(serverId, options);
  }

  /**
   * Check if Docker is available for running MCP servers.
   */
  async checkDockerAvailable(): Promise<{ 
    available: boolean; 
    version?: string; 
    error?: string;
  }> {
    const dockerExec = getDockerExec();
    return dockerExec.checkDocker();
  }

  /**
   * Check if Docker should be preferred for a given server.
   * Returns recommendation based on package type and platform.
   */
  async shouldPreferDocker(serverId: string): Promise<{
    prefer: boolean;
    reason?: string;
    dockerAvailable: boolean;
  }> {
    const server = this.servers.get(serverId);
    if (!server) {
      return { prefer: false, dockerAvailable: false };
    }

    const dockerInfo = await this.checkDockerAvailable();
    
    if (!dockerInfo.available) {
      return { 
        prefer: false, 
        dockerAvailable: false,
        reason: dockerInfo.error || 'Docker not available'
      };
    }

    // Recommend Docker for binaries on macOS (Gatekeeper bypass)
    if (server.packageType === 'binary' && process.platform === 'darwin') {
      return {
        prefer: true,
        dockerAvailable: true,
        reason: 'Docker bypasses macOS Gatekeeper for downloaded binaries'
      };
    }

    return { prefer: false, dockerAvailable: true };
  }

  /**
   * Enable or disable Docker mode for a server.
   */
  setDockerMode(serverId: string, useDocker: boolean, volumes?: string[]): void {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`Server not installed: ${serverId}`);
    }

    server.useDocker = useDocker;
    if (volumes !== undefined) {
      server.dockerVolumes = volumes;
    }

    this.save();
    log(`[InstalledServerManager] Docker mode ${useDocker ? 'enabled' : 'disabled'} for ${serverId}`);
  }

  getStatus(serverId: string): {
    installed: boolean;
    server?: InstalledServer;
    process?: ServerProcess | null;
    missingSecrets?: string[];
    canStart?: boolean;
    runningInDocker?: boolean;
  } {
    const server = this.servers.get(serverId);
    if (!server) {
      return { installed: false };
    }

    // Check both native and Docker runners
    let proc = this.runner.getProcess(serverId);
    let runningInDocker = false;
    
    if (!proc || proc.state !== ProcessState.RUNNING) {
      const dockerProc = this.dockerRunner.getProcess(serverId);
      if (dockerProc) {
        proc = dockerProc;
        runningInDocker = dockerProc.state === ProcessState.RUNNING;
      }
    }
    
    const missingSecrets = this.secrets.getMissingSecrets(
      serverId,
      server.requiredEnvVars
    );

    return {
      installed: true,
      server,
      process: proc,
      missingSecrets: missingSecrets.map(m => m.name),
      canStart: missingSecrets.length === 0,
      runningInDocker,
    };
  }

  getAllStatus(): Array<ReturnType<InstalledServerManager['getStatus']>> {
    return Array.from(this.servers.keys()).map(id => this.getStatus(id));
  }

  setSecret(serverId: string, key: string, value: string): void {
    this.secrets.set(serverId, key, value);
  }

  setSecrets(serverId: string, secrets: Record<string, string>): void {
    this.secrets.setAll(serverId, secrets);
  }

  configure(
    serverId: string,
    options: { 
      autoStart?: boolean; 
      args?: string[];
      useDocker?: boolean;
      dockerVolumes?: string[];
    }
  ): void {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`Server not installed: ${serverId}`);
    }

    if (options.autoStart !== undefined) {
      server.autoStart = options.autoStart;
    }
    if (options.args !== undefined) {
      server.args = options.args;
    }
    if (options.useDocker !== undefined) {
      server.useDocker = options.useDocker;
    }
    if (options.dockerVolumes !== undefined) {
      server.dockerVolumes = options.dockerVolumes;
    }

    this.save();
  }

  async startAutoStartServers(): Promise<void> {
    for (const server of this.servers.values()) {
      if (server.autoStart) {
        try {
          await this.start(server.id);
        } catch (e) {
          log(`[InstalledServerManager] Failed to auto-start ${server.id}: ${e}`);
        }
      }
    }
  }

  async checkRuntimes(): Promise<{
    runtimes: Array<{
      type: string;
      available: boolean;
      version: string | null;
      path: string | null;
      runnerCmd: string | null;
      installHint: string | null;
    }>;
    canInstall: {
      npm: boolean;
      pypi: boolean;
      oci: boolean;
    };
  }> {
    const runtimes = await this.runtimeManager.detectAll();
    return {
      runtimes: runtimes.map(r => ({
        type: r.type,
        available: r.available,
        version: r.version,
        path: r.path,
        runnerCmd: r.runnerCmd,
        installHint: r.installHint,
      })),
      canInstall: {
        npm: runtimes.some(r => r.available && r.type === 'node'),
        pypi: runtimes.some(r => r.available && r.type === 'python'),
        oci: runtimes.some(r => r.available && r.type === 'docker'),
      },
    };
  }
}

// Singleton
let _manager: InstalledServerManager | null = null;

export function getInstalledServerManager(): InstalledServerManager {
  if (!_manager) {
    _manager = new InstalledServerManager();
  }
  return _manager;
}





