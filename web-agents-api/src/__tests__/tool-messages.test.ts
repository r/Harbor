import { describe, it, expect } from 'vitest';
import { toolResultText } from '../tool-messages';

// The agent loop sends each tool result back to the model as a `tool` message.
// The bridge requires its content to be a string.
describe('toolResultText', () => {
  it('sends the text of an MCP result, not the JSON wrapper', () => {
    expect(toolResultText({ content: [{ type: 'text', text: '12:00' }] })).toBe('12:00');
  });

  it('joins multiple text parts and skips non-text parts', () => {
    const result = {
      content: [
        { type: 'text', text: 'a' },
        { type: 'image', data: '…' },
        { type: 'text', text: 'b' },
      ],
    };
    expect(toolResultText(result)).toBe('a\nb');
  });

  it('sends errors and other shapes as JSON', () => {
    expect(toolResultText({ error: 'Tool call failed' })).toBe('{"error":"Tool call failed"}');
    expect(toolResultText({ content: [] })).toBe('{"content":[]}');
  });

  it('passes strings through', () => {
    expect(toolResultText('plain')).toBe('plain');
  });

  it('always returns a string, even for a missing result', () => {
    expect(typeof toolResultText(undefined)).toBe('string');
    expect(typeof toolResultText(null)).toBe('string');
  });
});
