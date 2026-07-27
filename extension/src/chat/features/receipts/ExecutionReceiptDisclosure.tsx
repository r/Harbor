import type { ExecutionReceipt } from '../../contracts';

type ExecutionReceiptDisclosureProps = {
  receipt: ExecutionReceipt;
  defaultOpen?: boolean;
};

function receiptHeading(receipt: ExecutionReceipt): string {
  if (receipt.status === 'completed') {
    return 'Completed';
  }
  if (receipt.status === 'cancelled') {
    return 'Cancelled';
  }
  return 'Could not complete';
}

export function ExecutionReceiptDisclosure({
  receipt,
  defaultOpen = false,
}: ExecutionReceiptDisclosureProps) {
  return (
    <details
      className="execution-receipt"
      data-receipt-id={receipt.id}
      open={defaultOpen}
    >
      <summary className="execution-receipt__summary">
        <span>How this worked</span>
        <span>{receiptHeading(receipt)}</span>
      </summary>
      <dl className="execution-receipt__ledger">
        <div>
          <dt>Route</dt>
          <dd>{receipt.mode === 'agent' ? 'Model and tools' : 'Model only'}</dd>
        </div>
        {receipt.provider ? (
          <div>
            <dt>Provider</dt>
            <dd>{receipt.provider}</dd>
          </div>
        ) : null}
        {receipt.model ? (
          <div>
            <dt>Model</dt>
            <dd>{receipt.model}</dd>
          </div>
        ) : null}
        {receipt.locality ? (
          <div>
            <dt>Processing</dt>
            <dd>{receipt.locality === 'local' ? 'On this device' : 'Cloud'}</dd>
          </div>
        ) : null}
        {receipt.source ? (
          <div>
            <dt>Page context</dt>
            <dd>{receipt.source.title} ({receipt.source.origin})</dd>
          </div>
        ) : null}
        <div>
          <dt>Access</dt>
          <dd>{receipt.scopes.length > 0 ? receipt.scopes.join(', ') : 'Model only'}</dd>
        </div>
        <div>
          <dt>Tools</dt>
          <dd>{receipt.toolCalls.length}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{receipt.durationMs} ms</dd>
        </div>
      </dl>
      {receipt.toolCalls.length > 0 ? (
        <ol className="execution-receipt__tools" aria-label="Tool calls">
          {receipt.toolCalls.map((toolCall) => (
            <li key={toolCall.callId}>
              <span>{toolCall.tool}</span>
              <span>{toolCall.status}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </details>
  );
}
