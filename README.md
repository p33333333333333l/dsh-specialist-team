# DSH Specialist Team

[English](README.md) | [简体中文](README.zh-CN.md)

Small tasks stay with the lead agent. Larger tasks go to specialists with clear jobs and tool permissions. Delegation rules load automatically; no skill activation is needed.

Built on DeepSeek's [@deepseek-ai/dsh-experimental-agent-team-profile](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.3/packages/experimental/agent-team-profile). This plugin adds specialist assignments, model preferences, and tool restrictions. See [source details](vendor/README.md).

## Specialists

| Specialist | Job |
| --- | --- |
| Designer | UI decisions and assigned UI changes |
| Researcher | Read-only research |
| Engineer | Code and assigned tests; does not run checks |
| Architect | Read-only architecture and diagnosis |
| Verifier | Independent checks using approved commands |

The lead agent chooses the team, assigns file and tool access, and integrates the results. Specialists cannot delegate or commit changes.

## Install

Requires **DSH `0.2.1-rc.3`**, **Node.js 22+**, and the upstream Agent Team profile linked above. Other DSH versions are untested.

1. Clone this repository. Add `"dsh-specialist-team": "link:/absolute/path/to/dsh-specialist-team"` to your DSH profile's dependencies.
2. Add `dsh-specialist-team` to `dsh.profile.bundles`, install the dependencies, and reload DSH.
3. Confirm that `spawn_teammate` includes `specialist` and `assignment`.

This replaces the Team service and tools, retains the Team interface, and disables ordinary subagent entry points. Members inherit the model by default. Optional model preferences go in `config.models` on `id: specialist-team-tools` and must use authorized models.

## Limits

Tool restrictions are not an OS sandbox. Approved commands and recursive searches can reach beyond assigned files; review commands before granting access. The model remains responsible for delegation decisions and work quality.

For tests, recovery, and uninstall instructions, see [maintenance](docs/maintenance.md).
