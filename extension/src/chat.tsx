import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { browserAPI } from './browser-compat';
import { App } from './chat/App';
import { createConsentContextCoordinator } from './chat/features/context/consent-context-coordinator';
import { createBrowserReadinessService } from './chat/features/readiness/readiness-service';
import { createChatRunService } from './chat/features/run/run-controller';
import {
  createBrowserSourceTabPort,
  createChatPermissionPort,
  createTransportAgentRunPort,
  createTransportTextGenerationPort,
  listConnectedToolNames,
} from './chat/runtime/browser-adapters';
import { createChatTransport } from './chat/runtime/chat-transport';

const rootElement = document.getElementById('harbor-chat-root');

if (!rootElement) {
  throw new Error('Missing Harbor chat root');
}

const transport = createChatTransport();
const sourceTabPort = createBrowserSourceTabPort(transport);
const permissionPort = createChatPermissionPort(transport, sourceTabPort);
const readinessService = createBrowserReadinessService();
const launchId = new URLSearchParams(window.location.search).get('launch') ?? '';
const runService = createChatRunService({
  ai: createTransportTextGenerationPort(transport),
  agent: createTransportAgentRunPort(transport),
  async environment() {
    const readiness = await readinessService.check();
    return {
      provider: readiness.model.provider,
      model: readiness.model.model,
      locality: readiness.model.locality,
    };
  },
});
const services = {
  readiness: readinessService,
  consent: createConsentContextCoordinator({
    launchId,
    permissionPort,
    sourceTabPort,
  }),
  run: runService,
  listToolNames: listConnectedToolNames,
  async openConnections() {
    await browserAPI.tabs.create({
      url: browserAPI.runtime.getURL('sidebar.html'),
    });
  },
  reload() {
    window.location.reload();
  },
};

createRoot(rootElement).render(
  <StrictMode>
    <App services={services} />
  </StrictMode>,
);
