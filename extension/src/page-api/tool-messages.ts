/**
 * Render an MCP tool result as text for a `tool` message. MCP results look like
 * `{ content: [{ type: 'text', text: '…' }] }`; send the text itself rather than
 * the JSON wrapper. Anything else (including `{ error }`) is sent as JSON.
 */
export function toolResultText(result: unknown): string {
  const content = (result as { content?: unknown } | null)?.content;
  if (Array.isArray(content)) {
    const text = content
      .filter((c): c is { type: 'text'; text: string } =>
        c?.type === 'text' && typeof c.text === 'string')
      .map(c => c.text)
      .join('\n');
    if (text) return text;
  }
  if (typeof result === 'string') return result;
  // JSON.stringify(undefined) is undefined, and the bridge needs a string.
  return JSON.stringify(result) ?? String(result);
}
