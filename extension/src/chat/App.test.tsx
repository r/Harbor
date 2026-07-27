// @vitest-environment jsdom

import {
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type {
  ChatIntent,
  ChatRunRequest,
  ExecutionReceipt,
} from './contracts';
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

  it('completes a consented page and tool run with a receipt', async () => {
    const approvedIntents: ChatIntent[] = [];
    const runRequests: ChatRunRequest[] = [];
    const receipt: ExecutionReceipt = {
      version: 1,
      id: 'receipt-1',
      runId: 'run-1',
      status: 'completed',
      mode: 'agent',
      provider: 'Ollama',
      model: 'llama',
      locality: 'local',
      source: {
        title: 'Article',
        origin: 'https://example.com',
      },
      scopes: [
        'model:prompt',
        'model:tools',
        'mcp:tools.list',
        'mcp:tools.call',
        'browser:activeTab.read',
      ],
      toolCalls: [{
        callId: 'tool-1',
        tool: 'summarize',
        status: 'completed',
        startedOffsetMs: 10,
        durationMs: 15,
        argumentSummary: {
          fieldCount: 1,
          sensitiveFieldCount: 0,
        },
      }],
      startedAt: '2026-07-26T12:00:00.000Z',
      completedAt: '2026-07-26T12:00:00.025Z',
      durationMs: 25,
      citations: [],
    };
    const journeyServices: ChatApplicationServices = {
      ...services,
      consent: {
        async previewSource() {
          return {
            title: 'Article',
            origin: 'https://example.com',
          };
        },
        async approveIntent(intent) {
          approvedIntents.push(intent);
          return {
            kind: 'approved',
            approval: {
              intent,
              scopes: receipt.scopes,
              context: {
                title: 'Article',
                url: 'https://example.com/article',
                text: 'Page contents',
                capturedAt: 1_000,
              },
            },
          };
        },
      },
      run: {
        async *run(request) {
          runRequests.push(request);
          yield {
            type: 'started',
            runId: 'run-1',
            mode: 'agent',
            at: receipt.startedAt,
          };
          yield {
            type: 'completed',
            output: 'A concise summary.',
            receipt,
          };
        },
      },
      listToolNames: vi.fn().mockResolvedValue(['summarize']),
    };

    render(<App services={journeyServices} />);

    const contextButton = await screen.findByRole('button', {
      name: /Read this page: Article/,
    });
    fireEvent.click(contextButton);
    fireEvent.click(screen.getByRole('button', {
      name: /Connected tools/,
    }));
    await waitFor(() => {
      expect(screen.getByRole('button', {
        name: /Connected tools. Included/,
      })).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText('Message Harbor'), {
      target: { value: 'Summarize this page' },
    });
    fireEvent.click(screen.getByRole('button', {
      name: /Send message/,
    }));

    expect(await screen.findByText('A concise summary.')).toBeTruthy();
    expect(await screen.findByText('How this worked')).toBeTruthy();
    expect(approvedIntents).toEqual([{
      context: {
        mode: 'source',
        preview: {
          title: 'Article',
          origin: 'https://example.com',
        },
      },
      tools: {
        mode: 'approved',
        toolNames: ['summarize'],
      },
    }]);
    expect(runRequests).toHaveLength(1);
    expect(runRequests[0]?.prompt).toBe('Summarize this page');
  });
});
