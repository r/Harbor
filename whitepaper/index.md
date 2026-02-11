# Your AI

**a proposal for AI that's on your side**

---

## see it in action

**[Download whitepaper (PDF)]({{ site.baseurl }}/whitepaper.pdf)** — the full proposal in one document.

**[Watch the video](https://youtu.be/9B_c8Ji4yGA)** — a walkthrough of Harbor and the Web Agents API: LLM choice, MCP servers, demos (page summarizer, research agent, multi-agent, bring-your-own chatbot).

<div style="position: relative; padding-bottom: 56.25%; height: 0; overflow: hidden; max-width: 100%; margin: 1em 0;">
  <iframe src="https://www.youtube.com/embed/9B_c8Ji4yGA" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: 0;" allowfullscreen title="Harbor &amp; Web Agents API walkthrough"></iframe>
</div>

**[Join the conversation on LinkedIn](https://www.linkedin.com/posts/rkrikorian_the-deal-we-have-with-ai-is-broken-lets-activity-7425217144180592641-5I8M?utm_source=share&utm_medium=member_desktop&rcm=ACoAAAAAC-wBZLgQviFdQYr6XGU7Tq7V9hOsR2A)** — *"the deal we have with AI is broken. let's fix it."* — share feedback, tell us what's wrong, or what you'd build.

---

## context is all you need

whoever holds your context has leverage over you.

your conversations. your preferences. your history. your documents. your credentials. the AI that knows you can help you. the AI that doesn't know you has to start from scratch every time.

right now, your context is scattered across platforms. your conversation history lives in ChatGPT. your preferences live in Claude. your documents live in Google. your calendar lives in Outlook. nothing connects. and each platform holds its piece of you.

when you switch from one AI to another, you leave empty-handed. you're not bringing your context with you — you're starting over. you're renting your ability to reason, and the landlord keeps the furniture when you move out.

this isn't inevitable. it's an architectural choice.

---

## architecture is the choice

today's architecture: platforms hold context. users rent access.

websites embed AI. the website chooses the model. the website sees your queries. the website holds your conversation history. you use what you're given.

this architecture has consequences. you can't bring your own AI to a website. you can't take your context with you when you leave. you can't see what data flows where. the platform has leverage. you don't.

but architecture is a choice. we could choose differently.

---

## the proposal

we propose an architecture where context stays with you.

**LLMs, credentials, and tools terminate in the browser.**

your model connections. your API keys. your tool integrations (via protocols like MCP). these live in the browser — not scattered across websites. you pick the model. you pick the provider. you can switch anytime. you can run locally if you want.

websites don't embed AI. they request capabilities from the AI you've already configured.

**context stays in the browser.**

your accumulated context — conversation history, preferences, identity — stays with you. websites can request access with your consent. but the context is yours. it travels with you. switching providers doesn't mean starting over.

**an API layer lets developers build on top.**

websites expose domain expertise — tools, data, functionality. your AI connects to those tools. the website gets powerful capabilities without building AI infrastructure. you keep control.

developers choose everything. choose the LLM — Ollama, llamafile, GPT, Claude, Gemini, whatever the user has configured. choose which MCP servers to integrate — search, files, databases, or custom ones. choose what tools the page itself provides via [WebMCP](https://github.com/webmachinelearning/webmcp). the API gives building blocks, not opinions.

a news site exposes its 20-year archive. your AI searches it. the publisher pays nothing for inference.

an e-commerce site exposes product search. your AI brings your context ("I own a MacBook Pro M3") and finds compatible accessories.

a SaaS app exposes workflow tools. your AI automates tasks using your credentials, your preferences, your history.

the browser mediates. you decide what flows where.

---

## one sketch: Harbor + Web Agent API

to test whether this architecture works, we built a sketch. two browser extensions:

**Harbor** terminates LLM connections, credentials, and MCP servers in the browser. it's where your AI lives.

**Web Agent API** exposes capabilities to websites. it's how developers build on top.

this isn't a product. it's something concrete to point at. it's easier to talk about "should context sharing work this way?" when you can look at code.

what the sketch demonstrates:

- websites declare tools; users discover and connect to them
- users bring their own AI provider to any website
- permissions are scoped, granted, and revoked per-origin
- context is mediated by the browser
- this is practically viable

---

### how it works

**you configure your browser.**

you add the LLMs you want to use — Claude, GPT, Gemini, a local model. you add your API keys. you add credentials for services you use (Gmail, calendar, etc). you connect MCP servers that give your AI access to context — your files, your email, your tools.

this configuration lives in the browser. it travels with you across websites.

**websites can expose their own tools.**

when you visit a site, your browser detects if the site offers MCP servers:

```html
<link rel="mcp-server" 
      href="https://news.example/mcp" 
      title="Archive Search">
```

a news site might expose its archive. a shopping site might expose product search. a SaaS app might expose workflow automation. you choose which to connect.

**the API exposes capabilities.**

websites can request AI capabilities through a browser API:

```javascript
// text generation — choose a provider, or use the user's default
const response = await window.ai.prompt("summarize this article");

// autonomous tasks with tools — choose which tools to use
for await (const event of window.agent.run({
  task: 'find coverage of the 2008 financial crisis'
})) {
  if (event.type === 'tool_call') console.log('using:', event.tool);
  if (event.type === 'final') console.log('result:', event.output);
}
```

**websites can provide their own tools.**

the [W3C WebMCP proposal](https://github.com/webmachinelearning/webmcp) defines `navigator.modelContext` — a standard way for pages to register JavaScript functions as tools that AI agents can call. Harbor implements this today:

```javascript
// expose page functionality to the AI (WebMCP)
navigator.modelContext.addTool({
  name: 'search_archive',
  description: 'Search the 20-year news archive',
  handler: async ({ query }) => searchArchive(query),
});
```

the developer chooses what tools to expose. the user's AI calls them. no server needed — the code runs right in the page.

**permissions mediate access.**

just like camera and location access, AI capabilities require permission:

| scope | what it allows |
|-------|----------------|
| `model:prompt` | text generation |
| `model:tools` | tool-calling |
| `mcp:tools.call` | execute specific tools |
| `browser:activeTab.read` | read page content |

permissions are per-origin. revocable. auditable. you stay in control.

---

## the standards are converging

this isn't just our idea. there's a real standards effort forming around it.

**[WebMCP](https://github.com/webmachinelearning/webmcp)** is a proposal incubating at the [W3C Web Machine Learning Community Group](https://www.w3.org/community/webmachinelearning/). it defines `navigator.modelContext` — a standard JavaScript API for web pages to register tools that AI agents can call. the proposal was published in August 2025 by engineers at Google and Microsoft. Harbor implements `navigator.modelContext` today.

**[MCP (Model Context Protocol)](https://modelcontextprotocol.io/)** is the open protocol for connecting AI to tools. Harbor connects to any MCP server — search, files, databases, GitHub, or custom servers you build yourself. the developer chooses which ones.

**Chrome's Prompt API** proposes built-in `window.ai` for text generation. Harbor's `window.ai` is compatible — same code works with either.

three standards, one architecture: the browser mediates between websites, AI models, and tools. the developer chooses the components. the user stays in control.

---

## what we don't know

this is a proposal, not a finished design.

**session persistence:** should sessions persist across reloads?

**cross-origin context:** should users share context across sites?

**the adoption path:** why would websites expose tools? why would browsers implement this?

**whether this is right:** maybe the browser isn't the right place. maybe the abstractions are wrong. maybe we're solving the wrong problem.

we have hypotheses. we don't have answers.

---

## an invitation

we want thought partners.

**if you build with generative AI tools (Cursor, Claude, Copilot, etc.):** we've put together a [starter guide]({{ site.baseurl }}/docs/BUILDING_ON_WEB_AGENTS_API.md) you can copy into your project so the API, examples, and capabilities are in context. Use it to build on the Web Agents API with your assistant.

**if you build for the web:** what would you build with this? what's missing?

**if you think about security:** what attacks haven't we considered?

**if you think about privacy:** what data flows should we restrict?

**if you think about standards:** is the browser the right layer?

**if you think about incentives:** what's the path to adoption?

we're not trying to own this. we're trying to figure out what AI on your side looks like.

---

## what you could build

with this architecture, websites and users can build things that aren't possible today:

**chat with any page.** a bookmarklet that injects a chat sidebar into any website. ask questions about the content. summarize articles. extract key points. your AI, your model, on their content.

**email without an email AI.** a simple web app that connects to your email via MCP tools. search your inbox. draft replies. summarize threads. the app provides the interface; you provide the AI and credentials.

**research that spans tabs.** an agent that searches google, opens multiple results, reads each page, and synthesizes findings into a report. multi-tab coordination, powered by your browser.

**forms that fill themselves.** give an agent a task ("book a flight to NYC next tuesday") and watch it navigate forms, fill fields, click buttons. you stay in control; it handles the tedium.

**websites that don't need AI infrastructure.** a news site exposes its archive as MCP tools. readers bring their own AI to search and analyze 20 years of coverage. the publisher pays nothing for inference.

**multi-agent pipelines.** four agents collaborate: one orchestrates, one searches, one reads, one writes. they coordinate through the browser, not through a platform.

these aren't hypotheticals. they're [working demos](demo/).

---

*context is all you need. let's make sure it stays yours.*
