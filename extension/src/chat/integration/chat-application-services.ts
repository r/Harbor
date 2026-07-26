import type { ReadinessService, RunService } from '../services';
import type { ConsentContextCoordinator } from '../features/context/consent-context-coordinator';

export type ChatApplicationServices = {
  readiness: ReadinessService;
  consent: ConsentContextCoordinator;
  run: RunService;
  listToolNames(): Promise<string[]>;
  openConnections(): Promise<void>;
  reload(): void;
};
