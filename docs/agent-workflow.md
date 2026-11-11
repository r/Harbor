# Agentic coding workflow

**start → orchestrate → finalize → human-approved merge.** These are procedures, not agents. They work in one terminal or with parallel workers. Finalize stops at a PR; only the maintainer authorizes a merge. **pre-close** is termination cleanup, and it runs only when the user asks to end the session.

| Skill | Outcome |
| --- | --- |
| [start](../.agents/skills/start/SKILL.md) | One ready HBR issue, a recorded claim, an isolated worktree, a scope ledger |
| [orchestrate](../.agents/skills/orchestrate/SKILL.md) | Thin units built red→green and integrated on the feature branch |
| [finalize](../.agents/skills/finalize/SKILL.md) | A reviewed, verified change with exact-head evidence and a PR awaiting the maintainer |
| [merge](../.agents/skills/merge/SKILL.md) | The approved PR landed and reconciled |
| [pre-close](../.agents/skills/pre-close/SKILL.md) | Work preserved, claims released, owned resources stopped |

The rules are stated here once, and the skills point back to them. Worker roles are in [roles](../.agents/roles/README.md), and their harness bindings are in [harness-agents](harness-agents.md). Human-facing contribution rules are in [CONTRIBUTING](../CONTRIBUTING.md). This workflow follows them.

"The maintainer" means Harbor's current lead maintainer.

## Portable execution

Use a skill by name if your harness discovers it. Otherwise read its `SKILL.md`. No particular vendor, model, MCP server, hook or background-task API is required. Without workers, run the same passes serially and call the review a self-review. Tooling changes the mechanism, never the evidence bar.

Linear is team **Harbor / HBR**, in an internal workspace. Read summaries first, and read full issues only for the few you might take. Paginate before claiming you saw a whole queue. If Linear is down, prepare locally and say that no remote claim exists.

**Without Linear access** (outside contributors and their agents): skip the claim and the Linear steps. Use a GitHub issue, or the PR description, as the ledger. Everything else applies.

## Ownership

The states mean exactly this:

| State | Meaning |
| --- | --- |
| **Todo / Backlog** | Nobody holds it. Backlog also records blocked or deferred work, with its remaining condition. |
| **In Progress** | A live session is working on it right now. |
| **In Review** | A PR is up and waiting for the maintainer. The coordinator still owns it. |
| **Done** | The required outcome is merged to `main` and evidenced. If the change touches the GitHub Pages site, the deploy has also succeeded. |

A **claim** is a Linear comment in this exact shape. Post it immediately before work begins, after a fresh reread of the status:

```text
claim <harness>/<session-id> <ISO-8601 time> <absolute worktree> <branch>
```

`<session-id>` is the most specific live ID that the harness gives one agent. In Rex that is the session plus the pane, `rex:<REX_SESSION uuid>/<REX_BLOCK uuid>`. Every pane in a Rex session shares the session ID, so a claim that names only the session can't tell agents in neighbouring panes apart.

The newest claim comment is the owner. Competing ownership means stop and ask. A claim with no commit or comment for 24 hours is abandoned: post a new claim noting the takeover, and continue from the preserved branch. Under 24 hours, it's a question for the maintainer, not permission.

An In Review ticket with a live coordinator can't be resumed by another session. A Backlog ticket with a ready PR can: resume that branch and PR, never rebuild them. At every pause, handoff or end, set your ticket to the state that's true.

Reconcile only this session's claims, unless the maintainer asks for board-wide cleanup.

## The Harbor bar

This workflow sits under [AGENTS.md](../AGENTS.md), [ARCHITECTURE.md](../ARCHITECTURE.md) and the area docs. Route reading by area:

| Change area | Read |
| --- | --- |
| Any change | `AGENTS.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md` |
| Page-facing API (`window.ai`, `window.agent`, `navigator.modelContext`) | `docs/WEB_AGENTS_API.md`, `docs/HARBOR_WEB_API_EXPLAINER.md`, `spec/` |
| Permissions and policy | `docs/PERMISSIONS.md`, `spec/security-privacy.md` |
| Native bridge, LLM providers | `bridge-rs/`, `docs/DEVELOPER_GUIDE.md` |
| MCP host and servers | `docs/MCP_HOST.md`, `docs/MCP_MANIFEST_SPEC.md`, `docs/MCP_WASM_MANIFEST_SPEC.md`, `docs/JS_MCP_SERVER_SPEC.md` |
| Sessions | `docs/SESSIONS_GUIDE.md` |
| OAuth and secrets | `docs/OAUTH_GUIDE.md`, `docs/NON_OAUTH_SECRETS_AND_LOGIN_PLAN.md` |
| External framing, the site | `docs/POSITIONING.md` first, then `whitepaper/` |
| Demos | `demo/README.md` (there are two chat POC copies; change both or say why not) |
| Testing harness for third-party apps | `spec/testing/`, `docs/TESTING_YOUR_APP.md` |

`bridge-rs/any-llm-rust` is a submodule of `r/any-llm-rust`. A change there goes to that repo first, then the submodule is bumped here.

Every worker brief carries the invariants:

- Firefox is the primary target. Behavior is verified with both extensions loaded.
- Every page-facing capability is gated by a permission scope. No change widens what a page can do outside the permission model.
- Messages that cross a trust boundary (page ↔ extension, extension ↔ extension, extension ↔ bridge) are validated by the receiver.
- User data goes only to the provider the user configured.
- External framing follows `docs/POSITIONING.md`.
- Public artifacts stand alone (see below).
- Scope grows only by the maintainer's call.

## Public repo, internal tracker

The repo is public, and Linear is internal. So:

- PR descriptions, commit messages, code comments and docs make sense without a ticket. Follow [CONTRIBUTING](../CONTRIBUTING.md#writing-the-description).
- Ticket IDs go in the PR body (`Fixes HBR-123`), not the title. When mentioning another ticket, describe it in a few words.
- Security details from internal tickets never go into public artifacts before the maintainer says they're disclosed. A security fix's PR describes the change at the class-of-problem level.
- The ledger and its evidence stay in Linear and `~/.harbor-dev/evidence/HBR-<n>/`. No tokens, credential URLs or personal data in a ticket, and never in a public artifact.

## Evidence

**Red first, and keep it.** New behavior starts with a failing test at the real boundary: a Rust unit test in `bridge-rs`, a vitest test in `extension` or `web-agents-api`, or an e2e browser test in `tests/e2e`. Commit the failing test, or paste its output into the ledger, before implementing. Finalize cites that red instead of reverting to reproduce it. Where no harness exists yet (for example, model behavior through the bridge), record a scripted reproduction and its output. Docs-only work uses link and content checks.

**Review at the depth the change earns.** Blast radius sets the tier:

- *quick*: low-risk docs and config.
- *standard*: ordinary behavior, with one independent finder.
- *deep*: multi-surface changes, or any protected boundary.
- *max*: broad high-risk work.

Permissions and policy, cross-extension or native messaging, the page-facing API surface, and secrets handling are deep at minimum, whatever the diff size. The standard finder's first angle is **correctness**; copy, docs, coverage and cross-file effects come second. Self-review is named as such.

**Coverage is reviewed, not assumed.** Map each required outcome and each changed behavior to a test at the right boundary. Add missing edge, failure and regression cases. Material gaps block readiness unless the maintainer accepts the risk.

**Final gates** for runtime changes, run from the worktree root:

```sh
cargo test --manifest-path bridge-rs/Cargo.toml   # bridge or submodule changes
npm test --prefix extension
npm test --prefix web-agents-api
npm run build                                     # Firefox builds of both extensions
npx tsc --noEmit -p extension
npx tsc --noEmit -p web-agents-api
```

- `main` currently has type errors in both packages. The gate is **no new errors**: compare the error lists at base and head, and record both counts.
- Run `npm run build:chrome` too when a change touches manifests or browser-specific code.
- Run `cd tests/e2e && npm run test:browser` when a change touches page injection.
- Don't use the root `npm run test:unit`. It's broken (HBR-26).
- Docs-only work runs link and content checks.
- A skip or a timeout is not a pass.
- GitHub Actions only deploys the Pages site, so local evidence is the merge gate.

**Rendered checks.** For anything visible in the browser, run Firefox in a fresh temporary profile with both `dist-firefox` add-ons loaded (`extension/` and `web-agents-api/`), the bridge registered, and a local model. Use the demo server for page-level checks (`cd demo && npm start`, on port 8000). Check the sidebar for "Bridge: Connected", exercise the real interaction, and read the browser console. A Chrome or Safari bug needs that browser, or it's reported as unverified.

**Size.** Estimate the unit before coding. At the first full review, record `git diff --shortstat <base>...HEAD` over owned paths. If owned changes pass twice the estimate, or 1.5× that first-review figure, pause and audit: check acceptance, group causes, then keep, defer or discard. Neither baseline moves.

**Durable knowledge.** Finalize updates the area docs for changed behavior, and records verified lessons in the relevant doc or skill, or says none is needed. Chat and PR comments are not the record.

## Shared local resources

Worktrees isolate source, not the machine. These are shared, so serialize them and record use in the ledger:

- **The bridge registration.** Firefox's native messaging manifest (`harbor_bridge.json`) points at one binary path on the machine. To test a worktree's bridge, re-register that worktree's build, record the previous path, and restore it when done.
- **Harbor's data directory**, `~/.harbor/`. Never delete or reset it. If a check needs a clean state, say so and ask.
- **Ports.** 8000 is the demo server, and 11434 is Ollama. Use a different port for a second demo server. Stop only the processes you started.
- **Ollama and its models.** Don't pull or delete models without the maintainer's say.
- **Firefox.** Use a temporary profile per session. Never touch the user's own profile.

## What the maintainer decides

Ask before, not after:

- new product or API scope, or a durable new subsystem;
- any change to the permission model, the trust boundaries, or the page-facing API contract;
- changes to external framing (`docs/POSITIONING.md`, the site);
- a change to an accepted risk, or a coverage gap left open;
- merging, publishing an extension build, or anything touching an account or external service;
- disclosing a security issue, or contacting anyone outside the repo;
- a human act (a decision, a credential, a store submission).

Everything else inside the claimed scope proceeds without re-asking, across skill boundaries.

## Approval and merge

Approval is one of: the maintainer's GitHub review on the PR, the maintainer's Linear comment naming the PR, or the maintainer's words in the same session that runs merge. Nothing else counts. Approval of one PR does not cover others.

Merge reruns the final gates for the change class on the approved head, in a clean worktree, whatever the ledger says. Squash is the default, with a subject and body written from the final diff. Merging `main` deploys the Pages site when `whitepaper/`, `demo/` or the other paths in `.github/workflows/deploy-pages.yml` change. Watch that run. Nothing else deploys, and publishing an extension build is a separate decision.

## Human-only work

The **Needs human** label means a named human act is required: a decision, a permission, a credential, an external submission. It doesn't mean "difficult" or "idle". Agent pickup skips labeled issues, and any work blocked on them. Ordinary PR approval isn't labeled; merge covers it.

## Ledger

Keep one current ledger in the HBR description, linked from the PR, so a cold session needs nothing else. Evidence files (sanitized logs, screenshots, receipts) live in `~/.harbor-dev/evidence/HBR-<n>/`. The PR carries what a public reader needs. The ledger carries the rest.

```text
HBR / coordinator / claim (harness, session, time, worktree, branch) / base SHA:
required outcomes and exclusions:
maintainer's decisions / open questions / blockers:
units: files, dependencies, owner, disposition:
red: test and where its failing run is recorded:
checks: command / outcome / type-error counts base→head / artifact path:
browser: Firefox build / page / interactions / console / limits:
coverage: outcome → test / gaps:
review: tier and why / independent or self / findings and dispositions:
docs updated / lessons recorded / none needed:
PR / state (In Review, Backlog) / approval source:
shared resources used: bridge registration, ports, PIDs, profiles:
remaining work / next action / owner:
```
