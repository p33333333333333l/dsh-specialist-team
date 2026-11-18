import { randomUUID } from 'node:crypto';
import { appendPluginRecord } from '@deepseek-ai/dsh-session';
import { parentAgentOptionsForDelegation } from '@deepseek-ai/dsh-subagent';
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { ASSIGNMENT_RECORD, ROLES, assignmentIn, leadToolDenial, rolePrompt, toolDenial } from './policy.mjs';
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

async function selectModel(ctx, parent, args, preference, signal) {
  const explicit = [args.provider, args.model, args.reasoning_effort].some(value => value !== undefined);
  if (!explicit && !preference) return;
  const route = explicit ? { provider: args.provider, model: args.model, reasoningEffort: args.reasoning_effort } : preference;
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
        return strict ? leadToolDenial(exec) : undefined;
      }
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
      if (mode() === 'strict' && policy.teamEnabled) useNativeExecutor(agent);
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
    if (event.type !== 'team/mode') return;
    const agent = ctx.agents.get(session.id);
    if (!installed.has(agent)) return;
    // Keep the last Team mode for the guard that outlives this plugin context.
    agent[agentPolicy].teamEnabled = event.data.enabled;
    if (event.data.enabled && mode() === 'strict') useNativeExecutor(agent);
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
      return isLead(agent) ? routingPrompt(mode()) : '';
    },
  });

  ctx.tools.register(defineTool(specialistSpawn({
    name: 'spawn_teammate',
    description: 'Create a scoped specialist in the native Agent Team.',
    parameters: {
      name: text('Unique native teammate name.', true),
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
      if (!isLead(parent)) throw new Error('Enable Agent Teams in the root session before spawning a specialist.');
      const signal = AbortSignal.any([exec.signal, lifetime.signal]);
      const agentOptions = await selectModel(ctx, parent, args, readConfig(config.models)?.[args.specialist], signal);
      signal.throwIfAborted();
      if (stopped || !isLead(parent)) throw new Error('Specialist dispatch is no longer available in this session.');
      const childId = randomUUID();
      pending.set(childId, args.specialistAssignment);
      try {
        const started = await ctx.subagents.startActivation({
          childId, parent, name: args.name, label: args.description,
          provider: args.context === 'fork' ? 'fork' : 'spawn',
          cwd: args.specialistAssignment.cwd,
          prompt: [{ type: 'text', text: args.prompt }],
          maxDepth: ctx.subagents.resolveMaxDepth(),
          signal, delivery: 'parent',
          ...agentOptions === undefined ? {} : { agentOptions },
        });
        return { name: started.name };
      } finally {
        pending.delete(childId);
      }
    },
  }, agent => ctx.workingDirectory.get(agent.session))), { when: ({ agent }) => isLead(agent) });

  ctx.effect(() => () => {
    lastMode = mode();
    stopped = true;
    lifetime.abort();
    installed.clear();
  });
  return Promise.all(ctx.agents.list().map(install));
}
