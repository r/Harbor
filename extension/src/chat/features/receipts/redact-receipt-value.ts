import type { ToolCallReceipt } from '../../contracts';

export type RedactedValue =
  | null
  | boolean
  | number
  | string
  | RedactedValue[]
  | { [key: string]: RedactedValue };

export type RedactionLimits = {
  maxDepth: number;
  maxEntries: number;
  maxStringLength: number;
};

const DEFAULT_LIMITS: RedactionLimits = {
  maxDepth: 4,
  maxEntries: 40,
  maxStringLength: 500,
};

const SENSITIVE_FIELD_PATTERN =
  /(?:pass(?:word|wd)?|secret|token|api[_-]?key|authorization|auth|credential|session|signature|cookie|client[_-]?secret)/i;
const CREDENTIAL_ASSIGNMENT_PATTERN =
  /\b(?:password|passwd|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|client[ _-]?secret|authorization)\b(\s*[:=]\s*)[^\s,;]+/gi;

export function isSensitiveFieldName(fieldName: string): boolean {
  return SENSITIVE_FIELD_PATTERN.test(fieldName);
}

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return value;
    }
    return `${url.origin}/`;
  } catch {
    return value;
  }
}

function redactString(value: string, maxLength: number): string {
  const credentialRedacted = value.replace(
    CREDENTIAL_ASSIGNMENT_PATTERN,
    (_match, separator: string) => `[redacted]${separator}[redacted]`,
  );
  const sanitized = sanitizeUrl(credentialRedacted);
  if (sanitized.length <= maxLength) {
    return sanitized;
  }
  return `${sanitized.slice(0, maxLength)}…`;
}

export function redactTransientValue(
  value: unknown,
  limits: Partial<RedactionLimits> = {},
): RedactedValue {
  const resolvedLimits = { ...DEFAULT_LIMITS, ...limits };
  const seen = new WeakSet<object>();
  let visitedEntries = 0;

  function visit(currentValue: unknown, depth: number): RedactedValue {
    if (currentValue === null || typeof currentValue === 'boolean') {
      return currentValue;
    }
    if (typeof currentValue === 'number') {
      return Number.isFinite(currentValue) ? currentValue : String(currentValue);
    }
    if (typeof currentValue === 'string') {
      return redactString(currentValue, resolvedLimits.maxStringLength);
    }
    if (typeof currentValue === 'bigint') {
      return currentValue.toString();
    }
    if (typeof currentValue !== 'object') {
      return `[${typeof currentValue}]`;
    }
    if (seen.has(currentValue)) {
      return '[circular]';
    }
    if (depth >= resolvedLimits.maxDepth) {
      return '[depth-limited]';
    }

    seen.add(currentValue);

    if (Array.isArray(currentValue)) {
      const redactedItems: RedactedValue[] = [];
      for (const item of currentValue) {
        if (visitedEntries >= resolvedLimits.maxEntries) {
          redactedItems.push('[entry-limited]');
          break;
        }
        visitedEntries += 1;
        redactedItems.push(visit(item, depth + 1));
      }
      return redactedItems;
    }

    const redactedObject: Record<string, RedactedValue> = {};
    for (const [key, nestedValue] of Object.entries(currentValue)) {
      if (visitedEntries >= resolvedLimits.maxEntries) {
        redactedObject['[entry-limited]'] = '[entry-limited]';
        break;
      }
      visitedEntries += 1;
      redactedObject[key] = isSensitiveFieldName(key)
        ? '[redacted]'
        : visit(nestedValue, depth + 1);
    }
    return redactedObject;
  }

  return visit(value, 0);
}

export function summarizeArguments(
  value: unknown,
): ToolCallReceipt['argumentSummary'] {
  const seen = new WeakSet<object>();
  let fieldCount = 0;
  let sensitiveFieldCount = 0;
  let visitedEntries = 0;

  function visit(currentValue: unknown, depth: number): void {
    if (
      !currentValue
      || typeof currentValue !== 'object'
      || seen.has(currentValue)
      || depth >= DEFAULT_LIMITS.maxDepth
      || visitedEntries >= DEFAULT_LIMITS.maxEntries
    ) {
      return;
    }

    seen.add(currentValue);
    for (const [key, nestedValue] of Object.entries(currentValue)) {
      if (visitedEntries >= DEFAULT_LIMITS.maxEntries) {
        return;
      }
      visitedEntries += 1;
      fieldCount += 1;
      if (isSensitiveFieldName(key)) {
        sensitiveFieldCount += 1;
      } else {
        visit(nestedValue, depth + 1);
      }
    }
  }

  visit(value, 0);
  return { fieldCount, sensitiveFieldCount };
}

export function summarizeResult(
  value: unknown,
): ToolCallReceipt['resultSummary'] {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return { kind: 'null' };
  }
  if (typeof value === 'string') {
    return { kind: 'string', size: value.length };
  }
  if (Array.isArray(value)) {
    return { kind: 'array', size: value.length };
  }
  if (typeof value === 'object') {
    return { kind: 'object', size: Object.keys(value).length };
  }
  return { kind: typeof value };
}

export function sanitizeReceiptReference(value: unknown): string {
  if (typeof value !== 'string') {
    return 'unknown';
  }
  return redactString(value, 160);
}
