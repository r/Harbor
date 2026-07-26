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
});
