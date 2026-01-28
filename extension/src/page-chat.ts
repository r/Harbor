/**
 * Page Chat - Injected sidebar for chatting about the current page
 * 
 * This content script injects a chat sidebar into web pages that allows
 * users to ask questions about the current page content using the Web Agent API.
 * 
 * Supports:
 * - agent.chat.open() with configuration (BYOC mode)
 * - Keyboard shortcut toggle
 * - Page context extraction
 */

import { browserAPI } from './browser-compat';

// Configuration interface for BYOC mode
interface PageChatConfig {
  chatId?: string;
  initialMessage?: string;
  systemPrompt?: string;
  tools?: string[];
  sessionId?: string;
  style?: {
    theme?: 'light' | 'dark' | 'auto';
    accentColor?: string;
    position?: 'right' | 'left' | 'center';
  };
}

// Read configuration injected by background script
const byocConfig: PageChatConfig = 
  (window as unknown as { __harborPageChatConfig?: PageChatConfig }).__harborPageChatConfig || {};

// Check if sidebar is already injected
if (document.getElementById('harbor-page-chat')) {
  console.log('[Harbor Page Chat] Already injected, skipping');
} else {
  initPageChat();
}

function initPageChat() {
  const isByocMode = !!byocConfig.chatId;
  console.log('[Harbor Page Chat] Initializing...', isByocMode ? `(BYOC: ${byocConfig.chatId})` : '');

  // Create the sidebar container
  const sidebar = document.createElement('div');
  sidebar.id = 'harbor-page-chat';
  sidebar.innerHTML = getSidebarHTML(isByocMode);
  document.body.appendChild(sidebar);

  // Add styles
  const styles = document.createElement('style');
  styles.textContent = getSidebarCSS();
  document.head.appendChild(styles);
  
  // Apply custom styling from config
  if (byocConfig.style) {
    if (byocConfig.style.theme === 'light') {
      sidebar.classList.add('hpc-theme-light');
    } else if (byocConfig.style.theme === 'auto') {
      const bodyBg = window.getComputedStyle(document.body).backgroundColor;
      const rgb = bodyBg.match(/\d+/g);
      if (rgb) {
        const brightness = (parseInt(rgb[0]) * 299 + parseInt(rgb[1]) * 587 + parseInt(rgb[2]) * 114) / 1000;
        if (brightness > 128) {
          sidebar.classList.add('hpc-theme-light');
        }
      }
    }
    
    if (byocConfig.style.accentColor) {
      sidebar.style.setProperty('--hpc-accent', byocConfig.style.accentColor);
      sidebar.style.setProperty('--hpc-accent-glow', byocConfig.style.accentColor + '40');
    }
    
    if (byocConfig.style.position === 'left') {
      sidebar.classList.add('hpc-position-left');
    }
  }

  // Initialize state
  let isOpen = true;
  let isConnected = isByocMode;
  let isProcessing = false;
  let pageContext = '';
  
  const customSystemPrompt = byocConfig.systemPrompt;

  // DOM references
  const container = document.getElementById('harbor-page-chat')!;
  const toggleBtn = container.querySelector('#hpc-toggle') as HTMLButtonElement;
  const closeBtn = container.querySelector('#hpc-close') as HTMLButtonElement;
  const panel = container.querySelector('.hpc-panel') as HTMLDivElement;
  const connectBtn = container.querySelector('#hpc-connect') as HTMLButtonElement;
  const setupOverlay = container.querySelector('.hpc-setup') as HTMLDivElement;
  const setupError = container.querySelector('#hpc-setup-error') as HTMLDivElement;
  const messagesContainer = container.querySelector('#hpc-messages') as HTMLDivElement;
  const emptyState = container.querySelector('.hpc-empty') as HTMLDivElement;
  const inputArea = container.querySelector('#hpc-input') as HTMLTextAreaElement;
  const sendBtn = container.querySelector('#hpc-send') as HTMLButtonElement;
  const statusDot = container.querySelector('#hpc-status-dot') as HTMLSpanElement;
  const statusText = container.querySelector('#hpc-status-text') as HTMLSpanElement;

  // Toggle sidebar
  toggleBtn.addEventListener('click', () => {
    isOpen = !isOpen;
    panel.classList.toggle('hpc-hidden', !isOpen);
    toggleBtn.title = isOpen ? 'Hide chat' : 'Show chat';
  });

  closeBtn.addEventListener('click', () => {
    container.remove();
    styles.remove();
  });
  
  // Listen for close messages from background script
  if (byocConfig.chatId) {
    browserAPI.runtime.onMessage.addListener((message: { type: string; chatId?: string }) => {
      if (message.type === 'harbor_chat_close' && message.chatId === byocConfig.chatId) {
        console.log('[Harbor Page Chat] Closing via API request');
        container.remove();
        styles.remove();
      }
    });
  }

  // Connect to Web Agent API
  connectBtn.addEventListener('click', async () => {
    connectBtn.disabled = true;
    connectBtn.innerHTML = '<span class="hpc-spinner"></span> Connecting...';
    setupError.style.display = 'none';

    try {
      // Check for Web Agent API
      if (!(window as unknown as { ai?: unknown }).ai || !(window as unknown as { agent?: unknown }).agent) {
        throw new Error('Web Agent API not found. Make sure Harbor is installed and enabled.');
      }

      const windowAny = window as unknown as { 
        agent: { requestPermissions: (opts: unknown) => Promise<{ granted: boolean }> };
        ai: { createTextSession: () => Promise<{ destroy: () => Promise<void> }> };
      };

      // Request permissions
      const result = await windowAny.agent.requestPermissions({
        scopes: ['model:prompt'],
        reason: 'Chat about this page content'
      });

      if (!result.granted) {
        throw new Error('Permission denied. Please allow access to continue.');
      }

      // Test LLM
      const session = await windowAny.ai.createTextSession();
      await session.destroy();

      // Success
      isConnected = true;
      pageContext = getPageContext();

      setupOverlay.style.display = 'none';
      statusDot.classList.add('hpc-connected');
      statusText.textContent = 'Connected';
      inputArea.disabled = false;
      sendBtn.disabled = false;
      inputArea.focus();

    } catch (err) {
      connectBtn.disabled = false;
      connectBtn.textContent = 'Try Again';
      setupError.textContent = err instanceof Error ? err.message : 'Unknown error';
      setupError.style.display = 'block';
      statusDot.classList.add('hpc-error');
      statusText.textContent = 'Error';
    }
  });

  // Get page context
  function getPageContext(): string {
    const article = document.querySelector('article');
    const main = document.querySelector('main');
    const content = article || main || document.body;
    
    let text = content.innerText;
    
    if (text.length > 4000) {
      text = text.substring(0, 4000) + '\n\n[Content truncated...]';
    }
    
    return text;
  }

  const configuredTools = byocConfig.tools || [];
  
  // Send message
  async function sendMessage(content: string) {
    if (!content.trim() || !isConnected || isProcessing) return;

    isProcessing = true;
    sendBtn.disabled = true;
    inputArea.value = '';
    autoResize();

    addMessage('user', content);
    addThinking();

    try {
      const systemPrompt = customSystemPrompt 
        ? `${customSystemPrompt}

Page URL: ${window.location.href}
Page Title: ${document.title}

Page content:
---
${pageContext}
---`
        : `You are a helpful assistant that answers questions about the content on this webpage.
Be concise and helpful. Reference specific parts of the content when relevant.

Page URL: ${window.location.href}
Page Title: ${document.title}

Here is the page content:
---
${pageContext}
---`;

      if (isByocMode) {
        // BYOC mode - send via background script
        console.log('[Harbor Page Chat] BYOC mode - sending via background');
        
        const response = await browserAPI.runtime.sendMessage({
          type: 'page_chat_message',
          chatId: byocConfig.chatId,
          message: content,
          systemPrompt,
          tools: configuredTools,
          pageContext: {
            url: window.location.href,
            title: document.title,
          },
        }) as { 
          type: string; 
          response?: string; 
          error?: { message: string };
          toolsUsed?: { name: string }[];
        };
        
        removeThinking();
        
        if (response.type === 'error' || response.error) {
          addMessage('assistant', `Error: ${response.error?.message || 'Unknown error'}`);
        } else if (response.response) {
          const messageEl = addMessage('assistant', response.response);
          
          if (response.toolsUsed && response.toolsUsed.length > 0 && messageEl) {
            const toolsInfo = document.createElement('div');
            toolsInfo.className = 'hpc-tools-used';
            toolsInfo.innerHTML = `<small>🔧 Used: ${response.toolsUsed.map(t => t.name.split('/').pop()).join(', ')}</small>`;
            messageEl.appendChild(toolsInfo);
          }
        } else {
          addMessage('assistant', '(No response)');
        }
      } else {
        // Standard mode - use window.ai
        const windowAny = window as unknown as { 
          ai: { createTextSession: (opts?: unknown) => Promise<{
            promptStreaming: (input: string) => AsyncIterable<string>;
            destroy: () => Promise<void>;
          }> };
        };

        const session = await windowAny.ai.createTextSession({ systemPrompt });

        let responseText = '';
        let messageEl: HTMLElement | null = null;

        for await (const chunk of session.promptStreaming(content)) {
          responseText = chunk;

          if (!messageEl) {
            removeThinking();
            messageEl = addMessage('assistant', responseText);
          } else {
            updateMessageBody(messageEl, responseText);
          }
          scrollToBottom();
        }

        await session.destroy();
        removeThinking();

        if (!messageEl && !responseText) {
          addMessage('assistant', '(No response)');
        }
      }

    } catch (err) {
      console.error('[Harbor Page Chat] Error:', err);
      removeThinking();
      addMessage('assistant', `Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }

    isProcessing = false;
    sendBtn.disabled = false;
    inputArea.focus();
  }

  // Add message to UI
  function addMessage(role: 'user' | 'assistant', content: string): HTMLElement {
    emptyState.style.display = 'none';

    const msg = document.createElement('div');
    msg.className = `hpc-message hpc-${role}`;

    const avatar = role === 'user' ? 'U' : 'H';
    const roleName = role === 'user' ? 'You' : 'Harbor';

    msg.innerHTML = `
      <div class="hpc-msg-header">
        <span class="hpc-avatar">${avatar}</span>
        <span class="hpc-role">${roleName}</span>
      </div>
      <div class="hpc-msg-body">${escapeHtml(content)}</div>
    `;

    messagesContainer.appendChild(msg);
    scrollToBottom();

    return msg;
  }

  function updateMessageBody(messageEl: HTMLElement, content: string) {
    const body = messageEl.querySelector('.hpc-msg-body');
    if (body) {
      body.innerHTML = escapeHtml(content);
    }
  }

  function addThinking() {
    const thinking = document.createElement('div');
    thinking.className = 'hpc-message hpc-assistant';
    thinking.id = 'hpc-thinking';
    thinking.innerHTML = `
      <div class="hpc-msg-header">
        <span class="hpc-avatar">H</span>
        <span class="hpc-role">Harbor</span>
      </div>
      <div class="hpc-thinking">
        <span></span><span></span><span></span>
      </div>
    `;
    messagesContainer.appendChild(thinking);
    scrollToBottom();
  }

  function removeThinking() {
    const thinking = document.getElementById('hpc-thinking');
    if (thinking) thinking.remove();
  }

  function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML.replace(/\n/g, '<br>');
  }

  // Input handling
  function autoResize() {
    inputArea.style.height = 'auto';
    inputArea.style.height = Math.min(inputArea.scrollHeight, 100) + 'px';
  }

  inputArea.addEventListener('input', autoResize);

  inputArea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(inputArea.value);
    }
  });

  sendBtn.addEventListener('click', () => {
    sendMessage(inputArea.value);
  });

  // Suggestion chips
  const chips = container.querySelectorAll('.hpc-chip');
  chips.forEach(chip => {
    chip.addEventListener('click', () => {
      const text = chip.textContent || '';
      sendMessage(text);
    });
  });

  // Auto-connect in BYOC mode
  if (isByocMode) {
    pageContext = getPageContext();
    setupOverlay.style.display = 'none';
    statusDot.classList.add('hpc-connected');
    statusText.textContent = 'Connected';
    inputArea.disabled = false;
    sendBtn.disabled = false;
    
    // Send initial message if provided
    if (byocConfig.initialMessage) {
      setTimeout(() => {
        sendMessage(byocConfig.initialMessage!);
      }, 100);
    }
  }
}

function getSidebarHTML(isByocMode: boolean): string {
  const headerContent = isByocMode
    ? `<div class="hpc-header hpc-header-byoc">
        <div class="hpc-header-main">
          <div class="hpc-header-left">
            <span class="hpc-logo hpc-logo-verified">H</span>
            <div class="hpc-header-text">
              <span class="hpc-title">Page Chat</span>
              <span class="hpc-subtitle">Powered by Harbor</span>
            </div>
          </div>
          <div class="hpc-header-right">
            <span class="hpc-status">
              <span class="hpc-status-dot" id="hpc-status-dot"></span>
              <span id="hpc-status-text">Ready</span>
            </span>
            <button class="hpc-close-btn" id="hpc-close" title="Close">×</button>
          </div>
        </div>
        <div class="hpc-trust-bar">
          <span class="hpc-trust-badge">✓ Verified</span>
          <span class="hpc-trust-divider">•</span>
          <span class="hpc-trust-site">Chat provided by <strong>${window.location.hostname}</strong></span>
        </div>
      </div>`
    : `<div class="hpc-header">
        <div class="hpc-header-left">
          <span class="hpc-logo">H</span>
          <span class="hpc-title">Page Chat</span>
        </div>
        <div class="hpc-header-right">
          <span class="hpc-status">
            <span class="hpc-status-dot" id="hpc-status-dot"></span>
            <span id="hpc-status-text">Disconnected</span>
          </span>
          <button class="hpc-close-btn" id="hpc-close" title="Close">×</button>
        </div>
      </div>`;

  return `
    <button class="hpc-toggle" id="hpc-toggle" title="Toggle chat">💬</button>
    <div class="hpc-panel">
      ${headerContent}
      <div class="hpc-setup" style="${isByocMode ? 'display: none;' : ''}">
        <div class="hpc-setup-content">
          <h3>Chat about this page</h3>
          <p>Ask questions about the content on this page using AI.</p>
          <button class="hpc-connect-btn" id="hpc-connect">Connect to Harbor</button>
          <div class="hpc-setup-error" id="hpc-setup-error" style="display: none;"></div>
        </div>
      </div>
      <div class="hpc-messages" id="hpc-messages">
        <div class="hpc-empty">
          <h4>👋 Hi there!</h4>
          <p class="hpc-empty-desc">Ask me anything about <strong>${document.title || 'this page'}</strong></p>
          <div class="hpc-chips">
            <button class="hpc-chip">Summarize this page</button>
            <button class="hpc-chip">What are the key points?</button>
            <button class="hpc-chip">Explain the main topic</button>
          </div>
        </div>
      </div>
      <div class="hpc-input-area">
        <textarea id="hpc-input" placeholder="Ask about this page..." rows="1" disabled></textarea>
        <button class="hpc-send-btn" id="hpc-send" disabled>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>
          </svg>
        </button>
      </div>
    </div>
  `;
}

function getSidebarCSS(): string {
  return `
    #harbor-page-chat {
      --hpc-accent: #8b5cf6;
      --hpc-accent-glow: rgba(139, 92, 246, 0.25);
      --hpc-bg: #16161e;
      --hpc-surface: #1e1e28;
      --hpc-border: rgba(255,255,255,0.08);
      --hpc-text: #ffffff;
      --hpc-text-dim: #e0e0e0;
      --hpc-text-muted: #888888;
      --hpc-success: #22c55e;
      --hpc-error: #ef4444;
      --hpc-font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      z-index: 2147483647;
      font-family: var(--hpc-font);
      font-size: 14px;
      line-height: 1.5;
    }
    
    #harbor-page-chat * {
      box-sizing: border-box;
    }
    
    #harbor-page-chat.hpc-position-left {
      right: auto;
      left: 0;
    }
    
    #harbor-page-chat.hpc-position-left .hpc-panel {
      right: auto;
      left: 0;
      border-radius: 0 12px 12px 0;
    }
    
    #harbor-page-chat.hpc-position-left .hpc-toggle {
      right: auto;
      left: 16px;
    }
    
    .hpc-toggle {
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--hpc-accent), #a855f7);
      border: none;
      color: white;
      font-size: 20px;
      cursor: pointer;
      box-shadow: 0 4px 20px rgba(139, 92, 246, 0.4);
      transition: all 0.2s;
      z-index: 2147483646;
    }
    
    .hpc-toggle:hover {
      transform: scale(1.05);
    }
    
    .hpc-panel {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      width: 380px;
      background: var(--hpc-bg);
      border-left: 1px solid var(--hpc-border);
      display: flex;
      flex-direction: column;
      box-shadow: -4px 0 20px rgba(0,0,0,0.3);
      transition: transform 0.2s ease;
    }
    
    .hpc-panel.hpc-hidden {
      transform: translateX(100%);
    }
    
    .hpc-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      background: var(--hpc-surface);
      border-bottom: 1px solid var(--hpc-border);
    }
    
    .hpc-header-left {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    
    .hpc-logo {
      width: 28px;
      height: 28px;
      background: linear-gradient(135deg, var(--hpc-accent), #a855f7);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 14px;
      color: white;
    }
    
    .hpc-title {
      font-weight: 600;
      color: var(--hpc-text);
    }
    
    .hpc-header-right {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    
    .hpc-status {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--hpc-text-muted);
    }
    
    .hpc-status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--hpc-text-muted);
    }
    
    .hpc-status-dot.hpc-connected {
      background: var(--hpc-success);
      box-shadow: 0 0 8px var(--hpc-success);
    }
    
    .hpc-status-dot.hpc-error {
      background: var(--hpc-error);
    }
    
    .hpc-close-btn {
      background: none;
      border: none;
      color: var(--hpc-text-muted);
      font-size: 20px;
      cursor: pointer;
      padding: 4px;
      line-height: 1;
    }
    
    .hpc-close-btn:hover {
      color: var(--hpc-text);
    }
    
    .hpc-setup {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    
    .hpc-setup-content {
      text-align: center;
      max-width: 280px;
    }
    
    .hpc-setup-content h3 {
      font-size: 18px;
      font-weight: 600;
      color: var(--hpc-text);
      margin-bottom: 8px;
    }
    
    .hpc-setup-content p {
      color: var(--hpc-text-muted);
      margin-bottom: 20px;
      font-size: 14px;
    }
    
    .hpc-connect-btn {
      background: linear-gradient(135deg, var(--hpc-accent), #a855f7);
      color: white;
      border: none;
      padding: 12px 24px;
      border-radius: 8px;
      font-weight: 600;
      cursor: pointer;
      font-size: 14px;
      transition: all 0.15s;
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    
    .hpc-connect-btn:hover:not(:disabled) {
      filter: brightness(1.1);
    }
    
    .hpc-connect-btn:disabled {
      opacity: 0.7;
      cursor: wait;
    }
    
    .hpc-setup-error {
      margin-top: 12px;
      padding: 10px;
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.2);
      border-radius: 6px;
      color: var(--hpc-error);
      font-size: 13px;
    }
    
    .hpc-messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
    }
    
    .hpc-empty {
      text-align: center;
      padding: 40px 16px;
    }
    
    .hpc-empty h4 {
      font-size: 18px;
      margin-bottom: 8px;
      color: var(--hpc-text);
    }
    
    .hpc-chips {
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 100%;
      margin-top: 16px;
    }
    
    .hpc-chip {
      padding: 10px 14px;
      background: var(--hpc-surface);
      border: 1px solid var(--hpc-border);
      border-radius: 8px;
      color: var(--hpc-text-dim);
      font-size: 13px;
      cursor: pointer;
      text-align: left;
      transition: all 0.15s;
    }
    
    .hpc-chip:hover {
      background: rgba(255,255,255,0.05);
      border-color: var(--hpc-accent);
      color: var(--hpc-text);
    }
    
    .hpc-message {
      margin-bottom: 16px;
      animation: hpc-fadeIn 0.2s ease;
    }
    
    @keyframes hpc-fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    
    .hpc-msg-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
    }
    
    .hpc-avatar {
      width: 24px;
      height: 24px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 700;
    }
    
    .hpc-user .hpc-avatar {
      background: linear-gradient(135deg, var(--hpc-accent), #a855f7);
      color: white;
    }
    
    .hpc-assistant .hpc-avatar {
      background: var(--hpc-surface);
      border: 1px solid var(--hpc-border);
      color: var(--hpc-text-dim);
    }
    
    .hpc-role {
      font-size: 12px;
      font-weight: 600;
      color: var(--hpc-text);
    }
    
    .hpc-msg-body {
      margin-left: 32px;
      font-size: 13px;
      line-height: 1.6;
      color: var(--hpc-text-dim);
    }
    
    .hpc-tools-used {
      margin-left: 32px;
      margin-top: 8px;
      padding: 6px 10px;
      background: var(--hpc-surface);
      border: 1px solid var(--hpc-border);
      border-radius: 6px;
      font-size: 11px;
      color: var(--hpc-text-muted);
    }
    
    .hpc-header-byoc {
      background: linear-gradient(180deg, #1a1a24 0%, #16161e 100%);
      padding: 0 !important;
      flex-direction: column;
      border-bottom: none;
    }
    
    .hpc-header-main {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      border-bottom: 1px solid var(--hpc-border);
    }
    
    .hpc-header-main .hpc-header-left {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    
    .hpc-header-main .hpc-header-text {
      display: flex;
      flex-direction: column;
    }
    
    .hpc-header-main .hpc-title {
      font-size: 15px;
      font-weight: 700;
      color: var(--hpc-text);
    }
    
    .hpc-header-main .hpc-subtitle {
      font-size: 11px;
      color: var(--hpc-text-muted);
    }
    
    .hpc-trust-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      font-size: 11px;
      background: rgba(0,0,0,0.2);
      border-bottom: 1px solid var(--hpc-border);
    }
    
    .hpc-trust-badge {
      background: rgba(34, 197, 94, 0.15);
      color: var(--hpc-success);
      padding: 3px 10px;
      border-radius: 12px;
      font-weight: 600;
      font-size: 11px;
    }
    
    .hpc-trust-divider {
      color: var(--hpc-text-muted);
    }
    
    .hpc-trust-site {
      color: var(--hpc-text-muted);
    }
    
    .hpc-trust-site strong {
      color: var(--hpc-text-dim);
    }
    
    .hpc-empty-desc {
      color: var(--hpc-text-muted);
      font-size: 13px;
      line-height: 1.5;
      max-width: 280px;
    }
    
    .hpc-empty-desc strong {
      color: var(--hpc-text-dim);
    }
    
    .hpc-logo-verified {
      position: relative;
    }
    
    .hpc-logo-verified::after {
      content: '✓';
      position: absolute;
      bottom: -2px;
      right: -2px;
      width: 12px;
      height: 12px;
      background: var(--hpc-success);
      border-radius: 50%;
      font-size: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
    }
    
    /* Light Theme */
    #harbor-page-chat.hpc-theme-light {
      --hpc-bg: #ffffff;
      --hpc-surface: #f5f5f5;
      --hpc-border: rgba(0,0,0,0.1);
      --hpc-text: #1a1a1a;
      --hpc-text-dim: #4a4a4a;
      --hpc-text-muted: #888888;
    }
    
    #harbor-page-chat.hpc-theme-light .hpc-panel {
      background: var(--hpc-bg);
      border-color: var(--hpc-border);
      box-shadow: -4px 0 20px rgba(0,0,0,0.1);
    }
    
    #harbor-page-chat.hpc-theme-light .hpc-header {
      background: var(--hpc-surface);
      border-bottom-color: var(--hpc-border);
    }
    
    #harbor-page-chat.hpc-theme-light .hpc-header-byoc {
      background: linear-gradient(180deg, #f8f8f8, #f0f0f0);
    }
    
    #harbor-page-chat.hpc-theme-light .hpc-trust-bar {
      background: rgba(0,0,0,0.03);
    }
    
    #harbor-page-chat.hpc-theme-light .hpc-toggle {
      box-shadow: 0 2px 10px rgba(0,0,0,0.15);
    }
    
    .hpc-thinking {
      display: flex;
      gap: 4px;
      margin-left: 32px;
    }
    
    .hpc-thinking span {
      width: 6px;
      height: 6px;
      background: var(--hpc-accent);
      border-radius: 50%;
      animation: hpc-pulse 1.2s infinite;
    }
    
    .hpc-thinking span:nth-child(2) { animation-delay: 0.15s; }
    .hpc-thinking span:nth-child(3) { animation-delay: 0.3s; }
    
    @keyframes hpc-pulse {
      0%, 100% { opacity: 0.3; transform: scale(0.8); }
      50% { opacity: 1; transform: scale(1); }
    }
    
    .hpc-input-area {
      display: flex;
      gap: 8px;
      padding: 12px 16px;
      border-top: 1px solid var(--hpc-border);
      background: var(--hpc-surface);
    }
    
    #hpc-input {
      flex: 1;
      background: var(--hpc-bg);
      border: 1px solid var(--hpc-border);
      border-radius: 8px;
      padding: 10px 12px;
      color: var(--hpc-text);
      font-size: 13px;
      font-family: var(--hpc-font);
      resize: none;
      min-height: 20px;
      max-height: 100px;
    }
    
    #hpc-input:focus {
      outline: none;
      border-color: var(--hpc-accent);
      box-shadow: 0 0 0 3px var(--hpc-accent-glow);
    }
    
    #hpc-input::placeholder {
      color: var(--hpc-text-muted);
    }
    
    #hpc-input:disabled {
      opacity: 0.5;
    }
    
    .hpc-send-btn {
      width: 36px;
      height: 36px;
      background: linear-gradient(135deg, var(--hpc-accent), #a855f7);
      border: none;
      border-radius: 8px;
      color: white;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: all 0.15s;
    }
    
    .hpc-send-btn:hover:not(:disabled) {
      filter: brightness(1.1);
    }
    
    .hpc-send-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    
    .hpc-spinner {
      width: 14px;
      height: 14px;
      border: 2px solid rgba(255,255,255,0.3);
      border-top-color: white;
      border-radius: 50%;
      animation: hpc-spin 0.8s linear infinite;
    }
    
    @keyframes hpc-spin {
      to { transform: rotate(360deg); }
    }
    
    .hpc-messages::-webkit-scrollbar {
      width: 6px;
    }
    
    .hpc-messages::-webkit-scrollbar-track {
      background: transparent;
    }
    
    .hpc-messages::-webkit-scrollbar-thumb {
      background: var(--hpc-border);
      border-radius: 3px;
    }
    
    @media (max-width: 768px) {
      .hpc-panel {
        width: 100%;
      }
    }
  `;
}
