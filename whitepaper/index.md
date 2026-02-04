# Your AI

**a proposal for AI that's on your side**

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

websites declare their tools:

```html
<link rel="mcp-server" 
      href="https://news.example/mcp" 
      title="Archive Search">
```

the API exposes capabilities:

```javascript
// text generation
const session = await window.ai.createTextSession();
const response = await session.prompt("summarize this article");

// tools and autonomous execution
for await (const event of window.agent.run({
  task: 'find coverage of the 2008 financial crisis'
})) {
  if (event.type === 'tool_call') console.log('using:', event.tool);
  if (event.type === 'final') console.log('result:', event.output);
}
```

permissions follow patterns established for cameras and location:

| scope | what it allows |
|-------|----------------|
| `model:prompt` | text generation |
| `model:tools` | tool-calling |
| `mcp:tools.call` | execute specific tools |
| `browser:activeTab.read` | read page content |

permissions are per-origin. revocable. auditable.

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

**if you build for the web:** what would you build with this? what's missing?

**if you think about security:** what attacks haven't we considered?

**if you think about privacy:** what data flows should we restrict?

**if you think about standards:** is the browser the right layer?

**if you think about incentives:** what's the path to adoption?

we're not trying to own this. we're trying to figure out what AI on your side looks like.

[try the sketch →](../QUICKSTART.md) · [join the conversation →](https://github.com/anthropics/anthropic-tools/discussions) · [view the code →](https://github.com/anthropics/anthropic-tools)

---

*context is all you need. let's make sure it stays yours.*
