import { browserAPI } from '../browser-compat';
import type {
  RawPageObservation,
  SafeTabListLimits,
  SafeTabListResult,
} from './types';

export interface AgentGatewayBrowserAdapter {
  listTabs(
    boundTabId: number,
    limits: SafeTabListLimits,
  ): Promise<SafeTabListResult>;
  observePage(
    tabId: number,
    maxReadableTextBytes: number,
    maxElements: number,
  ): Promise<RawPageObservation>;
}

export interface GatewayDocumentBinding {
  url: string;
  origin: string;
  documentFingerprint: string;
}

export async function captureDocumentBinding(tabId: number): Promise<GatewayDocumentBinding> {
  const tab = await browserAPI.tabs.get(tabId);
  const tabUrl = sanitizeUrl(tab.url);
  if (!tabUrl) {
    throw new Error('Selected tab is unavailable or privileged');
  }
  const results = await browserAPI.scripting.executeScript({
    target: { tabId },
    func: () => ({
      url: window.location.href,
      origin: window.location.origin,
      documentFingerprint: `${window.location.href}\n${performance.timeOrigin}`,
    }),
  });
  const binding = results?.[0]?.result as GatewayDocumentBinding | undefined;
  if (!binding) {
    throw new Error('Selected tab document is unavailable');
  }
  return binding;
}

export class ExtensionAgentGatewayBrowserAdapter implements AgentGatewayBrowserAdapter {
  async listTabs(
    boundTabId: number,
    limits: SafeTabListLimits,
  ): Promise<SafeTabListResult> {
    const tab = await browserAPI.tabs.get(boundTabId);
    const documentBinding = await captureDocumentBinding(boundTabId);
    const safeTabs: SafeTabListResult['tabs'] = [];
    let outputBytes = 2;
    let truncated = false;

    const safeUrl = minimizePublicUrl(documentBinding.url, limits.maxUrlBytes);
    if (tab.id === boundTabId && safeUrl) {
      const safeTitle = boundUtf8(
        sanitizeReadableText(tab.title ?? ''),
        limits.maxTitleBytes,
      );
      truncated =
        safeTitle !== sanitizeReadableText(tab.title ?? '')
        || safeUrl !== sanitizeUrl(documentBinding.url);
      const metadata = {
        tabId: boundTabId,
        windowId: tab.windowId,
        title: safeTitle,
        url: safeUrl,
        active: tab.active,
        controllable: true,
      };
      const metadataBytes = utf8Length(JSON.stringify(metadata))
        + (safeTabs.length > 0 ? 1 : 0);
      if (outputBytes + metadataBytes > limits.maxResultBytes) {
        truncated = true;
      } else {
        safeTabs.push(metadata);
        outputBytes += metadataBytes;
      }
    } else {
      truncated = true;
    }

    return {
      tabs: safeTabs,
      truncated,
      target: {
        origin: documentBinding.origin,
        documentFingerprint: documentBinding.documentFingerprint,
      },
    };
  }

  async observePage(
    tabId: number,
    maxReadableTextBytes: number,
    maxElements: number,
  ): Promise<RawPageObservation> {
    const tab = await browserAPI.tabs.get(tabId);
    const tabUrl = sanitizeUrl(tab.url);
    if (!tabUrl) {
      throw new Error('Bound tab is unavailable or privileged');
    }

    const results = await browserAPI.scripting.executeScript({
      target: { tabId },
      func: extractBoundedPageObservation,
      args: [maxReadableTextBytes, maxElements],
    });
    const result = results?.[0]?.result as RawPageObservation | undefined;
    if (!result) {
      throw new Error('Page observation returned no result');
    }
    return {
      ...result,
      readableText: sanitizeReadableText(result.readableText),
    };
  }
}

export function sanitizeUrl(value?: string): string {
  if (!value) {
    return '';
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
    }
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (/(?:pass(?:word)?|token|secret|api[_-]?key|auth|code|credential|state|signature|session)/i.test(key)) {
        parsed.searchParams.set(key, '[REDACTED]');
      }
    }
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

export function minimizePublicUrl(value: string, maxBytes: number): string {
  const sanitizedUrl = sanitizeUrl(value);
  if (!sanitizedUrl) {
    return '';
  }
  const originOnlyUrl = `${new URL(sanitizedUrl).origin}/`;
  return utf8Length(originOnlyUrl) <= maxBytes ? originOnlyUrl : '';
}

export function boundUtf8(value: string, maxBytes: number): string {
  if (utf8Length(value) <= maxBytes) {
    return value;
  }
  let lowerBound = 0;
  let upperBound = value.length;
  while (lowerBound < upperBound) {
    const midpoint = Math.ceil((lowerBound + upperBound) / 2);
    if (utf8Length(value.slice(0, midpoint)) <= maxBytes) {
      lowerBound = midpoint;
    } else {
      upperBound = midpoint - 1;
    }
  }
  return value.slice(0, lowerBound);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function sanitizeReadableText(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(
      /\b(password|passwd|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|client[ _-]?secret)\b(\s*[:=]\s*)[^\r\n]+/gi,
      '$1$2[REDACTED]',
    );
}

function extractBoundedPageObservation(
  maxReadableTextBytes: number,
  maxElements: number,
): RawPageObservation {
  const textEncoder = new TextEncoder();
  const editableSelector =
    'input, textarea, select, [contenteditable], [role="textbox"], '
    + '[role="searchbox"], [role="combobox"]';
  const excludedContentSelector =
    `${editableSelector}, script, style, noscript, template, [hidden], `
    + '[aria-hidden="true"]';
  const readableBody = document.body?.cloneNode(true) as HTMLElement | undefined;
  readableBody
    ?.querySelectorAll(excludedContentSelector)
    .forEach((element) => element.remove());
  const rawText = readableBody?.innerText ?? '';
  let readableText = rawText;
  let truncated = false;

  if (textEncoder.encode(readableText).byteLength > maxReadableTextBytes) {
    let lowerBound = 0;
    let upperBound = readableText.length;
    while (lowerBound < upperBound) {
      const midpoint = Math.ceil((lowerBound + upperBound) / 2);
      if (textEncoder.encode(readableText.slice(0, midpoint)).byteLength <= maxReadableTextBytes) {
        lowerBound = midpoint;
      } else {
        upperBound = midpoint - 1;
      }
    }
    readableText = readableText.slice(0, lowerBound);
    truncated = true;
  }

  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      'a[href], button, input:not([type="hidden"]):not([type="password"]), select, textarea, [role]',
    ),
  );
  const elements: RawPageObservation['elements'] = [];

  for (const element of candidates) {
    if (elements.length >= maxElements) {
      truncated = true;
      break;
    }
    if (
      element.hidden
      || element.getAttribute('aria-hidden') === 'true'
      || getComputedStyle(element).display === 'none'
      || getComputedStyle(element).visibility === 'hidden'
    ) {
      continue;
    }

    const tagName = element.tagName.toLowerCase();
    const isInput = tagName === 'input';
    const isEditable = isInput
      || tagName === 'textarea'
      || tagName === 'select'
      || element.hasAttribute('contenteditable')
      || ['textbox', 'searchbox', 'combobox'].includes(
        element.getAttribute('role') ?? '',
      );
    const labelledBy = element.getAttribute('aria-labelledby');
    const labelledByText = labelledBy
      ? labelledBy
          .split(/\s+/)
          .map((id) => {
            const label = document.getElementById(id);
            if (
              !label
              || label.matches(editableSelector)
              || label.closest(
                '[contenteditable], [role="textbox"], [role="searchbox"], '
                  + '[role="combobox"]',
              )
            ) {
              return '';
            }
            const labelClone = label.cloneNode(true) as HTMLElement;
            labelClone
              .querySelectorAll(excludedContentSelector)
              .forEach((excluded) => excluded.remove());
            return labelClone.innerText ?? '';
          })
          .join(' ')
      : '';
    const elementClone = element.cloneNode(true) as HTMLElement;
    elementClone
      .querySelectorAll(excludedContentSelector)
      .forEach((excluded) => excluded.remove());
    const staticElementText = elementClone.innerText ?? '';
    const name = (
      element.getAttribute('aria-label')
      || labelledByText
      || element.getAttribute('alt')
      || element.getAttribute('title')
      || (isEditable ? element.getAttribute('placeholder') : '')
      || (isEditable ? '' : staticElementText)
      || ''
    ).trim().replace(/\s+/g, ' ').slice(0, 200);
    const role = (
      element.getAttribute('role')
      || (tagName === 'a' ? 'link' : '')
      || (tagName === 'button' ? 'button' : '')
      || (tagName === 'select' ? 'combobox' : '')
      || (tagName === 'textarea' ? 'textbox' : '')
      || (isInput ? element.getAttribute('type') || 'textbox' : '')
    ).slice(0, 50);

    elements.push({
      ...(role ? { role } : {}),
      ...(name ? { name } : {}),
      ...(isInput
        && ['checkbox', 'radio'].includes(element.getAttribute('type') ?? '')
        ? { checked: Boolean((element as HTMLInputElement).checked) }
        : {}),
      disabled: ['button', 'input', 'select', 'textarea'].includes(tagName)
          ? Boolean((element as HTMLInputElement).disabled)
          : element.getAttribute('aria-disabled') === 'true',
    });
  }

  return {
    url: window.location.href,
    origin: window.location.origin,
    title: document.title,
    readableText,
    elements,
    documentFingerprint: `${window.location.href}\n${performance.timeOrigin}`,
    truncated,
  };
}

export const agentGatewayBrowserTesting = {
  extractBoundedPageObservation,
  sanitizeReadableText,
  sanitizeUrl,
  boundUtf8,
  minimizePublicUrl,
};
