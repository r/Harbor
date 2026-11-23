---
name: start
description: Resolve and claim one ready Harbor task before building. Check Linear scope, human gates, dependencies, existing PRs and competing claims; isolate a worktree and write the scope ledger. Use for an HBR number, a plain-English build request, or choosing the next task.
---

# Start

Rules: [the workflow](../../../docs/agent-workflow.md). This skill prepares a task scope, a worktree and a ledger, and records a claim when using Linear. Then it continues into **orchestrate**.

1. **Resolve the request.** Linear access is optional. Harbor’s internal tracker is team `HBR` in the Mozilla Linear workspace (`linear.app/mozillaorg`).
   - **Without Harbor Linear access:** Use the GitHub issue or the user’s request as scope. Skip steps 2 and 4, check for duplicate work in GitHub and Git in step 3, and use the GitHub issue or PR description for the ledger in step 6. If no task was supplied, ask for a GitHub issue or a description of the work. Contributors can use this path without connecting a Linear account. If the request cites only an internal `HBR` ticket, ask for a shareable description or GitHub issue.
   - **With Harbor Linear access:** Select the Mozilla account if the connector offers multiple accounts. In Codex, discover the current Mozilla `link_id` from the Linear tool schema and pass it explicitly on each Linear call. Verify the workspace and the `HBR` team before searching for issues. Pass the verified account selector to the scout and later workflow steps. If the available connection cannot reach `HBR`, use the no-access path. An empty result from another workspace says nothing about Harbor’s queue. Keep account emails and connection IDs out of the repo and public artifacts.
   - With Linear access and an HBR number, read the issue, its comments and its relations. For prose, search and explain the match.
   - With Linear access and no task, don't search Linear yourself. Hand candidate discovery to one read-only scout (Claude Code: `harbor-scout`). Brief it to read Linear only and return at most eight Todo/Backlog HBR candidates. For each, it reports the status, labels, blockers and their states, the newest claim comment, and what the ticket blocks. Rank them yourself against step 2, offer a short list and wait. Read the chosen issue in full yourself.
   - Create a ticket only for work the maintainer has authorized. A suggestion is not permission.
2. **Check readiness.** Candidates are Todo or Backlog, with prerequisites met, no live claim, and no **Needs human** label or unmet human answer. Canceled or Duplicate blockers are not delivered blockers. Say what would make blocked work ready.
3. **Check reality.** For an HBR ticket, run:

   ```sh
   gh pr list --search 'HBR-<n> in:body' --state all
   git branch -a --list '*hbr-<n>-*' '*hbr-<n>'
   git worktree list | grep -iE 'hbr-<n>([^0-9]|$)'
   git log origin/main --oneline -E -i --grep 'HBR-<n>([^0-9]|$)'
   ```

   Without an HBR number, search open and closed PRs, branches, worktrees and `origin/main` using the GitHub issue number or distinctive terms from the request. Also read any PR links attached to the issue. Search matches prefixes (HBR-1 finds HBR-12), so an HBR hit counts only when its number is exactly `<n>`. Read further only on a hit.
   - A Backlog issue with a ready PR is resumed, not rebuilt.
   - An issue that's In Review, or In Progress with a live coordinator, isn't yours.
   - Already-delivered work gets evidence and reconciliation, not a rebuild.

   When using Linear, claim the task before building.
4. **Claim.** Reread the status and the newest claim comment. Then post the claim in the [workflow's format](../../../docs/agent-workflow.md#ownership) and move the issue to In Progress. In Rex, the session ID names the pane too: `rex:<REX_SESSION uuid>/<REX_BLOCK uuid>`. Competing ownership means stop. A claim over 24 hours old with no commit or comment is abandoned; take it over with a note.
5. **Isolate.** Never switch the shared root checkout.
   - Read the workflow's [known pitfalls](../../../docs/agent-workflow.md#known-pitfalls) before setting up. Several bite during setup and base comparisons.
   - Fetch, then create the branch and worktree in one step. Use `origin/main` or the chosen base. `--no-track` keeps the branch from tracking the base, so the first `git push -u` sets the right upstream:

     ```sh
     git fetch origin
     git worktree add --no-track -b <user>/hbr-<n>-<slug> ../harbor-wt/hbr-<n>-<slug> origin/main
     cd ../harbor-wt/hbr-<n>-<slug> && git submodule update --init
     (cd extension && SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm ci)   # and each other package you'll build
     ```

   - For a task without an HBR number, use the GitHub issue number or a descriptive slug in place of `hbr-<n>-<slug>` throughout this step.
   - Don't silence the install, and don't skip install scripts to get past a failure. If it still fails, stop and record the error in the ledger.
   - To compare against the base, add a detached worktree at the base SHA. Never use `git stash`.
   - Record in the ledger the ports and the Firefox profile you'll use, and whether you'll need the [shared bridge registration](../../../docs/agent-workflow.md#shared-local-resources).
   - Use absolute paths in every brief.
   - Name the current session or tab after the task (`hbr-<n>-<slug>`) where the harness allows:
     - **Codex:** Set the current chat title with the available `set_thread_title` tool, using `title: "hbr-<n>-<slug>"` and omitting `threadId` to target the calling chat. Discover the tool if needed. If unavailable, report that the title could not be set and continue intake.
     - **Rex:** A tab is a window: `rex window rename "$(rex block inspect "$REX_BLOCK" | awk '/^window:/{print $2}')" hbr-<n>-<slug>`. Never rename the Rex session; every tab shares it.
6. **Write the ledger** in the HBR description, or use the GitHub issue or PR description when working without Linear. Follow the workflow's template: outcomes, exclusions, base SHA, worktree, acceptance source, expected files and size, and open decisions. Anything on the [maintainer-decides list](../../../docs/agent-workflow.md#what-the-maintainer-decides) goes to the maintainer before coding.
7. **Hand off** to orchestrate, which sizes the work. Intake alone finishes nothing, unless the request was explicitly intake-only.

If you pause or abandon the work, save the ledger and return any Linear claim to Backlog.
