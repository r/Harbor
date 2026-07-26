import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { ChatReadiness } from '../../contracts';
import type { ReadinessService } from '../../services';
import {
  CHECKING_CHAT_READINESS,
  createFailedReadiness,
} from './readiness-model';

export type ChatReadinessController = {
  readiness: ChatReadiness;
  retry(): Promise<void>;
};

export function useChatReadiness(
  service: ReadinessService,
): ChatReadinessController {
  const [readiness, setReadiness] = useState<ChatReadiness>(
    CHECKING_CHAT_READINESS,
  );
  const requestVersion = useRef(0);

  const retry = useCallback(async () => {
    const currentRequestVersion = ++requestVersion.current;
    setReadiness(CHECKING_CHAT_READINESS);

    try {
      const nextReadiness = await service.check();
      if (requestVersion.current === currentRequestVersion) {
        setReadiness(nextReadiness);
      }
    } catch {
      if (requestVersion.current === currentRequestVersion) {
        setReadiness(createFailedReadiness());
      }
    }
  }, [service]);

  useEffect(() => {
    void retry();

    return () => {
      requestVersion.current += 1;
    };
  }, [retry]);

  return {
    readiness,
    retry,
  };
}
