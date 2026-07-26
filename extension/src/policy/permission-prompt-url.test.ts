import { describe, expect, it, vi } from 'vitest';
import { buildPermissionPromptUrl } from './permission-prompt-url';

describe('buildPermissionPromptUrl', () => {
  it.each([
    'chrome-extension://harbor/',
    'moz-extension://harbor/',
  ])('resolves the packaged prompt from the extension root for %s', (
    extensionRoot,
  ) => {
    const getExtensionUrl = vi.fn(
      path => `${extensionRoot}${path}`,
    );

    const result = buildPermissionPromptUrl(getExtensionUrl, {
      origin: 'https://example.com',
      scopes: ['model:prompt', 'mcp:tools.call'],
      reason: 'Use the selected capabilities',
      tools: ['search/query', 'time/now'],
      sessionContext: {
        name: 'Research helper',
        type: 'explicit',
        requestedLLM: true,
        requestedToolsCount: 2,
        requestedBrowser: ['read'],
      },
    });

    const promptUrl = new URL(result);
    expect(promptUrl.pathname).toBe('/permission-prompt.html');
    expect(promptUrl.searchParams.get('origin')).toBe('https://example.com');
    expect(promptUrl.searchParams.get('scopes')).toBe(
      'model:prompt,mcp:tools.call',
    );
    expect(promptUrl.searchParams.get('tools')).toBe(
      'search/query,time/now',
    );
    expect(promptUrl.searchParams.get('sessionName')).toBe(
      'Research helper',
    );
    expect(promptUrl.searchParams.get('browser')).toBe('read');
    expect(getExtensionUrl).toHaveBeenCalledWith(
      expect.stringMatching(/^permission-prompt\.html\?/),
    );
  });
});
