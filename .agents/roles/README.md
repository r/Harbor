# Portable worker roles

These briefs are the source of truth for each worker role. The thin adapters in `.claude/agents/`, `.codex/agents/` and `.pi/agents/` register the roles with a harness, and read the role from here. See [harness bindings](../../docs/harness-agents.md) for names, models and Pi's required extension. Without a worker facility, the coordinator reads the brief and runs the pass serially.

| Role | Capability/cost target | Authority |
| --- | --- | --- |
| [scout](scout.md) | Small and fast; narrow factual reconnaissance | Read-only, no services |
| [planner](planner.md) | Strong reasoning when decomposition is uncertain | Read-only plan proposal |
| [mechanical-builder](mechanical-builder.md) | Smaller capable implementation model | Assigned decided edits and checks only |
| [builder](builder.md) | Strong reasoning for design-sensitive implementation | Assigned unit only |
| [finder](finder.md) | Smaller capable model, one focused review angle | Read-only source inspection |
| [verifier](verifier.md) | Strong reasoning for acceptance and disputed claims | Source read-only; authorized local checks |

## Mapping to a harness

Inspect the harness's actual workers and models before dispatch, and announce the role and model that ran. Smaller capable models take scouting and mechanical execution. Stronger reasoning takes planning, novel behavior and final verification.

Adapters hold only the description, model, tools and the pointer to the brief. Product instructions stay here. Where the harness can't enforce a restriction, the brief states it. "Read-only" means no source edits; builds still write, which is why the verifier has Bash.

- No spawning: run the passes serially.
- No model override: say that the inherited model ran.
- No isolation: serialize.
- Self-review is named as self-review.

## Every brief carries

- the HBR issue and owner, or the GitHub issue for contributors without Linear;
- decisions and non-goals;
- relevant docs and the invariants;
- the absolute repo or worktree, branch and base;
- exclusive files;
- acceptance;
- allowed operations;
- ports, Firefox profile, and whether the worker may touch the shared bridge registration;
- the evidence destination;
- escalation conditions.

All workers read `AGENTS.md`, and the relevant parts of `docs/agent-workflow.md`, in their assigned checkout. Workers are leaves: no further delegation, tracker edits, merges, publishing, or scope expansion.

Return the outcome first, then the exact SHA and dirty state, changed files, check receipts, limitations, and any owned resources still running. Missing evidence is reported, not inferred. The coordinator reviews every diff, and owns Linear, integration, publication and the handoff to the maintainer's merge decision.
