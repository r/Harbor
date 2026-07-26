import type { RecoveryAction } from '../../contracts';

export type RecoveryActionListProps = {
  actions: readonly RecoveryAction[];
  onAction(action: RecoveryAction): void;
};

export function RecoveryActionList({
  actions,
  onAction,
}: RecoveryActionListProps) {
  if (actions.length === 0) {
    return null;
  }

  return (
    <div className="chat-readiness__actions" aria-label="Recovery actions">
      {actions.map(action => (
        <button
          className="chat-readiness__action"
          data-recovery-action={action.kind}
          key={action.kind}
          onClick={() => onAction(action)}
          type="button"
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
