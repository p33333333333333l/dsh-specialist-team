import { randomUUID } from 'node:crypto';
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session';
import { parentAgentOptionsForDelegation, resolveChildDepth } from '@deepseek-ai/dsh-subagent';
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import {
  ASSIGNMENT_RECORD, ROLES, assignmentIn, coordinatorAssignmentFrom, leadToolDenial, rolePrompt,
  scopedAssignment, toolDenial,
} from './policy.mjs';
import { COORDINATOR_MODES, routingPrompt } from './prompts.mjs';
import { specialistSpawn } from './spawn.mjs';

export const name = 'specialist-team';
export const inject = ['agents', 'agentTeams', 'subagents', 'tools', 'systemPrompt', 'sessions', 'workingDirectory', 'llm'];
const model = z.object({ provider: z.string().required(), model: z.string().required(), reasoningEffort: z.string() });
export const Config = z.object({
  coordinatorMode: z.union(COORDINATOR_MODES.map(mode => z.const(mode))).default('off').volatile(),
  models: z.dict(model, z.union(ROLES.map(role => z.const(role)))).default({}).volatile(),
}).default({});

const readConfig = value => typeof value?.get === 'function' ? value.get() : value;
const text = (description, required = false) => ({ type: 'string', description, ...(required ? { required: true } : {}) });
const CHECK_STATUSES = ['expected_failure', 'passed', 'failed'];
const RESULT_STATUSES = ['delivered', ...CHECK_STATUSES, 'not_run', 'blocked'];
const REPORT_TOOL = 'report_specialist_result';
const GROUP_TOOL = 'spawn_specialist_coordinator';
const GROUP_RECORD = 'plugin:specialist-team/group';
const GROUP_TOOLS = new Set(['spawn_teammate', REPORT_TOOL, 'team_task_get', 'wait_agent']);
const pathList = { type: 'array', required: true, items: { type: 'string' } };

function rootActiveCap(ctx) {
  // RC4 exposes depth on SubagentRuntime and the active cap on its loader entry.
  const loader = ctx.get('loader');
  const entries = [...(loader?.entries() ?? [])].filter(entry =>
    entry.options.name === '@deepseek-ai/dsh-subagent' && entry.fiber?.state === 2); // FiberState.ACTIVE
  if (entries.length !== 1) return;
  const capacity = readConfig(entries[0].fiber.effectiveConfig?.maxActiveSubagents);
  if (Number.isInteger(capacity) && capacity >= 0) return capacity;
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
  const hasOpenGroup = lead => [...(lead[agentPolicy]?.groups?.values() ?? [])]
    .some(taskId => isOpenGroupTask(lead, taskId));
  const preflightGroup = lead => {
    const depth = ctx.subagents.resolveMaxDepth();
    const coordinatorDepth = resolveChildDepth(lead, undefined);
    if (depth !== undefined && depth <= coordinatorDepth) {
      throw new Error(`Two-level coordination needs depth ${coordinatorDepth + 1}; the host cap is ${depth}. Ask the user before switching to flat dispatch.`);
    }
    const cap = rootActiveCap(ctx);
    if (cap === undefined) return;
    if (cap < 2) {
      throw new Error(`Two-level coordination needs two root-tree slots; the host cap is ${cap}. Ask the user before switching to flat dispatch.`);
    }
    // Leave a specialist slot even if every open group wakes up at once.
    const allocated = [...lead[agentPolicy].groups].filter(([id, taskId]) =>
      ctx.agents.get(id) !== undefined || isOpenGroupTask(lead, taskId));
    if (allocated.length >= cap - 1) {
      throw new Error(`Keep this group queued. With ${cap} root-tree slots, finish an existing group and let its coordinator exit before starting another so specialists have room to run.`);
    }
  };
  const lifetime = new AbortController();
  const useNativeExecutor = agent => {
    const policy = agent[agentPolicy];
    if (policy.nativeExecutor) return;
    agent.ctx.tools.setExecutor(new NativeToolExecutor(agent.ctx));
    policy.nativeExecutor = true;
  };
  const mode = () => readConfig(config.coordinatorMode) ?? 'off';
  let stopped = false;
  let lastMode;
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
      return await ctx.subagents.startActivation({
        childId, parent, name: args.name, label: args.description,
        provider: args.context === 'fork' ? 'fork' : 'spawn', cwd: assignment.cwd,
        prompt: [{ type: 'text', text: args.prompt }],
        maxDepth: ctx.subagents.resolveMaxDepth(), signal, delivery: 'parent',
        ...agentOptions === undefined ? {} : { agentOptions },
      });
    } finally {
      pending.delete(childId);
    }
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
    policy.check = exec => {
      if (stopped && assignment) return 'Specialist policy was unloaded. Reopen this session before continuing.';
      if (loading) return 'Specialist policy is still loading.';
      if (!assignment) {
        const strict = stopped ? lastMode === 'strict' && policy.teamEnabled : mode() === 'strict' && isLead(agent);
        if (policy.teamEnabled && (startingGroups.has(agent.id) || hasOpenGroup(agent))) {
          if (exec.name === 'spawn_teammate') return `During group coordination, dispatch through ${GROUP_TOOL}.`;
          return leadToolDenial(exec);
        }
        return strict ? leadToolDenial(exec) : undefined;
      }
      if (assignment.role === 'coordinator') {
        if (!GROUP_TOOLS.has(exec.name)) return 'Group coordinators can only dispatch specialists, check their group card, and report.';
        if (exec.name === 'team_task_get' && exec.arguments?.task_id !== assignment.task_id) return 'Only your group task card is available.';
        return;
      }
      if (exec.name === REPORT_TOOL && (assignment.task_id !== undefined || assignment.coordinator_id !== undefined)) return;
      if (assignment.coordinator_id && exec.name === 'send_message') return 'Use report_specialist_result to report to your coordinator.';
      if (exec.name === 'send_message') {
        return exec.arguments?.agent === 'lead' ? undefined : 'Specialists report only to Lead.';
      }
      return toolDenial(assignment, exec, ctx.workingDirectory.get(agent.session));
    };
    const own = assignmentIn(agent, agent.id);
    assignment = own ?? initial;
    if (assignment) {
      useNativeExecutor(agent);
      if (!own) {
        appendPluginRecord(agent.session, ASSIGNMENT_RECORD, { memberId: agent.id, assignment });
        await ctx.sessions.flush(agent.session);
      }
    } else {
      policy.teamEnabled = isLead(agent);
      policy.groups = new Map();
      const cataloged = new Set();
      for (const event of agent.session.snapshotEvents(agent.session.inheritedEventCount ?? 0)) {
        if (event.type === 'subagent/catalog') cataloged.add(event.data.childId);
        const record = pluginRecordOf(event);
        if (record?.type === GROUP_RECORD && record.data?.leadId === agent.id) {
          policy.groups.set(record.data.coordinatorId, record.data.taskId);
        }
      }
      // A prepared group is usable only after DSH commits the native child.
      for (const id of policy.groups.keys()) if (!cataloged.has(id)) policy.groups.delete(id);
      if (policy.teamEnabled && (mode() === 'strict' || hasOpenGroup(agent))) useNativeExecutor(agent);
    }
    policy.assignment = assignment;
    loading = false;
  };

  ctx.on('agent/created', ({ agent }) => install(agent));
  ctx.on('agent/disposed', ({ agent }) => installed.delete(agent));
  ctx.on('loader/volatile-update', () => {
    if (mode() === 'strict') for (const agent of installed) if (isLead(agent)) useNativeExecutor(agent);
  });
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'team/mode' && event.type !== 'team/task') return;
    const agent = ctx.agents.get(session.id);
    if (!installed.has(agent)) return;
    const policy = agent[agentPolicy];
    if (event.type === 'team/mode') {
      // Keep the last Team mode for the guard that outlives this plugin context.
      policy.teamEnabled = event.data.enabled;
      if (policy.teamEnabled && (mode() === 'strict' || hasOpenGroup(agent))) useNativeExecutor(agent);
    } else if (policy.teamEnabled && event.data.task.status !== 'completed' && event.data.task.status !== 'deleted'
        && [...(policy.groups?.values() ?? [])].includes(event.data.task.id)) {
      useNativeExecutor(agent);
    }
  });
  ctx.systemPrompt.context({
    name: 'specialist-team:routing',
    order: ctx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
    required: true,
    interpolate: false,
    text: ({ agent }) => {
      if (!agent) return '';
      const assignment = agent[agentPolicy]?.assignment;
      if (assignment) return rolePrompt(assignment);
      return isLead(agent) ? routingPrompt(mode(), ctx.subagents.resolveMaxDepth(), rootActiveCap(ctx)) : '';
    },
  });

  ctx.tools.register(defineTool({
    name: REPORT_TOOL,
    description: 'Send a concise result to your immediate coordinator, or to Lead for a native task.',
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
      if (assignment?.task_id === undefined && assignment?.coordinator_id === undefined) throw new Error('A linked native task or coordinator is required.');
      const lead = ctx.subagents.rootOf(specialist);
      if (!isLead(lead)) throw new Error('Agent Teams must be enabled to report a task result.');
      const coordinatorId = assignment.coordinator_id;
      if (coordinatorId) {
        const taskId = groupFor(lead, coordinatorId);
        if (!taskId) throw new Error('The specialist group is unavailable.');
        requireTask(ctx, lead, taskId, { id: coordinatorId });
      } else {
        requireTask(ctx, lead, assignment.task_id, specialist);
      }
      if (!summary.trim() || checks.some(check => !check.trim())) {
        throw new Error('Provide a non-empty summary and concrete check descriptions.');
      }
      if (CHECK_STATUSES.includes(status) && (assignment.role !== 'verifier' || !checks.length)) {
        throw new Error(`${status} requires an independent verifier and at least one check.`);
      }
      const targetId = coordinatorId ?? lead.id;
      const subject = coordinatorId ? ctx.subagents.namesOf(specialist).self : assignment.task_id;
      const result = [
        `Specialist result for ${subject}: ${status}`,
        summary.trim(),
        ...checks.map(check => `Check: ${check.trim()}`),
        ...(limits?.trim() ? [`Limits: ${limits.trim()}`] : []),
      ].join('\n');
      const messageId = await ctx.subagents.sendMessage(specialist, targetId, [{ type: 'text', text: result }], { signal: exec.signal });
      return { messageId };
    },
  }), { when: ({ agent }) => {
    const assignment = agent?.[agentPolicy]?.assignment;
    return !stopped && (assignment?.task_id !== undefined || assignment?.coordinator_id !== undefined);
  } });

  ctx.tools.register(defineTool({
    name: GROUP_TOOL,
    description: 'Start a fresh coordinator for one native group task. Use only when the user opts into two-level dispatch.',
    parameters: {
      name: text('Unique coordinator-<group> name, up to 32 characters.', true),
      description: text('Short label for the native agent tree.', true),
      prompt: text('Group instructions and acceptance criteria.', true),
      assignment: {
        type: 'object', required: true, additionalProperties: false,
        properties: {
          task_id: text('Ready native task ID for the group.', true),
          deliverable: text('Group deliverable.', true),
          stop_when: text('Stop after the group meets this condition or is blocked.', true),
          read_paths: { ...pathList, description: 'Allowed read paths for the group.' },
          write_paths: { ...pathList, description: 'Allowed write paths for the group.' },
          commands: { type: 'array', items: { type: 'string' }, description: 'Exact verifier commands permitted in this group.' },
          max_specialists: { type: 'integer', required: true, description: 'Positive total of fresh specialist starts allowed in this group.' },
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { name: text('Native coordinator name.', true) } },
      render: (_args, value) => [{ type: 'text', text: `Started ${value.name}. Reassign the group card, then message the coordinator to begin.` }],
    },
    async execute(args, exec) {
      const lead = exec.agent;
      if (stopped || !isLead(lead)) throw new Error('Only the native Team Lead can start a group coordinator.');
      if (args.name.length > 32 || !/^coordinator-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(args.name)) {
        throw new Error('Use coordinator-<group> with lowercase letters, digits, and single hyphens, up to 32 characters.');
      }
      const assignment = coordinatorAssignmentFrom(args.assignment, ctx.workingDirectory.get(lead.session));
      const taskId = assignment.task_id;
      const groups = lead[agentPolicy].groups;
      if (startingGroups.has(lead.id)) throw new Error('Wait for the current coordinator start to finish.');
      if ([...groups.values()].includes(taskId)) throw new Error(`A coordinator was already started for ${taskId}. Continue that coordinator or use a new group card.`);
      preflightGroup(lead);
      requireTask(ctx, lead, taskId);
      const signal = AbortSignal.any([exec.signal, lifetime.signal]);
      const childId = randomUUID();
      startingGroups.add(lead.id);
      try {
        signal.throwIfAborted();
        useNativeExecutor(lead);
        appendPluginRecord(lead.session, GROUP_RECORD, { leadId: lead.id, coordinatorId: childId, taskId });
        await ctx.sessions.flush(lead.session);
        requireTask(ctx, lead, taskId);
        const started = await start(lead, args, assignment, signal, undefined, childId);
        groups.set(childId, taskId);
        try {
          await ctx.sessions.flush(lead.session);
        } catch (error) {
          throw new Error(`Coordinator ${started.name} started for ${taskId}, but saving the native catalog failed. Check the team before retrying.`, { cause: error });
        }
        return { name: started.name };
      } finally {
        startingGroups.delete(lead.id);
      }
    },
  }), { when: ({ agent }) => !stopped && isLead(agent) });

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
      const parent = exec.agent;
      const coordinator = coordinatorOf(parent);
      const signal = AbortSignal.any([exec.signal, lifetime.signal]);
      if (coordinator) {
        if (args.context === 'fork') throw new Error('Group specialists must use fresh context.');
        if ([args.provider, args.model, args.reasoning_effort].some(value => value !== undefined)) {
          throw new Error('Group coordinators cannot override Lead-configured specialist model routes.');
        }
        const assignment = scopedAssignment(args.specialistAssignment, coordinator, parent.id);
        return serializeGroupStart(parent.id, async () => {
          signal.throwIfAborted();
          const lead = ctx.subagents.rootOf(parent);
          if (!isLead(lead) || groupFor(lead, parent.id) !== coordinator.task_id) throw new Error('The specialist group is unavailable.');
          resolveChildDepth(parent, ctx.subagents.resolveMaxDepth());
          requireTask(ctx, lead, coordinator.task_id, parent);
          const descendants = await ctx.subagents.listDescendants(parent.id, signal);
          if (descendants.filter(entry => entry.depth === 1).length >= coordinator.max_specialists) {
            throw new Error(`This group reached its ${coordinator.max_specialists}-specialist start limit.`);
          }
          const agentOptions = await selectModel(ctx, parent, args, readConfig(config.models)?.[args.specialist], signal);
          signal.throwIfAborted();
          requireTask(ctx, lead, coordinator.task_id, parent);
          const started = await start(parent, args, assignment, signal, agentOptions);
          return { name: started.name };
        });
      }
      if (!isLead(parent)) throw new Error('Enable Agent Teams in the root session before spawning a specialist.');
      const agentOptions = await selectModel(ctx, parent, args, readConfig(config.models)?.[args.specialist], signal);
      signal.throwIfAborted();
      if (stopped || !isLead(parent) || startingGroups.has(parent.id) || hasOpenGroup(parent)) {
        throw new Error('Direct specialist dispatch is unavailable during group coordination.');
      }
      const assignment = args.specialistAssignment;
      if (assignment.task_id !== undefined) requireTask(ctx, parent, assignment.task_id);
      const started = await start(parent, args, assignment, signal, agentOptions);
      return { name: started.name };
    },
  }, agent => ctx.workingDirectory.get(agent.session))), { when: ({ agent }) => !stopped && (isLead(agent) || !!coordinatorOf(agent)) });

  ctx.effect(() => () => {
    lastMode = mode();
    stopped = true;
    lifetime.abort();
    installed.clear();
  });
  return Promise.all(ctx.agents.list().map(install));
}
