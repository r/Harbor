// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatComposer } from './ChatComposer';

describe('ChatComposer', () => {
  it('submits a ready message', () => {
    const onSubmit = vi.fn();
    render(
      <ChatComposer
        onChange={vi.fn()}
        onSubmit={onSubmit}
        state="ready"
        value="Chart a route"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(
      screen.getByRole('textbox', { name: 'Message Harbor' })
        .getAttribute('aria-describedby'),
    ).toBe('harbor-chat-count harbor-chat-help');
  });

  it('keeps the composer unavailable while the route is blocked', () => {
    render(
      <ChatComposer
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        state="blocked"
        value="Waiting"
      />,
    );

    expect(
      (screen.getByRole('textbox', {
        name: 'Message Harbor',
      }) as HTMLTextAreaElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', {
        name: 'Send message',
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
