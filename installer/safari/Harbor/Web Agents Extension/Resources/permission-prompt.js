// src/permission-prompt.ts
var SCOPE_DESCRIPTIONS = {
  "model:prompt": {
    title: "Text Generation",
    description: "Generate text using AI models. The site can send prompts and receive responses.",
    risk: "low"
  },
  "model:list": {
    title: "List Providers",
    description: "View available AI providers and models.",
    risk: "low"
  },
  "mcp:tools.list": {
    title: "List Tools",
    description: "View available MCP tools that can be called.",
    risk: "low"
  },
  "mcp:tools.call": {
    title: "Execute Tools",
    description: "Call MCP tools to perform actions. Tools may access external services.",
    risk: "medium"
  }
};
var SCOPE_ICONS = {
  "model:prompt": "\u{1F916}",
  "model:list": "\u{1F4CB}",
  "mcp:tools.list": "\u{1F50C}",
  "mcp:tools.call": "\u26A1"
};
function getSystemTheme() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function applyTheme(theme) {
  const effectiveTheme = theme === "system" ? getSystemTheme() : theme;
  document.documentElement.setAttribute("data-theme", effectiveTheme);
}
function initTheme() {
  const saved = localStorage.getItem("harbor-theme");
  const theme = saved || "system";
  applyTheme(theme);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    const current = localStorage.getItem("harbor-theme");
    if (current === "system" || !current) {
      applyTheme("system");
    }
  });
}
initTheme();
var params = new URLSearchParams(window.location.search);
var promptId = params.get("promptId") || "";
var origin = params.get("origin") || "Unknown";
var scopesParam = params.get("scopes") || "";
var reason = params.get("reason") || "";
var toolsParam = params.get("tools") || "";
var scopes = scopesParam.split(",").filter(Boolean);
var tools = toolsParam.split(",").filter(Boolean);
var originEl = document.getElementById("origin");
if (originEl) {
  originEl.textContent = origin;
}
if (reason) {
  const reasonContainer = document.getElementById("reason-container");
  const reasonEl = document.getElementById("reason");
  if (reasonContainer && reasonEl) {
    reasonContainer.style.display = "block";
    reasonEl.textContent = reason;
  }
}
var scopesList = document.getElementById("scopes-list");
if (scopesList) {
  if (scopes.length === 0) {
    const empty = document.createElement("div");
    empty.className = "scopes-empty";
    empty.textContent = "No specific permissions requested";
    scopesList.appendChild(empty);
  } else {
    for (const scope of scopes) {
      const info = SCOPE_DESCRIPTIONS[scope];
      const icon = SCOPE_ICONS[scope] || "\u{1F510}";
      const item = document.createElement("div");
      item.className = "scope-item";
      if (info) {
        item.innerHTML = `
          <div class="scope-header">
            <span class="scope-icon">${icon}</span>
            <span class="scope-title">${info.title}</span>
            <span class="risk-badge risk-${info.risk}">${info.risk}</span>
          </div>
          <div class="scope-description">${info.description}</div>
        `;
      } else {
        item.innerHTML = `
          <div class="scope-header">
            <span class="scope-icon">${icon}</span>
            <span class="scope-title">${scope}</span>
          </div>
          <div class="scope-description">Access to ${scope}</div>
        `;
      }
      scopesList.appendChild(item);
    }
  }
}
if (tools.length > 0) {
  const toolsSection = document.getElementById("tools-section");
  const toolsList = document.getElementById("tools-list");
  if (toolsSection && toolsList) {
    toolsSection.style.display = "block";
    for (const tool of tools) {
      const item = document.createElement("div");
      item.className = "tool-item";
      item.innerHTML = `
        <input type="checkbox" id="tool-${tool}" data-tool="${tool}" checked>
        <label for="tool-${tool}" class="tool-name">${tool}</label>
      `;
      toolsList.appendChild(item);
    }
  }
}
var btnDeny = document.getElementById("btn-deny");
btnDeny?.addEventListener("click", () => {
  sendResponse({ granted: false, explicitDeny: true });
});
var btnAllow = document.getElementById("btn-grant");
btnAllow?.addEventListener("click", () => {
  const grantOnce = document.getElementById("grant-once")?.checked;
  const grantType = grantOnce ? "granted-once" : "granted-always";
  const selectedTools = [];
  const toolCheckboxes = document.querySelectorAll('#tools-list input[type="checkbox"]');
  for (const checkbox of toolCheckboxes) {
    if (checkbox.checked) {
      const toolName = checkbox.dataset.tool;
      if (toolName) selectedTools.push(toolName);
    }
  }
  sendResponse({
    granted: true,
    grantType,
    allowedTools: selectedTools.length > 0 ? selectedTools : void 0
  });
});
function sendResponse(response) {
  console.log("[Permission Prompt] Sending response:", response);
  chrome.runtime.sendMessage({
    type: "permission_prompt_response",
    response: { promptId, ...response }
  });
}
//# sourceMappingURL=permission-prompt.js.map
