/**
 * Demo Bootstrap Script
 * 
 * This script makes window.ai and window.agent available in extension pages
 * by using the internal API. This allows the same demo code to work both:
 * 
 * 1. As an extension page (using this bootstrap)
 * 2. As a regular website (using content script injection)
 */

import { ai, agent } from './provider/internal-api';

// Make APIs available globally
(window as unknown as { ai: typeof ai; agent: typeof agent }).ai = ai;
(window as unknown as { ai: typeof ai; agent: typeof agent }).agent = agent;

// Dispatch event to signal APIs are ready
window.dispatchEvent(new CustomEvent('harbor-provider-ready'));

console.log('[Harbor Demo] APIs ready:', {
  'window.ai': typeof (window as unknown as { ai: unknown }).ai !== 'undefined',
  'window.agent': typeof (window as unknown as { agent: unknown }).agent !== 'undefined',
});

