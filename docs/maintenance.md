# Maintenance and verification

[English](maintenance.md) | [简体中文](maintenance.zh-CN.md) · [README](../README.md)

## Development

This package runs ESM source directly; there is no build step. Run `npm test` with the DSH dependencies available. The development checkout links to the installed runtime's dependencies so Cordis services share one instance.

The supported baseline is DSH `0.2.1-rc.3`. Before supporting another release, verify the actual Loader composition, tool schemas, and member recovery. The bundled Team code comes from that release; see [source notes](../vendor/README.md) for the model-routing changes and MIT license.

## Verification

The latest regression run (`npm test`, which runs `node --test test/*.test.mjs`, on branch `feat/coordinator-only-20261117`, verified 2026-11-17) passed all 22 of 22 tests. They cover structured assignments, path and symlink checks, misleading extra path arguments, exact verification commands and their first-request context, malformed saved records, fresh/fork requests, cold recovery, a missing Lead, plugin unload, and cleanup after a failed write, plus the strict coordinator cases and the configuration cases.

The 22 tests include the policy cases (allowlist matrix in `test/policy.test.mjs`) and integration cases for `coordinatorMode`: strict guard behavior, the default (`off`) lead being unrestricted with the lenient prompt, rejection of an invalid mode, and the model preference summary shown in the `spawn_teammate` description (in `test/integration.test.mjs`). All of them passed. Real-desktop manual acceptance (the default mode check and steps 2–5 under "Strict coordinator mode") has not been run yet; the plugin was disabled in the desktop profile when this change was made.

Integration tests use real Cordis, AgentLoop, tool dispatch, and JSONL storage with a local mock model. They make no remote model calls.

Earlier historical record, made before strict coordinator mode was added and when the suite had 11 tests: a separate live-model check created a verifier using `huanling-deepseek/deepseek-v4.1-flash-1017` with `medium` reasoning effort. Its saved descriptor recorded that route and effort. The member received its role, working directory, and exact command list. An attempt to append an unauthorized command was rejected; the assigned command then passed all 11 tests and the member reported to the Lead. This check did not cover every interaction after a full desktop restart.

## Installation checks

The development profile uses a local link to this repository. Its dependency and bundle composition checks passed without skipped entries or warnings. The running session received the routing rules and the required `specialist` and `assignment` fields on `spawn_teammate`.

After installing or upgrading, check these states in the plugin page:

| Component ID | Expected state | Purpose |
| --- | --- | --- |
| `agent-team`, `tool-agent-team` | Disabled | Original Team service and tools replaced by this plugin |
| `tool-subagent`, `tool-subagent-fork` | Disabled | Ordinary subagent entry points |
| `ui-agent-team` | Enabled and running | Upstream Team interface retained by this plugin |
| `specialist-team-service`, `specialist-team-tools`, `specialist-team` | Enabled and running | This plugin's Team service, tools, and delegation policy |

Any `config.models` preferences on `specialist-team-tools` must use currently authorized provider/model pairs. If authorization changes, update the preferences; invalid choices fail rather than silently falling back. A real failure of this kind happened when a preference named a retired model id (`deepseek-v4.1-flash-1017`): `spawn_teammate` was rejected, and the lead then picked its own model for every member. The error now names `config.models` on `specialist-team-tools`. Efforts must also be supported by the model, for example `claude-sonnet-5-5` accepts only `off`, `high` and `xhigh`.

### Original Team component errors or member creation failures

This plugin's `cordis.patch.yml` disables the four original service or tool entries listed above by default, but the profile's own `cordis.patch.yml` can override those settings later. For example, a leftover `disabled: false` in the desktop profile re-enables an original component. The original and replacement implementations then register the same `agentTeams` service and tool names. An observed failure showed errors on `agent-team` and `tool-agent-team` while the Team interface and all three replacement components remained active.

Inspect the current profile's `cordis.patch.yml` (the desktop default is `~/.dsh/profiles/desktop/cordis.patch.yml`). Remove overrides that re-enable the original components, or set them to disabled. The fix for the observed conflict was:

```yaml
- id: tool-agent-team
  disabled: true
- id: agent-team
  disabled: true
```

Also keep `tool-subagent` and `tool-subagent-fork` disabled, and `ui-agent-team` enabled. Do not disable the three Specialist Team components to clear errors on the original components.

After saving, wait for configuration hot reload, recheck the table above, then create a member with `specialist` and `assignment`, assign it a task, and confirm that it replies. Reload DSH if the configuration does not load automatically. This procedure repaired the desktop conflict on 2026-11-17: runtime state checks, member creation, and messaging passed, as did all 11 regression tests. It did not cover every interaction after a full desktop restart.

The package identifier stays `dsh-specialist-team`. Display metadata uses `locale/en.json` and `locale/zh.json`; DSH's Chinese locale key is `zh`, even when the page's HTML language is `zh-CN`.

## Assignments and recovery

Each spawn requires a specialty and an assignment: deliverable, readable and writable paths, allowed tools, reviewer, stopping condition, and exact commands for verifier checks. Invalid assignments are rejected before the member starts. The assignment is saved in the Lead's journal and copied to the member's journal before work begins.

The guard checks registered tool calls before execution. It resolves paths to reject direct access outside the assigned scope. With a PTC host, specialists use native tools instead of an unrestricted code-execution entry point.

These checks are not an OS sandbox. Recursive searches may follow links, approved commands and their child processes can access the same system, and files can change between the check and execution. Review the commands and their effects accordingly.

A recovered member keeps its saved assignment and model settings. If the Lead is not loaded, resume the parent Team session before continuing. Unloading the policy leaves existing members blocked; restart those sessions to continue. Older members without assignments retain their previous behavior.

## Strict coordinator mode

Strict mode is opt-in: `coordinatorMode: strict` in the `config` of the `id: specialist-team` entry (`Config` in `src/index.mjs`, default `off`; any other value throws `specialist-team: coordinatorMode must be one of off, strict`). With `off` the Lead guard is not installed and the lenient routing prompt (`routingPrompt('off')` in `src/prompts.mjs`) is used. Specialist assignment checks apply in both modes.

The Lead guard in `src/index.mjs` calls `leadToolDenial` from `src/policy.mjs` before each Lead tool runs. `COORDINATOR_TOOLS` is an exact-name list with no prefix or wildcard grants. Unknown, renamed and newly added tools are denied until someone reviews the list and the test matrix. `decompress` is allowed only without `toFile` or `imageRef`, since those write files or images. The Lead is also presented with native tools, so a PTC host does not give it `run_code`.

The guard is registered before the routing prompt and its disposer is deliberately kept out of the unload cleanup. After the policy is unloaded the Lead keeps the same allowlist and additionally cannot call `spawn_teammate`, because members created then would have no assignment limits. Restart the Lead session to spawn again. Specialists and older members without assignments use their own paths and are not affected by the Lead guard.

Integrating, committing and publishing remain Lead-role duties, but neither the Lead nor any specialist has a tool for them in this mode. The Lead reports such a request to the user as a conflict with strict mode. Do not widen engineer or verifier assignments to work around it. To commit or publish, use a session or profile without this plugin, or do it outside DSH, after reviewing the specialists' reports.

Acceptance steps after installing or changing the allowlist (set `coordinatorMode: strict` first; with the default `off`, confirm instead that the Lead can still read files and run commands directly):

1. Run `npm test` and confirm the strict coordinator cases pass.
2. In a Lead session, ask for a simple file read. The Lead should spawn a researcher instead, and a direct `read`, `bash`, `edit` or `git_*` call should be refused with "Strict coordinator mode".
3. Ask the Lead to commit. It should report the conflict to you and not run git or delegate a commit.
4. Confirm that `spawn_teammate`, `ask_user_question`, `todo_write` and the task board still work.
5. After a full restart and resume of the Lead session, repeat step 2.

The allowlist checks registered tool calls only. It is not an OS sandbox: a specialist's approved commands and their child processes still act on the real system, and a tool registered under an allowed name would be allowed.

## Uninstall

Remove this package from the profile's dependencies and `dsh.profile.bundles`, restore the original Agent Team configuration, and restart DSH. Historical assignment records remain available for audit; the ordinary Team implementation ignores these extension records.
