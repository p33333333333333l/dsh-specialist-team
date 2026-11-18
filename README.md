# dsh-specialist-team

English | [简体中文](README.zh-CN.md)

Assign work to specialists with a specific deliverable, file scope, and set of tools. Specialists join DSH’s native Agent Teams and share the team tree, messages, and task board with ordinary teammates.

## Install and try it

Version `0.3.0` requires **DSH `0.2.2-rc.4`** and **Node.js 22 or newer**. The canonical package is attached to the [v0.3.0 release](https://github.com/p33333333333333l/dsh-specialist-team/releases/tag/v0.3.0).

1. Install the release package in DSH’s plugin manager using its `.tgz` URL, or run the following command for the `web` profile. Replace `web` if your installation uses a different profile.

   ```sh
   dsh plugin --profile web add https://github.com/p33333333333333l/dsh-specialist-team/releases/download/v0.3.0/dsh-specialist-team-0.3.0.tgz
   ```

2. Open a root conversation and turn on **Agent Teams**. If the plugin manager reports a pending change, reload DSH first.
3. Ask the lead to delegate a bounded task. For example, “Ask a researcher to read only the project README and report which DSH version it requires.” The lead uses `spawn_teammate` to name the role and specify the deliverable, read and write paths, tools, reviewer, and stop condition. Specialists start with fresh context by default. Use `context: fork` when the task needs the lead’s conversation history.

## Choose a specialist

| Role | Use it for |
| --- | --- |
| Designer | Design layouts and interactions or edit assigned UI files. |
| Researcher | Find sources and check evidence with read-only tools. |
| Engineer | Implement changes and write tests. Assign test execution to a verifier. |
| Architect | Diagnose problems and compare designs with read-only tools. |
| Verifier | Independently check the result and run commands specified in the assignment. |

The lead integrates results, commits, and publishes. For independent verification, give the check to a separate specialist. Tool and path restrictions apply to registered calls. Review each verification command for effects on files and subprocesses before assigning it.

## Set specialist models

Open **Plugins → Specialist Team → Specialist model settings**. Select both a provider and a model for each role you want to configure. Changes save automatically and apply to new specialists. The lead’s model is used when the assignment and the role have no model preference.

If DSH rejects a provider/model pair, enable model selection for subagents, add the exact pair to the allowed list, and open a new root conversation. Choose a reasoning effort offered by the provider for that model.

## Let the lead coordinate only

In **Specialist model settings**, turn on **Strict coordinator mode** to keep the lead focused on assigning work and using the task board. While Agent Teams is on, specialist assignments handle direct work such as reading files or running commands. The default is off, so the lead can do that work directly. Specialist calls may add to model costs in either mode.

Turn strict mode off before uninstalling. If the lead previously used Programmatic Tool Calling (PTC), reopen the conversation after turning strict mode off to restore that executor.

## Configure from YAML

For manual setup, use the `dsh-team` entry in the profile’s `cordis.patch.yml`. Replace the example provider and model IDs with a pair authorized in DSH.

```yaml
- id: dsh-team
  config:
    coordinatorMode: 'off'  # off | strict
    models:
      researcher: { provider: YOUR_PROVIDER, model: YOUR_MODEL }
```

Model keys are `designer`, `researcher`, `engineer`, `architect`, and `verifier`. Each can also set `reasoningEffort`. Saving through the settings page can remove comments in the edited YAML block.

## Troubleshoot an upgrade from 0.2.x

If you configured a previous version manually, move model preferences from `dsh-team-tools.config.models` to `dsh-team.config.models`. Remove the overrides you added for `dsh-team-tools` and `dsh-team-service` and restore any native Team entries or delegation groups you disabled for the old version. Reload DSH, then enable Agent Teams in a new root conversation. Old team sessions remain available as history. Their membership and task lists stay with those sessions.

## Source and license

Run `npm install` and `npm test` in a checkout to verify the source. See the [Apache-2.0 license](LICENSE) and [attribution notice](NOTICE).
