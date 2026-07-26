import type {
  ChatReadiness,
  RecoveryAction,
} from '../../contracts';
import { RecoveryActionList } from './RecoveryActionList';

export type ReadinessPanelProps = {
  readiness: ChatReadiness;
  onRecoveryAction(action: RecoveryAction): void;
};

export function ReadinessPanel({
  readiness,
  onRecoveryAction,
}: ReadinessPanelProps) {
  const overallState = getOverallState(readiness);

  return (
    <section
      aria-labelledby="chat-readiness-title"
      className="chat-readiness"
      data-readiness-state={overallState}
    >
      <header className="chat-readiness__header">
        <p className="chat-readiness__eyebrow">System status</p>
        <h2 id="chat-readiness-title">{getPanelTitle(overallState)}</h2>
      </header>

      <dl className="chat-readiness__ledger" aria-live="polite">
        <ReadinessRow
          label="Harbor"
          state={readiness.bridge}
          value={getBridgeLabel(readiness)}
        />
        <ReadinessRow
          label="Model"
          state={readiness.model.state}
          value={getModelLabel(readiness)}
        />
        <ReadinessRow
          label="Tools"
          state={readiness.tools.state}
          value={getToolsLabel(readiness)}
        />
      </dl>

      <RecoveryActionList
        actions={readiness.blockers}
        onAction={onRecoveryAction}
      />
    </section>
  );
}

type ReadinessRowProps = {
  label: string;
  state: string;
  value: string;
};

function ReadinessRow({
  label,
  state,
  value,
}: ReadinessRowProps) {
  return (
    <div className="chat-readiness__row" data-state={state}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function getOverallState(
  readiness: ChatReadiness,
): 'checking' | 'blocked' | 'ready' {
  if (
    readiness.bridge === 'checking'
    || readiness.model.state === 'checking'
  ) {
    return 'checking';
  }

  return readiness.blockers.length > 0 ? 'blocked' : 'ready';
}

function getPanelTitle(state: 'checking' | 'blocked' | 'ready'): string {
  const labels = {
    checking: 'Checking Harbor',
    blocked: 'Harbor needs attention',
    ready: 'Ready for departure',
  };
  return labels[state];
}

function getBridgeLabel(readiness: ChatReadiness): string {
  if (readiness.api === 'missing') {
    return 'Chat API unavailable';
  }

  const labels: Record<ChatReadiness['bridge'], string> = {
    checking: 'Checking connection',
    ready: 'Connected',
    offline: 'Connection unavailable',
  };
  return labels[readiness.bridge];
}

function getModelLabel(readiness: ChatReadiness): string {
  if (readiness.model.state === 'ready') {
    return [
      readiness.model.model,
      readiness.model.provider,
      readiness.model.locality,
    ].filter(Boolean).join(' · ');
  }

  const labels: Record<Exclude<
    ChatReadiness['model']['state'],
    'ready'
  >, string> = {
    checking: 'Checking configuration',
    unconfigured: 'Choose a model',
    unavailable: 'Model unavailable',
  };
  return labels[readiness.model.state];
}

function getToolsLabel(readiness: ChatReadiness): string {
  const labels: Record<ChatReadiness['tools']['state'], string> = {
    checking: 'Checking tools',
    ready: `${readiness.tools.count} available`,
    empty: 'None connected',
    unavailable: 'Inventory unavailable',
  };
  return labels[readiness.tools.state];
}
