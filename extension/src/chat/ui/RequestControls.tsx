import type { SourceContextPreview } from '../contracts';

type ContextControl =
  | { kind: 'unavailable' }
  | {
    kind: 'available';
    preview: SourceContextPreview;
    state: 'off' | 'included';
    onToggle(): void;
  };

type ToolControl =
  | {
    state: 'off';
    onToggle(): void;
  }
  | {
    state: 'loading';
    onToggle(): void;
  }
  | {
    state: 'approved';
    count: number;
    onToggle(): void;
  };

type RequestControlsProps = {
  context: ContextControl;
  tools: ToolControl;
};

export function RequestControls({
  context,
  tools,
}: RequestControlsProps) {
  return (
    <section aria-labelledby="request-route-title" className="request-controls">
      <header className="request-controls__header">
        <p>Request route</p>
        <h2 id="request-route-title">Choose what travels with this message</h2>
      </header>

      <div className="request-controls__rail">
        <div className="request-control" data-control-state="fixed">
          <span className="request-control__index">01</span>
          <span className="request-control__copy">
            <strong>Selected model</strong>
            <small>Required for the response</small>
          </span>
          <span className="request-control__state">Included</span>
        </div>

        {context.kind === 'available' ? (
          <button
            aria-label={`Read this page: ${context.preview.title}. ${
              context.state === 'included' ? 'Included' : 'Off'
            }`}
            aria-pressed={context.state === 'included'}
            className="request-control"
            data-control-state={context.state}
            onClick={context.onToggle}
            type="button"
          >
            <span className="request-control__index">02</span>
            <span className="request-control__copy">
              <strong>Read this page</strong>
              <small title={context.preview.title}>
                {context.preview.title}
              </small>
            </span>
            <span className="request-control__state">
              {context.state === 'included' ? 'Included' : 'Off'}
            </span>
          </button>
        ) : (
          <div className="request-control" data-control-state="unavailable">
            <span className="request-control__index">02</span>
            <span className="request-control__copy">
              <strong>Page context</strong>
              <small>Open chat from a page to add it</small>
            </span>
            <span className="request-control__state">Unavailable</span>
          </div>
        )}

        <button
          aria-label={`Connected tools. ${getToolStateLabel(tools)}`}
          aria-pressed={tools.state === 'approved'}
          className="request-control"
          data-control-state={tools.state}
          disabled={tools.state === 'loading'}
          onClick={tools.onToggle}
          type="button"
        >
          <span className="request-control__index">03</span>
          <span className="request-control__copy">
            <strong>Connected tools</strong>
            <small>{getToolDetail(tools)}</small>
          </span>
          <span className="request-control__state">
            {getToolStateLabel(tools)}
          </span>
        </button>
      </div>
    </section>
  );
}

function getToolDetail(tools: ToolControl): string {
  if (tools.state === 'approved') {
    return `${tools.count} available to this run`;
  }
  if (tools.state === 'loading') {
    return 'Reading the connected inventory';
  }
  return 'Approve only when this request needs them';
}

function getToolStateLabel(tools: ToolControl): string {
  if (tools.state === 'approved') {
    return 'Included';
  }
  if (tools.state === 'loading') {
    return 'Checking';
  }
  return 'Off';
}
