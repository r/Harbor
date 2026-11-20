// Page chat replies render markdown with marked, sanitized by DOMPurify.
// These tests cover the marked side (Harbor's configuration of it); the
// sanitizing runs on a real DOM, which this suite doesn't have.
import { describe, expect, it } from 'vitest';
import { markdownToHtml } from '../chat-markdown';

describe('markdownToHtml', () => {
  it('renders the formatting agents use', () => {
    const html = markdownToHtml('For **Tom, the Keyboard ($129.99)**.\n\n- one\n- two');
    expect(html).toContain('<strong>Tom, the Keyboard ($129.99)</strong>');
    expect(html).toContain('<ul>\n<li>one</li>\n<li>two</li>\n</ul>');
  });

  it('keeps single line breaks', () => {
    expect(markdownToHtml('a\nb')).toContain('a<br>b');
  });

  it('shows raw HTML in a reply as text', () => {
    const html = markdownToHtml('<img src=x onerror=alert(1)>\n\nhi <b>x</b>');
    expect(html).not.toMatch(/<img|<b>/);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});
