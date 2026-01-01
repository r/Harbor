/**
 * VS Code MCP Server Button Detector
 * 
 * This content script detects VS Code "Install" buttons for MCP servers
 * on web pages and adds a Harbor install button next to them.
 * 
 * VS Code uses URL schemes like:
 * vscode:extension/publisher.extension
 * cursor://extension/...
 * 
 * For MCP servers, the VS Code MCP extension uses:
 * vscode:mcp/install?name=...&command=...&args=...&env=...
 */

import browser from 'webextension-polyfill';

const HARBOR_BUTTON_CLASS = 'harbor-install-btn';
const SCAN_INTERVAL_MS = 2000;

interface McpInstallParams {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // Also support npm/pypi package references
  npmPackage?: string;
  pypiPackage?: string;
}

/**
 * Parse a VS Code MCP install URL.
 */
function parseMcpInstallUrl(href: string): McpInstallParams | null {
  // Match URLs like: vscode:mcp/install?... or cursor://mcp/install?...
  if (!href.match(/^(vscode|cursor):\/?\/?mcp\/install\?/i)) {
    return null;
  }

  try {
    // Parse as URL (need to normalize the scheme)
    const normalized = href.replace(/^(vscode|cursor):\/?\/?/, 'http://localhost/');
    const url = new URL(normalized);
    
    const params = url.searchParams;
    const name = params.get('name');
    
    if (!name) {
      return null;
    }

    const result: McpInstallParams = { name };
    
    if (params.get('command')) {
      result.command = params.get('command')!;
    }
    
    if (params.get('args')) {
      try {
        result.args = JSON.parse(params.get('args')!);
      } catch {
        result.args = params.get('args')!.split(',');
      }
    }
    
    if (params.get('env')) {
      try {
        result.env = JSON.parse(params.get('env')!);
      } catch {
        // Ignore invalid env
      }
    }
    
    if (params.get('npm')) {
      result.npmPackage = params.get('npm')!;
    }
    
    if (params.get('pypi')) {
      result.pypiPackage = params.get('pypi')!;
    }
    
    return result;
  } catch (e) {
    console.error('[Harbor] Failed to parse MCP install URL:', e);
    return null;
  }
}

/**
 * Create a Harbor install button.
 */
function createHarborButton(params: McpInstallParams): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = HARBOR_BUTTON_CLASS;
  btn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="margin-right: 4px;">
      <path d="M12 2L2 7l10 5 10-5-10-5z"/>
      <path d="M2 17l10 5 10-5"/>
      <path d="M2 12l10 5 10-5"/>
    </svg>
    Install in Harbor
  `;
  
  // Style the button
  Object.assign(btn.style, {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '6px 12px',
    marginLeft: '8px',
    border: '1px solid #0066cc',
    borderRadius: '4px',
    background: 'linear-gradient(to bottom, #0077ee, #0055cc)',
    color: '#fff',
    fontSize: '13px',
    fontWeight: '500',
    cursor: 'pointer',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    transition: 'all 0.15s ease',
    boxShadow: '0 1px 2px rgba(0,0,0,0.1)',
  });
  
  btn.addEventListener('mouseenter', () => {
    btn.style.background = 'linear-gradient(to bottom, #0088ff, #0066dd)';
    btn.style.boxShadow = '0 2px 4px rgba(0,0,0,0.15)';
  });
  
  btn.addEventListener('mouseleave', () => {
    btn.style.background = 'linear-gradient(to bottom, #0077ee, #0055cc)';
    btn.style.boxShadow = '0 1px 2px rgba(0,0,0,0.1)';
  });
  
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    btn.disabled = true;
    btn.textContent = 'Installing...';
    
    try {
      // Send to background script to install
      const response = await browser.runtime.sendMessage({
        type: 'install_from_vscode_button',
        params,
        pageUrl: window.location.href,
      });
      
      if (response?.success) {
        btn.style.background = '#16a34a';
        btn.style.borderColor = '#16a34a';
        btn.textContent = '✓ Installed!';
        
        // Reset after a moment
        setTimeout(() => {
          btn.style.background = 'linear-gradient(to bottom, #0077ee, #0055cc)';
          btn.style.borderColor = '#0066cc';
          btn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="margin-right: 4px;">
              <path d="M12 2L2 7l10 5 10-5-10-5z"/>
              <path d="M2 17l10 5 10-5"/>
              <path d="M2 12l10 5 10-5"/>
            </svg>
            Install in Harbor
          `;
          btn.disabled = false;
        }, 3000);
      } else {
        throw new Error(response?.error?.message || 'Installation failed');
      }
    } catch (err) {
      console.error('[Harbor] Install failed:', err);
      btn.style.background = '#dc2626';
      btn.style.borderColor = '#dc2626';
      btn.textContent = '✕ Failed';
      
      setTimeout(() => {
        btn.style.background = 'linear-gradient(to bottom, #0077ee, #0055cc)';
        btn.style.borderColor = '#0066cc';
        btn.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="margin-right: 4px;">
            <path d="M12 2L2 7l10 5 10-5-10-5z"/>
            <path d="M2 17l10 5 10-5"/>
            <path d="M2 12l10 5 10-5"/>
          </svg>
          Install in Harbor
        `;
        btn.disabled = false;
      }, 3000);
    }
  });
  
  return btn;
}

/**
 * Scan for VS Code install links on the page.
 */
function scanForMcpLinks(): void {
  // Find all links with vscode: or cursor: protocols
  const links = document.querySelectorAll<HTMLAnchorElement>(
    'a[href^="vscode:"], a[href^="cursor:"]'
  );
  
  for (const link of links) {
    // Skip if we already added a button
    if (link.nextElementSibling?.classList.contains(HARBOR_BUTTON_CLASS)) {
      continue;
    }
    
    const params = parseMcpInstallUrl(link.href);
    if (!params) {
      continue;
    }
    
    console.log('[Harbor] Found MCP install link:', params.name);
    
    // Create and insert Harbor button
    const btn = createHarborButton(params);
    link.parentNode?.insertBefore(btn, link.nextSibling);
  }
  
  // Also look for data attributes that might contain install info
  // Some docs use custom elements or data attributes
  const dataElements = document.querySelectorAll<HTMLElement>(
    '[data-mcp-install], [data-vscode-mcp]'
  );
  
  for (const el of dataElements) {
    if (el.querySelector(`.${HARBOR_BUTTON_CLASS}`)) {
      continue;
    }
    
    try {
      const installData = el.dataset.mcpInstall || el.dataset.vscodeMcp;
      if (installData) {
        const params = JSON.parse(installData) as McpInstallParams;
        if (params.name) {
          const btn = createHarborButton(params);
          el.appendChild(btn);
        }
      }
    } catch {
      // Invalid JSON, skip
    }
  }
}

/**
 * Initialize the detector.
 */
function init(): void {
  console.log('[Harbor] VS Code MCP button detector initialized');
  
  // Initial scan
  scanForMcpLinks();
  
  // Re-scan periodically for dynamically added content
  setInterval(scanForMcpLinks, SCAN_INTERVAL_MS);
  
  // Also scan on DOM mutations
  const observer = new MutationObserver((mutations) => {
    // Debounce mutations
    let hasAddedNodes = false;
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        hasAddedNodes = true;
        break;
      }
    }
    
    if (hasAddedNodes) {
      // Delay slightly to let the DOM settle
      setTimeout(scanForMcpLinks, 100);
    }
  });
  
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

// Run when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

