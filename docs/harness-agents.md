# Native agent bindings

Role behavior lives in [`.agents/roles/`](../.agents/roles/README.md). The files described here register those roles with a harness. Every adapter reads `AGENTS.md`, this document and its role **from the assigned checkout**, then follows the unit brief. A missing file is an escalation, not permission to read another checkout.

The skills live in `.agents/skills/`. `.claude/skills` is a symlink to that directory, so Claude Code discovers the same files.

## Roster

The `harbor-` prefix keeps the names from shadowing built-in roles. These are runtime defaults. A model appearing in a catalog proves neither entitlement nor a funded balance.

| Native agent | Shared role | Claude model / effort | Codex model / reasoning | Pi model / thinking |
| --- | --- | --- | --- | --- |
| `harbor-scout` | `scout` | haiku / medium | gpt-6-luna / medium | anthropic/claude-haiku-5-5:medium |
| `harbor-planner` | `planner` | opus / high | gpt-6.1-sol / high | anthropic/claude-opus-5-5:high |
| `harbor-mechanical-builder` | `mechanical-builder` | sonnet / medium | gpt-5.6-terra / medium | anthropic/claude-sonnet-5-5:medium |
| `harbor-builder` | `builder` | sonnet / high | gpt-6.1-sol / high | anthropic/claude-sonnet-5-5:high |
| `harbor-finder` | `finder` | sonnet / medium | gpt-5.6-terra / medium | anthropic/claude-sonnet-5-5:medium |
| `harbor-verifier` | `verifier` | opus / high | gpt-6.1-sol / high | anthropic/claude-opus-5-5:high |

Model changes go in the adapters and in this table, not in the role bodies. Announce the role and model that actually ran. If a preset beats a requested override, say so. Don't interrupt an in-flight worker to change tiers.

Coordinators pass no model override: the table is the budget. In Claude Code, built-in agents that aren't presets (general-purpose, Explore) default to Sonnet through `CLAUDE_CODE_SUBAGENT_MODEL` in `.claude/settings.json`. A preset's own frontmatter model still wins.

## Linear access

The scout lists Linear candidates for a bare **start**. Its Claude Code preset allows read-only tools from an MCP server named `linear-server-mozilla` (`list_issues`, `get_issue`, `list_comments`). The server is defined in the repo's [`.mcp.json`](../.mcp.json), and each person authenticates it on first use. Only members of Harbor's Linear workspace can authenticate. Everyone else skips the Linear steps, as [the workflow](agent-workflow.md#portable-execution) describes.

## Claude Code

[`.claude/agents/`](../.claude/agents/) holds six Markdown agents. Their frontmatter sets `name`, `description`, `model`, `effort` and `tools`, and their body loads the role. A running session may need a restart to see changes. Dispatch the named agent with the brief from **orchestrate**.

Read-only presets omit Edit and Write, but their Bash can still write: read-only is an instruction, not a sandbox. The verifier's Bash is for checks that write build artifacts.

## Codex

[`.codex/agents/`](../.codex/agents/) holds six TOML custom agents, with `name`, `description`, `developer_instructions`, `model` and `model_reasoning_effort`. Codex discovers them directly when multi-agent tools are enabled in the parent session; don't enable that behind the person's back. Use the `harbor-*` agent type when it's supported. If the runtime only exposes a bare spawn API, pass the TOML's instructions, model and the brief through its fields, and verify the model that ran. Never spawn a second CLI to evade a permission rejection.

Permissions come from the parent session: `sandbox_mode`, `approval_policy`, `model_provider` and `mcp_servers` in these files don't override it, so the adapters omit them.

## Pi (extension required)

Pi core has no subagents. The six [`.pi/agents/`](../.pi/agents/) adapters target the subagent extension example bundled with Pi. Nothing is installed or auto-loaded by this repository. To opt in, find your installed Pi package (the directory with its `README.md` and `examples/`), and launch from this checkout:

```sh
PI_PACKAGE_ROOT=/absolute/path/to/@earendil-works/pi-coding-agent
pi --extension "$PI_PACKAGE_ROOT/examples/extensions/subagent/index.ts"
```

The extension runs with your OS permissions, so only load trusted code. Confirm that a `subagent` tool is present before relying on it.

Discovery is user-only by default, and is based on the coordinator's cwd. So launch in this checkout, and pass `agentScope: "project"` on every call. Set the child's `cwd` to the assigned worktree, and name that path in its task:

```json
{
  "agent": "harbor-scout",
  "agentScope": "project",
  "cwd": "/absolute/path/to/assigned-harbor-worktree",
  "task": "Read the shared scout role and answer the coordinator's bounded question from the supplied unit brief."
}
```

The extension creates no worktrees, sandboxes or port isolation, and tool lists aren't a security boundary. The frontmatter suffix `model: provider/id:level` sets the thinking level.

- The scout, planner and finder have no shell, so the coordinator supplies git and PR receipts.
- The verifier has Bash for checks.
- The builders have edit, write and Bash.
- All children are leaves.

## Verifying the bindings

After editing adapters, parse the TOML and the frontmatter, and check the role paths, unique names, and the model and tool fields. A parser check is not a live run. Verify one bounded read-only dispatch per harness before claiming that the path works, and record the model, checkout and result. Unavailable credentials or tools are limitations, not passes.
