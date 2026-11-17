import { appendPluginRecord } from '@deepseek-ai/dsh-session';
import z from '@deepseek-ai/schemastery';
import { ASSIGNMENT_RECORD, assignmentIn, leadToolDenial, rolePrompt, toolDenial } from './policy.mjs';
import { COORDINATOR_MODES, routingPrompt } from './prompts.mjs';

export const name = 'specialist-team';
export const inject = ['agents', 'agentTeams', 'tools', 'systemPrompt', 'sessions'];

/**
 * `coordinatorMode`: `off` (default) leaves the Lead's tools alone; `strict` restricts the Lead to dispatch and coordination.
 * The field is volatile, so the settings page can switch it while the plugin keeps running.
 */
export const Config = z.object({
  coordinatorMode: z.union(COORDINATOR_MODES.map(mode => z.const(mode))).default('off').volatile(),
}).default({});

/** Current mode from a volatile reference or a plain string (direct `apply()` callers). */
function modeOf(value) {
  const mode = value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;
  return mode ?? 'off';
}

export function apply(ctx, config = {}) {
  const readMode = () => {
    const mode = modeOf(config.coordinatorMode);
    if (!COORDINATOR_MODES.includes(mode)) throw new Error(`specialist-team: coordinatorMode must be one of ${COORDINATOR_MODES.join(', ')}`);
    return mode;
  };
  readMode();
  const installed = new Map();
  // Per Lead: re-evaluates whether it should present native tools after a mode change.
  const presentations = new Map();
  let stopped = false;
  // The mode in force when the plugin unloaded; the Lead guard keeps enforcing it afterwards.
  let unloadMode;
  const effectiveMode = () => (stopped ? unloadMode : readMode());
  const install = async agent => {
    if (stopped || installed.has(agent)) return;
    const own = assignmentIn(agent, agent.id);
    const membership = ctx.agentTeams.tryMembership(agent);
    if (!membership && !own) return;
    const disposers = [];
    installed.set(agent, disposers);
    if (!own && membership?.role === 'lead') {
      // Strict coordinator mode: Lead only dispatches, coordinates and asks the user.
      // Native presentation keeps run_code, a code-execution entry point the guard cannot inspect, away from a strict Lead.
      let nativeDisposer = null;
      const syncPresentation = () => {
        if (stopped || installed.get(agent) !== disposers) return;
        const strict = readMode() === 'strict';
        if (strict && !nativeDisposer) nativeDisposer = agent.ctx.tools.presentAs('native');
        else if (!strict && nativeDisposer) {
          const dispose = nativeDisposer;
          nativeDisposer = null;
          dispose();
        }
      };
      disposers.push(() => {
        const dispose = nativeDisposer;
        nativeDisposer = null;
        dispose?.();
      });
      presentations.set(agent, syncPresentation);
      syncPresentation();
      // Installed before the prompt and, like the specialist guard, deliberately kept out of
      // `disposers`: unloading the plugin must not return real tools to a strict Lead.
      agent.ctx.tools.guard(exec => {
        if (exec.agent !== agent) return;
        if (effectiveMode() !== 'strict') return;
        // Spawning is the only path that creates assigned members; once the policy is unloaded it would create unrestricted ones.
        if (stopped && exec.name === 'spawn_teammate') return 'Specialist policy was unloaded; restart this Lead session before spawning specialists.';
        return leadToolDenial(exec);
      });
      disposers.push(agent.ctx.systemPrompt.context({
        name: 'specialist-team:routing',
        order: agent.ctx.systemPrompt.getContextOrder('TEAM_IDENTITY'), required: true,
        text: () => routingPrompt(effectiveMode()), interpolate: false,
      }));
      return;
    }
    const assignment = own ?? assignmentIn(membership.root, agent.id);
    // Existing members without an assignment retain their original behavior.
    if (!assignment) return;
    let ready = false;
    disposers.push(agent.ctx.tools.presentAs('native'));
    // The guard belongs to the agent: policy unload revokes it until that agent closes.
    agent.ctx.tools.guard(exec => {
      if (exec.agent !== agent) return;
      if (stopped) return 'Specialist policy was unloaded; restart this specialist session before continuing.';
      if (!ready) return 'Specialist assignment is still loading; retry after initialization.';
      if (!ctx.agentTeams.tryMembership(agent)) return 'Specialist Lead is not loaded; resume the parent Team session before continuing.';
      if (exec.name === 'send_message') return exec.arguments?.target === 'lead' ? undefined : 'Specialists report only to Lead.';
      return toolDenial(assignment, exec);
    });
    if (assignment.version !== 1) throw new Error('Unsupported specialist assignment version');
    if (!own) {
      appendPluginRecord(agent.session, ASSIGNMENT_RECORD, { memberId: agent.id, assignment });
      await ctx.sessions.flush(agent.session);
    }
    if (stopped || installed.get(agent) !== disposers) return;
    disposers.push(agent.ctx.systemPrompt.context({
      name: 'specialist-team:routing',
      order: agent.ctx.systemPrompt.getContextOrder('TEAM_IDENTITY'), required: true,
      text: rolePrompt(assignment), interpolate: false,
    }));
    ready = true;
  };
  ctx.on('agent/created', ({ agent }) => install(agent));
  ctx.on('agent/disposed', ({ agent }) => {
    for (const dispose of installed.get(agent) ?? []) dispose();
    installed.delete(agent);
    presentations.delete(agent);
  });
  // Emitted by the Loader right after it commits a volatile config change into this plugin's references.
  ctx.on('loader/volatile-update', () => {
    for (const sync of presentations.values()) sync();
  });
  ctx.effect(() => () => {
    unloadMode = readMode();
    stopped = true;
    for (const disposers of installed.values()) for (const dispose of disposers) dispose();
    installed.clear();
    presentations.clear();
  });
  return Promise.all(ctx.agents.list().map(install));
}
