/**
 * MCP Configuration Parser
 * 
 * Parses standard MCP configuration formats:
 * 
 * 1. Claude Desktop format (stdio servers):
 *    {
 *      "mcpServers": {
 *        "server-name": {
 *          "command": "npx",
 *          "args": ["-y", "package-name"],
 *          "env": { "API_KEY": "..." }
 *        }
 *      }
 *    }
 * 
 * 2. VS Code format (HTTP servers):
 *    {
 *      "servers": {
 *        "server-name": {
 *          "type": "http",
 *          "url": "https://...",
 *          "headers": { "Authorization": "Bearer ${input:token}" }
 *        }
 *      },
 *      "inputs": [
 *        { "id": "token", "type": "promptString", "description": "...", "password": true }
 *      ]
 *    }
 */

import { log } from '../native-messaging.js';

// ============================================================================
// Types
// ============================================================================

export interface ParsedServer {
  id: string;
  name: string;
  type: 'stdio' | 'http' | 'sse';
  
  // For stdio servers
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  
  // For HTTP servers
  url?: string;
  headers?: Record<string, string>;
  
  // Required inputs (secrets/prompts)
  requiredInputs: ParsedInput[];
}

export interface ParsedInput {
  id: string;
  description: string;
  isSecret: boolean;
  envVar?: string; // For stdio servers, the env var name
  headerVar?: string; // For HTTP servers, the header placeholder
}

export interface ParsedConfig {
  servers: ParsedServer[];
  format: 'claude' | 'vscode' | 'unknown';
}

// ============================================================================
// Claude Desktop Format Parser
// ============================================================================

interface ClaudeServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface ClaudeConfig {
  mcpServers?: Record<string, ClaudeServerConfig>;
}

function parseClaudeFormat(config: ClaudeConfig): ParsedServer[] {
  const servers: ParsedServer[] = [];
  
  if (!config.mcpServers) return servers;
  
  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    const server: ParsedServer = {
      id: generateServerId(name),
      name,
      type: 'stdio',
      command: serverConfig.command,
      args: serverConfig.args || [],
      env: serverConfig.env || {},
      requiredInputs: [],
    };
    
    // Extract required inputs from env vars that look like placeholders
    // or common secret patterns (API_KEY, TOKEN, SECRET, etc.)
    if (serverConfig.env) {
      for (const [key, value] of Object.entries(serverConfig.env)) {
        // Check if it's a placeholder or looks like a secret
        const isPlaceholder = value.startsWith('${') || value === '' || value === 'your_token';
        const looksLikeSecret = /key|token|secret|password|auth/i.test(key);
        
        if (isPlaceholder || (looksLikeSecret && value.length < 50)) {
          server.requiredInputs.push({
            id: key.toLowerCase().replace(/_/g, '-'),
            description: humanizeName(key),
            isSecret: true,
            envVar: key,
          });
        }
      }
    }
    
    servers.push(server);
  }
  
  return servers;
}

// ============================================================================
// VS Code Format Parser
// ============================================================================

interface VSCodeServerConfig {
  type?: 'http' | 'sse' | 'stdio';
  url?: string;
  headers?: Record<string, string>;
  command?: string | string[];
  args?: string[];
  env?: Record<string, string>;
}

interface VSCodeInput {
  type: 'promptString' | 'pickString';
  id: string;
  description?: string;
  password?: boolean;
  default?: string;
}

interface VSCodeConfig {
  servers?: Record<string, VSCodeServerConfig>;
  mcpServers?: Record<string, VSCodeServerConfig>; // Some versions use this
  inputs?: VSCodeInput[];
}

function parseVSCodeFormat(config: VSCodeConfig): ParsedServer[] {
  const servers: ParsedServer[] = [];
  const inputs = config.inputs || [];
  
  // Support both 'servers' and 'mcpServers' keys
  const serverConfigs = config.servers || config.mcpServers || {};
  
  for (const [name, serverConfig] of Object.entries(serverConfigs)) {
    const serverType = serverConfig.type || 'stdio';
    
    if (serverType === 'http' || serverType === 'sse') {
      // HTTP/SSE server
      const server: ParsedServer = {
        id: generateServerId(name),
        name,
        type: serverType,
        url: serverConfig.url,
        headers: {},
        requiredInputs: [],
      };
      
      // Process headers and extract input placeholders
      if (serverConfig.headers) {
        for (const [headerName, headerValue] of Object.entries(serverConfig.headers)) {
          // Check for ${input:xxx} placeholders
          const inputMatch = headerValue.match(/\$\{input:([^}]+)\}/);
          if (inputMatch) {
            const inputId = inputMatch[1];
            const input = inputs.find(i => i.id === inputId);
            
            server.requiredInputs.push({
              id: inputId,
              description: input?.description || humanizeName(inputId),
              isSecret: input?.password ?? true,
              headerVar: headerName,
            });
            
            // Store the header pattern for later substitution
            server.headers![headerName] = headerValue;
          } else {
            // Static header value
            server.headers![headerName] = headerValue;
          }
        }
      }
      
      servers.push(server);
    } else {
      // Stdio server
      const command = Array.isArray(serverConfig.command) 
        ? serverConfig.command[0] 
        : serverConfig.command;
      const commandArgs = Array.isArray(serverConfig.command)
        ? serverConfig.command.slice(1)
        : [];
      
      const server: ParsedServer = {
        id: generateServerId(name),
        name,
        type: 'stdio',
        command,
        args: [...commandArgs, ...(serverConfig.args || [])],
        env: serverConfig.env || {},
        requiredInputs: [],
      };
      
      // Extract required inputs from env vars
      if (serverConfig.env) {
        for (const [key, value] of Object.entries(serverConfig.env)) {
          const inputMatch = value.match(/\$\{input:([^}]+)\}/);
          if (inputMatch) {
            const inputId = inputMatch[1];
            const input = inputs.find(i => i.id === inputId);
            
            server.requiredInputs.push({
              id: inputId,
              description: input?.description || humanizeName(inputId),
              isSecret: input?.password ?? true,
              envVar: key,
            });
          }
        }
      }
      
      servers.push(server);
    }
  }
  
  return servers;
}

// ============================================================================
// Main Parser
// ============================================================================

/**
 * Parse an MCP configuration JSON string.
 * Automatically detects Claude Desktop or VS Code format.
 */
export function parseMcpConfig(jsonString: string): ParsedConfig {
  let config: unknown;
  
  try {
    config = JSON.parse(jsonString);
  } catch (e) {
    throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  
  if (typeof config !== 'object' || config === null) {
    throw new Error('Configuration must be a JSON object');
  }
  
  const configObj = config as Record<string, unknown>;
  
  // Detect format
  if ('mcpServers' in configObj && !('servers' in configObj)) {
    // Claude Desktop format
    log('[ConfigParser] Detected Claude Desktop format');
    return {
      servers: parseClaudeFormat(configObj as ClaudeConfig),
      format: 'claude',
    };
  }
  
  if ('servers' in configObj || ('mcpServers' in configObj && 'inputs' in configObj)) {
    // VS Code format (has 'servers' key, or mcpServers with inputs)
    log('[ConfigParser] Detected VS Code format');
    return {
      servers: parseVSCodeFormat(configObj as VSCodeConfig),
      format: 'vscode',
    };
  }
  
  throw new Error('Unrecognized configuration format. Expected Claude Desktop or VS Code MCP config.');
}

/**
 * Parse a VS Code install URL.
 * Format: https://insiders.vscode.dev/redirect/mcp/install?name=xxx&config=URL_ENCODED_JSON
 */
export function parseVSCodeInstallUrl(url: string): ParsedServer | null {
  try {
    const urlObj = new URL(url);
    
    // Check if it's a VS Code install URL
    if (!urlObj.pathname.includes('/mcp/install')) {
      return null;
    }
    
    const name = urlObj.searchParams.get('name');
    const configStr = urlObj.searchParams.get('config');
    
    if (!name || !configStr) {
      return null;
    }
    
    const config = JSON.parse(configStr) as VSCodeServerConfig;
    
    const server: ParsedServer = {
      id: generateServerId(name),
      name,
      type: config.type === 'sse' ? 'sse' : (config.type === 'http' || config.url) ? 'http' : 'stdio',
      url: config.url,
      headers: config.headers || {},
      requiredInputs: [],
    };
    
    // Extract any input placeholders from headers
    if (config.headers) {
      for (const [headerName, headerValue] of Object.entries(config.headers)) {
        const inputMatch = headerValue.match(/\$\{input:([^}]+)\}/);
        if (inputMatch) {
          const inputId = inputMatch[1];
          server.requiredInputs.push({
            id: inputId,
            description: humanizeName(inputId),
            isSecret: true,
            headerVar: headerName,
          });
        }
      }
    }
    
    log(`[ConfigParser] Parsed VS Code install URL: ${name}`);
    return server;
    
  } catch (e) {
    log(`[ConfigParser] Failed to parse VS Code URL: ${e}`);
    return null;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function generateServerId(name: string): string {
  // Create a URL-safe ID from the name
  const base = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
  // Add some uniqueness
  const suffix = Date.now().toString(36).slice(-4);
  return `${base}-${suffix}`;
}

function humanizeName(key: string): string {
  // Convert SNAKE_CASE or camelCase to human readable
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, c => c.toUpperCase());
}

