---
name: orchestrate
description: Plan and build a claimed Harbor task in thin end-to-end units. Route mechanical work to smaller workers, keep design and contract decisions with the coordinator, capture red before green, integrate verified work. Works serially when delegation is unavailable.
---

# Orchestrate

Rules: [the workflow](../../../docs/agent-workflow.md). Worker briefs: [roles](../../roles/README.md). This skill requires a start ledger and a live claim.

## Plan

Read the routed docs and the actual code. Write the smallest complete path to acceptance, with a named consumer and no speculative foundation.

- One coherent unit stays inline.
- Split only at real boundaries (bridge, Harbor extension, Web Agents API extension, demos, docs). Record each unit's outcome, files, dependencies and owner.
- Create child HBR issues only for units that are handed off independently.
- Open product, API or permission-model questions go to the maintainer now.

## Dispatch

Match the role to the work:

| Role | Work |
| --- | --- |
| scout | reconnaissance |
| planner | uncertain decomposition |
| mechanical-builder | decided edits |
| builder | design-sensitive work |
| finder | one review angle |
| verifier | adversarial acceptance |

- Announce the actual role and model. Without spawning, run the passes serially and say so.
- Spawn the `harbor-*` presets, never a built-in general-purpose agent. Pass no model override: the preset's model is the budget ([harness bindings](../../../docs/harness-agents.md)). Raising one is the maintainer's call.

Every brief carries:

- the HBR unit and its parent;
- the outcome and non-goals;
- settled decisions and routed docs;
- the invariants;
- repo, absolute worktree, branch and base;
- exclusive files;
- ports, Firefox profile, and whether the worker may touch the shared bridge registration;
- the acceptance source and the red test;
- the checks, and the evidence path (`~/.harbor-dev/evidence/HBR-<n>/`);
- stop conditions;
- the expected report: SHA, dirty state, receipts, limits.

Workers are leaves: no fan-out, product decisions, PRs, merges or tracker edits. Each writer gets its own initialized worktree off the integration branch. Serialize shared files, the bridge registration and the shared ports, and bound concurrency to the machine. An in-flight worker is stopped only by the maintainer's decision or an accepted checkpoint, not by a hunch.

## Build

1. **Red, recorded.** Write the failing test at the real boundary and commit it, or paste its failing output into the ledger. Use cargo tests for the bridge, vitest for either extension, and `tests/e2e` for page injection. Where no harness reaches the behavior, record a scripted reproduction. For docs-only work, use content and link checks.
2. **Implement** only the ledger. Mechanical workers escalate any undecided API, permission, messaging or UX choice. Keep both chat POC copies in step, or record why not.
3. **Verify** against acceptance, preferably with an independent verifier that reruns the checks and reads the code. Inspect visible behavior in Firefox, with both extensions and the bridge loaded. Don't weaken assertions.
4. **Gate** each unit READY / BOUNCE / RE-APPROACH. Bugs go back to the builder. Out-of-scope improvements are reported, not added. Apply the workflow's size rule when a threshold is crossed.
5. **Fold** READY units into the integration branch. Review every delegated diff, and reverify shared paths. Remove only clean, integrated worker worktrees.

Keep the ledger current: unit → SHA → evidence → disposition. Continue into **finalize** over the whole change without re-asking. Never invoke merge.
