# Harbor Positioning (2026)

**Status:** Internal reference — drives website copy, talks, and external materials.
**Last updated:** May 2026.

This document captures the current landscape, why Harbor still matters in it, and the language we use to describe the difference. Read it before you write a deck, a blog post, or a landing page about Harbor.

**Where this lives in the wider repo:**

- The **public site** (`whitepaper/index.html`, `landscape.html`, `spec.html`, `build.html`) is the rendered version of the framing on this page. If you change framing here, propagate it there.
- The **README** (`README.md`) and **spec README** (`spec/README.md`) carry the short version of the same argument.
- The **changelog** records when framing meaningfully changes; bump it when the differentiation argument or the comparison table moves.

If you're reaching for the literal copy that ships on the site, read `whitepaper/index.html` directly — it's hand-written HTML, not generated, so the words on the page are the words in the file.

---

## The one-line summary

> Bring your own AI to the web. Take your agent with you as you browse. You decide what it can see, what it can do, and what it shares with each site.

---

## Introducing Harbor on the public site

The homepage is a provocation about who gets to act on the reader’s behalf. The proposed browser capability is permissioned access to the reader’s own AI. A site asks to use it, and the browser brings that request to the reader, as it does for camera or location access. Lead with the reader’s ownership of their agent and make the case before offering setup instructions. Use a concrete example to show what each party controls. A newspaper could expose its archive search to a reader’s chosen model. The archive supplies the search tool, the reader grants access, and the model works with the results. This is an example for builders. For a hands-on introduction today, point readers to the Page Summarizer bookmarklet and explain the developer setup it requires. Keep the detailed market comparison in the landscape essay.

## Where the world is, May 2026

The browser–AI landscape has crystallized into four camps. Harbor is none of them.

### Camp 1 — AI-native browsers (the agent IS the browser)

| Browser | Vendor | Model | Posture |
|---|---|---|---|
| ChatGPT Atlas | OpenAI | GPT‑5 | Most agentic. Agent Mode clicks, fills, books, and shops in a sandboxed Chromium. macOS GA. |
| Comet | Perplexity | Perplexity + partners | Highly agentic personal-assistant browser. Long-running multi-tab automation, email/calendar connectors, e-commerce. |
| Dia | The Browser Company (Atlassian) | Multi-provider | "Chat with your tabs." Skills system. Local-first, intentionally less autonomous. |
| Copilot Mode in Edge | Microsoft | Microsoft Copilot | Cross-tab reasoning + scoped Actions. Conservative; enterprise-friendly. |
| Gemini in Chrome / Auto Browse | Google | Gemini | Rolled out January 2026. Origin-set sandboxing, User Alignment Critic, sensitive-action confirmations. |

**Pattern:** the browser company chooses the model. Your context, your task history, and (for Atlas/Comet) often your page content flow to one vendor. Switching means starting over. The agent reads the live web — which is exactly the surface where indirect prompt injection bites (Comet → 1Password vault, Atlas → omnibox injection, Comet → CometJacking, etc.).

### Camp 2 — Browser AI assistants (sidebar chat, BYO model)

- **Brave Leo (BYOM)** — Stable since 2024. Lets users connect Ollama or remote endpoints. Chat-only; doesn't expose anything to web pages.
- **Mozilla AI Window / AI Controls** — Announced Nov 2025; AI Controls shipped in Firefox 148 (Feb 2026). Multi-provider chat in the sidebar (Claude, ChatGPT, Copilot, Gemini, Mistral). Opt-in. Doesn't expose anything to web pages.

**Pattern:** the user gets choice over their AI assistant, but websites can't program against it. AI is a feature *for the user*, not a *capability of the platform*. Pages still have to ship their own AI infra if they want their app to use AI.

### Camp 3 — The standards converging

- **WebMCP** — W3C Community Group draft, April 2026. `navigator.modelContext.addTool()` lets pages declare JavaScript-backed tools an agent can call. **Solves the page-side half** of the problem.
- **Chrome Prompt API** — `window.LanguageModel`, stable in Chrome 138 extensions, in origin trial for web pages. Gives pages on-device Gemini Nano. **One model, one browser**.
- **Model Context Protocol (MCP)** — Open protocol from Anthropic, now ubiquitous on the backend. Defines how agents talk to tool servers.

**Pattern:** each standard solves *part* of the problem. None of them, individually or together, answers the central question: *how does an arbitrary website call the user's chosen AI, with the user's chosen tools, on whatever browser the user happens to be on, without anyone holding their context hostage?*

### Camp 4 — BYOK in IDEs and dev tools

- **VS Code Language Model Chat Provider** (Oct 2025), **JetBrains BYOK** (Dec 2025), **Vercel AI Gateway BYOK**, **GitHub Copilot SDK BYOK**, **Byoky** (browser-extension key wallet).

**Pattern:** the same idea — let users bring their keys — has won inside developer tools. It hasn't crossed over to the open web. Harbor is the open-web version of this idea.

---

## What's missing

No one is shipping the combination of:

1. **A portable contract** between websites and the user's chosen AI that works across browsers (not just Chrome's Prompt API; not just Firefox AI Window).
2. **A unified permission boundary** that covers LLMs + remote MCP servers + page tools as a coherent whole, scoped per-origin, like `geolocation` or `camera`.
3. **AI as a web platform capability** — a website calls `window.ai.createTextSession()` the same way it calls `fetch()`, without caring which model, key, or browser the user has, and without the website ever touching the credentials.
4. **An architectural answer to the prompt-injection problem**: instead of an agent free-roaming the DOM (Comet, Atlas), websites *delegate* via a scoped API. The user's AI mediates. Permissions throttle each side.
5. **Today's adoption path**: ship now, on Firefox and Chrome, as an extension, while the standards mature. A polyfill, not a vendor.

That combination is Harbor's lane.

---

## How we say the differentiation

Three sentences, in order of importance:

1. **"Today's agentic browsers ask you to pick a vendor; Harbor lets you bring your AI to every website you already use."**
2. **"WebMCP standardizes how pages expose tools. Chrome's Prompt API standardizes one model. Harbor is the missing piece: a browser-mediated contract where any website can use the user's chosen AI, with the user's chosen tools, scoped per origin."**
3. **"It's not a browser. It's a proposal — with a working implementation — for treating AI like `fetch()`: a capability the platform provides, not a product the user has to buy into."**

If we have one minute, we say all three. If we have ten seconds, we say the first.

---

## Differentiation table

This is the table that goes on the website and in decks. Numbers/labels are May 2026.

| | Vendor agent browsers (Atlas, Comet, Gemini in Chrome) | Sidebar AI assistants (Brave Leo, Firefox AI Window) | Chrome Prompt API + WebMCP alone | **Harbor + Web Agent API** |
|---|---|---|---|---|
| Who picks the model | The browser vendor | The user (chat-only) | Chrome (Gemini Nano) | **The user** |
| Who pays for inference | Mixed (vendor often subsidizes) | The user | Free, on-device | **The user — including local & free** |
| Can a website use the AI? | Through the vendor's product, on the vendor's terms | No | Yes, but only on Chrome with Gemini Nano | **Yes, on Firefox and Chrome, with any model the user has configured** |
| Cross-origin tool calls (MCP) | Vendor-curated | None | Not in scope | **Yes — any MCP server the user trusts** |
| Page-declared tools (WebMCP) | Sometimes, vendor-mediated | No | Yes | **Yes — implements `navigator.modelContext` today** |
| Permission boundary | Browser-wide / app-wide | Sidebar opt-in | Per-API, on Chrome | **Per-origin, per-scope, revocable** |
| Prompt-injection surface | Large: agent reads the live DOM autonomously | Small: chat is user-driven | Small: no agent | **Small: websites delegate via scoped APIs; the agent is not free-roaming** |
| Where context lives | With the vendor | With the assistant chat (sometimes synced) | On-device (Gemini Nano cache) | **In the browser, mediated to sites with consent** |
| Works in Firefox? | No | Yes for Mozilla's; partially for others | No | **Yes — primary target** |

---

## What we are not

- **Not a browser.** We don't compete with Firefox, Chrome, Edge, Atlas, Comet, Dia. We run *inside* them.
- **Not an agent.** Harbor does not autonomously browse. It exposes a contract; the page or the user drives.
- **Not a model provider.** We connect to the models you bring (Ollama, llamafile, OpenAI, Anthropic, Gemini, …).
- **Not a Mozilla product.** It's a sketch from people inside Mozilla, but the goal is a standard the whole web can adopt — not a Firefox-only feature.
- **Not a finished design.** It's version 0.1, deliberately. We want feedback before we calcify.

---

## Where Harbor sits relative to the standards

| Layer | Standard | Harbor's stance |
|---|---|---|
| Page declares tools | **WebMCP** (`navigator.modelContext`) — W3C CG, April 2026 | We implement it today; we'd happily yield this surface to the spec. |
| Page calls a model | **Chrome Prompt API** (`window.LanguageModel`) — Chrome 138+ | We implement a compatible `window.ai`; same code runs on either. |
| Cross-origin tools | **MCP** | We host MCP servers (WASM/JS in-browser; native via the Rust bridge); developers pick any servers they want. |
| Browser-mediated agent + permissions | **No standard yet** | This is the gap. Our `window.agent` proposal is what we'd put on the standards track. |

---

## The two-paragraph elevator

> Every website that wants AI features has three bad options today: ask users for API keys, run their own AI backend, or embed someone else's. The new "AI browsers" — Atlas, Comet, Dia, Copilot Mode, Gemini in Chrome — try to solve this from the wrong end: they replace your browser with their agent and route your context to one vendor. Standards like WebMCP and Chrome's Prompt API are real progress, but each solves only a slice.
>
> Harbor proposes a fourth option: AI as a browser capability. The browser holds your model connections, your credentials, and your tools. Websites declare what they need through `window.ai` and `window.agent`. Pages can expose their own functions through WebMCP. Permissions are per-origin and revocable. You bring your AI to the web; the web doesn't drag you into someone else's AI. We've shipped a working implementation — two extensions and a Rust bridge — on Firefox and Chrome to prove it's viable. It's a starting point for a conversation, not a product.

---

## Talking points by audience

### For developers building web apps

- You write `await window.ai.createTextSession()` and the user's model handles it. No keys, no backend, no per-user billing.
- You pick which MCP servers your app integrates. The user approves them. You don't ship credentials.
- One code path works against Chrome's Prompt API (when Gemini Nano is available) and against Harbor (when the user has a different model).
- You expose your domain logic via `navigator.modelContext.addTool()` (the W3C WebMCP API). Any agent — Harbor today, Chrome's tomorrow, Atlas's eventually — can call it.

### For people thinking about security and privacy

- The agent doesn't free-roam the DOM. Websites delegate via a scoped API, which keeps the prompt-injection surface roughly the size of a normal Web API surface — not the size of "the entire web."
- Permissions are per-origin (`example.com` can't act on `other.com`'s credentials), per-scope (`model:prompt` ≠ `mcp:tools.call`), and revocable.
- Local-first is real: Ollama and llamafile mean the data never leaves the machine. Cloud is a choice, not a default.
- Compare to Comet: a calendar invite was enough to exfiltrate a 1Password vault, because the agent had cross-service access and trusted what it read on a page. Our threat model assumes the agent will be tricked, and the architecture limits the blast radius.

### For browser vendors and standards people

- We're not asking Firefox or Chrome to ship Harbor. We're saying: here is a working implementation of what AI as a browser capability could look like, so the standards conversation has something concrete to argue about.
- WebMCP covers one half. Chrome's Prompt API covers another sliver. Harbor is the proposal for the rest, designed to be implementable by browsers natively and forward-compatible with both existing standards.
- Concrete artifacts: the explainer, the security/privacy doc, the WebIDL. Take them, fork them, push back on them.

### For Mozilla / open-source / "user-controlled AI" people

- The "AI Window" approach gives the user choice in the chat sidebar. That's important and good. Harbor extends the same principle to *every website's interaction with AI*, not just the chat.
- The architecture matches Mozilla's stated direction (user choice, openness, not locked in) but answers a question Mozilla hasn't yet: how does the *page* get a model?
- Harbor is not a Mozilla product. It's a way to test whether the architecture works, on Firefox and Chrome, before any browser commits to anything.

---

## Headlines and taglines we like

- **"AI as a browser capability."**
- **"Bring your AI to every site."**
- **"Your model. Your credentials. Your context. Every website."**
- **"The web doesn't have to pick an AI vendor."**
- **"AI on your side."** (carried over from the existing whitepaper)

## Headlines we avoid

- "Harbor is an AI browser." (We're not a browser.)
- "Harbor is a Mozilla product." (It isn't.)
- "Replace ChatGPT/Claude/Gemini with Harbor." (We're not a model.)
- "Harbor is secure because it has fewer features." (We have a positive security story; lead with it.)

---

## Source list (for fact-checking copy)

- WebMCP CG draft (Apr 23, 2026): https://webmachinelearning.github.io/webmcp/
- Chrome Prompt API: https://developer.chrome.com/docs/ai/built-in-apis
- Chrome agentic security architecture (Dec 8, 2025): https://blog.google/security/architecting-security-for-agentic/
- Edge "Considerations for Safe Agentic Browsing" (Oct 23, 2025): https://blogs.windows.com/msedgedev/2025/10/23/considerations-for-safe-agentic-browsing/
- Mozilla AI Window (Nov 13, 2025): https://blog.mozilla.org/en/firefox/ai-window/
- Mozilla AI Controls in Firefox 148 (Feb 2026): https://blog.mozilla.org/firefox/ai-controls/
- Brave Leo BYOM: https://brave.com/blog/byom-nightly
- Trail of Bits Comet audit (Feb 20, 2026): https://blog.trailofbits.com/2026/02/20/using-threat-modeling-and-prompt-injection-to-audit-comet/
- Zenity 1Password / Comet attack: https://labs.zenity.io/p/perplexedbrowser-how-attackers-can-weaponize-comet-to-takeover-your-1password-vault
- Same-origin policy bypass research: https://agent-security.cs.washington.edu/agentic_browsers_sop.html
- BrowseSafe paper (arXiv:2511.20597): https://arxiv.org/html/2511.20597v1
