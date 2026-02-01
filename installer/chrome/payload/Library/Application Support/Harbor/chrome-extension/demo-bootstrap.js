// src/browser-compat.ts
var browserAPI = typeof browser !== "undefined" ? browser : chrome;

// src/demo-bootstrap.ts
async function bridgeRequest(method, params) {
  const response = await browserAPI.runtime.sendMessage({
    type: "bridge_rpc",
    method,
    params
  });
  if (!response.ok) {
    throw new Error(response.error || "Bridge request failed");
  }
  return response.result;
}
var sessionCounter = 0;
function modelSupportsNativeTools(modelId) {
  if (!modelId) return false;
  const modelLower = modelId.toLowerCase();
  const parts = modelId.split(":");
  const provider = parts.length >= 2 ? parts[0].toLowerCase() : null;
  const model = parts.length >= 2 ? parts.slice(1).join(":").toLowerCase() : modelLower;
  const nativeToolProviders = ["openai", "anthropic", "mistral", "groq"];
  if (provider && nativeToolProviders.includes(provider)) {
    return true;
  }
  if (provider === "ollama") {
    const ollamaModelsWithNativeTools = [
      "llama3.1",
      "llama3.2",
      "llama3.3",
      // Llama 3.1+ has native tool support
      "mistral-nemo",
      "mistral-large",
      // Newer Mistral models (not 7b-instruct)
      "qwen2.5",
      // Qwen 2.5 has tool support
      "command-r"
      // Command R models
    ];
    return ollamaModelsWithNativeTools.some((m) => model.includes(m));
  }
  return false;
}
var ai = {
  async createTextSession(options) {
    const sessionId = `demo-${++sessionCounter}`;
    const history = [];
    if (options?.systemPrompt) {
      history.push({ role: "system", content: options.systemPrompt });
    }
    return {
      sessionId,
      async prompt(input, promptTools) {
        history.push({ role: "user", content: input });
        let model;
        try {
          const configuredRes = await bridgeRequest("llm.list_configured_models");
          const defaultModel = configuredRes.models?.find((m) => m.is_default);
          if (defaultModel) {
            model = defaultModel.model_id;
          } else if (configuredRes.models?.length > 0) {
            model = configuredRes.models[0].model_id;
          }
          if (!model) {
            const config = await bridgeRequest("llm.get_config");
            model = config.default_model;
          }
          if (!model) {
            throw Object.assign(
              new Error("No LLM model configured. Please add an LLM provider (like Ollama) in the Harbor sidebar."),
              { code: "ERR_NO_MODEL" }
            );
          }
        } catch (err) {
          if (err && typeof err === "object" && "code" in err && err.code === "ERR_NO_MODEL") {
            throw err;
          }
        }
        const requestParams = {
          messages: history,
          model
        };
        if (options?.systemPrompt) {
          requestParams.system_prompt = options.systemPrompt;
        }
        if (promptTools && promptTools.length > 0 && model && modelSupportsNativeTools(model)) {
          requestParams.tools = promptTools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema || { type: "object", properties: {} }
          }));
          console.log(`[demo-bootstrap] Passing ${requestParams.tools.length} tools to native tool calling model`);
        }
        const result = await bridgeRequest("llm.chat", requestParams);
        const toolCalls = result.choices?.[0]?.message?.tool_calls || result.message?.tool_calls;
        if (toolCalls && toolCalls.length > 0) {
          const tc = toolCalls[0];
          const toolCallJson = {
            name: tc.function.name,
            parameters: JSON.parse(tc.function.arguments || "{}")
          };
          console.log("[demo-bootstrap] Native tool call detected:", toolCallJson);
          const content2 = JSON.stringify(toolCallJson);
          history.push({ role: "assistant", content: content2 });
          return content2;
        }
        const content = result.choices?.[0]?.message?.content || result.content || result.message?.content;
        if (!content) {
          console.error("[demo-bootstrap] Unexpected LLM response format:", result);
          throw new Error("LLM returned empty or unexpected response");
        }
        history.push({ role: "assistant", content });
        return content;
      },
      async *promptStreaming(input) {
        const response = await this.prompt(input);
        const words = response.split(/(\s+)/);
        for (const word of words) {
          if (word) {
            yield { type: "token", token: word };
            await new Promise((r) => setTimeout(r, 20));
          }
        }
        yield { type: "done" };
      },
      async destroy() {
      }
    };
  },
  providers: {
    async list() {
      try {
        const result = await bridgeRequest("llm.list_providers");
        return result.providers.map((p) => ({
          id: p.id,
          name: p.name,
          available: p.configured,
          isDefault: p.is_default || false
        }));
      } catch {
        return [];
      }
    },
    async getActive() {
      try {
        const result = await bridgeRequest("llm.get_config");
        const parts = result.default_model?.split(":") || [];
        return {
          provider: result.default_provider || parts[0] || null,
          model: parts[1] || null
        };
      } catch {
        return { provider: null, model: null };
      }
    }
  }
};
var agent = {
  async requestPermissions(_options) {
    return {
      granted: true,
      scopes: {
        "model:prompt": "granted-always",
        "model:tools": "granted-always",
        "mcp:tools.list": "granted-always",
        "mcp:tools.call": "granted-always"
      }
    };
  },
  permissions: {
    async list() {
      return {
        origin: "extension",
        scopes: {
          "model:prompt": "granted-always",
          "model:tools": "granted-always",
          "mcp:tools.list": "granted-always",
          "mcp:tools.call": "granted-always"
        }
      };
    }
  },
  tools: {
    async list() {
      try {
        const response = await browserAPI.runtime.sendMessage({ type: "sidebar_get_servers" });
        if (!response.ok || !response.servers) {
          return [];
        }
        const tools = [];
        for (const server of response.servers) {
          if (server.running && server.tools) {
            for (const tool of server.tools) {
              tools.push({
                name: `${server.id}/${tool.name}`,
                description: tool.description,
                inputSchema: tool.inputSchema,
                serverId: server.id
              });
            }
          }
        }
        return tools;
      } catch (err) {
        console.error("[Demo] Failed to list tools:", err);
        return [];
      }
    },
    async call(options) {
      const [serverId, toolName] = options.tool.split("/");
      if (!serverId || !toolName) {
        throw new Error("Invalid tool name format. Expected: serverId/toolName");
      }
      const response = await browserAPI.runtime.sendMessage({
        type: "sidebar_call_tool",
        serverId,
        toolName,
        args: options.args
      });
      if (!response.ok) {
        throw new Error(response.error || "Tool call failed");
      }
      return response.result;
    }
  },
  browser: {
    activeTab: {
      async readability() {
        const tabs = await browserAPI.tabs.query({ active: true, currentWindow: true });
        const tab = tabs[0];
        if (!tab?.id || !tab.url) {
          throw new Error("No active tab found");
        }
        if (!tab.url.startsWith("http://") && !tab.url.startsWith("https://")) {
          throw new Error("Cannot read from this type of page");
        }
        const results = await browserAPI.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const clone = document.cloneNode(true);
            ["script", "style", "noscript", "nav", "footer", "header"].forEach((sel) => {
              clone.querySelectorAll(sel).forEach((el) => el.remove());
            });
            const main = clone.querySelector("main, article, .content") || clone.body;
            let text = main?.textContent || "";
            text = text.replace(/\s+/g, " ").trim().slice(0, 1e4);
            return { url: window.location.href, title: document.title, text };
          }
        });
        if (!results?.[0]?.result) {
          throw new Error("Failed to extract content");
        }
        return results[0].result;
      }
    }
  },
  run(options) {
    const { task, maxToolCalls = 5 } = options;
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "status", message: "Starting agent..." };
        try {
          const tools = await agent.tools.list();
          yield { type: "status", message: `Found ${tools.length} tools` };
          let activeModel;
          try {
            const configuredRes = await bridgeRequest("llm.list_configured_models");
            const defaultModel = configuredRes.models?.find((m) => m.is_default);
            activeModel = defaultModel?.model_id || configuredRes.models?.[0]?.model_id;
          } catch {
            try {
              const config = await bridgeRequest("llm.get_config");
              activeModel = config.default_model;
            } catch {
            }
          }
          let systemPrompt;
          const useNativeTools = modelSupportsNativeTools(activeModel);
          console.log(`[Demo] Active model: ${activeModel}, native tools: ${useNativeTools}`);
          if (tools.length === 0) {
            systemPrompt = "You are a helpful assistant.";
          } else if (useNativeTools) {
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
- User: "reverse hello world" \u2192 Use "hello world" as the argument
- User: "what time is it?" \u2192 Call time tool with no made-up arguments
- User: "reverse this" (with no text provided) \u2192 Ask "What text would you like me to reverse?"

Examples of INCORRECT behavior:
- User: "reverse this string" \u2192 Using "this is a test string" (WRONG - made up data)
- User: "translate this" \u2192 Using example text (WRONG - should ask what to translate)

## RESPONSE RULES
1. After receiving a tool result, RESPOND directly to the user
2. Do NOT call additional tools unless the user's request explicitly requires it
3. Synthesize tool results into a clear, helpful answer

After getting a result, answer the user directly. Do NOT call more tools in a loop.`;
          } else {
            const toolList = tools.map((t) => {
              const schema = t.inputSchema;
              const properties = schema?.properties;
              const required = schema?.required;
              let paramInfo = "";
              if (properties) {
                const params = Object.entries(properties).map(([name, prop]) => {
                  const isRequired = required?.includes(name);
                  return `${name}${isRequired ? " (required)" : ""}: ${prop.description || "no description"}`;
                });
                if (params.length > 0) {
                  paramInfo = `
  Parameters: ${params.join("; ")}`;
                }
              }
              return `- ${t.name}: ${t.description || "No description"}${paramInfo}`;
            }).join("\n");
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

CORRECT: User says "reverse hello world" \u2192 parameters: {"text": "hello world"}
INCORRECT: User says "reverse this string" \u2192 parameters: {"text": "this is a test string"} (WRONG - made up data)

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
          const session = await ai.createTextSession({ systemPrompt });
          const toolMap = {};
          for (const t of tools) {
            toolMap[t.name] = t.serverId || "";
          }
          let iterations = 0;
          let currentMessage = task;
          let finalOutput = "";
          const calledTools = /* @__PURE__ */ new Set();
          while (iterations < maxToolCalls) {
            iterations++;
            yield { type: "status", message: `Processing (iteration ${iterations})...` };
            let response;
            try {
              response = await session.prompt(currentMessage, useNativeTools ? tools : void 0);
            } catch (err) {
              const errorCode = err && typeof err === "object" && "code" in err ? err.code : "ERR_LLM_FAILED";
              const errorMsg = err instanceof Error ? err.message : "LLM request failed";
              yield { type: "error", error: { code: errorCode, message: errorMsg } };
              return;
            }
            if (!response) {
              yield { type: "error", error: { code: "ERR_EMPTY_RESPONSE", message: "LLM returned empty response" } };
              return;
            }
            const toolCall = parseToolCallFromText(response, Object.keys(toolMap));
            if (toolCall) {
              if (toolCall.toolNotFound) {
                console.log(`[demo-bootstrap] Model tried to call non-existent tool: ${toolCall.requestedTool}`);
                const availableToolNames = Object.keys(toolMap).map((t) => t.split("/").pop()).join(", ");
                currentMessage = `Error: The tool "${toolCall.requestedTool}" does not exist. Available tools are: ${availableToolNames}. Please provide a direct answer to the user.`;
                continue;
              }
              const { name: toolName, parameters: args } = toolCall;
              const shortToolName = toolName.split("/").pop() || toolName;
              if (calledTools.has(toolName)) {
                console.log(`[demo-bootstrap] Preventing repeat call to: ${toolName}`);
                try {
                  const forceMessage = `You already have the result from "${shortToolName}". Now answer the user's question: "${task}"

Respond in plain text only.`;
                  const forcedResponse = await session.prompt(forceMessage, void 0);
                  if (forcedResponse && !parseToolCallFromText(forcedResponse, Object.keys(toolMap))) {
                    finalOutput = forcedResponse;
                    break;
                  }
                } catch {
                }
                continue;
              }
              calledTools.add(toolName);
              yield { type: "tool_call", tool: toolName, args };
              try {
                const result = await agent.tools.call({ tool: toolName, args });
                yield { type: "tool_result", tool: toolName, result };
                let resultText;
                if (result && typeof result === "object" && "content" in result) {
                  const content = result.content;
                  resultText = content.filter((c) => c.type === "text" && c.text).map((c) => c.text).join("\n");
                } else {
                  resultText = JSON.stringify(result, null, 2);
                }
                currentMessage = `Tool "${toolName.split("/").pop()}" returned: ${resultText}

Now respond directly to the user's original question: "${task}"

IMPORTANT: Provide your answer in plain text. Do NOT call any more tools.`;
              } catch (err) {
                const errorMsg = err instanceof Error ? err.message : "Unknown error";
                yield { type: "tool_result", tool: toolName, error: { code: "ERR_TOOL_FAILED", message: errorMsg } };
                currentMessage = `Tool ${toolName} failed: ${errorMsg}. Please provide the best answer you can without using tools.`;
              }
            } else {
              finalOutput = response;
              break;
            }
          }
          if (!finalOutput && iterations >= maxToolCalls) {
            finalOutput = "I apologize, but I wasn't able to complete the task within the allowed steps. Based on my attempts, I may need more information or a simpler request.";
          }
          const words = finalOutput.split(/(\s+)/);
          for (const word of words) {
            if (word) {
              yield { type: "token", token: word };
              await new Promise((r) => setTimeout(r, 15));
            }
          }
          yield { type: "final", output: finalOutput };
          await session.destroy();
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : "Unknown error";
          yield { type: "error", error: { code: "ERR_INTERNAL", message: errorMsg } };
        }
      }
    };
  }
};
function parseToolCallFromText(text, availableTools) {
  if (!text) return null;
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed.name && typeof parsed.name === "string") {
      const toolName = parsed.name;
      const params = parsed.parameters || parsed.arguments || parsed.args || {};
      if (availableTools.length === 0) {
        return {
          name: toolName,
          parameters: params,
          toolNotFound: true,
          requestedTool: toolName
        };
      }
      let matchedTool = availableTools.find((t) => t === toolName);
      if (!matchedTool) {
        matchedTool = availableTools.find((t) => t.endsWith("/" + toolName) || t.endsWith("__" + toolName));
      }
      if (!matchedTool) {
        const shortName = toolName.split("/").pop() || toolName;
        matchedTool = availableTools.find((t) => {
          const tShort = t.split("/").pop() || t;
          return tShort === shortName;
        });
      }
      if (!matchedTool) {
        matchedTool = availableTools.find((t) => t.includes(toolName) || toolName.includes(t.split("/").pop() || ""));
      }
      if (matchedTool) {
        return {
          name: matchedTool,
          parameters: params
        };
      } else {
        console.log(`[demo-bootstrap] Tool call detected for non-existent tool: ${toolName}`);
        console.log(`[demo-bootstrap] Available tools: ${availableTools.join(", ")}`);
        return {
          name: toolName,
          parameters: params,
          toolNotFound: true,
          requestedTool: toolName
        };
      }
    }
    if (parsed.tool && typeof parsed.tool === "string") {
      const toolName = parsed.tool;
      const params = parsed.args || parsed.arguments || parsed.parameters || {};
      const matchedTool = availableTools.find(
        (t) => t === toolName || t.includes(toolName)
      );
      if (matchedTool) {
        return {
          name: matchedTool,
          parameters: params
        };
      } else {
        return {
          name: toolName,
          parameters: params,
          toolNotFound: true,
          requestedTool: toolName
        };
      }
    }
  } catch {
  }
  return null;
}
window.ai = ai;
window.agent = agent;
window.dispatchEvent(new CustomEvent("harbor-provider-ready"));
console.log("[Harbor Demo] APIs ready:", {
  "window.ai": typeof window.ai !== "undefined",
  "window.agent": typeof window.agent !== "undefined"
});
//# sourceMappingURL=demo-bootstrap.js.map
