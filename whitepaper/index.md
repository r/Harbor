# The Web Agent API

**A sketch for user-controlled AI on the web**

---

you're not an owner — you're a renter.

that's the trajectory we're on with AI. renting your ability to reason. and the landlord can change the terms anytime.

today, when you use AI on the web, you use whatever model a website embedded. your preferences reset on every site. your context is scattered and inaccessible. you can't bring your own AI to a website any more than you could bring your own rendering engine.

we don't accept that future. this document is a sketch of a different one — and an invitation to think it through together.

this isn't a product announcement. it's not a finished standard. it's code you can run, questions we haven't answered, and a bet that it's easier to talk about these problems with something concrete in front of us.

---

## what we believe

these aren't aspirations. they're the constraints we design by.

### user agency first

users should control their AI experience. which models they use. which providers they trust. what context they share, and with whom. AI capabilities should be resources users own and lend — not services websites control on their behalf.

for decades, the browser was your representative on the open web. there's a reason it's called a "user agent" — it was on your side. it could block ads. protect your privacy. give you choices the sites never would.

now AI is becoming the new intermediary. call it "layer 8" — the intelligence layer sitting on top of everything. the question is: whose side is your agent on?

### privacy by architecture

the best privacy isn't a setting you toggle. it's infrastructure that makes tracking difficult by design. when AI can run locally, data never leaves the device. when data must flow externally, users should explicitly consent — and understand what they're consenting to.

these systems aren't neutral. they encode values and incentives. values shape the worldview baked into their responses. incentives shape what gets optimized: engagement, cost reduction, controversy avoidance. every answer carries both the choices of the people who built it and the pressures of the system that sustains it.

when validation is purchased rather than earned, we lose something vital. and when that validation comes from a system we don't control, trained on choices we didn't make, we should pause.

### open standards over lock-in

no single company should own this layer.

the LAMP stack didn't win because it was open. it won because it became easier — composable, swappable, forkable — and the economics worked. it let developers build things no platform would have built for them.

we need that for AI. not one stack, but many — shaped by communities and countries and companies. open interfaces. open data with provenance. open models you can tune to your values. plural. accessible. yours.

owners, not renters.

[read our full values statement →](values.md)

---

## the problem

### for users: fragmentation and loss of control

your context is scattered across the internet — emails in Gmail, documents in Drive, purchase history on Amazon, calendar in Outlook. when you want AI to help with any of it, you connect these services to third-party models on terms you don't set.

you don't control which data gets sent. you're stuck with whatever model a website chose. your preferences don't travel with you. when you switch from ChatGPT to Claude, your accumulated context disappears.

you're renting AI infrastructure. the landlord can change the terms anytime.

### for websites: cost and complexity barriers

a news publisher wants to offer deep research across 20 years of archives — but can't absorb inference costs.

an e-commerce site wants personalization based on user context — but doesn't have that context.

a SaaS application wants sophisticated AI features — but doesn't want to become an AI infrastructure company.

each builds the same integrations from scratch. or doesn't build them at all.

### for developers: unnecessary friction

building AI-driven web experiences requires managing model connections, handling authentication, building tool infrastructure, and paying for inference — all before delivering actual value.

this is like requiring every website to ship its own rendering engine. the plumbing should be platform infrastructure.

---

## what we're proposing

### context as a browser-mediated resource

a decade ago, browsers introduced permission prompts for cameras and microphones — sensitive resources websites could request but not access without consent.

we propose extending this model to AI and context.

your AI, your preferences, your accumulated context: these become resources the browser manages on your behalf. websites request access. you grant or deny. the browser enforces your decision.

### bring your own AI

today: websites embed AI, users have no choice.

we propose flipping this.

websites declare their capabilities — tools, data access, domain expertise. users bring their preferred AI — Claude, GPT, local Llama, whatever they've configured. the user's AI gains new capabilities from the website's tools. the website pays nothing for inference.

```html
<!-- a website declares its tools -->
<link rel="mcp-server" 
      href="https://news.example/mcp" 
      title="Archive Search">
```

```javascript
// your AI uses those tools
const results = await window.agent.run({
  task: 'find coverage of the 2008 financial crisis'
});
```

### building on open standards

this proposal builds on the **Model Context Protocol (MCP)**, an open standard that defines how AI systems connect to external tools.

before USB, every peripheral needed its own connector. MCP is USB for AI: standardized tool definitions, structured schemas, discovery mechanisms.

MCP is a starting point, not an endpoint. the architecture separates the browser API surface from the underlying protocol. as standards evolve, implementations adapt.

---

## Harbor: a sketch

to test whether this model actually works, we built **Harbor** — a browser extension that implements what we're calling the Web Agent API.

Harbor isn't a product. it's a sketch — something concrete to talk about. it's easier to have a conversation about "should this permission scope be broader?" when you can point at code than when you're debating hypotheticals.

the bet is on the pattern — browser-mediated AI with user-controlled tool access — not on any particular implementation. Harbor is where we test ideas. the conversation is what matters.

**what Harbor demonstrates:**

- websites can declare MCP servers; users can discover and connect to them
- users can bring their own AI provider to any website
- permissions can be scoped, granted, and revoked per-origin
- tool execution can be allowlisted per-site
- this is practically viable, not just theoretically sound

---

## the Web Agent API

the API defines two JavaScript surfaces:

### `window.ai` — text generation

compatible with Chrome's emerging Prompt API:

```javascript
const session = await window.ai.createTextSession({
  systemPrompt: "you are a research assistant."
});
const response = await session.prompt("summarize this article");
```

### `window.agent` — tools and autonomous execution

```javascript
// discover available tools
const tools = await window.agent.tools.list();

// run an autonomous task
for await (const event of window.agent.run({
  task: 'find recent news about renewable energy',
  maxToolCalls: 10
})) {
  if (event.type === 'token') process.stdout.write(event.token);
  if (event.type === 'tool_call') console.log('using:', event.tool);
  if (event.type === 'final') console.log('done:', event.output);
}
```

### permission model

all operations require explicit user consent, following patterns established for cameras and location:

| scope | what it allows |
|-------|----------------|
| `model:prompt` | basic text generation |
| `model:tools` | AI with tool-calling enabled |
| `mcp:tools.list` | list available tools |
| `mcp:tools.call` | execute specific tools (requires per-tool allowlist) |
| `browser:activeTab.read` | read current page content |

permissions are granted per-origin. access to one site doesn't affect others. users can grant once, always, or deny entirely.

---

## we need your help

this is where you come in.

### use cases we haven't considered

we designed around scenarios we understood: research assistants, page summarization, shopping helpers, SaaS integrations. the web is vast.

- what would you build with this?
- what capabilities are missing?
- what have we not imagined?

### things we're uncertain about

**session persistence:** should AI sessions persist across page reloads? better UX, but privacy implications.

**cross-origin context:** should users share context across sites? powerful, but risky.

**website-provided models:** should sites provide their own models, not just tools? useful, but undermines "bring your own AI."

we don't have answers to these. your input would help.

### security and privacy review

we've thought about security. we're not infallible.

- what attack vectors haven't we considered?
- are there data flows we should restrict further?
- what could a malicious website do that we haven't accounted for?

[see all open questions →](feedback.md)

---

## how to engage

### try it

the best way to understand the proposal is to run the code:

1. [install Harbor](../QUICKSTART.md)
2. run the demos
3. build something
4. tell us what broke

### contribute

- **[GitHub Issues](https://github.com/anthropics/harbor/issues)** — bugs, features, questions
- **[Discussions](https://github.com/anthropics/harbor/discussions)** — use cases, architecture, standards
- **Pull Requests** — fixes, docs, examples

### join the conversation

we're not trying to own this. we're trying to figure out what user-controlled AI on the web should look like.

if you're working on related problems, reach out. if you have concerns, share them. if you think we're solving the wrong problem, tell us.

the rebellion needs builders.

---

## further reading

| document | description |
|----------|-------------|
| [values](values.md) | the principles that guide design decisions |
| [feedback](feedback.md) | specific areas where we need input |
| [full explainer](../spec/explainer.md) | complete spec with Web IDL |
| [security & privacy](../spec/security-privacy.md) | threat model and mitigations |

---

*this is a living document. last updated: January 2026.*

*we kept the web open — not by asking permission, but by building something better. let's do it again.*
