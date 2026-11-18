/**
 * Mock implementation of the Web Agent API (window.ai and window.agent)
 * for unit/integration tests. Install on globalThis or window so your app
 * code sees the same API without a real browser or extensions.
 *
 * Usage:
 *   const mock = installWebAgentsMock(globalThis);
 *   mock.permissions.grantAll();   // the user allows what the page requests
 *   mock.ai.textSessionResponse = 'Mocked reply';
 *   // run your tests...
 *   mock.uninstall();
 */

function createApiError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Install the Web Agent API mock on the given global object (globalThis or window).
 * Returns a control object to configure behavior; call .uninstall() when done.
 */
export function installWebAgentsMock(global) {
  const state = {
    // What the user answers when the page asks: null = deny everything,
    // true = allow every requested scope, or a Set of the scopes they'd allow.
    permissionPolicy: null,
    // Scopes this origin holds right now, as Harbor records them.
    granted: new Set(),
    textSessionResponse: 'Mocked response',
    textSessionStreamTokens: ['Mocked ', 'streamed ', 'response'],
    textSessionError: null,
    toolsList: [
      { name: 'mock-server/echo', description: 'Echo tool for tests', inputSchema: {}, serverId: 'mock-server' },
    ],
    toolCallResult: { result: 'mock result' },
    toolCallError: null,
    runOutput: 'Mocked agent run output',
    runError: null,
  };

  // The scopes Harbor knows (extension/src/page-api/injected.ts).
  const ALL_SCOPES = [
    'model:prompt', 'model:tools', 'model:list', 'mcp:tools.list', 'mcp:tools.call', 'mcp:servers.register',
    'browser:activeTab.read', 'browser:activeTab.interact', 'browser:activeTab.screenshot',
    'browser:tabs.read', 'browser:tabs.create', 'browser:navigate', 'web:fetch', 'chat:open',
    'agents:register', 'agents:discover', 'agents:invoke', 'agents:message',
  ];

  function scopesResult() {
    return Object.fromEntries(ALL_SCOPES.map(s => [s, state.granted.has(s) ? 'granted-always' : 'not-granted']));
  }

  function userAllows(scope) {
    return state.permissionPolicy === true
      || (state.permissionPolicy instanceof Set && state.permissionPolicy.has(scope));
  }

  // Like Harbor, a request grants exactly the scopes it names, never more.
  async function requestPermissions(options = {}) {
    const requested = [...new Set(options.scopes || [])];
    const denied = requested.filter(s => !state.granted.has(s) && !userAllows(s));
    if (denied.length > 0) {
      const scopes = scopesResult();
      denied.forEach(s => { scopes[s] = 'denied'; });
      return { granted: false, scopes };
    }
    requested.forEach(s => state.granted.add(s));
    return { granted: true, scopes: scopesResult() };
  }

  // Harbor asks the user when a page calls the agent API without the scope.
  // The mock can't show that prompt, so it fails instead: a test then shows
  // whether the page requested the scope before using it.
  function requireScope(scope) {
    if (!state.granted.has(scope)) {
      throw createApiError('ERR_SCOPE_REQUIRED', `Permission "${scope}" is required. Request it with agent.requestPermissions().`);
    }
  }

  const agentsState = {
    featureEnabled: false, // Harbor's multiAgent feature is off by default
    nextId: 1,
    pageAgentId: null,
    pageAgent: null,
    others: new Map(), // id -> { info, onInvoke, onMessage }
    messageHandlers: [],
    invokeHandlers: [],
  };

  function checkFeature() {
    if (!agentsState.featureEnabled) {
      throw createApiError('ERR_FEATURE_DISABLED', 'Feature "multiAgent" is not enabled. Enable it in Web Agents API settings.');
    }
  }

  function makeAgentInfo(options) {
    const now = Date.now();
    return {
      id: `agent-mock-${agentsState.nextId++}`,
      name: options.name,
      description: options.description,
      capabilities: options.capabilities || [],
      tags: options.tags || [],
      status: 'active',
      origin: 'http://localhost',
      acceptsInvocations: options.acceptsInvocations ?? true,
      acceptsMessages: options.acceptsMessages ?? true,
      registeredAt: now,
      lastActiveAt: now,
    };
  }

  function summarize(info) {
    return {
      id: info.id,
      name: info.name,
      description: info.description,
      capabilities: info.capabilities,
      tags: info.tags,
      status: info.status,
      sameOrigin: true,
      isRemote: false,
    };
  }

  // Every agent on the site, this page's own included (Harbor's discover and list both return it).
  function allAgents() {
    const others = [...agentsState.others.values()].map(o => o.info);
    return agentsState.pageAgent ? [agentsState.pageAgent, ...others] : others;
  }

  function requirePageAgent(message) {
    if (!agentsState.pageAgentId) throw createApiError('ERR_NOT_REGISTERED', message);
    return agentsState.pageAgentId;
  }

  // agent.agents: the methods and shapes from extension/src/page-api/injected.ts.
  // Not mocked: subscribe/unsubscribe, broadcast (always fails in Harbor
  // today), orchestrate.*, remote and cross-origin agents.
  const agents = {
    async register(options) {
      checkFeature();
      if (!options?.name) throw createApiError('ERR_INVALID_REQUEST', 'Missing name');
      requireScope('agents:register');
      const info = makeAgentInfo(options);
      agentsState.pageAgentId = info.id;
      agentsState.pageAgent = info;
      return { ...info };
    },
    async unregister(agentId) {
      checkFeature();
      const id = agentId || agentsState.pageAgentId;
      if (!id) throw new Error('Agent not registered');
      requireScope('agents:register');
      if (id === agentsState.pageAgentId) {
        agentsState.pageAgentId = null;
        agentsState.pageAgent = null;
      }
    },
    async getInfo(agentId) {
      checkFeature();
      if (agentId === agentsState.pageAgentId) return { ...agentsState.pageAgent };
      const other = agentsState.others.get(agentId);
      return other ? { ...other.info } : null;
    },
    async discover(query = {}) {
      checkFeature();
      requireScope('agents:discover');
      if (query.includeSameOrigin === false) return { agents: [], total: 0 };
      const found = allAgents().filter(info =>
        info.status === 'active'
        && (!query.name || info.name.toLowerCase().includes(query.name.toLowerCase()))
        && (!query.capabilities?.length || query.capabilities.some(c => info.capabilities.includes(c)))
        && (!query.tags?.length || query.tags.some(t => info.tags.includes(t))));
      return { agents: found.map(summarize), total: found.length };
    },
    async list() {
      checkFeature();
      return allAgents().map(summarize);
    },
    async invoke(agentId, request) {
      checkFeature();
      if (!agentId || !request) throw createApiError('ERR_INVALID_REQUEST', 'Missing agentId or request');
      requireScope('agents:invoke');
      const from = requirePageAgent('Must register as an agent before invoking others');
      const target = agentsState.others.get(agentId);
      // Error codes and messages from extension/src/multi-agent/messaging.ts.
      if (!target) return { success: false, error: { code: 'ERR_AGENT_NOT_FOUND', message: 'Target agent not found' } };
      if (!target.info.acceptsInvocations) {
        return { success: false, error: { code: 'ERR_NOT_ACCEPTED', message: 'Target agent does not accept invocations' } };
      }
      if (!target.onInvoke) {
        return { success: false, error: { code: 'ERR_NO_HANDLER', message: 'Target agent has no invocation handler' } };
      }
      const started = Date.now();
      try {
        const result = await target.onInvoke({ ...request, from });
        return { success: true, result, executionTime: Date.now() - started };
      } catch (e) {
        return { success: false, error: { code: 'ERR_INVOCATION_FAILED', message: e instanceof Error ? e.message : String(e) } };
      }
    },
    async send(agentId, payload) {
      checkFeature();
      if (!agentId) throw createApiError('ERR_INVALID_REQUEST', 'Missing agentId');
      requireScope('agents:message');
      const from = requirePageAgent('Must register as an agent before sending messages');
      const target = agentsState.others.get(agentId);
      if (!target?.onMessage) return { delivered: false };
      target.onMessage({ id: `msg-mock-${agentsState.nextId++}`, from, to: agentId, type: 'request', payload, timestamp: Date.now() });
      return { delivered: true };
    },
    onMessage(handler) {
      checkFeature();
      agentsState.messageHandlers.push(handler);
      return () => { agentsState.messageHandlers = agentsState.messageHandlers.filter(h => h !== handler); };
    },
    onInvoke(handler) {
      checkFeature();
      agentsState.invokeHandlers.push(handler);
      return () => { agentsState.invokeHandlers = agentsState.invokeHandlers.filter(h => h !== handler); };
    },
  };

  const agent = {
    requestPermissions,
    permissions: {
      list: async () => ({ origin: 'http://localhost', scopes: scopesResult() }),
    },
    agents,
    tools: {
      list: async () => state.toolsList,
      call: async ({ tool, args }) => {
        if (state.toolCallError) {
          const e = createApiError(state.toolCallError.code || 'ERR_TOOL_FAILED', state.toolCallError.message || 'Tool failed');
          throw e;
        }
        return state.toolCallResult;
      },
    },
    run: async function* (options) {
      if (state.runError) {
        yield { type: 'error', error: { code: state.runError.code || 'ERR_AGENT_FAILED', message: state.runError.message || 'Run failed' } };
        return;
      }
      yield { type: 'status', message: 'Starting...' };
      yield { type: 'token', token: state.runOutput };
      yield { type: 'final', output: state.runOutput };
    },
  };

  function createTextSession(sessionOptions = {}) {
    const sessionId = 'mock-session-' + Math.random().toString(36).slice(2);
    return {
      sessionId,
      async prompt(input) {
        if (state.textSessionError) {
          const e = createApiError(state.textSessionError.code || 'ERR_MODEL_FAILED', state.textSessionError.message || 'Model failed');
          throw e;
        }
        return state.textSessionResponse;
      },
      async *promptStreaming(input) {
        if (state.textSessionError) {
          yield { type: 'error', error: { code: state.textSessionError.code || 'ERR_MODEL_FAILED', message: state.textSessionError.message || 'Model failed' } };
          return;
        }
        for (const token of (state.textSessionStreamTokens || [state.textSessionResponse])) {
          yield { type: 'token', token };
        }
        yield { type: 'done' };
      },
      async destroy() {},
    };
  }

  const ai = {
    createTextSession: async (options) => createTextSession(options),
  };

  const original = { ai: global.ai, agent: global.agent };
  global.ai = ai;
  global.agent = agent;

  const control = {
    uninstall() {
      global.ai = original.ai;
      global.agent = original.agent;
    },
    permissions: {
      /** The user allows every scope the page requests. Nothing is granted until it asks. */
      grantAll() { state.permissionPolicy = true; },
      /** The user denies every request, and any earlier grant is revoked. */
      denyAll() { state.permissionPolicy = null; state.granted.clear(); },
      /** These scopes are already granted (say, from an earlier visit); the user allows only these. */
      grantScopes(scopes) {
        state.permissionPolicy = new Set(scopes || []);
        state.granted = new Set(scopes || []);
      },
    },
    agents: {
      /** Off by default, like Harbor's multiAgent feature: agent.agents calls fail with ERR_FEATURE_DISABLED. Set to true to turn it on. */
      get featureEnabled() { return agentsState.featureEnabled; },
      set featureEnabled(v) { agentsState.featureEnabled = v; },
      /** The agent this page registered, or null. */
      get pageAgent() { return agentsState.pageAgent ? { ...agentsState.pageAgent } : null; },
      /**
       * Add an agent as if another tab on this site had registered it.
       * `onInvoke(request)` answers agent.agents.invoke(); `onMessage(message)` receives agent.agents.send().
       */
      addAgent(options, { onInvoke, onMessage } = {}) {
        const info = makeAgentInfo(options);
        agentsState.others.set(info.id, { info, onInvoke, onMessage });
        return { ...info };
      },
      removeAgent(agentId) { agentsState.others.delete(agentId); },
      /** Have another agent invoke this page; runs the page's onInvoke handler. */
      async invokePage(fromAgentId, request) {
        const handler = agentsState.invokeHandlers[0];
        if (!agentsState.pageAgentId || !handler) {
          return { success: false, error: { code: 'ERR_NO_HANDLER', message: 'Target agent has no invocation handler' } };
        }
        const started = Date.now();
        try {
          const result = await handler({ ...request, from: fromAgentId });
          return { success: true, result, executionTime: Date.now() - started };
        } catch (e) {
          return { success: false, error: { code: 'ERR_INVOCATION_FAILED', message: e instanceof Error ? e.message : String(e) } };
        }
      },
      /** Deliver a message from another agent to the page's onMessage handlers. */
      sendToPage(fromAgentId, payload) {
        const message = { id: `msg-mock-${agentsState.nextId++}`, from: fromAgentId, to: agentsState.pageAgentId, type: 'request', payload, timestamp: Date.now() };
        agentsState.messageHandlers.forEach(h => h(message));
        return message;
      },
    },
    ai: {
      get textSessionResponse() { return state.textSessionResponse; },
      set textSessionResponse(v) { state.textSessionResponse = v; },
      get textSessionStreamTokens() { return state.textSessionStreamTokens; },
      set textSessionStreamTokens(v) { state.textSessionStreamTokens = v; },
      get nextError() { return state.textSessionError; },
      set nextError(v) { state.textSessionError = v; },
    },
    agent: {
      get toolsList() { return state.toolsList; },
      set toolsList(v) { state.toolsList = v; },
      get toolCallResult() { return state.toolCallResult; },
      set toolCallResult(v) { state.toolCallResult = v; },
      get toolCallError() { return state.toolCallError; },
      set toolCallError(v) { state.toolCallError = v; },
      get runOutput() { return state.runOutput; },
      set runOutput(v) { state.runOutput = v; },
      get runError() { return state.runError; },
      set runError(v) { state.runError = v; },
    },
  };

  return control;
}
