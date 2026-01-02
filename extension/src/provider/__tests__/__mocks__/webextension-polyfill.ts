/**
 * Mock for webextension-polyfill browser API
 * 
 * This mock is automatically used by vitest when importing 'webextension-polyfill'
 */

// Shared mock storage
export const __mockStorage: Record<string, unknown> = {};

export function __clearMockStorage(): void {
  Object.keys(__mockStorage).forEach(key => delete __mockStorage[key]);
}

const browser = {
  storage: {
    local: {
      get: async (key: string) => {
        return { [key]: __mockStorage[key] };
      },
      set: async (data: Record<string, unknown>) => {
        Object.assign(__mockStorage, data);
      },
    },
  },
  runtime: {
    sendMessage: async () => ({}),
    getURL: (path: string) => `moz-extension://test-id/${path}`,
    onMessage: {
      addListener: () => {},
      removeListener: () => {},
    },
    onConnect: {
      addListener: () => {},
    },
  },
  tabs: {
    query: async () => [],
    onRemoved: {
      addListener: () => {},
    },
  },
  windows: {
    create: async () => ({}),
  },
  scripting: {
    executeScript: async () => [],
  },
};

export default browser;

