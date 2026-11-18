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

const STRICT = { coordinatorMode: 'strict' };
// Same write symbol cosmokit uses; the tests stand in for the Loader's volatile commit without importing cosmokit.
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');
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
// Advertises two reasoning efforts for every model so routed children can carry an effort.
class ReasoningAdapter extends Adapter {
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model, reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } });
  }
}
async function setup(root, mode = 'native', policyConfig = {}, { toolsConfig, adapter = new Adapter(), allowedModels, enableTeam = true } = {}) {
  const ctx = new Context();
  for (const plugin of [Agents, Sessions, Projections, Llm, SystemPrompt, Fs]) await ctx.plugin(plugin);
  await ctx.plugin(Tools, { mode });
  await ctx.plugin(WorkingDirectory, { defaultDirectory: root });
  await ctx.plugin(Persistence, { root: join(root, 'sessions') });
  await ctx.plugin(AgentLoop, { agents: [] });
  await ctx.plugin(Subagents);
  await ctx.plugin(Spawn);
  await ctx.plugin(Fork);
  if (enableTeam) await ctx.plugin(Team);
  // Stands in for the Host's subagent-model-selection-settings service when model selection is enabled.
  if (allowedModels) ctx.provide('subagentModelSelection', { current: () => ({ enabled: true, allowedModels }) });
  const toolsFiber = enableTeam ? await ctx.plugin(TeamTools, toolsConfig) : undefined;
  const policyFiber = enableTeam ? await ctx.plugin(Policy, policyConfig) : undefined;
  ctx.llm.registerAdapter(['mock'], adapter);
  return { ctx, adapter, policyFiber, toolsFiber };
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
  const { ctx } = await setup(root, 'ptc', STRICT);
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
    // Strict coordinator mode must not leave the Lead with an unrestricted code-execution entry point.
    assert.equal(ctx.tools.modeFor(lead), 'native');
    const assembled = await ctx.systemPrompt.assemble({ agent: child, scope: child });
    assert.ok(assembled.contexts.some(s => s.text.includes('researcher specialist')));
    assert.ok(!assembled.sections.some(s => s.name === 'tools:ptc-only' && s.text));
  } finally {
    await ctx.fiber.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

const FIXTURE_PARAMETERS = {
  file_path: { type: 'string' }, value: { type: 'string' },
  blockId: { type: 'string' }, toFile: { type: 'string' }, imageRef: { type: 'string' },
};
// Registers side-effect-free tools that count real executions, so a blocked call is proven never to reach its executor.
function countedTools(ctx, names) {
  const calls = Object.fromEntries(names.map(name => [name, 0]));
  for (const name of names) {
    ctx.tools.register(defineContentToolFixture({
      name, description: 'Count executions without side effects', parameters: FIXTURE_PARAMETERS,
      execute: async () => { calls[name]++; return [{ type: 'text', text: 'ran' }]; },
    }));
  }
  return calls;
}
const WORK_TOOLS = ['read', 'edit', 'write', 'bash', 'git_commit', 'web_fetch', 'mcp__huashu-chrome__navigate', 'session_search'];
const COORDINATION_TOOLS = ['todo_write', 'decompress'];

test('strict Lead never executes work tools but still coordinates and spawns', { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'specialist-coordinator-'));
  const { ctx } = await setup(root, 'native', STRICT);
  try {
    const calls = countedTools(ctx, [...WORK_TOOLS, ...COORDINATION_TOOLS]);
    const lead = await ctx.agentLoop.create('coordinator-lead', { provider: 'mock', model: 'mock' }, { cwd: root });
    const prompt = await ctx.systemPrompt.assemble({ agent: lead, scope: lead });
    const routing = prompt.contexts.find(s => s.name === 'specialist-team:routing');
    assert.match(routing.text, /Strict coordinator mode/);
    assert.doesNotMatch(routing.text, /Do local, known, easily checked work directly/);
    for (const name of WORK_TOOLS) {
      const denied = await execute(ctx, lead, name, { file_path: join(root, 'x'), value: 'x' });
      assert.equal(denied.isError, true, name);
      assert.match(JSON.stringify(denied), /Strict coordinator mode/, name);
    }
    for (const name of WORK_TOOLS) assert.equal(calls[name], 0, `${name} executor must never run for Lead`);
    const todo = await execute(ctx, lead, 'todo_write', { value: 'plan' });
    assert.equal(todo.isError, false, JSON.stringify(todo));
    assert.equal(calls.todo_write, 1);
    const restored = await execute(ctx, lead, 'decompress', { blockId: 'b1' });
    assert.equal(restored.isError, false, JSON.stringify(restored));
    assert.equal(calls.decompress, 1);
    for (const extra of [{ toFile: join(root, 'out.txt') }, { imageRef: 'm00001' }, { imageRef: 'list' }]) {
      const denied = await execute(ctx, lead, 'decompress', { blockId: 'b1', ...extra });
      assert.equal(denied.isError, true, JSON.stringify(extra));
      assert.match(JSON.stringify(denied), /Strict coordinator mode/);
    }
    assert.equal(calls.decompress, 1);
    const spawned = await execute(ctx, lead, 'spawn_teammate', args(root, 'coordinator-reader'));
    assert.equal(spawned.isError, false, JSON.stringify(spawned));
    assert.ok(ctx.agentTeams.listMembers(lead).some(m => m.name === 'coordinator-reader'));
  } finally {
    await ctx.fiber.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Lead guard leaves specialists and legacy teammates without assignments unchanged', { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'specialist-legacy-'));
  const { ctx } = await setup(root, 'native', STRICT);
  try {
    const calls = countedTools(ctx, ['read', 'bash']);
    const lead = await ctx.agentLoop.create('legacy-lead', { provider: 'mock', model: 'mock' }, { cwd: root });
    const spawned = await execute(ctx, lead, 'spawn_teammate', args(root, 'scoped-reader'));
    assert.equal(spawned.isError, false, JSON.stringify(spawned));
    const specialist = ctx.agents.get(ctx.agentTeams.listMembers(lead).find(m => m.name === 'scoped-reader').id);
    const allowed = await execute(ctx, specialist, 'read', { file_path: join(root, 'allowed.txt') });
    assert.equal(allowed.isError, false, JSON.stringify(allowed));
    assert.equal(calls.read, 1);
    const blocked = await execute(ctx, specialist, 'bash', { value: 'ls' });
    assert.equal(blocked.isError, true);
    assert.match(JSON.stringify(blocked), /does not allow bash/);
    assert.equal(calls.bash, 0);

    // A member created through the Team service without an assignment keeps its original behavior.
    const legacyResult = await ctx.agentTeams.spawnTeammate(lead, {
      name: 'legacy-worker', description: 'Legacy member', prompt: [{ type: 'text', text: 'Work' }],
      context: 'fresh', provider: 'spawn', signal: new AbortController().signal,
    });
    const legacy = ctx.agents.get(legacyResult.member.id);
    const assembled = await ctx.systemPrompt.assemble({ agent: legacy, scope: legacy });
    assert.ok(!assembled.contexts.some(s => s.name === 'specialist-team:routing'));
    const legacyRun = await execute(ctx, legacy, 'bash', { value: 'ls' });
    assert.equal(legacyRun.isError, false, JSON.stringify(legacyRun));
    assert.equal(calls.bash, 1);

    // The Lead stays blocked while the others keep running.
    for (const name of ['read', 'bash']) {
      const denied = await execute(ctx, lead, name, { file_path: join(root, 'allowed.txt'), value: 'ls' });
      assert.equal(denied.isError, true, name);
      assert.match(JSON.stringify(denied), /Strict coordinator mode/);
    }
    assert.equal(calls.read, 1);
    assert.equal(calls.bash, 1);
  } finally {
    await ctx.fiber.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('restored Lead is guarded and keeps the coordinator prompt', { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'specialist-coordinator-restore-'));
  let current;
  try {
    current = await setup(root, 'native', STRICT);
    const lead = await current.ctx.agentLoop.create('restore-lead', { provider: 'mock', model: 'mock' }, { cwd: root });
    const spawned = await execute(current.ctx, lead, 'spawn_teammate', args(root, 'restore-reader'));
    assert.equal(spawned.isError, false, JSON.stringify(spawned));
    await current.ctx.fiber.dispose();
    current = await setup(root, 'native', STRICT);
    const calls = countedTools(current.ctx, ['bash', 'todo_write']);
    const restored = await current.ctx.agentLoop.resume(current.ctx, {
      resumeSessionId: 'restore-lead', agentOptions: { provider: 'mock', model: 'mock' },
    });
    const prompt = await current.ctx.systemPrompt.assemble({ agent: restored.agent, scope: restored.agent });
    assert.match(prompt.contexts.find(s => s.name === 'specialist-team:routing').text, /Strict coordinator mode/);
    const denied = await execute(current.ctx, restored.agent, 'bash', { value: 'ls' });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied), /Strict coordinator mode/);
    assert.equal(calls.bash, 0);
    const todo = await execute(current.ctx, restored.agent, 'todo_write', { value: 'plan' });
    assert.equal(todo.isError, false, JSON.stringify(todo));
    assert.equal(calls.todo_write, 1);
  } finally {
    await current?.ctx.fiber.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Lead guard stays fail-closed after the policy plugin unloads', { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'specialist-coordinator-unload-'));
  const { ctx, policyFiber } = await setup(root, 'native', STRICT);
  try {
    const calls = countedTools(ctx, ['bash', 'read', 'todo_write']);
    const lead = await ctx.agentLoop.create('unload-lead', { provider: 'mock', model: 'mock' }, { cwd: root });
    const before = await execute(ctx, lead, 'bash', { value: 'ls' });
    assert.equal(before.isError, true);
    await policyFiber.dispose();
    for (const name of ['bash', 'read']) {
      const denied = await execute(ctx, lead, name, { file_path: join(root, 'x'), value: 'ls' });
      assert.equal(denied.isError, true, name);
      assert.match(JSON.stringify(denied), /Strict coordinator mode/);
    }
    assert.equal(calls.bash, 0);
    assert.equal(calls.read, 0);
    // Spawning would now create members the unloaded policy cannot restrict, so it is refused too.
    const spawn = await execute(ctx, lead, 'spawn_teammate', args(root, 'after-unload'));
    assert.equal(spawn.isError, true);
    assert.match(JSON.stringify(spawn), /policy was unloaded/);
    assert.ok(!ctx.agentTeams.listMembers(lead).some(m => m.name === 'after-unload'));
    const todo = await execute(ctx, lead, 'todo_write', { value: 'plan' });
    assert.equal(todo.isError, false, JSON.stringify(todo));
    assert.equal(calls.todo_write, 1);
  } finally {
    await ctx.fiber.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('default Lead is not restricted and gets the lenient routing prompt', { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'specialist-default-'));
  const { ctx } = await setup(root);
  try {
    const calls = countedTools(ctx, [...WORK_TOOLS, 'todo_write']);
    const lead = await ctx.agentLoop.create('default-lead', { provider: 'mock', model: 'mock' }, { cwd: root });
    const prompt = await ctx.systemPrompt.assemble({ agent: lead, scope: lead });
    const routing = prompt.contexts.find(s => s.name === 'specialist-team:routing');
    assert.match(routing.text, /Do local, known, easily checked work directly/);
    assert.doesNotMatch(routing.text, /Strict coordinator mode/);
    assert.match(routing.text, /omit provider and model/);
    for (const name of WORK_TOOLS) {
      const result = await execute(ctx, lead, name, { file_path: join(root, 'x'), value: 'x' });
      assert.equal(result.isError, false, `${name}: ${JSON.stringify(result)}`);
      assert.equal(calls[name], 1, name);
    }
    // Specialists keep their scoped guard regardless of the Lead mode.
    const spawned = await execute(ctx, lead, 'spawn_teammate', args(root, 'default-reader'));
    assert.equal(spawned.isError, false, JSON.stringify(spawned));
    const specialist = ctx.agents.get(ctx.agentTeams.listMembers(lead).find(m => m.name === 'default-reader').id);
    const denied = await execute(ctx, specialist, 'bash', { value: 'ls' });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied), /does not allow bash/);
    assert.equal(calls.bash, 1);
  } finally {
    await ctx.fiber.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const mode of ['disabled', 'default', 'strict']) test(`Lead dispatch and argument isolation: ${mode}`, async () => {
  const cases = [
    ['bash', { description: 'Show working directory', command: 'pwd' }],
    ['update_goal', { action: 'complete', goal_id: 'fixture', revision: 5 }],
  ];
  {
    const root = mkdtempSync(join(tmpdir(), 'specialist-no-dispatch-'));
    const { ctx, adapter } = await setup(root, 'native', mode === 'strict' ? STRICT : {}, { enableTeam: mode !== 'disabled' });
    try {
      const lead = await ctx.agentLoop.create('lead', { provider: 'mock', model: 'mock' }, { cwd: root });
      const seen = [];
      for (const [name, input] of cases) {
        const parameters = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, { type: typeof value, required: true }]));
        for (const [key, type] of Object.entries(name === 'bash' ? { sandbox_permissions: 'string', justification: 'string' } : { objective: 'string', max_goal_rounds: 'number', blocked_reason: 'string' })) parameters[key] = { type };
        ctx.tools.register(defineContentToolFixture({ name, description: 'Record received arguments', parameters,
          execute: args => { seen.push([name, { ...args }]); return [{ type: 'text', text: 'ok' }]; },
        }));
        const result = await execute(ctx, lead, name, { ...input });
        const denied = mode === 'strict' && name === 'bash';
        assert.equal(result.isError, denied, JSON.stringify(result));
        if (denied) assert.match(JSON.stringify(result), /Strict coordinator mode/);
      }
      await setImmediate();
      assert.deepEqual(seen, mode === 'strict' ? cases.slice(1) : cases);
      assert.deepEqual(ctx.agents.list().map(agent => agent.id), [lead.id]);
      assert.equal(adapter.requests.length, 0);
      if (mode === 'strict') {
        const spawned = await execute(ctx, lead, 'spawn_teammate', args(root, 'explicit-reader'));
        assert.equal(spawned.isError, false, JSON.stringify(spawned));
        const member = ctx.agentTeams.listMembers(lead).find(m => m.name === 'explicit-reader');
        await spinUntil(() => adapter.requests.some(request => request.sessionId === member.id));
        assert.deepEqual(adapter.requests.map(request => request.sessionId), [member.id]);
      }
    } finally {
      await ctx.fiber.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('explicit off behaves like the default and unknown modes are rejected', { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'specialist-mode-'));
  const { ctx } = await setup(root, 'native', { coordinatorMode: 'off' });
  try {
    const calls = countedTools(ctx, ['bash']);
    const lead = await ctx.agentLoop.create('off-lead', { provider: 'mock', model: 'mock' }, { cwd: root });
    assert.equal((await execute(ctx, lead, 'bash', { value: 'ls' })).isError, false);
    assert.equal(calls.bash, 1);
    assert.throws(() => Policy.apply(ctx, { coordinatorMode: 'loose' }), /coordinatorMode must be one of off, strict/);
    assert.equal(Policy.Config(undefined).coordinatorMode.get(), 'off');
    assert.equal(Policy.Config({}).coordinatorMode.get(), 'off');
    assert.equal(Policy.Config({ coordinatorMode: 'strict' }).coordinatorMode.get(), 'strict');
    assert.throws(() => Policy.Config({ coordinatorMode: 'loose' }));
  } finally {
    await ctx.fiber.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('spawn tool description lists configured model preferences', () => {
  const none = TeamTools.describeModelPreferences(undefined);
  assert.match(none, /No specialist has a configured model preference/);
  const some = TeamTools.describeModelPreferences({ researcher: { provider: 'p', model: 'm', reasoningEffort: 'high' }, verifier: { provider: 'q', model: 'n' } });
  assert.match(some, /researcher=p\/m \(high\), verifier=q\/n\./);
  assert.match(some, /designer, engineer, architect inherit the Lead route/);
});

const POLICY_MODEL = { provider: 'mock', model: 'mock' };
// Stands in for the Loader: commits the new value into the running fiber's volatile reference, then emits its event.
function setMode(current, mode) {
  current.policyFiber.config.coordinatorMode[VOLATILE_WRITE](mode);
  current.ctx.emit('loader/volatile-update', [['coordinatorMode']]);
}
function setModels(current, models) {
  current.toolsFiber.config.models[VOLATILE_WRITE](models);
  current.ctx.emit('loader/volatile-update', [['models']]);
}

test('Schemastery configs: coordinator mode defaults to off and rejects unknown modes', () => {
  assert.equal(Policy.Config(undefined).coordinatorMode.get(), 'off');
  assert.equal(Policy.Config({}).coordinatorMode.get(), 'off');
  assert.equal(Policy.Config({ coordinatorMode: 'off' }).coordinatorMode.get(), 'off');
  assert.equal(Policy.Config({ coordinatorMode: 'strict' }).coordinatorMode.get(), 'strict');
  assert.throws(() => Policy.Config({ coordinatorMode: 'loose' }));
  assert.throws(() => Policy.Config({ coordinatorMode: '' }));
});

test('Schemastery configs: models is a sparse volatile map with exact entry shapes', () => {
  assert.deepEqual(TeamTools.Config({}).models.get(), {});
  assert.deepEqual(TeamTools.Config(undefined).models.get(), {});
  const researcher = { provider: 'p', model: 'm', reasoningEffort: 'high' };
  assert.deepEqual(TeamTools.Config({ models: { researcher } }).models.get(), { researcher });
  const profile = {
    designer: { provider: 'a', model: 'one' },
    researcher: { provider: 'b', model: 'two', reasoningEffort: 'low' },
    engineer: { provider: 'c', model: 'three' },
    architect: { provider: 'd', model: 'four', reasoningEffort: 'high' },
    verifier: { provider: 'e', model: 'five' },
  };
  assert.deepEqual(TeamTools.Config({ models: profile }).models.get(), profile);
  const bare = TeamTools.Config({ models: { engineer: { provider: 'c', model: 'three' } } }).models.get();
  assert.equal('reasoningEffort' in bare.engineer, false);
  assert.throws(() => TeamTools.Config({ models: { researcher: { provider: 'p' } } }));
  assert.throws(() => TeamTools.Config({ models: { researcher: { model: 'm' } } }));
  assert.throws(() => TeamTools.Config({ models: { researcher: { provider: '', model: 'm' } } }));
  // Other settings keep their defaults and stay plain values.
  const config = TeamTools.Config({});
  assert.equal(config.interrupt, true);
  assert.equal(config.modelSelectionSettings, false);
});

test('live coordinator mode switch applies to later tool calls and prompts on the same Lead', { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'specialist-live-mode-'));
  const current = await setup(root);
  const { ctx } = current;
  try {
    const calls = countedTools(ctx, [...WORK_TOOLS, 'todo_write']);
    const lead = await ctx.agentLoop.create('live-lead', POLICY_MODEL, { cwd: root });
    const routing = async () => (await ctx.systemPrompt.assemble({ agent: lead, scope: lead })).contexts.find(s => s.name === 'specialist-team:routing').text;
    assert.match(await routing(), /Do local, known, easily checked work directly/);
    assert.equal((await execute(ctx, lead, 'bash', { value: 'ls' })).isError, false);
    assert.equal(calls.bash, 1);

    setMode(current, 'strict');
    assert.match(await routing(), /Strict coordinator mode/);
    for (const name of WORK_TOOLS) {
      const denied = await execute(ctx, lead, name, { file_path: join(root, 'x'), value: 'x' });
      assert.equal(denied.isError, true, name);
      assert.match(JSON.stringify(denied), /Strict coordinator mode/, name);
    }
    assert.equal(calls.bash, 1);
    assert.equal(calls.read, 0);
    assert.equal((await execute(ctx, lead, 'todo_write', { value: 'plan' })).isError, false);
    const spawned = await execute(ctx, lead, 'spawn_teammate', args(root, 'live-reader'));
    assert.equal(spawned.isError, false, JSON.stringify(spawned));

    setMode(current, 'off');
    assert.match(await routing(), /Do local, known, easily checked work directly/);
    assert.doesNotMatch(await routing(), /Strict coordinator mode/);
    assert.equal((await execute(ctx, lead, 'bash', { value: 'ls' })).isError, false);
    assert.equal(calls.bash, 2);
    assert.equal((await execute(ctx, lead, 'read', { file_path: join(root, 'x') })).isError, false);

    setMode(current, 'strict');
    assert.equal((await execute(ctx, lead, 'bash', { value: 'ls' })).isError, true);
    assert.equal(calls.bash, 2);
    // A Lead created while strict is guarded without any further update.
    const second = await ctx.agentLoop.create('live-lead-2', POLICY_MODEL, { cwd: root });
    assert.equal((await execute(ctx, second, 'bash', { value: 'ls' })).isError, true);
    assert.equal(calls.bash, 2);
  } finally {
    await ctx.fiber.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('live coordinator mode switch toggles native presentation only while strict', { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'specialist-live-ptc-'));
  // Starts strict, like the existing PTC fixture, so no PTC runtime is needed to create the Lead.
  const current = await setup(root, 'ptc', STRICT);
  const { ctx } = current;
  try {
    const lead = await ctx.agentLoop.create('live-ptc-lead', POLICY_MODEL, { cwd: root });
    assert.equal(ctx.tools.modeFor(lead), 'native');
    setMode(current, 'off');
    assert.equal(ctx.tools.modeFor(lead), 'ptc');
    setMode(current, 'strict');
    assert.equal(ctx.tools.modeFor(lead), 'native');
    // A repeated event while strict must not declare the presentation twice.
    ctx.emit('loader/volatile-update', [['coordinatorMode']]);
    assert.equal(ctx.tools.modeFor(lead), 'native');
    setMode(current, 'off');
    assert.equal(ctx.tools.modeFor(lead), 'ptc');
  } finally {
    await ctx.fiber.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('strict switched on live stays fail-closed after unload, and spawning is refused', { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'specialist-live-unload-'));
  const current = await setup(root);
  const { ctx, policyFiber } = current;
  try {
    const calls = countedTools(ctx, ['bash', 'read', 'todo_write']);
    const lead = await ctx.agentLoop.create('live-unload-lead', POLICY_MODEL, { cwd: root });
    setMode(current, 'strict');
    await policyFiber.dispose();
    for (const name of ['bash', 'read']) {
      const denied = await execute(ctx, lead, name, { file_path: join(root, 'x'), value: 'ls' });
      assert.equal(denied.isError, true, name);
      assert.match(JSON.stringify(denied), /Strict coordinator mode/, name);
    }
    assert.equal(calls.bash, 0);
    assert.equal(calls.read, 0);
    const spawn = await execute(ctx, lead, 'spawn_teammate', args(root, 'after-live-unload'));
    assert.equal(spawn.isError, true);
    assert.match(JSON.stringify(spawn), /policy was unloaded/);
    assert.ok(!ctx.agentTeams.listMembers(lead).some(m => m.name === 'after-live-unload'));
    assert.equal((await execute(ctx, lead, 'todo_write', { value: 'plan' })).isError, false);
    const prompt = await ctx.systemPrompt.assemble({ agent: lead, scope: lead });
    // Unloading removes the routing prompt (as before); only the guard stays.
    assert.equal(prompt.contexts.find(s => s.name === 'specialist-team:routing'), undefined);
  } finally {
    await ctx.fiber.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('mode switched back to off before unload, or never switched, leaves the Lead unrestricted after unload', { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'specialist-live-off-unload-'));
  const switched = await setup(root);
  try {
    const calls = countedTools(switched.ctx, ['bash']);
    const lead = await switched.ctx.agentLoop.create('off-unload-lead', POLICY_MODEL, { cwd: root });
    setMode(switched, 'strict');
    assert.equal((await execute(switched.ctx, lead, 'bash', { value: 'ls' })).isError, true);
    setMode(switched, 'off');
    await switched.policyFiber.dispose();
    assert.equal((await execute(switched.ctx, lead, 'bash', { value: 'ls' })).isError, false);
    assert.equal(calls.bash, 1);
    const spawn = await execute(switched.ctx, lead, 'spawn_teammate', args(root, 'after-off-unload'));
    assert.doesNotMatch(JSON.stringify(spawn), /policy was unloaded/);
  } finally {
    await switched.ctx.fiber.dispose();
    rmSync(root, { recursive: true, force: true });
  }
  const root2 = mkdtempSync(join(tmpdir(), 'specialist-never-switched-'));
  const never = await setup(root2);
  try {
    const calls = countedTools(never.ctx, ['bash']);
    const lead = await never.ctx.agentLoop.create('never-lead', POLICY_MODEL, { cwd: root2 });
    await never.policyFiber.dispose();
    assert.equal((await execute(never.ctx, lead, 'bash', { value: 'ls' })).isError, false);
    assert.equal(calls.bash, 1);
  } finally {
    await never.ctx.fiber.dispose();
    rmSync(root2, { recursive: true, force: true });
  }
});

const ALLOWED_MODELS = [
  { provider: 'mock', model: 'mock' }, { provider: 'mock', model: 'other' }, { provider: 'mock', model: 'third' },
];
const modelFor = (adapter, member) => adapter.requests.find(r => r.sessionId === member.id);
const memberNamed = (ctx, lead, name) => ctx.agentTeams.listMembers(lead).find(m => m.name === name);

test('specialist model preferences are read at each spawn and can change live', { timeout: 20000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'specialist-live-models-'));
  const current = await setup(root, 'native', {}, {
    adapter: new ReasoningAdapter(), allowedModels: ALLOWED_MODELS,
    toolsConfig: { modelSelectionSettings: true, models: { researcher: { provider: 'mock', model: 'other', reasoningEffort: 'high' } } },
  });
  const { ctx, adapter } = current;
  try {
    const lead = await ctx.agentLoop.create('models-lead', POLICY_MODEL, { cwd: root });
    // The tool description keeps only the static guidance; the live list is a prompt context.
    const description = ctx.tools.get('spawn_teammate', lead).description;
    assert.match(description, /Choose specialist from the task/);
    assert.doesNotMatch(description, /Configured model preferences/);
    const preferences = async () => (await ctx.systemPrompt.assemble({ agent: lead, scope: lead })).contexts.find(s => s.name === 'team:model-preferences')?.text;
    assert.match(await preferences(), /researcher=mock\/other \(high\)/);

    const first = await execute(ctx, lead, 'spawn_teammate', args(root, 'pref-first'));
    assert.equal(first.isError, false, JSON.stringify(first));
    const firstMember = memberNamed(ctx, lead, 'pref-first');
    await spinUntil(() => modelFor(adapter, firstMember));
    assert.equal(modelFor(adapter, firstMember).model, 'other');
    assert.equal(modelFor(adapter, firstMember).reasoningEffort, 'high');

    setModels(current, { researcher: { provider: 'mock', model: 'third' } });
    assert.match(await preferences(), /researcher=mock\/third\./);
    assert.doesNotMatch(await preferences(), /\(high\)/);
    const second = await execute(ctx, lead, 'spawn_teammate', args(root, 'pref-second'));
    assert.equal(second.isError, false, JSON.stringify(second));
    const secondMember = memberNamed(ctx, lead, 'pref-second');
    await spinUntil(() => modelFor(adapter, secondMember));
    assert.equal(modelFor(adapter, secondMember).model, 'third');
    assert.equal(modelFor(adapter, secondMember).reasoningEffort, undefined);
    // The member created earlier keeps its route.
    assert.equal(modelFor(adapter, firstMember).model, 'other');

    // An explicit provider/model wins over the preference.
    setModels(current, { researcher: { provider: 'mock', model: 'other' } });
    const explicit = await execute(ctx, lead, 'spawn_teammate', { ...args(root, 'pref-explicit'), provider: 'mock', model: 'third' });
    assert.equal(explicit.isError, false, JSON.stringify(explicit));
    const explicitMember = memberNamed(ctx, lead, 'pref-explicit');
    await spinUntil(() => modelFor(adapter, explicitMember));
    assert.equal(modelFor(adapter, explicitMember).model, 'third');

    // Clearing every preference makes the next member inherit the Lead route.
    setModels(current, {});
    assert.match(await preferences(), /No specialist has a configured model preference/);
    const inherited = await execute(ctx, lead, 'spawn_teammate', args(root, 'pref-inherit'));
    assert.equal(inherited.isError, false, JSON.stringify(inherited));
    const inheritedMember = memberNamed(ctx, lead, 'pref-inherit');
    await spinUntil(() => modelFor(adapter, inheritedMember));
    assert.equal(modelFor(adapter, inheritedMember).model, 'mock');
  } finally {
    await ctx.fiber.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unauthorized preference creates no child and explains where to fix it', { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'specialist-unauthorized-model-'));
  const current = await setup(root, 'native', {}, {
    adapter: new ReasoningAdapter(), allowedModels: ALLOWED_MODELS,
    toolsConfig: { modelSelectionSettings: true, models: { researcher: { provider: 'mock', model: 'forbidden' } } },
  });
  const { ctx } = current;
  try {
    const lead = await ctx.agentLoop.create('unauthorized-lead', POLICY_MODEL, { cwd: root });
    const denied = await execute(ctx, lead, 'spawn_teammate', args(root, 'unauthorized-reader'));
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied), /mock\/forbidden/);
    assert.match(JSON.stringify(denied), /Specialist models settings page/);
    assert.match(JSON.stringify(denied), /pass an authorized provider\/model explicitly/);
    assert.ok(!ctx.agentTeams.listMembers(lead).some(m => m.name === 'unauthorized-reader'));
    // Fixing the preference live makes the same call succeed.
    setModels(current, { researcher: { provider: 'mock', model: 'other' } });
    const fixed = await execute(ctx, lead, 'spawn_teammate', args(root, 'unauthorized-reader'));
    assert.equal(fixed.isError, false, JSON.stringify(fixed));
  } finally {
    await ctx.fiber.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
