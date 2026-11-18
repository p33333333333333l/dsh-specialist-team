# dsh-specialist-team

English | [简体中文](README.zh-CN.md)

Assign work to specialists with a specific deliverable, file scope, and set of tools. Specialists join DSH’s native Agent Teams and share the team tree, messages, and task board with ordinary teammates.

## Install and try it

Version `0.3.2` requires **DSH `0.2.2-rc.4`** and **Node.js 22 or newer**. The canonical package is attached to the [v0.3.2 release](https://github.com/p33333333333333l/dsh-specialist-team/releases/tag/v0.3.2).

1. Install the release package in DSH’s plugin manager using its `.tgz` URL, or run the following command for the `web` profile. Replace `web` if your installation uses a different profile.

   ```sh
   dsh plugin --profile web add https://github.com/p33333333333333l/dsh-specialist-team/releases/download/v0.3.2/dsh-specialist-team-0.3.2.tgz
   ```

2. Open a root conversation and turn on **Agent Teams**. If the plugin manager reports a pending change, reload DSH first.
3. Ask the lead to delegate a bounded task. For example, “Ask a researcher to read only the project README and report which DSH version it requires.” The lead uses `spawn_teammate` to name the role and specify the deliverable, read and write paths, tools, reviewer, and stop condition. Specialists start with fresh context by default. Use `context: fork` when the task needs the lead’s conversation history.

New specialists need a unique name in `<role>-<task>` form, such as `researcher-read-docs`. Use lowercase ASCII letters and digits separated by single hyphens, with up to 32 characters total. `spawn_teammate` rejects names that do not match the assigned role or this format.

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

Open **Plugins → Specialist Team → Specialist model settings**. Select both a provider and a model for each role you want to configure. Changes save automatically and apply to new specialists. The lead’s model is used when the assignment and the role have no model preference. Blank optional model fields in the spawn call are treated as omitted.

![The Specialist Team plugin page with the model settings entry and the running dsh-team component](docs/specialist-settings.jpg)

If DSH rejects a provider/model pair, enable model selection for subagents, add the exact pair to the allowed list, and open a new root conversation. Choose a reasoning effort offered by the provider for that model. If the model stops supporting a saved effort, select **No effort preference** to clear it while keeping the provider and model.

## Let the lead coordinate only

In **Specialist model settings**, turn on **Strict coordinator mode** to keep the lead focused on assigning work and using the task board. While Agent Teams is on, specialist assignments handle direct work such as reading files or running commands. The default is off, so the lead can do that work directly. Specialist calls may add to model costs in either mode.

Open specialist conversations pause tool use while the plugin is disabled. When you enable it again, they resume with their original assignments. Turn strict mode off before uninstalling. If the lead previously used Programmatic Tool Calling (PTC), reopen the conversation after turning strict mode off to restore that executor.

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

## Source and license

Run `npm install` and `npm test` in a checkout to verify the source. See the [Apache-2.0 license](LICENSE) and [attribution notice](NOTICE).
