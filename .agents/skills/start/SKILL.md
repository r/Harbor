---
name: start
description: Resolve and claim one ready Harbor task before building. Check Linear scope, human gates, dependencies, existing PRs and competing claims; isolate a worktree and write the scope ledger. Use for an HBR number, a plain-English build request, or choosing the next task.
---

# Start

Rules: [the workflow](../../../docs/agent-workflow.md). This skill ends with a claimed task, a worktree and a ledger, then continues into **orchestrate**.

1. **Resolve the request.** The team is Harbor / HBR.
   - For a number, read the issue, its comments and its relations.
   - For prose, search, and explain the match.
   - With no task, don't search Linear yourself. Hand candidate discovery to one read-only scout (Claude Code: `harbor-scout`). Brief it to read Linear only and return at most eight Todo/Backlog HBR candidates. For each, it reports the status, labels, blockers and their states, the newest claim comment, and what the ticket blocks. Rank them yourself against step 2, offer a short list and wait. Read the chosen issue in full yourself.
   - Create a ticket only for work the maintainer has authorized. A suggestion is not permission.
   - Without Linear access, use the GitHub issue or the user's request as the scope, and skip steps 2 and 4.
2. **Check readiness.** Candidates are Todo or Backlog, with prerequisites met, no live claim, and no **Needs human** label or unmet human answer. Canceled or Duplicate blockers are not delivered blockers. Say what would make blocked work ready.
3. **Check reality.** Run:

   ```sh
   gh pr list --search 'HBR-<n> in:body' --state all
   git branch -a --list '*hbr-<n>-*' '*hbr-<n>'
   git worktree list | grep -iE 'hbr-<n>([^0-9]|$)'
   git log origin/main --oneline -E -i --grep 'HBR-<n>([^0-9]|$)'
   ```

   Also read the issue's attached PR links. Search matches prefixes (HBR-1 finds HBR-12), so a hit counts only when its number is exactly `<n>`. Read further only on a hit.
   - A Backlog issue with a ready PR is resumed, not rebuilt.
   - An issue that's In Review, or In Progress with a live coordinator, isn't yours.
   - Already-delivered work gets evidence and reconciliation, not a rebuild.

   Stay bounded: nothing is built under an unclaimed task.
4. **Claim.** Reread the status and the newest claim comment. Then post the claim in the [workflow's format](../../../docs/agent-workflow.md#ownership) and move the issue to In Progress. In Rex, the session ID names the pane too: `rex:<REX_SESSION uuid>/<REX_BLOCK uuid>`. Competing ownership means stop. A claim over 24 hours old with no commit or comment is abandoned; take it over with a note.
5. **Isolate.** Never switch the shared root checkout.
   - Fetch, then branch from `origin/main` (or the chosen base), named `<user>/hbr-<n>-<slug>`.
   - Add a worktree at `../harbor-wt/hbr-<n>-<slug>`.
   - Run `git submodule update --init` in it, plus `npm install` in each package you'll build.
   - Record in the ledger the ports and the Firefox profile you'll use, and whether you'll need the [shared bridge registration](../../../docs/agent-workflow.md#shared-local-resources).
   - Use absolute paths in every brief.
   - Title your tab after the task (`hbr-<n>-<slug>`) where the harness allows. In Rex a tab is a window: `rex window rename "$(rex block inspect "$REX_BLOCK" | awk '/^window:/{print $2}')" hbr-<n>-<slug>`. Never rename the Rex session; every tab shares it.
6. **Write the ledger** in the HBR description, using the workflow's template: outcomes, exclusions, base SHA, worktree, acceptance source, expected files and size, and open decisions. Anything on the [maintainer-decides list](../../../docs/agent-workflow.md#what-the-maintainer-decides) goes to the maintainer before coding.
7. **Hand off** to orchestrate, which sizes the work. Intake alone finishes nothing, unless the request was explicitly intake-only.

If you pause or abandon the work, save the ledger and return the claim to Backlog.
