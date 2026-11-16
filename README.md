# DSH Specialist Team

[English](README.md) | [简体中文](README.zh-CN.md)

Give DSH specialists clear jobs. The Lead handles small tasks directly and brings in help when needed, assigning each specialist a deliverable, file scope, allowed tools, and stopping point.

The plugin loads the delegation rules automatically and checks tool calls against each assignment. No separate skill activation is needed.

## How it works

The Lead chooses the team size based on risk, dependencies, and missing expertise:

| Specialist | Job |
| --- | --- |
| Designer | UI decisions and assigned UI changes |
| Researcher | Read-only research |
| Engineer | Implementation and assigned test code; no check execution |
| Architect | Read-only architecture and diagnosis |
| Verifier | Independent checks using commands assigned by the Lead |

Every specialist needs a complete assignment and cannot delegate, commit, push, or use unauthorized tools. The Lead integrates the work and manages the task board.

Model preferences must use DSH-authorized models. Members inherit the model when no preference is set; reasoning effort is chosen per task. Invalid selections fail explicitly. Restored members keep their saved assignments and model settings.

## Install

Requires **DSH `0.2.1-rc.3`**, **Node.js 22 or later**, and the **Agent Team profile**. Other DSH versions have not been verified.

1. Get this repository and add `"dsh-specialist-team": "link:/absolute/path/to/dsh-specialist-team"` to your DSH profile's dependencies.
2. Add `dsh-specialist-team` to `dsh.profile.bundles`, install the profile dependencies, and reload DSH.
3. Check that `spawn_teammate` has the required `specialist` and `assignment` fields.

The plugin replaces the old Team service and tools, keeps the Team interface, and disables the ordinary subagent entry points. Names and descriptions support English and Chinese. No provider is selected by default; set model preferences in `config.models` on the profile entry `id: specialist-team-tools`.

## Limits

The plugin checks permissions, not work quality, and does not provide an operating system sandbox. Recursive searches and approved commands may access files outside the assigned scope. The Lead must review commands and their side effects.

A restored specialist waits if its Lead is missing. Unloading the plugin blocks existing specialists until their sessions restart. Older members without assignments retain their previous behavior.

See [maintenance](docs/maintenance.md) for development, tests, recovery, and uninstall instructions. Vendored code retains the upstream MIT license; see [source notes](vendor/README.md).
