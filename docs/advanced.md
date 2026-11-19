# Advanced reference

[Quick start](../README.md) · [简体中文](advanced.zh-CN.md)

## Call the assignment tool directly

Use `spawn_teammate` in the main conversation with Agent Teams enabled. Select the specialist role and specify the deliverable, allowed read and write paths, allowed tools, reviewer, and stop condition. For a verifier, include the exact commands it may run. The main agent integrates changes after review.

Choose a unique name that starts with the selected role, such as `researcher-read-docs`. Use lowercase ASCII letters and digits, with a single hyphen between segments. The name can be up to 32 characters long. If creation fails because of the name, check the role prefix, format, and whether the team already uses that name.

Use `context: fork` to share the main conversation’s history. Omit the optional model fields to use the role preference or, if none is set, the main agent’s model. Blank model fields are treated as omitted. To name a model directly, pass both `provider` and `model`. If you pass `reasoning_effort`, use a level supported by that pair.

Tool and path restrictions apply to registered tool calls. They do not sandbox subprocesses. Before assigning a verifier command, check what it and any subprocesses can read, change, or access over the network.

## Link an assignment to a task card

After creating a native task, pass its ID as `assignment.task_id` in `spawn_teammate`. The task’s dependencies must be complete. Once the specialist starts, the main agent assigns it the task on the native board so it can send the receipt. Assignments without a task ID still work as before.

A linked specialist can call `report_specialist_result` with `status`, `summary`, and, when applicable, `checks` and `limits`. The statuses `expected_failure`, `passed`, and `failed` require a verifier to list the checks it ran. Other statuses are `delivered`, `not_run`, and `blocked`. The receipt uses the task ID saved in the assignment and reaches the main agent as a native message. The main agent reviews the receipt and completes the matching task on the board.

## Check dispatch limits

Only the main agent can dispatch specialists. Its system prompt shows the current DSH depth cap, the total active-child cap for the root tree, and the coordinator mode. Existing work can reduce the available slots. If the active-child cap is unavailable, DSH still checks capacity when starting a teammate. For requests with nested dispatch or a concurrency target, the prompt tells the main agent to check the limits and ask for agreement before proceeding with a different arrangement.

## Edit the profile YAML

Add or update `dsh-team` in the profile’s `cordis.patch.yml`. Replace the example IDs with a provider and model allowed in DSH.

```yaml
- id: dsh-team
  config:
    coordinatorMode: 'off'  # off | strict
    models:
      researcher: { provider: YOUR_PROVIDER, model: YOUR_MODEL }
```

Use `designer`, `researcher`, `engineer`, `architect`, or `verifier` as the role key. Each role may also set `reasoningEffort`. Saving through the settings page can remove comments in the edited YAML block.

## Restore Programmatic Tool Calling

If the main agent used Programmatic Tool Calling (PTC) before strict coordinator mode was enabled, turn strict mode off and reopen the conversation to restore that tool executor.

## Verify the source

Run `npm install` and then `npm test` in a checkout.
