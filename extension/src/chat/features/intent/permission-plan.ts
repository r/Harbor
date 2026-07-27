import type {
  ChatIntent,
  ChatPermissionScope,
  PermissionPlan,
} from '../../contracts';
import { normalizeToolNames } from './intent-state';

const MODEL_SCOPE: ChatPermissionScope = 'model:prompt';
const CONTEXT_SCOPE: ChatPermissionScope = 'browser:activeTab.read';
const TOOL_SCOPES: ChatPermissionScope[] = [
  'model:tools',
  'mcp:tools.list',
  'mcp:tools.call',
];

export function buildPermissionPlan(intent: ChatIntent): PermissionPlan {
  const scopes: ChatPermissionScope[] = [MODEL_SCOPE];
  const includesSourceContext = intent.context.mode === 'source';
  const toolAllowlist = intent.tools.mode === 'approved'
    ? normalizeToolNames(intent.tools.toolNames)
    : [];

  if (includesSourceContext) {
    scopes.push(CONTEXT_SCOPE);
  }

  if (intent.tools.mode === 'approved') {
    if (toolAllowlist.length === 0) {
      throw new Error('Approved tool access requires at least one tool');
    }
    scopes.push(...TOOL_SCOPES);
  }

  return {
    scopes,
    reason: describePermissionReason(includesSourceContext, toolAllowlist),
    toolAllowlist,
  };
}

function describePermissionReason(
  includesSourceContext: boolean,
  toolAllowlist: string[],
): string {
  if (includesSourceContext && toolAllowlist.length > 0) {
    return 'Answer using the approved page and selected tools';
  }
  if (includesSourceContext) {
    return 'Answer using the approved page';
  }
  if (toolAllowlist.length > 0) {
    return 'Answer using the selected tools';
  }
  return 'Answer this message with the selected model';
}
