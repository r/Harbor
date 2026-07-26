export type SupportedBrowser = 'firefox' | 'chrome' | 'safari' | 'unknown';

export type ExtensionManagementTarget = {
  buttonLabel: string;
  clipboardValue: string;
  successMessage: string;
};

const EXTENSION_MANAGEMENT_TARGETS: Record<
  Exclude<SupportedBrowser, 'unknown'>,
  ExtensionManagementTarget
> = {
  firefox: {
    buttonLabel: 'Copy Firefox debugging URL',
    clipboardValue: 'about:debugging#/runtime/this-firefox',
    successMessage: 'Copied Firefox debugging URL. Paste it in the address bar.',
  },
  chrome: {
    buttonLabel: 'Copy Chrome extensions URL',
    clipboardValue: 'chrome://extensions',
    successMessage: 'Copied Chrome extensions URL. Paste it in the address bar.',
  },
  safari: {
    buttonLabel: 'Copy Safari setup guide path',
    clipboardValue: 'installer/safari/README.md',
    successMessage: 'Copied Safari setup guide path.',
  },
};

export function getExtensionManagementTarget(
  browserName: SupportedBrowser,
): ExtensionManagementTarget | null {
  if (browserName === 'unknown') {
    return null;
  }

  return EXTENSION_MANAGEMENT_TARGETS[browserName];
}
