# Maintenance and verification

[English](maintenance.md) | [简体中文](maintenance.zh-CN.md) · [README](../README.md)

## Development

This package runs ESM source directly; there is no build step. Run `npm test` with the DSH dependencies available.

The supported baseline is DSH `0.2.1-rc.3`. Before supporting another release, verify the actual Loader composition, tool schemas, and member recovery. The bundled Team code comes from that release; see [source notes](../vendor/README.md) for the model-routing changes and MIT license.

## Verification

Run `npm test`. Policy tests check tool, path and command limits; integration tests use a local mock model for assignments, recovery and live updates. Client tests cover autosave, conflicts, disconnects and bilingual controls. These checks do not verify desktop restart, sign-in or live provider calls.

## Installation checks


After installing or upgrading, check these states in the plugin page:

| Component ID | Expected state | Purpose |
| --- | --- | --- |
| `agent-team`, `tool-agent-team` | Disabled | Original Team service and tools replaced by this plugin |
| `tool-subagent`, `tool-subagent-fork` | Disabled | Ordinary subagent entry points |
| `ui-agent-team` | If installed, leave enabled to use the Team interface | Not installed by this bundle |
| `subagent-model-selection-settings` | Loaded | The default tools configuration requires this service to initialize. To use preferences, enable model selection and authorize the provider/model pairs. |
| `dsh-team-service`, `dsh-team-tools`, `dsh-team` | Enabled and running | This plugin's Team service, tools, and delegation policy |

Any `config.models` preferences on `dsh-team-tools` must use currently authorized provider/model pairs. If authorization changes, update the preferences; invalid choices fail rather than silently falling back. When setting `reasoningEffort` manually, use a level listed on the settings page for that provider and model.

### Original Team component errors or member creation failures

This plugin's `cordis.patch.yml` disables the four original service or tool entries listed above by default, but the profile's own `cordis.patch.yml` can override those settings later. For example, a leftover `disabled: false` in the desktop profile re-enables an original component. The original and replacement implementations then register the same `agentTeams` service and tool names. An observed failure showed errors on `agent-team` and `tool-agent-team` while the Team interface and all three replacement components remained active.

Inspect the current profile's `cordis.patch.yml` (for example, `~/.dsh/profiles/desktop/cordis.patch.yml`). Remove overrides that re-enable the original components, or set them to disabled. The fix for the observed conflict was:

```yaml
- id: tool-agent-team
  disabled: true
- id: agent-team
  disabled: true
```

Also keep `tool-subagent` and `tool-subagent-fork` disabled, and leave `ui-agent-team` enabled if you use its interface. Do not disable this plugin's three components to clear errors on the original components.

After saving, wait for configuration hot reload, recheck the table above, then create a member with `specialist` and `assignment`, assign it a task, and confirm that it replies. Reload DSH if the configuration does not load automatically.


## Assignments and recovery

Each spawn requires a specialty and an assignment: deliverable, readable and writable paths, allowed tools, reviewer, stopping condition, and exact commands for verifier checks. Invalid assignments are rejected before the member starts. The assignment is saved in the Lead's journal and copied to the member's journal before work begins.

The guard checks registered tool calls before execution. It resolves paths to reject direct access outside the assigned scope. With a PTC host, specialists use native tools instead of an unrestricted code-execution entry point.

These checks are not an OS sandbox. Recursive searches may follow links, approved commands and their child processes can access the same system, and files can change between the check and execution. Review the commands and their effects accordingly.

A recovered member keeps its saved assignment and model settings. If the Lead is not loaded, resume the parent Team session before continuing. Unloading the policy leaves existing members blocked; restart those sessions to continue. Older members without assignments retain their previous behavior.

## Strict coordinator mode

Use the settings switch or set `coordinatorMode: strict` on `dsh-team`. While on, the lead is subject to the [tool allowlist](../src/policy.mjs). Turning it off lifts this restriction; specialist assignment checks apply in both modes. Unloading while strict leaves the lead restricted and unable to spawn until the session restarts.

Acceptance steps after installing or changing the allowlist (set `coordinatorMode: strict` first; with the default `off`, check instead that this plugin does not block otherwise permitted tool calls):

1. Run `npm test` and confirm the strict coordinator cases pass.
2. In a Lead session, ask for a simple file read. Check the tool result: a direct `read`, `bash`, `edit` or `git_*` call should be refused with "Strict coordinator mode".
3. Ask the Lead to commit. It should report the conflict to you and not run git or delegate a commit.
4. Confirm that `spawn_teammate`, `ask_user_question`, `todo_write` and the task board still work.
5. After a full restart and resume of the Lead session, repeat step 2.

The allowlist checks registered tool calls only. It is not an OS sandbox: a specialist's approved commands and their child processes still act on the real system, and a tool registered under an allowed name would be allowed.

## Uninstall

Remove this package from the profile's dependencies and `dsh.profile.bundles`, restore any Team settings you changed for this installation, and restart DSH. Historical assignment records remain available for audit; the ordinary Team implementation ignores these extension records.
