import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
} from 'react';
import type {
  ChatRunEvent,
  ChatRunRequest,
  ExecutionReceipt,
} from '../../contracts';
import type { RunService } from '../../services';
import {
  conversationReducer,
  INITIAL_CONVERSATION_STATE,
} from './conversation-reducer';
import type {
  ConversationAction,
  ConversationMessage,
} from './conversation-types';

type UseConversationOptions = {
  runService: RunService;
  onReceipt?: (receipt: ExecutionReceipt) => void;
  createId?: () => string;
  now?: () => Date;
};

type CancellableRunService = RunService & {
  cancel(runId?: string): void;
};

function defaultCreateId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function defaultNow(): Date {
  return new Date();
}

function actionForEvent(event: ChatRunEvent): ConversationAction {
  if (event.type === 'started') {
    return { type: 'started', runId: event.runId };
  }
  if (event.type === 'status') {
    return event;
  }
  if (event.type === 'content-delta') {
    return event;
  }
  if (event.type === 'tool-started') {
    return event;
  }
  if (event.type === 'tool-completed') {
    return event;
  }
  if (event.type === 'completed') {
    return event;
  }
  if (event.type === 'failed') {
    return event;
  }
  return event;
}

function receiptForEvent(event: ChatRunEvent): ExecutionReceipt | undefined {
  if (
    event.type === 'completed'
    || event.type === 'failed'
    || event.type === 'cancelled'
  ) {
    return event.receipt;
  }
  return undefined;
}

export function useConversation(options: UseConversationOptions) {
  const [state, dispatch] = useReducer(
    conversationReducer,
    INITIAL_CONVERSATION_STATE,
  );
  const runGeneration = useRef(0);
  const mounted = useRef(true);
  const onReceipt = useRef(options.onReceipt);
  onReceipt.current = options.onReceipt;
  const createId = options.createId ?? defaultCreateId;
  const now = options.now ?? defaultNow;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      runGeneration.current += 1;
      const runService = options.runService as Partial<CancellableRunService>;
      runService.cancel?.();
    };
  }, [options.runService]);

  const send = useCallback(async (request: ChatRunRequest): Promise<void> => {
    if (state.activeAssistantMessageId) {
      return;
    }

    const generation = runGeneration.current + 1;
    runGeneration.current = generation;
    const createdAt = now().toISOString();
    const userMessage: ConversationMessage = {
      id: createId(),
      role: 'user',
      content: request.prompt,
      createdAt,
      state: 'complete',
    };
    const assistantMessage: ConversationMessage = {
      id: createId(),
      role: 'assistant',
      content: '',
      createdAt,
      state: 'streaming',
    };
    dispatch({
      type: 'begin',
      value: { userMessage, assistantMessage },
    });

    let bufferedContent = '';
    let animationFrame: number | undefined;

    const flushContent = (): void => {
      if (!bufferedContent || generation !== runGeneration.current) {
        bufferedContent = '';
        return;
      }
      dispatch({ type: 'content-delta', text: bufferedContent });
      bufferedContent = '';
    };

    const scheduleContentFlush = (): void => {
      if (animationFrame !== undefined) {
        return;
      }
      if (typeof requestAnimationFrame === 'function') {
        animationFrame = requestAnimationFrame(() => {
          animationFrame = undefined;
          flushContent();
        });
      } else {
        flushContent();
      }
    };

    for await (const event of options.runService.run(request)) {
      if (!mounted.current || generation !== runGeneration.current) {
        break;
      }
      if (event.type === 'content-delta') {
        bufferedContent += event.text;
        scheduleContentFlush();
        continue;
      }

      if (animationFrame !== undefined && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(animationFrame);
        animationFrame = undefined;
      }
      flushContent();
      dispatch(actionForEvent(event));

      const receipt = receiptForEvent(event);
      if (receipt) {
        onReceipt.current?.(receipt);
      }
    }

    if (animationFrame !== undefined && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(animationFrame);
    }
    flushContent();
  }, [
    createId,
    now,
    options.runService,
    state.activeAssistantMessageId,
  ]);

  const clear = useCallback((): void => {
    runGeneration.current += 1;
    const runService = options.runService as Partial<CancellableRunService>;
    runService.cancel?.(state.activeRunId);
    dispatch({ type: 'clear' });
  }, [options.runService, state.activeRunId]);

  return {
    state,
    send,
    clear,
    isProcessing: state.activeAssistantMessageId !== undefined,
  };
}
