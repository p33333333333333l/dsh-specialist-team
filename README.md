# dsh-specialist-team

English | [简体中文](README.zh-CN.md)

The lead can handle simple tasks directly or assign work to specialists with defined responsibilities, file scopes and tools. The bundle adds specialist dispatch to DSH’s native Agent Teams. DSH still provides ordinary subagents and group controls, the team interface and the shared task board.

## Install

Version `0.3.0` requires exactly DSH `0.2.2-rc.4` and Node.js 22 or later. If upgrading, start with the [migration steps](docs/maintenance.md#upgrade-from-02x).

1. Clone this repository and run `npm pack` in the checkout. Add `"dsh-specialist-team": "file:/absolute/path/to/dsh-specialist-team-0.3.0.tgz"` to your DSH profile's dependencies, using the absolute path of the generated package.
2. Add `dsh-specialist-team` to `dsh.profile.bundles`, install the profile dependencies and reload DSH. Check the [expected plugin entries](docs/maintenance.md#installation-checks).
3. Enable **Agent Teams** with DSH’s session toggle in the root session. The root can then use `spawn_teammate` with a required `specialist` and structured `assignment`. Choose `context: fresh` (the default) for a fresh context or `context: fork` to inherit the lead’s transcript.

## Specialists

| Specialist | Work |
| --- | --- |
| Designer | Designs layouts and interactions and makes assigned UI changes |
| Researcher | Finds sources and checks evidence without editing files |
| Engineer | Implements features and writes tests without running checks |
| Architect | Diagnoses problems and compares designs without editing files |
| Verifier | Independently checks results and runs only approved commands |

For independent review, the lead assigns the check to someone other than the implementer. Specialists cannot delegate. Integration, commits and publishing are the lead's responsibility. Tool restrictions apply to registered tool calls. Review what a command and its child processes can affect before approving it.

## Set specialist models

In the plugin manager, open **dsh-specialist-team → Specialist model settings**. Without an explicit route for the assignment or a saved role preference, the specialist inherits the lead’s model.

- After changing the provider, select a model. The existing preference stays in effect until then. Choosing a model, changing its reasoning effort, or clearing the preference saves automatically. Only new specialists use the change.
- Model selection requires a provider/model pair authorized for the root session. For authorization errors, check `enabled` and `allowedModels` in the subagent model selection settings. Choose a reasoning effort listed for that provider and model.

## Strict coordinator mode

With strict mode off (the default), the lead can work directly and call specialists as needed. In strict mode, the lead of an enabled Agent Teams session can coordinate, use the task board and dispatch specialists. Direct work such as file reads and shell commands is blocked. Specialist calls may add to your model bill in either mode.

Switching affects subsequent tool calls. Turn strict mode off before unloading the bundle so the lead’s work tools remain available in the current session.

## Manual configuration (optional)

In the profile’s `cordis.patch.yml`, configure both settings under `dsh-team`. Replace the placeholders with a provider and model ID authorized for your session.

```yaml
- id: dsh-team
  config:
    coordinatorMode: 'off'  # off | strict
    models:
      researcher: { provider: YOUR_PROVIDER, model: YOUR_MODEL }
```

`models` accepts `designer`, `researcher`, `engineer`, `architect` and `verifier`. Each entry may include `reasoningEffort`. Both settings update live. Saving from the settings page can remove comments in the affected YAML block.

## Maintenance and license

The release is licensed under [Apache-2.0](LICENSE). The source repository retains `vendor/` as an archive of earlier upstream code and its MIT license. The release package excludes that archive. For verification, session recovery and removal, see the [maintenance guide](docs/maintenance.md).
