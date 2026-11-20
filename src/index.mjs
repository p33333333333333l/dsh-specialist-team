import { randomUUID } from 'node:crypto';
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session';
import { parentAgentOptionsForDelegation, resolveChildDepth } from '@deepseek-ai/dsh-subagent';
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import {
  ASSIGNMENT_RECORD, ROLES, assignmentIn, coordinatorAssignmentFrom, groupIdOf, leadToolDenial, rolePrompt,
  scopedAssignment, toolDenial,
} from './policy.mjs';
import { COORDINATOR_MODES, FULL_POWER_LIMITS, routingPrompt } from './prompts.mjs';
import { specialistSpawn } from './spawn.mjs';

export const name = 'specialist-team';
export const inject = ['agents', 'agentTeams', 'subagents', 'tools', 'systemPrompt', 'sessions', 'workingDirectory', 'llm'];
const model = z.object({ provider: z.string().required(), model: z.string().required(), reasoningEffort: z.string() });
export const Config = z.object({
  // `strict` is the pre-0.5 name of full-power mode; saved profiles keep loading.
  coordinatorMode: z.union([...COORDINATOR_MODES, 'strict'].map(mode => z.const(mode))).default('off').volatile(),
  models: z.dict(model, z.union(ROLES.map(role => z.const(role)))).default({}).volatile(),
}).default({});

const readConfig = value => typeof value?.get === 'function' ? value.get() : value;
const text = (description, required = false) => ({ type: 'string', description, ...(required ? { required: true } : {}) });
const CHECK_STATUSES = ['expected_failure', 'passed', 'failed'];
const RESULT_STATUSES = ['delivered', ...CHECK_STATUSES, 'not_run', 'blocked'];
const REPORT_TOOL = 'report_specialist_result';
const GROUP_TOOL = 'spawn_specialist_coordinator';
const GROUP_RECORD = 'plugin:specialist-team/group';
const SUBGROUP_RECORD = 'plugin:specialist-team/subgroup';
const CARD_RECORD = 'plugin:specialist-team/card';
const GROUP_TOOLS = new Set(['spawn_teammate', GROUP_TOOL, REPORT_TOOL, 'team_task_get', 'wait_agent', 'send_message']);
const DONE_STATUSES = new Set(['delivered', 'passed', 'expected_failure']);
const FULL_POWER = 'full-power';
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');
const COORDINATOR_NAME = /^coordinator-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DENIAL_LIMIT = 3;
const pathList = { type: 'array', required: true, items: { type: 'string' } };

function subagentEntry(ctx) {
  // RC4 exposes depth on SubagentRuntime and the active cap on its loader entry.
  const loader = ctx.get('loader');
  const entries = [...(loader?.entries() ?? [])].filter(entry =>
    entry.options.name === '@deepseek-ai/dsh-subagent' && entry.fiber?.state === 2); // FiberState.ACTIVE
  return entries.length === 1 ? entries[0] : undefined;
}

function rootActiveCap(ctx) {
  const capacity = readConfig(subagentEntry(ctx)?.fiber.effectiveConfig?.maxActiveSubagents);
  if (Number.isInteger(capacity) && capacity >= 0) return capacity;
}

// Raise the live subagent limits while full-power mode is on; otherwise put back the user's values.
// Only the running references change, never the profile. A later user edit resets them until the next sync.
function syncSubagentLimits(ctx, raise) {
  const entry = subagentEntry(ctx);
  const live = entry?.fiber.effectiveConfig;
  if (!live) return;
  let saved;
  try {
    saved = entry.fiber.resolveConfig(entry.fiber.rawConfig);
  } catch {
    return;
  }
  for (const [key, floor] of Object.entries(FULL_POWER_LIMITS)) {
    const ref = live[key];
    const own = readConfig(saved?.[key]);
    if (typeof ref?.[VOLATILE_WRITE] !== 'function' || !Number.isInteger(own)) continue;
    const value = raise ? Math.max(own, floor) : own;
    if (ref.get() !== value) ref[VOLATILE_WRITE](value);
  }
}

function requireTask(ctx, lead, taskId, reporter) {
  const task = ctx.agentTeams.getTask(lead, taskId);
  if (!reporter && task.ready) return;
  const owner = reporter ?? lead;
  if (task.status === 'in_progress' && task.ownerId === owner.id &&
      task.blockedBy.every(id => ctx.agentTeams.getTask(lead, id).status === 'completed')) return;
  if (reporter) throw new Error(`Lead must assign the ready native task ${taskId} to you before you can report a result.`);
  throw new Error(`Native task ${taskId} is not ready for this specialist. Check its status, dependencies and owner.`);
}

async function selectModel(ctx, parent, args, preference, signal) {
  const provider = args.provider?.trim() ? args.provider : undefined;
  const model = args.model?.trim() ? args.model : undefined;
  const reasoningEffort = args.reasoning_effort?.trim() ? args.reasoning_effort : undefined;
  const explicit = provider !== undefined || model !== undefined || reasoningEffort !== undefined;
  if (!explicit && !preference) return;
  const route = explicit ? { provider, model, reasoningEffort } : preference;
  if (!route.provider?.trim() || !route.model?.trim() || route.reasoningEffort === '') {
    throw new Error('Specify a nonempty provider and model together, with an optional reasoning effort.');
  }
  // Read the first recorded decision, matching RC4's native model selection.
  const policy = parent.session.snapshotEvents().find(event => event.type === 'subagent/model-selection-policy');
  const inherited = parentAgentOptionsForDelegation(parent);
  const routes = policy ? policy.data.allowedModels : [inherited];
  if (!Array.isArray(routes) || !routes.some(candidate => candidate.provider === route.provider && candidate.model === route.model)) {
    throw new Error(`Child LLM route "${route.provider}/${route.model}" is not allowed for this Session.`);
  }
  await ctx.llm.resolveCallConfig(route, signal);
  return { provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort };
}

// Keep one guard and executor per live Agent across plugin reloads.
const agentPolicy = Symbol.for('dsh-specialist-team.agent-policy');

export function apply(ctx, config = {}) {
  const pending = new Map();
  const installed = new Set();
  const startingGroups = new Set();
  const groupStarts = new Map();
  const serializeGroupStart = async (id, run) => {
    const previous = groupStarts.get(id);
    const next = (previous ?? Promise.resolve()).then(run);
    const settled = next.then(() => {}, () => {});
    groupStarts.set(id, settled);
    try { return await next; }
    finally { if (groupStarts.get(id) === settled) groupStarts.delete(id); }
  };
  const groupFor = (lead, id) => lead[agentPolicy]?.groups?.get(id);
  const coordinatorOf = agent => {
    const assignment = agent?.[agentPolicy]?.assignment;
    return assignment?.role === 'coordinator' ? assignment : undefined;
  };
  const isOpenGroupTask = (lead, taskId) => {
    const { status } = ctx.agentTeams.getTask(lead, taskId);
    return status !== 'completed' && status !== 'deleted';
  };
  // A coordinator can nest only when its sub-coordinator's specialists still fit the host depth cap.
  const canNest = agent => {
    if (!coordinatorOf(agent)) return false;
    const depth = ctx.subagents.resolveMaxDepth();
    return depth === undefined || resolveChildDepth(agent, undefined) + 1 <= depth;
  };
  // Count coordinators that hold or may reclaim a root-tree slot: live ones and those of open groups.
  const allocatedCoordinators = async (lead, signal) => {
    const tops = new Set([...lead[agentPolicy].groups].filter(([id, taskId]) =>
      ctx.agents.get(id) !== undefined || isOpenGroupTask(lead, taskId)).map(([id]) => id));
    const entries = await ctx.subagents.listDescendants(lead.id, signal);
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    const topOf = entry => { while (entry && entry.depth > 1) entry = byId.get(entry.parentId); return entry?.id; };
    const nested = entries.filter(entry => entry.depth > 1 && COORDINATOR_NAME.test(entry.path?.split('/').at(-1) ?? '')
      && (ctx.agents.get(entry.id) !== undefined || tops.has(topOf(entry))));
    return tops.size + nested.length;
  };
  const preflightGroup = async (lead, signal) => {
    const depth = ctx.subagents.resolveMaxDepth();
    const coordinatorDepth = resolveChildDepth(lead, undefined);
    if (depth !== undefined && depth <= coordinatorDepth) {
      throw new Error(`Group coordination needs depth ${coordinatorDepth + 1}; the host cap is ${depth}. Ask the user before switching to flat dispatch.`);
    }
    const cap = rootActiveCap(ctx);
    if (cap === undefined) return;
    if (cap < 2) {
      throw new Error(`Group coordination needs two root-tree slots; the host cap is ${cap}. Ask the user before switching to flat dispatch.`);
    }
    // Leave a specialist slot even if every open coordinator wakes up at once.
    if (await allocatedCoordinators(lead, signal) >= cap - 1) {
      throw new Error(`Keep this group queued. With ${cap} root-tree slots, finish an existing group and let its coordinator exit before starting another so specialists have room to run.`);
    }
  };
  // A direct child costs 1; a sub-coordinator also reserves its own budget, used or not.
  // Each level enforces its own budget, so the whole subtree stays within the Lead-approved total.
  const checkBudget = async (parent, coordinator, cost, signal) => {
    const reserved = parent[agentPolicy].subgroups;
    const used = (await ctx.subagents.listDescendants(parent.id, signal))
      .filter(entry => entry.depth === 1)
      .reduce((sum, entry) => sum + 1 + (reserved.get(entry.id) ?? 0), 0);
    const max = coordinator.max_specialists;
    if (used + cost <= max) return;
    throw new Error(cost === 1
      ? `This group reached its ${max}-specialist start limit.`
      : `A sub-coordinator costs 1 plus its max_specialists (${cost} starts); only ${Math.max(0, max - used)} of this group's ${max}-specialist start limit remain.`);
  };
  // The group must still exist and its card must stay with the top coordinator.
  const requireGroup = (parent, coordinator) => {
    const lead = ctx.subagents.rootOf(parent);
    const groupId = groupIdOf(coordinator, parent.id);
    if (!isLead(lead) || groupFor(lead, groupId) !== coordinator.task_id) throw new Error('The specialist group is unavailable.');
    requireTask(ctx, lead, coordinator.task_id, { id: groupId });
    return lead;
  };
  const lifetime = new AbortController();
  // Interrupt a member that keeps hitting guard denials and tell its direct creator why.
  const stopLooping = async (agent, toolName, reason) => {
    try {
      const lead = ctx.subagents.rootOf(agent);
      ctx.subagents.interrupt(agent.id, { kind: 'ancestor', agent: lead });
      const entry = (await ctx.subagents.listDescendants(lead.id, lifetime.signal)).find(item => item.id === agent.id);
      const text = `${ctx.subagents.namesOf(agent).self} was stopped after ${DENIAL_LIMIT} tool denials in a row. Last denied ${toolName}: ${reason}\nRemove the blocker or adjust the assignment before messaging it to continue, or close it.`;
      await ctx.subagents.sendMessage(agent, entry?.parentId ?? lead.id, [{ type: 'text', text }], { signal: lifetime.signal });
    } catch (error) {
      ctx.logger?.warn?.(`specialist-team: could not stop looping member ${agent.id}: ${error?.message ?? error}`);
    }
  };
  const useNativeExecutor = agent => {
    const policy = agent[agentPolicy];
    if (policy.nativeExecutor) return;
    agent.ctx.tools.setExecutor(new NativeToolExecutor(agent.ctx));
    policy.nativeExecutor = true;
  };
  const mode = () => {
    const value = readConfig(config.coordinatorMode) ?? 'off';
    return value === 'strict' ? FULL_POWER : value;
  };
  const syncLimits = () => syncSubagentLimits(ctx, !stopped && mode() === FULL_POWER);
  // The member's current sandbox mode, or undefined when this composition has no sandbox policy.
  const sandboxModeOf = agent => {
    try {
      return ctx.get('sandboxPolicy')?.resolve({ session: agent.session }).mode;
    } catch {
      return undefined;
    }
  };
  let stopped = false;
  let lastMode;
  // A restored member whose root is not live has no resolvable names.
  const namesOf = agent => {
    try {
      return ctx.subagents.namesOf(agent);
    } catch (error) {
      if (error.code !== 'UNAUTHORIZED') throw error;
      return {};
    }
  };
  const isLead = agent => {
    if (!agent) return false;
    try {
      return ctx.subagents.rootOf(agent) === agent && ctx.agentTeams.isEnabled(agent);
    } catch (error) {
      if (error.code !== 'UNAUTHORIZED') throw error;
      return false;
    }
  };

  const start = async (parent, args, assignment, signal, agentOptions, childId = randomUUID()) => {
    pending.set(childId, assignment);
    try {
      const started = await ctx.subagents.startActivation({
        childId, parent, name: args.name, label: args.description,
        provider: args.context === 'fork' ? 'fork' : 'spawn', cwd: assignment.cwd,
        prompt: [{ type: 'text', text: args.prompt }],
        maxDepth: ctx.subagents.resolveMaxDepth(), signal, delivery: 'parent',
        ...agentOptions === undefined ? {} : { agentOptions },
      });
      return { name: started.name, id: childId };
    } finally {
      pending.delete(childId);
    }
  };

  // Every started member owns a card: the Lead-provided one, or one the plugin creates for it.
  // Cards are created only after a successful start so a failed start leaves no unowned card.
  const assignCard = async (lead, memberId, taskId, subject, description) => {
    let card;
    try {
      card = taskId === undefined
        ? await ctx.agentTeams.createTask(lead, { subject, description })
        : ctx.agentTeams.getTask(lead, taskId);
      await ctx.agentTeams.updateTask(lead, { taskId: card.id, expectedRevision: card.revision, action: 'reassign', owner: memberId });
    } catch (error) {
      ctx.logger?.warn?.(`specialist-team: could not assign a card to member ${memberId}: ${error?.message ?? error}`);
      if (taskId === undefined && card) {
        await ctx.agentTeams.updateTask(lead, { taskId: card.id, expectedRevision: card.revision, action: 'delete' }).catch(() => {});
      }
      return false;
    }
    if (taskId !== undefined) return true;
    lead[agentPolicy]?.cards?.set(memberId, card.id);
    appendPluginRecord(lead.session, CARD_RECORD, { leadId: lead.id, memberId, taskId: card.id });
    try {
      await ctx.sessions.flush(lead.session);
    } catch (error) {
      ctx.logger?.warn?.(`specialist-team: could not save the card of member ${memberId}: ${error?.message ?? error}`);
    }
    return true;
  };

  // Coordinator starts anywhere in one root tree share a lock so each slot check sees the previous start.
  const serializeSlotStart = (lead, run) => serializeGroupStart(`slots:${lead.id}`, run);
  const startSubgroup = (parent, coordinator, args, exec) => {
    const signal = AbortSignal.any([exec.signal, lifetime.signal]);
    const nested = coordinatorAssignmentFrom(args.assignment, ctx.workingDirectory.get(parent.session));
    const assignment = scopedAssignment(nested, coordinator, parent.id);
    return serializeGroupStart(groupIdOf(coordinator, parent.id), async () => {
      signal.throwIfAborted();
      const lead = requireGroup(parent, coordinator);
      if (!canNest(parent)) {
        throw new Error(`A sub-coordinator and its specialists need depth ${resolveChildDepth(parent, undefined) + 1}; the host cap is ${ctx.subagents.resolveMaxDepth()}. Dispatch specialists directly.`);
      }
      await checkBudget(parent, coordinator, 1 + assignment.max_specialists, signal);
      return serializeSlotStart(lead, async () => {
        const cap = rootActiveCap(ctx);
        if (cap !== undefined && await allocatedCoordinators(lead, signal) >= cap - 1) {
          throw new Error(`With ${cap} root-tree slots, another sub-coordinator would leave no slot for specialists. Dispatch specialists directly or wait for a sub-coordinator to exit.`);
        }
        signal.throwIfAborted();
        requireGroup(parent, coordinator);
        const childId = randomUUID();
        appendPluginRecord(parent.session, SUBGROUP_RECORD, { parentId: parent.id, coordinatorId: childId, max_specialists: assignment.max_specialists });
        await ctx.sessions.flush(parent.session);
        const started = await start(parent, args, assignment, signal, undefined, childId);
        parent[agentPolicy].subgroups.set(childId, assignment.max_specialists);
        await assignCard(lead, childId, undefined, args.description, assignment.deliverable);
        return { name: started.name, next: 'It shares your group card and starts on its own; wait for its subgroup receipt.' };
      });
    });
  };

  const install = async agent => {
    if (stopped || installed.has(agent)) return;
    installed.add(agent);
    const initial = pending.get(agent.id);
    // Keep denials in the Agent scope so unloading cannot grant capabilities.
    let policy = agent[agentPolicy];
    if (!policy) {
      policy = { check: () => 'Specialist policy is still loading.' };
      agent.ctx.tools.guard(exec => exec.agent === agent ? policy.check(exec) : undefined);
      Object.defineProperty(agent, agentPolicy, { value: policy });
    }
    let loading = true;
    let assignment = policy.assignment;
    let denials = 0;
    policy.check = exec => {
      if (stopped && assignment) return 'Specialist policy was unloaded. Reopen this session before continuing.';
      if (loading) return 'Specialist policy is still loading.';
      if (!assignment) return check(exec);
      const reason = check(exec);
      if (!reason) {
        denials = 0;
        return;
      }
      // Prompts alone do not stop a model that keeps retrying a denied call, so the guard stops the run.
      if (++denials < DENIAL_LIMIT) return `${reason} (Denial ${denials} of ${DENIAL_LIMIT} in a row; at ${DENIAL_LIMIT} this run is stopped.)`;
      denials = 0;
      void stopLooping(agent, exec.name, reason);
      return `${reason} This was denial ${DENIAL_LIMIT} in a row, so the plugin stopped this run and told your parent agent. Do not retry.`;
    };
    const check = exec => {
      if (!assignment) {
        const full = stopped ? lastMode === FULL_POWER && policy.teamEnabled : mode() === FULL_POWER && isLead(agent);
        return full ? leadToolDenial(exec) : undefined;
      }
      if (assignment.role === 'coordinator') {
        if (!GROUP_TOOLS.has(exec.name)) return 'Group coordinators can only dispatch specialists or sub-coordinators, check their group card, and report.';
        if (exec.name === 'team_task_get' && exec.arguments?.task_id !== assignment.task_id) return 'Only your group task card is available.';
        if (exec.name === 'send_message') return messageDenial(exec, true);
        return;
      }
      if (exec.name === REPORT_TOOL) return;
      if (exec.name === 'send_message') return messageDenial(exec, false);
      return toolDenial(assignment, exec, ctx.workingDirectory.get(agent.session), sandboxModeOf(agent));
    };
    // Members may ask their direct parent; coordinators may also answer their direct members.
    const messageDenial = (exec, coordinator) => {
      const target = exec.arguments?.agent;
      const { self, parent } = namesOf(agent);
      if (parent !== undefined && target === parent) return;
      const child = self !== undefined && typeof target === 'string' && target.startsWith(`${self}/`) ? target.slice(self.length + 1) : '';
      if (coordinator && child && !child.includes('/')) return;
      return coordinator ? 'Coordinators message only their direct parent and their direct members.' : 'Specialists message only their direct parent.';
    };
    const own = assignmentIn(agent, agent.id);
    assignment = own ?? initial;
    if (assignment) {
      useNativeExecutor(agent);
      if (!own) {
        appendPluginRecord(agent.session, ASSIGNMENT_RECORD, { memberId: agent.id, assignment });
        await ctx.sessions.flush(agent.session);
      }
      if (assignment.role === 'coordinator') {
        policy.subgroups = new Map();
        const cataloged = new Set();
        for (const event of agent.session.snapshotEvents(agent.session.inheritedEventCount ?? 0)) {
          if (event.type === 'subagent/catalog') cataloged.add(event.data.childId);
          const record = pluginRecordOf(event);
          if (record?.type === SUBGROUP_RECORD && record.data?.parentId === agent.id) {
            policy.subgroups.set(record.data.coordinatorId, record.data.max_specialists);
          }
        }
        for (const id of policy.subgroups.keys()) if (!cataloged.has(id)) policy.subgroups.delete(id);
      }
    } else {
      policy.teamEnabled = isLead(agent);
      policy.groups = new Map();
      policy.cards = new Map();
      const cataloged = new Set();
      for (const event of agent.session.snapshotEvents(agent.session.inheritedEventCount ?? 0)) {
        if (event.type === 'subagent/catalog') cataloged.add(event.data.childId);
        const record = pluginRecordOf(event);
        if (record?.type === GROUP_RECORD && record.data?.leadId === agent.id) {
          policy.groups.set(record.data.coordinatorId, record.data.taskId);
        }
        if (record?.type === CARD_RECORD && record.data?.leadId === agent.id) {
          policy.cards.set(record.data.memberId, record.data.taskId);
        }
      }
      // A prepared group is usable only after DSH commits the native child.
      for (const id of policy.groups.keys()) if (!cataloged.has(id)) policy.groups.delete(id);
      if (policy.teamEnabled && mode() === FULL_POWER) useNativeExecutor(agent);
    }
    policy.assignment = assignment;
    loading = false;
  };

  ctx.on('agent/created', ({ agent }) => install(agent));
  ctx.on('agent/disposed', ({ agent }) => installed.delete(agent));
  ctx.on('loader/volatile-update', () => {
    syncLimits();
    if (mode() === FULL_POWER) for (const agent of installed) if (isLead(agent)) useNativeExecutor(agent);
  });
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'team/mode') return;
    const agent = ctx.agents.get(session.id);
    if (!installed.has(agent)) return;
    const policy = agent[agentPolicy];
    // Keep the last Team mode for the guard that outlives this plugin context.
    policy.teamEnabled = event.data.enabled;
    if (policy.teamEnabled && mode() === FULL_POWER) useNativeExecutor(agent);
  });
  ctx.systemPrompt.context({
    name: 'specialist-team:routing',
    order: ctx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
    required: true,
    interpolate: false,
    text: ({ agent }) => {
      if (!agent) return '';
      const assignment = agent[agentPolicy]?.assignment;
      if (assignment) return rolePrompt(assignment, canNest(agent), namesOf(agent).parent);
      if (!isLead(agent)) return '';
      syncLimits();
      return routingPrompt(mode(), ctx.subagents.resolveMaxDepth(), rootActiveCap(ctx));
    },
  });

  ctx.tools.register(defineTool({
    name: REPORT_TOOL,
    description: 'Send a concise final result to your immediate coordinator, or to Lead for your task card.',
    parameters: {
      status: { type: 'string', required: true, enum: RESULT_STATUSES, description: 'Outcome of the deliverable or check.' },
      summary: text('Key finding or deliverable, including paths when useful.', true),
      checks: { type: 'array', items: { type: 'string' }, description: 'Actual checks run and observed results. Required for expected_failure, passed and failed.' },
      limits: text('Checks skipped, coverage limits or blockers.'),
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { messageId: text('Accepted inbox message ID.', true) } },
      render: (_args, value) => [{ type: 'text', text: `Sent result (${value.messageId}).` }],
    },
    async execute({ status, summary, checks = [], limits }, exec) {
      const specialist = exec.agent;
      const assignment = specialist?.[agentPolicy]?.assignment;
      const lead = ctx.subagents.rootOf(specialist);
      if (!isLead(lead)) throw new Error('Agent Teams must be enabled to report a task result.');
      const cardId = lead[agentPolicy]?.cards?.get(specialist.id);
      const coordinatorId = assignment?.coordinator_id;
      const taskId = assignment?.task_id ?? cardId;
      if (!assignment || (taskId === undefined && coordinatorId === undefined)) throw new Error('A linked native task or coordinator is required.');
      if (coordinatorId) {
        const groupId = groupIdOf(assignment, specialist.id);
        const taskId = groupFor(lead, groupId);
        if (!taskId) throw new Error('The specialist group is unavailable.');
        requireTask(ctx, lead, taskId, { id: groupId });
      } else {
        requireTask(ctx, lead, taskId, specialist);
      }
      if (!summary.trim() || checks.some(check => !check.trim())) {
        throw new Error('Provide a non-empty summary and concrete check descriptions.');
      }
      if (CHECK_STATUSES.includes(status) && (assignment.role !== 'verifier' || !checks.length)) {
        throw new Error(`${status} requires an independent verifier and at least one check.`);
      }
      const targetId = coordinatorId ?? lead.id;
      const subject = coordinatorId ? ctx.subagents.namesOf(specialist).self : taskId;
      const result = [
        `Specialist result for ${subject}: ${status}`,
        summary.trim(),
        ...checks.map(check => `Check: ${check.trim()}`),
        ...(limits?.trim() ? [`Limits: ${limits.trim()}`] : []),
      ].join('\n');
      const messageId = await ctx.subagents.sendMessage(specialist, targetId, [{ type: 'text', text: result }], { signal: exec.signal });
      // A plugin-created card closes with its owner's successful result; Lead-provided cards stay for Lead review.
      if (cardId !== undefined && DONE_STATUSES.has(status)) {
        try {
          const card = ctx.agentTeams.getTask(lead, cardId);
          if (card.status === 'in_progress' && card.ownerId === specialist.id) {
            await ctx.agentTeams.updateTask(lead, { taskId: cardId, expectedRevision: card.revision, action: 'complete' });
          }
        } catch (error) {
          ctx.logger?.warn?.(`specialist-team: could not complete card ${cardId}: ${error?.message ?? error}`);
        }
      }
      return { messageId };
    },
  }), { when: ({ agent }) => !stopped && agent?.[agentPolicy]?.assignment !== undefined });

  const startGroup = async (lead, args, assignment, signal) => {
    const taskId = assignment.task_id;
    const groups = lead[agentPolicy].groups;
    const childId = randomUUID();
    await preflightGroup(lead, signal);
    requireTask(ctx, lead, taskId);
    signal.throwIfAborted();
    appendPluginRecord(lead.session, GROUP_RECORD, { leadId: lead.id, coordinatorId: childId, taskId });
    await ctx.sessions.flush(lead.session);
    requireTask(ctx, lead, taskId);
    const started = await start(lead, args, assignment, signal, undefined, childId);
    groups.set(childId, taskId);
    const owned = await assignCard(lead, childId, taskId);
    try {
      await ctx.sessions.flush(lead.session);
    } catch (error) {
      throw new Error(`Coordinator ${started.name} started for ${taskId}, but saving the native catalog failed. Check the team before retrying.`, { cause: error });
    }
    return {
      name: started.name,
      next: owned ? 'It owns the group card and starts on its own; wait for its group receipt.' : 'Assigning the group card failed: reassign it with team_task_update, then message the coordinator to begin.',
    };
  };

  ctx.tools.register(defineTool({
    name: GROUP_TOOL,
    description: 'Start a fresh coordinator for one native group task, or a sub-coordinator inside your group. In off mode, use only when the user opts into multi-level dispatch.',
    parameters: {
      name: text('Unique coordinator-<group> name, up to 32 characters.', true),
      description: text('Short label for the native agent tree.', true),
      prompt: text('Group instructions and acceptance criteria.', true),
      assignment: {
        type: 'object', required: true, additionalProperties: false,
        properties: {
          task_id: text('Ready native task ID for the group. Sub-coordinators reuse their parent group task ID.', true),
          deliverable: text('Group deliverable.', true),
          stop_when: text('Stop after the group meets this condition or is blocked.', true),
          read_paths: { ...pathList, description: 'Allowed read paths for the group.' },
          write_paths: { ...pathList, description: 'Allowed write paths for the group.' },
          commands: { type: 'array', items: { type: 'string' }, description: 'Exact verifier commands permitted in this group.' },
          max_specialists: { type: 'integer', required: true, description: 'Positive total of starts allowed in this group subtree, counting specialists and sub-coordinators.' },
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { name: text('Native coordinator name.', true), next: text('Next step for the caller.', true) } },
      render: (_args, value) => [{ type: 'text', text: `Started ${value.name}. ${value.next}` }],
    },
    async execute(args, exec) {
      syncLimits();
      const lead = exec.agent;
      if (args.name.length > 32 || !COORDINATOR_NAME.test(args.name)) {
        throw new Error('Use coordinator-<group> with lowercase letters, digits, and single hyphens, up to 32 characters.');
      }
      const parentCoordinator = coordinatorOf(lead);
      if (!stopped && parentCoordinator) return startSubgroup(lead, parentCoordinator, args, exec);
      if (stopped || !isLead(lead)) throw new Error('Only the native Team Lead or a group coordinator can start a coordinator.');
      const assignment = coordinatorAssignmentFrom(args.assignment, ctx.workingDirectory.get(lead.session));
      const taskId = assignment.task_id;
      if (startingGroups.has(lead.id)) throw new Error('Wait for the current coordinator start to finish.');
      if ([...lead[agentPolicy].groups.values()].includes(taskId)) throw new Error(`A coordinator was already started for ${taskId}. Continue that coordinator or use a new group card.`);
      const signal = AbortSignal.any([exec.signal, lifetime.signal]);
      startingGroups.add(lead.id);
      try {
        return await serializeSlotStart(lead, () => startGroup(lead, args, assignment, signal));
      } finally {
        startingGroups.delete(lead.id);
      }
    },
  }), { when: ({ agent }) => !stopped && (isLead(agent) || canNest(agent)) });

  ctx.tools.register(defineTool(specialistSpawn({
    name: 'spawn_teammate',
    description: 'Create a scoped specialist in the native Agent Team.',
    parameters: {
      name: text('Unique name in <specialist>-<task> form, e.g. researcher-read-docs. Use lowercase letters, digits, and single hyphens, up to 32 characters total.', true),
      description: text('Short label for the native agent tree.', true),
      prompt: text('Task instructions for the specialist.', true),
      context: { type: 'string', enum: ['fresh', 'fork'], description: 'Defaults to fresh. Fork shares the Lead transcript.' },
      provider: text('Optional authorized model provider.'),
      model: text('Optional authorized model ID.'),
      reasoning_effort: text('Optional reasoning effort for the selected route.'),
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { name: text('Native teammate name.', true) } },
      render: (_args, value) => [{ type: 'text', text: `Started specialist ${value.name}` }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      syncLimits();
      const parent = exec.agent;
      const coordinator = coordinatorOf(parent);
      const signal = AbortSignal.any([exec.signal, lifetime.signal]);
      if (coordinator) {
        if (args.context === 'fork') throw new Error('Group specialists must use fresh context.');
        if ([args.provider, args.model, args.reasoning_effort].some(value => value !== undefined)) {
          throw new Error('Group coordinators cannot override Lead-configured specialist model routes.');
        }
        const assignment = scopedAssignment(args.specialistAssignment, coordinator, parent.id);
        return serializeGroupStart(groupIdOf(coordinator, parent.id), async () => {
          signal.throwIfAborted();
          requireGroup(parent, coordinator);
          resolveChildDepth(parent, ctx.subagents.resolveMaxDepth());
          await checkBudget(parent, coordinator, 1, signal);
          const agentOptions = await selectModel(ctx, parent, args, readConfig(config.models)?.[args.specialist], signal);
          signal.throwIfAborted();
          requireGroup(parent, coordinator);
          const started = await start(parent, args, assignment, signal, agentOptions);
          await assignCard(ctx.subagents.rootOf(parent), started.id, undefined, args.description, assignment.deliverable);
          return { name: started.name };
        });
      }
      if (!isLead(parent)) throw new Error('Enable Agent Teams in the root session before spawning a specialist.');
      const agentOptions = await selectModel(ctx, parent, args, readConfig(config.models)?.[args.specialist], signal);
      signal.throwIfAborted();
      if (stopped || !isLead(parent)) throw new Error('Enable Agent Teams in the root session before spawning a specialist.');
      const assignment = args.specialistAssignment;
      if (assignment.task_id !== undefined) requireTask(ctx, parent, assignment.task_id);
      const started = await start(parent, args, assignment, signal, agentOptions);
      await assignCard(parent, started.id, assignment.task_id, args.description, assignment.deliverable);
      return { name: started.name };
    },
  }, agent => ctx.workingDirectory.get(agent.session))), { when: ({ agent }) => !stopped && (isLead(agent) || !!coordinatorOf(agent)) });

  ctx.effect(() => () => {
    lastMode = mode();
    stopped = true;
    syncLimits();
    lifetime.abort();
    installed.clear();
  });
  syncLimits();
  return Promise.all(ctx.agents.list().map(install));
}
