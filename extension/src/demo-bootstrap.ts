/**
 * Demo Bootstrap Script
 * 
 * Provides window.ai and window.agent APIs for the chat demo.
 * Communicates with the bridge via the extension's native messaging.
 */

// Make this a module to avoid global scope conflicts
export {};

import { browserAPI } from './browser-compat';

// Types
interface TextSession {
  sessionId: string;
  prompt(input: string, tools?: ToolDescriptor[]): Promise<string>;
  promptStreaming(input: string): AsyncIterable<{ type: string; token?: string }>;
  destroy(): Promise<void>;
}

interface ToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
  serverId?: string;
}

// Bridge RPC helper - goes through extension message passing
async function bridgeRequest<T>(method: string, params?: unknown): Promise<T> {
  // Use browserAPI.runtime.sendMessage to go through the background script
  const response = await browserAPI.runtime.sendMessage({
    type: 'bridge_rpc',
    method,
    params,
  }) as { ok: boolean; result?: T; error?: string };
  
  if (!response.ok) {
    throw new Error(response.error || 'Bridge request failed');
  }
  return response.result as T;
}

// Session counter for IDs
let sessionCounter = 0;

/**
 * Check if a model supports native tool calling.
 * 
 * Native tool calling means the model can receive tools in the API request
 * and return structured tool_calls in the response.
 * 
 * Based on chat orchestrator logic
 */
function modelSupportsNativeTools(modelId?: string): boolean {
  if (!modelId) return false;
  
  const modelLower = modelId.toLowerCase();
  
  // Parse model ID - format is usually "provider:model:tag" or just "model"
  // e.g., "ollama:llama3.2:latest" or "openai:gpt-4o"
  const parts = modelId.split(':');
  const provider = parts.length >= 2 ? parts[0].toLowerCase() : null;
  const model = parts.length >= 2 ? parts.slice(1).join(':').toLowerCase() : modelLower;
  
  // Cloud providers with native tool support
  const nativeToolProviders = ['openai', 'anthropic', 'mistral', 'groq'];
  if (provider && nativeToolProviders.includes(provider)) {
    return true;
  }
  
  // Ollama - only specific models support native tool calling
  // Note: mistral:7b-instruct (aka mistral:latest) does NOT support native tools
  if (provider === 'ollama') {
    const ollamaModelsWithNativeTools = [
      'llama3.1', 'llama3.2', 'llama3.3',  // Llama 3.1+ has native tool support
      'mistral-nemo', 'mistral-large',      // Newer Mistral models (not 7b-instruct)
      'qwen2.5',                            // Qwen 2.5 has tool support
      'command-r',                          // Command R models
    ];
    return ollamaModelsWithNativeTools.some(m => model.includes(m));
  }
  
  return false;
}

// Create the ai API
const ai = {
  async createTextSession(options?: { systemPrompt?: string; temperature?: number }): Promise<TextSession> {
    const sessionId = `demo-${++sessionCounter}`;
    const history: Array<{ role: string; content: string }> = [];
    
    if (options?.systemPrompt) {
      history.push({ role: 'system', content: options.systemPrompt });
    }
    
    return {
      sessionId,
      
      async prompt(input: string, promptTools?: ToolDescriptor[]): Promise<string> {
        history.push({ role: 'user', content: input });
        
        // Get the default model from config, or first configured model
        let model: string | undefined;
        try {
          // First try configured models
          const configuredRes = await bridgeRequest<{ models: Array<{ model_id: string; is_default: boolean }> }>('llm.list_configured_models');
          const defaultModel = configuredRes.models?.find(m => m.is_default);
          if (defaultModel) {
            model = defaultModel.model_id;
          } else if (configuredRes.models?.length > 0) {
            model = configuredRes.models[0].model_id;
          }
          
          // Fallback to legacy default_model
          if (!model) {
            const config = await bridgeRequest<{ default_model?: string }>('llm.get_config');
            model = config.default_model;
          }
          
          // If still no model, throw a clear error
          if (!model) {
            throw Object.assign(
              new Error('No LLM model configured. Please add an LLM provider (like Ollama) in the Harbor sidebar.'),
              { code: 'ERR_NO_MODEL' }
            );
          }
        } catch (err) {
          // Re-throw if it's our specific error
          if (err && typeof err === 'object' && 'code' in err && err.code === 'ERR_NO_MODEL') {
            throw err;
          }
          // Otherwise fall back to letting the bridge decide (may still fail)
        }
        
        // Build request params
        const requestParams: {
          messages: typeof history;
          model?: string;
          system_prompt?: string;
          tools?: Array<{ name: string; description?: string; input_schema: unknown }>;
        } = {
          messages: history,
          model,
        };
        
        // Add system prompt if provided
        if (options?.systemPrompt) {
          requestParams.system_prompt = options.systemPrompt;
        }
        
        // For models with native tool calling, pass tools directly to the bridge
        if (promptTools && promptTools.length > 0 && model && modelSupportsNativeTools(model)) {
          requestParams.tools = promptTools.map(t => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema || { type: 'object', properties: {} },
          }));
          console.log(`[demo-bootstrap] Passing ${requestParams.tools.length} tools to native tool calling model`);
        }
        
        // Bridge returns CompletionResponse in OpenAI-compatible format
        const result = await bridgeRequest<{ 
          content?: string; 
          message?: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
          choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }; finish_reason?: string }>;
        }>('llm.chat', requestParams);
        
        // Check for native tool calls
        const toolCalls = result.choices?.[0]?.message?.tool_calls || result.message?.tool_calls;
        if (toolCalls && toolCalls.length > 0) {
          // Return the tool call as JSON so it can be parsed
          const tc = toolCalls[0];
          const toolCallJson = {
            name: tc.function.name,
            parameters: JSON.parse(tc.function.arguments || '{}'),
          };
          console.log('[demo-bootstrap] Native tool call detected:', toolCallJson);
          const content = JSON.stringify(toolCallJson);
          history.push({ role: 'assistant', content });
          return content;
        }
        
        // Handle different response formats:
        // 1. OpenAI format: choices[0].message.content
        // 2. Simple format: content
        // 3. Message format: message.content
        const content = result.choices?.[0]?.message?.content 
          || result.content 
          || result.message?.content;
          
        if (!content) {
          console.error('[demo-bootstrap] Unexpected LLM response format:', result);
          throw new Error('LLM returned empty or unexpected response');
        }
        
        history.push({ role: 'assistant', content });
        return content;
      },
      
      async *promptStreaming(input: string): AsyncIterable<{ type: string; token?: string }> {
        // For now, fall back to non-streaming
        const response = await (this as TextSession).prompt(input);
        
        // Simulate streaming by yielding word by word
        const words = response.split(/(\s+)/);
        for (const word of words) {
          if (word) {
            yield { type: 'token', token: word };
            await new Promise(r => setTimeout(r, 20));
          }
        }
        yield { type: 'done' };
      },
      
      async destroy(): Promise<void> {
        // Nothing to clean up
      },
    };
  },
  
  providers: {
    async list(): Promise<Array<{ id: string; name: string; available: boolean; isDefault: boolean }>> {
      try {
        const result = await bridgeRequest<{ providers: Array<{ id: string; name: string; configured: boolean; is_default?: boolean }> }>('llm.list_providers');
        return result.providers.map(p => ({
          id: p.id,
          name: p.name,
          available: p.configured,
          isDefault: p.is_default || false,
        }));
      } catch {
        return [];
      }
    },
    
    async getActive(): Promise<{ provider: string | null; model: string | null }> {
      try {
        const result = await bridgeRequest<{ default_model?: string; default_provider?: string }>('llm.get_config');
        const parts = result.default_model?.split(':') || [];
        return {
          provider: result.default_provider || parts[0] || null,
          model: parts[1] || null,
        };
      } catch {
        return { provider: null, model: null };
      }
    },
  },
};

// Create the agent API
const agent = {
  async requestPermissions(_options: { scopes: string[]; reason?: string }): Promise<{ granted: boolean; scopes: Record<string, string> }> {
    // In demo context, permissions are always granted
    return {
      granted: true,
      scopes: {
        'model:prompt': 'granted-always',
        'model:tools': 'granted-always',
        'mcp:tools.list': 'granted-always',
        'mcp:tools.call': 'granted-always',
      },
    };
  },
  
  permissions: {
    async list(): Promise<{ origin: string; scopes: Record<string, string> }> {
      return {
        origin: 'extension',
        scopes: {
          'model:prompt': 'granted-always',
          'model:tools': 'granted-always',
          'mcp:tools.list': 'granted-always',
          'mcp:tools.call': 'granted-always',
        },
      };
    },
  },
  
  tools: {
    async list(): Promise<ToolDescriptor[]> {
      try {
        // Get servers from the background script via browserAPI.runtime
        const response = await browserAPI.runtime.sendMessage({ type: 'sidebar_get_servers' }) as {
          ok: boolean;
          servers?: Array<{ id: string; name: string; running: boolean; tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> }>;
        };
        
        if (!response.ok || !response.servers) {
          return [];
        }
        
        const tools: ToolDescriptor[] = [];
        for (const server of response.servers) {
          // Only include tools from RUNNING servers
          if (server.running && server.tools) {
            for (const tool of server.tools) {
              tools.push({
                name: `${server.id}/${tool.name}`,
                description: tool.description,
                inputSchema: tool.inputSchema,
                serverId: server.id,
              });
            }
          }
        }
        return tools;
      } catch (err) {
        console.error('[Demo] Failed to list tools:', err);
        return [];
      }
    },
    
    async call(options: { tool: string; args: Record<string, unknown> }): Promise<unknown> {
      const [serverId, toolName] = options.tool.split('/');
      if (!serverId || !toolName) {
        throw new Error('Invalid tool name format. Expected: serverId/toolName');
      }
      
      const response = await browserAPI.runtime.sendMessage({
        type: 'sidebar_call_tool',
        serverId,
        toolName,
        args: options.args,
      }) as { ok: boolean; result?: unknown; error?: string };
      
      if (!response.ok) {
        throw new Error(response.error || 'Tool call failed');
      }
      
      return response.result;
    },
  },
  
  browser: {
    activeTab: {
      async readability(): Promise<{ url: string; title: string; text: string }> {
        // Get active tab content
        const tabs = await browserAPI.tabs.query({ active: true, currentWindow: true });
        const tab = tabs[0];
        
        if (!tab?.id || !tab.url) {
          throw new Error('No active tab found');
        }
        
        if (!tab.url.startsWith('http://') && !tab.url.startsWith('https://')) {
          throw new Error('Cannot read from this type of page');
        }
        
        const results = await browserAPI.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const clone = document.cloneNode(true) as Document;
            ['script', 'style', 'noscript', 'nav', 'footer', 'header'].forEach(sel => {
              clone.querySelectorAll(sel).forEach(el => el.remove());
            });
            const main = clone.querySelector('main, article, .content') || clone.body;
            let text = main?.textContent || '';
            text = text.replace(/\s+/g, ' ').trim().slice(0, 10000);
            return { url: window.location.href, title: document.title, text };
          },
        });
        
        if (!results?.[0]?.result) {
          throw new Error('Failed to extract content');
        }
        
        return results[0].result;
      },
    },
  },
  
  run(options: { task: string; tools?: string[]; maxToolCalls?: number; useAllTools?: boolean }): AsyncIterable<{
    type: 'status' | 'tool_call' | 'tool_result' | 'token' | 'final' | 'error';
    message?: string;
    tool?: string;
    args?: unknown;
    result?: unknown;
    token?: string;
    output?: string;
    error?: { code: string; message: string };
  }> {
    const { task, maxToolCalls = 5 } = options;
    
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'status', message: 'Starting agent...' };
        
        try {
          // Get available tools
          const tools = await agent.tools.list();
          yield { type: 'status', message: `Found ${tools.length} tools` };
          
          // Get the active model to determine if it supports native tool calling
          let activeModel: string | undefined;
          try {
            const configuredRes = await bridgeRequest<{ models: Array<{ model_id: string; is_default: boolean }> }>('llm.list_configured_models');
            const defaultModel = configuredRes.models?.find(m => m.is_default);
            activeModel = defaultModel?.model_id || configuredRes.models?.[0]?.model_id;
          } catch {
            // Fall back to legacy
            try {
              const config = await bridgeRequest<{ default_model?: string }>('llm.get_config');
              activeModel = config.default_model;
            } catch {
              // Ignore
            }
          }
          
          // Build system prompt based on whether model supports native tool calling
          // Build system prompt based on model capabilities
          let systemPrompt: string;
          const useNativeTools = modelSupportsNativeTools(activeModel);
          console.log(`[Demo] Active model: ${activeModel}, native tools: ${useNativeTools}`);
          
          if (tools.length === 0) {
            systemPrompt = 'You are a helpful assistant.';
          } else if (useNativeTools) {
            // For models with native tool support (llama3.1+, mistral-nemo, etc.)
            systemPrompt = `You are a helpful assistant with access to tools.

## TOOL SELECTION STRATEGY
1. Before calling any tool, carefully analyze what the user is asking for
2. Call a tool ONLY when you need information or capabilities you don't have
3. Choose the most appropriate tool based on the user's actual intent
4. Most requests need at most ONE tool call

## ARGUMENT EXTRACTION - CRITICAL
When determining tool arguments:
1. Use EXACTLY what the user provides - never invent or assume values
2. If the user references "this", "that", or similar pronouns, look for the actual content in their message or conversation history
3. If the user's request is ambiguous or missing required information, ASK for clarification instead of guessing
4. Do NOT use placeholder or example data - only use actual values from the user

Examples of CORRECT behavior:
- User: "reverse hello world" → Use "hello world" as the argument
- User: "what time is it?" → Call time tool with no made-up arguments
- User: "reverse this" (with no text provided) → Ask "What text would you like me to reverse?"

Examples of INCORRECT behavior:
- User: "reverse this string" → Using "this is a test string" (WRONG - made up data)
- User: "translate this" → Using example text (WRONG - should ask what to translate)

## RESPONSE RULES
1. After receiving a tool result, RESPOND directly to the user
2. Do NOT call additional tools unless the user's request explicitly requires it
3. Synthesize tool results into a clear, helpful answer

After getting a result, answer the user directly. Do NOT call more tools in a loop.`;
          } else {
            // For models WITHOUT native tool support (mistral 7b, llamafile, etc.)
            // Need explicit instructions on HOW to format tool calls as JSON
            const toolList = tools.map(t => {
              const schema = t.inputSchema as Record<string, unknown> | undefined;
              const properties = schema?.properties as Record<string, { description?: string }> | undefined;
              const required = schema?.required as string[] | undefined;
              
              let paramInfo = '';
              if (properties) {
                const params = Object.entries(properties).map(([name, prop]) => {
                  const isRequired = required?.includes(name);
                  return `${name}${isRequired ? ' (required)' : ''}: ${prop.description || 'no description'}`;
                });
                if (params.length > 0) {
                  paramInfo = `\n  Parameters: ${params.join('; ')}`;
                }
              }
              
              return `- ${t.name}: ${t.description || 'No description'}${paramInfo}`;
            }).join('\n');
            
            systemPrompt = `You are a helpful assistant with access to tools.

## Available Tools
${toolList}

## TOOL SELECTION STRATEGY
1. Before calling any tool, carefully analyze what the user is asking for
2. Call a tool ONLY when you need information or capabilities you don't have
3. Choose the most appropriate tool based on the user's actual intent
4. Most requests need at most ONE tool call

## ARGUMENT EXTRACTION - CRITICAL
When determining tool arguments:
1. Use EXACTLY what the user provides - never invent or assume values
2. If the user references "this", "that", or similar pronouns, look for the actual content in their message or conversation history
3. If the user's request is ambiguous or missing required information, ASK for clarification instead of guessing
4. Do NOT use placeholder or example data - only use actual values from the user

CORRECT: User says "reverse hello world" → parameters: {"text": "hello world"}
INCORRECT: User says "reverse this string" → parameters: {"text": "this is a test string"} (WRONG - made up data)

If the user doesn't provide the actual data needed, respond with a question asking for it.

## How to Call a Tool
Output ONLY this JSON (nothing else):
{"name": "tool_name", "parameters": {}}

## RESPONSE RULES
1. After receiving tool results, RESPOND to the user in plain text
2. Do NOT call more tools unless explicitly needed
3. Do NOT call the same tool twice
4. Synthesize results into a clear answer

## Example Flow
User: "What time is it?"
You: {"name": "time-wasm/time.now", "parameters": {}}
[Tool returns: "2024-01-15T10:30:00Z"]
You: The current time is 10:30 AM UTC on January 15, 2024.

After getting a result, answer the user directly. Do NOT output another JSON tool call.`;
          }
          
          // Create session with system prompt
          const session = await ai.createTextSession({ systemPrompt });
          
          // Build tool name to serverId mapping
          const toolMap: Record<string, string> = {};
          for (const t of tools) {
            toolMap[t.name] = t.serverId || '';
          }
          
          let iterations = 0;
          let currentMessage = task;
          let finalOutput = '';
          const calledTools = new Set<string>(); // Track which tools have been called
          
          while (iterations < maxToolCalls) {
            iterations++;
            yield { type: 'status', message: `Processing (iteration ${iterations})...` };
            
            let response: string;
            try {
              // Always pass tools - allow chaining different tools
              response = await session.prompt(currentMessage, useNativeTools ? tools : undefined);
            } catch (err) {
              const errorCode = (err && typeof err === 'object' && 'code' in err) ? (err as { code: string }).code : 'ERR_LLM_FAILED';
              const errorMsg = err instanceof Error ? err.message : 'LLM request failed';
              yield { type: 'error', error: { code: errorCode, message: errorMsg } };
              return;
            }
            
            if (!response) {
              yield { type: 'error', error: { code: 'ERR_EMPTY_RESPONSE', message: 'LLM returned empty response' } };
              return;
            }
            
            // Try to parse tool call from response
            const toolCall = parseToolCallFromText(response, Object.keys(toolMap));
            
            if (toolCall) {
              // Check if the tool exists
              if (toolCall.toolNotFound) {
                console.log(`[demo-bootstrap] Model tried to call non-existent tool: ${toolCall.requestedTool}`);
                const availableToolNames = Object.keys(toolMap).map(t => t.split('/').pop()).join(', ');
                currentMessage = `Error: The tool "${toolCall.requestedTool}" does not exist. Available tools are: ${availableToolNames}. Please provide a direct answer to the user.`;
                continue;
              }
              
              const { name: toolName, parameters: args } = toolCall;
              const shortToolName = toolName.split('/').pop() || toolName;
              
              // Prevent calling the same tool twice (allow different tools)
              if (calledTools.has(toolName)) {
                console.log(`[demo-bootstrap] Preventing repeat call to: ${toolName}`);
                // Force a response by prompting WITHOUT tools
                try {
                  const forceMessage = `You already have the result from "${shortToolName}". Now answer the user's question: "${task}"

Respond in plain text only.`;
                  const forcedResponse = await session.prompt(forceMessage, undefined); // No tools!
                  if (forcedResponse && !parseToolCallFromText(forcedResponse, Object.keys(toolMap))) {
                    finalOutput = forcedResponse;
                    break;
                  }
                } catch {
                  // Fall through to continue
                }
                continue;
              }
              calledTools.add(toolName);
              
              yield { type: 'tool_call', tool: toolName, args };
              
              try {
                const result = await agent.tools.call({ tool: toolName, args });
                yield { type: 'tool_result', tool: toolName, result };
                
                // Extract text content from MCP result format
                let resultText: string;
                if (result && typeof result === 'object' && 'content' in result) {
                  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
                  resultText = content
                    .filter(c => c.type === 'text' && c.text)
                    .map(c => c.text)
                    .join('\n');
                } else {
                  resultText = JSON.stringify(result, null, 2);
                }
                
                // Clear instruction to respond, not call more tools
                currentMessage = `Tool "${toolName.split('/').pop()}" returned: ${resultText}

Now respond directly to the user's original question: "${task}"

IMPORTANT: Provide your answer in plain text. Do NOT call any more tools.`;
              } catch (err) {
                const errorMsg = err instanceof Error ? err.message : 'Unknown error';
                yield { type: 'tool_result', tool: toolName, error: { code: 'ERR_TOOL_FAILED', message: errorMsg } };
                currentMessage = `Tool ${toolName} failed: ${errorMsg}. Please provide the best answer you can without using tools.`;
              }
            } else {
              // No tool call detected, this is the final response
              finalOutput = response;
              break;
            }
          }
          
          // If we exhausted iterations without a final response, use the last response
          if (!finalOutput && iterations >= maxToolCalls) {
            finalOutput = "I apologize, but I wasn't able to complete the task within the allowed steps. Based on my attempts, I may need more information or a simpler request.";
          }
          
          // Stream the final output
          const words = finalOutput.split(/(\s+)/);
          for (const word of words) {
            if (word) {
              yield { type: 'token', token: word };
              await new Promise(r => setTimeout(r, 15));
            }
          }
          
          yield { type: 'final', output: finalOutput };
          await session.destroy();
          
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : 'Unknown error';
          yield { type: 'error', error: { code: 'ERR_INTERNAL', message: errorMsg } };
        }
      },
    };
  },
};

/**
 * Result of parsing a tool call from text.
 */
interface ParsedToolCall {
  name: string;
  parameters: Record<string, unknown>;
  /** If true, a tool call was detected but the tool doesn't exist */
  toolNotFound?: boolean;
  /** The original tool name that was requested (if not found) */
  requestedTool?: string;
}

/**
 * Parse a tool call from LLM text response.
 * Handles JSON format: {"name": "tool_name", "parameters": {...}}
 */
function parseToolCallFromText(
  text: string, 
  availableTools: string[]
): ParsedToolCall | null {
  if (!text) return null;
  
  // Clean up the text - remove markdown code blocks if present
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  
  // Try to find JSON object in the response
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    
    // Check for {"name": "...", "parameters": {...}} format
    if (parsed.name && typeof parsed.name === 'string') {
      const toolName = parsed.name;
      const params = parsed.parameters || parsed.arguments || parsed.args || {};
      
      // If no tools available, return as not found
      if (availableTools.length === 0) {
        return {
          name: toolName,
          parameters: params,
          toolNotFound: true,
          requestedTool: toolName,
        };
      }
      
      // Check if this tool exists (try exact match first, then with server prefix)
      let matchedTool = availableTools.find(t => t === toolName);
      if (!matchedTool) {
        // Try matching by suffix (tool name without server prefix)
        matchedTool = availableTools.find(t => t.endsWith('/' + toolName) || t.endsWith('__' + toolName));
      }
      if (!matchedTool) {
        // Try matching the short name (after the last /)
        const shortName = toolName.split('/').pop() || toolName;
        matchedTool = availableTools.find(t => {
          const tShort = t.split('/').pop() || t;
          return tShort === shortName;
        });
      }
      if (!matchedTool) {
        // Try matching by partial name
        matchedTool = availableTools.find(t => t.includes(toolName) || toolName.includes(t.split('/').pop() || ''));
      }
      
      if (matchedTool) {
        return {
          name: matchedTool,
          parameters: params,
        };
      } else {
        // Tool call detected but tool doesn't exist
        console.log(`[demo-bootstrap] Tool call detected for non-existent tool: ${toolName}`);
        console.log(`[demo-bootstrap] Available tools: ${availableTools.join(', ')}`);
        return {
          name: toolName,
          parameters: params,
          toolNotFound: true,
          requestedTool: toolName,
        };
      }
    }
    
    // Also check for {"tool": "...", "args": {...}} format
    if (parsed.tool && typeof parsed.tool === 'string') {
      const toolName = parsed.tool;
      const params = parsed.args || parsed.arguments || parsed.parameters || {};
      
      const matchedTool = availableTools.find(t => 
        t === toolName || t.includes(toolName)
      );
      
      if (matchedTool) {
        return {
          name: matchedTool,
          parameters: params,
        };
      } else {
        return {
          name: toolName,
          parameters: params,
          toolNotFound: true,
          requestedTool: toolName,
        };
      }
    }
  } catch {
    // JSON parse failed, not a tool call
  }
  
  return null;
}

// Make APIs available globally
(window as any).ai = ai;
(window as any).agent = agent;

// Dispatch event to signal APIs are ready
window.dispatchEvent(new CustomEvent('harbor-provider-ready'));

console.log('[Harbor Demo] APIs ready:', {
  'window.ai': typeof (window as any).ai !== 'undefined',
  'window.agent': typeof (window as any).agent !== 'undefined',
});
