import { describe, expect, it } from 'vitest';
import { getExtensionManagementTarget } from '../developer-tools';

describe('getExtensionManagementTarget', () => {
  it('returns the Firefox temporary-extension debugger', () => {
    expect(getExtensionManagementTarget('firefox')).toEqual({
      buttonLabel: 'Copy Firefox debugging URL',
      clipboardValue: 'about:debugging#/runtime/this-firefox',
      successMessage: 'Copied Firefox debugging URL. Paste it in the address bar.',
    });
  });

  it('returns the Chrome extension manager', () => {
    expect(getExtensionManagementTarget('chrome')).toEqual({
      buttonLabel: 'Copy Chrome extensions URL',
      clipboardValue: 'chrome://extensions',
      successMessage: 'Copied Chrome extensions URL. Paste it in the address bar.',
    });
  });

  it('returns the Safari Xcode setup guide', () => {
    expect(getExtensionManagementTarget('safari')).toEqual({
      buttonLabel: 'Copy Safari setup guide path',
      clipboardValue: 'installer/safari/README.md',
      successMessage: 'Copied Safari setup guide path.',
    });
  });

  it('returns no action for an unknown browser', () => {
    expect(getExtensionManagementTarget('unknown')).toBeNull();
  });
});
