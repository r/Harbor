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

const CONFIG_DIR = join(homedir(), '.harbor');
const INSTALLED_FILE = join(CONFIG_DIR, 'installed_servers.json');

export class InstalledServerManager {
  private servers: Map<string, InstalledServer> = new Map();
  private runtimeManager: RuntimeManager;
  private runner: PackageRunner;
  private secrets: SecretStore;

  constructor() {
    mkdirSync(CONFIG_DIR, { recursive: true });
    this.runtimeManager = getRuntimeManager();
    this.runner = getPackageRunner();
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

    if (packages.length > 0 && packageIndex < packages.length) {
      const pkg = packages[packageIndex];
      packageType = pkg.registryType || 'npm';
      packageId = pkg.identifier || name;
      requiredEnvVars = pkg.environmentVariables || [];
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
    };

    this.servers.set(serverId, server);
    this.save();

    log(`[InstalledServerManager] Installed server: ${name} (${packageType}:${packageId})`);
    return server;
  }

  uninstall(serverId: string): boolean {
    if (!this.servers.has(serverId)) {
      return false;
    }

    // Stop if running
    const proc = this.runner.getProcess(serverId);
    if (proc && proc.state === ProcessState.RUNNING) {
      this.runner.stopServer(serverId);
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

  async start(serverId: string): Promise<ServerProcess> {
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

    // Start the server
    return this.runner.startServer(
      serverId,
      server.packageType,
      server.packageId,
      envVars,
      server.args.length > 0 ? server.args : undefined
    );
  }

  async stop(serverId: string): Promise<boolean> {
    return this.runner.stopServer(serverId);
  }

  async restart(serverId: string): Promise<ServerProcess> {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`Server not installed: ${serverId}`);
    }

    const envVars = this.secrets.getAll(serverId);
    return this.runner.restartServer(serverId, envVars);
  }

  getStatus(serverId: string): {
    installed: boolean;
    server?: InstalledServer;
    process?: ServerProcess | null;
    missingSecrets?: string[];
    canStart?: boolean;
  } {
    const server = this.servers.get(serverId);
    if (!server) {
      return { installed: false };
    }

    const proc = this.runner.getProcess(serverId);
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
    options: { autoStart?: boolean; args?: string[] }
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





