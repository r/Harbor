---
name: finalize
description: Review and verify a Harbor change against its acceptance at an exact head, update docs and the Linear ledger, open a PR that stands on its own and stop for the maintainer's decision. Never authorizes its own merge.
---

# Finalize

Rules: [the workflow](../../../docs/agent-workflow.md). This is the gate between a builder's claim and the maintainer's decision. It never consents to a merge.

1. **Freeze the scope.** Record the base and head, and `git diff <base>...HEAD`. Record dirty work separately. Review the whole change against the current HBR acceptance. Any later push reopens the claims it touches.
2. **Review at the workflow's tier.** At standard tier, run one fresh finder with **correctness** first, and copy, docs, coverage and cross-file effects second. Add more finders only for distinct risk surfaces. Permissions, messaging, the page-facing API and secrets are deep at minimum. Report serial self-review as such. Record the tier, the rationale and what actually ran.
3. **Triage and repair.** Each finding needs a file, line, failure scenario and evidence. Classify it as required, regression, out-of-scope follow-up, or disproved. Verify it in the checkout before fixing. Material fixes get re-reviewed within their scope. File follow-up tickets only inside authorized scope.
4. **Review coverage.** Map each required outcome and each changed behavior to a test at the right boundary. Add missing edge, failure and regression cases. Cite the recorded red for each regression test. Record the mapping and the gaps. A material gap blocks readiness unless the maintainer accepts it.
5. **Run the final gates** listed in the workflow for this change class, at the exact head. Record the commands and results, plus the type-error counts at base and head. Skips, timeouts and unrelated red are named gaps, not passes.
6. **Exercise the surface** where the change is visible. Use Firefox in a temporary profile with both extensions and the bridge, a real model, the real interaction, and the console. Use the demo pages for page-facing behavior, and check both chat POC copies when either changes. If you re-registered the bridge, restore the previous registration afterward.
7. **Update docs and lessons.** Put new and changed behavior into the area docs. Check `docs/POSITIONING.md` before changing any external framing. Put process lessons into the relevant skill. Say when nothing needs updating.
8. **Package.** If publishing is authorized: commit through normal hooks, push, and open one PR. The PR follows [CONTRIBUTING](../../../CONTRIBUTING.md#writing-the-description):
   - The title has no ticket ID. The body has `Fixes HBR-<n>`.
   - The body covers the problem, the change, the testing (including what wasn't tested), and what's left.
   - Other tickets are mentioned with a few words of description.
   - No security detail from internal tickets.

   Without authorization, preserve the branch and ask.
9. **Present.** Update the ledger with the PR, head and evidence. Attach the PR link to the ticket, and move the issue to **In Review**. Give a verdict: **READY FOR REVIEW** or **BLOCKED: <reason>**. Stop.
