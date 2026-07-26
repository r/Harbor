import type { ExecutionReceipt } from '../contracts';
import { ExecutionReceiptDisclosure } from '../features/receipts/ExecutionReceiptDisclosure';
import { SectionHeading } from './SectionHeading';

type ReceiptsPanelProps = {
  receipts: ExecutionReceipt[];
};

export function ReceiptsPanel({ receipts }: ReceiptsPanelProps) {
  return (
    <section aria-label="Run receipts" className="receipts-panel">
      <SectionHeading
        description="Metadata only. Prompt and page contents stay out."
        eyebrow="Ship log"
        title="Run receipts"
      />
      {receipts.length > 0 ? (
        <div className="receipts-panel__list">
          {receipts.map(receipt => (
            <ExecutionReceiptDisclosure
              key={receipt.id}
              receipt={receipt}
            />
          ))}
        </div>
      ) : (
        <p className="receipts-panel__empty">
          Completed runs will leave a compact receipt here.
        </p>
      )}
    </section>
  );
}
