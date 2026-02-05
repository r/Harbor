/**
 * Web fetch handler for proxying HTTP requests.
 */

import type { RequestContext, ResponseSender } from './router-types';
import { requirePermission } from './helpers';

// Allowed domains for web fetch (user configurable in the future)
const FETCH_ALLOWED_DOMAINS: string[] = [];

/**
 * Handle agent.fetch - Proxy HTTP requests through the extension.
 */
export async function handleAgentFetch(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  if (!(await requirePermission(ctx, sender, 'web:fetch'))) {
    return;
  }

  const payload = ctx.payload as {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  };

  try {
    const url = new URL(payload.url);
    
    // Check domain allowlist (for now, allow all - user will configure)
    // In production, this should check against user's configured allowlist
    if (FETCH_ALLOWED_DOMAINS.length > 0 && !FETCH_ALLOWED_DOMAINS.includes(url.hostname)) {
      sender.sendResponse({
        id: ctx.id,
        ok: false,
        error: {
          code: 'ERR_PERMISSION_DENIED',
          message: `Domain ${url.hostname} is not in the allowed list`,
        },
      });
      return;
    }

    const response = await fetch(payload.url, {
      method: payload.method || 'GET',
      headers: payload.headers,
      body: payload.body,
    });

    const text = await response.text();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    sender.sendResponse({
      id: ctx.id,
      ok: true,
      result: {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers,
        text,
      },
    });
  } catch (error) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: 'ERR_INTERNAL',
        message: error instanceof Error ? error.message : 'Fetch failed',
      },
    });
  }
}
