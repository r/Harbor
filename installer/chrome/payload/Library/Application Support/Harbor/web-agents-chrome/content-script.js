// src/content-script.ts
var CHANNEL = "web_agents_api";
var backgroundPort = null;
var pendingRequests = /* @__PURE__ */ new Map();
var activeStreams = /* @__PURE__ */ new Map();
var agentEventForwardingSetup = false;
function getBackgroundPort() {
  if (!backgroundPort || !backgroundPort.name) {
    backgroundPort = chrome.runtime.connect({ name: "web-agent-transport" });
    backgroundPort.onMessage.addListener((message) => {
      if ("ok" in message) {
        const pending = pendingRequests.get(message.id);
        if (pending) {
          pendingRequests.delete(message.id);
          pending.sendResponse(message);
        }
      } else if ("event" in message) {
        const stream = activeStreams.get(message.id);
        if (stream) {
          stream.sendEvent(message);
          if (message.done) {
            activeStreams.delete(message.id);
          }
        }
      }
    });
    backgroundPort.onDisconnect.addListener(() => {
      backgroundPort = null;
      for (const [id, pending] of pendingRequests) {
        pending.sendResponse({
          id,
          ok: false,
          error: { code: "ERR_INTERNAL", message: "Background connection lost" }
        });
      }
      pendingRequests.clear();
      for (const [id, stream] of activeStreams) {
        stream.sendEvent({
          id,
          event: { type: "error", error: { code: "ERR_INTERNAL", message: "Background connection lost" } },
          done: true
        });
      }
      activeStreams.clear();
    });
  }
  return backgroundPort;
}
var DEFAULT_FLAGS = {
  textGeneration: true,
  toolCalling: false,
  toolAccess: true,
  browserInteraction: false,
  browserControl: false,
  multiAgent: false
};
async function getFeatureFlags() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "getFeatureFlags" }, (response) => {
      if (chrome.runtime.lastError || !response) {
        resolve(DEFAULT_FLAGS);
      } else {
        resolve(response);
      }
    });
  });
}
var injected = false;
function appendInjectedScripts(flags) {
  if (injected) return true;
  const root = document.head || document.documentElement;
  if (!root) return false;
  const flagsScript = document.createElement("script");
  flagsScript.type = "application/json";
  flagsScript.id = "web-agents-api-flags";
  flagsScript.textContent = JSON.stringify(flags);
  root.appendChild(flagsScript);
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("injected.js");
  script.async = false;
  script.onload = () => {
    script.remove();
  };
  script.onerror = () => {
    script.remove();
  };
  root.appendChild(script);
  injected = true;
  return true;
}
async function injectAgentsAPI() {
  document.documentElement?.setAttribute("data-web-agents-content-script", "true");
  const checkHarbor = () => {
    const harborInfo = window.__harbor;
    if (harborInfo?.extensionId) {
      chrome.runtime.sendMessage({
        type: "harbor_discovered",
        extensionId: harborInfo.extensionId
      });
    }
  };
  checkHarbor();
  window.addEventListener("harbor-discovered", checkHarbor);
  const flags = await getFeatureFlags();
  if (appendInjectedScripts(flags)) return;
  const retry = () => {
    if (appendInjectedScripts(flags)) {
      document.removeEventListener("readystatechange", retry);
      window.removeEventListener("DOMContentLoaded", retry);
    }
  };
  document.addEventListener("readystatechange", retry);
  window.addEventListener("DOMContentLoaded", retry);
}
window.addEventListener("message", async (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (data?.channel !== CHANNEL) return;
  if (data.abort) {
    const port2 = getBackgroundPort();
    port2.postMessage({ type: "abort", id: data.abort.id });
    activeStreams.delete(data.abort.id);
    return;
  }
  if (!data.request) return;
  const request = data.request;
  const isStreamingRequest = request.type === "session.promptStreaming" || request.type === "agent.run";
  const port = getBackgroundPort();
  if (isStreamingRequest) {
    activeStreams.set(request.id, {
      sendEvent: (streamEvent) => {
        window.postMessage({ channel: CHANNEL, streamEvent }, "*");
      }
    });
  } else {
    pendingRequests.set(request.id, {
      sendResponse: (response) => {
        window.postMessage({ channel: CHANNEL, response }, "*");
      }
    });
  }
  port.postMessage({
    ...request,
    origin: window.location.origin
  });
});
function setupAgentEventForwarding() {
  if (agentEventForwardingSetup) return;
  agentEventForwardingSetup = true;
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "agentEvent") {
      window.postMessage({
        channel: CHANNEL,
        agentEvent: message.event
      }, "*");
    }
    return false;
  });
}
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (data?.channel !== CHANNEL || !data.agentInvocationResponse) return;
  chrome.runtime.sendMessage({
    type: "agentInvocationResponse",
    response: data.agentInvocationResponse
  });
});
var processedInvocations = /* @__PURE__ */ new Set();
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "agentInvocation") {
    return false;
  }
  const trace = message.traceId || "no-trace";
  const invocationId = message.invocationId;
  if (processedInvocations.has(invocationId)) {
    console.log(`[TRACE ${trace}] Content: DUPLICATE invocation, skipping: ${invocationId}`);
    sendResponse({ ok: true, duplicate: true });
    return true;
  }
  processedInvocations.add(invocationId);
  setTimeout(() => processedInvocations.delete(invocationId), 6e4);
  console.log(`[TRACE ${trace}] Content: Forwarding invocation to page - task: ${message.task}, invocationId: ${invocationId}`);
  window.postMessage({
    channel: CHANNEL,
    agentEvent: {
      type: "invocation",
      invocation: {
        invocationId: message.invocationId,
        from: message.from,
        task: message.task,
        input: message.input
      }
    }
  }, "*");
  sendResponse({ ok: true });
  return true;
});
var pendingHarborInvocations = /* @__PURE__ */ new Map();
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.channel !== CHANNEL) return;
  if (data.agentInvocationResponse) {
    const { invocationId, success, result, error } = data.agentInvocationResponse;
    const resolver = pendingHarborInvocations.get(invocationId);
    if (resolver) {
      pendingHarborInvocations.delete(invocationId);
      resolver({ success, result, error });
    }
  }
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "harbor.forwardInvocation") {
    return false;
  }
  const trace = message.traceId || "no-trace";
  const { agentId, request } = message;
  const invocationId = `harbor-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  console.log(`[TRACE ${trace}] Content: Harbor forward invocation - agentId: ${agentId}, task: ${request?.task}`);
  pendingHarborInvocations.set(invocationId, (response) => {
    console.log(`[TRACE ${trace}] Content: Sending response back to Harbor`);
    sendResponse(response);
  });
  window.postMessage({
    channel: CHANNEL,
    agentEvent: {
      type: "invocation",
      invocation: {
        invocationId,
        from: request?.from,
        task: request?.task,
        input: request?.input
      }
    }
  }, "*");
  return true;
});
injectAgentsAPI().catch(console.error);
setupAgentEventForwarding();
//# sourceMappingURL=content-script.js.map
