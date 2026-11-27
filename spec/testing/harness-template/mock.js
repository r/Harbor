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
    // A policy refusal every policy-checked call gets, as Harbor's policy
    // engine would give it (ERR_BLOCKED_BY_POLICY, ERR_QUARANTINED), or null.
    policyRefusal: null,
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

  // Harbor runs model, tool, session and agent calls past its policy
  // engine, which can refuse them without a prompt.
  function checkPolicy() {
    if (state.policyRefusal) {
      const code = state.policyRefusal;
      throw createApiError(code, code === 'ERR_QUARANTINED'
        ? 'This site is quarantined.'
        : 'Blocked by policy.');
    }
  }

  // The grants a typed action in requestCapabilities() needs
  // (extension/src/page-api/injected.ts, scopesForTypedAction).
  function scopesForTypedAction(action) {
    if (action.startsWith('model.prompt')) return ['model:prompt'];
    if (action === 'tool.call') return ['mcp:tools.call'];
    if (action === 'browser.read.screenshot') return ['browser:activeTab.read', 'browser:activeTab.screenshot'];
    if (action.startsWith('browser.read.')) return ['browser:activeTab.read'];
    if (action.startsWith('browser.write.')) return ['browser:activeTab.interact'];
    return [];
  }

  // Like Harbor: an optional capability the site hasn't been granted is left
  // out; a required one it lacks refuses the whole session. Harbor checks
  // model:prompt for model access and mcp:tools.call for tools, then its
  // policy engine. Unlike Harbor, the mock doesn't narrow tools to the site's
  // tool allowlist or fail on a browser grant the site denied.
  async function requestCapabilities(opts = {}) {
    const optional = (opts.optional || []).filter(r => scopesForTypedAction(r.action).every(s => state.granted.has(s)));
    const all = [...(opts.require || []), ...optional];
    const llm = all.some(r => r.action.startsWith('model.prompt'));
    const tools = [];
    for (const r of all) {
      if (r.action === 'tool.call' && r.server && r.toolNames?.length) r.toolNames.forEach(t => tools.push(`${r.server}/${t}`));
      else if (r.action === 'tool.call' && r.server) tools.push(`${r.server}/*`);
    }
    for (const [needed, scope] of [[llm, 'model:prompt'], [tools.length > 0, 'mcp:tools.call']]) {
      if (needed && !state.granted.has(scope)) {
        throw createApiError('ERR_PERMISSION_DENIED', `Permission ${scope} required`);
      }
    }
    checkPolicy();
    const capabilities = {
      llm: { allowed: llm },
      tools: { allowed: tools.length > 0, allowedTools: tools },
      browser: {
        readActiveTab: all.some(r => r.action.startsWith('browser.read.')),
        interact: all.some(r => r.action.startsWith('browser.write.')),
        screenshot: all.some(r => r.action === 'browser.read.screenshot'),
      },
      ...(opts.budget ? { limits: { maxToolCalls: opts.budget.maxToolCalls } } : {}),
    };
    const sessionId = 'mock-session-' + Math.random().toString(36).slice(2);
    const text = createTextSession();
    return Object.freeze({
      sessionId,
      capabilities,
      async prompt(input) {
        if (!llm) throw new Error('Session does not have LLM access');
        return text.prompt(input);
      },
      promptStreaming(input) {
        if (!llm) throw new Error('Session does not have LLM access');
        return text.promptStreaming(input);
      },
      async callTool(tool, args) {
        if (!capabilities.tools.allowed) throw new Error('Session does not have tool access');
        if (!tools.includes(tool)) throw new Error(`Tool ${tool} not allowed in this session`);
        return agent.tools.call({ tool, args });
      },
      listAllowedTools() { return tools; },
      async terminate() {},
    });
  }

  // Harbor asks the user when a page calls the agent API without the scope.
  // The mock can't show that prompt, so it fails as Harbor does when the
  // person declines: a test then shows whether the page requested the scope
  // before using it.
  function requireScope(scope) {
    if (!state.granted.has(scope)) {
      throw createApiError('ERR_PERMISSION_DENIED', `Permission "${scope}" is required. Request it with agent.requestPermissions().`);
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
    waiting: new Map(), // agentId -> Set of settle functions for invocations still waiting on it
  };

  // Harbor's invocation timeout (extension/src/multi-agent/messaging.ts):
  // 30 seconds unless the caller asks, capped at 5 minutes.
  function invocationTimeoutMs(requested) {
    if (typeof requested !== 'number' || Number.isNaN(requested) || requested <= 0) return 30_000;
    return Math.min(requested, 5 * 60_000);
  }

  /**
   * Run one invocation the way Harbor does: the handler gets a signal that
   * aborts when the invocation is over for the caller, Harbor answers
   * ERR_TIMEOUT when the timeout runs out and ERR_AGENT_NOT_FOUND when the
   * agent's page goes, and only an answer the agent gave carries provenance.
   */
  function runInvocation(agentId, info, handler, request) {
    const controller = new AbortController();
    const started = Date.now();
    return new Promise((resolve) => {
      let done = false;
      const settle = (response) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        agentsState.waiting.get(agentId)?.delete(gone);
        if (!response.success && !response.provenance) controller.abort();
        resolve({ executionTime: Date.now() - started, ...response });
      };
      const gone = () => settle({ success: false, error: { code: 'ERR_AGENT_NOT_FOUND', message: "The agent's page is gone" } });
      if (!agentsState.waiting.has(agentId)) agentsState.waiting.set(agentId, new Set());
      agentsState.waiting.get(agentId).add(gone);
      const timer = setTimeout(
        () => settle({ success: false, error: { code: 'ERR_TIMEOUT', message: 'Invocation timed out' } }),
        invocationTimeoutMs(request.timeout),
      );
      Promise.resolve()
        .then(() => handler({ ...request, signal: controller.signal }))
        .then(
          (result) => settle({ success: true, result, provenance: provenanceOf(info) }),
          // In Harbor a page agent's handler that throws still answers, as ERR_HANDLER_FAILED.
          (e) => settle({
            success: false,
            error: { code: 'ERR_HANDLER_FAILED', message: e instanceof Error ? e.message : String(e) },
            provenance: provenanceOf(info),
          }),
        );
    });
  }

  function checkFeature() {
    if (!agentsState.featureEnabled) {
      throw createApiError('ERR_FEATURE_DISABLED', 'Feature "multiAgent" is not enabled. Enable it in Web Agents API settings.');
    }
  }

  // Which site's agent sent an answer, as Harbor stamps it (extension/src/multi-agent/messaging.ts).
  function provenanceOf(info) {
    return info ? { source: 'agent', origin: info.origin, agentId: info.id } : undefined;
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

  function removeOther(agentId) {
    agentsState.others.delete(agentId);
    for (const gone of [...(agentsState.waiting.get(agentId) ?? [])]) gone();
    agentsState.waiting.delete(agentId);
  }

  // agent.agents: the methods and shapes from extension/src/page-api/injected.ts.
  // Not mocked: subscribe/unsubscribe, broadcast, orchestrate.*, remote and
  // cross-origin agents.
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
      } else if (agentsState.others.has(id)) {
        // Another tab's agent on this site, which Harbor lets the site unregister.
        removeOther(id);
      } else {
        // Harbor answers this for another site's agent too, so it doesn't reveal one.
        throw createApiError('ERR_AGENT_NOT_FOUND', 'Agent not found');
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
      return allAgents().map(({ id, name, status }) => ({ id, name, status }));
    },
    async invoke(agentId, request) {
      checkFeature();
      if (!agentId || !request) throw createApiError('ERR_INVALID_REQUEST', 'Missing agentId or request');
      requireScope('agents:invoke');
      checkPolicy();
      const from = requirePageAgent('Must register as an agent before invoking others');
      const target = agentsState.others.get(agentId);
      // Error codes and messages from extension/src/multi-agent/messaging.ts.
      if (!target) return { success: false, error: { code: 'ERR_AGENT_NOT_FOUND', message: 'Target agent not found' } };
      if (!target.info.acceptsInvocations) {
        return { success: false, error: { code: 'ERR_AGENT_NOT_ACCEPTING', message: 'Target agent does not accept invocations' } };
      }
      if (!target.onInvoke) {
        return { success: false, error: { code: 'ERR_AGENT_NOT_ACCEPTING', message: 'Target agent has no invocation handler' } };
      }
      return runInvocation(agentId, target.info, target.onInvoke, { ...request, from });
    },
    async send(agentId, payload) {
      checkFeature();
      if (!agentId) throw createApiError('ERR_INVALID_REQUEST', 'Missing agentId');
      requireScope('agents:message');
      checkPolicy();
      const from = requirePageAgent('Must register as an agent before sending messages');
      const target = agentsState.others.get(agentId);
      if (!target?.onMessage) return { delivered: false };
      target.onMessage({
        id: `msg-mock-${agentsState.nextId++}`, from, to: agentId, type: 'request', payload, timestamp: Date.now(),
        provenance: provenanceOf(agentsState.pageAgent),
      });
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
    requestCapabilities,
    permissions: {
      list: async () => ({ origin: 'http://localhost', scopes: scopesResult() }),
    },
    agents,
    tools: {
      list: async () => state.toolsList,
      call: async ({ tool, args }) => {
        checkPolicy();
        if (state.toolCallError) {
          const e = createApiError(state.toolCallError.code || 'ERR_TOOL_FAILED', state.toolCallError.message || 'Tool failed');
          throw e;
        }
        return state.toolCallResult;
      },
    },
    run: async function* (options) {
      if (state.policyRefusal) {
        yield { type: 'error', error: { code: state.policyRefusal, message: 'Blocked by policy.' } };
        return;
      }
      if (state.runError) {
        yield { type: 'error', error: { code: state.runError.code || 'ERR_AGENT_FAILED', message: state.runError.message || 'Run failed' } };
        return;
      }
      yield { type: 'status', message: 'Starting...' };
      yield { type: 'token', token: state.runOutput };
      yield { type: 'final', output: state.runOutput };
    },
  };

  function checkTextSessionError() {
    checkPolicy();
    if (state.textSessionError) {
      throw createApiError(state.textSessionError.code || 'ERR_MODEL_FAILED', state.textSessionError.message || 'Model failed');
    }
  }

  function createTextSession(sessionOptions = {}) {
    const sessionId = 'mock-session-' + Math.random().toString(36).slice(2);
    return {
      sessionId,
      async prompt(input) {
        checkTextSessionError();
        return state.textSessionResponse;
      },
      async *promptStreaming(input) {
        checkTextSessionError();
        for (const token of (state.textSessionStreamTokens || [state.textSessionResponse])) {
          if (token) yield token;
        }
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
    policy: {
      /**
       * Harbor's policy engine refuses every model, tool, session and agent
       * call with this code until reset(): 'ERR_BLOCKED_BY_POLICY' (a user or
       * organization rule) or 'ERR_QUARANTINED' (the watchdog quarantined the site).
       */
      refuse(code = 'ERR_BLOCKED_BY_POLICY') { state.policyRefusal = code; },
      /** Calls go through again. */
      reset() { state.policyRefusal = null; },
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
      /** The agent's page goes: invocations waiting on it fail at once with ERR_AGENT_NOT_FOUND. */
      removeAgent(agentId) { removeOther(agentId); },
      /**
       * Have another agent invoke this page; runs the page's onInvoke handler,
       * whose request.signal aborts if the invocation times out.
       */
      async invokePage(fromAgentId, request) {
        const handler = agentsState.invokeHandlers[0];
        if (!agentsState.pageAgentId || !handler) {
          return { success: false, error: { code: 'ERR_AGENT_NOT_ACCEPTING', message: 'Target agent has no invocation handler' } };
        }
        return runInvocation(agentsState.pageAgentId, agentsState.pageAgent, handler, { ...request, from: fromAgentId });
      },
      /** Deliver a message from another agent to the page's onMessage handlers. */
      sendToPage(fromAgentId, payload) {
        const message = {
          id: `msg-mock-${agentsState.nextId++}`, from: fromAgentId, to: agentsState.pageAgentId, type: 'request', payload, timestamp: Date.now(),
          provenance: provenanceOf(agentsState.others.get(fromAgentId)?.info),
        };
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
