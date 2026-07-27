import { useCallback, useState } from 'react';
import type { ChatIntent, SourceContextPreview } from '../../contracts';
import {
  approveTools,
  createDefaultChatIntent,
  disableTools,
  excludeSourceContext,
  includeSourceContext,
} from './intent-state';

export type ChatIntentController = {
  intent: ChatIntent;
  includeSource(preview: SourceContextPreview): void;
  excludeSource(): void;
  allowTools(toolNames: string[]): void;
  turnOffTools(): void;
  reset(): void;
};

export function useChatIntent(
  initialIntent: ChatIntent = createDefaultChatIntent(),
): ChatIntentController {
  const [intent, setIntent] = useState<ChatIntent>(initialIntent);

  const includeSource = useCallback((preview: SourceContextPreview) => {
    setIntent((currentIntent) =>
      includeSourceContext(currentIntent, preview)
    );
  }, []);

  const excludeSource = useCallback(() => {
    setIntent(excludeSourceContext);
  }, []);

  const allowTools = useCallback((toolNames: string[]) => {
    setIntent((currentIntent) => approveTools(currentIntent, toolNames));
  }, []);

  const turnOffTools = useCallback(() => {
    setIntent(disableTools);
  }, []);

  const reset = useCallback(() => {
    setIntent(createDefaultChatIntent());
  }, []);

  return {
    intent,
    includeSource,
    excludeSource,
    allowTools,
    turnOffTools,
    reset,
  };
}
