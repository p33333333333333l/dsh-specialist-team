import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Agents from '@deepseek-ai/dsh-agent';
import Sessions, { pluginRecordOf } from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Llm, { LlmAdapter } from '@deepseek-ai/dsh-llm';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools, { defineTool } from '@deepseek-ai/dsh-tools';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import Fs from '@deepseek-ai/dsh-fs-local';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import Subagents from '@deepseek-ai/dsh-subagent';
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process';
import * as Fork from '@deepseek-ai/dsh-subagent-fork-in-process';
import Team from '@deepseek-ai/dsh-agent-team';
import * as TeamTools from '@deepseek-ai/dsh-tool-agent-team';
import Query from '@deepseek-ai/dsh-session-query';
import * as Native from '@deepseek-ai/dsh-tool-executor-native';
import { PtcExecutor } from '@deepseek-ai/dsh-tool-executor-ptc';
import * as Ordinary from '@deepseek-ai/dsh-tool-subagent';
import * as Control from '@deepseek-ai/dsh-tool-subagent-control';
import ModelSettings from '@deepseek-ai/dsh-tool-subagent/model-selection-settings';
import * as Policy from '../src/index.mjs';
import { ASSIGNMENT_RECORD } from '../src/policy.mjs';

const route = { provider: 'mock', model: 'lead-model' };
const signal = new AbortController().signal;
const options = { timeout: 15_000 };
class Adapter extends LlmAdapter {
  requests = [];
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model, reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } });
  }
  async *stream(request) {
    this.requests.push(request);
    if (!request.signal.aborted) await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }));
  }
}

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'specialist-integration-'));
  const contexts = [];
  t.after(async () => {
    try {
      for (const ctx of contexts.reverse()) await ctx.fiber.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  return {
    root,
    async start(policyConfig = {}, { allowedModels, ptc = false, subagentConfig } = {}) {
      const ctx = new Context();
      contexts.push(ctx);
      for (const plugin of [Agents, Sessions, Projections, Query, Llm, SystemPrompt, Fs, Tools]) await ctx.plugin(plugin);
      if (ptc) ctx.tools.setExecutor(new PtcExecutor(ctx));
      else await ctx.plugin(Native);
      await ctx.plugin(WorkingDirectory, { defaultDirectory: root });
      await ctx.plugin(Persistence, { root: join(root, 'sessions') });
      await ctx.plugin(AgentLoop, { agents: [] });
      if (subagentConfig) {
        await ctx.plugin(Loader, { baseUrl: import.meta.url });
        await ctx.get('loader').create({ name: '@deepseek-ai/dsh-subagent', config: subagentConfig });
      } else {
        await ctx.plugin(Subagents);
      }
      await ctx.plugin(Spawn);
      await ctx.plugin(Fork);
      if (allowedModels) await ctx.plugin(ModelSettings, { enabled: true, allowedModels });
      await ctx.plugin(Team);
      await ctx.plugin(TeamTools);
      await ctx.plugin(Ordinary, { provider: 'spawn', modelSelection: true });
      await ctx.plugin(Control);
      const policyFiber = await ctx.plugin(Policy, policyConfig);
      const adapter = new Adapter();
      ctx.llm.registerAdapter(['mock'], adapter);
      const lead = async () => {
        const agent = await ctx.agentLoop.create('integration-lead', route, { cwd: root });
        await ctx.agentTeams.setEnabled(agent, true);
        return agent;
      };
      return { ctx, adapter, policyFiber, lead };
    },
  };
}

const ordinary = name => ({ name, description: 'Inspect assigned files', prompt: 'Inspect the files' });
const specialist = (root, name, context = 'fresh') => ({
  ...ordinary(name), context, specialist: 'researcher', assignment: {
    deliverable: 'Read-only report', read_paths: [root], write_paths: [], allowed_tools: ['read'],
    commands: [], reviewer: 'lead', stop_when: 'Report delivered',
  },
});
async function call(ctx, agent, name, args = {}, error) {
  const toolSet = await ctx.tools.resolve({ agent, signal, modelSelection: route });
  try {
    const { results } = await ctx.tools.execute({
      agent, signal, toolSet,
      calls: [{ type: 'tool-call', id: randomUUID(), name, arguments: JSON.stringify(args) }],
    });
    assert.equal(results.length, 1);
    const { result } = results[0];
    const text = result.content.map(block => block.text).join('\n');
    assert.equal(result.isError, Boolean(error), `${name}: ${text}`);
    if (error) assert.match(text, error);
    return text;
  } finally {
    toolSet.dispose();
  }
}
async function until(read, reason) {
  const deadline = Date.now() + 4_000;
  do {
    const value = read();
    if (value) return value;
    await setTimeout(10);
  } while (Date.now() < deadline);
  assert.fail(reason);
}
const firstRequest = (adapter, id) => until(() => adapter.requests.find(request => request.sessionId === id), `No first request for ${id}`);
const requestText = request => request.messages.flatMap(message => message.content.map(block => block.text)).join('\n');
const member = async (ctx, lead, name) => ctx.agents.get(await ctx.subagents.resolveName(lead, name, signal));

function probe(ctx, name, fields) {
  const calls = [];
  ctx.tools.register(defineTool({
    name, description: 'Observe dispatch without external effects',
    parameters: Object.fromEntries(fields.map(field => [field, { type: 'string', required: true }])),
    output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [{ type: 'text', text: 'dispatched' }] },
    execute: async args => { calls.push(args); return {}; },
  }));
  return calls;
}

test('Lead sees live dispatch limits before starting any specialist', options, async t => {
  const fixture = workspace(t);
  const { ctx, lead: createLead } = await fixture.start({ coordinatorMode: 'strict' }, {
    subagentConfig: { maxDepth: 2, maxActiveSubagents: 3 },
  });
  const lead = await createLead();
  const readRouting = async () => {
    const prompt = await ctx.systemPrompt.assemble({ agent: lead, scope: lead });
    return prompt.contexts.find(section => section.text.includes('Specialist dispatch capability:')).text;
  };
  const beforeDispatch = await readRouting();
  assert.match(beforeDispatch, /Lead only; specialist delegation depth is at most 1/);
  assert.match(beforeDispatch, /Host depth cap: 2/);
  assert.match(beforeDispatch, /Root tree active-child cap: 3 \(shared, not free slots\)/);
  assert.match(beforeDispatch, /Coordinator mode: strict/);
  assert.match(beforeDispatch, /obtain approval for an alternative before dispatching/);
  assert.deepEqual(await ctx.subagents.listDescendants(lead.id, signal), []);

  const loader = ctx.get('loader');
  const entry = [...loader.entries()].find(row => row.options.name === '@deepseek-ai/dsh-subagent');
  await loader.update(entry.id, { config: { maxDepth: 0, maxActiveSubagents: 5 } });
  const updated = await readRouting();
  assert.match(updated, /specialist delegation depth is at most 0/);
  assert.match(updated, /Host depth cap: 0/);
  assert.match(updated, /Root tree active-child cap: 5/);
  await call(ctx, lead, 'spawn_teammate', specialist(fixture.root, 'researcher-denied'), /exceeds maxDepth 0/);
  assert.deepEqual(await ctx.subagents.listDescendants(lead.id, signal), []);
});

test('specialist names must match the assigned role and include a task slug', options, async t => {
  const fixture = workspace(t);
  const { ctx, lead: createLead } = await fixture.start();
  const lead = await createLead();
  for (const name of ['reader', 'researcher', 'engineer-read-docs', 'researcher--read', 'researcher-read-', 'researcher-Read', `researcher-${'a'.repeat(22)}`]) {
    await call(ctx, lead, 'spawn_teammate', specialist(fixture.root, name), /Use researcher-<task>/);
  }
  assert.deepEqual(await ctx.subagents.listDescendants(lead.id, signal), []);

  const name = 'researcher-read-docs';
  const noOverride = { provider: '', model: '', reasoning_effort: '' };
  assert.equal(await call(ctx, lead, 'spawn_teammate', { ...specialist(fixture.root, name), ...noOverride }), `Started specialist ${name}`);
  assert.ok(await member(ctx, lead, name));
  await call(ctx, lead, 'spawn_teammate', specialist(fixture.root, name), /already used/);

  const maxLengthName = `researcher-${'a'.repeat(20)}1`;
  assert.equal(await call(ctx, lead, 'spawn_teammate', specialist(fixture.root, maxLengthName)), `Started specialist ${maxLengthName}`);
  assert.ok(await member(ctx, lead, maxLengthName));
  await call(ctx, lead, 'subagent', ordinary('reader'));
  assert.ok(await member(ctx, lead, 'reader'));
});

test('ordinary and specialist children share native discovery, task board and controls', options, async t => {
  const fixture = workspace(t);
  const { ctx, adapter, lead: createLead } = await fixture.start();
  const lead = await createLead();
  await call(ctx, lead, 'subagent', ordinary('ordinary'));
  const input = specialist(fixture.root, 'researcher-read');
  input.assignment.allowed_tools.push('list_agents', 'team_task_get', 'team_task_list');
  await call(ctx, lead, 'spawn_teammate', input);
  const worker = await member(ctx, lead, 'ordinary');
  const reader = await member(ctx, lead, 'researcher-read');
  for (const caller of [lead, worker, reader]) {
    assert.equal(ctx.subagents.rootOf(caller), lead);
    const list = await call(ctx, caller, 'list_agents');
    assert.match(list, /ordinary/);
    assert.match(list, /researcher-read/);
  }
  assert.doesNotMatch(requestText(await firstRequest(adapter, worker.id)), /You are the researcher specialist/);
  const task = JSON.parse(await call(ctx, lead, 'team_task_create', { subject: 'Read files', description: 'Record observations' }));
  const claimed = JSON.parse(await call(ctx, worker, 'team_task_update', { action: 'claim', task_id: task.id, expected_revision: task.revision }));
  assert.equal(claimed.owner, 'ordinary');
  assert.deepEqual(JSON.parse(await call(ctx, reader, 'team_task_get', { task_id: task.id })), claimed);
  const complete = { action: 'complete', task_id: task.id, expected_revision: claimed.revision };
  await call(ctx, reader, 'team_task_update', complete, /does not allow team_task_update/);
  const completed = JSON.parse(await call(ctx, worker, 'team_task_update', complete));
  assert.equal(completed.status, 'completed');
  assert.deepEqual(JSON.parse(await call(ctx, reader, 'team_task_list')).tasks, [completed]);
  await call(ctx, reader, 'send_message', { agent: 'ordinary', message: 'Not in scope' }, /report only to Lead/);
  await call(ctx, reader, 'send_message', { agent: 'lead', message: 'Specialist report' });
  assert.match(requestText(await firstRequest(adapter, lead.id)), /Specialist report/);
  await firstRequest(adapter, reader.id);
  await call(ctx, lead, 'interrupt_agent', { agent: 'researcher-read' });
  await reader.whenIdle();
  await call(ctx, worker, 'send_message', { agent: 'researcher-read', message: 'Native follow-up' });
  const next = await until(() => adapter.requests.find(request => request.sessionId === reader.id && requestText(request).includes('Native follow-up')), 'Reader did not continue after interrupt');
  assert.match(requestText(next), /You are the researcher specialist/);
});

test('task-linked reports hand off reproduction, repair and retest through the native team', options, async t => {
  const fixture = workspace(t);
  const { ctx, adapter, lead: createLead } = await fixture.start();
  const lead = await createLead();
  const createTask = async (subject, blocked_by = []) => JSON.parse(await call(ctx, lead, 'team_task_create', {
    subject, description: subject, blocked_by,
  }));
  const reproduction = await createTask('Reproduce the regression');
  const repair = await createTask('Repair the regression', [reproduction.id]);
  const retest = await createTask('Retest the regression independently', [repair.id]);
  const readTask = async id => JSON.parse(await call(ctx, lead, 'team_task_get', { task_id: id }));
  const readBoard = () => call(ctx, lead, 'team_task_list').then(JSON.parse);
  const reportTool = 'report_specialist_result';
  const delivered = { status: 'delivered', summary: 'Repaired the off-by-one error.' };
  const expectedFailure = {
    status: 'expected_failure', summary: 'The boundary assertion failed before the repair.',
    checks: ['Boundary case: expected 2, got 1'], limits: 'Only the boundary case was checked.',
  };
  const passed = {
    status: 'passed', summary: 'The boundary assertion passed after the repair.',
    checks: ['Boundary case: expected 2, got 2'],
  };
  const linked = (task, role, slug) => {
    const input = specialist(fixture.root, `${role}-${slug}`);
    return { ...input, specialist: role, assignment: { ...input.assignment, task_id: task.id, deliverable: task.subject } };
  };
  const stages = [
    // A caller-supplied task ID cannot redirect the receipt to the next task.
    { task: reproduction, input: linked(reproduction, 'verifier', 'reproduce'), report: { ...expectedFailure, task_id: repair.id } },
    { task: repair, input: linked(repair, 'engineer', 'repair'), report: delivered },
    { task: retest, input: linked(retest, 'verifier', 'retest'), report: passed },
  ];
  const receipts = () => lead.session.snapshotEvents()
    .filter(event => event.type === 'agent/inbox/spliced')
    .flatMap(event => event.data.inserted)
    .filter(message => message.source?.kind === 'agent-message')
    .flatMap(message => message.content
      .filter(block => block.type === 'text' && block.text.startsWith('Specialist result for '))
      .map(block => ({ senderId: message.source.senderSessionId, text: block.text })));

  const unlinked = specialist(fixture.root, 'researcher-unlinked');
  await call(ctx, lead, 'spawn_teammate', unlinked);
  await call(ctx, lead, reportTool, delivered, /unknown tool/i);
  const unlinkedChild = await member(ctx, lead, unlinked.name);
  await call(ctx, unlinkedChild, reportTool, delivered, /assignment does not allow/);

  for (const [index, { task, input, report }] of stages.entries()) {
    const ready = await readTask(task.id);
    assert.equal(ready.ready, true);
    const next = stages[index + 1];
    if (next) {
      assert.equal((await readTask(next.task.id)).ready, false);
      await call(ctx, lead, 'spawn_teammate', next.input, /not ready/);
      const descendants = await ctx.subagents.listDescendants(lead.id, signal);
      assert.ok(descendants.every(row => row.path !== next.input.name));
    }

    await call(ctx, lead, 'spawn_teammate', input);
    const child = await member(ctx, lead, input.name);
    const request = await firstRequest(adapter, child.id);
    assert.ok(requestText(request).includes(`Native task: ${task.id}`));
    const assignment = child.session.snapshotEvents().map(pluginRecordOf)
      .find(record => record?.type === ASSIGNMENT_RECORD && record.data.memberId === child.id);
    assert.equal(assignment?.data.assignment.task_id, task.id);
    const assign = async (owner, revision) => JSON.parse(await call(ctx, lead, 'team_task_update', {
      action: 'reassign', task_id: task.id, expected_revision: revision, owner,
    }));
    let active = await assign(input.name, ready.revision);
    assert.equal(active.status, 'in_progress');
    if (index === 0) {
      const reassigned = await assign(unlinked.name, active.revision);
      await call(ctx, child, reportTool, report, /Lead must assign/);
      active = await assign(input.name, reassigned.revision);
    }
    const beforeReport = await readBoard();

    if (input.specialist === 'verifier') {
      await call(ctx, child, reportTool, { status: report.status, summary: report.summary }, /at least one check/);
    } else {
      await call(ctx, child, reportTool, { ...passed, status: 'failed' }, /independent verifier/);
    }
    assert.equal(receipts().length, index);
    await call(ctx, child, reportTool, report);
    const received = receipts();
    assert.equal(received.length, index + 1);
    const receipt = received[index];
    assert.equal(receipt.senderId, child.id);
    assert.equal(receipt.text.split('\n')[0], `Specialist result for ${task.id}: ${report.status}`);
    for (const detail of [report.summary, ...(report.checks ?? []), ...(report.limits ? [report.limits] : [])]) {
      assert.ok(receipt.text.includes(detail));
    }
    assert.deepEqual(await readBoard(), beforeReport);

    const completed = JSON.parse(await call(ctx, lead, 'team_task_update', {
      action: 'complete', task_id: task.id, expected_revision: active.revision,
    }));
    assert.equal(completed.status, 'completed');
    if (next) assert.equal((await readTask(next.task.id)).ready, true);
  }

  const retestId = (await member(ctx, lead, stages[2].input.name)).id;
  await ctx.fiber.dispose();
  const restored = await fixture.start();
  const { agent } = await restored.ctx.agents.resume({ resumeSessionId: retestId, agentOptions: route });
  const prompt = await restored.ctx.systemPrompt.assemble({ agent, scope: agent });
  assert.ok(prompt.contexts.some(section => section.text.includes(`Native task: ${retest.id}`)));
});

test('fresh and fork specialists retain scope through first request and cold restore', options, async t => {
  const fixture = workspace(t);
  const { ctx, adapter, lead: createLead } = await fixture.start();
  const lead = await createLead();
  const ids = [];
  for (const context of ['fresh', 'fork']) {
    const input = specialist(fixture.root, `verifier-check-${context}`, context);
    input.specialist = 'verifier';
    input.assignment.allowed_tools.push('bash');
    input.assignment.commands = ['node --test "test/check with spaces.test.mjs"', 'git diff --check'];
    await call(ctx, lead, 'spawn_teammate', input);
    const child = await member(ctx, lead, input.name);
    ids.push(child.id);
    const request = await firstRequest(adapter, child.id);
    assert.equal(request.model, route.model);
    const text = requestText(request);
    assert.match(text, /You are the verifier specialist/);
    assert.ok(text.includes(`Exact check commands (JSON): ${JSON.stringify(input.assignment.commands)}`));
    assert.ok(text.includes(`Working directory: ${fixture.root}`));
    const records = child.session.snapshotEvents().map(pluginRecordOf).filter(record => record?.type === ASSIGNMENT_RECORD);
    assert.deepEqual(records.map(record => record.data.memberId), [child.id]);
  }
  await ctx.fiber.dispose();
  const restored = await fixture.start();
  const writes = probe(restored.ctx, 'write', ['file_path', 'content']);
  const reads = probe(restored.ctx, 'read', ['file_path']);
  for (const id of ids) {
    const { agent } = await restored.ctx.agents.resume({ resumeSessionId: id, agentOptions: route });
    assert.equal(restored.ctx.agents.get(lead.id), undefined);
    const file_path = join(fixture.root, 'allowed');
    await call(restored.ctx, agent, 'write', { file_path, content: 'no' }, /does not allow write/);
    await call(restored.ctx, agent, 'read', { file_path });
    const prompt = await restored.ctx.systemPrompt.assemble({ agent, scope: agent });
    assert.ok(prompt.contexts.some(section => section.text.includes('verifier specialist')));
  }
  assert.equal(writes.length, 0);
  assert.equal(reads.length, 2);
  await restored.policyFiber.dispose();
  await call(restored.ctx, restored.ctx.agents.get(ids[0]), 'read', { file_path: fixture.root }, /policy was unloaded/);
});

test('specialist scope checks the actual search path and exact verifier command', options, async t => {
  const fixture = workspace(t);
  const { ctx, lead: createLead } = await fixture.start();
  const glob = probe(ctx, 'glob', ['pattern', 'path']);
  const grep = probe(ctx, 'grep', ['pattern', 'path']);
  const bash = probe(ctx, 'bash', ['command', 'workdir']);
  const lead = await createLead();
  const input = specialist(fixture.root, 'verifier-check-scope');
  input.specialist = 'verifier';
  input.assignment.allowed_tools.push('glob', 'grep', 'bash');
  input.assignment.commands = ['npm test'];
  await call(ctx, lead, 'spawn_teammate', input);
  const child = await member(ctx, lead, 'verifier-check-scope');
  const outside = join(fixture.root, '..', 'outside');
  for (const name of ['glob', 'grep']) {
    await call(ctx, child, name, { file_path: fixture.root, path: outside, pattern: 'file' }, /outside/);
    await call(ctx, child, name, { file_path: outside, path: fixture.root, pattern: 'file' });
  }
  await call(ctx, child, 'bash', { path: fixture.root, workdir: outside, command: 'npm test' }, /outside/);
  await call(ctx, child, 'bash', { workdir: fixture.root, command: 'npm test -- --other' }, /exact check commands/);
  await call(ctx, child, 'bash', { workdir: fixture.root, command: 'npm test' });
  assert.equal(glob.length, 1);
  assert.equal(grep.length, 1);
  assert.equal(bash.length, 1);
});

test('assignment flush failure prevents the specialist from starting', options, async t => {
  const fixture = workspace(t);
  const { ctx, adapter, lead: createLead } = await fixture.start();
  const lead = await createLead();
  let attempted;
  ctx.on('session/flush', session => {
    if (!session.snapshotEvents().some(event => pluginRecordOf(event)?.type === ASSIGNMENT_RECORD)) return;
    attempted = session.id;
    throw new Error('Simulated assignment persistence failure');
  });
  await call(ctx, lead, 'spawn_teammate', specialist(fixture.root, 'researcher-test-flush'), /Simulated assignment persistence failure/);
  assert.ok(attempted);
  assert.equal(ctx.agents.list().some(agent => agent.id === attempted), false);
  assert.deepEqual(await ctx.subagents.listDescendants(lead.id, signal), []);
  assert.equal(adapter.requests.some(request => request.sessionId === attempted), false);
});

test('strict mode blocks ordinary delegation and local work for the enabled root', options, async t => {
  const fixture = workspace(t);
  const { ctx, lead: createLead } = await fixture.start({ coordinatorMode: 'strict' });
  const reads = probe(ctx, 'read', ['file_path']);
  const lead = await createLead();
  const unrelated = await ctx.agentLoop.create('unrelated', route, { cwd: fixture.root });
  const file_path = join(fixture.root, 'allowed');
  await call(ctx, lead, 'subagent', ordinary('denied'), /Strict coordinator mode/);
  await call(ctx, lead, 'read', { file_path }, /Strict coordinator mode/);
  await call(ctx, unrelated, 'read', { file_path });
  await call(ctx, lead, 'spawn_teammate', specialist(fixture.root, 'researcher-read'));
  const child = await member(ctx, lead, 'researcher-read');
  await call(ctx, child, 'read', { file_path: join(fixture.root, '..', 'outside') }, /outside/);
  await call(ctx, child, 'read', { file_path });
  assert.equal(reads.length, 2);
});

test('live coordinator changes select native execution only for the enabled team and its specialist', options, async t => {
  const fixture = workspace(t);
  const { ctx, adapter, policyFiber, lead: createLead } = await fixture.start({}, { ptc: true });
  const reads = probe(ctx, 'read', ['file_path']);
  const lead = await createLead();
  const unrelated = await ctx.agentLoop.create('unrelated', route, { cwd: fixture.root });
  const file_path = join(fixture.root, 'allowed');
  const ptcOnly = /only `run_code` is callable directly/;
  await call(ctx, lead, 'read', { file_path }, ptcOnly);

  // Reproduce rc.4 loader's volatile-cell commit and fiber-scoped event.
  const updateMode = mode => {
    policyFiber.effectiveConfig.coordinatorMode[Symbol.for('cosmokit.volatile.write')](mode);
    const emitter = Object.create(policyFiber.ctx);
    emitter[Context.filter] = owner => owner.fiber === policyFiber;
    policyFiber.ctx.emit(emitter, 'loader/volatile-update', [['coordinatorMode']]);
  };
  updateMode('strict');
  await call(ctx, lead, 'read', { file_path }, /Strict coordinator mode/);
  await call(ctx, unrelated, 'read', { file_path }, ptcOnly);
  await call(ctx, lead, 'spawn_teammate', specialist(fixture.root, 'researcher-read'));
  const child = await member(ctx, lead, 'researcher-read');
  assert.match(requestText(await firstRequest(adapter, child.id)), /You are the researcher specialist/);
  await call(ctx, child, 'read', { file_path });

  updateMode('off');
  await call(ctx, lead, 'read', { file_path });
  await call(ctx, unrelated, 'read', { file_path }, ptcOnly);
  assert.equal(reads.length, 2);
});

test('reloading the plugin restores scoped tools on the same live Agents', options, async t => {
  const fixture = workspace(t);
  const { ctx, policyFiber, lead: createLead } = await fixture.start({ coordinatorMode: 'strict' });
  probe(ctx, 'read', ['file_path']);
  const lead = await createLead();
  await call(ctx, lead, 'spawn_teammate', specialist(fixture.root, 'researcher-read'));
  const child = await member(ctx, lead, 'researcher-read');
  const allowed = { file_path: fixture.root };
  const outside = { file_path: join(fixture.root, '..', 'outside') };
  await call(ctx, child, 'read', allowed);
  await policyFiber.dispose();
  await call(ctx, child, 'read', allowed, /policy was unloaded/);
  await call(ctx, lead, 'read', allowed, /Strict coordinator mode/);

  const reloaded = await import('../src/index.mjs?reload');
  await ctx.plugin(reloaded, { coordinatorMode: 'strict' });
  assert.equal(ctx.agents.get(child.id), child);
  await call(ctx, child, 'read', allowed);
  await call(ctx, child, 'read', outside, /outside/);
  await call(ctx, lead, 'read', allowed, /Strict coordinator mode/);
  await call(ctx, lead, 'spawn_teammate', specialist(fixture.root, 'researcher-read-more'));
});

test('specialist routes obey native Session model policy', options, async t => {
  const fixture = workspace(t);
  const preferred = { provider: 'mock', model: 'preferred', reasoningEffort: 'low' };
  const explicit = { provider: 'mock', model: 'explicit', reasoning_effort: 'high' };
  const routes = [route, { provider: 'mock', model: 'preferred' }, { provider: 'mock', model: 'explicit' }];
  const { ctx, adapter, lead: createLead } = await fixture.start({ models: { researcher: preferred } }, { allowedModels: routes });
  const lead = await createLead();
  assert.deepEqual(lead.session.snapshotEvents().find(event => event.type === 'subagent/model-selection-policy')?.data.allowedModels, routes);
  await call(ctx, lead, 'spawn_teammate', { ...specialist(fixture.root, 'researcher-bad-route'), provider: 'mock', model: 'denied' }, /not allowed/);
  await call(ctx, lead, 'spawn_teammate', { ...specialist(fixture.root, 'researcher-partial'), model: 'explicit' }, /provider and model together/);
  await call(ctx, lead, 'subagent', { ...ordinary('ordinary-bad'), provider: 'mock', model: 'denied' }, /not allowed/);
  for (const [name, override, model, effort] of [
    ['researcher-preferred', { provider: '', model: ' ', reasoning_effort: '' }, 'preferred', 'low'],
    ['researcher-overridden', explicit, 'explicit', 'high'],
    ['researcher-no-effort', { ...explicit, reasoning_effort: '' }, 'explicit', undefined],
  ]) {
    await call(ctx, lead, 'spawn_teammate', { ...specialist(fixture.root, name), ...override });
    const request = await firstRequest(adapter, (await member(ctx, lead, name)).id);
    assert.equal(request.provider, 'mock');
    assert.equal(request.model, model);
    assert.equal(request.reasoningEffort, effort);
  }
  assert.deepEqual((await ctx.subagents.listDescendants(lead.id, signal)).map(row => row.path), ['researcher-preferred', 'researcher-overridden', 'researcher-no-effort']);
});
