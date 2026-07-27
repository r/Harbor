import type {
  ChatIntent,
  ChatPermissionScope,
  SourceContextPreview,
} from '../../contracts';

const TOOL_PERMISSION_SCOPES = new Set<ChatPermissionScope>([
  'model:tools',
  'mcp:tools.list',
  'mcp:tools.call',
]);

export function createDefaultChatIntent(): ChatIntent {
  return {
    context: { mode: 'off' },
    tools: { mode: 'off' },
  };
}

export function includeSourceContext(
  intent: ChatIntent,
  preview: SourceContextPreview,
): ChatIntent {
  return {
    ...intent,
    context: {
      mode: 'source',
      preview,
    },
  };
}

export function excludeSourceContext(intent: ChatIntent): ChatIntent {
  if (intent.context.mode === 'off') {
    return intent;
  }

  return {
    ...intent,
    context: { mode: 'off' },
  };
}

export function approveTools(
  intent: ChatIntent,
  toolNames: string[],
): ChatIntent {
  const normalizedToolNames = normalizeToolNames(toolNames);

  if (normalizedToolNames.length === 0) {
    return disableTools(intent);
  }

  return {
    ...intent,
    tools: {
      mode: 'approved',
      toolNames: normalizedToolNames,
    },
  };
}

export function disableTools(intent: ChatIntent): ChatIntent {
  if (intent.tools.mode === 'off') {
    return intent;
  }

  return {
    ...intent,
    tools: { mode: 'off' },
  };
}

export function removeDeniedCapabilities(
  intent: ChatIntent,
  deniedScopes: ChatPermissionScope[],
): {
  intent: ChatIntent;
  omitted: Array<'context' | 'tools'>;
} {
  const deniedScopeSet = new Set(deniedScopes);
  const omitted: Array<'context' | 'tools'> = [];
  let fallbackIntent = intent;

  if (
    intent.context.mode === 'source'
    && deniedScopeSet.has('browser:activeTab.read')
  ) {
    fallbackIntent = excludeSourceContext(fallbackIntent);
    omitted.push('context');
  }

  if (
    intent.tools.mode === 'approved'
    && Array.from(TOOL_PERMISSION_SCOPES).some((scope) =>
      deniedScopeSet.has(scope)
    )
  ) {
    fallbackIntent = disableTools(fallbackIntent);
    omitted.push('tools');
  }

  return {
    intent: fallbackIntent,
    omitted,
  };
}

export function normalizeToolNames(toolNames: string[]): string[] {
  const uniqueToolNames = new Set<string>();

  for (const toolName of toolNames) {
    const normalizedToolName = toolName.trim();
    if (normalizedToolName) {
      uniqueToolNames.add(normalizedToolName);
    }
  }

  return Array.from(uniqueToolNames);
}
