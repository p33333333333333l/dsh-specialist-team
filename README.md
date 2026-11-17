# DSH Specialist Team

[English](README.md) | [简体中文](README.zh-CN.md)

The lead assigns work to specialists, each with its own scope, tools and optionally its own model. Delegation rules load automatically; no skill activation is needed. An optional [strict coordinator mode](#strict-coordinator-mode) (off by default) restricts the lead to dispatching only.

Built on DeepSeek's [@deepseek-ai/dsh-experimental-agent-team-profile](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.3/packages/experimental/agent-team-profile). This plugin adds specialist assignments, model preferences, and tool restrictions. See [source details](vendor/README.md).

## Specialists

| Specialist | Job |
| --- | --- |
| Designer | UI decisions and assigned UI changes |
| Researcher | Read-only research |
| Engineer | Code and assigned tests; does not run checks |
| Architect | Read-only architecture and diagnosis |
| Verifier | Independent checks using approved commands |

By default (`coordinatorMode: off`) the lead keeps all its tools. It does local, known, easily checked work itself and uses a specialist for a concrete expertise gap, an independent check, or work with several independent parts. It chooses the team, assigns file and tool access, and hands each delivery to a reviewer. Specialists cannot delegate, commit, integrate or publish.

## Strict coordinator mode

Off by default. Set `coordinatorMode: strict` in the `config` of the `id: dsh-team` entry (see [Configuration](#configuration)) to enable it. The lead then only dispatches, coordinates, asks you questions and summarizes, and every actual task, even a single file read, goes to a fresh specialist. The lead's tool calls pass an exact-name allowlist before they run; everything else is blocked, including file reads, search, edits, shell, git, web, browser and MCP tools, session lookups, `subagent`, `subagent_fork`, `workflow`, `run_code` and scheduling. Unknown or newly added tools are blocked until the list is reviewed.

| Group | Allowed tools |
| --- | --- |
| Dispatch and team | `spawn_teammate`, `list_subagent_models`, `list_agents`, `send_message`, `interrupt_agent`, `wait_agent`, `team_task_create`, `team_task_get`, `team_task_list`, `team_task_update` |
| Asking and planning | `ask_user_question`, `todo_write`, `create_goal`, `get_goal`, `update_goal`, `exit_plan_mode`, `skill` |
| Context and jobs | `compress`, `decompress` (without `toFile` or `imageRef`), `search_context`, `acp_status`, `acp_cache`, `job_list`, `job_output`, `job_kill` |
| Delivering | `present` |

Integrating changes, committing and publishing stay with the lead role, but the lead has no tool for them in this mode and specialists may not do them either. The lead reports such a request to you as a conflict with strict mode and asks how to proceed; it does not widen engineer or verifier permissions.

The guard stays in force after the plugin is unloaded, and the lead can no longer spawn members until the session is restarted. Older members without an assignment keep their original behavior.

## Install

Requires DSH `0.2.1-rc.3`, Node.js 22+, and the upstream Agent Team profile linked above. Other DSH versions are untested.

1. Clone this repository. Add `"dsh-specialist-team": "link:/absolute/path/to/dsh-specialist-team"` to your DSH profile's dependencies.
2. Add `dsh-specialist-team` to `dsh.profile.bundles`, install the dependencies, and reload DSH.
3. Confirm that `spawn_teammate` includes `specialist` and `assignment`, then check the component states as described in [Avoid plugin conflicts](#avoid-plugin-conflicts) and [installation checks](docs/maintenance.md#installation-checks).

This replaces the Team service and tools, retains the Team interface, and disables ordinary subagent entry points. Members inherit the lead's model unless you configure model preferences, see [Configuration](#configuration).

## Avoid plugin conflicts

Check these components on the plugin page after installing, and again after enabling any other plugin:

| Component ID | Keep | Why |
| --- | --- | --- |
| `agent-team`, `tool-agent-team` | Disabled | The original Team service and tools register the same `agentTeams` service and tool names (`spawn_teammate`, `send_message` and others). Running both causes errors on the original components. |
| `tool-subagent`, `tool-subagent-fork` | Disabled | The built-in `subagent` and `subagent_fork` tools skip specialist assignments, tool limits and the model preferences below. Subagents they start inherit the main session's model. |
| `ui-agent-team` | Enabled | The Team interface this plugin still uses. |
| `subagent-model-selection-settings` | Enabled, with `enabled: true` and every model you use in `allowedModels` | `dsh-team-tools` reads the authorized models from it when `modelSelectionSettings: true`. Without it, model preferences and `list_subagent_models` are unavailable. |
| `dsh-team-service`, `dsh-team-tools`, `dsh-team` | Enabled | This plugin. |

This plugin's `cordis.patch.yml` disables the four components above by default, but a later `disabled: false` in your profile's own `cordis.patch.yml` turns them back on. Also do not enable another plugin that provides its own Team or subagent dispatch tools or replaces the `agentTeams` service. Such a plugin could register tools with the same names or bypass the specialist checks. See [troubleshooting](docs/maintenance.md#original-team-component-errors-or-member-creation-failures) for the fix.

## Configuration

Settings go in the profile's `cordis.patch.yml`. Both are optional.

```yaml
- id: dsh-team
  config:
    coordinatorMode: strict   # off (default) | strict
- id: dsh-team-tools
  config:
    modelSelectionSettings: true
    models:
      researcher: { provider: huanling-deepseek, model: deepseek-v4.1-flash, reasoningEffort: high }
      engineer: { provider: huanling-cc-kiro-power, model: claude-sonnet-5-5, reasoningEffort: high }
      verifier: { provider: huanling-gpt-pro, model: gpt-6.1-sol, reasoningEffort: medium }
```

- `coordinatorMode` on `id: dsh-team`: `off` (default) or `strict`. Any other value fails at load.
- `models` on `id: dsh-team-tools`: one preference per specialist (`designer`, `researcher`, `engineer`, `architect`, `verifier`) with `provider`, `model` and optional `reasoningEffort`. A specialist without an entry inherits the lead's model. Each pair must be authorized for the session (for example in `subagent-model-selection-settings.allowedModels`), and `reasoningEffort` must be a level the model supports; otherwise `spawn_teammate` fails with a hint instead of switching models.
- With `modelSelectionSettings: true`, the configured preferences are listed in the `spawn_teammate` description, so the lead sees them. The lead omits `provider` and `model` to use the preference, and passes them only when you ask for a model or the task needs a different one.

## Limits

Tool restrictions, including the lead's allowlist in strict mode, are not an OS sandbox. They check registered tool calls only; approved commands and recursive searches can reach beyond assigned files, so review commands before granting access. The lead's allowlist does not stop a specialist's approved commands from having side effects. The model remains responsible for delegation decisions and work quality.

For tests, recovery, and uninstall instructions, see [maintenance](docs/maintenance.md).

## License

Original contributions to this project are licensed under [Apache-2.0](LICENSE). Bundled upstream DeepSeek Harness code retains its [MIT license](vendor/LICENSE-MIT); our original changes to that code use Apache-2.0. The package declares `Apache-2.0 AND MIT` because both licenses apply to their respective portions, not as alternatives. See [NOTICE](NOTICE) and [source details](vendor/README.md) for attribution and scope.
