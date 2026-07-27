// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConversationPanel } from './ConversationPanel';

describe('ConversationPanel', () => {
  it('keeps starter actions in the primary workspace', () => {
    const onStarterAction = vi.fn();
    render(
      <ConversationPanel
        messages={[]}
        onStarterAction={onStarterAction}
        starterActions={['Summarize the key points']}
        toolActivity={[]}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Summarize the key points' }),
    );

    expect(onStarterAction).toHaveBeenCalledWith('Summarize the key points');
  });

  it('renders conversation and tool state without raw payload details', () => {
    render(
      <ConversationPanel
        messages={[{
          id: 'message-1',
          role: 'assistant',
          content: 'The channel is clear.',
          createdAt: '2026-07-26T12:00:00.000Z',
          state: 'complete',
        }]}
        onStarterAction={vi.fn()}
        starterActions={[]}
        statusMessage="Checking the route"
        toolActivity={[{
          callId: 'call-1',
          tool: 'browser-tools/search',
          state: 'completed',
        }]}
      />,
    );

    expect(screen.getByText('The channel is clear.')).toBeTruthy();
    expect(screen.getByText('Checking the route')).toBeTruthy();
    expect(screen.getByText('browser-tools/search')).toBeTruthy();
    expect(screen.getByText('Complete')).toBeTruthy();
  });

  it('renders assistant Markdown while keeping user prompts literal', () => {
    render(
      <ConversationPanel
        messages={[
          {
            id: 'message-1',
            role: 'user',
            content: '**Keep this literal**',
            createdAt: '2026-07-26T12:00:00.000Z',
            state: 'complete',
          },
          {
            id: 'message-2',
            role: 'assistant',
            content: '## Route ready\n\n- **Model** connected\n- Tools available',
            createdAt: '2026-07-26T12:01:00.000Z',
            state: 'complete',
          },
        ]}
        onStarterAction={vi.fn()}
        starterActions={[]}
        toolActivity={[]}
      />,
    );

    expect(screen.getByText('**Keep this literal**').tagName).toBe('P');
    expect(
      screen.getByRole('heading', { level: 2, name: 'Route ready' }),
    ).toBeTruthy();
    expect(screen.getByText('Model').tagName).toBe('STRONG');
  });
});
