import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractReadablePage } from '../readable-page';

// Every "read this page" path in Harbor runs one extractor in the tab. It is
// serialized into the tab, so it has to work with no outside references.

type FakeEl = { innerText?: string; textContent?: string };

function page(opts: { selectors?: Record<string, FakeEl>; body?: FakeEl | null; origin?: string; title?: string }) {
  const origin = opts.origin ?? 'https://news.example';
  vi.stubGlobal('window', { location: { origin, href: `${origin}/story` } });
  vi.stubGlobal('document', {
    title: opts.title ?? 'A story',
    body: opts.body === undefined ? { innerText: 'body text' } : opts.body,
    querySelector: (sel: string) => opts.selectors?.[sel] ?? null,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('extractReadablePage', () => {
  it('returns exactly url, title and text', () => {
    page({});
    expect(extractReadablePage()).toEqual({ url: 'https://news.example/story', title: 'A story', text: 'body text' });
  });

  it('prefers the main content area over the body', () => {
    page({ selectors: { article: { innerText: 'article text' }, '.content': { innerText: 'later' } } });
    expect(extractReadablePage()).toMatchObject({ text: 'article text' });
  });

  it('keeps line breaks, collapses spaces within lines and drops blank lines', () => {
    page({ selectors: { main: { innerText: '  Heading \n\n\n  first   para\t here \n second ' } } });
    expect(extractReadablePage()).toMatchObject({ text: 'Heading\nfirst para here\nsecond' });
  });

  it('falls back to textContent when innerText is unavailable or empty', () => {
    page({ selectors: { main: { innerText: '', textContent: 'from textContent' } } });
    expect(extractReadablePage()).toMatchObject({ text: 'from textContent' });
  });

  it('returns empty text for a document with no body', () => {
    page({ body: null });
    expect(extractReadablePage()).toMatchObject({ text: '' });
  });

  it('limits text to 50,000 characters', () => {
    page({ body: { innerText: 'x'.repeat(60_000) } });
    expect((extractReadablePage() as { text: string }).text).toHaveLength(50_000);
  });

  it('refuses to read when the page is not on the expected origin', () => {
    page({ origin: 'https://bank.example', body: { innerText: 'secret' } });
    const result = extractReadablePage('https://news.example');
    expect(result).toEqual({ originMismatch: true });
  });

  it('reads when the page is on the expected origin', () => {
    page({});
    expect(extractReadablePage('https://news.example')).toMatchObject({ text: 'body text' });
  });

  it('still works after being serialized, as executeScript does', () => {
    page({ selectors: { main: { innerText: 'serialized' } } });
    const revived = new Function(`return (${extractReadablePage.toString()})`)() as typeof extractReadablePage;
    expect(revived()).toEqual({ url: 'https://news.example/story', title: 'A story', text: 'serialized' });
  });
});
