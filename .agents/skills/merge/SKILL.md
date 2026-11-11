---
name: merge
description: Land a Harbor PR the maintainer has explicitly approved. Recheck the head, rerun the gates, squash with a head guard, watch the Pages deploy when it applies, reconcile Linear and resources. Only the maintainer's approval starts this.
---

# Merge

Rules: [the workflow](../../../docs/agent-workflow.md). Approval is the maintainer's GitHub review, the maintainer's Linear comment naming the PR, or the maintainer's words in this session. Nothing else counts. If the target or the consent is ambiguous, ask first.

1. **Identify the approved work.** Find the PR number and its current head. Read the finalize ledger and the maintainer's actual instruction. One PR's approval doesn't cover others. If there's no finalize record, run finalize first.
2. **Recheck the head.** Fetch without touching the shared root. Confirm that the PR is open and mergeable, has no unresolved required findings, and has its dependencies merged, and that the evidence describes this exact head. A changed head needs fresh evidence and the maintainer's renewed approval.
3. **Rerun the gates** for the change class on the approved head, in a clean worktree (the workflow's final gates; no new type errors against base). Red stops the merge, whatever the ledger says. A repair returns to finalize.
4. **Surface effects.** Say whether merging deploys the Pages site: it does when the change touches a path in `.github/workflows/deploy-pages.yml` (`whitepaper/`, `demo/`, and others). Note anything that needs a separate act, such as a submodule PR, an extension release or a store submission. A merge authorizes none of those.
5. **Merge the named head.** Squash by default. Write the subject and body from `git diff <base>...<approved-head>`, not from the commit list, keeping `Fixes HBR-<n>` in the body. Run `gh pr merge <n> --squash --match-head-commit <head> --subject ... --body ...`. Don't use an admin override, a force-push, or a raw fallback when a guard fails. Verify the landed commit and its message.
6. **Watch the deploy** if step 4 applies. Find the run with `gh run list --workflow deploy-pages.yml --limit 3`, then run `gh run watch <id> --exit-status` as a background task. On failure, report and fix forward. On success, load the changed page once.
7. **Reconcile.**
   - Comment on the HBR ticket with the approved head, the landed commit, the deploy result, the checks run, and residual work.
   - Move the ticket to Done only when its required outcome is delivered. Partial work stays partial, with next actions recorded.
   - Account for workers, servers, Firefox profiles, the bridge registration and worktrees. Remove only clean, integrated work.
   - Report merged, deployed and verified separately.

A merge is the maintainer's judgment. The agent executes it and records it.
