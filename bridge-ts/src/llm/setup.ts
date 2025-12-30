/**
 * LLM Setup - Downloads and manages local LLM (llamafile).
 * 
 * Currently supports llamafile only, but designed for future expansion.
 * 
 * Flow:
 * 1. Check status (is llamafile downloaded? running?)
 * 2. If not downloaded, user clicks "Download"
 * 3. Download progress is streamed back
 * 4. Once downloaded, can start/stop the server
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'node:https';
import { spawn, ChildProcess } from 'node:child_process';
import { log } from '../native-messaging.js';

// =============================================================================
// Types
// =============================================================================

export interface LLMModel {
  /** Unique identifier */
  id: string;
  
  /** Human-readable name */
  name: string;
  
  /** Size in bytes */
  size: number;
  
  /** Human-readable size */
  sizeHuman: string;
  
  /** Download URL */
  url: string;
  
  /** Description */
  description: string;
  
  /** Whether this model supports tool calling */
  supportsTools: boolean;
  
  /** Recommended for most users */
  recommended?: boolean;
}

export interface LLMSetupStatus {
  /** Is any LLM currently running and accessible? */
  available: boolean;
  
  /** What's running (if anything) */
  runningProvider: 'llamafile' | 'ollama' | 'external' | null;
  
  /** URL of running LLM */
  runningUrl: string | null;
  
  /** Downloaded model IDs */
  downloadedModels: string[];
  
  /** Currently running model (if we started it) */
  activeModel: string | null;
  
  /** Available models to download */
  availableModels: LLMModel[];
  
  /** Ollama-specific info (when Ollama is the provider) */
  ollamaInfo?: {
    version: string | null;
    supportsTools: boolean;
    minimumToolVersion: string;
    recommendedVersion: string;
    warning?: string;
  };
}

export interface DownloadProgress {
  modelId: string;
  bytesDownloaded: number;
  totalBytes: number;
  percent: number;
  status: 'downloading' | 'complete' | 'error';
  error?: string;
}

// =============================================================================
// Available Models
// =============================================================================

/**
 * Available llamafile models.
 * 
 * These are hosted on HuggingFace by Mozilla.
 * We pick models that work well for tool calling.
 */
const AVAILABLE_MODELS: LLMModel[] = [
  {
    id: 'mistral-7b-instruct',
    name: 'Mistral 7B Instruct',
    size: 4_070_000_000, // ~4.1 GB
    sizeHuman: '4.1 GB',
    url: 'https://huggingface.co/Mozilla/Mistral-7B-Instruct-v0.2-llamafile/resolve/main/mistral-7b-instruct-v0.2.Q4_0.llamafile',
    description: 'Best for tool calling. Good balance of speed and capability.',
    supportsTools: true,
    recommended: true,
  },
  {
    id: 'phi-2',
    name: 'Phi-2 (2.7B)',
    size: 1_700_000_000, // ~1.7 GB
    sizeHuman: '1.7 GB',
    url: 'https://huggingface.co/Mozilla/phi-2-llamafile/resolve/main/phi-2.Q4_K_M.llamafile',
    description: 'Smaller and faster. Good for testing.',
    supportsTools: true,
  },
  {
    id: 'tinyllama-1.1b',
    name: 'TinyLlama 1.1B',
    size: 670_000_000, // ~670 MB
    sizeHuman: '670 MB',
    url: 'https://huggingface.co/Mozilla/TinyLlama-1.1B-Chat-v1.0-llamafile/resolve/main/TinyLlama-1.1B-Chat-v1.0.Q5_K_M.llamafile',
    description: 'Fastest download. Limited capability but good for testing.',
    supportsTools: false,
  },
  {
    id: 'llama-3.2-3b',
    name: 'Llama 3.2 3B Instruct',
    size: 2_000_000_000, // ~2 GB
    sizeHuman: '2.0 GB',
    url: 'https://huggingface.co/Mozilla/Llama-3.2-3B-Instruct-llamafile/resolve/main/Llama-3.2-3B-Instruct.Q6_K.llamafile',
    description: 'Latest Llama model. Great instruction following.',
    supportsTools: true,
  },
];

// =============================================================================
// Paths
// =============================================================================

function getLLMDir(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
  return path.join(homeDir, '.harbor', 'llm');
}

function getModelPath(modelId: string): string {
  return path.join(getLLMDir(), `${modelId}.llamafile`);
}

function ensureLLMDir(): void {
  const dir = getLLMDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// =============================================================================
// LLM Setup Manager
// =============================================================================

export class LLMSetupManager {
  private runningProcess: ChildProcess | null = null;
  private activeModelId: string | null = null;
  private downloadAbortController: AbortController | null = null;
  
  /**
   * Get current setup status.
   */
  async getStatus(): Promise<LLMSetupStatus> {
    // Check what's downloaded
    const downloadedModels = this.getDownloadedModels();
    
    // Check if something is running
    const runningCheck = await this.checkRunning();
    
    const status: LLMSetupStatus = {
      available: runningCheck.available,
      runningProvider: runningCheck.provider,
      runningUrl: runningCheck.url,
      downloadedModels,
      activeModel: this.activeModelId,
      availableModels: AVAILABLE_MODELS,
    };
    
    // Include Ollama-specific info if Ollama is running
    if (runningCheck.ollamaInfo) {
      status.ollamaInfo = runningCheck.ollamaInfo;
    }
    
    return status;
  }
  
  /**
   * Get list of downloaded model IDs.
   */
  getDownloadedModels(): string[] {
    const dir = getLLMDir();
    if (!fs.existsSync(dir)) {
      return [];
    }
    
    const files = fs.readdirSync(dir);
    return files
      .filter(f => f.endsWith('.llamafile'))
      .map(f => f.replace('.llamafile', ''));
  }
  
  /**
   * Check if an LLM is running.
   */
  private async checkRunning(): Promise<{
    available: boolean;
    provider: 'llamafile' | 'ollama' | 'external' | null;
    url: string | null;
    ollamaInfo?: {
      version: string | null;
      supportsTools: boolean;
      minimumToolVersion: string;
      recommendedVersion: string;
      warning?: string;
    };
  }> {
    // Check llamafile default port
    const llamafileUrl = 'http://localhost:8080';
    if (await this.isServerRunning(llamafileUrl)) {
      return {
        available: true,
        provider: this.activeModelId ? 'llamafile' : 'external',
        url: llamafileUrl,
      };
    }
    
    // Check Ollama
    const ollamaUrl = 'http://localhost:11434';
    if (await this.isOllamaRunning(ollamaUrl)) {
      const ollamaInfo = await this.getOllamaInfo(ollamaUrl);
      return {
        available: true,
        provider: 'ollama',
        url: ollamaUrl,
        ollamaInfo,
      };
    }
    
    return {
      available: false,
      provider: null,
      url: null,
    };
  }
  
  /**
   * Check if Ollama is running (uses /api/tags endpoint).
   */
  private async isOllamaRunning(baseUrl: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      
      const response = await fetch(`${baseUrl}/api/tags`, {
        method: 'GET',
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      return response.ok;
    } catch {
      return false;
    }
  }
  
  /**
   * Get Ollama version and tool support info.
   */
  private async getOllamaInfo(baseUrl: string): Promise<{
    version: string | null;
    supportsTools: boolean;
    minimumToolVersion: string;
    recommendedVersion: string;
    warning?: string;
  }> {
    const MINIMUM_TOOL_VERSION = '0.3.0';
    const RECOMMENDED_VERSION = '0.5.0';
    
    let version: string | null = null;
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      
      const response = await fetch(`${baseUrl}/api/version`, {
        method: 'GET',
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      
      if (response.ok) {
        const data = await response.json() as { version?: string };
        version = data.version || null;
      }
    } catch {
      // Version check failed
    }
    
    // Compare versions
    const supportsTools = version ? this.compareVersions(version, MINIMUM_TOOL_VERSION) >= 0 : true;
    const meetsRecommended = version ? this.compareVersions(version, RECOMMENDED_VERSION) >= 0 : true;
    
    let warning: string | undefined;
    if (!supportsTools) {
      warning = `Version ${version} does not support tool calling. Upgrade to ${MINIMUM_TOOL_VERSION} or later.`;
    } else if (!meetsRecommended) {
      warning = `Version ${version} supports tools but ${RECOMMENDED_VERSION}+ is recommended for reliability.`;
    }
    
    return {
      version,
      supportsTools,
      minimumToolVersion: MINIMUM_TOOL_VERSION,
      recommendedVersion: RECOMMENDED_VERSION,
      warning,
    };
  }
  
  /**
   * Compare two semantic version strings.
   * Returns: negative if a < b, 0 if a == b, positive if a > b
   */
  private compareVersions(a: string, b: string): number {
    const partsA = a.replace(/^v/, '').split('.').map(p => parseInt(p, 10) || 0);
    const partsB = b.replace(/^v/, '').split('.').map(p => parseInt(p, 10) || 0);
    
    const maxLen = Math.max(partsA.length, partsB.length);
    
    for (let i = 0; i < maxLen; i++) {
      const numA = partsA[i] || 0;
      const numB = partsB[i] || 0;
      
      if (numA !== numB) {
        return numA - numB;
      }
    }
    
    return 0;
  }
  
  /**
   * Check if a server is responding.
   */
  private async isServerRunning(baseUrl: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      
      const response = await fetch(`${baseUrl}/v1/models`, {
        method: 'GET',
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      return response.ok;
    } catch {
      return false;
    }
  }
  
  /**
   * Download a model.
   */
  async downloadModel(
    modelId: string,
    onProgress?: (progress: DownloadProgress) => void
  ): Promise<void> {
    const model = AVAILABLE_MODELS.find(m => m.id === modelId);
    if (!model) {
      throw new Error(`Unknown model: ${modelId}`);
    }
    
    ensureLLMDir();
    const targetPath = getModelPath(modelId);
    const tempPath = `${targetPath}.download`;
    
    // Check if already downloaded
    if (fs.existsSync(targetPath)) {
      log(`[LLMSetup] Model ${modelId} already downloaded`);
      onProgress?.({
        modelId,
        bytesDownloaded: model.size,
        totalBytes: model.size,
        percent: 100,
        status: 'complete',
      });
      return;
    }
    
    log(`[LLMSetup] Starting download of ${modelId} from ${model.url}`);
    
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(tempPath);
      let downloadedBytes = 0;
      
      const request = https.get(model.url, {
        headers: {
          'User-Agent': 'Harbor-Bridge/1.0',
        },
      }, (response) => {
        // Handle redirects
        if (response.statusCode === 301 || response.statusCode === 302) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            log(`[LLMSetup] Following redirect to ${redirectUrl}`);
            file.close();
            fs.unlinkSync(tempPath);
            
            // Recursively follow redirect
            https.get(redirectUrl, {
              headers: { 'User-Agent': 'Harbor-Bridge/1.0' },
            }, (redirectResponse) => {
              this.handleDownloadResponse(
                redirectResponse,
                tempPath,
                targetPath,
                modelId,
                model.size,
                onProgress,
                resolve,
                reject
              );
            }).on('error', (err) => {
              file.close();
              fs.unlinkSync(tempPath);
              reject(err);
            });
            return;
          }
        }
        
        this.handleDownloadResponse(
          response,
          tempPath,
          targetPath,
          modelId,
          model.size,
          onProgress,
          resolve,
          reject
        );
      });
      
      request.on('error', (err) => {
        file.close();
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
        onProgress?.({
          modelId,
          bytesDownloaded: 0,
          totalBytes: model.size,
          percent: 0,
          status: 'error',
          error: err.message,
        });
        reject(err);
      });
    });
  }
  
  private handleDownloadResponse(
    response: any,
    tempPath: string,
    targetPath: string,
    modelId: string,
    expectedSize: number,
    onProgress: ((progress: DownloadProgress) => void) | undefined,
    resolve: () => void,
    reject: (err: Error) => void
  ): void {
    const totalBytes = parseInt(response.headers['content-length'] || String(expectedSize), 10);
    let downloadedBytes = 0;
    
    const file = fs.createWriteStream(tempPath);
    
    response.on('data', (chunk: Buffer) => {
      downloadedBytes += chunk.length;
      const percent = Math.round((downloadedBytes / totalBytes) * 100);
      
      onProgress?.({
        modelId,
        bytesDownloaded: downloadedBytes,
        totalBytes,
        percent,
        status: 'downloading',
      });
    });
    
    response.pipe(file);
    
    file.on('finish', () => {
      file.close();
      
      // Rename temp to final
      fs.renameSync(tempPath, targetPath);
      
      // Make executable
      fs.chmodSync(targetPath, 0o755);
      
      log(`[LLMSetup] Download complete: ${targetPath}`);
      
      onProgress?.({
        modelId,
        bytesDownloaded: totalBytes,
        totalBytes,
        percent: 100,
        status: 'complete',
      });
      
      resolve();
    });
    
    file.on('error', (err) => {
      file.close();
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
      onProgress?.({
        modelId,
        bytesDownloaded: downloadedBytes,
        totalBytes,
        percent: 0,
        status: 'error',
        error: err.message,
      });
      reject(err);
    });
  }
  
  /**
   * Cancel an in-progress download.
   */
  cancelDownload(): void {
    if (this.downloadAbortController) {
      this.downloadAbortController.abort();
      this.downloadAbortController = null;
    }
  }
  
  /**
   * Delete a downloaded model.
   */
  deleteModel(modelId: string): boolean {
    const modelPath = getModelPath(modelId);
    if (fs.existsSync(modelPath)) {
      // Stop if running
      if (this.activeModelId === modelId) {
        this.stopLocalLLM();
      }
      
      fs.unlinkSync(modelPath);
      log(`[LLMSetup] Deleted model: ${modelId}`);
      return true;
    }
    return false;
  }
  
  /**
   * Start a downloaded llamafile.
   */
  async startLocalLLM(modelId: string, port: number = 8080): Promise<{
    success: boolean;
    error?: string;
    url?: string;
  }> {
    const modelPath = getModelPath(modelId);
    
    if (!fs.existsSync(modelPath)) {
      return {
        success: false,
        error: `Model not downloaded: ${modelId}`,
      };
    }
    
    // Stop any existing process
    if (this.runningProcess) {
      await this.stopLocalLLM();
    }
    
    log(`[LLMSetup] Starting llamafile: ${modelPath}`);
    
    try {
      // Start the llamafile server
      this.runningProcess = spawn(modelPath, [
        '--server',
        '--host', '127.0.0.1',
        '--port', String(port),
        '--ctx-size', '4096',
        '--parallel', '1',
      ], {
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      
      this.activeModelId = modelId;
      
      // Log stderr
      this.runningProcess.stderr?.on('data', (data) => {
        log(`[llamafile] ${data.toString().trim()}`);
      });
      
      this.runningProcess.on('error', (err) => {
        log(`[LLMSetup] Process error: ${err.message}`);
        this.runningProcess = null;
        this.activeModelId = null;
      });
      
      this.runningProcess.on('exit', (code) => {
        log(`[LLMSetup] Process exited with code ${code}`);
        this.runningProcess = null;
        this.activeModelId = null;
      });
      
      // Wait for server to be ready
      const url = `http://127.0.0.1:${port}`;
      const ready = await this.waitForServer(url, 30000);
      
      if (!ready) {
        this.stopLocalLLM();
        return {
          success: false,
          error: 'Server failed to start within 30 seconds',
        };
      }
      
      log(`[LLMSetup] Server ready at ${url}`);
      
      return {
        success: true,
        url,
      };
      
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[LLMSetup] Failed to start: ${message}`);
      
      return {
        success: false,
        error: message,
      };
    }
  }
  
  /**
   * Wait for the server to be ready.
   */
  private async waitForServer(url: string, timeoutMs: number): Promise<boolean> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
      if (await this.isServerRunning(url)) {
        return true;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    
    return false;
  }
  
  /**
   * Stop the running llamafile.
   */
  async stopLocalLLM(): Promise<boolean> {
    if (!this.runningProcess) {
      return false;
    }
    
    log('[LLMSetup] Stopping llamafile...');
    
    try {
      this.runningProcess.kill('SIGTERM');
      
      // Wait a bit for graceful shutdown
      await new Promise(r => setTimeout(r, 1000));
      
      // Force kill if still running
      if (this.runningProcess && !this.runningProcess.killed) {
        this.runningProcess.kill('SIGKILL');
      }
      
      this.runningProcess = null;
      this.activeModelId = null;
      
      log('[LLMSetup] Stopped');
      return true;
      
    } catch (error) {
      log(`[LLMSetup] Error stopping: ${error}`);
      this.runningProcess = null;
      this.activeModelId = null;
      return false;
    }
  }
  
  /**
   * Get the PID of the running process.
   */
  getPid(): number | null {
    return this.runningProcess?.pid || null;
  }
}

// Singleton
let _setupManager: LLMSetupManager | null = null;

export function getLLMSetupManager(): LLMSetupManager {
  if (!_setupManager) {
    _setupManager = new LLMSetupManager();
  }
  return _setupManager;
}


