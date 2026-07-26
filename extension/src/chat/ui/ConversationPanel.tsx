import type {
  ConversationMessage,
  ConversationToolActivity,
} from '../features/conversation/conversation-types';
import { PortLight } from './PortLight';
import { SectionHeading } from './SectionHeading';

type ConversationPanelProps = {
  messages: ConversationMessage[];
  statusMessage?: string;
  toolActivity: ConversationToolActivity[];
  starterActions: string[];
  onStarterAction(action: string): void;
};

export function ConversationPanel({
  messages,
  statusMessage,
  toolActivity,
  starterActions,
  onStarterAction,
}: ConversationPanelProps) {
  return (
    <section
      aria-label="Conversation"
      className="conversation-panel"
    >
      <SectionHeading
        description="One request at a time, with authority attached to the run."
        eyebrow="Chart table"
        title="Conversation"
      />

      <div className="conversation-panel__body">
        {messages.length === 0 ? (
          <div className="conversation-empty">
            <p className="conversation-empty__lead">
              What outcome are you navigating toward?
            </p>
            <p>
              Start with the model. Add this page or connected tools only when
              they make the answer better.
            </p>
            <div
              aria-label="Starter actions"
              className="starter-actions"
            >
              {starterActions.map(action => (
                <button
                  className="starter-action"
                  key={action}
                  onClick={() => onStarterAction(action)}
                  type="button"
                >
                  <span>{action}</span>
                  <span aria-hidden="true">↗</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ol className="conversation-feed">
            {messages.map(message => (
              <li
                className="conversation-message"
                data-message-role={message.role}
                data-message-state={message.state}
                key={message.id}
              >
                <div className="conversation-message__meta">
                  <span>
                    {message.role === 'user' ? 'You' : 'Harbor'}
                  </span>
                  <time dateTime={message.createdAt}>
                    {formatMessageTime(message.createdAt)}
                  </time>
                </div>
                <p>{message.content}</p>
              </li>
            ))}
          </ol>
        )}
      </div>

      {statusMessage ? (
        <p
          aria-live="polite"
          className="conversation-status"
        >
          <PortLight state="pending" />
          {statusMessage}
        </p>
      ) : null}

      {toolActivity.length > 0 ? (
        <ol aria-label="Tool activity" className="tool-activity">
          {toolActivity.map(activity => (
            <li data-tool-state={activity.state} key={activity.callId}>
              <PortLight state={getToolLightState(activity.state)} />
              <span>{activity.tool}</span>
              <span>{getToolStateLabel(activity.state)}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

function formatMessageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function getToolLightState(
  state: ConversationToolActivity['state'],
): 'ready' | 'pending' | 'attention' {
  if (state === 'running') {
    return 'pending';
  }
  if (state === 'completed') {
    return 'ready';
  }
  return 'attention';
}

function getToolStateLabel(
  state: ConversationToolActivity['state'],
): string {
  const labels: Record<ConversationToolActivity['state'], string> = {
    running: 'Running',
    completed: 'Complete',
    failed: 'Failed',
    denied: 'Not approved',
  };
  return labels[state];
}
