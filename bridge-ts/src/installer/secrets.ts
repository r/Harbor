/**
 * Secret store for API keys and credentials.
 * 
 * Supports multiple credential types:
 * - API_KEY: Single token/key value
 * - PASSWORD: Username + password pair
 * - OAUTH: OAuth tokens with expiration (future)
 * - HEADER: Custom header values
 * 
 * Uses a JSON file with restrictive permissions for now.
 * TODO: Use system keychain (Keychain on macOS, libsecret on Linux, etc.)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { log } from '../native-messaging.js';
import { 
  CredentialType, 
  CredentialRequirement, 
  StoredCredential, 
  CredentialStatus 
} from '../types.js';

const SECRETS_DIR = join(homedir(), '.harbor', 'secrets');
const SECRETS_FILE = join(SECRETS_DIR, 'credentials.json');

// Storage format version for migrations
const STORAGE_VERSION = 2;

interface StorageFormat {
  version: number;
  credentials: Record<string, Record<string, StoredCredential>>;
  // Legacy format for backward compatibility
  legacy?: Record<string, Record<string, string>>;
}

export class SecretStore {
  private credentials: Record<string, Record<string, StoredCredential>> = {};
  // Legacy storage for backward compatibility
  private legacySecrets: Record<string, Record<string, string>> = {};

  constructor() {
    mkdirSync(SECRETS_DIR, { recursive: true });
    try {
      chmodSync(SECRETS_DIR, 0o700);
    } catch {
      // Ignore permission errors
    }
    this.load();
  }

  private load(): void {
    if (existsSync(SECRETS_FILE)) {
      try {
        const data = JSON.parse(readFileSync(SECRETS_FILE, 'utf-8'));
        
        if (data.version === STORAGE_VERSION) {
          // New format
          this.credentials = data.credentials || {};
          this.legacySecrets = data.legacy || {};
        } else if (!data.version) {
          // Old format - migrate
          log('[SecretStore] Migrating from legacy format');
          this.legacySecrets = data;
          this.credentials = {};
          this.migrateFromLegacy();
        }
      } catch (e) {
        log(`[SecretStore] Failed to load secrets: ${e}`);
        this.credentials = {};
        this.legacySecrets = {};
      }
    }
  }

  private migrateFromLegacy(): void {
    // Convert legacy key-value pairs to StoredCredential format
    for (const [serverId, secrets] of Object.entries(this.legacySecrets)) {
      if (!this.credentials[serverId]) {
        this.credentials[serverId] = {};
      }
      
      for (const [key, value] of Object.entries(secrets)) {
        this.credentials[serverId][key] = {
          key,
          value,
          type: CredentialType.API_KEY,
          setAt: Date.now(),
        };
      }
    }
    
    this.save();
  }

  private save(): void {
    try {
      const data: StorageFormat = {
        version: STORAGE_VERSION,
        credentials: this.credentials,
        legacy: this.legacySecrets,
      };
      writeFileSync(SECRETS_FILE, JSON.stringify(data, null, 2));
      chmodSync(SECRETS_FILE, 0o600);
    } catch (e) {
      log(`[SecretStore] Failed to save secrets: ${e}`);
    }
  }

  // ===========================================================================
  // New Credential API
  // ===========================================================================

  /**
   * Set a credential for a server.
   */
  setCredential(serverId: string, credential: StoredCredential): void {
    if (!this.credentials[serverId]) {
      this.credentials[serverId] = {};
    }
    
    this.credentials[serverId][credential.key] = {
      ...credential,
      setAt: Date.now(),
    };
    
    // Also update legacy format for backward compatibility
    if (!this.legacySecrets[serverId]) {
      this.legacySecrets[serverId] = {};
    }
    this.legacySecrets[serverId][credential.key] = credential.value;
    
    // For PASSWORD type, also store username
    if (credential.type === CredentialType.PASSWORD && credential.username) {
      this.legacySecrets[serverId][`${credential.key}_username`] = credential.username;
    }
    
    this.save();
  }

  /**
   * Get a credential for a server.
   */
  getCredential(serverId: string, key: string): StoredCredential | undefined {
    return this.credentials[serverId]?.[key];
  }

  /**
   * Get all credentials for a server.
   */
  getCredentials(serverId: string): StoredCredential[] {
    const serverCreds = this.credentials[serverId];
    if (!serverCreds) return [];
    return Object.values(serverCreds);
  }

  /**
   * Delete a credential.
   */
  deleteCredential(serverId: string, key: string): void {
    if (this.credentials[serverId]) {
      delete this.credentials[serverId][key];
      if (Object.keys(this.credentials[serverId]).length === 0) {
        delete this.credentials[serverId];
      }
    }
    
    if (this.legacySecrets[serverId]) {
      delete this.legacySecrets[serverId][key];
      delete this.legacySecrets[serverId][`${key}_username`];
      if (Object.keys(this.legacySecrets[serverId]).length === 0) {
        delete this.legacySecrets[serverId];
      }
    }
    
    this.save();
  }

  /**
   * Delete all credentials for a server.
   */
  deleteServerCredentials(serverId: string): void {
    delete this.credentials[serverId];
    delete this.legacySecrets[serverId];
    this.save();
  }

  /**
   * Check if a credential has expired.
   */
  isExpired(credential: StoredCredential): boolean {
    if (!credential.expiresAt) return false;
    return Date.now() > credential.expiresAt;
  }

  /**
   * Get the status of credentials for a server.
   * Compares stored credentials against requirements.
   */
  getCredentialStatus(
    serverId: string,
    requirements: CredentialRequirement[]
  ): CredentialStatus {
    const stored = this.credentials[serverId] || {};
    
    const configured: CredentialStatus['configured'] = [];
    const missing: CredentialStatus['missing'] = [];
    const expired: CredentialStatus['expired'] = [];

    for (const req of requirements) {
      const cred = stored[req.key];
      
      if (!cred) {
        missing.push({
          key: req.key,
          label: req.label,
          type: req.type,
          required: req.required,
        });
      } else if (this.isExpired(cred)) {
        expired.push({
          key: cred.key,
          type: cred.type,
          expiresAt: cred.expiresAt!,
        });
      } else {
        configured.push({
          key: cred.key,
          type: cred.type,
          setAt: cred.setAt,
          isExpired: false,
        });
      }
    }

    // Check if all required credentials are set
    const requiredMissing = missing.filter(m => m.required);
    const isComplete = requiredMissing.length === 0 && expired.length === 0;

    return {
      serverId,
      isComplete,
      configured,
      missing,
      expired,
    };
  }

  /**
   * Validate credentials against requirements.
   * Returns validation errors if any.
   */
  validateCredentials(
    serverId: string,
    requirements: CredentialRequirement[]
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const stored = this.credentials[serverId] || {};

    for (const req of requirements) {
      const cred = stored[req.key];

      if (!cred && req.required) {
        errors.push(`Missing required credential: ${req.label}`);
        continue;
      }

      if (!cred) continue;

      // Check expiration
      if (this.isExpired(cred)) {
        errors.push(`Credential expired: ${req.label}`);
        continue;
      }

      // Validate pattern if specified
      if (req.pattern && cred.value) {
        try {
          const regex = new RegExp(req.pattern);
          if (!regex.test(cred.value)) {
            errors.push(`Invalid format for ${req.label}`);
          }
        } catch {
          // Invalid regex, skip validation
        }
      }

      // For PASSWORD type, check username is set
      if (req.type === CredentialType.PASSWORD && !cred.username) {
        errors.push(`Missing username for ${req.label}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Generate environment variables from stored credentials.
   * This is used when spawning MCP server processes.
   */
  generateEnvVars(
    serverId: string,
    requirements: CredentialRequirement[]
  ): Record<string, string> {
    const envVars: Record<string, string> = {};
    const stored = this.credentials[serverId] || {};

    for (const req of requirements) {
      const cred = stored[req.key];
      if (!cred || this.isExpired(cred)) continue;

      switch (req.type) {
        case CredentialType.API_KEY:
        case CredentialType.HEADER:
          if (req.envVar) {
            envVars[req.envVar] = cred.value;
          }
          break;

        case CredentialType.PASSWORD:
          if (req.usernameEnvVar && cred.username) {
            envVars[req.usernameEnvVar] = cred.username;
          }
          if (req.passwordEnvVar) {
            envVars[req.passwordEnvVar] = cred.value;
          }
          break;

        case CredentialType.OAUTH:
          if (req.envVar) {
            envVars[req.envVar] = cred.value;
          }
          break;
      }
    }

    return envVars;
  }

  // ===========================================================================
  // Legacy API (backward compatibility)
  // ===========================================================================

  /**
   * @deprecated Use getCredential instead
   */
  get(serverId: string, key: string): string | undefined {
    return this.legacySecrets[serverId]?.[key];
  }

  /**
   * @deprecated Use getCredentials + generateEnvVars instead
   */
  getAll(serverId: string): Record<string, string> {
    return { ...(this.legacySecrets[serverId] || {}) };
  }

  /**
   * @deprecated Use setCredential instead
   */
  set(serverId: string, key: string, value: string): void {
    // Create both new and legacy format
    this.setCredential(serverId, {
      key,
      value,
      type: CredentialType.API_KEY,
      setAt: Date.now(),
    });
  }

  /**
   * @deprecated Use setCredential for each credential instead
   */
  setAll(serverId: string, secrets: Record<string, string>): void {
    for (const [key, value] of Object.entries(secrets)) {
      this.set(serverId, key, value);
    }
  }

  /**
   * @deprecated Use deleteCredential or deleteServerCredentials instead
   */
  delete(serverId: string, key?: string): void {
    if (key) {
      this.deleteCredential(serverId, key);
    } else {
      this.deleteServerCredentials(serverId);
    }
  }

  /**
   * Check if a server has any secrets.
   */
  hasSecrets(serverId: string): boolean {
    return serverId in this.credentials && Object.keys(this.credentials[serverId]).length > 0;
  }

  /**
   * List all servers with stored secrets.
   */
  listServers(): string[] {
    return Object.keys(this.credentials);
  }

  /**
   * @deprecated Use getCredentialStatus instead
   */
  getMissingSecrets(
    serverId: string,
    required: Array<{ name: string; isSecret?: boolean }>
  ): Array<{ name: string; isSecret?: boolean }> {
    const stored = this.legacySecrets[serverId] || {};
    return required.filter(
      envVar => envVar.isSecret && envVar.name && !(envVar.name in stored)
    );
  }
}

// Singleton
let _store: SecretStore | null = null;

export function getSecretStore(): SecretStore {
  if (!_store) {
    _store = new SecretStore();
  }
  return _store;
}
