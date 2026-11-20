# Advanced reference

[Quick start](../README.md) · [简体中文](advanced.zh-CN.md)

## Call the assignment tool directly

Use `spawn_teammate` in the main conversation with Agent Teams enabled. Select the specialist role and specify the deliverable, allowed read and write paths, allowed tools, reviewer, and stop condition. For a verifier, include the exact commands it may run. The main agent integrates changes after review. In full-power mode, it assigns the commit and push commands to a verifier instead.

Choose a unique name that starts with the selected role, such as `researcher-read-docs`. Use lowercase ASCII letters and digits, with a single hyphen between segments. The name can be up to 32 characters long. If creation fails because of the name, check the role prefix, format, and whether the team already uses that name.

Use `context: fork` to share the main conversation’s history. Omit the optional model fields to use the role preference or, if none is set, the main agent’s model. Blank model fields are treated as omitted. To name a model directly, pass both `provider` and `model`. If you pass `reasoning_effort`, use a level supported by that pair.

Tool and path restrictions apply to registered tool calls. They do not sandbox subprocesses. Before assigning a verifier command, check what it and any subprocesses can read, change, or access over the network. Specialists and coordinators run in their own session's sandbox mode. They may pass `sandbox_permissions` equal to or narrower than that mode, but the plugin rejects any wider mode.

If a specialist or coordinator has 3 tool calls denied in a row, the plugin stops its run and messages its direct parent with the last denied tool and reason. Any allowed call resets the count. Remove the blocker or adjust the assignment before you message it to continue.

## Task cards and receipts

Every specialist and coordinator started through the plugin owns a card on the native board:

- **With a task ID.** Create a native task, then pass its ID as `assignment.task_id` in `spawn_teammate`. The task’s dependencies must be complete. The plugin assigns the card to the specialist once it starts.
- **Without a task ID.** The plugin creates a card from the assignment’s description and deliverable and assigns it to the new member.

When done, the specialist calls `report_specialist_result` with `status`, `summary`, and, when applicable, `checks` and `limits`. The statuses `expected_failure`, `passed`, and `failed` require a verifier to list the checks it ran. Other statuses are `delivered`, `not_run`, and `blocked`. The receipt names the member’s card and reaches its direct parent as a native message.

Who completes the card depends on who created it. The plugin completes its own cards when the member reports `delivered`, `passed`, or `expected_failure`; after `failed`, `not_run`, or `blocked` the card stays in progress. A card the main agent created stays open until the main agent reviews the receipt and completes it.

Ordinary teammates started with `subagent` do not go through the plugin, so they get no automatic card. The main agent creates and assigns cards for them.

## Questions and messages

A specialist can message only its direct parent. A coordinator can also message its own direct members. Members take questions to their parent first; the parent answers or passes the question up, and only the main agent asks the user.

## Multi-level dispatch

Users can request multi-level dispatch for a task. In full-power mode the main agent uses it by default, and the raised limits (depth 3, 100 subagents) meet the requirements below. DSH must allow a subagent depth of at least 2 and at least two active slots shared across the agent tree. The number of levels follows the DSH subagent depth: with depth 2 the tree is main agent → coordinator → specialist, and each extra level lets a coordinator start a sub-coordinator. With a depth of 1, the main agent explains the limit and asks the user before switching to direct dispatch.

1. The **main agent** creates one native task card per group. Once dependencies are complete, it starts the coordinator using `spawn_specialist_coordinator`. The plugin assigns the card to the coordinator, which starts on its own.
2. The **coordinator** uses `spawn_teammate` to assign specialists within the approved paths and exact verifier commands. `max_specialists` caps the number of starts in the group's whole subtree over its lifetime. Specialists report to their own coordinator.
   When the depth allows, a coordinator can split off a subgroup with `spawn_specialist_coordinator`. The sub-coordinator reuses the group card, its paths and commands must stay within its parent's, and it reports to its parent coordinator. Its start costs 1 plus its own `max_specialists`, which must fit the parent's remaining budget. A coordinator whose sub-coordinator would have no depth left for specialists cannot nest.
3. The **coordinator** sends one group report covering checks run, coverage, and blockers. The **main agent** reviews it and closes the card.

**When slots are tight**, the plugin limits new coordinator and sub-coordinator starts to leave a slot for specialists if it can read the host cap. With two slots, wait for the current card to close and its coordinator to exit before starting the next group. Other teammates share those slots, and DSH checks availability on each start.

**If startup reports an error**, check the native team list first. If the coordinator is listed, continue using it. Reopen the conversation if needed to recover the link to its card. If the coordinator is absent, fix the reported cause and retry with the same card.

## Edit the profile YAML

Add or update `dsh-team` in the profile’s `cordis.patch.yml`. Replace the example IDs with a provider and model allowed in DSH.

```yaml
- id: dsh-team
  config:
    coordinatorMode: 'off'  # off | full-power (legacy strict reads as full-power)
    models:
      researcher: { provider: YOUR_PROVIDER, model: YOUR_MODEL }
```

Use `designer`, `researcher`, `engineer`, `architect`, or `verifier` as the role key. Each role may also set `reasoningEffort`. Saving through the settings page can remove comments in the edited YAML block.

## Restore Programmatic Tool Calling

While full-power mode is on, the main agent uses native tool calls. To restore Programmatic Tool Calling (PTC), turn full-power mode off and reopen the conversation.

## Verify the source

Run `npm install` and then `npm test` in a checkout.
