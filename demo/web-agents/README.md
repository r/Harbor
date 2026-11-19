# Web Agents Demos

Basic Web Agent API demos for LLM and MCP server access.

## Demos

| Demo | Description | Path |
|------|-------------|------|
| **Getting Started** | Interactive walkthrough of the Web Agent API basics | `getting-started/` |
| **Page Summarizer** | Simple page summarization using `window.ai.createTextSession()` | `summarizer/` |
| **Chrome Compat Demo** | Demonstrates Chrome Prompt API compatibility | `summarizer/chrome-compat.html` |
| **Time Agent** | Simple MCP time tool demo | `time-agent/` |
| **Bring Your Own Chatbot** | A shop page that opens your agent's chat with one `agent.chat.open()` call: no chat UI of its own | `bring-your-chatbot/` |

## APIs Covered

- `window.ai.createTextSession()` - LLM sessions
- `window.agent.requestPermissions()` - Permission management
- `window.agent.tools.list()` - List MCP tools
- `window.agent.run()` - Autonomous agent tasks
- `window.agent.chat.open()` - Open your agent's chat on a page
