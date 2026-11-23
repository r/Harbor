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
| **AAF Invoice** | Fill and review an invoice using the visitor’s Harbor-selected AI | `/demo/web-agents/aaf-invoice/` |
| **Page Summarizer** | Simple one-click page summarization | `/demo/web-agents/summarizer/` |
| **Time Agent** | Simple MCP time tool demo | `/demo/web-agents/time-agent/` |
| **Bring Your Own Chatbot** | A shop page that opens Harbor's chat with one `agent.chat.open()` call, no chat UI of its own | `/demo/web-agents/bring-your-chatbot/` |
| **Page Tools** | A page offers its own functions with `document.modelContext.registerTool()`, and your agent (built-in or your own ACP agent) calls them | `/demo/web-agents/page-tools/` |
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
   - Page Summarizer: `http://localhost:8000/web-agents/summarizer/`
   - Bring Your Own Chatbot: `http://localhost:8000/web-agents/bring-your-chatbot/`

4. **Grant Permissions**:
   - The demo will request Web Agent API permissions
   - Select the permissions you want to grant
   - Harbor will show a permission prompt

5. **Chat**: open Bring Your Own Chatbot and click **Chat with Acme Shop**. Harbor opens its chat on the page.

## Features Demonstrated

- **Permission Request Flow**: Shows how to request and handle permissions
- **Text Generation**: Basic prompt → response using `window.ai`
- **Agent Tasks**: Run autonomous tasks with tool access using `window.agent.run()`
- **Tool Listing**: View available MCP tools
- **Streaming Responses**: Token-by-token output (Research Pipeline)
- **Chat Without Building One**: A page hands the conversation to your agent's chat with `window.agent.chat.open()`

## Bring Your Own Chatbot Demo

The "Bring Your Own Chatbot" (BYOC) demo shows a site that doesn't want to build its own chat
UI: it calls `agent.chat.open({ systemPrompt, style })`, and Harbor opens the chat surface on
the page instead, running on the person's own model. The page writes no chat UI of its own.

1. **One call, no chat UI**: The page's only chat-related code is the `agent.chat.open()` call
2. **User Control**: Harbor's chat runs on the person's own model, with their own permissions
3. **Permission Flow**: Harbor asks for `chat:open` when the chat opens, and for `model:prompt` on the first message
4. **Graceful Degradation**: The chat button is hidden, with an explanatory banner, when `agent.chat.open` isn't available

See [`web-agents/bring-your-chatbot/README.md`](web-agents/bring-your-chatbot/README.md) for the full demo and `docs/WEB_AGENTS_API.md` for the API reference.

## API Usage Examples

### Basic Text Session

```javascript
const session = await window.ai.createTextSession();
const response = await session.prompt('Hello!');
console.log(response);
```

### Agent with Tools

`agent.run()` requires the `toolCalling` feature flag in Harbor's sidebar. It yields **typed events** (not raw tokens):

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
console.log(tab.title, tab.text);
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
- On a fresh install, the built-in Time Server starts automatically for the Getting Started checklist.
- Existing saved stop choices are preserved. If you previously stopped Time Server, start it under MCP Servers in the Harbor sidebar.
- The final agent step also needs an available model. Ready Apple Intelligence works automatically; otherwise configure your preferred model using the [Quickstart](../QUICKSTART.md#configure-a-model).

