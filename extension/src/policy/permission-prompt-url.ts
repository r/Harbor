type PermissionPromptSessionContext = {
  name?: string;
  type?: 'implicit' | 'explicit';
  requestedLLM?: boolean;
  requestedToolsCount?: number;
  requestedBrowser?: Array<'read' | 'interact' | 'screenshot'>;
};

type PermissionPromptUrlOptions = {
  origin: string;
  scopes: string[];
  reason?: string;
  tools?: string[];
  sessionContext?: PermissionPromptSessionContext;
};

export function buildPermissionPromptUrl(
  getExtensionUrl: (path: string) => string,
  options: PermissionPromptUrlOptions,
): string {
  const params = new URLSearchParams({
    origin: options.origin,
    scopes: options.scopes.join(','),
  });

  if (options.reason) {
    params.set('reason', options.reason);
  }
  if (options.tools && options.tools.length > 0) {
    params.set('tools', options.tools.join(','));
  }
  if (options.sessionContext?.name) {
    params.set('sessionName', options.sessionContext.name);
  }
  if (options.sessionContext?.type) {
    params.set('sessionType', options.sessionContext.type);
  }
  if (options.sessionContext?.requestedLLM) {
    params.set('llm', 'true');
  }
  if (options.sessionContext?.requestedToolsCount !== undefined) {
    params.set(
      'toolsCount',
      String(options.sessionContext.requestedToolsCount),
    );
  }
  if (
    options.sessionContext?.requestedBrowser
    && options.sessionContext.requestedBrowser.length > 0
  ) {
    params.set(
      'browser',
      options.sessionContext.requestedBrowser.join(','),
    );
  }

  return getExtensionUrl(`permission-prompt.html?${params.toString()}`);
}
