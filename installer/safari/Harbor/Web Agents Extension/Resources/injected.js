if (typeof chrome === 'undefined' && typeof browser !== 'undefined') { globalThis.chrome = browser; }
// src/injected.ts
function getFeatureFlags() {
  const defaults = {
    textGeneration: true,
    toolCalling: false,
    toolAccess: true,
    browserInteraction: false,
    browserControl: false,
    multiAgent: false
  };
  try {
    const flagsElement = document.getElementById("web-agents-api-flags");
    if (flagsElement?.textContent) {
      const parsed = JSON.parse(flagsElement.textContent);
      return { ...defaults, ...parsed };
    }
  } catch {
  }
  return defaults;
}
var FEATURE_FLAGS = getFeatureFlags();
function featureDisabled(featureName) {
  return () => {
    const err = new Error(`Feature "${featureName}" is not enabled. Enable it in Web Agents API settings.`);
    err.code = "ERR_FEATURE_DISABLED";
    throw err;
  };
}
function featureDisabledAsync(featureName) {
  return async () => {
    const err = new Error(`Feature "${featureName}" is not enabled. Enable it in Web Agents API settings.`);
    err.code = "ERR_FEATURE_DISABLED";
    throw err;
  };
}
var CHANNEL = "web_agents_api";
var pendingRequests = /* @__PURE__ */ new Map();
var streamListeners = /* @__PURE__ */ new Map();
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (data?.channel !== CHANNEL) return;
  if (data.response) {
    const pending = pendingRequests.get(data.response.id);
    if (pending) {
      pendingRequests.delete(data.response.id);
      if (data.response.ok) {
        pending.resolve(data.response.result);
      } else {
        const err = new Error(data.response.error?.message || "Request failed");
        err.code = data.response.error?.code;
        pending.reject(err);
      }
    }
  }
  if (data.streamEvent) {
    const listener = streamListeners.get(data.streamEvent.id);
    if (listener) {
      listener(data.streamEvent.event, data.streamEvent.done || false);
      if (data.streamEvent.done) {
        streamListeners.delete(data.streamEvent.id);
      }
    }
  }
});
function sendRequest(type, payload) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, {
      resolve,
      reject
    });
    window.postMessage({ channel: CHANNEL, request: { id, type, payload } }, "*");
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        const err = new Error("Request timeout");
        err.code = "ERR_TIMEOUT";
        reject(err);
      }
    }, 3e4);
  });
}
function createStreamIterable(type, payload) {
  const id = crypto.randomUUID();
  return {
    [Symbol.asyncIterator]() {
      const queue = [];
      let resolveNext = null;
      let done = false;
      let error = null;
      streamListeners.set(id, (event, isDone) => {
        if (isDone) {
          done = true;
          streamListeners.delete(id);
        }
        if ("type" in event && event.type === "error") {
          error = new Error(event.error?.message || "Stream error");
          error.code = event.error?.code || "ERR_INTERNAL";
          done = true;
        }
        if (resolveNext && !error) {
          resolveNext({ done: false, value: event });
          resolveNext = null;
        } else if (!error) {
          queue.push(event);
        }
      });
      window.postMessage({ channel: CHANNEL, request: { id, type, payload } }, "*");
      return {
        async next() {
          if (error) {
            throw error;
          }
          if (queue.length > 0) {
            return { done: false, value: queue.shift() };
          }
          if (done) {
            return { done: true, value: void 0 };
          }
          return new Promise((resolve) => {
            resolveNext = resolve;
          });
        },
        async return() {
          done = true;
          streamListeners.delete(id);
          window.postMessage({ channel: CHANNEL, abort: { id } }, "*");
          return { done: true, value: void 0 };
        }
      };
    }
  };
}
function createTextSessionObject(sessionId) {
  return Object.freeze({
    sessionId,
    async prompt(input) {
      return sendRequest("session.prompt", { sessionId, input });
    },
    promptStreaming(input) {
      const tokenIterable = createStreamIterable("session.promptStreaming", { sessionId, input });
      return {
        [Symbol.asyncIterator]() {
          const tokenIterator = tokenIterable[Symbol.asyncIterator]();
          return {
            async next() {
              const result = await tokenIterator.next();
              if (result.done) {
                return { done: true, value: void 0 };
              }
              if (result.value.type === "token" && result.value.token) {
                return { done: false, value: result.value.token };
              }
              if (result.value.type === "done") {
                return { done: true, value: void 0 };
              }
              if (result.value.type === "error") {
                throw new Error(result.value.error?.message || "Stream error");
              }
              return this.next();
            },
            async return() {
              await tokenIterator.return?.();
              return { done: true, value: void 0 };
            }
          };
        }
      };
    },
    destroy() {
      sendRequest("session.destroy", { sessionId }).catch(() => {
      });
    }
  });
}
var aiApi = Object.freeze({
  async canCreateTextSession() {
    return sendRequest("ai.canCreateTextSession");
  },
  async createTextSession(options = {}) {
    const sessionId = await sendRequest("ai.createTextSession", options);
    return createTextSessionObject(sessionId);
  },
  languageModel: Object.freeze({
    async capabilities() {
      return sendRequest("ai.languageModel.capabilities");
    },
    async create(options = {}) {
      const sessionOptions = {
        systemPrompt: options.systemPrompt,
        temperature: options.temperature
      };
      const sessionId = await sendRequest("ai.languageModel.create", {
        ...sessionOptions,
        topK: options.topK
      });
      return createTextSessionObject(sessionId);
    }
  }),
  providers: Object.freeze({
    async list() {
      return sendRequest("ai.providers.list");
    },
    async getActive() {
      return sendRequest("ai.providers.getActive");
    }
  })
});
function createAgentSessionObject(sessionId, capabilities) {
  return Object.freeze({
    sessionId,
    capabilities,
    async prompt(input) {
      if (!capabilities.llm.allowed) {
        throw new Error("Session does not have LLM access");
      }
      return sendRequest("session.prompt", { sessionId, input });
    },
    promptStreaming(input) {
      if (!capabilities.llm.allowed) {
        throw new Error("Session does not have LLM access");
      }
      const tokenIterable = createStreamIterable("session.promptStreaming", { sessionId, input });
      return {
        [Symbol.asyncIterator]() {
          const tokenIterator = tokenIterable[Symbol.asyncIterator]();
          return {
            async next() {
              const result = await tokenIterator.next();
              if (result.done) {
                return { done: true, value: void 0 };
              }
              if (result.value.type === "token" && result.value.token) {
                return { done: false, value: result.value.token };
              }
              if (result.value.type === "done") {
                return { done: true, value: void 0 };
              }
              if (result.value.type === "error") {
                throw new Error(result.value.error?.message || "Stream error");
              }
              return this.next();
            },
            async return() {
              await tokenIterator.return?.();
              return { done: true, value: void 0 };
            }
          };
        }
      };
    },
    async callTool(tool, args) {
      if (!capabilities.tools.allowed) {
        throw new Error("Session does not have tool access");
      }
      if (!capabilities.tools.allowedTools.includes(tool)) {
        throw new Error(`Tool ${tool} not allowed in this session`);
      }
      return sendRequest("agent.tools.call", { tool, args, sessionId });
    },
    listAllowedTools() {
      return capabilities.tools.allowedTools;
    },
    async terminate() {
      await sendRequest("agent.sessions.terminate", { sessionId });
    }
  });
}
function createBrowserApi() {
  return Object.freeze({
    activeTab: Object.freeze({
      /**
       * Get readable content from the current page using readability parser.
       */
      readability: FEATURE_FLAGS.browserInteraction || FEATURE_FLAGS.browserControl ? async function() {
        return sendRequest("agent.browser.activeTab.readability");
      } : featureDisabledAsync("browserInteraction"),
      /**
       * Get visible interactive elements on the page.
       */
      getElements: FEATURE_FLAGS.browserInteraction ? async function() {
        return sendRequest("agent.browser.activeTab.getElements");
      } : featureDisabledAsync("browserInteraction"),
      /**
       * Click an element by ref.
       */
      click: FEATURE_FLAGS.browserInteraction ? async function(ref) {
        return sendRequest("agent.browser.activeTab.click", { ref });
      } : featureDisabledAsync("browserInteraction"),
      /**
       * Fill a form field.
       */
      fill: FEATURE_FLAGS.browserInteraction ? async function(ref, value) {
        return sendRequest("agent.browser.activeTab.fill", { ref, value });
      } : featureDisabledAsync("browserInteraction"),
      /**
       * Scroll the page.
       */
      scroll: FEATURE_FLAGS.browserInteraction ? async function(direction, amount) {
        return sendRequest("agent.browser.activeTab.scroll", { direction, amount });
      } : featureDisabledAsync("browserInteraction"),
      /**
       * Select an option from a dropdown.
       */
      select: FEATURE_FLAGS.browserInteraction ? async function(ref, value) {
        return sendRequest("agent.browser.activeTab.select", { ref, value });
      } : featureDisabledAsync("browserInteraction"),
      /**
       * Take a screenshot.
       */
      screenshot: FEATURE_FLAGS.browserInteraction ? async function() {
        return sendRequest("agent.browser.activeTab.screenshot");
      } : featureDisabledAsync("browserInteraction")
    }),
    /**
     * Navigate to a URL.
     */
    navigate: FEATURE_FLAGS.browserControl ? async function(url) {
      return sendRequest("agent.browser.navigate", { url });
    } : featureDisabledAsync("browserControl"),
    /**
     * Fetch a URL (CORS-bypassing).
     */
    fetch: FEATURE_FLAGS.browserControl ? async function(url, options) {
      return sendRequest("agent.browser.fetch", { url, options });
    } : featureDisabledAsync("browserControl"),
    /**
     * Tab management (browserControl required).
     */
    tabs: FEATURE_FLAGS.browserControl ? Object.freeze({
      async list() {
        return sendRequest("agent.browser.tabs.list");
      },
      async create(options) {
        return sendRequest("agent.browser.tabs.create", options);
      },
      async close(tabId) {
        return sendRequest("agent.browser.tabs.close", { tabId });
      }
    }) : {
      list: featureDisabledAsync("browserControl"),
      create: featureDisabledAsync("browserControl"),
      close: featureDisabledAsync("browserControl")
    },
    /**
     * Spawned tab operations - for tabs this origin created.
     */
    tab: FEATURE_FLAGS.browserControl ? Object.freeze({
      /**
       * Extract readable content from a tab this origin created.
       */
      async readability(tabId) {
        return sendRequest("agent.browser.tab.readability", { tabId });
      },
      /**
       * Get HTML content from a tab this origin created.
       * @param tabId - The tab ID
       * @param selector - Optional CSS selector to scope the HTML extraction
       */
      async getHtml(tabId, selector) {
        return sendRequest("agent.browser.tab.getHtml", { tabId, selector });
      },
      /**
       * Wait for a tab to finish loading.
       * @param tabId - The tab ID
       * @param options - Optional timeout in milliseconds (default 30000)
       */
      async waitForLoad(tabId, options) {
        return sendRequest("agent.browser.tab.waitForLoad", { tabId, ...options });
      }
    }) : {
      readability: featureDisabledAsync("browserControl"),
      getHtml: featureDisabledAsync("browserControl"),
      waitForLoad: featureDisabledAsync("browserControl")
    }
  });
}
var agentMessageHandlers = [];
var agentInvocationHandlers = [];
var agentEventSubscriptions = /* @__PURE__ */ new Map();
var currentAgentId = null;
function createMultiAgentApi() {
  return Object.freeze({
    /**
     * Register this page as an agent.
     * 
     * @example
     * const agent = await window.agent.agents.register({
     *   name: 'Researcher',
     *   capabilities: ['search', 'summarize'],
     *   acceptsInvocations: true,
     * });
     */
    async register(options) {
      const result = await sendRequest("agent.agents.register", options);
      currentAgentId = result.id;
      setupAgentEventListener();
      return result;
    },
    /**
     * Unregister this agent.
     */
    async unregister(agentId) {
      const idToUnregister = agentId || currentAgentId;
      if (!idToUnregister) {
        throw new Error("Agent not registered");
      }
      await sendRequest("agent.agents.unregister", { agentId: idToUnregister });
      if (idToUnregister === currentAgentId) {
        currentAgentId = null;
      }
    },
    /**
     * Get information about an agent by ID.
     */
    async getInfo(agentId) {
      return sendRequest("agent.agents.getInfo", { agentId });
    },
    /**
     * Discover agents matching a query.
     * 
     * @example
     * const result = await window.agent.agents.discover({
     *   capabilities: ['search'],
     *   includeSameOrigin: true,
     * });
     * console.log('Found agents:', result.agents);
     */
    async discover(query = {}) {
      return sendRequest("agent.agents.discover", query);
    },
    /**
     * List all registered agents visible to this origin.
     */
    async list() {
      const result = await sendRequest("agent.agents.list");
      return result.agents;
    },
    /**
     * Invoke another agent to perform a task.
     * 
     * @example
     * const response = await window.agent.agents.invoke(researcherId, {
     *   task: 'research',
     *   input: { topic: 'AI safety' },
     *   timeout: 30000,
     * });
     */
    async invoke(agentId, request) {
      return sendRequest("agent.agents.invoke", { agentId, request });
    },
    /**
     * Send a message to another agent.
     */
    async send(agentId, payload) {
      return sendRequest("agent.agents.send", { agentId, payload });
    },
    /**
     * Register a handler for incoming messages.
     * 
     * @example
     * window.agent.agents.onMessage((message) => {
     *   console.log('Received from', message.from, ':', message.payload);
     * });
     */
    onMessage(handler) {
      agentMessageHandlers.push(handler);
      return () => {
        const index = agentMessageHandlers.indexOf(handler);
        if (index >= 0) agentMessageHandlers.splice(index, 1);
      };
    },
    /**
     * Register a handler for incoming invocations.
     * 
     * @example
     * window.agent.agents.onInvoke(async (request) => {
     *   if (request.task === 'research') {
     *     return { findings: ['...'] };
     *   }
     *   throw new Error('Unknown task');
     * });
     */
    onInvoke(handler) {
      agentInvocationHandlers.push(handler);
      return () => {
        const index = agentInvocationHandlers.indexOf(handler);
        if (index >= 0) agentInvocationHandlers.splice(index, 1);
      };
    },
    /**
     * Subscribe to events of a specific type.
     */
    async subscribe(eventType, handler) {
      if (!agentEventSubscriptions.has(eventType)) {
        agentEventSubscriptions.set(eventType, []);
        await sendRequest("agent.agents.subscribe", { eventType });
      }
      agentEventSubscriptions.get(eventType).push(handler);
    },
    /**
     * Unsubscribe from events of a specific type.
     */
    async unsubscribe(eventType, handler) {
      const handlers = agentEventSubscriptions.get(eventType);
      if (!handlers) return;
      if (handler) {
        const index = handlers.indexOf(handler);
        if (index >= 0) handlers.splice(index, 1);
      } else {
        handlers.length = 0;
      }
      if (handlers.length === 0) {
        agentEventSubscriptions.delete(eventType);
        await sendRequest("agent.agents.unsubscribe", { eventType });
      }
    },
    /**
     * Broadcast an event to all subscribed agents.
     */
    async broadcast(eventType, data) {
      return sendRequest("agent.agents.broadcast", { eventType, data });
    },
    /**
     * Orchestration patterns for multi-agent workflows.
     */
    orchestrate: Object.freeze({
      /**
       * Execute a pipeline of agents sequentially.
       * Each step's output becomes the next step's input.
       * 
       * @example
       * const result = await window.agent.agents.orchestrate.pipeline({
       *   steps: [
       *     { agentId: researcherId, task: 'research' },
       *     { agentId: writerId, task: 'write' },
       *   ],
       * }, { topic: 'AI' });
       */
      async pipeline(config, initialInput) {
        return sendRequest("agent.agents.orchestrate.pipeline", { config, initialInput });
      },
      /**
       * Execute multiple agents in parallel.
       * 
       * @example
       * const result = await window.agent.agents.orchestrate.parallel({
       *   tasks: [
       *     { agentId: agent1, task: 'analyze', input: data },
       *     { agentId: agent2, task: 'validate', input: data },
       *   ],
       *   combineStrategy: 'array',
       * });
       */
      async parallel(config) {
        return sendRequest("agent.agents.orchestrate.parallel", { config });
      },
      /**
       * Route input to an agent based on conditions.
       * 
       * @example
       * const result = await window.agent.agents.orchestrate.route({
       *   routes: [
       *     { condition: 'type:technical', agentId: techAgent },
       *     { condition: 'type:creative', agentId: creativeAgent },
       *   ],
       *   defaultAgentId: generalAgent,
       * }, input, 'process');
       */
      async route(config, input, task) {
        return sendRequest("agent.agents.orchestrate.route", { config, input, task });
      }
    })
  });
}
var processedPageInvocations = /* @__PURE__ */ new Set();
var eventListenerSetUp = false;
function setupAgentEventListener() {
  if (eventListenerSetUp) {
    console.log("[Web Agents API Page] Event listener already set up, skipping");
    return;
  }
  eventListenerSetUp = true;
  console.log("[Web Agents API Page] Setting up event listener");
  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (data?.channel !== "web_agents_api" || !data.agentEvent) return;
    const { type, message, invocation, broadcast } = data.agentEvent;
    if (type === "message" && message) {
      for (const handler of agentMessageHandlers) {
        try {
          handler(message);
        } catch (e) {
          console.error("[Web Agents API] Message handler error:", e);
        }
      }
    } else if (type === "invocation" && invocation) {
      const invocationId = invocation.invocationId;
      if (processedPageInvocations.has(invocationId)) {
        console.log("[Web Agents API Page] DUPLICATE invocation, skipping:", invocationId);
        return;
      }
      processedPageInvocations.add(invocationId);
      setTimeout(() => processedPageInvocations.delete(invocationId), 6e4);
      console.log("[Web Agents API Page] Processing invocation:", invocation.task, invocationId);
      let result;
      let error;
      for (const handler of agentInvocationHandlers) {
        try {
          result = await handler(invocation);
          break;
        } catch (e) {
          error = {
            code: "ERR_HANDLER_FAILED",
            message: e instanceof Error ? e.message : "Handler failed"
          };
        }
      }
      window.postMessage({
        channel: "web_agents_api",
        agentInvocationResponse: {
          invocationId: invocation.invocationId,
          success: !error,
          result,
          error
        }
      }, "*");
    } else if (type === "broadcast" && broadcast) {
      const handlers = agentEventSubscriptions.get(broadcast.type);
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(broadcast);
          } catch (e) {
            console.error("[Web Agents API] Event handler error:", e);
          }
        }
      }
    }
  });
}
var agentApi = Object.freeze({
  async requestPermissions(options) {
    return sendRequest("agent.requestPermissions", options);
  },
  permissions: Object.freeze({
    async list() {
      return sendRequest("agent.permissions.list");
    }
  }),
  tools: FEATURE_FLAGS.toolAccess ? Object.freeze({
    async list() {
      return sendRequest("agent.tools.list");
    },
    async call(options) {
      return sendRequest("agent.tools.call", options);
    }
  }) : {
    list: featureDisabledAsync("toolAccess"),
    call: featureDisabledAsync("toolAccess")
  },
  browser: createBrowserApi(),
  /**
   * MCP (Model Context Protocol) server management.
   * Allows websites to register MCP servers that provide tools to the user's AI.
   */
  mcp: Object.freeze({
    /**
     * Discover MCP servers declared on this page via <link rel="mcp-server">.
     * 
     * @example
     * const servers = await window.agent.mcp.discover();
     * console.log('Found MCP servers:', servers);
     */
    async discover() {
      return sendRequest("agent.mcp.discover");
    },
    /**
     * Register an MCP server with the browser.
     * 
     * @example
     * const result = await window.agent.mcp.register({
     *   url: 'http://localhost:3001/mcp',
     *   name: 'My Shop Assistant',
     *   tools: ['search_products', 'add_to_cart'],
     *   transport: 'sse',
     * });
     */
    async register(options) {
      return sendRequest("agent.mcp.register", options);
    },
    /**
     * Unregister a previously registered MCP server.
     */
    async unregister(serverId) {
      return sendRequest("agent.mcp.unregister", { serverId });
    }
  }),
  /**
   * Browser chat UI management.
   * Allows websites to open the user's AI chat with custom configuration.
   */
  chat: Object.freeze({
    /**
     * Check if the browser chat can be opened.
     */
    async canOpen() {
      return sendRequest("agent.chat.canOpen");
    },
    /**
     * Open the browser's chat UI with optional configuration.
     * 
     * @example
     * const result = await window.agent.chat.open({
     *   systemPrompt: 'You are a helpful shopping assistant...',
     *   tools: ['server-id/search_products', 'server-id/add_to_cart'],
     *   style: { accentColor: '#ff9900', theme: 'light' },
     * });
     */
    async open(options) {
      return sendRequest("agent.chat.open", options);
    },
    /**
     * Close a chat opened by this origin.
     */
    async close(chatId) {
      return sendRequest("agent.chat.close", { chatId });
    }
  }),
  /**
   * Run an autonomous agent that can use tools to complete a task.
   * 
   * @example
   * for await (const event of window.agent.run({
   *   task: 'What is the current time?',
   *   maxToolCalls: 3
   * })) {
   *   if (event.type === 'tool_call') {
   *     console.log('Using tool:', event.tool);
   *   }
   *   if (event.type === 'final') {
   *     console.log('Response:', event.output);
   *   }
   * }
   */
  run: FEATURE_FLAGS.toolCalling ? function(options) {
    const tokenStream = createStreamIterable("agent.run", options);
    return {
      [Symbol.asyncIterator]() {
        const tokenIterator = tokenStream[Symbol.asyncIterator]();
        return {
          async next() {
            while (true) {
              const result = await tokenIterator.next();
              if (result.done) {
                return { done: true, value: void 0 };
              }
              const token = result.value;
              if (token.type === "done") {
                return { done: true, value: void 0 };
              }
              if (token.type === "error") {
                return {
                  done: false,
                  value: { type: "error", error: token.error?.message || "Unknown error" }
                };
              }
              if (token.type === "token" && token.token) {
                try {
                  const event = JSON.parse(token.token);
                  return { done: false, value: event };
                } catch {
                  continue;
                }
              }
            }
          },
          async return() {
            await tokenIterator.return?.();
            return { done: true, value: void 0 };
          }
        };
      }
    };
  } : featureDisabled("toolCalling"),
  // Session management API (explicit sessions)
  sessions: Object.freeze({
    /**
     * Create an explicit session with specified capabilities.
     * 
     * @example
     * const session = await agent.sessions.create({
     *   name: 'Recipe Assistant',
     *   capabilities: {
     *     llm: { provider: 'ollama' },
     *     tools: ['time-wasm/time.now'],
     *   },
     *   limits: { maxToolCalls: 10 },
     * });
     * 
     * const response = await session.prompt('What time is it?');
     */
    async create(options) {
      const result = await sendRequest("agent.sessions.create", options);
      if (!result.success || !result.sessionId || !result.capabilities) {
        const errorMsg = result.error?.message || "Session creation failed";
        throw new Error(errorMsg);
      }
      return createAgentSessionObject(result.sessionId, result.capabilities);
    },
    /**
     * Get a session by ID.
     */
    async get(sessionId) {
      return sendRequest("agent.sessions.get", { sessionId });
    },
    /**
     * List active sessions for this origin.
     */
    async list() {
      return sendRequest("agent.sessions.list");
    },
    /**
     * Terminate a session.
     */
    async terminate(sessionId) {
      const result = await sendRequest("agent.sessions.terminate", { sessionId });
      return result.terminated;
    }
  }),
  // Multi-agent API (Extension 3)
  agents: FEATURE_FLAGS.multiAgent ? createMultiAgentApi() : {
    register: featureDisabledAsync("multiAgent"),
    unregister: featureDisabledAsync("multiAgent"),
    getInfo: featureDisabledAsync("multiAgent"),
    discover: featureDisabledAsync("multiAgent"),
    list: featureDisabledAsync("multiAgent"),
    invoke: featureDisabledAsync("multiAgent"),
    send: featureDisabledAsync("multiAgent"),
    onMessage: featureDisabled("multiAgent"),
    onInvoke: featureDisabled("multiAgent"),
    subscribe: featureDisabledAsync("multiAgent"),
    unsubscribe: featureDisabledAsync("multiAgent"),
    orchestrate: {
      pipeline: featureDisabledAsync("multiAgent"),
      parallel: featureDisabledAsync("multiAgent"),
      route: featureDisabledAsync("multiAgent")
    }
  }
});
function safeDefineProperty(name, value) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(window, name);
    if (descriptor && !descriptor.configurable) {
      console.debug(`[Web Agents API] Skipping ${name} - already defined`);
      return false;
    }
    Object.defineProperty(window, name, {
      value,
      writable: false,
      configurable: true,
      enumerable: true
    });
    return true;
  } catch (error) {
    console.debug(`[Web Agents API] Could not define window.${name}:`, error);
    return false;
  }
}
try {
  const existingAi = window.ai;
  const chromeAiDetected = existingAi !== void 0 && existingAi !== null;
  if (FEATURE_FLAGS.textGeneration && !chromeAiDetected) {
    safeDefineProperty("ai", aiApi);
  } else if (!FEATURE_FLAGS.textGeneration) {
    console.debug("[Web Agents API] Text generation disabled, window.ai not registered.");
  } else {
    console.debug("[Web Agents API] Chrome AI detected, window.ai not overridden.");
  }
  const existingAgent = window.agent;
  if (existingAgent === void 0) {
    safeDefineProperty("agent", agentApi);
  }
  window.dispatchEvent(
    new CustomEvent("agent-ready", {
      detail: {
        version: "1.0.0",
        chromeAiDetected,
        features: {
          textGeneration: FEATURE_FLAGS.textGeneration,
          toolCalling: FEATURE_FLAGS.toolCalling,
          toolAccess: FEATURE_FLAGS.toolAccess,
          browserInteraction: FEATURE_FLAGS.browserInteraction,
          browserControl: FEATURE_FLAGS.browserControl,
          multiAgent: FEATURE_FLAGS.multiAgent
        }
      }
    })
  );
  console.debug("[Web Agents API] Registered with features:", FEATURE_FLAGS);
} catch (error) {
  console.warn("[Web Agents API] Failed to register API", error);
}
//# sourceMappingURL=injected.js.map
