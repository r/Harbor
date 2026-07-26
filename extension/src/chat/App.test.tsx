// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';
import type { ChatApplicationServices } from './integration/chat-application-services';

const services: ChatApplicationServices = {
  readiness: {
    async check() {
      return {
        api: 'available',
        bridge: 'ready',
        model: {
          state: 'ready',
          provider: 'Ollama',
          model: 'llama',
          locality: 'local',
        },
        tools: {
          state: 'empty',
          count: 0,
        },
        blockers: [],
      };
    },
  },
  consent: {
    async previewSource() {
      return null;
    },
    async approveIntent() {
      throw new Error('Not used in this test');
    },
  },
  run: {
    async *run() {
      return;
    },
  },
  async listToolNames() {
    return [];
  },
  async openConnections() {
    return;
  },
  reload() {},
};

describe('Harbor React chat shell', () => {
  it('renders the isolated application mount', async () => {
    render(<App services={services} />);

    expect(screen.getByRole('heading', { name: 'Harbor' })).toBeTruthy();
    expect(screen.getByTestId('harbor-chat-app')).toBeTruthy();
    expect(
      await screen.findByRole('heading', { name: 'Ready for departure' }),
    ).toBeTruthy();
  });
});
