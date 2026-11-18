/**
 * Shared Web Agent API utilities for demos.
 * 
 * Usage:
 *   <script src="../shared/agent.js"></script>
 *   <script>
 *     const agent = getWebAgent(); // Lazy lookup
 *     await waitForWebAgent();     // Wait for injection
 *   </script>
 */

/**
 * Get the Web Agent API (lazy lookup).
 * Uses window.agent provided by Harbor.
 * @returns {object|undefined} The agent API or undefined if not available.
 */
function getWebAgent() {
  return window.agent;
}

/**
 * Wait for the Web Agent API to be available.
 * Resolves when the API is injected, rejects after timeout.
 * @param {number} timeoutMs - Maximum time to wait (default 5000ms)
 * @returns {Promise<object>} The agent API
 */
function waitForWebAgent(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    // Check immediately
    const agent = getWebAgent();
    if (agent) {
      resolve(agent);
      return;
    }

    // Set up timeout
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('Web Agent API not detected. Make sure Harbor is installed and enabled.'));
    }, timeoutMs);

    // Listen for ready events
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
