import { appendPluginRecord } from '@deepseek-ai/dsh-session';
import { ASSIGNMENT_RECORD, assignmentIn, rolePrompt, toolDenial } from './policy.mjs';
import { ROUTING_PROMPT } from './prompts.mjs';

export const name = 'specialist-team';
export const inject = ['agents', 'agentTeams', 'tools', 'systemPrompt', 'sessions'];

export function apply(ctx) {
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
      disposers.push(agent.ctx.systemPrompt.context({
        name: 'specialist-team:routing',
        order: agent.ctx.systemPrompt.getContextOrder('TEAM_IDENTITY'), required: true,
        text: ROUTING_PROMPT, interpolate: false,
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
