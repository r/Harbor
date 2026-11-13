# Web Agent API Demos

Example code showing how web pages can use the **Web Agent API** (`window.ai` and `window.agent`) to interact with AI models and MCP tools.

These demos require **Harbor**, an implementation of the Web Agent API.

## Live Demo

These demos are published via GitHub Pages at: **https://[your-org].github.io/harbor/demo/**

## Available Demos

| Demo | Description | Path |
|------|-------------|------|
| **Demo Index** | Index page linking to all demos | `/demo/index.html` |
| **Getting Started** | Interactive walkthrough of the Web Agent API | `/demo/web-agents/getting-started/` |
| **Chat Demo** | Full-featured chat with MCP tools | `/demo/web-agents/chat-poc/` |
| **AAF Invoice** | Fill and review an invoice using the visitor’s Harbor-selected AI | `/demo/web-agents/aaf-invoice/` |
| **Page Summarizer** | Simple one-click page summarization | `/demo/web-agents/summarizer/` |
| **Email Chat** | Chat with your email using Gmail MCP tools | `/demo/web-agents/email-chat/` |
| **Time Agent** | Simple MCP time tool demo | `/demo/web-agents/time-agent/` |
| **Page Chat Bookmarklet** | Bookmarklet to chat about any page | `/demo/web-agents/bookmarklet/` |
| **Bring Your Own Chatbot** | Website-provided MCP servers demo | `/demo/web-agents/bring-your-chatbot/` |
| **Basic Actions** | Practice click, fill, and select | `/demo/web-agent-control/basic-actions/` |
| **Multi-step Form** | Form validation and step navigation | `/demo/web-agent-control/multi-step-form/` |
| **Research Agent** | Multi-tab search and synthesis | `/demo/web-agent-control/research-agent/` |
| **Research Pipeline** | Multi-agent collaboration demo | `/demo/multi-web-agent/research-writer/` |

## Quick Start

1. **Build and install the Harbor extension** (see main README)

2. **Install dependencies and start the server**:
   ```bash
   cd demo
   npm install
   npm start
   ```

3. **Open a demo in your browser**:
   - Demo Index: `http://localhost:8000`
   - Getting Started: `http://localhost:8000/web-agents/getting-started/`
   - Chat Demo: `http://localhost:8000/web-agents/chat-poc/`
   - Page Summarizer: `http://localhost:8000/web-agents/summarizer/`
   - Email Chat: `http://localhost:8000/web-agents/email-chat/`

4. **Grant Permissions**:
   - The demo will request Web Agent API permissions
   - Select the permissions you want to grant
   - Harbor will show a permission prompt

5. **Start chatting**:
   - Type a message and hit Enter
   - Enable "Tools" to let the AI use MCP tools
   - Enable "Active Tab" to give context from the current tab

## Launching from Extension

You can also launch the demos directly from the Harbor extension sidebar:
- Click **"API Demo"** to open the chat-poc demo

## Features Demonstrated

- **Permission Request Flow**: Shows how to request and handle permissions
- **Text Generation**: Basic prompt → response using `window.ai`
- **Agent Tasks**: Run autonomous tasks with tool access using `window.agent.run()`
- **Tool Listing**: View available MCP tools
- **Streaming Responses**: Token-by-token output display
- **Tool Call Visualization**: See tool calls and results in collapsible panels

## Bring Your Own Chatbot Demo

The "Bring Your Own Chatbot" (BYOC) demo shows how websites integrate with the user's own AI chatbot:

1. **Website-Provided Tools**: Instead of websites embedding their own AI, they provide MCP servers that the user's chatbot can access
2. **User Control**: The user's own chatbot (with their preferences, history, and privacy settings) handles the AI interactions
3. **Permission Flow**: Users explicitly grant permission for websites to register MCP servers
4. **Graceful Degradation**: Works without the Web Agent API by falling back to a simulated mode

`agent.mcp.register()`, `agent.mcp.unregister()`, `agent.mcp.discover()`, and `agent.chat.{canOpen, open, close}` are implemented in the Web Agents API extension. See [`web-agents/bring-your-chatbot/README.md`](web-agents/bring-your-chatbot/README.md) for the full demo and `docs/WEB_AGENTS_API.md` for the API reference.

## Email Chat Demo

The Email Chat demo shows how to build an application that interacts with Gmail via MCP tools:

1. **Setup Wizard**: Steps through API detection, permissions, LLM check, and tool discovery
2. **Email Tools Detection**: Automatically finds Gmail/email-related MCP tools
3. **Chat Interface**: Natural language interface for email tasks

**Requirements**: To use email features, you need a Gmail MCP server running. The demo will still work without one but will show a warning.

**Example prompts**:
- "Summarize my unread emails from today"
- "Find emails from my manager this week"
- "Draft a reply to my most recent email"

## API Usage Examples

### Basic Text Session

```javascript
const session = await window.ai.createTextSession();
const response = await session.prompt('Hello!');
console.log(response);
```

### Agent with Tools

`agent.run()` requires the `toolCalling` feature flag in the Web Agents API sidebar. It yields **typed events** (not raw tokens):

```javascript
for await (const event of window.agent.run({
  task: 'Search for recent news about AI',
  maxToolCalls: 5,
})) {
  if (event.type === 'thinking')    console.log('thinking:', event.content);
  if (event.type === 'tool_call')   console.log('calling:', event.tool, event.args);
  if (event.type === 'tool_result') console.log('result:', event.tool, event.result);
  if (event.type === 'final')       console.log('answer:', event.output);
}
```

### Streaming Text

`session.promptStreaming()` yields **plain string chunks** (Chrome Prompt API compatible):

```javascript
const session = await window.ai.createTextSession();
for await (const chunk of session.promptStreaming('Tell me a story')) {
  process.stdout.write(chunk);
}
session.destroy();
```

### Read Active Tab

```javascript
const tab = await window.agent.browser.activeTab.readability();
console.log(tab.title, tab.textContent);
```

## Troubleshooting

**"Web Agent API not detected"**
- Make sure Harbor (or another Web Agent API implementation) is installed
- Reload the page after installing the extension
- Check `about:debugging` to verify the extension is loaded

**Permission denied**
- You may have previously denied permissions for this origin
- Check the extension settings to reset permissions

**No tools available**
- Make sure MCP servers are connected in the Harbor sidebar
- Start servers in the sidebar before using tools

