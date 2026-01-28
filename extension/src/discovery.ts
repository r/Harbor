/**
 * Harbor Discovery Script
 * 
 * This minimal content script is injected into all pages to allow
 * other extensions to detect that Harbor is installed.
 * 
 * It sets a read-only window.__harbor object with version and extensionId.
 * This does NOT expose any callable API to web pages.
 */

import { browserAPI } from './browser-compat';

// Inject discovery info into the page context
function injectDiscoveryInfo(): void {
  const script = document.createElement('script');
  script.textContent = `
    (function() {
      // Only set if not already defined
      if (typeof window.__harbor !== 'undefined') return;
      
      Object.defineProperty(window, '__harbor', {
        value: Object.freeze({
          version: '0.1.0',
          extensionId: '${browserAPI.runtime.id}',
          installed: true
        }),
        writable: false,
        configurable: false,
        enumerable: true
      });
      
      // Dispatch event for extensions waiting for Harbor
      window.dispatchEvent(new CustomEvent('harbor-discovered', {
        detail: { version: '0.1.0', extensionId: '${browserAPI.runtime.id}' }
      }));
    })();
  `;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

// Run immediately at document_start
injectDiscoveryInfo();
