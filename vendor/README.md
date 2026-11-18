# Legacy team implementation and attribution

English | [简体中文](README.zh-CN.md) · [Current plugin guide](../README.md)

This archive documents the team implementation used before version `0.3.0`. For current installation and use, see the plugin guide. Version `0.3.0` uses native DSH Agent Teams and ships without this archive.

The archived code comes from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), tag [`dsh-v0.2.1-rc.3`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.3), commit [`1f81c047`](https://github.com/deepseek-ai/deepseek-harness/commit/1f81c047fc48fa190a683e469daa699857e9afe8).

| Upstream package | Use in this plugin |
| --- | --- |
| [@deepseek-ai/dsh-experimental-agent-team-profile](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.3/packages/experimental/agent-team-profile) | Reference for wiring the Team service, tools, and UI. This plugin registers its own service and tools; it does not install the upstream UI. |
| [@deepseek-ai/dsh-experimental-agent-team](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.3/packages/experimental/agent-team) | [agent-team.mjs](agent-team.mjs): team membership, messages, and the task board. |
| [@deepseek-ai/dsh-experimental-tool-agent-team](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.3/packages/experimental/tool-agent-team) | [tool-agent-team.mjs](tool-agent-team.mjs): Team tools available to the model. |
| [@deepseek-ai/dsh-tool-subagent](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.3/packages/subagent/tool-subagent) | [tool-subagent.mjs](tool-subagent.mjs) and [list-models-l-21_ZpK.mjs](list-models-l-21_ZpK.mjs): model selection and discovery. |

## What changed

The [model-routing patch](model-routing.patch) adds model preferences for five specialist roles, explicit model and reasoning-effort selection, authorization checks, and preflight checks before launch. Its SHA-256 is `834d0eba572af9dc30f602970c2f8965b7da414027dbf45c795927fe0cc73c31`. The patch records the original backport, not every change in the bundled files. Later changes in [tool-agent-team.mjs](tool-agent-team.mjs) report unauthorized preferences and expose `describeModelPreferences` through `team:model-preferences` when assembling the Lead's prompt.

The Team service saves the assignment before creating a member. The Team tools validate structured assignments through [spawn.mjs](../src/spawn.mjs). The [role policies and permission checks](../src/) run without modifying the installed DSH files. After upgrading upstream code, recheck service wiring, tool parameters, and member recovery.

## Licensing

Original contributions and modifications by this project use [Apache-2.0](../LICENSE). Upstream portions of the `.mjs` files and upstream context in the patch retain their [MIT license](LICENSE-MIT). Keep the full upstream copyright and permission notice with redistributed copies. See [NOTICE](../NOTICE) for attribution.
