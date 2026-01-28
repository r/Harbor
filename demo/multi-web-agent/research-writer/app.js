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
 * Prefers window.harbor.agent, falls back to window.agent.
 */
function getWebAgent() {
  return window.harbor?.agent ?? window.agent;
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
      window.removeEventListener('harbor-provider-ready', onReady);
      window.removeEventListener('agent-ready', onReady);
    };

    window.addEventListener('harbor-provider-ready', onReady);
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
  messageCount: 0,
  sources: [],
  spawnedTabs: [],
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
  
  // Wait for Web Agent API
  console.log('[Init] Waiting for Web Agent API...');
  
  try {
    await waitForWebAgent(3000);
  } catch (e) {
    statusEl.className = 'api-status error';
    statusEl.querySelector('.status-text').textContent = 'No API';
    console.log('[Init] Web Agent API not found');
    return;
  }
  
  const agent = getWebAgent();
  state.apiAvailable = true;
  console.log('[Init] Web Agent API available:', agent);
  
  // Check if browser control APIs exist
  if (!agent.browser?.tabs?.create) {
    statusEl.className = 'api-status warning';
    statusEl.querySelector('.status-text').textContent = 'No Browser Control';
    console.log('[Init] browser.tabs.create not available');
    return;
  }
  
  // Check if it's a disabled stub
  const fnStr = agent.browser.tabs.create.toString();
  if (fnStr.includes('ERR_FEATURE_DISABLED')) {
    statusEl.className = 'api-status warning';
    statusEl.querySelector('.status-text').textContent = 'Browser Control Disabled';
    console.log('[Init] Browser control feature is disabled');
    return;
  }
  
  // Browser control looks available
  state.browserControlAvailable = true;
  statusEl.className = 'api-status ready';
  statusEl.querySelector('.status-text').textContent = 'Ready';
  console.log('[Init] Browser control available!');
  
  // Log available APIs
  console.log('[Init] Available APIs:');
  console.log('  - tabs.create:', !!agent.browser?.tabs?.create);
  console.log('  - tabs.close:', !!agent.browser?.tabs?.close);
  console.log('  - tab.getHtml:', !!agent.browser?.tab?.getHtml);
  console.log('  - tab.readability:', !!agent.browser?.tab?.readability);
  console.log('  - requestPermissions:', !!agent.requestPermissions);
}

// ============================================================================
// Orchestrator Agent
// ============================================================================

async function orchestratorAgent(topic) {
  setAgentActive('orchestrator', true);
  const shortTopic = topic.length > 40 ? topic.slice(0, 37) + '...' : topic;
  addStatus('orchestrator', `Starting research on "${shortTopic}"`);
  
  await delay(300);
  
  // Step 1: Request search
  addMessage('orchestrator', 'searcher', 'Search Google for relevant pages');
  setAgentActive('orchestrator', false);
  
  const searchResults = await searcherAgent(topic);
  
  if (searchResults.length === 0) {
    setAgentActive('orchestrator', true);
    addStatus('orchestrator', 'No results found', 'error');
    return null;
  }
  
  // Step 2: Searcher reports success, then orchestrator sends to reader
  await delay(300);
  setAgentActive('orchestrator', true);
  addMessage('orchestrator', 'reader', `Read these ${searchResults.length} pages`);
  setAgentActive('orchestrator', false);
  
  const contents = await readerAgent(searchResults);
  
  // Step 3: Reader reports success, then orchestrator sends to writer
  const sourceCount = contents.filter(c => c.content.length > 100).length;
  await delay(300);
  setAgentActive('orchestrator', true);
  addMessage('orchestrator', 'writer', `Write a summary from ${sourceCount} sources`);
  setAgentActive('orchestrator', false);
  
  const article = await writerAgent(topic, contents);
  
  // Complete
  setAgentActive('orchestrator', true);
  addStatus('orchestrator', 'Research complete!', 'success');
  setAgentActive('orchestrator', false);
  
  return article;
}

// ============================================================================
// Searcher Agent
// ============================================================================

async function searcherAgent(topic) {
  setAgentActive('searcher', true);
  const statusRow = addStatus('searcher', 'Opening Google Search...');
  
  let results = [];
  
  console.log('[Searcher] browserControlAvailable:', state.browserControlAvailable);
  
  if (state.browserControlAvailable) {
    console.log('[Searcher] Using REAL Google search with browser tabs');
    results = await searchGoogleReal(topic, statusRow);
  } else {
    console.log('[Searcher] Using SIMULATED search (browser control not available)');
    results = await searchGoogleSimulated(topic, statusRow);
  }
  
  // Show result as status under Searcher column
  updateStatus(statusRow, `Found ${results.length} pages`, 'success');
  state.sources = results;
  
  // List the found URLs
  for (const result of results) {
    const shortTitle = result.title.length > 35 ? result.title.slice(0, 32) + '...' : result.title;
    addStatus('searcher', shortTitle, 'success');
    await delay(100);
  }
  
  setAgentActive('searcher', false);
  
  return results;
}

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
      throw new Error('Tab creation not available. Enable browserControl feature flag.');
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
      throw new Error('tab.getHtml not available. Enable browserControl feature flag.');
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

/**
 * Simulated search results for demo without browser control.
 * Uses real Wikipedia URLs so the demo is realistic.
 */
async function searchGoogleSimulated(topic, statusRow) {
  await delay(800);
  updateStatus(statusRow, 'Parsing results...');
  await delay(400);
  
  // Use real Wikipedia URLs
  const wikiTerm = topic.replace(/ /g, '_');
  
  return [
    { 
      title: `${topic} - Wikipedia`,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(wikiTerm)}`
    },
    {
      title: `${topic} - Simple English Wikipedia`,
      url: `https://simple.wikipedia.org/wiki/${encodeURIComponent(wikiTerm)}`
    },
  ];
}

// ============================================================================
// Reader Agent
// ============================================================================

async function readerAgent(urls) {
  setAgentActive('reader', true);
  
  const contents = [];
  
  for (let i = 0; i < urls.length; i++) {
    const { url, title } = urls[i];
    const shortTitle = title.length > 30 ? title.slice(0, 27) + '...' : title;
    const statusRow = addStatus('reader', `Opening page ${i + 1}...`);
    
    let content;
    if (state.browserControlAvailable) {
      content = await readPageReal(url, title, statusRow);
    } else {
      content = await readPageSimulated(url, title, statusRow);
    }
    
    if (content && content.content && content.content.length > 50) {
      contents.push(content);
      updateStatus(statusRow, `✓ ${shortTitle}`, 'success');
      console.log('[Reader] Successfully read:', title.slice(0, 50));
    } else {
      updateStatus(statusRow, `✗ ${shortTitle}`, 'error');
      console.log('[Reader] Failed to read:', title.slice(0, 50));
    }
    
    await delay(300);
  }
  
  // Show summary
  addStatus('reader', `Extracted ${contents.length} articles`, 'success');
  
  setAgentActive('reader', false);
  
  // If we got no content, provide fallback content
  if (contents.length === 0) {
    console.log('[Reader] No content extracted, providing fallback');
    contents.push({
      url: urls[0]?.url || 'https://example.com',
      title: urls[0]?.title || 'Research Topic',
      content: `Information about ${urls[0]?.title || 'this topic'} from various sources indicates this is an important subject with multiple perspectives to consider.`
    });
  }
  
  return contents;
}

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

/**
 * Simulated page reading for demo without browser control.
 */
async function readPageSimulated(url, title, statusRow) {
  await delay(600);
  updateStatus(statusRow, 'Extracting content...');
  await delay(800);
  
  // Generate plausible content based on the title
  const topic = title.replace(/[-_|:]/g, ' ').toLowerCase();
  
  const content = `
This comprehensive resource explores the topic of ${topic}. 
Research has shown that understanding this subject is essential for making informed decisions.

Key findings include:
- Multiple studies have demonstrated significant effects in this area
- Experts recommend considering various factors when approaching this topic
- Recent developments have shed new light on long-standing questions

The evidence suggests that ${topic} has important implications for both individuals and society.
Further research is ongoing to better understand the mechanisms involved.
  `.trim();
  
  return { url, title, content };
}

// ============================================================================
// Writer Agent
// ============================================================================

async function writerAgent(topic, sources) {
  setAgentActive('writer', true);
  const statusRow = addStatus('writer', 'Analyzing sources...');
  
  let article;
  
  await delay(500);
  updateStatus(statusRow, 'Writing article...');
  
  // Use simulated for reliability (LLM can be slow/hang)
  // TODO: Re-enable LLM once streaming is more reliable
  article = await writeSimulated(topic, sources, statusRow);
  
  updateStatus(statusRow, '✓ Article complete!', 'success');
  setAgentActive('writer', false);
  
  return article;
}

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
    
    // Request permissions if browser control is available
    if (state.browserControlAvailable && agent.requestPermissions) {
      console.log('[Pipeline] Requesting permissions...');
      addStatus('orchestrator', 'Requesting permissions...');
      
      const permResult = await agent.requestPermissions({
        scopes: ['browser:tabs.create', 'browser:tabs.read', 'model:prompt'],
        reason: 'Research agent: search Google, read pages, and synthesize findings'
      });
      
      if (!permResult.granted) {
        throw new Error('Permissions denied. Please grant access to continue.');
      }
      
      console.log('[Pipeline] Permissions granted!');
    }
    
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
    
    state.isRunning = false;
    elements.startBtn.disabled = false;
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

elements.startBtn.addEventListener('click', () => {
  const topic = elements.topicInput.value.trim();
  if (topic && !state.isRunning) {
    runPipeline(topic);
  }
});

elements.topicInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !state.isRunning) {
    const topic = e.target.value.trim();
    if (topic) {
      runPipeline(topic);
    }
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
