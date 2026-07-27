import { useEffect, useState } from 'react';
import type {
  RecoveryAction,
  SourceContextPreview,
} from '../contracts';
import { useConversation } from '../features/conversation/use-conversation';
import { useChatIntent } from '../features/intent/use-chat-intent';
import { ReadinessPanel } from '../features/readiness/ReadinessPanel';
import { useChatReadiness } from '../features/readiness/useChatReadiness';
import { useRunReceipts } from '../features/receipts/use-run-receipts';
import {
  ChatShell,
  ChatShellRoute,
  ChatShellVoyageRail,
  ChatShellWorkspace,
} from '../layout/ChatShell';
import { ChatComposer } from '../ui/ChatComposer';
import { ConversationPanel } from '../ui/ConversationPanel';
import { HarborHeader } from '../ui/HarborHeader';
import { NoticeBanner } from '../ui/NoticeBanner';
import { ReceiptsPanel } from '../ui/ReceiptsPanel';
import { RequestControls } from '../ui/RequestControls';
import type { ChatApplicationServices } from './chat-application-services';

type ChatApplicationProps = {
  services: ChatApplicationServices;
};

type Notice = {
  tone: 'info' | 'error';
  message: string;
};

const STARTER_ACTIONS = [
  'Summarize the key points',
  'Explain this in plain language',
  'Help me decide what to do next',
];

export function ChatApplication({
  services,
}: ChatApplicationProps) {
  const readinessController = useChatReadiness(services.readiness);
  const intentController = useChatIntent();
  const receiptController = useRunReceipts();
  const conversation = useConversation({
    runService: services.run,
    onReceipt: receiptController.addReceipt,
  });
  const [draft, setDraft] = useState('');
  const [sourcePreview, setSourcePreview] =
    useState<SourceContextPreview | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [loadingTools, setLoadingTools] = useState(false);

  useEffect(() => {
    let active = true;
    void services.consent.previewSource().then(preview => {
      if (active) {
        setSourcePreview(preview);
      }
    });
    return () => {
      active = false;
    };
  }, [services.consent]);

  const ready = readinessController.readiness.blockers.length === 0
    && readinessController.readiness.model.state === 'ready';
  const routeState = getRouteState(readinessController.readiness);
  const composerState = !ready
    ? 'blocked'
    : conversation.isProcessing
      ? 'working'
      : 'ready';

  async function handleSubmit() {
    const prompt = draft.trim();
    if (!prompt || !ready || conversation.isProcessing) {
      return;
    }

    setNotice(null);
    const outcome = await services.consent.approveIntent(
      intentController.intent,
    );
    if (outcome.kind === 'approved' || outcome.kind === 'fallback') {
      if (outcome.kind === 'fallback') {
        setNotice({
          tone: 'info',
          message: describeFallback(outcome.omitted),
        });
      }
      setDraft('');
      await conversation.send({
        prompt,
        approval: outcome.approval,
      });
      return;
    }

    setNotice({
      tone: 'error',
      message: describeConsentFailure(outcome),
    });
  }

  async function handleToolsToggle() {
    if (intentController.intent.tools.mode === 'approved') {
      intentController.turnOffTools();
      return;
    }

    setLoadingTools(true);
    setNotice(null);
    try {
      const toolNames = await services.listToolNames();
      if (toolNames.length === 0) {
        setNotice({
          tone: 'info',
          message: 'Connect a tool before enabling tool-assisted answers.',
        });
        return;
      }
      intentController.allowTools(toolNames);
    } catch {
      setNotice({
        tone: 'error',
        message: 'Harbor could not load the connected tools.',
      });
    } finally {
      setLoadingTools(false);
    }
  }

  function handleRecoveryAction(action: RecoveryAction) {
    if (action.kind === 'retry') {
      void readinessController.retry();
    } else if (action.kind === 'reload') {
      services.reload();
    } else {
      void services.openConnections();
    }
  }

  return (
    <ChatShell>
      <HarborHeader state={routeState} />

      <ChatShellRoute>
        <ReadinessPanel
          readiness={readinessController.readiness}
          onRecoveryAction={handleRecoveryAction}
        />
      </ChatShellRoute>

      <ChatShellWorkspace>
        <div className="chat-shell__main">
          <ConversationPanel
            messages={conversation.state.messages}
            onStarterAction={setDraft}
            starterActions={STARTER_ACTIONS}
            statusMessage={conversation.state.statusMessage}
            toolActivity={conversation.state.toolActivity}
          />

          {notice ? (
            <NoticeBanner message={notice.message} tone={notice.tone} />
          ) : null}

          <RequestControls
            context={sourcePreview
              ? {
                kind: 'available',
                preview: sourcePreview,
                state: intentController.intent.context.mode === 'source'
                  ? 'included'
                  : 'off',
                onToggle() {
                  if (intentController.intent.context.mode === 'source') {
                    intentController.excludeSource();
                  } else {
                    intentController.includeSource(sourcePreview);
                  }
                },
              }
              : { kind: 'unavailable' }}
            tools={loadingTools
              ? {
                state: 'loading',
                onToggle() {},
              }
              : intentController.intent.tools.mode === 'approved'
                ? {
                  state: 'approved',
                  count: intentController.intent.tools.toolNames.length,
                  onToggle: () => void handleToolsToggle(),
                }
                : {
                  state: 'off',
                  onToggle: () => void handleToolsToggle(),
                }}
          />

          <ChatComposer
            onChange={setDraft}
            onSubmit={() => void handleSubmit()}
            state={composerState}
            value={draft}
          />
        </div>

        <ChatShellVoyageRail>
          <ReceiptsPanel receipts={receiptController.receipts} />
        </ChatShellVoyageRail>
      </ChatShellWorkspace>
    </ChatShell>
  );
}

function getRouteState(
  readiness: Awaited<ReturnType<ChatApplicationServices['readiness']['check']>>,
): 'checking' | 'blocked' | 'ready' {
  if (
    readiness.bridge === 'checking'
    || readiness.model.state === 'checking'
  ) {
    return 'checking';
  }
  return readiness.blockers.length > 0 ? 'blocked' : 'ready';
}

function describeFallback(omitted: Array<'context' | 'tools'>): string {
  if (omitted.length === 2) {
    return 'Continuing with the model only, without page context or tools.';
  }
  return omitted[0] === 'context'
    ? 'Continuing without reading the page.'
    : 'Continuing without connected tools.';
}

function describeConsentFailure(
  outcome: Exclude<
    Awaited<ReturnType<ChatApplicationServices['consent']['approveIntent']>>,
    { kind: 'approved' | 'fallback' }
  >,
): string {
  if (outcome.kind === 'denied') {
    return 'Access was not approved. Your message is still here.';
  }
  if (outcome.kind === 'dismissed') {
    return 'The access request was dismissed. Your message is still here.';
  }
  if (outcome.kind === 'stale') {
    return 'That page changed after chat opened. Open chat from it again.';
  }
  return outcome.kind === 'failed' || outcome.kind === 'unavailable'
    ? outcome.message
    : 'Harbor could not approve this request.';
}
