import type { ChatReadiness } from '../../contracts';
import {
  CHECKING_CHAT_READINESS,
  createMissingApiReadiness,
} from './readiness-model';

export const readinessFixtures = {
  checking: CHECKING_CHAT_READINESS,
  missingApi: createMissingApiReadiness(),
  offline: {
    api: 'available',
    bridge: 'offline',
    model: {
      state: 'unavailable',
    },
    tools: {
      state: 'unavailable',
      count: 0,
    },
    blockers: [
      { kind: 'open-connections', label: 'Open Connections' },
      { kind: 'retry', label: 'Check Again' },
    ],
  },
  unconfigured: {
    api: 'available',
    bridge: 'ready',
    model: {
      state: 'unconfigured',
    },
    tools: {
      state: 'empty',
      count: 0,
    },
    blockers: [
      { kind: 'open-connections', label: 'Open Connections' },
    ],
  },
  ready: {
    api: 'available',
    bridge: 'ready',
    model: {
      state: 'ready',
      provider: 'Ollama',
      model: 'Local assistant',
      locality: 'local',
    },
    tools: {
      state: 'ready',
      count: 4,
    },
    blockers: [],
  },
} satisfies Record<string, ChatReadiness>;
