import { useCallback, useState } from 'react';
import type { ExecutionReceipt } from '../../contracts';

export function useRunReceipts() {
  const [receipts, setReceipts] = useState<ExecutionReceipt[]>([]);

  const addReceipt = useCallback((receipt: ExecutionReceipt): void => {
    setReceipts((currentReceipts) => {
      if (currentReceipts.some((current) => current.id === receipt.id)) {
        return currentReceipts;
      }
      return [...currentReceipts, receipt];
    });
  }, []);

  const clearReceipts = useCallback((): void => {
    setReceipts([]);
  }, []);

  return { receipts, addReceipt, clearReceipts };
}
