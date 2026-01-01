# Harbor Demos

Example code showing how web pages can use the Harbor JS AI Provider to interact with AI models and MCP tools.

## Available Demos

| Demo | Description | Path |
|------|-------------|------|
| **Main Demo** | Full-featured chat with permissions flow | `/demo/index.html` |
| **Chat POC** | Minimal example code for developers | `/demo/chat-poc/` |

## Quick Start

1. **Build and install the Harbor extension** (see main README)

2. **Start a local server**:
   ```bash
   cd demo
   python3 -m http.server 8000
   ```

3. **Open a demo in your browser**:
   - Main demo: `http://localhost:8000`
   - Chat POC: `http://localhost:8000/chat-poc/`

4. **Connect to Harbor**:
   - Click "Connect to Harbor" 
   - Select the permissions you want to grant
   - The extension will show a permission prompt

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

## API Usage Examples

### Basic Text Session

```javascript
const session = await window.ai.createTextSession();
const response = await session.prompt('Hello!');
console.log(response);
```

### Agent with Tools

```javascript
for await (const event of window.agent.run({
  task: 'Search for recent news about AI',
  maxToolCalls: 5,
})) {
  if (event.type === 'token') {
    console.log(event.token);
  }
}
```

### Read Active Tab

```javascript
const tab = await window.agent.browser.activeTab.readability();
console.log(tab.title, tab.text);
```

## Troubleshooting

**"Extension not detected"**
- Make sure the Harbor extension is installed and enabled
- Reload the page after installing the extension
- Check `about:debugging` to verify the extension is loaded

**Permission denied**
- You may have previously denied permissions for this origin
- Check the extension settings to reset permissions

**No tools available**
- Make sure MCP servers are connected in the Harbor sidebar
- Start servers in the sidebar before using tools

