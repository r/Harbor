/**
 * Harbor Chat - Chat interface for LLM + MCP interaction.
 */

import browser from 'webextension-polyfill';

// =============================================================================
// Types
// =============================================================================

interface ChatSession {
  id: string;
  name: string;
  enabledServers: string[];
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface OrchestrationStep {
  index: number;
  type: 'tool_calls' | 'tool_results' | 'final' | 'error';
  content?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  toolResults?: Array<{
    toolCallId: string;
    toolName: string;
    serverId: string;
    content: string;
    isError: boolean;
  }>;
  error?: string;
  timestamp: number;
}

interface McpConnection {
  serverId: string;
  serverName: string;
  toolCount: number;
}

interface LLMProviderStatus {
  id: string;
  name: string;
  available: boolean;
  baseUrl: string;
  models?: Array<{ id: string; name: string }>;
}

// =============================================================================
// State
// =============================================================================

let currentSession: ChatSession | null = null;
let currentSessionStock: ChatSession | null = null; // For compare mode (no tools)
let connectedServers: McpConnection[] = [];
let enabledServerIds: Set<string> = new Set();
let llmStatus: LLMProviderStatus | null = null;
let isProcessing = false;
let compareMode = false;
let useToolRouter = true; // Smart Router - on by default

// =============================================================================
// DOM Elements
// =============================================================================

const llmStatusEl = document.getElementById('llm-status') as HTMLParagraphElement;
const chatContainer = document.getElementById('chat-container') as HTMLDivElement;
const chatMessages = document.getElementById('chat-messages') as HTMLDivElement;
const emptyState = document.getElementById('empty-state') as HTMLDivElement;
const messageInput = document.getElementById('message-input') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
const serverSelector = document.getElementById('server-selector') as HTMLDivElement;
const newChatBtn = document.getElementById('new-chat-btn') as HTMLButtonElement;
const clearContextBtn = document.getElementById('clear-context-btn') as HTMLButtonElement;
const themeToggle = document.getElementById('theme-toggle') as HTMLButtonElement;
// Compare toggle is now in sidebar only - we use storage to sync
const compareToggle = document.getElementById('compare-toggle') as HTMLInputElement | null;
const compareResults = document.getElementById('compare-results') as HTMLDivElement;
const messagesStock = document.getElementById('messages-stock') as HTMLDivElement;
const messagesTools = document.getElementById('messages-tools') as HTMLDivElement;

// =============================================================================
// Theme
// =============================================================================

function initTheme(): void {
  const savedTheme = localStorage.getItem('harbor-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = savedTheme || (prefersDark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
  themeToggle.textContent = theme === 'dark' ? '☀️' : '🌙';
}

function toggleTheme(): void {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('harbor-theme', next);
  themeToggle.textContent = next === 'dark' ? '☀️' : '🌙';
}

// =============================================================================
// LLM Status
// =============================================================================

async function checkLLMStatus(): Promise<void> {
  try {
    const response = await browser.runtime.sendMessage({
      type: 'llm_detect',
    }) as { type: string; providers?: LLMProviderStatus[]; active?: string };

    if (response.type === 'llm_detect_result' && response.providers) {
      const active = response.providers.find(p => p.available);
      if (active) {
        llmStatus = active;
        llmStatusEl.textContent = `${active.name} connected`;
        llmStatusEl.style.color = 'var(--accent-success)';
        sendBtn.disabled = false;
      } else {
        llmStatusEl.textContent = 'No LLM available';
        llmStatusEl.style.color = 'var(--accent-warning)';
        sendBtn.disabled = true;
      }
    }
  } catch (err) {
    console.error('Failed to check LLM status:', err);
    llmStatusEl.textContent = 'Error connecting to bridge';
    llmStatusEl.style.color = 'var(--accent-danger)';
  }
}

// =============================================================================
// MCP Servers
// =============================================================================

async function loadConnectedServers(): Promise<void> {
  try {
    const response = await browser.runtime.sendMessage({
      type: 'mcp_list_connections',
    }) as { type: string; connections?: McpConnection[] };

    if (response.type === 'mcp_list_connections_result' && response.connections) {
      connectedServers = response.connections;
      renderServerSelector();
    }
  } catch (err) {
    console.error('Failed to load connected servers:', err);
  }
}

function renderServerSelector(): void {
  if (connectedServers.length === 0) {
    serverSelector.innerHTML = `
      <span style="color: var(--text-muted); font-size: 12px; padding: 6px 0;">
        No MCP servers connected. <a href="#" id="open-sidebar" style="color: var(--accent-primary);">Open sidebar</a> to connect.
      </span>
    `;
    document.getElementById('open-sidebar')?.addEventListener('click', (e) => {
      e.preventDefault();
      browser.sidebarAction.open();
    });
    return;
  }

  serverSelector.innerHTML = connectedServers.map(server => {
    const isEnabled = enabledServerIds.has(server.serverId);
    return `
      <div class="server-chip ${isEnabled ? 'active' : ''}" data-server-id="${escapeHtml(server.serverId)}">
        <span class="chip-dot"></span>
        ${escapeHtml(server.serverName)} (${server.toolCount} tools)
      </div>
    `;
  }).join('');

  // Add click handlers
  serverSelector.querySelectorAll('.server-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const serverId = (chip as HTMLElement).dataset.serverId!;
      if (enabledServerIds.has(serverId)) {
        enabledServerIds.delete(serverId);
        chip.classList.remove('active');
      } else {
        enabledServerIds.add(serverId);
        chip.classList.add('active');
      }
    });
  });
}

// =============================================================================
// Chat Session
// =============================================================================

async function createNewSession(): Promise<void> {
  try {
    const response = await browser.runtime.sendMessage({
      type: 'chat_create_session',
      enabled_servers: Array.from(enabledServerIds),
      name: `Chat ${new Date().toLocaleTimeString()}`,
    }) as { type: string; session?: ChatSession };

    if (response.type === 'chat_create_session_result' && response.session) {
      currentSession = {
        ...response.session,
        messages: [],
      };
      clearChat();
    }
  } catch (err) {
    console.error('Failed to create session:', err);
  }
}

function clearChat(): void {
  chatMessages.innerHTML = '';
  emptyState.style.display = 'block';
  chatMessages.appendChild(emptyState);
}

// =============================================================================
// Message Rendering
// =============================================================================

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatMessageContent(content: string): string {
  // Basic markdown-like formatting
  return content
    .split('\n')
    .map(line => `<p>${escapeHtml(line) || '&nbsp;'}</p>`)
    .join('');
}

function formatJsonForDisplay(obj: unknown): string {
  const json = JSON.stringify(obj, null, 2);
  // Add syntax highlighting
  return escapeHtml(json)
    .replace(/"([^"]+)":/g, '<span style="color: #8b5cf6;">"$1"</span>:')
    .replace(/: "([^"]*)"/g, ': <span style="color: #22c55e;">"$1"</span>')
    .replace(/: (\d+\.?\d*)/g, ': <span style="color: #f59e0b;">$1</span>')
    .replace(/: (true|false|null)/g, ': <span style="color: #3b82f6;">$1</span>');
}

function addMessage(
  role: 'user' | 'assistant' | 'tool', 
  content: string, 
  extra?: {
    toolCalls?: ToolCall[];
    toolName?: string;
    isError?: boolean;
    target?: HTMLElement; // Optional target container for compare mode
  }
): HTMLDivElement {
  const targetContainer = extra?.target || chatMessages;
  
  // Hide empty state if targeting main messages
  if (targetContainer === chatMessages) {
    emptyState.style.display = 'none';
  }

  const messageEl = document.createElement('div');
  messageEl.className = `message ${role}`;

  const avatar = role === 'user' ? '👤' : role === 'assistant' ? '✨' : '🔧';
  const roleName = role === 'user' ? 'You' : role === 'assistant' ? 'Assistant' : extra?.toolName || 'Tool';

  let bodyContent = formatMessageContent(content);

  // Add tool calls if present
  if (extra?.toolCalls?.length) {
    bodyContent += extra.toolCalls.map(tc => `
      <div class="tool-call">
        <div class="tool-call-header">
          🔧 <span class="tool-call-name">${escapeHtml(tc.name)}</span>
        </div>
        <pre class="tool-call-args"><code>${formatJsonForDisplay(tc.arguments)}</code></pre>
      </div>
    `).join('');
  }

  const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  
  messageEl.innerHTML = `
    <div class="message-avatar">${avatar}</div>
    <div class="message-content">
      <div class="message-header">
        <span class="message-role">${roleName}</span>
        <span class="message-time">${new Date().toLocaleTimeString()}</span>
      </div>
      <div class="message-body ${extra?.isError ? 'error' : ''}" data-message-id="${messageId}">
        <button class="copy-btn" data-copy-target="${messageId}">📋 Copy</button>
        ${bodyContent}
      </div>
    </div>
  `;

  // Store raw content for copy
  messageEl.dataset.rawContent = content;

  targetContainer.appendChild(messageEl);
  
  // Add copy button event listener
  const copyBtn = messageEl.querySelector('.copy-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(content);
        copyBtn.textContent = '✓ Copied!';
        copyBtn.classList.add('copied');
        setTimeout(() => {
          copyBtn.textContent = '📋 Copy';
          copyBtn.classList.remove('copied');
        }, 2000);
      } catch (err) {
        console.error('Failed to copy:', err);
      }
    });
  }
  
  if (!extra?.target) {
    scrollToBottom();
  } else {
    // Scroll the specific column
    const columnContent = targetContainer.closest('.chat-column-content');
    if (columnContent) {
      columnContent.scrollTop = columnContent.scrollHeight;
    }
  }

  return messageEl;
}

/**
 * Add a system message (for routing info, status updates, etc.)
 */
function addSystemMessage(content: string, target?: HTMLElement): void {
  const targetContainer = target || chatMessages;
  
  const messageEl = document.createElement('div');
  messageEl.className = 'message system';
  messageEl.innerHTML = `
    <div class="system-message">
      <span class="system-icon">ℹ️</span>
      <span class="system-content">${escapeHtml(content)}</span>
    </div>
  `;
  
  targetContainer.appendChild(messageEl);
  scrollToBottom();
}

function addToolResult(toolName: string, content: string, isError: boolean, target?: HTMLElement): void {
  const targetContainer = target || chatMessages;
  
  const resultEl = document.createElement('div');
  resultEl.className = `tool-result ${isError ? 'error' : ''}`;
  resultEl.innerHTML = `
    <div class="tool-result-header">
      ${isError ? '❌' : '✓'} ${escapeHtml(toolName)} result
    </div>
    <div style="font-family: 'JetBrains Mono', monospace; font-size: 12px; white-space: pre-wrap;">${escapeHtml(content.slice(0, 500))}${content.length > 500 ? '...' : ''}</div>
  `;

  targetContainer.appendChild(resultEl);
  
  if (!target) {
    scrollToBottom();
  }
}

function addThinkingIndicator(target?: HTMLElement): HTMLDivElement {
  const targetContainer = target || chatMessages;
  
  const thinkingEl = document.createElement('div');
  thinkingEl.className = 'message assistant';
  thinkingEl.id = target ? '' : 'thinking-indicator'; // Only set ID for main container
  thinkingEl.innerHTML = `
    <div class="message-avatar">✨</div>
    <div class="message-content">
      <div class="thinking">
        <div class="thinking-dots">
          <span></span><span></span><span></span>
        </div>
        <span>Thinking...</span>
      </div>
    </div>
  `;

  targetContainer.appendChild(thinkingEl);
  
  if (!target) {
    scrollToBottom();
  }

  return thinkingEl;
}

function removeThinkingIndicator(): void {
  const indicator = document.getElementById('thinking-indicator');
  if (indicator) {
    indicator.remove();
  }
}

function scrollToBottom(): void {
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

// =============================================================================
// Send Message
// =============================================================================

async function sendMessage(): Promise<void> {
  const content = messageInput.value.trim();
  if (!content || isProcessing) return;

  // Create session if needed
  if (!currentSession) {
    await createNewSession();
  }

  if (!currentSession) {
    console.error('Failed to create session');
    return;
  }

  // Update enabled servers
  currentSession.enabledServers = Array.from(enabledServerIds);

  isProcessing = true;
  sendBtn.disabled = true;
  messageInput.value = '';
  autoResizeInput();

  if (compareMode) {
    await sendCompareMessage(content);
  } else {
    await sendNormalMessage(content);
  }

  isProcessing = false;
  sendBtn.disabled = !llmStatus?.available;
}

async function sendNormalMessage(content: string): Promise<void> {
  // Add user message
  addMessage('user', content);

  // Show thinking indicator
  addThinkingIndicator();

  try {
    // Update session with enabled servers first
    await browser.runtime.sendMessage({
      type: 'chat_update_session',
      session_id: currentSession!.id,
      updates: {
        enabledServers: Array.from(enabledServerIds),
      },
    });

    // Send message to orchestrator
    const response = await browser.runtime.sendMessage({
      type: 'chat_send_message',
      session_id: currentSession!.id,
      message: content,
      use_tool_router: useToolRouter,
    }) as {
      type: string;
      response?: string;
      steps?: OrchestrationStep[];
      routing?: {
        selectedServers: string[];
        matchedKeywords: string[];
        wasRouted: boolean;
        reason: string;
      };
      error?: { message: string };
    };

    removeThinkingIndicator();

    if (response.type === 'chat_send_message_result') {
      // Show routing info if router was used
      if (response.routing?.wasRouted) {
        const serverNames = response.routing.selectedServers.map(s => s.replace(/_/g, ' ')).join(', ');
        addSystemMessage(`🎯 Smart Router: Using ${serverNames} (keywords: ${response.routing.matchedKeywords.join(', ')})`);
      }
      // Process steps to show tool usage
      if (response.steps) {
        for (const step of response.steps) {
          if (step.type === 'tool_calls' && step.toolCalls) {
            // Show that tools are being called
            addMessage('assistant', 'Using tools...', { toolCalls: step.toolCalls });
          } else if (step.type === 'tool_results' && step.toolResults) {
            // Show tool results
            for (const result of step.toolResults) {
              addToolResult(result.toolName, result.content, result.isError);
            }
          }
        }
      }

      // Add final response
      if (response.response) {
        addMessage('assistant', response.response);
      }
    } else if (response.type === 'error') {
      addMessage('assistant', `Error: ${response.error?.message || 'Unknown error'}`, { isError: true });
    }

  } catch (err) {
    removeThinkingIndicator();
    console.error('Failed to send message:', err);
    addMessage('assistant', `Error: ${err}`, { isError: true });
  }
}

async function sendCompareMessage(content: string): Promise<void> {
  console.log('[Chat] Compare mode: sending message');
  
  // Clear previous compare results
  messagesStock.innerHTML = '';
  messagesTools.innerHTML = '';
  
  console.log('[Chat] Stock container:', messagesStock);
  console.log('[Chat] Tools container:', messagesTools);

  // Add user message to both columns
  addMessage('user', content, { target: messagesStock });
  addMessage('user', content, { target: messagesTools });
  
  console.log('[Chat] Added user messages to both columns');

  // Add thinking indicators to both
  const thinkingStock = addThinkingIndicator(messagesStock);
  const thinkingTools = addThinkingIndicator(messagesTools);

  // Create a stock session if needed (no tools)
  if (!currentSessionStock) {
    const stockResponse = await browser.runtime.sendMessage({
      type: 'chat_create_session',
      name: 'Compare - Stock',
    }) as { type: string; session?: ChatSession };

    if (stockResponse.type === 'chat_create_session_result' && stockResponse.session) {
      currentSessionStock = stockResponse.session;
    }
  }

  // Run both requests in parallel
  const stockPromise = sendStockRequest(content, thinkingStock);
  const toolsPromise = sendToolsRequest(content, thinkingTools);

  await Promise.all([stockPromise, toolsPromise]);
}

async function sendStockRequest(content: string, thinkingEl: HTMLDivElement): Promise<void> {
  console.log('[Chat] Stock request starting...');
  try {
    // Direct LLM chat without tools
    const response = await browser.runtime.sendMessage({
      type: 'llm_chat',
      messages: [{ role: 'user', content }],
    }) as {
      type: string;
      response?: { message?: { content?: string } };
      error?: { message: string };
    };

    console.log('[Chat] Stock response:', response);
    thinkingEl.remove();

    if (response.type === 'llm_chat_result' && response.response?.message?.content) {
      console.log('[Chat] Adding stock assistant message');
      addMessage('assistant', response.response.message.content, { target: messagesStock });
    } else if (response.type === 'error') {
      console.log('[Chat] Stock error:', response.error);
      addMessage('assistant', `Error: ${response.error?.message || 'Unknown error'}`, { 
        isError: true, 
        target: messagesStock 
      });
    } else {
      console.log('[Chat] Stock - no content in response');
      addMessage('assistant', 'No response from LLM', { isError: true, target: messagesStock });
    }
  } catch (err) {
    console.error('[Chat] Stock request failed:', err);
    thinkingEl.remove();
    addMessage('assistant', `Error: ${err}`, { isError: true, target: messagesStock });
  }
}

async function sendToolsRequest(content: string, thinkingEl: HTMLDivElement): Promise<void> {
  console.log('[Chat] Tools request starting...');
  console.log('[Chat] Enabled servers:', Array.from(enabledServerIds));
  
  try {
    // Update session with enabled servers
    await browser.runtime.sendMessage({
      type: 'chat_update_session',
      session_id: currentSession!.id,
      updates: {
        enabledServers: Array.from(enabledServerIds),
      },
    });

    // Send through orchestrator with tools
    const response = await browser.runtime.sendMessage({
      type: 'chat_send_message',
      session_id: currentSession!.id,
      message: content,
      use_tool_router: useToolRouter,
    }) as {
      type: string;
      response?: string;
      steps?: OrchestrationStep[];
      routing?: {
        selectedServers: string[];
        matchedKeywords: string[];
        wasRouted: boolean;
        reason: string;
      };
      error?: { message: string };
    };

    console.log('[Chat] Tools response:', response);
    thinkingEl.remove();

    if (response.type === 'chat_send_message_result') {
      // Show routing info if router was used
      if (response.routing?.wasRouted) {
        const serverNames = response.routing.selectedServers.map(s => s.replace(/_/g, ' ')).join(', ');
        addSystemMessage(`🎯 Router: ${serverNames}`, messagesTools);
      }
      // Process steps to show tool usage
      if (response.steps) {
        console.log('[Chat] Tools steps:', response.steps);
        for (const step of response.steps) {
          if (step.type === 'tool_calls' && step.toolCalls) {
            addMessage('assistant', 'Using tools...', { toolCalls: step.toolCalls, target: messagesTools });
          } else if (step.type === 'tool_results' && step.toolResults) {
            for (const result of step.toolResults) {
              addToolResult(result.toolName, result.content, result.isError, messagesTools);
            }
          }
        }
      }

      // Add final response
      if (response.response) {
        console.log('[Chat] Adding tools assistant message');
        addMessage('assistant', response.response, { target: messagesTools });
      }
    } else if (response.type === 'error') {
      console.log('[Chat] Tools error:', response.error);
      addMessage('assistant', `Error: ${response.error?.message || 'Unknown error'}`, { 
        isError: true, 
        target: messagesTools 
      });
    }
  } catch (err) {
    console.error('[Chat] Tools request failed:', err);
    thinkingEl.remove();
    addMessage('assistant', `Error: ${err}`, { isError: true, target: messagesTools });
  }
}

// =============================================================================
// Input Handling
// =============================================================================

function autoResizeInput(): void {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + 'px';
}

// =============================================================================
// Event Listeners
// =============================================================================

messageInput.addEventListener('input', autoResizeInput);

messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

sendBtn.addEventListener('click', sendMessage);

newChatBtn.addEventListener('click', async () => {
  currentSession = null;
  currentSessionStock = null;
  clearChat();
  await createNewSession();
});

// Clear context - keeps session but wipes conversation history
clearContextBtn.addEventListener('click', async () => {
  if (!currentSession) return;
  
  try {
    // Clear messages on the server
    await browser.runtime.sendMessage({
      type: 'chat_clear_messages',
      session_id: currentSession.id,
    });
    
    // Clear local UI
    clearChat();
    
    // Show confirmation
    const originalText = clearContextBtn.textContent;
    clearContextBtn.textContent = '✓ Cleared!';
    setTimeout(() => {
      clearContextBtn.textContent = originalText;
    }, 1500);
    
    console.log('[Chat] Context cleared - LLM will now rely only on memory servers');
  } catch (err) {
    console.error('Failed to clear context:', err);
  }
});

themeToggle.addEventListener('click', toggleTheme);

// Compare mode is now controlled from sidebar only
// The chat listens for 'compare_mode_changed' messages and storage changes

// =============================================================================
// Initialize
// =============================================================================

async function init(): Promise<void> {
  initTheme();
  await checkLLMStatus();
  await loadConnectedServers();
  
  // Enable all connected servers by default
  for (const server of connectedServers) {
    enabledServerIds.add(server.serverId);
  }
  renderServerSelector();
  
  // Load compare mode and tool router state from storage
  const stored = await browser.storage.local.get(['compareMode', 'useToolRouter']);
  if (stored.compareMode) {
    compareMode = true;
    chatContainer.classList.add('compare-mode');
  }
  // Tool router defaults to true if not set
  useToolRouter = stored.useToolRouter !== false;
  
  // Listen for messages from background/sidebar
  browser.runtime.onMessage.addListener((message) => {
    // Server connection changes
    if (message.type === 'mcp_server_connected') {
      console.log('[Chat] Server connected:', message.server_id);
      loadConnectedServers().then(() => {
        enabledServerIds.add(message.server_id);
        renderServerSelector();
      });
    } else if (message.type === 'mcp_server_disconnected') {
      console.log('[Chat] Server disconnected:', message.server_id);
      enabledServerIds.delete(message.server_id);
      loadConnectedServers().then(() => {
        renderServerSelector();
      });
    }
    
    // Compare mode toggled from sidebar
    if (message.type === 'compare_mode_changed') {
      console.log('[Chat] Compare mode changed from sidebar:', message.enabled);
      compareMode = message.enabled;
      if (compareMode) {
        chatContainer.classList.add('compare-mode');
        messagesStock.innerHTML = '';
        messagesTools.innerHTML = '';
      } else {
        chatContainer.classList.remove('compare-mode');
      }
    }
    
    // Tool router toggled from sidebar
    if (message.type === 'tool_router_changed') {
      console.log('[Chat] Tool router changed from sidebar:', message.enabled);
      useToolRouter = message.enabled;
    }
  });
}

init();

