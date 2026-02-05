/**
 * Web Agent API Chat Demo - Example Code
 * 
 * This demonstrates using the Web Agent API (window.ai and window.agent)
 * that Web Agents API implementations provide to web pages.
 * 
 * WEB AGENT API REFERENCE:
 * 
 * window.ai - Text generation API
 *   .createTextSession(options?) → TextSession
 *     options: { systemPrompt?: string, temperature?: number }
 *   
 *   TextSession:
 *     .prompt(text) → Promise<string>  (non-streaming)
 *     .promptStreaming(text) → AsyncIterable<StreamToken>
 *     .destroy() → Promise<void>
 * 
 * window.agent - Agent API with tools
 *   .requestPermissions({ scopes, reason? }) → Promise<PermissionResult>
 *   .permissions.list() → Promise<PermissionStatus>
 *   .tools.list() → Promise<ToolDescriptor[]>
 *   .tools.call({ tool, args }) → Promise<unknown>
 *   .browser.activeTab.readability() → Promise<TabContent>
 *   .run({ task, tools?, maxToolCalls?, useAllTools? }) → AsyncIterable<RunEvent>
 * 
 * Note: The tool router is built into agent.run() and automatically selects
 * relevant tools based on your task. This helps local LLMs perform better
 * by not overwhelming them with too many tool options.
 * 
 * See README.md and the Web Agent API spec for more details.
 */

// =============================================================================
// State
// =============================================================================

let session = null;
let messages = [];
let useTools = true;
let useTabContext = false;
let isProcessing = false;
let availableTools = [];

// =============================================================================
// DOM Elements
// =============================================================================

const chatContainer = document.getElementById('chat-container');
const messagesEl = document.getElementById('messages');
const emptyState = document.getElementById('empty-state');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const toolsToggle = document.getElementById('tools-toggle');
const tabToggle = document.getElementById('tab-toggle');
const clearBtn = document.getElementById('clear-btn');
const themeToggle = document.getElementById('theme-toggle');
const docsToggle = document.getElementById('docs-toggle');
const docsPanel = document.getElementById('docs-panel');
const docsClose = document.getElementById('docs-close');

const extensionStatus = document.getElementById('extension-status');
const extensionStatusText = document.getElementById('extension-status-text');
const llmStatus = document.getElementById('llm-status');
const llmStatusText = document.getElementById('llm-status-text');
const toolsStatus = document.getElementById('tools-status');
const toolsStatusText = document.getElementById('tools-status-text');
const toolsStatusItem = document.getElementById('tools-status-item');
const sessionText = document.getElementById('session-text');

// Tools modal elements
const toolsModal = document.getElementById('tools-modal');
const toolsModalClose = document.getElementById('tools-modal-close');
const toolsModalContent = document.getElementById('tools-modal-content');
const toolsModalCount = document.getElementById('tools-modal-count');

// =============================================================================
// Theme Management
// =============================================================================

function initTheme() {
  const saved = localStorage.getItem('demo-chat-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (prefersDark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
  themeToggle.textContent = theme === 'dark' ? '○' : '●';
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('demo-chat-theme', next);
  themeToggle.textContent = next === 'dark' ? '○' : '●';
}

// =============================================================================
// Status Checking
// =============================================================================

/**
 * Check if the Web Agent API is available
 */
function checkExtension() {
  if (typeof window.ai !== 'undefined' && typeof window.agent !== 'undefined') {
    extensionStatus.classList.add('success');
    extensionStatusText.textContent = 'Web Agent API available';
    return true;
  }
  
  extensionStatus.classList.add('error');
  extensionStatusText.textContent = 'API not found';
  return false;
}

/**
 * Check LLM availability by checking for configured providers
 */
async function checkLLM() {
  try {
    console.log('[Demo] Checking LLM...');
    
    // First check if there are any providers configured
    const providers = await window.ai.providers.list();
    console.log('[Demo] Providers:', providers);
    
    if (!providers || providers.length === 0) {
      console.log('[Demo] No LLM providers configured');
      llmStatus.classList.add('warning');
      llmStatusText.textContent = 'No LLM configured';
      return false;
    }
    
    // Create a test session to verify it works
    console.log('[Demo] Creating test LLM session...');
    const testSession = await window.ai.createTextSession();
    console.log('[Demo] Test session created, destroying...');
    await testSession.destroy();
    console.log('[Demo] LLM check passed');
    
    llmStatus.classList.add('success');
    llmStatusText.textContent = 'LLM Ready';
    return true;
  } catch (err) {
    console.error('[Demo] LLM check failed:', err?.message || err);
    llmStatus.classList.add('warning');
    llmStatusText.textContent = `LLM: ${err?.message?.slice(0, 20) || 'Error'}`;
    return false;
  }
}

/**
 * Check available MCP tools
 */
async function checkTools() {
  try {
    console.log('[Demo] Listing tools...');
    const tools = await window.agent.tools.list();
    console.log('[Demo] Got tools:', tools?.length);
    availableTools = tools; // Store for modal
    if (tools.length > 0) {
      toolsStatus.classList.add('success');
      toolsStatusText.textContent = `Tools: ${tools.length}`;
      return tools;
    } else {
      toolsStatus.classList.add('warning');
      toolsStatusText.textContent = 'No tools';
      return [];
    }
  } catch (err) {
    console.error('[Demo] Tools check failed:', err);
    toolsStatus.classList.add('error');
    toolsStatusText.textContent = 'Tools: Error';
    return [];
  }
}

// =============================================================================
// Tools Modal
// =============================================================================

function showToolsModal() {
  renderToolsList();
  toolsModal.style.display = 'flex';
}

function hideToolsModal() {
  toolsModal.style.display = 'none';
}

function renderToolsList() {
  toolsModalCount.textContent = availableTools.length;
  
  if (availableTools.length === 0) {
    toolsModalContent.innerHTML = `
      <div class="tools-empty">
        <div class="tools-empty-icon">🔌</div>
        <p>No tools available.<br>Start an MCP server to see tools here.</p>
      </div>
    `;
    return;
  }
  
  // Group tools by server
  const toolsByServer = {};
  for (const tool of availableTools) {
    // Parse server from tool name (format: "server__toolname" or just "toolname")
    const parts = tool.name.split('__');
    const server = parts.length > 1 ? parts[0] : 'default';
    const shortName = parts.length > 1 ? parts.slice(1).join('__') : tool.name;
    
    if (!toolsByServer[server]) {
      toolsByServer[server] = [];
    }
    toolsByServer[server].push({ ...tool, shortName, server });
  }
  
  let html = '';
  for (const [server, tools] of Object.entries(toolsByServer)) {
    for (const tool of tools) {
      const description = tool.description || 'No description available';
      const schemaStr = tool.inputSchema 
        ? JSON.stringify(tool.inputSchema, null, 2)
        : '{}';
      
      html += `
        <div class="tool-item" onclick="this.classList.toggle('expanded')">
          <div class="tool-item-header">
            <span class="tool-item-name">${escapeHtml(tool.shortName)}</span>
            <span class="tool-item-server">${escapeHtml(server)}</span>
          </div>
          <div class="tool-item-description">${escapeHtml(description)}</div>
          <div class="tool-item-schema">${escapeHtml(schemaStr)}</div>
        </div>
      `;
    }
  }
  
  toolsModalContent.innerHTML = html;
}

function updateSessionInfo() {
  if (session) {
    sessionText.textContent = `Session: ${session.sessionId.slice(-8)}`;
  } else {
    sessionText.textContent = 'No session';
  }
}

// =============================================================================
// Message Rendering
// =============================================================================

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showMessages() {
  emptyState.style.display = 'none';
}

function addMessageUI(role, content) {
  showMessages();
  messages.push({ role, content });
  
  const messageEl = document.createElement('div');
  messageEl.className = `message ${role}`;
  
  const avatar = role === 'user' ? 'U' : role === 'assistant' ? 'A' : 'S';
  const roleName = role === 'user' ? 'You' : role === 'assistant' ? 'Assistant' : 'System';
  
  const bodyHtml = content.split('\n').map(line => `<p>${escapeHtml(line) || '&nbsp;'}</p>`).join('');
  
  messageEl.innerHTML = `
    <div class="message-header">
      <div class="message-avatar">${avatar}</div>
      <span class="message-role">${roleName}</span>
      <span class="message-time">${new Date().toLocaleTimeString()}</span>
    </div>
    <div class="message-body">${bodyHtml}</div>
  `;
  
  messagesEl.appendChild(messageEl);
  scrollToBottom();
  
  return messageEl;
}

function addToolCallUI(name, args, status, result) {
  const toolEl = document.createElement('div');
  toolEl.className = 'tool-call';
  
  const statusIcon = status === 'pending' ? '⏳' : status === 'success' ? '✓' : '✕';
  
  toolEl.innerHTML = `
    <div class="tool-call-header" onclick="this.nextElementSibling.classList.toggle('collapsed')">
      <span>🔧</span>
      <span class="tool-call-name">${escapeHtml(name)}</span>
      <span class="tool-call-status ${status}">${statusIcon} ${status}</span>
    </div>
    <div class="tool-call-content">Args: ${escapeHtml(JSON.stringify(args, null, 2))}${result !== undefined ? '\n\nResult: ' + escapeHtml(typeof result === 'string' ? result : JSON.stringify(result, null, 2)) : ''}</div>
  `;
  
  messagesEl.appendChild(toolEl);
  scrollToBottom();
  
  return toolEl;
}

function updateToolCallUI(toolEl, status, result) {
  const statusEl = toolEl.querySelector('.tool-call-status');
  const contentEl = toolEl.querySelector('.tool-call-content');
  
  const statusIcon = status === 'success' ? '✓' : '✕';
  statusEl.className = `tool-call-status ${status}`;
  statusEl.textContent = `${statusIcon} ${status}`;
  
  const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  contentEl.textContent += '\n\nResult: ' + resultStr;
}

function addThinkingUI(initialText = 'Thinking...') {
  showMessages();
  
  // Remove any existing thinking indicator first to prevent duplicates
  removeThinking();
  
  const thinkingEl = document.createElement('div');
  thinkingEl.className = 'message assistant';
  thinkingEl.id = 'thinking';
  thinkingEl.innerHTML = `
    <div class="message-header">
      <div class="message-avatar">A</div>
      <span class="message-role">Assistant</span>
    </div>
    <div class="message-body">
      <div class="thinking">
        <div class="thinking-dots"><span></span><span></span><span></span></div>
        <span id="thinking-text">${initialText}</span>
      </div>
    </div>
  `;
  
  messagesEl.appendChild(thinkingEl);
  scrollToBottom();
  
  return thinkingEl;
}

function updateThinkingText(text) {
  const el = document.getElementById('thinking-text');
  if (el) {
    // Clear and set to ensure clean update (no leftover text)
    el.innerHTML = '';
    el.textContent = text;
  }
}

function removeThinking() {
  const el = document.getElementById('thinking');
  if (el) el.remove();
}

function scrollToBottom() {
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function clearChat() {
  messages.length = 0;
  messagesEl.innerHTML = '';
  messagesEl.appendChild(emptyState);
  emptyState.style.display = 'flex';
  
  // Destroy and reset session
  if (session) {
    session.destroy();
    session = null;
  }
  updateSessionInfo();
}

// =============================================================================
// Chat Logic
// =============================================================================

async function sendMessage() {
  const content = messageInput.value.trim();
  if (!content || isProcessing) return;
  
  // Check if Web Agent API is available
  if (!window.ai || !window.agent) {
    addMessageUI('system', 'Web Agent API not detected. Please install a Web Agents API implementation and reload.');
    return;
  }
  
  isProcessing = true;
  sendBtn.disabled = true;
  messageInput.value = '';
  autoResizeInput();
  
  // Add user message to UI
  addMessageUI('user', content);
  
  // Create a text session if we don't have one
  if (!session) {
    try {
      // EXAMPLE: Creating a text session with window.ai
      session = await window.ai.createTextSession({
        systemPrompt: 'You are a helpful assistant.',
      });
      updateSessionInfo();
    } catch (err) {
      addMessageUI('assistant', 'Failed to connect to LLM. Make sure Ollama or another LLM is running.');
      isProcessing = false;
      sendBtn.disabled = false;
      return;
    }
  }
  
  // Run with or without tools based on toggle
  if (useTools) {
    await runWithTools(content);
  } else {
    await runSimple(content);
  }
  
  isProcessing = false;
  sendBtn.disabled = false;
}

/**
 * Simple prompt without tools - uses window.ai text session
 * 
 * EXAMPLE: Basic text generation
 */
async function runSimple(content) {
  addThinkingUI();
  
  try {
    // Get tab context if enabled
    let fullContent = content;
    if (useTabContext) {
      try {
        updateThinkingText('Reading active tab...');
        // EXAMPLE: Reading the active tab's content
        const tab = await window.agent.browser.activeTab.readability();
        fullContent = `Context from active tab (${tab.title}):\n${tab.text.slice(0, 2000)}\n\n---\n\nUser question: ${content}`;
      } catch (err) {
        console.warn('[Demo] Could not read tab:', err);
      }
    }
    
    updateThinkingText('Generating response...');
    
    // EXAMPLE: Streaming tokens from the LLM
    let responseText = '';
    let messageEl = null;
    
    for await (const event of session.promptStreaming(fullContent)) {
      if (event.type === 'token' && event.token) {
        responseText += event.token;
        
        if (!messageEl) {
          removeThinking();
          messageEl = addMessageUI('assistant', responseText);
        } else {
          const body = messageEl.querySelector('.message-body');
          if (body) {
            body.innerHTML = responseText.split('\n').map(line => `<p>${escapeHtml(line) || '&nbsp;'}</p>`).join('');
          }
        }
        scrollToBottom();
      } else if (event.type === 'error') {
        removeThinking();
        addMessageUI('assistant', `Error: ${event.error?.message || 'Unknown error'}`);
        return;
      }
    }
    
    removeThinking();
  } catch (err) {
    removeThinking();
    addMessageUI('assistant', `Error: ${err}`);
  }
}

/**
 * Agent run with tools - uses window.agent.run()
 * 
 * EXAMPLE: Running an agent with MCP tools
 * 
 * NOTE: The tool router is built-in and automatically selects relevant tools
 * based on your task. For example, if you mention "GitHub", only GitHub-related
 * tools will be presented to the LLM. This improves performance with local models.
 * 
 * To disable the router and use all tools, pass { useAllTools: true }
 */
async function runWithTools(content) {
  addThinkingUI('Initializing agent...');
  
  try {
    // Get tab context if enabled
    let task = content;
    if (useTabContext) {
      try {
        updateThinkingText('Reading active tab...');
        const tab = await window.agent.browser.activeTab.readability();
        task = `Context from active tab (${tab.title}):\n${tab.text.slice(0, 2000)}\n\n---\n\nUser request: ${content}`;
      } catch (err) {
        console.warn('[Demo] Could not read tab:', err);
      }
    }
    
    let responseText = '';
    let messageEl = null;
    const toolElements = new Map();
    
    // EXAMPLE: Streaming events from window.agent.run()
    // The tool router is built-in - it automatically selects relevant tools
    // based on keywords in your task. You don't need to do anything special!
    for await (const event of window.agent.run({ 
      task, 
      maxToolCalls: 5,
      // useAllTools: true,  // Uncomment to disable tool router
    })) {
      switch (event.type) {
        case 'status':
          updateThinkingText(event.message);
          break;
          
        case 'tool_call':
          // Tool is being called
          removeThinking();
          const toolEl = addToolCallUI(event.tool, event.args, 'pending');
          toolElements.set(event.tool, toolEl);
          addThinkingUI('Waiting for tool result...');
          break;
          
        case 'tool_result':
          // Tool returned a result
          const el = toolElements.get(event.tool);
          if (el) {
            updateToolCallUI(el, event.error ? 'error' : 'success', event.result);
          }
          break;
          
        case 'token':
          // Streaming text token
          if (event.token) {
            responseText += event.token;
            
            if (!messageEl) {
              removeThinking();
              messageEl = addMessageUI('assistant', responseText);
            } else {
              const body = messageEl.querySelector('.message-body');
              if (body) {
                body.innerHTML = responseText.split('\n').map(line => `<p>${escapeHtml(line) || '&nbsp;'}</p>`).join('');
              }
            }
            scrollToBottom();
          }
          break;
          
        case 'final':
          // Agent completed
          console.log('[Demo] Agent final event:', event);
          removeThinking();
          
          // Display the final output - ALWAYS show it regardless of token state
          const finalText = event.output || '';
          console.log('[Demo] Final text to display:', finalText, 'existing messageEl:', !!messageEl, 'responseText:', responseText);
          
          if (finalText) {
            // Always create/update the message with the final text
            if (!messageEl) {
              messageEl = addMessageUI('assistant', finalText);
            } else {
              // Force update the body with final text
              const body = messageEl.querySelector('.message-body');
              if (body) {
                body.innerHTML = finalText.split('\n').map(line => `<p>${escapeHtml(line) || '&nbsp;'}</p>`).join('');
              }
            }
          } else if (!messageEl && !responseText) {
            // No output at all - show a placeholder
            messageEl = addMessageUI('assistant', '(No response)');
          }
          
          // Update any pending tool calls to complete (in case tool_result was missed)
          for (const [toolName, toolEl] of toolElements) {
            const statusEl = toolEl.querySelector('.tool-status');
            if (statusEl && statusEl.textContent === 'pending') {
              statusEl.textContent = 'done';
              statusEl.className = 'tool-status success';
            }
          }
          
          // Show citations if present
          if (event.citations && event.citations.length > 0) {
            const citationText = event.citations.map(c => `• ${c.source}: ${c.ref}`).join('\n');
            addMessageUI('system', `Sources:\n${citationText}`);
          }
          
          // If tools were available but LLM didn't use them, show a hint
          if (availableTools.length > 0 && toolElements.size === 0) {
            console.log('[Demo] LLM did not use any tools. Available tools:', availableTools.length);
          }
          break;
          
        case 'error':
          console.error('[Demo] Agent error:', event.error);
          removeThinking();
          // Provide helpful error messages
          let errorMsg = event.error.message;
          if (event.error.code === 'ERR_LLM_FAILED' || errorMsg.includes('NetworkError') || errorMsg.includes('fetch')) {
            errorMsg = 'LLM connection failed. Please check that an LLM provider (like Ollama) is running and configured in the extension sidebar.';
          } else if (event.error.code === 'ERR_NO_MODEL') {
            errorMsg = 'No LLM model configured. Please add an LLM provider in the extension sidebar.';
          }
          addMessageUI('assistant', `Error: ${errorMsg}`);
          break;
      }
    }
    
    removeThinking();
  } catch (err) {
    removeThinking();
    addMessageUI('assistant', `Error: ${err}`);
  }
}

// =============================================================================
// Input Handling
// =============================================================================

function autoResizeInput() {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 150) + 'px';
}

messageInput.addEventListener('input', autoResizeInput);

messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// =============================================================================
// Event Listeners
// =============================================================================

sendBtn.addEventListener('click', sendMessage);

toolsToggle.addEventListener('click', () => {
  useTools = !useTools;
  toolsToggle.classList.toggle('active', useTools);
});

tabToggle.addEventListener('click', () => {
  useTabContext = !useTabContext;
  tabToggle.classList.toggle('active', useTabContext);
});

clearBtn.addEventListener('click', clearChat);

themeToggle.addEventListener('click', toggleTheme);

// Docs panel toggle
docsToggle.addEventListener('click', () => {
  const isOpen = docsPanel.style.display !== 'none';
  docsPanel.style.display = isOpen ? 'none' : 'flex';
  docsToggle.classList.toggle('active', !isOpen);
});

docsClose.addEventListener('click', () => {
  docsPanel.style.display = 'none';
  docsToggle.classList.remove('active');
});

// Tools modal
toolsStatusItem.addEventListener('click', showToolsModal);

toolsModalClose.addEventListener('click', hideToolsModal);

toolsModal.addEventListener('click', (e) => {
  // Close when clicking outside the modal
  if (e.target === toolsModal) {
    hideToolsModal();
  }
});

// Close modal on Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && toolsModal.style.display !== 'none') {
    hideToolsModal();
  }
});

// =============================================================================
// Initialize
// =============================================================================

async function init() {
  initTheme();
  
  // Check if extension is installed
  const hasExtension = checkExtension();
  
  if (hasExtension) {
    // Request necessary permissions first
    let permissionsGranted = false;
    try {
      const permResult = await window.agent.requestPermissions({
        scopes: ['model:list', 'model:prompt', 'model:tools', 'mcp:tools.list', 'mcp:tools.call'],
        reason: 'Chat demo needs access to the LLM and MCP tools to answer your questions',
      });
      console.log('[Demo] Permission result:', permResult);
      permissionsGranted = permResult.granted === true;
    } catch (err) {
      console.error('[Demo] Permission request failed:', err);
    }
    
    // Check LLM and tools (even without explicit permissions, as they may have been granted before)
    console.log('[Demo] Checking LLM...');
    await checkLLM();
    console.log('[Demo] Checking tools...');
    await checkTools();
    console.log('[Demo] Status checks complete');
  }
  
  // Log API availability for developers
  console.log('[Web Agent API Chat Demo]');
  console.log('  window.ai:', typeof window.ai !== 'undefined' ? '✓' : '✕');
  console.log('  window.agent:', typeof window.agent !== 'undefined' ? '✓' : '✕');
  console.log('');
  console.log('Web Agent API available:');
  console.log('  window.ai.createTextSession() - Create a text generation session');
  console.log('  window.agent.tools.list() - List available MCP tools');
  console.log('  window.agent.tools.call({tool, args}) - Call an MCP tool');
  console.log('  window.agent.browser.activeTab.readability() - Read current tab');
  console.log('  window.agent.run({task}) - Run an agent with tools (tool router built-in!)');
}

// Wait for DOM and potential extension injection
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    // Give extension time to inject APIs
    setTimeout(init, 100);
  });
} else {
  setTimeout(init, 100);
}

