import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { ChatPermissionScope, SourceContextResult } from '../../contracts';
import type { SourceTabPort } from '../../services';
import {
  approveSourceContext,
  captureApprovedSourceContext,
  resolveSourceContext,
} from './source-context-coordinator';
import type {
  AvailableSourceContext,
  SourceContextHookState,
} from './source-context-state';

export type SourceContextController = {
  state: SourceContextHookState;
  refreshPreview(): Promise<void>;
  capture(scopes: ChatPermissionScope[]): Promise<SourceContextResult>;
};

export function useSourceContext(options: {
  launchId: string;
  sourceTabPort: SourceTabPort;
  now?: () => number;
}): SourceContextController {
  const now = useRef(options.now ?? Date.now);
  const [state, setState] = useState<SourceContextHookState>({
    kind: 'idle',
  });
  const requestVersion = useRef(0);

  const refreshPreview = useCallback(async () => {
    const currentRequestVersion = ++requestVersion.current;
    setState({ kind: 'resolving' });

    const resolution = await resolveSourceContext(
      options.launchId,
      options.sourceTabPort,
      now.current,
    );
    if (currentRequestVersion === requestVersion.current) {
      setState(resolution);
    }
  }, [options.launchId, options.sourceTabPort]);

  useEffect(() => {
    void refreshPreview();
    return () => {
      requestVersion.current += 1;
    };
  }, [refreshPreview]);

  const capture = useCallback(async (
    scopes: ChatPermissionScope[],
  ): Promise<SourceContextResult> => {
    if (state.kind !== 'available') {
      if (
        state.kind === 'captured'
        || state.kind === 'unavailable'
        || state.kind === 'stale'
        || state.kind === 'failed'
        || state.kind === 'denied'
        || state.kind === 'dismissed'
      ) {
        return state;
      }

      return {
        kind: 'unavailable',
        reason: 'missing',
      };
    }

    const availableState: AvailableSourceContext = state;
    const approval = approveSourceContext(availableState, scopes);
    if (!approval) {
      const deniedResult: SourceContextResult = { kind: 'denied' };
      setState(deniedResult);
      return deniedResult;
    }

    setState({
      kind: 'capturing',
      envelope: availableState.envelope,
      preview: availableState.preview,
    });
    const result = await captureApprovedSourceContext(
      approval,
      options.sourceTabPort,
      now.current,
    );
    setState(result);
    return result;
  }, [options.sourceTabPort, state]);

  return {
    state,
    refreshPreview,
    capture,
  };
}
