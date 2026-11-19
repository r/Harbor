# Web Agents Demos

Basic Web Agent API demos for LLM and MCP server access.

## Demos

| Demo | Description | Path |
|------|-------------|------|
| **Getting Started** | Interactive walkthrough of the Web Agent API basics | `getting-started/` |
| **Chat Demo** | Full-featured chat interface using `window.agent.run()` | `chat-poc/` |
| **Page Summarizer** | Simple page summarization using `window.ai.createTextSession()` | `summarizer/` |
| **Chrome Compat Demo** | Demonstrates Chrome Prompt API compatibility | `summarizer/chrome-compat.html` |
| **Email Chat** | Chat with your Gmail inbox using MCP tools | `email-chat/` |
| **Time Agent** | Simple MCP time tool demo | `time-agent/` |
| **Page Chat Bookmarklet** | Drag-and-drop bookmarklet for chatting about any page | `bookmarklet/` |
| **Bring Your Own Chatbot** | A shop page that opens your agent's chat with one `agent.chat.open()` call: no chat UI of its own | `bring-your-chatbot/` |

## APIs Covered

- `window.ai.createTextSession()` - LLM sessions
- `window.agent.requestPermissions()` - Permission management
- `window.agent.tools.list()` - List MCP tools
- `window.agent.tools.call()` - Call MCP tools
- `window.agent.run()` - Autonomous agent tasks
- `window.agent.browser.activeTab.readability()` - Read page content
- `window.agent.capabilities()` - Query available capabilities
