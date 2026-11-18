# Maintenance and verification

[English](maintenance.md) | [简体中文](maintenance.zh-CN.md) · [README](../README.md)

## Installation checks

Version `0.3.0` requires exactly DSH `0.2.2-rc.4` and Node.js 22 or later. After installing or upgrading, check the plugin entries in the active profile:

| Entry ID | Expected state |
| --- | --- |
| `agent-team`, `tool-agent-team` | Enabled. DSH provides the team service and task board tools. |
| `tool-subagent-control`, `tool-subagent`, `tool-subagent-fork` | Keep the normal DSH configuration for ordinary subagents and group controls. |
| `ui-agent-team` | Keep the native team UI enabled where available. Use its **Agent Teams** toggle in the root session. |
| `subagent-model-selection-settings` | To use custom model routes, enable selection and authorize provider/model pairs before starting a new root session. |
| `dsh-team` | Enabled. This bundle has one entry for specialist dispatch, settings and assignment guards. |

Leave the native preset groups intact. In a root session, confirm that switching Agent Teams on exposes `spawn_teammate` with required `specialist` and `assignment` fields. Switching it off removes specialist dispatch. Child sessions cannot dispatch specialists. DSH continues to manage the agent tree, messaging and task board.

## Upgrade from 0.2.x

1. In the active profile’s `cordis.patch.yml`, move any `dsh-team-tools.config.models` preferences to `dsh-team.config.models`. Preserve `dsh-team.config.coordinatorMode`. See the [manual configuration example](../README.md#manual-configuration-optional).
2. Remove old `dsh-team-tools` and `dsh-team-service` entries or overrides. Remove `disabled: true` overrides added for the old bundle on `agent-team`, `tool-agent-team`, `ui-agent-team`, `tool-subagent-control`, `tool-subagent` and `tool-subagent-fork`, where present. Restore any native delegation groups disabled for the old setup.
3. Reload DSH, check the plugin entries above, then enable Agent Teams in a new root session. Keep sessions from the replacement Team implementation as history. Their journals remain available for reference. Existing team members and tasks are not migrated into the native team.

The earlier replacement implementation and its MIT license are archived in `vendor/` in the source repository. The `0.3.0` release package excludes the archive.

## Assignments and recovery

Only the root of an enabled Agent Teams session can use `spawn_teammate`. Each spawn requires a specialty and an assignment defining the deliverable, read and write paths, allowed tools, reviewer and stopping condition. Include exact command strings if a verifier needs to run checks. Write paths must fall within read scopes. `context: fresh` is the default. Use `context: fork` to inherit the lead’s transcript.

Invalid assignments are rejected before launch. The bundle saves the assignment in the specialist’s session journal before work begins and reloads it when the native specialist session is resumed. Specialists use the native tool executor even in a PTC preset and report to the lead through DSH’s `send_message` with `agent: lead`.

Guards enforce the assigned scope for registered tools. Recursive searches may follow links, approved commands can launch other processes, and files may change between a scope check and execution. Review what each verifier command can affect. If the bundle is unloaded, already assigned specialists are blocked. Reload the bundle and reopen the affected sessions before continuing specialist work.

## Strict coordinator mode

Set `coordinatorMode: strict` on `dsh-team` or use the switch in Specialist model settings. In an enabled Agent Teams root session, the lead can coordinate, dispatch specialists and use the task board. Direct work tools are blocked by the [coordinator allowlist](../src/policy.mjs#L98). Turning strict mode off restores the lead’s work tools on subsequent calls. If the root previously used PTC, reopen the session to restore the preset’s executor. Turn strict mode off before unloading the bundle. If the lead remains restricted after unloading, reopen the session.

## Verification

This package runs ESM directly. With the target DSH dependencies installed, run `npm test`. For an installation check:

1. In a fresh root session, toggle Agent Teams off and on. Confirm ordinary subagent tools are available as appropriate to the preset and the native team UI and task board work when enabled.
2. Dispatch fresh and fork specialists with valid assignments. Confirm the root receives replies, a specialist cannot dispatch another specialist, and an out-of-scope read is rejected after resuming the specialist.
3. Toggle strict mode in the root and verify that it blocks direct work while allowing coordination. Repeat in a PTC preset. Try an authorized model route and an unauthorized one.

Automated checks do not verify desktop restart, sign-in or live provider calls.

## Uninstall

Turn strict mode off, remove the bundle from the profile dependencies and `dsh.profile.bundles`, remove bundle-specific overrides, and restart DSH. The native team components remain available. Historical assignment records remain in session journals.
