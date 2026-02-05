/**
 * Agent capabilities handler.
 */

import type { RequestContext, ResponseSender } from './router-types';
import { getPermissionStatus } from '../../policy/permissions';
import { getRuntimeCapabilities } from '../../llm/provider-registry';
import { listServersWithStatus } from '../../mcp/host';

/**
 * Handle agent.capabilities() - Returns comprehensive capabilities report.
 * This is the unified way to discover what the agent can do.
 */
export async function handleAgentCapabilities(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  try {
    // Get permission status
    const permStatus = await getPermissionStatus(ctx.origin, ctx.tabId);
    
    // Get runtime capabilities (LLM info)
    const runtimeCaps = await getRuntimeCapabilities();
    
    // Get available tools
    let toolCount = 0;
    const serverIds: string[] = [];
    try {
      const servers = await listServersWithStatus();
      for (const server of servers) {
        if (server.running) {
          serverIds.push(server.id);
          toolCount += server.tools?.length || 0;
        }
      }
    } catch {
      // MCP not available
    }
    
    // Harbor exposes all features - Web Agents API extension enforces feature flags
    const browserInteractionEnabled = true;
    const screenshotsEnabled = true;
    const browserControlEnabled = true;
    const multiAgentEnabled = true;
    
    // Determine best runtime
    let bestRuntime: 'firefox' | 'chrome' | 'harbor' | null = null;
    if (runtimeCaps.firefox?.available && runtimeCaps.firefox.hasWllama) {
      bestRuntime = 'firefox';
    } else if (runtimeCaps.chrome?.available) {
      bestRuntime = 'chrome';
    } else if (runtimeCaps.harbor?.bridgeConnected) {
      bestRuntime = 'harbor';
    }
    
    // Build the capabilities report
    const report = {
      version: '1.0.0',
      
      llm: {
        available: runtimeCaps.harbor?.bridgeConnected || 
                   runtimeCaps.firefox?.available || 
                   runtimeCaps.chrome?.available || false,
        streaming: true, // All our providers support streaming
        toolCalling: runtimeCaps.harbor?.bridgeConnected || 
                     runtimeCaps.firefox?.supportsTools || 
                     runtimeCaps.chrome?.supportsTools || false,
        providers: runtimeCaps.harbor?.providers || [],
        bestRuntime,
      },
      
      tools: {
        available: toolCount > 0,
        count: toolCount,
        servers: serverIds,
      },
      
      browser: {
        readActiveTab: true, // Always supported
        interact: browserInteractionEnabled,
        screenshot: screenshotsEnabled,
        // Extension 2 features (requires browserControl flag)
        navigate: browserControlEnabled,
        readTabs: browserControlEnabled,
        createTabs: browserControlEnabled,
      },
      
      // Extension 3 features (requires multiAgent flag)
      agents: {
        register: multiAgentEnabled,
        discover: multiAgentEnabled,
        invoke: multiAgentEnabled,
        message: multiAgentEnabled,
        crossOrigin: multiAgentEnabled,
        remote: multiAgentEnabled,
      },
      
      permissions: {
        llm: {
          prompt: permStatus.scopes['model:prompt'] || 'not-granted',
          tools: permStatus.scopes['model:tools'] || 'not-granted',
          list: permStatus.scopes['model:list'] || 'not-granted',
        },
        mcp: {
          list: permStatus.scopes['mcp:tools.list'] || 'not-granted',
          call: permStatus.scopes['mcp:tools.call'] || 'not-granted',
          register: permStatus.scopes['mcp:servers.register'] || 'not-granted',
        },
        browser: {
          read: permStatus.scopes['browser:activeTab.read'] || 'not-granted',
          interact: permStatus.scopes['browser:activeTab.interact'] || 'not-granted',
          screenshot: permStatus.scopes['browser:activeTab.screenshot'] || 'not-granted',
          // Extension 2 scopes
          navigate: permStatus.scopes['browser:navigate'] || 'not-granted',
          tabsRead: permStatus.scopes['browser:tabs.read'] || 'not-granted',
          tabsCreate: permStatus.scopes['browser:tabs.create'] || 'not-granted',
        },
        // Extension 3 scopes
        agents: {
          register: permStatus.scopes['agents:register'] || 'not-granted',
          discover: permStatus.scopes['agents:discover'] || 'not-granted',
          invoke: permStatus.scopes['agents:invoke'] || 'not-granted',
          message: permStatus.scopes['agents:message'] || 'not-granted',
          crossOrigin: permStatus.scopes['agents:crossOrigin'] || 'not-granted',
          remote: permStatus.scopes['agents:remote'] || 'not-granted',
        },
        web: {
          fetch: permStatus.scopes['web:fetch'] || 'not-granted',
        },
      },
      
      allowedTools: permStatus.allowedTools || [],
      
      features: {
        browserInteraction: browserInteractionEnabled,
        screenshots: screenshotsEnabled,
        // Extension 2 & 3 feature flags
        browserControl: browserControlEnabled,
        multiAgent: multiAgentEnabled,
        remoteTabs: browserControlEnabled, // Part of browserControl
        webFetch: browserControlEnabled,   // Part of browserControl
      },
    };
    
    sender.sendResponse({
      id: ctx.id,
      ok: true,
      result: report,
    });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Failed to get capabilities',
      },
    });
  }
}
