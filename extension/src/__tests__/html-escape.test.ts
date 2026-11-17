import { describe, expect, it } from 'vitest';
import { escapeHtml } from '../html-escape';

describe('escapeHtml', () => {
  it('escapes markup and both quote styles', () => {
    expect(escapeHtml(`<img src=x onerror="a('b')">&`)).toBe(
      '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;',
    );
  });

  it('leaves plain text alone', () => {
    expect(escapeHtml('time.now')).toBe('time.now');
  });
});
