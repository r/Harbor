/**
 * Session Handlers
 * 
 * Handlers for session management (sidebar UI).
 */

import { registerHandler } from './types';
import { SessionRegistry } from '../sessions';

export function registerSessionHandlers(): void {
  // List sessions
  registerHandler('session.list', (message, _sender, sendResponse) => {
    const { origin, status, type, activeOnly } = message as {
      origin?: string;
      status?: 'active' | 'suspended' | 'terminated';
      type?: 'implicit' | 'explicit';
      activeOnly?: boolean;
    };
    try {
      const sessions = SessionRegistry.listSessions({ origin, status, type, activeOnly });
      sendResponse({ ok: true, sessions });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  });

  // Terminate session
  registerHandler('session.terminate', (message, _sender, sendResponse) => {
    const { sessionId, origin } = message as { sessionId?: string; origin?: string };
    if (!sessionId || !origin) {
      sendResponse({ ok: false, error: 'Missing sessionId or origin' });
      return true;
    }
    try {
      const terminated = SessionRegistry.terminateSession(sessionId, origin);
      sendResponse({ ok: true, terminated });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  });

  // Get session
  registerHandler('session.get', (message, _sender, sendResponse) => {
    const { sessionId } = message as { sessionId?: string };
    if (!sessionId) {
      sendResponse({ ok: false, error: 'Missing sessionId' });
      return true;
    }
    try {
      const session = SessionRegistry.getSession(sessionId);
      if (!session) {
        sendResponse({ ok: false, error: 'Session not found' });
      } else {
        sendResponse({ ok: true, session });
      }
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  });
}
