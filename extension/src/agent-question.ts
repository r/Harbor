/**
 * Agent Question Prompt Handler
 *
 * Runs in the popup window `page-api/agent-question.ts` opens for one ACP
 * `session/request_permission`. Shows the agent's own question — never
 * Harbor's own framing of it — and relays the person's choice back
 * unchanged. See docs/ACP_BACKEND_DESIGN.md section 3 ("Relaying
 * permission requests").
 *
 * Deliberately not sharing code with permission-prompt.ts, which answers a
 * different question (whether a *site* may use the person's agent at all):
 * see the brief this was built from. This page fetches its own content
 * from the background by the opaque `id` in its URL — not the request
 * itself, which can carry an arbitrarily large `rawInput` — and the
 * background answers only this page's own messages (page-api/
 * agent-question.ts's sender check).
 */
import { browserAPI } from './browser-compat';
import { optionLabel } from './agent-question-label';

// =============================================================================
// The question
// =============================================================================

interface AgentQuestionOption {
  optionId: string;
  name: string;
  kind: string;
}

interface AgentQuestionToolCall {
  title: string;
  kind?: string;
  rawInput?: unknown;
  locations?: Array<{ path: string; line?: number }>;
}

interface AgentQuestionPayload {
  origin: string;
  agentName: string;
  toolCall: AgentQuestionToolCall;
  options: AgentQuestionOption[];
}

/** Above this, the raw input is shown truncated with a "Show all" toggle. */
const RAW_INPUT_PREVIEW_LIMIT = 4000;

const id = new URLSearchParams(window.location.search).get('id') || '';

function showError(message: string): void {
  const content = document.getElementById('content');
  if (!content) return;
  content.innerHTML = '';
  const p = document.createElement('div');
  p.className = 'error-message';
  p.textContent = message;
  content.appendChild(p);
}

function renderHeader(agentName: string, origin: string): void {
  const heading = document.getElementById('heading');
  if (heading) heading.textContent = `${agentName} is asking for permission`;
  const subtext = document.getElementById('subtext');
  if (subtext) subtext.textContent = `while working on a request from ${origin}`;
}

function renderToolCall(toolCall: AgentQuestionToolCall): void {
  const titleEl = document.getElementById('tool-title');
  if (titleEl) titleEl.textContent = toolCall.title || '(untitled tool call)';

  const kindEl = document.getElementById('tool-kind');
  if (kindEl) {
    if (toolCall.kind) {
      kindEl.textContent = toolCall.kind;
      kindEl.style.display = '';
    } else {
      kindEl.style.display = 'none';
    }
  }

  if (toolCall.rawInput !== undefined) {
    const section = document.getElementById('raw-input-section');
    const pre = document.getElementById('raw-input');
    const showAllBtn = document.getElementById('btn-show-all');
    if (section && pre) {
      section.style.display = 'block';
      const full = JSON.stringify(toolCall.rawInput, null, 2);
      if (full.length > RAW_INPUT_PREVIEW_LIMIT) {
        pre.textContent = `${full.slice(0, RAW_INPUT_PREVIEW_LIMIT)}\n… (truncated)`;
        if (showAllBtn) {
          showAllBtn.style.display = '';
          showAllBtn.addEventListener('click', () => {
            pre.textContent = full;
            showAllBtn.style.display = 'none';
          });
        }
      } else {
        pre.textContent = full;
      }
    }
  }

  if (toolCall.locations && toolCall.locations.length > 0) {
    const section = document.getElementById('locations-section');
    const list = document.getElementById('locations-list');
    if (section && list) {
      section.style.display = 'block';
      for (const loc of toolCall.locations) {
        const item = document.createElement('div');
        item.className = 'location-item';
        item.textContent = typeof loc.line === 'number' ? `${loc.path}:${loc.line}` : loc.path;
        list.appendChild(item);
      }
    }
  }
}

/** Allow-flavoured options are styled distinctly from reject-flavoured ones; anything else (an agent-defined kind this page doesn't know) renders as a reject-styled, i.e. non-default, button. */
function buttonClass(kind: string): string {
  return kind.startsWith('allow') ? 'btn-primary' : 'btn-secondary';
}

function renderOptions(options: AgentQuestionOption[]): void {
  const container = document.getElementById('options');
  if (!container) return;
  // The agent's own order, exactly as it sent them — Harbor adds nothing.
  for (const option of options) {
    const btn = document.createElement('button');
    btn.className = `btn ${buttonClass(option.kind)}`;
    btn.textContent = optionLabel(option);
    btn.addEventListener('click', async () => {
      for (const b of container.querySelectorAll('button')) (b as HTMLButtonElement).disabled = true;
      let response: { ok?: boolean } | undefined;
      try {
        response = await browserAPI.runtime.sendMessage({ type: 'agent_question_answer', id, optionId: option.optionId });
      } catch {
        response = undefined;
      }
      // On success the background closes this window. Otherwise the question
      // was already answered, timed out or withdrawn by the agent.
      if (!response?.ok) showError('This question is no longer waiting for an answer.');
    });
    container.appendChild(btn);
  }
  // Start keyboard focus on a reject option, so Enter never approves by accident.
  const firstReject = options.findIndex((o) => !o.kind.startsWith('allow'));
  if (firstReject >= 0) (container.children[firstReject] as HTMLButtonElement | undefined)?.focus();
}

// Escape closes the window, which the background treats as the agent's reject option.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.close();
});

async function load(): Promise<void> {
  if (!id) {
    showError('No question to show.');
    return;
  }

  let response: { ok: boolean; request?: AgentQuestionPayload } | undefined;
  try {
    response = await browserAPI.runtime.sendMessage({ type: 'agent_question_get', id });
  } catch {
    response = undefined;
  }

  if (!response?.ok || !response.request) {
    showError('This question is no longer waiting for an answer.');
    return;
  }

  const { origin, agentName, toolCall, options } = response.request;
  renderHeader(agentName, origin);
  renderToolCall(toolCall);
  renderOptions(options);
}

// Closing this window (without clicking a button) is handled entirely by
// the background script (page-api/agent-question.ts): it answers with the
// agent's own reject option once the window is gone.
void load();
