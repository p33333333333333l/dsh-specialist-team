import { appendPluginRecord } from '@deepseek-ai/dsh-session';
import { ASSIGNMENT_RECORD, assignmentIn, leadToolDenial, rolePrompt, toolDenial } from './policy.mjs';
import { z } from 'zod';
import { COORDINATOR_MODES, routingPrompt } from './prompts.mjs';

export const name = 'specialist-team';
export const inject = ['agents', 'agentTeams', 'tools', 'systemPrompt', 'sessions'];

/** `coordinatorMode`: `off` (default) leaves the Lead's tools alone; `strict` restricts the Lead to dispatch and coordination. */
export const Config = z.object({ coordinatorMode: z.enum(COORDINATOR_MODES).default('off') }).default({ coordinatorMode: 'off' });

export function apply(ctx, config = {}) {
  const coordinatorMode = config.coordinatorMode ?? 'off';
  if (!COORDINATOR_MODES.includes(coordinatorMode)) throw new Error(`specialist-team: coordinatorMode must be one of ${COORDINATOR_MODES.join(', ')}`);
  const strict = coordinatorMode === 'strict';
  const installed = new Map();
  let stopped = false;
  const install = async agent => {
    if (stopped || installed.has(agent)) return;
    const own = assignmentIn(agent, agent.id);
    const membership = ctx.agentTeams.tryMembership(agent);
    if (!membership && !own) return;
    const disposers = [];
    installed.set(agent, disposers);
    if (!own && membership?.role === 'lead') {
      if (strict) {
        // Strict coordinator mode: Lead only dispatches, coordinates and asks the user.
        disposers.push(agent.ctx.tools.presentAs('native'));
        // Installed before the prompt and, like the specialist guard, deliberately kept out of
        // `disposers`: unloading the plugin must not return real tools to the Lead.
        agent.ctx.tools.guard(exec => {
          if (exec.agent !== agent) return;
          // Spawning is the only path that creates assigned members; once the policy is unloaded it would create unrestricted ones.
          if (stopped && exec.name === 'spawn_teammate') return 'Specialist policy was unloaded; restart this Lead session before spawning specialists.';
          return leadToolDenial(exec);
        });
      }
      disposers.push(agent.ctx.systemPrompt.context({
        name: 'specialist-team:routing',
        order: agent.ctx.systemPrompt.getContextOrder('TEAM_IDENTITY'), required: true,
        text: routingPrompt(coordinatorMode), interpolate: false,
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
  });
  ctx.effect(() => () => {
    stopped = true;
    for (const disposers of installed.values()) for (const dispose of disposers) dispose();
    installed.clear();
  });
  return Promise.all(ctx.agents.list().map(install));
}
