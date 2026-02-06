# Prompt: Rewrite Mozilla Intelligence for External Audience

**Use this prompt with Claude.** Paste the prompt below, then paste the full "DRAFT: Mozilla Intelligence" document (Executive Summary through Error Handling). Ask Claude to produce a new document suitable for the same audience as the Harbor GitHub Pages site.

---

## Instructions for the model

You are rewriting an **internal/executive** Mozilla document ("Mozilla Intelligence") into a version suitable for an **external, public audience** — the same audience that reads the Harbor project’s GitHub Pages content: developers (web and AI tools), product thinkers, and people who care about user-controlled AI and might build on or adopt this approach.

**Source document:** A long-form draft that mixes executive summary, strategy ("Mozilla's right to play"), technical specification (Web Agent API, MCP, permissions), and implementation detail. It is written for internal stakeholders and partners.

**Target:** A single, coherent document that could sit on that same GitHub Pages site (e.g. alongside or instead of the current whitepaper). It should feel like one piece with the existing public content: inviting, clear, and useful for people who want to understand the vision, the technical foundation, and how they could participate — without internal strategy or positioning language.

**Reference voice and structure:** The existing Harbor whitepaper (`whitepaper/index.md`) and spec overview (`spec/README.md`) are the tone to match:
- **Tone:** Direct, concrete, lowercase where it fits ("your AI", "context is all you need"). Proposal, not product. "We're figuring this out" / "thought partners" / invitation to feedback.
- **Structure:** Lead with the problem and the idea (context as a resource, bring your own AI), then how it works (browser, MCP, Web Agent API in plain language), then technical detail only as much as an external developer or implementer needs (API surface, permissions, discovery). End with what people could build and an explicit invitation (feedback, what’s missing, what would you build).
- **Length:** Substantially shorter than the source. Preserve the technical substance that external readers need (Web Agent API, MCP, permission model, key APIs and scopes). Condense or drop: lengthy executive framing, "right to play," revenue/strategy, Chrome-compatibility tables (keep one short compatibility note), exhaustive error-code tables (summarize or link to spec), and repeated restatements of the same idea.

**What to do:**
1. **Keep:** The core argument (context scattered → browser mediates context and AI → your AI, your context, your preferences; MCP as foundation; Web Agent API as the standard; permission model and origin isolation). The developer-facing value (news archive, e-commerce tools, SaaS without inference, BYOC). The permission scopes and grant types in a compact form. The fact that Harbor is a sketch/implementation and that the goal is a standard, not a Firefox-only feature.
2. **Reframe or soften:** "Mozilla Intelligence" can stay as the name for the initiative, but de-emphasize Mozilla-specific strategy. Present "why the browser" and "why Mozilla" as a short, factual "why we're doing this" — not as competitive positioning. Enterprise policy control can stay as one paragraph; keep it factual.
3. **Drop or summarize:** Long tables of API methods (keep a minimal "what the API offers" overview; point to the full spec for reference). Full error-code table (one sentence plus link to spec). Redundant paragraphs that restate the same point in different sections.
4. **Add or ensure:** A clear "what you could build" section with concrete examples (aligned with the existing whitepaper’s list if possible). A closing "invitation" section: who we want feedback from (builders, security/privacy folks, standards people), how to get started (Harbor, spec, BUILDING_ON_WEB_AGENTS_API), and that we’re not trying to own this — we’re trying to figure out what AI on the user’s side looks like.
5. **Format:** Publishable markdown: clear headings, short paragraphs, bullet lists where they help. Code or API snippets only where they illustrate the idea (e.g. one `window.ai` and one `window.agent` example, one `<link rel="mcp-server">` example). No need for "Executive Summary" as a heading — the first section can just be the vision in 1–2 short paragraphs.

**Output:** Produce the new document in full. It should be self-contained and ready for external readers; they should not need the internal draft to understand it. At the end, you may add a one-paragraph "Note to editor" listing any substantive decisions you made (e.g. what you cut or merged) so the author can review.

---

*After you run this prompt with the Mozilla Intelligence draft, you can replace or add to the content in `whitepaper/` (e.g. `whitepaper/index.md` or a new page) so the public site reflects the external version.*
