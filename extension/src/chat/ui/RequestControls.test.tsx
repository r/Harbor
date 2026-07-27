// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RequestControls } from './RequestControls';

describe('RequestControls', () => {
  it('exposes page and tool authority as explicit toggles', () => {
    const toggleContext = vi.fn();
    const toggleTools = vi.fn();
    render(
      <RequestControls
        context={{
          kind: 'available',
          preview: {
            title: 'Harbor brand guide',
            origin: 'https://example.com',
          },
          state: 'off',
          onToggle: toggleContext,
        }}
        tools={{
          state: 'approved',
          count: 3,
          onToggle: toggleTools,
        }}
      />,
    );

    const contextButton = screen.getByRole('button', {
      name: 'Read this page: Harbor brand guide. Off',
    });
    const toolsButton = screen.getByRole('button', {
      name: 'Connected tools. Included',
    });
    fireEvent.click(contextButton);
    fireEvent.click(toolsButton);

    expect(contextButton.getAttribute('aria-pressed')).toBe('false');
    expect(toolsButton.getAttribute('aria-pressed')).toBe('true');
    expect(toggleContext).toHaveBeenCalledOnce();
    expect(toggleTools).toHaveBeenCalledOnce();
  });

  it('explains when no exact source page is attached', () => {
    render(
      <RequestControls
        context={{ kind: 'unavailable' }}
        tools={{ state: 'off', onToggle: vi.fn() }}
      />,
    );

    expect(
      screen.getByText('Open chat from a page to add it'),
    ).toBeTruthy();
  });
});
