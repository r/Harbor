/**
 * OAuth Callback Server
 * 
 * A lightweight HTTP server that handles OAuth callbacks.
 * Runs on localhost to receive authorization codes from OAuth providers.
 */

import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { log } from '../native-messaging.js';
import { OAuthFlowState } from './types.js';

const OAUTH_PORT = 8765;
const CALLBACK_PATH = '/oauth/callback';
const FLOW_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface PendingFlow {
  flow: OAuthFlowState;
  resolve: (code: string) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

/**
 * OAuth callback server singleton.
 */
export class OAuthCallbackServer {
  private server: Server | null = null;
  private pendingFlows: Map<string, PendingFlow> = new Map();
  private isStarting = false;

  /**
   * Get the callback URL for OAuth redirects.
   */
  getCallbackUrl(): string {
    return `http://127.0.0.1:${OAUTH_PORT}${CALLBACK_PATH}`;
  }

  /**
   * Start the callback server if not already running.
   */
  async start(): Promise<void> {
    if (this.server) {
      return; // Already running
    }

    if (this.isStarting) {
      // Wait for startup to complete
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (this.server) {
            clearInterval(check);
            resolve();
          }
        }, 100);
      });
      return;
    }

    this.isStarting = true;

    try {
      this.server = createServer((req, res) => this.handleRequest(req, res));

      await new Promise<void>((resolve, reject) => {
        this.server!.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            log(`[OAuth] Port ${OAUTH_PORT} already in use, assuming server is running`);
            resolve();
          } else {
            reject(err);
          }
        });

        this.server!.listen(OAUTH_PORT, '127.0.0.1', () => {
          log(`[OAuth] Callback server listening on http://127.0.0.1:${OAUTH_PORT}`);
          resolve();
        });
      });
    } finally {
      this.isStarting = false;
    }
  }

  /**
   * Stop the callback server.
   */
  async stop(): Promise<void> {
    if (!this.server) return;

    // Cancel all pending flows
    for (const [state, pending] of this.pendingFlows) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('OAuth server stopped'));
      this.pendingFlows.delete(state);
    }

    await new Promise<void>((resolve) => {
      this.server!.close(() => {
        log('[OAuth] Callback server stopped');
        resolve();
      });
    });

    this.server = null;
  }

  /**
   * Register a pending OAuth flow.
   * Returns a promise that resolves with the authorization code.
   */
  registerFlow(flow: OAuthFlowState): Promise<string> {
    return new Promise((resolve, reject) => {
      // Timeout after FLOW_TIMEOUT_MS
      const timeout = setTimeout(() => {
        this.pendingFlows.delete(flow.state);
        reject(new Error('OAuth flow timed out. Please try again.'));
      }, FLOW_TIMEOUT_MS);

      this.pendingFlows.set(flow.state, {
        flow,
        resolve,
        reject,
        timeout,
      });

      log(`[OAuth] Registered flow for ${flow.providerId} (state: ${flow.state.substring(0, 8)}...)`);
    });
  }

  /**
   * Cancel a pending OAuth flow.
   */
  cancelFlow(state: string): void {
    const pending = this.pendingFlows.get(state);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('OAuth flow cancelled'));
      this.pendingFlows.delete(state);
      log(`[OAuth] Cancelled flow (state: ${state.substring(0, 8)}...)`);
    }
  }

  /**
   * Handle incoming HTTP requests.
   */
  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url || '/', `http://127.0.0.1:${OAUTH_PORT}`);

    // CORS headers for potential popup windows
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    this.handleCallback(url, res);
  }

  /**
   * Handle OAuth callback.
   */
  private handleCallback(url: URL, res: ServerResponse): void {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    const errorDescription = url.searchParams.get('error_description');

    // Handle error from provider
    if (error) {
      const errorMsg = errorDescription || error;
      log(`[OAuth] Provider returned error: ${errorMsg}`);

      this.sendHtmlResponse(res, {
        title: 'Authorization Failed',
        message: errorMsg,
        success: false,
      });

      if (state) {
        const pending = this.pendingFlows.get(state);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingFlows.delete(state);
          pending.reject(new Error(`OAuth error: ${errorMsg}`));
        }
      }
      return;
    }

    // Validate required parameters
    if (!code || !state) {
      log('[OAuth] Missing code or state in callback');
      this.sendHtmlResponse(res, {
        title: 'Invalid Request',
        message: 'Missing authorization code or state parameter.',
        success: false,
      });
      return;
    }

    // Find pending flow
    const pending = this.pendingFlows.get(state);
    if (!pending) {
      log(`[OAuth] Unknown state: ${state.substring(0, 8)}...`);
      this.sendHtmlResponse(res, {
        title: 'Session Expired',
        message: 'This authorization session has expired. Please try again.',
        success: false,
      });
      return;
    }

    // Success!
    log(`[OAuth] Received authorization code for ${pending.flow.providerId}`);

    this.sendHtmlResponse(res, {
      title: 'Authorization Successful',
      message: 'You can close this window and return to Harbor.',
      success: true,
    });

    // Resolve the pending flow
    clearTimeout(pending.timeout);
    this.pendingFlows.delete(state);
    pending.resolve(code);
  }

  /**
   * Send a styled HTML response.
   */
  private sendHtmlResponse(
    res: ServerResponse,
    options: { title: string; message: string; success: boolean }
  ): void {
    const { title, message, success } = options;
    const color = success ? '#16a34a' : '#dc2626';
    const icon = success ? '✅' : '❌';

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title} - Harbor</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #fff;
    }
    .container {
      text-align: center;
      padding: 40px;
      background: rgba(255, 255, 255, 0.05);
      border-radius: 16px;
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      max-width: 400px;
    }
    .icon {
      font-size: 48px;
      margin-bottom: 20px;
    }
    h1 {
      font-size: 24px;
      margin-bottom: 12px;
      color: ${color};
    }
    p {
      font-size: 16px;
      color: rgba(255, 255, 255, 0.7);
      line-height: 1.5;
    }
    .close-hint {
      margin-top: 20px;
      font-size: 14px;
      color: rgba(255, 255, 255, 0.4);
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${message}</p>
    <p class="close-hint">This window will close automatically.</p>
  </div>
  <script>
    // Try to close the window after a delay
    setTimeout(() => {
      try { window.close(); } catch (e) {}
    }, 2000);
  </script>
</body>
</html>
    `);
  }
}

// Singleton instance
let _server: OAuthCallbackServer | null = null;

export function getOAuthServer(): OAuthCallbackServer {
  if (!_server) {
    _server = new OAuthCallbackServer();
  }
  return _server;
}

