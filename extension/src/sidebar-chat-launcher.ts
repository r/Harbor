import {
  launchHarborChat,
  type ChatLaunchBrowser,
  type ChatLaunchStorage,
  type ChatLaunchTab,
} from './chat-launch';

type SidebarChatAPI = {
  runtime: {
    getURL(path: string): string;
  };
  storage: {
    local: ChatLaunchStorage;
  };
  tabs: {
    query(query: {
      active: boolean;
      currentWindow: boolean;
    }): Promise<ChatLaunchTab[]>;
    create(properties: { url: string }): Promise<unknown>;
  };
};

type ChatLaunchOptions = Parameters<typeof launchHarborChat>[1];

export async function launchSidebarChat(
  browserAPI: SidebarChatAPI,
  options?: ChatLaunchOptions,
): Promise<void> {
  await launchHarborChat(createSidebarChatBrowser(browserAPI), options);
}

function createSidebarChatBrowser(
  browserAPI: SidebarChatAPI,
): ChatLaunchBrowser {
  return {
    getChatUrl: () => browserAPI.runtime.getURL('chat.html'),
    async queryActiveTab() {
      const [activeTab] = await browserAPI.tabs.query({
        active: true,
        currentWindow: true,
      });
      return activeTab;
    },
    async openTab(url) {
      await browserAPI.tabs.create({ url });
    },
    storage: browserAPI.storage.local,
  };
}
