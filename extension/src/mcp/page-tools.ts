/**
 * Page tools: the tools a page registers with `document.modelContext` /
 * `navigator.modelContext`, as the background knows them.
 *
 * The handlers stay in the page. The page sends only descriptors
 * (`page_tools.sync`, the full list each time it changes), and a call is
 * relayed back to the page over the same port. That port lives exactly as
 * long as the page's document, so its disconnect is what drops the tools:
 * a reload or a real navigation ends them, while a same-document hash or
 * pushState/replaceState change (which `tabs.onUpdated` also reports as a
 * URL change) does not.
 *
 * Everything here crosses the page/extension trust boundary, so a sync is
 * validated as a whole and dropped if any part is wrong, the origin comes
 * from the port's sender (the caller passes it), and a result is accepted
 * only from the connection the call was sent to.
 *
 * See docs/PAGE_TOOLS_FOR_AGENTS.md.
 */

import type { LabelFlow } from '../policy/label-flow';

export const PAGE_TOOL_LIMITS = Object.freeze({
  maxTools: 64,
  maxDescriptionBytes: 4 * 1024,
  maxSchemaBytes: 64 * 1024,
  maxResultBytes: 1024 * 1024,
  maxErrorChars: 1024,
  callTimeoutMs: 60_000,
});

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

export interface PageToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The part of a runtime.Port this module uses. */
export interface PageToolPort {
  postMessage(message: Record<string, unknown>): void;
}

export interface PageConnection {
  tabId: number;
  origin: string;
  /** The background's number for this page's port connection. */
  connection: number;
  port: PageToolPort;
}

interface PendingCall {
  labelFlow?: LabelFlow;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
}

interface TabEntry {
  origin: string;
  connection: number;
  generation: number;
  port: PageToolPort;
  tools: PageToolDescriptor[];
  pending: Map<string, PendingCall>;
}

const tabs = new Map<number, TabEntry>();
let nextGeneration = 1;
let nextCallId = 1;

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateTools(payload: unknown): PageToolDescriptor[] | null {
  if (!isPlainObject(payload) || !Array.isArray(payload.tools)) return null;
  const raw = payload.tools;
  if (raw.length > PAGE_TOOL_LIMITS.maxTools) return null;
  const seen = new Set<string>();
  const tools: PageToolDescriptor[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) return null;
    const { name, description, inputSchema } = entry;
    if (typeof name !== 'string' || !TOOL_NAME_PATTERN.test(name) || seen.has(name)) return null;
    if (typeof description !== 'string' || description === '') return null;
    if (byteLength(description) > PAGE_TOOL_LIMITS.maxDescriptionBytes) return null;
    let schema: Record<string, unknown> = { type: 'object' };
    if (inputSchema !== undefined) {
      if (!isPlainObject(inputSchema)) return null;
      let serialized: string;
      try {
        serialized = JSON.stringify(inputSchema);
      } catch {
        return null;
      }
      if (byteLength(serialized) > PAGE_TOOL_LIMITS.maxSchemaBytes) return null;
      // A fresh copy: nothing the page holds a reference to.
      schema = JSON.parse(serialized) as Record<string, unknown>;
    }
    seen.add(name);
    tools.push({ name, description, inputSchema: schema });
  }
  return tools;
}

function toolFailure(message: string): Error {
  const err = new Error(message.slice(0, PAGE_TOOL_LIMITS.maxErrorChars));
  (err as Error & { code: string }).code = 'ERR_TOOL_FAILED';
  return err;
}

function failPending(entry: TabEntry, message: string): void {
  for (const call of entry.pending.values()) {
    call.cleanup();
    call.reject(toolFailure(message));
  }
  entry.pending.clear();
}

/**
 * Replace a tab's page tools with the page's current list. Returns false,
 * changing nothing, when the payload fails validation. A sync from a new
 * connection (a new document in the tab) starts a new generation and fails
 * any call still waiting on the old one.
 */
export function syncPageTools(page: PageConnection, payload: unknown): boolean {
  const tools = validateTools(payload);
  if (!tools) {
    // No page-supplied content in the log line.
    console.log('[Harbor] Dropped an invalid page tool list');
    return false;
  }
  const existing = tabs.get(page.tabId);
  if (existing && existing.connection !== page.connection) {
    failPending(existing, 'The page that offered this tool has gone away');
    tabs.delete(page.tabId);
  }
  const current = tabs.get(page.tabId);
  if (tools.length === 0) {
    if (current) {
      failPending(current, 'The page no longer offers this tool');
      tabs.delete(page.tabId);
    }
    return true;
  }
  if (current) {
    current.tools = tools;
    current.port = page.port;
  } else {
    tabs.set(page.tabId, {
      origin: page.origin,
      connection: page.connection,
      generation: nextGeneration++,
      port: page.port,
      tools,
      pending: new Map(),
    });
  }
  return true;
}

/** The tab's page tools, if the page there is still `origin`'s. */
export function listPageTools(tabId: number, origin: string): { generation: number; tools: PageToolDescriptor[] } | null {
  const entry = tabs.get(tabId);
  if (!entry || entry.origin !== origin) return null;
  return { generation: entry.generation, tools: entry.tools.map(t => ({ ...t })) };
}

/** Whether a tab currently offers any page tools for `origin`. */
export function hasPageTools(tabId: number | undefined, origin: string): boolean {
  return tabId !== undefined && listPageTools(tabId, origin) !== null;
}

/** The page's port disconnected: its document is gone. */
export function forgetPageToolsForConnection(tabId: number, connection: number): void {
  const entry = tabs.get(tabId);
  if (!entry || entry.connection !== connection) return;
  failPending(entry, 'The page that offered this tool has gone away');
  tabs.delete(tabId);
}

/** The tab closed. */
export function forgetPageToolsInTab(tabId: number): void {
  const entry = tabs.get(tabId);
  if (!entry) return;
  failPending(entry, 'The tab that offered this tool was closed');
  tabs.delete(tabId);
}

export interface PageToolCall {
  labelFlow?: LabelFlow;
  tabId: number;
  origin: string;
  /** The generation the caller listed the tools under. */
  generation: number;
  name: string;
  input: Record<string, unknown>;
  signal?: AbortSignal;
}

/**
 * Run a page tool's handler in its page. Rejects with `ERR_TOOL_FAILED` when
 * the page is gone or changed, the tool is gone, the handler throws, the
 * result is too large, or no answer comes within the timeout. Never retried.
 */
export function callPageTool(call: PageToolCall): Promise<unknown> {
  const entry = tabs.get(call.tabId);
  if (!entry || entry.origin !== call.origin || entry.generation !== call.generation) {
    return Promise.reject(toolFailure('The page that offered this tool has gone away'));
  }
  if (!entry.tools.some(t => t.name === call.name)) {
    return Promise.reject(toolFailure('The page no longer offers this tool'));
  }
  if (call.signal?.aborted) {
    return Promise.reject(toolFailure('The tool call was cancelled'));
  }
  const callId = `ptc-${nextCallId++}`;
  return new Promise((resolve, reject) => {
    const cancelInPage = () => {
      try { entry.port.postMessage({ type: 'page_tools.cancel', callId }); } catch { /* port gone */ }
    };
    const onAbort = () => {
      if (!entry.pending.delete(callId)) return;
      clearTimeout(timer);
      cancelInPage();
      reject(toolFailure('The tool call was cancelled'));
    };
    const timer = setTimeout(() => {
      if (!entry.pending.delete(callId)) return;
      call.signal?.removeEventListener('abort', onAbort);
      cancelInPage();
      reject(toolFailure('The page did not answer in time'));
    }, PAGE_TOOL_LIMITS.callTimeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      call.signal?.removeEventListener('abort', onAbort);
    };
    entry.pending.set(callId, { resolve, reject, timer, cleanup, labelFlow: call.labelFlow });
    call.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      entry.port.postMessage({ type: 'page_tools.call', callId, name: call.name, input: call.input });
    } catch {
      entry.pending.delete(callId);
      cleanup();
      reject(toolFailure('The page that offered this tool has gone away'));
    }
  });
}

/**
 * A page's answer to a call, as relayed by its content script. Accepted only
 * from the connection the call went to. Returns whether it matched a call.
 */
export function resolvePageToolResult(tabId: number, connection: number, message: unknown): boolean {
  if (!isPlainObject(message) || typeof message.callId !== 'string') return false;
  const entry = tabs.get(tabId);
  if (!entry || entry.connection !== connection) return false;
  const call = entry.pending.get(message.callId);
  if (!call) return false;
  entry.pending.delete(message.callId);
  call.cleanup();
  // Both a result and an error message can carry content from this page.
  call.labelFlow?.addPageOutput(entry.origin);
  if (message.ok === true) {
    let size: number;
    try {
      size = byteLength(JSON.stringify(message.result) ?? '');
    } catch {
      call.reject(toolFailure('The page tool returned a result that cannot be sent'));
      return true;
    }
    if (size > PAGE_TOOL_LIMITS.maxResultBytes) {
      call.reject(toolFailure('The page tool returned too large a result'));
      return true;
    }
    call.resolve(message.result);
  } else {
    const error = isPlainObject(message.error) ? message.error : {};
    const text = typeof error.message === 'string' && error.message ? error.message : 'Page tool failed';
    call.reject(toolFailure(text));
  }
  return true;
}

/** The server id a page's tools appear under: `page:<host>`, with a non-default port. */
export function pageToolServerId(origin: string): string {
  try {
    return `page:${new URL(origin).host}`;
  } catch {
    return 'page:unknown';
  }
}

export function __resetPageToolsForTests(): void {
  for (const entry of tabs.values()) {
    for (const call of entry.pending.values()) call.cleanup();
  }
  tabs.clear();
  nextGeneration = 1;
  nextCallId = 1;
}
