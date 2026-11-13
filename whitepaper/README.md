# Harbor public site (`whitepaper/`)

This directory is the source for the Harbor public site, served via GitHub Pages.

It is a **static HTML site** as of May 2026 — the previous Jekyll setup was retired
when the site was redesigned. `.nojekyll` is present so GitHub Pages serves the
files exactly as they sit here.

The proposal draft number identifies an edition of the public site. The Web Agent API specification and browser extensions have their own versions.

## Files

| File | Purpose |
|---|---|
| `index.html` | Home page — bring your own AI, manifesto, proposal, API examples, short comparison, architecture, security and invitation. |
| `landscape.html` | Long-form essay: "the 2026 landscape, in four shapes." Linked from the home page and the nav. |
| `spec.html` | Web Agent API spec page — high-level overview, API surface, permission scopes, threat-model paragraph, with deep-link to the full explainer in the repo. |
| `build.html` | Quickstart for developers: install, hello-AI, run-an-agent, expose page tools, links to the deep developer docs. |
| `styles.css` | Shared design system — type tokens, color tokens, components. Light by default; `.dark` on `<html>` for dark mode. |
| `DESIGN_NOTES.md` | Type / color / spacing rationale and component decisions. Read this before iterating on the design. |
| `CLAUDE_DESIGN_PROMPT.md` | The brief that was fed into Claude Design to produce the redesign. Kept for reference. |
| `PROMPT_FOR_EXTERNAL_MOZILLA_INTELLIGENCE.md` | Older prompt artifact (predates the May 2026 redesign). Kept for history. |
| `whitepaper.pdf` | The original whitepaper PDF, still linked from the footer. |
| `design-bundle/` | Paper trail of the Claude Design handoff — the chat transcript and the bundle's README. |

## Editing

The site is hand-written HTML. Content changes happen directly in the `.html`
files. Style changes happen in `styles.css`.

The canonical source for **messaging** (positioning, talking points, the
differentiation argument) is **[`docs/POSITIONING.md`](../docs/POSITIONING.md)**.
If you change Harbor's framing on the site, change it there first so the website,
the spec, the README, and any decks stay in sync.

## Local preview

This is plain static HTML — open `index.html` directly in a browser, or run any
static server in this directory:

```bash
cd whitepaper
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Deploy

GitHub Pages serves `whitepaper/` (configured in repo settings → Pages). Push to
`main`; the live site updates within a minute or two.
