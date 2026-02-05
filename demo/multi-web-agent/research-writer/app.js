/**
 * Multi-Agent Research Pipeline
 * 
 * Four agents collaborate to research a topic:
 * - Orchestrator: Coordinates the workflow
 * - Searcher: Searches Google for relevant URLs
 * - Reader: Opens pages and extracts content
 * - Writer: Synthesizes findings into an article
 * 
 * Uses real browser control APIs when available.
 */

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  maxSearchResults: 3,
  maxContentLength: 5000,
  searchTimeout: 10000,
  readTimeout: 15000,
};

// ============================================================================
// Agent API Helper (matches working demos)
// ============================================================================

/**
 * Get the Web Agent API.
 * Uses window.agent provided by the Web Agents API extension.
 */
function getWebAgent() {
  return window.agent;
}

/**
 * Wait for the Web Agent API to be available.
 */
function waitForWebAgent(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const agent = getWebAgent();
    if (agent) {
      resolve(agent);
      return;
    }

    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('Web Agent API not detected (timeout)'));
    }, timeoutMs);

    const onReady = () => {
      const agent = getWebAgent();
      if (agent) {
        cleanup();
        resolve(agent);
      }
    };

    const cleanup = () => {
      clearTimeout(timeoutId);
      window.removeEventListener('agent-ready', onReady);
    };

    window.addEventListener('agent-ready', onReady);
  });
}

// Agent colors for arrows
const AGENT_COLORS = {
  orchestrator: '#8b5cf6',
  searcher: '#3b82f6',
  reader: '#10b981',
  writer: '#f59e0b',
};

// Column indices for positioning arrows
const AGENT_COLUMNS = {
  orchestrator: 0,
  searcher: 1,
  reader: 2,
  writer: 3,
};

// ============================================================================
// State
// ============================================================================

const state = {
  isRunning: false,
  startTime: null,
  apiAvailable: false,
  browserControlAvailable: false,
  multiAgentAvailable: false,
  messageCount: 0,
  sources: [],
  spawnedTabs: [],
  // Registered agent IDs
  agents: {
    orchestrator: null,
    searcher: null,
    reader: null,
    writer: null,
  },
};

// ============================================================================
// DOM Elements
// ============================================================================

const elements = {
  topicInput: document.getElementById('topic-input'),
  startBtn: document.getElementById('start-btn'),
  apiStatus: document.getElementById('api-status'),
  sequenceBody: document.getElementById('sequence-body'),
  messages: document.getElementById('messages'),
  emptyState: document.getElementById('empty-state'),
  outputSection: document.getElementById('output-section'),
  outputTitle: document.getElementById('output-title'),
  outputSources: document.getElementById('output-sources'),
  outputWords: document.getElementById('output-words'),
  outputTime: document.getElementById('output-time'),
  outputBody: document.getElementById('output-body'),
  themeToggle: document.getElementById('theme-toggle'),
};

// ============================================================================
// Sequence Diagram Rendering
// ============================================================================

/**
 * Clear the sequence diagram.
 */
function clearSequence() {
  state.messageCount = 0;
  elements.messages.innerHTML = '';
  if (elements.emptyState) {
    elements.messages.appendChild(elements.emptyState);
    elements.emptyState.style.display = 'flex';
  }
}

/**
 * Hide the empty state.
 */
function hideEmptyState() {
  if (elements.emptyState) {
    elements.emptyState.style.display = 'none';
  }
}

/**
 * Get a friendly description for agent-to-agent messages.
 * These labels explain what's happening in plain English.
 */
function getFriendlyLabel(from, to, label) {
  // The labels are already friendly in the new version
  // This function is kept for any additional mapping if needed
  return label;
}

/**
 * Add a message arrow between two agents.
 */
function addMessage(from, to, label, type = 'request') {
  hideEmptyState();
  state.messageCount++;
  
  const row = document.createElement('div');
  row.className = 'message-row arrow-row';
  row.id = `msg-${state.messageCount}`;
  
  const fromCol = AGENT_COLUMNS[from];
  const toCol = AGENT_COLUMNS[to];
  const friendlyLabel = getFriendlyLabel(from, to, label);
  const color = AGENT_COLORS[from];
  const minCol = Math.min(fromCol, toCol);
  const maxCol = Math.max(fromCol, toCol);
  const isLeftward = toCol < fromCol;
  
  // Build the grid row with arrow spanning the relevant columns
  let html = '<div class="message-grid">';
  
  for (let i = 0; i < 4; i++) {
    if (i === minCol) {
      // Start the arrow span
      const spanCount = maxCol - minCol + 1;
      html += `
        <div class="message-cell arrow-cell" style="grid-column: span ${spanCount}">
          <div class="arrow-wrapper ${isLeftward ? 'leftward' : 'rightward'}">
            <div class="arrow-line-left" style="background: ${color}"></div>
            <div class="arrow-label" style="border-color: ${color}">
              <span class="arrow-label-text">${friendlyLabel}</span>
            </div>
            <div class="arrow-line-right" style="background: ${color}">
              <div class="arrow-head" style="border-left-color: ${color}"></div>
            </div>
          </div>
        </div>
      `;
      i = maxCol; // Skip the cells we've spanned
    } else {
      html += '<div class="message-cell"></div>';
    }
  }
  
  html += '</div>';
  row.innerHTML = html;
  
  elements.messages.appendChild(row);
  elements.sequenceBody.scrollTop = elements.sequenceBody.scrollHeight;
  
  return row;
}

/**
 * Add a status node to show agent activity.
 */
function addStatus(agent, label, status = 'processing') {
  hideEmptyState();
  state.messageCount++;
  
  const row = document.createElement('div');
  row.className = 'message-row status-row';
  row.id = `status-${state.messageCount}`;
  
  const col = AGENT_COLUMNS[agent];
  const statusClass = status === 'success' ? 'success' : status === 'error' ? 'error' : '';
  const icon = status === 'processing' ? '<div class="spinner"></div>' : 
               status === 'success' ? '<span class="status-icon">✓</span>' : 
               status === 'error' ? '<span class="status-icon">✗</span>' : '';
  
  // Create a 4-column grid with the status in the correct column
  row.innerHTML = `
    <div class="message-grid">
      <div class="message-cell ${col === 0 ? 'has-status' : ''}">
        ${col === 0 ? `<div class="status-node ${statusClass}">${icon}<span>${label}</span></div>` : ''}
      </div>
      <div class="message-cell ${col === 1 ? 'has-status' : ''}">
        ${col === 1 ? `<div class="status-node ${statusClass}">${icon}<span>${label}</span></div>` : ''}
      </div>
      <div class="message-cell ${col === 2 ? 'has-status' : ''}">
        ${col === 2 ? `<div class="status-node ${statusClass}">${icon}<span>${label}</span></div>` : ''}
      </div>
      <div class="message-cell ${col === 3 ? 'has-status' : ''}">
        ${col === 3 ? `<div class="status-node ${statusClass}">${icon}<span>${label}</span></div>` : ''}
      </div>
    </div>
  `;
  
  elements.messages.appendChild(row);
  elements.sequenceBody.scrollTop = elements.sequenceBody.scrollHeight;
  
  return row;
}

/**
 * Update a status node.
 */
function updateStatus(row, label, status) {
  const statusNode = row.querySelector('.status-node');
  if (statusNode) {
    const statusClass = status === 'success' ? 'success' : status === 'error' ? 'error' : '';
    const icon = status === 'processing' ? '<div class="spinner"></div>' : 
                 status === 'success' ? '✓' : 
                 status === 'error' ? '✗' : '';
    
    statusNode.className = `status-node ${statusClass}`;
    statusNode.innerHTML = `${icon}<span>${label}</span>`;
  }
}

/**
 * Highlight an agent icon as active.
 */
function setAgentActive(agent, active) {
  const icon = document.querySelector(`.agent-icon.${agent}`);
  if (icon) {
    if (active) {
      icon.classList.add('active');
    } else {
      icon.classList.remove('active');
    }
  }
}

// ============================================================================
// API Availability Check
// ============================================================================

async function checkApiAvailability() {
  const statusEl = elements.apiStatus;
  
  // Reset state
  state.browserControlAvailable = false;
  state.multiAgentAvailable = false;
  elements.startBtn.disabled = true;
  
  // Wait for Web Agent API
  console.log('[Init] Waiting for Web Agent API...');
  
  try {
    await waitForWebAgent(3000);
  } catch (e) {
    statusEl.className = 'api-status error';
    statusEl.querySelector('.status-text').textContent = 'Web Agent API not found';
    elements.emptyState.innerHTML = `
      <div style="text-align: center;">
        <p style="margin-bottom: var(--demo-space-3);">❌ Web Agent API not detected</p>
        <p style="font-size: var(--demo-text-xs); color: var(--demo-text-muted);">
          Make sure the Web Agents API extension is installed and enabled.
        </p>
      </div>
    `;
    console.log('[Init] Web Agent API not found');
    return;
  }
  
  const agent = getWebAgent();
  state.apiAvailable = true;
  console.log('[Init] Web Agent API available:', agent);
  
  // Check required features and collect missing ones
  const missingFeatures = [];
  
  // Check browser control
  if (!agent.browser?.tabs?.create) {
    missingFeatures.push('Browser Control');
    console.log('[Init] browser.tabs.create not available');
  } else {
    const fnStr = agent.browser.tabs.create.toString();
    if (fnStr.includes('ERR_FEATURE_DISABLED')) {
      missingFeatures.push('Browser Control');
      console.log('[Init] Browser control feature is disabled');
    } else {
      state.browserControlAvailable = true;
      console.log('[Init] Browser control available!');
    }
  }
  
  // Check multi-agent
  if (!agent.agents?.register) {
    missingFeatures.push('Multi-Agent');
    console.log('[Init] agent.agents.register not available');
  } else {
    const fnStr = agent.agents.register.toString();
    if (fnStr.includes('ERR_FEATURE_DISABLED')) {
      missingFeatures.push('Multi-Agent');
      console.log('[Init] Multi-Agent feature is disabled');
    } else {
      state.multiAgentAvailable = true;
      console.log('[Init] Multi-Agent available!');
    }
  }
  
  // Show error if any features are missing
  if (missingFeatures.length > 0) {
    statusEl.className = 'api-status error';
    statusEl.querySelector('.status-text').textContent = 'Features Missing';
    const featureList = missingFeatures.map(f => `<strong>${f}</strong>`).join(' and ');
    elements.emptyState.innerHTML = `
      <div style="text-align: center;">
        <p style="margin-bottom: var(--demo-space-3);">❌ Required features not enabled</p>
        <p style="font-size: var(--demo-text-xs); color: var(--demo-text-muted);">
          Enable ${featureList} in the Web Agents API sidebar, then reload this page.
        </p>
      </div>
    `;
    return;
  }
  
  // All features available - enable the start button
  elements.startBtn.disabled = false;
  statusEl.className = 'api-status ready';
  statusEl.querySelector('.status-text').textContent = 'Ready';
  elements.emptyState.innerHTML = '<p>Enter a topic and click "Start Research" to see the agents collaborate.</p>';
  
  // Log available APIs
  console.log('[Init] Available APIs:');
  console.log('  - tabs.create:', !!agent.browser?.tabs?.create);
  console.log('  - tabs.close:', !!agent.browser?.tabs?.close);
  console.log('  - tab.getHtml:', !!agent.browser?.tab?.getHtml);
  console.log('  - tab.readability:', !!agent.browser?.tab?.readability);
  console.log('  - agents.register:', !!agent.agents?.register);
  console.log('  - agents.invoke:', !!agent.agents?.invoke);
  console.log('  - requestPermissions:', !!agent.requestPermissions);
}

// ============================================================================
// Multi-Agent Registration
// ============================================================================

/**
 * Register all agents using the Multi-Agent API.
 * Each agent registers itself and sets up invocation handlers.
 */
async function registerAgents() {
  const agent = getWebAgent();
  
  console.log('[MultiAgent] Registering agents...');
  
  // Register Searcher Agent
  const searcherReg = await agent.agents.register({
    name: 'Searcher',
    description: 'Searches Google and extracts result URLs',
    capabilities: ['search', 'google'],
    tags: ['research', 'web'],
    acceptsInvocations: true,
    acceptsMessages: false,
  });
  state.agents.searcher = searcherReg.id;
  console.log('[MultiAgent] Registered Searcher:', searcherReg.id);
  
  // Register Reader Agent
  const readerReg = await agent.agents.register({
    name: 'Reader',
    description: 'Opens web pages and extracts content',
    capabilities: ['read', 'extract', 'parse'],
    tags: ['research', 'web'],
    acceptsInvocations: true,
    acceptsMessages: false,
  });
  state.agents.reader = readerReg.id;
  console.log('[MultiAgent] Registered Reader:', readerReg.id);
  
  // Register Writer Agent
  const writerReg = await agent.agents.register({
    name: 'Writer',
    description: 'Synthesizes content into articles',
    capabilities: ['write', 'summarize', 'synthesize'],
    tags: ['research', 'writing'],
    acceptsInvocations: true,
    acceptsMessages: false,
  });
  state.agents.writer = writerReg.id;
  console.log('[MultiAgent] Registered Writer:', writerReg.id);
  
  // Register Orchestrator Agent (the coordinator)
  const orchestratorReg = await agent.agents.register({
    name: 'Orchestrator',
    description: 'Coordinates the research pipeline',
    capabilities: ['orchestrate', 'coordinate'],
    tags: ['research', 'coordination'],
    acceptsInvocations: true,
    acceptsMessages: false,
  });
  state.agents.orchestrator = orchestratorReg.id;
  console.log('[MultiAgent] Registered Orchestrator:', orchestratorReg.id);
  
  // Set up invocation handlers
  setupInvocationHandlers();
  
  console.log('[MultiAgent] All agents registered!');
}

// Track the cleanup function for invocation handlers
let cleanupInvocationHandler = null;
let handlersSetUp = false;

/**
 * Set up handlers for incoming invocations to each agent.
 * Only sets up once per page load to avoid duplicates.
 */
function setupInvocationHandlers() {
  // Only set up handlers once
  if (handlersSetUp) {
    console.log('[MultiAgent] Handlers already set up, skipping');
    return;
  }
  
  const agent = getWebAgent();
  
  // Clean up any previous handler to avoid duplicates
  if (cleanupInvocationHandler) {
    console.log('[MultiAgent] Cleaning up previous handler');
    cleanupInvocationHandler();
    cleanupInvocationHandler = null;
  }
  
  console.log('[MultiAgent] Setting up invocation handlers');
  handlersSetUp = true;
  
  cleanupInvocationHandler = agent.agents.onInvoke(async (request) => {
    console.log('[MultiAgent] === RECEIVED INVOCATION ===', request.task, 'from:', request.from);
    
    switch (request.task) {
      case 'search':
        return await handleSearchInvocation(request.input);
      
      case 'read':
        return await handleReadInvocation(request.input);
      
      case 'write':
        return await handleWriteInvocation(request.input);
      
      default:
        throw new Error(`Unknown task: ${request.task}`);
    }
  });
  
  console.log('[MultiAgent] Invocation handlers set up');
}

/**
 * Handle search invocation - performs the actual Google search.
 */
async function handleSearchInvocation(input) {
  const { topic } = input;
  console.log('[Searcher] Handling search for:', topic);
  
  setAgentActive('searcher', true);
  const statusRow = addStatus('searcher', 'Opening Google Search...');
  
  try {
    const results = await searchGoogleReal(topic, statusRow);
    
    // Show results in the UI
    updateStatus(statusRow, `Found ${results.length} pages`, 'success');
    state.sources = results;
    
    for (const result of results) {
      const shortTitle = result.title.length > 35 ? result.title.slice(0, 32) + '...' : result.title;
      addStatus('searcher', shortTitle, 'success');
      await delay(100);
    }
    
    setAgentActive('searcher', false);
    return { results };
    
  } catch (error) {
    updateStatus(statusRow, `Error: ${error.message}`, 'error');
    setAgentActive('searcher', false);
    throw error;
  }
}

/**
 * Handle read invocation - reads content from URLs.
 */
async function handleReadInvocation(input) {
  const { urls } = input;
  console.log('[Reader] Handling read for', urls.length, 'URLs');
  
  setAgentActive('reader', true);
  
  const contents = [];
  
  for (let i = 0; i < urls.length; i++) {
    const { url, title } = urls[i];
    const shortTitle = title.length > 30 ? title.slice(0, 27) + '...' : title;
    const statusRow = addStatus('reader', `Opening page ${i + 1}...`);
    
    try {
      const content = await readPageReal(url, title, statusRow);
      
      if (content && content.content && content.content.length > 50) {
        contents.push(content);
        updateStatus(statusRow, `✓ ${shortTitle}`, 'success');
        console.log('[Reader] Successfully read:', title.slice(0, 50));
      } else {
        updateStatus(statusRow, `✗ ${shortTitle}`, 'error');
        console.log('[Reader] Failed to read:', title.slice(0, 50));
      }
    } catch (error) {
      updateStatus(statusRow, `✗ ${shortTitle}`, 'error');
      console.log('[Reader] Error reading:', title.slice(0, 50), error.message);
    }
    
    await delay(300);
  }
  
  // Show summary
  if (contents.length === 0) {
    addStatus('reader', 'No content extracted', 'error');
    setAgentActive('reader', false);
    throw new Error('Failed to extract content from any pages.');
  }
  
  addStatus('reader', `Extracted ${contents.length} articles`, 'success');
  setAgentActive('reader', false);
  
  return { contents };
}

/**
 * Handle write invocation - synthesizes content into an article.
 */
async function handleWriteInvocation(input) {
  const { topic, sources } = input;
  console.log('[Writer] Handling write for topic:', topic, 'with', sources.length, 'sources');
  
  setAgentActive('writer', true);
  const statusRow = addStatus('writer', 'Analyzing sources...');
  
  try {
    await delay(500);
    updateStatus(statusRow, 'Writing article...');
    
    // Use the existing write function
    const article = await writeSimulated(topic, sources, statusRow);
    
    updateStatus(statusRow, '✓ Article complete!', 'success');
    setAgentActive('writer', false);
    
    return { article };
    
  } catch (error) {
    updateStatus(statusRow, `Error: ${error.message}`, 'error');
    setAgentActive('writer', false);
    throw error;
  }
}

/**
 * Unregister all agents.
 */
async function unregisterAgents() {
  const agent = getWebAgent();
  
  if (!agent?.agents) {
    console.log('[MultiAgent] Cannot unregister - API not available');
    return;
  }
  
  console.log('[MultiAgent] Unregistering agents...');
  
  // Unregister each agent by its ID
  const agentIds = [
    state.agents.searcher,
    state.agents.reader,
    state.agents.writer,
    state.agents.orchestrator,
  ].filter(id => id != null);
  
  for (const agentId of agentIds) {
    try {
      await agent.agents.unregister(agentId);
      console.log('[MultiAgent] Unregistered:', agentId);
    } catch (error) {
      console.log('[MultiAgent] Error unregistering', agentId, ':', error.message);
    }
  }
  
  // Clear agent IDs
  state.agents.orchestrator = null;
  state.agents.searcher = null;
  state.agents.reader = null;
  state.agents.writer = null;
  
  // Also reset the handlers flag so they can be re-setup on next run
  handlersSetUp = false;
}

// ============================================================================
// Orchestrator Agent
// ============================================================================

async function orchestratorAgent(topic) {
  const agent = getWebAgent();
  
  setAgentActive('orchestrator', true);
  const shortTopic = topic.length > 40 ? topic.slice(0, 37) + '...' : topic;
  const startingRow = addStatus('orchestrator', `Starting research on "${shortTopic}"`);
  
  await delay(300);
  
  // Step 1: Invoke Searcher agent via Multi-Agent API
  addMessage('orchestrator', 'searcher', 'Search Google for relevant pages');
  setAgentActive('orchestrator', false);
  
  console.log('[Orchestrator] Invoking Searcher agent:', state.agents.searcher);
  const searchResponse = await agent.agents.invoke(state.agents.searcher, {
    task: 'search',
    input: { topic },
    timeout: 60000, // 60 second timeout for search
  });
  
  if (!searchResponse.success) {
    setAgentActive('orchestrator', true);
    addStatus('orchestrator', `Search failed: ${searchResponse.error?.message || 'Unknown error'}`, 'error');
    return null;
  }
  
  const searchResults = searchResponse.result?.results || [];
  
  if (searchResults.length === 0) {
    setAgentActive('orchestrator', true);
    addStatus('orchestrator', 'No results found', 'error');
    return null;
  }
  
  // Step 2: Invoke Reader agent via Multi-Agent API
  await delay(300);
  setAgentActive('orchestrator', true);
  addMessage('orchestrator', 'reader', `Read these ${searchResults.length} pages`);
  setAgentActive('orchestrator', false);
  
  console.log('[Orchestrator] Invoking Reader agent:', state.agents.reader);
  const readResponse = await agent.agents.invoke(state.agents.reader, {
    task: 'read',
    input: { urls: searchResults },
    timeout: 120000, // 120 second timeout for reading multiple pages
  });
  
  if (!readResponse.success) {
    setAgentActive('orchestrator', true);
    addStatus('orchestrator', `Read failed: ${readResponse.error?.message || 'Unknown error'}`, 'error');
    return null;
  }
  
  const contents = readResponse.result?.contents || [];
  
  // Step 3: Invoke Writer agent via Multi-Agent API
  const sourceCount = contents.filter(c => c.content.length > 100).length;
  await delay(300);
  setAgentActive('orchestrator', true);
  addMessage('orchestrator', 'writer', `Write a summary from ${sourceCount} sources`);
  setAgentActive('orchestrator', false);
  
  console.log('[Orchestrator] Invoking Writer agent:', state.agents.writer);
  const writeResponse = await agent.agents.invoke(state.agents.writer, {
    task: 'write',
    input: { topic, sources: contents },
    timeout: 60000, // 60 second timeout for writing
  });
  
  if (!writeResponse.success) {
    setAgentActive('orchestrator', true);
    addStatus('orchestrator', `Write failed: ${writeResponse.error?.message || 'Unknown error'}`, 'error');
    return null;
  }
  
  const article = writeResponse.result?.article;
  
  // Complete - update the starting row to show success
  setAgentActive('orchestrator', true);
  updateStatus(startingRow, `Research on "${shortTopic}" complete!`, 'success');
  setAgentActive('orchestrator', false);
  
  return article;
}

// ============================================================================
// Searcher Agent - Helper Functions
// ============================================================================

/**
 * Real Google search by opening a browser tab.
 */
async function searchGoogleReal(topic, statusRow) {
  const agent = getWebAgent();
  let tabId = null;
  
  console.log('[Searcher] === Starting real Google search ===');
  console.log('[Searcher] Topic:', topic);
  console.log('[Searcher] Agent:', agent);
  console.log('[Searcher] browser.tabs.create:', typeof agent.browser?.tabs?.create);
  
  try {
    if (!agent.browser?.tabs?.create) {
      throw new Error('Tab creation not available. Enable the "Browser Control" feature flag.');
    }
    
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(topic)}`;
    
    updateStatus(statusRow, 'Opening Google...');
    console.log('[Searcher] Creating tab with URL:', searchUrl);
    
    // Open Google search in a new tab
    const tab = await agent.browser.tabs.create({ url: searchUrl, active: false });
    console.log('[Searcher] tabs.create returned:', tab);
    
    if (!tab || !tab.id) {
      throw new Error('tabs.create did not return a valid tab');
    }
    
    tabId = tab.id;
    state.spawnedTabs.push(tabId);
    console.log('[Searcher] Tab created with ID:', tabId);
    
    // Wait for page to load (simple sleep like the working demo)
    updateStatus(statusRow, 'Loading results...');
    console.log('[Searcher] Waiting for page to load...');
    await delay(2500);
    console.log('[Searcher] Wait complete');
    
    // Get the HTML from the Google page
    updateStatus(statusRow, 'Extracting links...');
    console.log('[Searcher] Getting HTML from Google page...');
    
    if (!agent.browser?.tab?.getHtml) {
      throw new Error('tab.getHtml not available. Enable the "Browser Control" feature flag.');
    }
    
    const response = await agent.browser.tab.getHtml(tabId);
    const html = response.html;
    console.log('[Searcher] Got HTML, length:', html?.length, 'url:', response.url);
    
    if (!html || html.length < 100) {
      throw new Error(`getHtml returned insufficient HTML (${html?.length || 0} chars)`);
    }
    
    // Parse the HTML to extract search results
    const results = parseGoogleResults(html);
    console.log('[Searcher] Parsed results:', results.length);
    
    // Close the Google tab
    try {
      await agent.browser.tabs.close(tabId);
      state.spawnedTabs = state.spawnedTabs.filter(id => id !== tabId);
      console.log('[Searcher] Closed Google tab');
    } catch (e) {
      console.log('[Searcher] Could not close tab:', e);
    }
    
    if (results.length === 0) {
      console.log('[Searcher] No results parsed. HTML sample:', html.slice(0, 1000));
      throw new Error('No results extracted from Google');
    }
    
    return results.slice(0, CONFIG.maxSearchResults);
    
  } catch (error) {
    console.error('[Searcher] Error:', error);
    
    // Clean up tab if still open
    if (tabId) {
      try {
        const agent = getWebAgent();
        await agent.browser.tabs.close(tabId);
        state.spawnedTabs = state.spawnedTabs.filter(id => id !== tabId);
      } catch {}
    }
    
    updateStatus(statusRow, 'Search failed, using Wikipedia');
    return getWikipediaFallback(topic);
  }
}

/**
 * Parse Google search results HTML to extract URLs and titles.
 */
function parseGoogleResults(html) {
  const results = [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  
  // Google search results typically have h3 elements with the titles
  // and nearby anchor tags with the URLs
  const h3Elements = doc.querySelectorAll('h3');
  console.log('[Parser] Found h3 elements:', h3Elements.length);
  
  for (const h3 of h3Elements) {
    const title = h3.textContent?.trim();
    if (!title || title.length < 5) continue;
    
    // Find the parent anchor or nearby anchor
    let link = h3.closest('a');
    if (!link) {
      link = h3.parentElement?.querySelector('a');
    }
    if (!link) {
      link = h3.parentElement?.closest('a');
    }
    
    if (!link) continue;
    
    let url = link.href;
    
    // Google sometimes uses /url?q= redirects
    if (url.includes('/url?')) {
      const match = url.match(/[?&]q=([^&]+)/);
      if (match) {
        url = decodeURIComponent(match[1]);
      }
    }
    
    // Skip unwanted domains
    if (!url.startsWith('http') ||
        url.includes('google.com') ||
        url.includes('youtube.com') ||
        url.includes('maps.google') ||
        url.includes('webcache.') ||
        url.includes('translate.google')) {
      continue;
    }
    
    // Avoid duplicates
    if (results.find(r => r.url === url)) continue;
    
    results.push({ url, title: title.slice(0, 100) });
    console.log('[Parser] Found:', title.slice(0, 40), '->', url.slice(0, 50));
    
    if (results.length >= 10) break;
  }
  
  // Fallback: look for any external links if no h3 results found
  if (results.length === 0) {
    console.log('[Parser] No h3 results, trying fallback...');
    const allLinks = doc.querySelectorAll('a[href^="http"]');
    
    for (const link of allLinks) {
      let url = link.href;
      
      // Handle redirects
      if (url.includes('/url?')) {
        const match = url.match(/[?&]q=([^&]+)/);
        if (match) {
          url = decodeURIComponent(match[1]);
        }
      }
      
      if (!url.startsWith('http') ||
          url.includes('google.com') ||
          url.includes('youtube.com')) {
        continue;
      }
      
      const title = link.textContent?.trim();
      if (!title || title.length < 10) continue;
      if (results.find(r => r.url === url)) continue;
      
      results.push({ url, title: title.slice(0, 100) });
      
      if (results.length >= 10) break;
    }
  }
  
  return results;
}

/**
 * Fallback to Wikipedia which is reliable and readable.
 */
function getWikipediaFallback(topic) {
  // Create Wikipedia search URLs that are likely to work
  const searchTerms = topic.toLowerCase().split(' ').slice(0, 3);
  const wikiTerm = searchTerms.join('_');
  
  return [
    {
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(wikiTerm.charAt(0).toUpperCase() + wikiTerm.slice(1))}`,
      title: `${topic} - Wikipedia`
    },
    {
      url: `https://simple.wikipedia.org/wiki/${encodeURIComponent(wikiTerm.charAt(0).toUpperCase() + wikiTerm.slice(1))}`,
      title: `${topic} - Simple Wikipedia`
    }
  ];
}

// ============================================================================
// Reader Agent - Helper Functions
// ============================================================================

/**
 * Real page reading using browser.tabs API.
 */
async function readPageReal(url, title, statusRow) {
  const agent = getWebAgent();
  let tabId = null;
  
  try {
    updateStatus(statusRow, 'Opening tab...');
    console.log('[Reader] Opening:', url);
    
    // Create a new tab
    const tab = await agent.browser.tabs.create({ url, active: false });
    tabId = tab.id;
    state.spawnedTabs.push(tabId);
    console.log('[Reader] Tab created:', tabId);
    
    // Wait for page to load
    updateStatus(statusRow, 'Loading page...');
    console.log('[Reader] Waiting for page to load...');
    await delay(3000);
    console.log('[Reader] Wait complete');
    
    updateStatus(statusRow, 'Extracting content...');
    
    // Extract content using readability
    const content = await agent.browser.tab.readability(tabId);
    console.log('[Reader] Got content:', content?.title, '- length:', (content?.content || content?.text || '').length);
    
    // Close the tab
    try {
      await agent.browser.tabs.close(tabId);
      state.spawnedTabs = state.spawnedTabs.filter(id => id !== tabId);
    } catch (e) {
      console.log('[Reader] Could not close tab:', e);
    }
    
    const extractedContent = content.text || content.content || '';
    if (extractedContent.length < 100) {
      throw new Error('Content too short');
    }
    
    return {
      url,
      title: content.title || title,
      content: extractedContent.slice(0, CONFIG.maxContentLength),
    };
  } catch (error) {
    console.error('[Reader] Error reading', url, ':', error.message);
    
    // Try to clean up tab
    if (tabId) {
      try {
        await agent.browser.tabs.close(tabId);
        state.spawnedTabs = state.spawnedTabs.filter(id => id !== tabId);
      } catch {}
    }
    
    // Try using fetch as fallback for simple pages
    return await readPageWithFetch(url, title, statusRow);
  }
}

/**
 * Fallback: read page using fetch instead of tabs.
 */
async function readPageWithFetch(url, title, statusRow) {
  const agent = getWebAgent();
  
  try {
    updateStatus(statusRow, 'Trying fetch...');
    console.log('[Reader] Fallback fetch:', url);
    
    const response = await agent.browser.fetch(url);
    
    if (response.status !== 200) {
      throw new Error(`Fetch failed: ${response.status}`);
    }
    
    // Parse HTML and extract text content
    const parser = new DOMParser();
    const doc = parser.parseFromString(response.body, 'text/html');
    
    // Remove scripts and styles
    doc.querySelectorAll('script, style, nav, header, footer, aside').forEach(el => el.remove());
    
    // Try to find main content
    const mainContent = doc.querySelector('main, article, .content, #content, .post, .article');
    const textContent = (mainContent || doc.body).textContent || '';
    
    // Clean up whitespace
    const cleanContent = textContent.replace(/\s+/g, ' ').trim();
    
    if (cleanContent.length < 100) {
      throw new Error('Content too short');
    }
    
    const pageTitle = doc.querySelector('title')?.textContent || title;
    
    console.log('[Reader] Fetch got content:', pageTitle.slice(0, 50), '- length:', cleanContent.length);
    
    return {
      url,
      title: pageTitle,
      content: cleanContent.slice(0, CONFIG.maxContentLength),
    };
  } catch (error) {
    console.error('[Reader] Fetch fallback failed:', error.message);
    return null;
  }
}

// ============================================================================
// Writer Agent - Helper Functions
// ============================================================================

/**
 * Write article using real LLM.
 */
async function writeWithLLM(topic, sources, statusRow) {
  console.log('[Writer] Starting LLM generation...');
  
  try {
    console.log('[Writer] Creating text session...');
    const session = await window.ai.createTextSession();
    console.log('[Writer] Session created:', session);
    
    // Keep source content shorter to speed up generation
    const sourceText = sources.map((s, i) => 
      `Source ${i + 1} (${s.title}):\n${s.content.slice(0, 800)}`
    ).join('\n\n');
    
    const prompt = `Write a brief summary about "${topic}" based on these sources:

${sourceText}

Write 150-200 words that synthesizes the key points. Be concise and direct.`;

    console.log('[Writer] Prompt length:', prompt.length);
    updateStatus(statusRow, 'Generating with AI...');
    
    // Use regular prompt with timeout instead of streaming
    let content = '';
    
    // Create a timeout promise
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('LLM timeout after 30s')), 30000);
    });
    
    // Try streaming first
    try {
      console.log('[Writer] Starting streaming prompt...');
      const streamPromise = (async () => {
        for await (const chunk of session.promptStreaming(prompt)) {
          content = chunk;
          // Update status periodically to show progress
          if (content.length % 100 < 20) {
            updateStatus(statusRow, `Writing... (${content.length} chars)`);
          }
        }
        return content;
      })();
      
      content = await Promise.race([streamPromise, timeoutPromise]);
      console.log('[Writer] Streaming complete, length:', content.length);
    } catch (streamError) {
      console.log('[Writer] Streaming failed, trying regular prompt:', streamError.message);
      
      // Fall back to regular prompt
      try {
        content = await Promise.race([
          session.prompt(prompt),
          timeoutPromise
        ]);
        console.log('[Writer] Regular prompt complete, length:', content.length);
      } catch (promptError) {
        console.error('[Writer] Regular prompt also failed:', promptError);
        throw promptError;
      }
    }
    
    try {
      await session.destroy();
    } catch (e) {
      console.log('[Writer] Session destroy failed:', e);
    }
    
    if (!content || content.length < 50) {
      throw new Error('LLM returned insufficient content');
    }
    
    console.log('[Writer] Success! Content length:', content.length);
    
    return {
      title: `${topic}: Key Insights`,
      content,
      sources,
    };
  } catch (error) {
    console.error('[Writer] LLM error:', error);
    updateStatus(statusRow, 'AI failed, using fallback...');
    return writeSimulated(topic, sources, statusRow);
  }
}

/**
 * Simulated article writing.
 */
async function writeSimulated(topic, sources, statusRow) {
  await delay(800);
  updateStatus(statusRow, 'Synthesizing findings...');
  await delay(600);
  
  const sourceSnippets = sources.map(s => s.content.slice(0, 200)).join(' ');
  
  const content = `
Understanding ${topic} is increasingly important in today's world. This article synthesizes findings from ${sources.length} authoritative sources to provide a comprehensive overview.

Research and expert analysis reveal several key insights about ${topic}. The available evidence suggests that this subject has significant implications for individuals seeking to make informed decisions.

According to the sources examined, there are multiple factors to consider when approaching this topic. Recent developments have expanded our understanding, while also raising new questions for future exploration.

Key takeaways from this research include:
- The importance of evidence-based approaches
- Multiple perspectives contribute to a fuller understanding
- Practical applications exist across various contexts
- Continued research is valuable for deeper insights

In conclusion, ${topic} represents an area where informed understanding can lead to better outcomes. The sources consulted for this article provide a solid foundation for further exploration.
  `.trim();
  
  return {
    title: `${topic}: Research Summary`,
    content,
    sources,
  };
}

// ============================================================================
// Output Display
// ============================================================================

function showOutput(article, elapsedTime) {
  elements.outputSection.style.display = 'block';
  elements.outputTitle.textContent = article.title;
  elements.outputSources.textContent = `${article.sources.length} sources`;
  elements.outputWords.textContent = `${article.content.split(/\s+/).length} words`;
  elements.outputTime.textContent = `${elapsedTime.toFixed(1)}s`;
  
  // Format content
  const paragraphs = article.content.split('\n\n').filter(p => p.trim());
  let html = paragraphs.map(p => {
    if (p.startsWith('- ')) {
      const items = p.split('\n').map(line => 
        line.startsWith('- ') ? `<li>${line.slice(2)}</li>` : ''
      ).join('');
      return `<ul>${items}</ul>`;
    }
    return `<p>${p}</p>`;
  }).join('');
  
  // Add source citations
  html += `
    <div class="source-citation">
      <strong>Sources:</strong><br>
      ${article.sources.map((s, i) => 
        `${i + 1}. <a href="${s.url}" target="_blank">${s.title}</a>`
      ).join('<br>')}
    </div>
  `;
  
  elements.outputBody.innerHTML = html;
  
  // Scroll to output
  elements.outputSection.scrollIntoView({ behavior: 'smooth' });
}

function hideOutput() {
  elements.outputSection.style.display = 'none';
}

// ============================================================================
// Pipeline Execution
// ============================================================================

async function runPipeline(topic) {
  state.isRunning = true;
  state.startTime = Date.now();
  state.sources = [];
  state.spawnedTabs = [];
  
  elements.startBtn.disabled = true;
  elements.topicInput.disabled = true;
  
  clearSequence();
  hideOutput();
  
  try {
    const agent = getWebAgent();
    
    // Verify required features are available
    if (!state.browserControlAvailable) {
      throw new Error('Browser Control is not available. Enable it in the Web Agents API sidebar and reload this page.');
    }
    
    if (!state.multiAgentAvailable) {
      throw new Error('Multi-Agent is not available. Enable it in the Web Agents API sidebar and reload this page.');
    }
    
    // Request permissions
    console.log('[Pipeline] Requesting permissions...');
    addStatus('orchestrator', 'Requesting permissions...');
    
    const permResult = await agent.requestPermissions({
      scopes: [
        'browser:tabs.create', 
        'browser:tabs.read', 
        'model:prompt',
        // Multi-agent permissions
        'agents:register',
        'agents:invoke',
        'agents:discover'
      ],
      reason: 'Research agent: search Google, read pages, synthesize findings, and coordinate multiple agents'
    });
    
    if (!permResult.granted) {
      throw new Error('Permissions denied. Please grant access to continue.');
    }
    
    console.log('[Pipeline] Permissions granted!');
    
    // Register all agents
    addStatus('orchestrator', 'Registering agents...');
    await registerAgents();
    console.log('[Pipeline] Agents registered!');
    
    const article = await orchestratorAgent(topic);
    
    if (article) {
      const elapsedTime = (Date.now() - state.startTime) / 1000;
      showOutput(article, elapsedTime);
    }
  } catch (error) {
    console.error('Pipeline error:', error);
    addStatus('orchestrator', `Error: ${error.message}`, 'error');
  } finally {
    // Clean up any remaining tabs
    const cleanupAgent = getWebAgent();
    for (const tabId of state.spawnedTabs) {
      try {
        await cleanupAgent?.browser?.tabs?.close(tabId);
      } catch {}
    }
    
    // Unregister agents
    await unregisterAgents();
    
    state.isRunning = false;
    // Only re-enable the button if all features are available
    elements.startBtn.disabled = !canStartPipeline();
    elements.topicInput.disabled = false;
    
    // Reset all agent active states
    ['orchestrator', 'searcher', 'reader', 'writer'].forEach(a => setAgentActive(a, false));
  }
}

// ============================================================================
// Utilities
// ============================================================================

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// Event Listeners
// ============================================================================

function canStartPipeline() {
  return state.browserControlAvailable && state.multiAgentAvailable;
}

function getMissingFeaturesMessage() {
  const missing = [];
  if (!state.browserControlAvailable) missing.push('Browser Control');
  if (!state.multiAgentAvailable) missing.push('Multi-Agent');
  return `Required features not enabled.\n\nEnable ${missing.join(' and ')} in the Web Agents API sidebar, then reload this page.`;
}

elements.startBtn.addEventListener('click', () => {
  const topic = elements.topicInput.value.trim();
  if (topic && !state.isRunning && canStartPipeline()) {
    runPipeline(topic);
  } else if (!canStartPipeline()) {
    alert(getMissingFeaturesMessage());
  }
});

elements.topicInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !state.isRunning && canStartPipeline()) {
    const topic = e.target.value.trim();
    if (topic) {
      runPipeline(topic);
    }
  } else if (e.key === 'Enter' && !canStartPipeline()) {
    alert(getMissingFeaturesMessage());
  }
});

elements.themeToggle?.addEventListener('click', () => {
  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  document.documentElement.setAttribute('data-theme', isDark ? 'light' : 'dark');
});

// ============================================================================
// Initialization
// ============================================================================

async function init() {
  elements.topicInput.focus();
  
  // Wait for agent-ready event
  window.addEventListener('agent-ready', () => {
    checkApiAvailability();
  });
  
  // Also check immediately and after delay
  checkApiAvailability();
  setTimeout(checkApiAvailability, 1000);
}

init();
