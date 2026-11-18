/**
 * Mock implementation of the Web Agent API (window.ai and window.agent)
 * for unit/integration tests. Install on globalThis or window so your app
 * code sees the same API without a real browser or extensions.
 *
 * Usage:
 *   const mock = installWebAgentsMock(globalThis);
 *   mock.permissions.grantAll();
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
    permissionGrants: null, // null = use default (deny); {} = grant all; or { scope: 'granted-always' }
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

  function buildScopesResult(grantType = 'not-granted') {
    const scopes = [
      'model:prompt', 'model:tools', 'mcp:tools.list', 'mcp:tools.call',
      'browser:activeTab.read', 'browser:activeTab.interact', 'browser:tabs.read', 'browser:tabs.create', 'web:fetch',
    ];
    return Object.fromEntries(scopes.map(s => [s, grantType]));
  }

  const agent = {
    requestPermissions: async (options) => {
      if (state.permissionGrants === null) {
        return { granted: false, scopes: buildScopesResult('denied') };
      }
      if (state.permissionGrants === true || (typeof state.permissionGrants === 'object' && Object.keys(state.permissionGrants).length === 0)) {
        const scopes = buildScopesResult('granted-always');
        if (options.scopes) options.scopes.forEach(s => { scopes[s] = 'granted-always'; });
        return { granted: true, scopes };
      }
      const scopes = buildScopesResult('not-granted');
      Object.assign(scopes, state.permissionGrants);
      const granted = Object.values(scopes).some(g => g === 'granted-always' || g === 'granted-once');
      return { granted, scopes };
    },
    permissions: {
      list: async () => ({
        origin: 'http://localhost',
        scopes: state.permissionGrants === true || state.permissionGrants === null
          ? buildScopesResult(state.permissionGrants === true ? 'granted-always' : 'not-granted')
          : state.permissionGrants,
      }),
    },
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
      grantAll() { state.permissionGrants = true; },
      denyAll() { state.permissionGrants = null; },
      grantScopes(scopes) {
        state.permissionGrants = buildScopesResult('not-granted');
        (scopes || []).forEach(s => { state.permissionGrants[s] = 'granted-always'; });
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
