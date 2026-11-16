# Web Agent Control Demos

Self-contained demos that exercise active-tab interaction APIs. Each step increases complexity and uses the same-tab security model.

## Demos

- **Basic Actions** (`basic-actions/`) — Click, fill, and select on a simple form.
- **Multi-step Form** (`multi-step-form/`) — Validation + delayed transitions with `waitForSelector`.
- **Research Agent** (`research-agent/`) — Search the web (falling back to Wikipedia search), fetch the result pages with `agent.browser.fetch`, and synthesize with AI.

## APIs Covered

### Active Tab (same-page)
- `agent.browser.activeTab.click(selector)`
- `agent.browser.activeTab.fill(selector, value)`
- `agent.browser.activeTab.select(selector, value)`
- `agent.browser.activeTab.scroll(options)`
- `agent.browser.activeTab.waitForSelector(selector)`

### Tab Management (multi-tab)
- `agent.browser.tabs.create({ url, active })` — Create new tabs
- `agent.browser.tabs.list()` — List all tabs
- `agent.browser.tabs.close(tabId)` — Close a spawned tab
- `agent.browser.tab.readability(tabId)` — Extract content from a spawned tab (only while it shows a page on your own origin)
- `agent.browser.tab.waitForLoad(tabId)` — Wait for a spawned tab to finish loading

## Permissions & Flags

- `browser:activeTab.interact` — Required for click/fill/select/scroll.
- `browser:activeTab.read` — Required for `waitForSelector` and `readability` on active tab.
- `browser:tabs.create` — Required for creating and controlling spawned tabs.
- `browser:tabs.read` — Required for listing tabs.
- Feature flag: "Browser Interaction" must be enabled for active-tab interactions.
- Feature flag: "Browser Control" must be enabled for tab management APIs.
