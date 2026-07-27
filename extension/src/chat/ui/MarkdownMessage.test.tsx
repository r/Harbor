// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarkdownMessage } from './MarkdownMessage';

describe('MarkdownMessage', () => {
  it('renders common assistant response structures', () => {
    const { container } = render(
      <MarkdownMessage
        content={[
          '### Departure notes',
          '',
          '1. **Model** connected',
          '2. `page:observe` approved',
          '',
          '| Route | State |',
          '| --- | --- |',
          '| Page | Ready |',
        ].join('\n')}
      />,
    );

    expect(
      screen.getByRole('heading', { level: 3, name: 'Departure notes' }),
    ).toBeTruthy();
    expect(screen.getByText('Model').tagName).toBe('STRONG');
    expect(screen.getByText('page:observe').tagName).toBe('CODE');
    expect(screen.getByRole('table')).toBeTruthy();
    expect(container.querySelectorAll('ol > li')).toHaveLength(2);
  });

  it('does not render raw HTML or unsafe links', () => {
    const { container } = render(
      <MarkdownMessage
        content={'<script>alert("unsafe")</script>\n\n[Run](javascript:alert(1))'}
      />,
    );

    expect(container.querySelector('script')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Run' })).toBeNull();
    expect(screen.getByText('Run').tagName).toBe('SPAN');
  });

  it('opens links without granting access to the Harbor window', () => {
    render(
      <MarkdownMessage content="[Harbor docs](https://example.com/harbor)" />,
    );

    const link = screen.getByRole('link', { name: 'Harbor docs' });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer noopener');
  });

  it('turns remote images into explicit links instead of loading them', () => {
    const { container } = render(
      <MarkdownMessage content="![Route map](https://example.com/map.png)" />,
    );

    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('link', { name: 'Image: Route map' })).toBeTruthy();
  });
});
