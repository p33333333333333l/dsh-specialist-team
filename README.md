# DSH Specialist Team

[English](README.md) | [简体中文](README.zh-CN.md)

Specialist Team helps DSH `0.2.1-rc.3` decide when to handle a task directly and when to bring in specialists. It supports five specialties, model selection, and tool limits for each assignment. Once installed, it adds its rules to the system prompt automatically. You do not need to activate a skill first.

The plugin list and detail page show localized names and descriptions. In Chinese, the plugin is “专家协作” and its components are “团队服务”, “协作工具”, and “专家协作”. English interfaces use the English equivalents. The package name remains `dsh-specialist-team`. Chinese metadata uses DSH's language code `zh` (`locale/zh.json`); English uses `en`. The page attribute `lang="zh-CN"` does not change the metadata lookup code to `zh-CN`.

## Features

- The lead agent considers risk, dependencies, and gaps in expertise before choosing to work alone, ask one specialist, or assemble a team. The model makes this decision; keywords do not automatically trigger more agents.
- Every `spawn_teammate` call must include a specialty and a structured assignment: the deliverable, readable and writable paths, allowed tools, reviewer, and stop condition. Invalid assignments are rejected before a member is created.
- Design and implementation specialists can use file editing tools when explicitly authorized. Research, architecture, and verification specialists cannot edit the project. Only verification specialists can run commands, and each command must be specified by the lead agent.
- Specialists report to the Lead. They cannot delegate further, commit or push changes, or use tools outside their assignment. The Lead manages the task board.
- Before a member starts, its assignment is saved in the Lead's session log and copied into the member's log. A restored member keeps that assignment. If the member is restored without the Lead, tool calls are blocked until the parent session is restored. Existing members without assignments keep their previous behavior.
- Model selection uses DSH's session authorization and live preflight checks. You can configure model preferences; otherwise, members inherit the model. The Lead chooses a reasoning level for each subtask instead of always using the highest level.

## Installation

Add the package to your DSH profile's dependencies and add `dsh-specialist-team` to `dsh.profile.bundles`. The existing Agent Team profile is required for the underlying services and interface. This package's bundle disables the old Team instances and registers its own service, tools, and policy while keeping the Team interface. It also disables the old ordinary subagent entry points to avoid duplicate registrations.

No provider is selected by default. To set preferences for the five specialties, configure `config.models` on the profile entry with `id: specialist-team-tools`. Each provider/model pair must be in the current authorization list. Update preferences when that list changes. An invalid configuration fails with an error; it does not silently switch models.

### Local installation and verification

The development installation uses `link:/var/home/admin/workspaces/dsh-specialist-team` in the profile. Its dependency and bundle are registered, and configuration composition passed with no skipped entries or warnings. The global working rules use the plugin first and fall back to the skill when the plugin is absent. The running session has received the plugin's rules, and `spawn_teammate` exposes the required `specialist` and `assignment` fields. After reinstalling or upgrading, check for those rules and fields to confirm that the plugin is active.

A test with a live model created a verifier using `huanling-deepseek/deepseek-v4.1-flash-1017` with `medium` reasoning. The saved descriptor recorded that selection. The member received its role, exact command list, and working directory, then passed 11 tests. The tool guard rejected an attempt to append an unauthorized command; the member then ran the exact assigned command and reported to the Lead. This checked assignment creation, the model call, command restrictions, and messaging in the running session. It did not cover every desktop interaction after a full application restart.

## Scope of the restrictions

Before a tool runs, the guard checks the specialty, allowed tools, read and write paths, and verification commands. It also rejects unapproved MCP, terminal, and subagent tools. Path checks resolve symbolic links and reject direct file access outside the assigned paths. When the lead agent uses PTC, specialists receive native tools so they do not gain an arbitrary code execution entry point. Unloading the plugin blocks further tool calls from existing specialists; those specialist sessions must be restarted.

These checks do not provide an operating system sandbox. Recursive searches inside an authorized directory may follow links. An approved verification command and its subprocesses can access the same system, so the Lead must review the command and its side effects. External file changes can also race with path checks. The plugin does not provide container isolation or file permissions that cannot be bypassed.

The model still has to follow the injected rules when deciding how to collaborate, choosing models, and stopping work. The plugin enforces assignment structure and restrictions on registered tool calls. Prompt instructions do not replace execution checks, and tool guards do not judge the quality of a deliverable.

## Development and verification

Run `npm test`. The 11 regression tests cover structured assignments, path and symbolic link boundaries, extra arguments that try to hide the actual path, exact verification commands and their first-turn context, invalid historical records, first requests for fresh/fork members, cold restoration, a missing Lead, plugin unloading, and cleanup after a write failure. Integration tests use real Cordis, AgentLoop, tool execution, and JSONL storage with a local mock model adapter. They do not make remote model calls or incur model fees.

The package uses ESM source and needs no separate build step. On the development machine, dependencies link to the existing DSH runtime to avoid duplicate Cordis service instances.

`vendor/` comes from DeepSeek Harness `dsh-v0.2.1-rc.3`, includes the previously verified model routing backport, and retains the upstream MIT license. The plugin adds an assignment record before Team member creation and wraps the creation tool. See the [source notes](vendor/README.md) for the changes. Compatibility with other DSH versions has not been verified. After an upgrade, rerun the real Loader composition and member restoration tests.

To uninstall, remove the package from the profile's dependencies and bundles, restore the original Agent Team module configuration, and restart. Historical assignment logs remain available for audit; the ordinary Team implementation ignores those extension events.
