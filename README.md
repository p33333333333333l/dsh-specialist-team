# DSH Specialist Team

English | [简体中文](README.zh-CN.md)

The lead can handle simple tasks directly or assign work to specialists with defined responsibilities, file access and tools. Delegation rules load with the plugin; no skill activation is needed.

## Install

Requires DSH `0.2.1-rc.3` and Node.js 22+. Other DSH versions are untested.

1. Clone this repository. Add `"dsh-specialist-team": "link:/absolute/path/to/dsh-specialist-team"` to your DSH profile's dependencies, using the absolute path of your checkout.
2. Add `dsh-specialist-team` to `dsh.profile.bundles`, install the profile dependencies and reload DSH.
3. Use the [installation checklist](docs/maintenance.md#installation-checks) on the plugins page. `spawn_teammate` should now include `specialist` and `assignment`.

## Specialists

| Specialist | Work |
| --- | --- |
| Designer | Designs layouts and interactions and makes assigned UI changes |
| Researcher | Finds sources and checks evidence without editing files |
| Engineer | Implements features and writes tests without running checks |
| Architect | Diagnoses problems and compares designs without editing files |
| Verifier | Independently checks results and runs only approved commands |

For independent review, the lead assigns the check to someone other than the implementer. Specialists cannot delegate. Integration, commits and publishing are the lead's responsibility. Tool restrictions apply to registered tool calls; they are not an OS sandbox. Review what a command and its child processes can affect before approving it.

## Set specialist models

In the plugin manager, open **Specialist Team → Specialist model settings**. Specialists without a preference inherit the lead's model by default.

- After changing the provider, select a model. The existing preference stays in effect until then. Choosing a model, changing its reasoning effort, or clearing the preference saves automatically. Only new members use the change.
- Model selection requires a provider/model pair authorized for the session. This page does not grant access. For authorization errors, check `enabled` and `allowedModels` in the subagent model selection settings. Choose a reasoning effort listed for that provider and model.

## Strict coordinator mode

The same settings page has a strict coordinator switch, off by default. The lead can still assign tasks and track progress, but fewer tools are available to it directly. Turn the switch off if the lead needs a tool blocked by this mode, or perform the operation yourself.

Switching affects subsequent tool calls and does not interrupt operations already under way. Before unloading the plugin, turn strict mode off. Otherwise the current lead remains restricted and cannot create members until its session is restarted.

## Manual configuration (optional)

You can also edit the profile's `cordis.patch.yml`. Replace the placeholders with a provider and model ID authorized for your session:

```yaml
- id: dsh-team-tools
  config:
    modelSelectionSettings: true
    models:
      researcher: { provider: YOUR_PROVIDER, model: YOUR_MODEL }
- id: dsh-team
  config:
    coordinatorMode: 'off'  # off | strict
```

`models` accepts `designer`, `researcher`, `engineer`, `architect` and `verifier`. Each entry may include `reasoningEffort`. Both `models` and `coordinatorMode` update live. Saving from the settings page can remove comments in the affected YAML block. Changes to `interrupt`, `freshProvider`, `forkProvider` or `modelSelectionSettings` restart the tools plugin.

## Maintenance and license

See [maintenance](docs/maintenance.md) for component conflicts, tests, session recovery and uninstall steps. Original contributions use [Apache-2.0](LICENSE); bundled upstream code retains its [MIT license](vendor/LICENSE-MIT). See [source details](vendor/README.md) and [NOTICE](NOTICE) for attribution and scope.
