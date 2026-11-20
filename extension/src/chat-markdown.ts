/**
 * Markdown for chat replies, using `marked` to render and `DOMPurify` to
 * sanitize.
 *
 * Page chat draws its panel inside the site's page, so a reply must never
 * reach the DOM unsanitized. Raw HTML in a reply is escaped by the renderer
 * (shown as text, not dropped), and DOMPurify then allows only the tags
 * below and http(s) links, which open in a new tab with `noopener`.
 */
import { Marked } from 'marked';
import DOMPurify, { type DOMPurify as Purifier, type WindowLike } from 'dompurify';

const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'hr',
  'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
];

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const marked = new Marked({ gfm: true, breaks: true, async: false });
marked.use({
  renderer: {
    // Raw HTML in a reply is shown as text, not interpreted.
    html({ text }) {
      return escapeHtml(text);
    },
  },
});

/** The reply as HTML, before sanitizing. Exported for tests. */
export function markdownToHtml(source: string): string {
  return marked.parse(source, { async: false }) as string;
}

let purifier: Purifier | undefined;
function getPurifier(win: WindowLike): Purifier {
  if (purifier) return purifier;
  purifier = DOMPurify(win);
  purifier.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
  return purifier;
}

/** The reply as sanitized DOM nodes, ready to append. */
export function renderMarkdown(source: string, win: WindowLike = window as unknown as WindowLike): DocumentFragment {
  return getPurifier(win).sanitize(markdownToHtml(source), {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ['href', 'title', 'target', 'rel'],
    ALLOWED_URI_REGEXP: /^https?:\/\//i,
    RETURN_DOM_FRAGMENT: true,
  });
}
