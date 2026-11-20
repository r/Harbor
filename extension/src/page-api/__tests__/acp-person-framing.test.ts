// The first prompt of every agent session tells the agent, from Harbor and
// separately from the site's own instructions, that it works for the person
// and should use what it knows or remembers about them.
import { describe, expect, it } from 'vitest';
import { buildPromptBlocks } from '../acp-connection';

const ORIGIN = 'https://shop.example';

function texts(blocks: ReturnType<typeof buildPromptBlocks>): string[] {
  return blocks.map((b) => (b as { text: string }).text);
}

describe('the person framing on an agent session\'s first prompt', () => {
  it('comes first, before the site\'s instructions and the input', () => {
    const t = texts(buildPromptBlocks(ORIGIN, 'what should I buy?', 'Be a shop assistant.', true));
    expect(t).toHaveLength(3);
    expect(t[0]).toMatch(/working for the person/i);
    expect(t[0]).toMatch(/remember/i);
    expect(t[0]).toContain(ORIGIN);
    expect(t[1]).toBe(`Instructions from ${ORIGIN}:\nBe a shop assistant.`);
    expect(t[2]).toBe('what should I buy?');
  });

  it('says the site\'s instructions are the site\'s request, not the person\'s', () => {
    const [framing] = texts(buildPromptBlocks(ORIGIN, 'hi', 'x', true));
    expect(framing).toMatch(/site's request/i);
  });

  it('is sent even when the site gives no instructions', () => {
    const t = texts(buildPromptBlocks(ORIGIN, 'hi', undefined, true));
    expect(t).toHaveLength(2);
    expect(t[0]).toMatch(/working for the person/i);
    expect(t[1]).toBe('hi');
  });

  it('is not repeated on later prompts', () => {
    expect(texts(buildPromptBlocks(ORIGIN, 'second', undefined, false))).toEqual(['second']);
  });

  it('names no protocol', () => {
    const [framing] = texts(buildPromptBlocks(ORIGIN, 'hi', undefined, true));
    expect(framing).not.toMatch(/\bACP\b|protocol/i);
  });
});
