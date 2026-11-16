import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import Agents from '@deepseek-ai/dsh-agent';
import Sessions from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Llm, { LlmAdapter } from '@deepseek-ai/dsh-llm';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools, { defineContentToolFixture } from '@deepseek-ai/dsh-tools';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import Fs from '@deepseek-ai/dsh-fs-local';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import Subagents from '@deepseek-ai/dsh-subagent';
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process';
import * as Fork from '@deepseek-ai/dsh-subagent-fork-in-process';
import Team from '../vendor/agent-team.mjs';
import * as TeamTools from '../vendor/tool-agent-team.mjs';
import * as Policy from '../src/index.mjs';

class Adapter extends LlmAdapter {
  requests = [];
  async *stream(options) {
    this.requests.push(options);
    await new Promise(resolve => {
      if (options.signal.aborted) resolve();
      else options.signal.addEventListener('abort', resolve, { once: true });
    });
  }
}
async function setup(root, mode = 'native') {
  const ctx = new Context();
  for (const plugin of [Agents, Sessions, Projections, Llm, SystemPrompt, Fs]) await ctx.plugin(plugin);
  await ctx.plugin(Tools, { mode });
  await ctx.plugin(WorkingDirectory, { defaultDirectory: root });
  await ctx.plugin(Persistence, { root: join(root, 'sessions') });
  await ctx.plugin(AgentLoop, { agents: [] });
  await ctx.plugin(Subagents);
  await ctx.plugin(Spawn);
  await ctx.plugin(Fork);
  await ctx.plugin(Team);
  await ctx.plugin(TeamTools);
  const policyFiber = await ctx.plugin(Policy);
  const adapter = new Adapter();
  ctx.llm.registerAdapter(['mock'], adapter);
  return { ctx, adapter, policyFiber };
}
const args = (root, name, context = 'fresh') => ({ name, description: 'Read files', prompt: 'Inspect assigned files', context, specialist: 'researcher', assignment: {
  deliverable: 'Read-only report', read_paths: [root], write_paths: [], allowed_tools: ['read'], commands: [], reviewer: 'lead', stop_when: 'Report delivered',
} });
const execute = (ctx, agent, name, parameters) => ctx.tools.execute({ callId: `${name}-${Math.random()}`, name, agent, arguments: parameters, signal: new AbortController().signal });
async function spinUntil(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await setImmediate();
  }
  assert.fail('Expected asynchronous observation did not arrive');
}

test('real services guard fresh/fork first requests and cold-restored child without parent', { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'specialist-integration-'));
  let current;
  try {
    current = await setup(root);
    const { ctx, adapter } = current;
    const lead = await ctx.agentLoop.create('integration-lead', { provider: 'mock', model: 'mock' }, { cwd: root });
    const prompt = await ctx.systemPrompt.assemble({ agent: lead, scope: lead });
    assert.ok(prompt.contexts.some(s => s.name === 'specialist-team:routing'));
    const definition = ctx.tools.get('spawn_teammate', lead);
    assert.ok(definition.parameters.required.includes('assignment'));
    const ids = [];
    for (const context of ['fresh', 'fork']) {
      const result = await execute(ctx, lead, 'spawn_teammate', args(root, `reader-${context}`, context));
      assert.equal(result.isError, false, JSON.stringify(result));
      const member = ctx.agentTeams.listMembers(lead).find(m => m.name === `reader-${context}`);
      const child = ctx.agents.get(member.id);
      ids.push(child.id);
      const assembled = await ctx.systemPrompt.assemble({ agent: child, scope: child });
      assert.ok(assembled.contexts.some(s => s.text.includes('researcher specialist')));
      const denied = await execute(ctx, child, 'write', { file_path: join(root, 'bad'), content: 'no' });
      assert.equal(denied.isError, true);
      assert.match(JSON.stringify(denied), /does not allow write/);
      assert.ok(child.session.snapshotEvents(0).some(e => e.type === 'plugin:specialist-team/assignment' && e.data.memberId === child.id));
      await spinUntil(() => adapter.requests.some(r => r.sessionId === child.id));
      const request = adapter.requests.find(r => r.sessionId === child.id);
      assert.equal(request.provider, 'mock');
      assert.equal(request.model, 'mock');
      assert.match(JSON.stringify(request), /researcher specialist/);
    }
    const duplicate = await execute(ctx, lead, 'spawn_teammate', args(root, 'reader-fresh'));
    assert.equal(duplicate.isError, true);
    assert.match(JSON.stringify(duplicate), /already used/);
    assert.doesNotMatch(JSON.stringify(duplicate), /both failed/);
    await ctx.fiber.dispose();
    current = await setup(root);
    const restored = await current.ctx.agentLoop.resume(current.ctx, {
      resumeSessionId: ids[0], agentOptions: { provider: 'mock', model: 'changed' },
    });
    const child = restored.agent;
    const denied = await execute(current.ctx, child, 'write', { file_path: join(root, 'bad'), content: 'no' });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied), /Lead is not loaded/);
    const assembled = await current.ctx.systemPrompt.assemble({ agent: child, scope: child });
    assert.ok(assembled.contexts.some(s => s.text.includes('researcher specialist')));
    await current.ctx.agentLoop.resume(current.ctx, {
      resumeSessionId: 'integration-lead', agentOptions: { provider: 'mock', model: 'mock' },
    });
    const scopedDenial = await execute(current.ctx, child, 'write', { file_path: join(root, 'bad'), content: 'no' });
    assert.match(JSON.stringify(scopedDenial), /does not allow write/);
    await current.policyFiber.dispose();
    const revoked = await execute(current.ctx, child, 'read', { file_path: join(root, 'allowed') });
    assert.match(JSON.stringify(revoked), /policy was unloaded/);
  } finally {
    await current?.ctx.fiber.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('fresh verifier receives exact assigned commands in its first request', { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'specialist-verifier-'));
  const { ctx, adapter } = await setup(root);
  try {
    const lead = await ctx.agentLoop.create('verifier-lead', { provider: 'mock', model: 'mock' }, { cwd: root });
    const input = args(root, 'command-checker');
    input.prompt = 'Run assigned checks';
    input.specialist = 'verifier';
    input.assignment.allowed_tools = ['read', 'bash'];
    input.assignment.commands = ['node --test "test/check with spaces.test.mjs"', 'git diff --check'];
    const result = await execute(ctx, lead, 'spawn_teammate', input);
    assert.equal(result.isError, false, JSON.stringify(result));
    const member = ctx.agentTeams.listMembers(lead).find(m => m.name === input.name);
    await spinUntil(() => adapter.requests.some(r => r.sessionId === member.id));
    const request = adapter.requests.find(r => r.sessionId === member.id);
    const texts = request.messages.flatMap(message => (message.content ?? []).filter(block => block.type === 'text').map(block => block.text));
    assert.ok(texts.some(text => text.includes(`Exact check commands (JSON): ${JSON.stringify(input.assignment.commands)}`)));
    assert.ok(texts.some(text => text.includes(`Working directory: ${root}`)));
  } finally {
    await ctx.fiber.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('real dispatch rejects masked search paths and verifier working directories', { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'specialist-masked-path-'));
  const { ctx } = await setup(root);
  try {
    let calls = 0;
    for (const name of ['grep', 'glob', 'bash']) {
      ctx.tools.register(defineContentToolFixture({
        name, description: 'Observe dispatch without filesystem or shell side effects',
        parameters: name === 'bash'
          ? { command: { type: 'string', required: true }, workdir: { type: 'string' } }
          : { pattern: { type: 'string', required: true }, path: { type: 'string' } },
        execute: async () => { calls++; return [{ type: 'text', text: 'dispatched' }]; },
      }));
    }
    const lead = await ctx.agentLoop.create('masked-path-lead', { provider: 'mock', model: 'mock' }, { cwd: root });
    const input = args(root, 'masked-path-verifier');
    input.specialist = 'verifier';
    input.assignment.allowed_tools = ['grep', 'glob', 'bash'];
    input.assignment.commands = ['npm test'];
    const spawned = await execute(ctx, lead, 'spawn_teammate', input);
    assert.equal(spawned.isError, false, JSON.stringify(spawned));
    const child = ctx.agents.get(ctx.agentTeams.listMembers(lead).find(m => m.name === input.name).id);
    const outside = join(root, '..', 'outside');
    for (const name of ['grep', 'glob']) {
      const denied = await execute(ctx, child, name, { file_path: root, path: outside, pattern: '*' });
      assert.equal(denied.isError, true);
      assert.match(JSON.stringify(denied), /outside/);
      assert.equal(calls, 0);
    }
    const denied = await execute(ctx, child, 'bash', { file_path: root, path: root, workdir: outside, command: 'npm test' });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied), /outside/);
    assert.equal(calls, 0);
    const allowed = await execute(ctx, child, 'grep', { file_path: outside, path: root, pattern: '*' });
    assert.equal(allowed.isError, false, JSON.stringify(allowed));
    assert.equal(calls, 1);
  } finally {
    await ctx.fiber.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('assignment flush failure settles admitted member and never creates a child', { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'specialist-failure-'));
  const { ctx } = await setup(root);
  try {
    const lead = await ctx.agentLoop.create('failure-lead', { provider: 'mock', model: 'mock' }, { cwd: root });
    const flush = ctx.sessions.flush.bind(ctx.sessions);
    let injected = false;
    ctx.sessions.flush = async session => {
      if (!injected && session === lead.session && session.snapshotEvents(0).some(e => e.type === 'plugin:specialist-team/assignment')) {
        injected = true;
        throw new Error('injected assignment flush failure');
      }
      return flush(session);
    };
    const result = await execute(ctx, lead, 'spawn_teammate', args(root, 'failed-reader'));
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /injected assignment flush failure/);
    const member = ctx.agentTeams.listMembers(lead).find(m => m.name === 'failed-reader');
    assert.equal(member.status, 'failed');
    assert.equal(ctx.agents.get(member.id), undefined);
  } finally {
    await ctx.fiber.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('specialists use native tools when host default uses PTC', { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'specialist-ptc-'));
  const { ctx } = await setup(root, 'ptc');
  try {
    const lead = await ctx.agentLoop.create('ptc-lead', { provider: 'mock', model: 'mock' }, { cwd: root });
    // Programmatic service call avoids requiring a PTC runtime in this fixture.
    const { assignmentFrom } = await import('../src/policy.mjs');
    const input = args(root, 'native-reader');
    const result = await ctx.agentTeams.spawnTeammate(lead, {
      name: input.name, description: input.description, prompt: [{ type: 'text', text: input.prompt }],
      context: 'fresh', provider: 'spawn', signal: new AbortController().signal,
      specialistAssignment: assignmentFrom(input, root),
    });
    const child = ctx.agents.get(result.member.id);
    assert.equal(ctx.tools.modeFor(child), 'native');
    const assembled = await ctx.systemPrompt.assemble({ agent: child, scope: child });
    assert.ok(assembled.contexts.some(s => s.text.includes('researcher specialist')));
    assert.ok(!assembled.sections.some(s => s.name === 'tools:ptc-only' && s.text));
  } finally {
    await ctx.fiber.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
