/**
 * Package runner - executes MCP servers from npm, pypi, docker, or binaries.
 */

import { spawn, ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { log } from '../native-messaging.js';
import { ProcessState, ServerProcess, RuntimeType } from '../types.js';
import { getRuntimeManager, RuntimeManager } from './runtime.js';
import { getBinaryPath } from './binary-downloader.js';

interface RunningProcess {
  serverId: string;
  packageType: string;
  packageId: string;
  state: ProcessState;
  pid: number | null;
  startedAt: number | null;
  stoppedAt: number | null;
  exitCode: number | null;
  errorMessage: string | null;
  process: ChildProcess | null;
  logBuffer: string[];
}

export class PackageRunner {
  private runtimeManager: RuntimeManager;
  private processes: Map<string, RunningProcess> = new Map();

  constructor() {
    this.runtimeManager = getRuntimeManager();
  }

  async startServer(
    serverId: string,
    packageType: string,
    packageId: string,
    envVars?: Record<string, string>,
    args?: string[],
    onOutput?: (stream: string, line: string) => void
  ): Promise<ServerProcess> {
    // Check if already running
    const existing = this.processes.get(serverId);
    if (existing && existing.state === ProcessState.RUNNING) {
      return this.toServerProcess(existing);
    }

    // Create process record
    const proc: RunningProcess = {
      serverId,
      packageType,
      packageId,
      state: ProcessState.STARTING,
      pid: null,
      startedAt: null,
      stoppedAt: null,
      exitCode: null,
      errorMessage: null,
      process: null,
      logBuffer: [],
    };
    this.processes.set(serverId, proc);

    try {
      // Build command
      const cmd = await this.buildCommand(packageType, packageId, args);
      if (!cmd) {
        proc.state = ProcessState.ERROR;
        proc.errorMessage = `Cannot run ${packageType} packages - runtime not available`;
        return this.toServerProcess(proc);
      }

      // Prepare environment
      const env = { ...process.env, ...envVars };

      log(`[${serverId}] Starting: ${cmd.join(' ')}`);
      proc.logBuffer.push(`$ ${cmd.join(' ')}`);

      // Start process
      const [command, ...cmdArgs] = cmd;
      const child = spawn(command, cmdArgs, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      proc.process = child;
      proc.pid = child.pid || null;
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
            onOutput?.('stdout', line);
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
            onOutput?.('stderr', line);
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
          proc.errorMessage = `Process exited with code ${code}${signal ? ` (signal: ${signal})` : ''}`;
        } else {
          proc.state = ProcessState.STOPPED;
        }

        log(`[${serverId}] Exited with code ${code}`);
      });

      child.on('error', (err) => {
        proc.state = ProcessState.ERROR;
        proc.errorMessage = err.message;
        log(`[${serverId}] Error: ${err.message}`);
      });

      log(`[${serverId}] Started with PID ${child.pid}`);
      return this.toServerProcess(proc);

    } catch (error) {
      log(`[${serverId}] Failed to start: ${error}`);
      proc.state = ProcessState.ERROR;
      proc.errorMessage = error instanceof Error ? error.message : String(error);
      return this.toServerProcess(proc);
    }
  }

  async stopServer(serverId: string, timeout: number = 5000): Promise<boolean> {
    const proc = this.processes.get(serverId);
    if (!proc || !proc.process) {
      return false;
    }

    if (proc.state !== ProcessState.RUNNING && proc.state !== ProcessState.STARTING) {
      return true; // Already stopped
    }

    proc.state = ProcessState.STOPPING;
    const child = proc.process;

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        log(`[${serverId}] Force killing after timeout`);
        child.kill('SIGKILL');
      }, timeout);

      child.once('exit', () => {
        clearTimeout(timeoutId);
        proc.state = ProcessState.STOPPED;
        proc.stoppedAt = Date.now();
        log(`[${serverId}] Stopped`);
        resolve(true);
      });

      // Try graceful shutdown first
      child.kill('SIGTERM');
    });
  }

  async restartServer(
    serverId: string,
    envVars?: Record<string, string>
  ): Promise<ServerProcess> {
    const proc = this.processes.get(serverId);
    if (!proc) {
      throw new Error(`Unknown server: ${serverId}`);
    }

    await this.stopServer(serverId);

    return this.startServer(
      serverId,
      proc.packageType,
      proc.packageId,
      envVars
    );
  }

  getProcess(serverId: string): ServerProcess | null {
    const proc = this.processes.get(serverId);
    return proc ? this.toServerProcess(proc) : null;
  }

  getAllProcesses(): ServerProcess[] {
    return Array.from(this.processes.values()).map(p => this.toServerProcess(p));
  }

  getRunningProcesses(): ServerProcess[] {
    return Array.from(this.processes.values())
      .filter(p => p.state === ProcessState.RUNNING)
      .map(p => this.toServerProcess(p));
  }

  async stopAll(): Promise<void> {
    const running = Array.from(this.processes.values())
      .filter(p => p.state === ProcessState.RUNNING);
    
    await Promise.all(running.map(p => this.stopServer(p.serverId)));
  }

  private async buildCommand(
    packageType: string,
    packageId: string,
    args?: string[]
  ): Promise<string[] | null> {
    // Ensure runtimes are detected
    await this.runtimeManager.detectAll();

    if (packageType === 'npm') {
      const runtime = this.runtimeManager.getRuntime(RuntimeType.NODE);
      if (!runtime?.available) {
        return null;
      }
      const cmd = ['npx', '-y', packageId];
      if (args) cmd.push(...args);
      return cmd;
    }

    if (packageType === 'pypi') {
      const runtime = this.runtimeManager.getRuntime(RuntimeType.PYTHON);
      if (!runtime?.available) {
        return null;
      }
      // Prefer uvx if available
      let cmd: string[];
      if (runtime.runnerCmd === 'uvx') {
        cmd = ['uvx', packageId];
      } else {
        cmd = ['python3', '-m', packageId.replace(/-/g, '_')];
      }
      if (args) cmd.push(...args);
      return cmd;
    }

    if (packageType === 'oci') {
      const runtime = this.runtimeManager.getRuntime(RuntimeType.DOCKER);
      if (!runtime?.available) {
        return null;
      }
      const cmd = ['docker', 'run', '-i', '--rm', packageId];
      if (args) cmd.push(...args);
      return cmd;
    }

    if (packageType === 'binary') {
      // packageId should be the serverId for binaries
      const binaryPath = getBinaryPath(packageId);
      if (!existsSync(binaryPath)) {
        log(`[PackageRunner] Binary not found: ${binaryPath}`);
        return null;
      }
      const cmd = [binaryPath];
      if (args) cmd.push(...args);
      return cmd;
    }

    return null;
  }

  private toServerProcess(proc: RunningProcess): ServerProcess {
    return {
      serverId: proc.serverId,
      packageType: proc.packageType,
      packageId: proc.packageId,
      state: proc.state,
      pid: proc.pid,
      startedAt: proc.startedAt,
      stoppedAt: proc.stoppedAt,
      exitCode: proc.exitCode,
      errorMessage: proc.errorMessage,
      recentLogs: proc.logBuffer.slice(-50),
    };
  }
}

// Singleton
let _runner: PackageRunner | null = null;

export function getPackageRunner(): PackageRunner {
  if (!_runner) {
    _runner = new PackageRunner();
  }
  return _runner;
}





