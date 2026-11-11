---
name: pre-close
description: Termination cleanup, run only when the user asks to exit the session or erase its context. Preserve work and evidence, release this session's claims, stop only owned processes and restore shared resources. Never a completion verdict.
---

# Pre-close

Rules: [the workflow](../../../docs/agent-workflow.md). Run this when the user asks to end the session, and only then. A merge wait, a blocker or the end of a reply doesn't count. Once every requested outcome is delivered, you may offer it, and run it only if accepted.

Inventory this session's resources from its ledger: claimed HBR issues, workers, branches, worktrees, PRs, stashes, server PIDs and ports, Firefox profiles, bridge re-registrations, and temporary artifacts. Anything that isn't yours isn't yours to clean. No broad `pkill`, `git clean`, resets, or killing every Firefox.

1. **Workers.** Collect their reports, and account for every lane. A running worker needs an accepting live coordinator or the maintainer's decision; don't kill it.
2. **Git.** For each owned checkout, record `git status --short`, the branch, the upstream, unpushed commits, and identified stashes. Preserve dirty and unique work. Commit and push only with existing authorization; otherwise record where the work is. Never switch the shared root, and never `stash` or `stash pop` as cleanup: the stash stack is shared across every worktree.
3. **Claims.** Set each of this session's issues to its true state:
   - In Review for a ready PR;
   - Backlog for blocked or incomplete work, with the condition and the resumption steps;
   - In Progress only for a named live worker who accepted it.

   Leave other sessions' claims alone.
4. **Promises.** Reconcile every worker thread, review finding and promised follow-up. Remaining work goes in the open ticket's ledger, or an authorized follow-up, not in chat. Anything not made durable is named as an open handoff gap.
5. **Processes and shared resources.** Stop the servers, Firefox instances and web-ext runners you own, by launcher or by verified PID after checking the command, cwd and port. Check the listeners afterward. If you re-registered the bridge, restore the recorded previous registration. Leave Ollama running unless this session started it.
6. **Artifacts.** Put sanitized evidence into `~/.harbor-dev/evidence/HBR-<n>/` and the ticket. Remove only clean, integrated worker worktrees. Never delete unique work, remote branches, or `~/.harbor/`.

Report the PR state, the claims released or transferred, the work preserved, the next actions, and the resources stopped or restored. Complete means delivered and evidenced; parked means parked. Never merge, publish or discard work to tidy a handoff.
