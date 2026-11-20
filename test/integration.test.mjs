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
const coordinator = (root, taskId) => ({
  ...ordinary('coordinator-alpha'), assignment: {
    task_id: taskId, deliverable: 'Consolidated specialist report', stop_when: 'Group result delivered',
    read_paths: [join(root, 'group')], write_paths: [], max_specialists: 1,
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

test('full-power mode raises live dispatch limits and restores the user values', options, async t => {
  const fixture = workspace(t);
  const { ctx, policyFiber, lead: createLead } = await fixture.start({ coordinatorMode: 'full-power' }, {
    subagentConfig: { maxDepth: 2, maxActiveSubagents: 3 },
  });
  const lead = await createLead();
  const readRouting = async () => {
    const prompt = await ctx.systemPrompt.assemble({ agent: lead, scope: lead });
    return prompt.contexts.find(section => section.text.includes('Specialist dispatch capability:')).text;
  };
  const loader = ctx.get('loader');
  const entry = [...loader.entries()].find(row => row.options.name === '@deepseek-ai/dsh-subagent');
  const live = () => [entry.fiber.effectiveConfig.maxDepth.get(), entry.fiber.effectiveConfig.maxActiveSubagents.get()];
  const updateMode = mode => {
    policyFiber.effectiveConfig.coordinatorMode[Symbol.for('cosmokit.volatile.write')](mode);
    const emitter = Object.create(policyFiber.ctx);
    emitter[Context.filter] = owner => owner.fiber === policyFiber;
    policyFiber.ctx.emit(emitter, 'loader/volatile-update', [['coordinatorMode']]);
  };
  assert.deepEqual(live(), [3, 100]);
  const beforeDispatch = await readRouting();
  assert.match(beforeDispatch, /Lead dispatches through group coordinators by default/);
  assert.match(beforeDispatch, /nests up to the host depth cap/);
  assert.match(beforeDispatch, /Host depth cap: 3/);
  assert.match(beforeDispatch, /Root tree active-child cap: 100 \(shared, not free slots\)/);
  assert.match(beforeDispatch, /Coordinator mode: full-power/);
  assert.match(beforeDispatch, /obtain approval before switching arrangements/);
  assert.deepEqual(await ctx.subagents.listDescendants(lead.id, signal), []);

  // Higher user values are kept; a lower user edit is raised again at the next sync.
  await loader.update(entry.id, { config: { maxDepth: 5, maxActiveSubagents: 200 } });
  assert.match(await readRouting(), /Host depth cap: 5\. Root tree active-child cap: 200 /);
  await loader.update(entry.id, { config: { maxDepth: 0, maxActiveSubagents: 5 } });
  assert.match(await readRouting(), /Host depth cap: 3\. Root tree active-child cap: 100 /);

  updateMode('off');
  assert.deepEqual(live(), [0, 5]);
  const updated = await readRouting();
  assert.match(updated, /Lead dispatches directly by default/);
  assert.match(updated, /unavailable with the current host limits/);
  assert.match(updated, /Host depth cap: 0/);
  assert.match(updated, /Root tree active-child cap: 5/);
  await call(ctx, lead, 'spawn_teammate', specialist(fixture.root, 'researcher-denied'), /exceeds maxDepth 0/);
  assert.deepEqual(await ctx.subagents.listDescendants(lead.id, signal), []);

  updateMode('full-power');
  assert.deepEqual(live(), [3, 100]);
  await policyFiber.dispose();
  assert.deepEqual(live(), [0, 5]);
});

for (const maxDepth of [0, 1, 99999]) {
  test(`group admission with host depth ${maxDepth}`, options, async t => {
    const fixture = workspace(t);
    const { ctx, adapter, lead: createLead } = await fixture.start({}, { subagentConfig: { maxDepth } });
    const lead = await createLead();
    const task = JSON.parse(await call(ctx, lead, 'team_task_create', {
      subject: 'Group task', description: 'Consolidate specialist results',
    }));
    assert.equal(task.ready, true);
    const input = coordinator(fixture.root, task.id);
    if (maxDepth < 2) {
      await call(ctx, lead, 'spawn_specialist_coordinator', input, /depth/i);
      assert.deepEqual(await ctx.subagents.listDescendants(lead.id, signal), []);
      assert.equal(adapter.requests.length, 0);
      assert.deepEqual(JSON.parse(await call(ctx, lead, 'team_task_get', { task_id: task.id })), task);
    } else {
      await call(ctx, lead, 'spawn_specialist_coordinator', input);
      const group = await member(ctx, lead, input.name);
      assert.match(requestText(await firstRequest(adapter, group.id)), /specialist group coordinator/);
    }
  });
}

test('a native group task scopes nested dispatch and routes only direct workflow receipts', options, async t => {
  const fixture = workspace(t);
  const { ctx, adapter, lead: createLead } = await fixture.start({}, { subagentConfig: { maxDepth: 2 } });
  const lead = await createLead();
  const reads = probe(ctx, 'read', ['file_path']);
  const createTask = (subject, blocked_by = []) => call(ctx, lead, 'team_task_create', {
    subject, description: subject, blocked_by,
  }).then(JSON.parse);
  const updateTask = (task, action, owner) => call(ctx, lead, 'team_task_update', {
    task_id: task.id, expected_revision: task.revision, action, ...(owner ? { owner } : {}),
  }).then(JSON.parse);
  const readTask = task_id => call(ctx, lead, 'team_task_get', { task_id }).then(JSON.parse);
  const groupTool = 'spawn_specialist_coordinator';
  const spawnTool = 'spawn_teammate';
  const reportTool = 'report_specialist_result';
  const dependency = await createTask('Prepare inputs');
  const task = await createTask('Review the group inputs', [dependency.id]);
  const input = coordinator(fixture.root, task.id);
  const [groupRoot] = input.assignment.read_paths;
  const leaf = specialist(join(groupRoot, 'review'), 'researcher-review');
  const flat = specialist(fixture.root, 'researcher-flat');
  const readInput = { file_path: join(leaf.assignment.read_paths[0], 'input') };
  const leafReport = { status: 'delivered', summary: 'Scoped review observations.' };
  const groupReport = { status: 'delivered', summary: 'Consolidated group observations.' };

  await call(ctx, lead, groupTool, input, /not ready|dependenc/i);
  assert.deepEqual(await ctx.subagents.listDescendants(lead.id, signal), []);
  await call(ctx, lead, 'read', readInput);
  await updateTask(await updateTask(dependency, 'reassign', 'lead'), 'complete');
  const ready = await readTask(task.id);
  assert.equal(ready.ready, true);
  await call(ctx, lead, groupTool, input);
  const group = await member(ctx, lead, input.name);
  assert.ok(requestText(await firstRequest(adapter, group.id)).includes(`Native group task: ${task.id}`));
  const active = await readTask(task.id);
  assert.equal(active.owner, input.name);
  assert.equal(active.status, 'in_progress');
  // Lead keeps its own tools while a group card is open.
  await call(ctx, lead, 'read', readInput);

  await call(ctx, group, spawnTool, { ...leaf, context: 'fork' }, /fresh|fork/i);
  await call(ctx, group, spawnTool, { ...leaf, model: route.model, provider: route.provider }, /override|model/i);
  await call(ctx, group, spawnTool, { ...leaf, assignment: { ...leaf.assignment, task_id: task.id } }, /task_id/i);
  await call(ctx, group, spawnTool, { ...leaf, assignment: { ...leaf.assignment, read_paths: [fixture.root] } }, /read_paths/i);
  await call(ctx, group, spawnTool, {
    ...leaf, name: 'engineer-review', specialist: 'engineer', assignment: { ...leaf.assignment, write_paths: leaf.assignment.read_paths },
  }, /write_paths/i);
  await call(ctx, group, spawnTool, {
    ...leaf, name: 'verifier-review', specialist: 'verifier', assignment: { ...leaf.assignment, commands: ['npm test'] },
  }, /commands/i);

  await call(ctx, group, spawnTool, leaf);
  const childPath = `${input.name}/${leaf.name}`;
  const child = await member(ctx, lead, childPath);
  await firstRequest(adapter, child.id);
  await call(ctx, group, spawnTool, { ...leaf, name: 'researcher-extra' }, /max_specialists|limit|maximum|bound|capacity/i);
  assert.deepEqual((await ctx.subagents.listDescendants(lead.id, signal)).map(({ path, id, parentId, depth }) => ({
    path, id, parentId, depth,
  })), [
    { path: input.name, id: group.id, parentId: lead.id, depth: 1 },
    { path: childPath, id: child.id, parentId: group.id, depth: 2 },
  ]);
  // Allowed reads keep these denials below the consecutive-denial stop.
  await call(ctx, child, 'read', readInput);
  await call(ctx, child, 'read', { file_path: join(groupRoot, 'other-input') }, /outside/i);
  await call(ctx, child, 'subagent', ordinary('grandchild'), /does not allow|unknown tool/i);
  await call(ctx, child, 'read', readInput);
  await call(ctx, child, spawnTool, { ...leaf, name: 'researcher-grandchild' }, /does not allow|unknown tool/i);
  await call(ctx, child, 'send_message', { agent: 'lead', message: 'Bypass the coordinator' }, /direct parent/);
  assert.equal(reads.length, 4);
  const board = () => call(ctx, lead, 'team_task_list').then(JSON.parse).then(value => value.tasks);
  const childCard = (await board()).find(card => card.owner === childPath);
  assert.equal(childCard.status, 'in_progress');
  assert.equal(childCard.description, leaf.assignment.deliverable);

  const receipts = agent => agent.session.snapshotEvents()
    .filter(event => event.type === 'agent/inbox/spliced')
    .flatMap(event => event.data.inserted)
    .filter(message => message.source?.kind === 'agent-message')
    .map(message => ({ senderId: message.source.senderSessionId, text: message.content.map(block => block.text).join('\n') }));
  await call(ctx, child, reportTool, leafReport);
  const groupReceipts = receipts(group);
  assert.deepEqual(groupReceipts.map(receipt => receipt.senderId), [child.id]);
  assert.ok(groupReceipts[0].text.includes(leafReport.summary));
  assert.deepEqual(receipts(lead), []);
  await call(ctx, group, reportTool, groupReport);
  const leadReceipts = receipts(lead);
  assert.deepEqual(leadReceipts.map(receipt => receipt.senderId), [group.id]);
  assert.ok(leadReceipts[0].text.includes(task.id));
  assert.ok(leadReceipts[0].text.includes(groupReport.summary));
  assert.deepEqual(await readTask(task.id), active);
  assert.equal((await readTask(childCard.id)).status, 'completed');

  // Questions go to the direct parent; coordinators answer only their direct members.
  await call(ctx, child, 'send_message', { agent: input.name, message: 'Question for the coordinator' });
  await call(ctx, group, 'send_message', { agent: childPath, message: 'Answer for the specialist' });
  await call(ctx, group, 'send_message', { agent: 'lead', message: 'Question for Lead' });
  await call(ctx, group, 'send_message', { agent: flat.name, message: 'Not a member' }, /direct parent and their direct members/);

  assert.equal((await updateTask(active, 'complete')).status, 'completed');
  await call(ctx, lead, 'read', readInput);
  await call(ctx, lead, spawnTool, flat);
  assert.ok(await member(ctx, lead, flat.name));
  await call(ctx, lead, 'subagent', ordinary('ordinary-restored'));
  assert.ok(await member(ctx, lead, 'ordinary-restored'));
});

test('a group start does not block parallel ordinary delegation', options, async t => {
  const fixture = workspace(t);
  const { ctx, lead: createLead } = await fixture.start({}, { subagentConfig: { maxDepth: 2 } });
  const lead = await createLead();
  const task = await ctx.agentTeams.createTask(lead, { subject: 'Group', description: 'Coordinate work' });
  const group = coordinator(fixture.root, task.id);
  const toolSet = await ctx.tools.resolve({ agent: lead, signal, modelSelection: route });
  try {
    const { results } = await ctx.tools.execute({
      agent: lead, signal, toolSet, calls: [
        ['spawn_specialist_coordinator', group], ['subagent', ordinary('ordinary-parallel')],
      ].map(([name, args]) => ({ type: 'tool-call', id: randomUUID(), name, arguments: JSON.stringify(args) })),
    });
    assert.equal(results[0].result.isError, false);
    assert.equal(results[1].result.isError, false);
    assert.deepEqual((await ctx.subagents.listDescendants(lead.id, signal)).map(entry => entry.path).sort(), [group.name, 'ordinary-parallel'].sort());
  } finally {
    toolSet.dispose();
  }
});

test('group startup recovery uses prepared links only for native catalog entries', options, async t => {
  const fixture = workspace(t);
  const subagentConfig = { maxDepth: 2, maxActiveSubagents: 2 };
  const { ctx, lead: createLead } = await fixture.start({}, { subagentConfig });
  const lead = await createLead();
  const task = await ctx.agentTeams.createTask(lead, { subject: 'Group', description: 'Coordinate work' });
  const input = coordinator(fixture.root, task.id);
  const dropAssignment = ctx.on('session/flush', session => {
    if (session.id !== lead.id && session.snapshotEvents().some(event => pluginRecordOf(event)?.type === ASSIGNMENT_RECORD)) {
      throw new Error('Simulated coordinator assignment checkpoint failure');
    }
  });
  await call(ctx, lead, 'spawn_specialist_coordinator', input, /Simulated coordinator assignment checkpoint failure/);
  dropAssignment();
  assert.deepEqual(await ctx.subagents.listDescendants(lead.id, signal), []);
  await ctx.fiber.dispose();

  const restarted = await fixture.start({}, { subagentConfig });
  const { agent: retryLead } = await restarted.ctx.agents.resume({ resumeSessionId: lead.id, agentOptions: route });
  const failCatalogCheckpoint = restarted.ctx.on('session/flush', session => {
    if (session === retryLead.session && session.snapshotEvents().some(event => event.type === 'subagent/catalog')) {
      throw new Error('Simulated error after the native catalog was appended');
    }
  });
  await call(restarted.ctx, retryLead, 'spawn_specialist_coordinator', input, /Coordinator coordinator-alpha started.*saving the native catalog failed/);
  failCatalogCheckpoint();
  const coordinatorId = await restarted.ctx.subagents.resolveName(retryLead, input.name, signal);
  assert.equal(restarted.ctx.agentTeams.getTask(retryLead, task.id).ownerId, coordinatorId);
  await restarted.ctx.fiber.dispose();

  const recovered = await fixture.start({}, { subagentConfig });
  const { agent: recoveredLead } = await recovered.ctx.agents.resume({ resumeSessionId: lead.id, agentOptions: route });
  await call(recovered.ctx, recoveredLead, 'spawn_specialist_coordinator', input, /A coordinator was already started/);
  await call(recovered.ctx, recoveredLead, 'send_message', { agent: input.name, message: 'Resume the assigned group.' });
  const recoveredGroup = await member(recovered.ctx, recoveredLead, input.name);
  assert.equal(recoveredGroup.id, coordinatorId);
  await call(recovered.ctx, recoveredGroup, 'spawn_teammate', specialist(input.assignment.read_paths[0], 'researcher-recovered'));
});

test('two root-tree slots admit one group at a time and let both groups run a specialist', options, async t => {
  const fixture = workspace(t);
  const { ctx, adapter, lead: createLead } = await fixture.start({}, {
    subagentConfig: { maxDepth: 2, maxActiveSubagents: 2 },
  });
  const lead = await createLead();
  const first = await ctx.agentTeams.createTask(lead, { subject: 'First group', description: 'Coordinate first group' });
  const second = await ctx.agentTeams.createTask(lead, { subject: 'Second group', description: 'Coordinate second group' });
  const a = coordinator(fixture.root, first.id);
  const b = { ...coordinator(fixture.root, second.id), name: 'coordinator-beta' };
  await call(ctx, lead, 'spawn_specialist_coordinator', a);
  await call(ctx, lead, 'spawn_specialist_coordinator', b, /Keep this group queued/);
  assert.deepEqual(await ctx.agentTeams.getTask(lead, second.id), second);

  const group = await member(ctx, lead, a.name);
  const assigned = ctx.agentTeams.getTask(lead, first.id);
  assert.equal(assigned.ownerId, group.id);
  await call(ctx, group, 'spawn_teammate', specialist(a.assignment.read_paths[0], 'researcher-first'));
  const childId = await ctx.subagents.resolveName(lead, `${a.name}/researcher-first`, signal);
  await firstRequest(adapter, childId);
  ctx.subagents.interrupt(childId, { kind: 'user' });
  await until(() => !ctx.agents.get(childId), 'The first specialist did not release its slot');
  await ctx.agentTeams.updateTask(lead, { action: 'complete', taskId: first.id, expectedRevision: assigned.revision });
  await call(ctx, lead, 'spawn_specialist_coordinator', b, /Keep this group queued/);
  const stream = adapter.stream.bind(adapter);
  adapter.stream = async function* (request) {
    if (request.sessionId !== group.id) yield* stream(request);
  };
  ctx.subagents.interrupt(group.id, { kind: 'user' });
  await group.whenIdle();
  if (ctx.agents.get(group.id)) {
    await call(ctx, lead, 'send_message', { agent: a.name, message: 'Finish this group.' });
  }
  await until(() => !ctx.agents.get(group.id), 'The first coordinator did not release its slot');

  await call(ctx, lead, 'spawn_specialist_coordinator', b);
  const nextGroup = await member(ctx, lead, b.name);
  assert.equal(ctx.agentTeams.getTask(lead, second.id).ownerId, nextGroup.id);
  await call(ctx, nextGroup, 'spawn_teammate', specialist(b.assignment.read_paths[0], 'researcher-second'));
});

test('group specialist budget survives concurrent starts and cold recovery', options, async t => {
  const fixture = workspace(t);
  const subagentConfig = { maxDepth: 99999, maxActiveSubagents: 8 };
  const { ctx, lead: createLead } = await fixture.start({}, { subagentConfig });
  const lead = await createLead();
  const task = JSON.parse(await call(ctx, lead, 'team_task_create', {
    subject: 'Coordinate one specialist', description: 'Keep the same start budget across restart',
  }));
  const input = coordinator(fixture.root, task.id);
  const groupRoot = input.assignment.read_paths[0];
  await call(ctx, lead, 'spawn_specialist_coordinator', input);
  const group = await member(ctx, lead, input.name);
  const launches = await Promise.allSettled(['researcher-first', 'researcher-second'].map(name =>
    call(ctx, group, 'spawn_teammate', specialist(groupRoot, name))));
  assert.equal(launches.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(launches.find(result => result.status === 'rejected').reason.message, /specialist start limit/);
  const descendants = await ctx.subagents.listDescendants(lead.id, signal);
  const child = descendants.find(entry => entry.depth === 2);
  assert.equal(child.parentId, group.id);
  await call(ctx, ctx.agents.get(child.id), 'spawn_teammate', specialist(groupRoot, 'researcher-grandchild'), /does not allow|unknown tool/i);
  assert.deepEqual(descendants.map(entry => entry.depth), [1, 2]);

  await ctx.fiber.dispose();
  const revived = await fixture.start({}, { subagentConfig });
  const { agent: restoredLead } = await revived.ctx.agents.resume({ resumeSessionId: lead.id, agentOptions: route });
  await call(revived.ctx, restoredLead, 'send_message', { agent: input.name, message: 'Recover the group.' });
  const restoredGroup = await member(revived.ctx, restoredLead, input.name);
  await call(revived.ctx, restoredGroup, 'spawn_teammate', specialist(groupRoot, 'researcher-third'), /specialist start limit/);
});

const subCoordinator = (root, taskId, max_specialists = 2) => ({
  ...ordinary('coordinator-sub'), assignment: {
    task_id: taskId, deliverable: 'Subgroup report', stop_when: 'Subgroup result delivered',
    read_paths: [join(root, 'sub')], write_paths: [], max_specialists,
  },
});
const receiptsOf = agent => agent.session.snapshotEvents()
  .filter(event => event.type === 'agent/inbox/spliced')
  .flatMap(event => event.data.inserted)
  .filter(message => message.source?.kind === 'agent-message')
  .map(message => ({ senderId: message.source.senderSessionId, text: message.content.map(block => block.text).join('\n') }));

test('nested groups follow the host depth, share one budget and report through each coordinator', options, async t => {
  const fixture = workspace(t);
  const { ctx, adapter, lead: createLead } = await fixture.start({}, { subagentConfig: { maxDepth: 3 } });
  const lead = await createLead();
  const task = await ctx.agentTeams.createTask(lead, { subject: 'Nested group', description: 'Coordinate nested work' });
  const input = { ...coordinator(fixture.root, task.id), assignment: { ...coordinator(fixture.root, task.id).assignment, max_specialists: 4 } };
  const groupRoot = input.assignment.read_paths[0];
  await call(ctx, lead, 'spawn_specialist_coordinator', input);
  const top = await member(ctx, lead, input.name);
  assert.match(requestText(await firstRequest(adapter, top.id)), /spawn_specialist_coordinator/);

  await call(ctx, top, 'spawn_specialist_coordinator', subCoordinator(groupRoot, task.id, 4), /costs 1 plus/);
  await call(ctx, top, 'spawn_specialist_coordinator', subCoordinator(groupRoot, 'other-task'), /parent group task_id/);
  await call(ctx, top, 'spawn_specialist_coordinator', subCoordinator(fixture.root, task.id), /read_paths/);
  const subInput = subCoordinator(groupRoot, task.id);
  assert.match(await call(ctx, top, 'spawn_specialist_coordinator', subInput), /shares your group card/);
  await call(ctx, top, 'spawn_specialist_coordinator', { ...subCoordinator(groupRoot, task.id, 1), name: 'coordinator-other' }, /only 1 of this group's 4-specialist/);
  const sub = await member(ctx, lead, `${input.name}/${subInput.name}`);
  const subPrompt = requestText(await firstRequest(adapter, sub.id));
  assert.match(subPrompt, /send your immediate coordinator a scoped subgroup receipt/);
  assert.doesNotMatch(subPrompt, /spawn_specialist_coordinator/);
  await call(ctx, sub, 'spawn_specialist_coordinator', { ...subInput, name: 'coordinator-deeper' }, /unknown tool|not available|depth/i);

  const subRoot = subInput.assignment.read_paths[0];
  await call(ctx, sub, 'spawn_teammate', specialist(groupRoot, 'researcher-wide'), /read_paths/);
  await call(ctx, sub, 'spawn_teammate', specialist(subRoot, 'researcher-first'));
  await call(ctx, sub, 'spawn_teammate', specialist(subRoot, 'researcher-second'));
  await call(ctx, sub, 'spawn_teammate', specialist(subRoot, 'researcher-third'), /2-specialist start limit/);
  await call(ctx, top, 'spawn_teammate', specialist(groupRoot, 'researcher-direct'));
  await call(ctx, top, 'spawn_teammate', specialist(groupRoot, 'researcher-extra'), /4-specialist start limit/);
  const descendants = await ctx.subagents.listDescendants(lead.id, signal);
  assert.deepEqual(descendants.map(entry => [entry.path, entry.depth]), [
    [input.name, 1], [`${input.name}/${subInput.name}`, 2],
    [`${input.name}/${subInput.name}/researcher-first`, 3], [`${input.name}/${subInput.name}/researcher-second`, 3],
    [`${input.name}/researcher-direct`, 2],
  ]);

  const leaf = await member(ctx, lead, `${input.name}/${subInput.name}/researcher-first`);
  await call(ctx, leaf, 'send_message', { agent: 'lead', message: 'Bypass' }, /direct parent/);
  await call(ctx, leaf, 'report_specialist_result', { status: 'delivered', summary: 'Leaf observations.' });
  assert.deepEqual(receiptsOf(sub).map(receipt => receipt.senderId), [leaf.id]);
  await call(ctx, sub, 'report_specialist_result', { status: 'delivered', summary: 'Subgroup observations.' });
  assert.deepEqual(receiptsOf(top).map(receipt => receipt.senderId), [sub.id]);
  assert.ok(receiptsOf(top)[0].text.includes('Subgroup observations.'));
  assert.deepEqual(receiptsOf(lead), []);
  await call(ctx, top, 'report_specialist_result', { status: 'delivered', summary: 'Group observations.' });
  assert.deepEqual(receiptsOf(lead).map(receipt => receipt.senderId), [top.id]);
  assert.ok(receiptsOf(lead)[0].text.includes(task.id));
  const cards = ctx.agentTeams.listTasks(lead);
  const ownerOf = id => cards.find(card => card.ownerId === id);
  assert.equal(ownerOf(top.id).id, task.id);
  assert.equal(ownerOf(top.id).status, 'in_progress');
  for (const id of [sub.id, leaf.id]) assert.equal(ownerOf(id).status, 'completed');
  assert.equal(ownerOf((await member(ctx, lead, `${input.name}/${subInput.name}/researcher-second`)).id).status, 'in_progress');
  assert.ok(cards.every(card => card.ownerId !== undefined));
});

test('a sub-coordinator budget stays reserved across cold recovery', options, async t => {
  const fixture = workspace(t);
  const subagentConfig = { maxDepth: 3 };
  const { ctx, lead: createLead } = await fixture.start({}, { subagentConfig });
  const lead = await createLead();
  const task = await ctx.agentTeams.createTask(lead, { subject: 'Reserved group', description: 'Keep sub-budgets after restart' });
  const input = { ...coordinator(fixture.root, task.id), assignment: { ...coordinator(fixture.root, task.id).assignment, max_specialists: 4 } };
  const groupRoot = input.assignment.read_paths[0];
  assert.match(await call(ctx, lead, 'spawn_specialist_coordinator', input), /owns the group card/);
  const top = await member(ctx, lead, input.name);
  await call(ctx, top, 'spawn_specialist_coordinator', subCoordinator(groupRoot, task.id));

  await ctx.fiber.dispose();
  const revived = await fixture.start({}, { subagentConfig });
  const { agent: restoredLead } = await revived.ctx.agents.resume({ resumeSessionId: lead.id, agentOptions: route });
  await call(revived.ctx, restoredLead, 'send_message', { agent: input.name, message: 'Recover the group.' });
  const restoredTop = await member(revived.ctx, restoredLead, input.name);
  await call(revived.ctx, restoredTop, 'spawn_specialist_coordinator', { ...subCoordinator(groupRoot, task.id, 1), name: 'coordinator-other' }, /costs 1 plus/);
  await call(revived.ctx, restoredTop, 'spawn_teammate', specialist(groupRoot, 'researcher-direct'));
  await call(revived.ctx, restoredTop, 'spawn_teammate', specialist(groupRoot, 'researcher-extra'), /4-specialist start limit/);
});

test('concurrent sub-coordinator starts in different groups keep one root-tree slot for specialists', options, async t => {
  const fixture = workspace(t);
  const { ctx, lead: createLead } = await fixture.start({}, { subagentConfig: { maxDepth: 3, maxActiveSubagents: 4 } });
  const lead = await createLead();
  const tops = [];
  for (const name of ['coordinator-alpha', 'coordinator-beta']) {
    const task = await ctx.agentTeams.createTask(lead, { subject: name, description: 'Coordinate one group' });
    const input = { ...coordinator(fixture.root, task.id), name, assignment: { ...coordinator(fixture.root, task.id).assignment, max_specialists: 4 } };
    await call(ctx, lead, 'spawn_specialist_coordinator', input);
    const top = await member(ctx, lead, name);
      tops.push({ top, sub: subCoordinator(input.assignment.read_paths[0], task.id) });
  }
  const starts = await Promise.allSettled(tops.map(({ top, sub }) => call(ctx, top, 'spawn_specialist_coordinator', sub)));
  assert.equal(starts.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(starts.find(result => result.status === 'rejected').reason.message, /no slot for specialists/);
});

test('a sub-coordinator start keeps one root-tree slot for specialists', options, async t => {
  const fixture = workspace(t);
  const { ctx, lead: createLead } = await fixture.start({}, { subagentConfig: { maxDepth: 3, maxActiveSubagents: 2 } });
  const lead = await createLead();
  const task = await ctx.agentTeams.createTask(lead, { subject: 'Tight group', description: 'Coordinate with two slots' });
  const input = { ...coordinator(fixture.root, task.id), assignment: { ...coordinator(fixture.root, task.id).assignment, max_specialists: 4 } };
  const groupRoot = input.assignment.read_paths[0];
  await call(ctx, lead, 'spawn_specialist_coordinator', input);
  const top = await member(ctx, lead, input.name);
  await call(ctx, top, 'spawn_specialist_coordinator', subCoordinator(groupRoot, task.id), /no slot for specialists/);
  await call(ctx, top, 'spawn_teammate', specialist(groupRoot, 'researcher-direct'));
});

test('a coordinator cannot nest when the host depth leaves no room for its specialists', options, async t => {
  const fixture = workspace(t);
  const { ctx, adapter, lead: createLead } = await fixture.start({}, { subagentConfig: { maxDepth: 2 } });
  const lead = await createLead();
  const task = await ctx.agentTeams.createTask(lead, { subject: 'Flat group', description: 'Coordinate at depth two' });
  const input = coordinator(fixture.root, task.id);
  await call(ctx, lead, 'spawn_specialist_coordinator', input);
  const top = await member(ctx, lead, input.name);
  const prompt = requestText(await firstRequest(adapter, top.id));
  assert.match(prompt, /Spawn only fresh leaf specialists/);
  assert.doesNotMatch(prompt, /spawn_specialist_coordinator/);
  await call(ctx, top, 'spawn_specialist_coordinator', subCoordinator(input.assignment.read_paths[0], task.id), /unknown tool|not available|depth/i);
  assert.deepEqual((await ctx.subagents.listDescendants(lead.id, signal)).map(entry => entry.depth), [1]);
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
  const [readerCard, ...others] = JSON.parse(await call(ctx, reader, 'team_task_list')).tasks;
  assert.deepEqual(others, [completed]);
  assert.equal(readerCard.owner, 'researcher-read');
  assert.equal(readerCard.status, 'in_progress');
  await call(ctx, reader, 'send_message', { agent: 'ordinary', message: 'Not in scope' }, /direct parent/);
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
    let active = await readTask(task.id);
    assert.equal(active.owner, input.name);
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

  // An unlinked specialist reports on its own plugin-created card, which then closes.
  const unlinkedCard = (await readBoard()).tasks.find(card => card.owner === unlinked.name);
  assert.equal(unlinkedCard.status, 'in_progress');
  await call(ctx, unlinkedChild, reportTool, delivered);
  assert.equal(receipts().at(-1).text.split('\n')[0], `Specialist result for ${unlinkedCard.id}: delivered`);
  assert.equal((await readTask(unlinkedCard.id)).status, 'completed');

  const retestId = (await member(ctx, lead, stages[2].input.name)).id;
  await ctx.fiber.dispose();
  const restored = await fixture.start();
  const { agent } = await restored.ctx.agents.resume({ resumeSessionId: retestId, agentOptions: route });
  const prompt = await restored.ctx.systemPrompt.assemble({ agent, scope: agent });
  // The assignment is no longer in the system prompt; the resumed child keeps it in its first user message.
  assert.ok(prompt.contexts.some(section => section.text.includes('You are the verifier specialist')));
  assert.ok(!prompt.contexts.some(section => section.text.includes(`Native task: ${retest.id}`)));
  assert.ok(JSON.stringify(agent.session.snapshotEvents()).includes(`Native task: ${retest.id}`));
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

test('same-role specialists share one system prompt and differ only in the first user message', options, async t => {
  const fixture = workspace(t);
  const { ctx, adapter, lead: createLead } = await fixture.start();
  const lead = await createLead();
  const slugs = ['one', 'two'];
  const systems = [];
  const firsts = [];
  for (const slug of slugs) {
    const input = specialist(fixture.root, `researcher-${slug}`);
    input.prompt = `Inspect the ${slug} files`;
    input.assignment.deliverable = `Report on ${slug}`;
    input.assignment.stop_when = `${slug} reported`;
    await call(ctx, lead, 'spawn_teammate', input);
    const child = await member(ctx, lead, input.name);
    const request = await firstRequest(adapter, child.id);
    const prompt = await ctx.systemPrompt.assemble({ agent: child, scope: child });
    systems.push(prompt.contexts.find(section => section.text.includes('You are the researcher specialist')).text);
    const carriers = request.messages.filter(message => message.content.some(block => block.text?.includes(`Deliverable: Report on ${slug}`)));
    assert.equal(carriers.length, 1);
    firsts.push(carriers[0].content.map(block => block.text ?? '').join('\n'));
  }
  assert.equal(systems[0], systems[1]);
  assert.doesNotMatch(systems[0], /Deliverable|Read paths|Write paths|Allowed tools|Check owner|Stop when|Direct parent|Report on|researcher-/);
  assert.notEqual(firsts[0], firsts[1]);
  slugs.forEach((slug, index) => {
    for (const expected of [`Deliverable: Report on ${slug}`, `Stop when: ${slug} reported`, `Read paths: ${fixture.root}`, 'Direct parent: lead', `Inspect the ${slug} files`]) {
      assert.ok(firsts[index].includes(expected), expected);
    }
    assert.ok(!firsts[index].includes('You are the researcher specialist'));
  });
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

test('consecutive guard denials stop the specialist and tell its parent', options, async t => {
  const fixture = workspace(t);
  const { ctx, adapter, lead: createLead } = await fixture.start();
  const reads = probe(ctx, 'read', ['file_path']);
  const bash = probe(ctx, 'bash', ['command', 'workdir']);
  const lead = await createLead();
  const input = specialist(fixture.root, 'verifier-loop');
  input.specialist = 'verifier';
  input.assignment.allowed_tools.push('bash');
  input.assignment.commands = ['npm test'];
  await call(ctx, lead, 'spawn_teammate', input);
  const child = await member(ctx, lead, 'verifier-loop');
  const request = await firstRequest(adapter, child.id);
  const escalate = { workdir: fixture.root, command: 'npm test', sandbox_permissions: 'workspace-write', justification: 'Need write' };
  await call(ctx, child, 'bash', escalate, /Denial 1 of 3/);
  await call(ctx, child, 'read', { file_path: join(fixture.root, 'input') });
  await call(ctx, child, 'bash', escalate, /Denial 1 of 3/);
  await call(ctx, child, 'bash', { ...escalate, command: 'pnpm install' }, /Denial 2 of 3/);
  assert.equal(request.signal.aborted, false);
  await call(ctx, child, 'bash', escalate, /stopped this run/);
  await until(() => request.signal.aborted, 'Looping specialist was not interrupted');
  const notice = await until(() => lead.session.snapshotEvents()
    .filter(event => event.type === 'agent/inbox/spliced')
    .flatMap(event => event.data.inserted)
    .find(message => message.source?.senderSessionId === child.id), 'Lead was not told about the stop');
  assert.match(notice.content.map(block => block.text).join('\n'), /verifier-loop was stopped after 3 tool denials in a row\. Last denied bash/);
  await call(ctx, child, 'bash', escalate, /Denial 1 of 3/);
  assert.equal(bash.length, 0);
  assert.equal(reads.length, 1);
});

test('a specialist may repeat its current sandbox mode but not widen it', options, async t => {
  const fixture = workspace(t);
  const { ctx, lead: createLead } = await fixture.start();
  let mode = 'danger-full-access';
  ctx.provide('sandboxPolicy');
  ctx.set('sandboxPolicy', { resolve: () => ({ mode }), overrideOf: () => undefined });
  const bash = probe(ctx, 'bash', ['command', 'workdir', 'sandbox_permissions']);
  const lead = await createLead();
  const input = specialist(fixture.root, 'verifier-mode');
  input.specialist = 'verifier';
  input.assignment.allowed_tools.push('bash');
  input.assignment.commands = ['npm test'];
  await call(ctx, lead, 'spawn_teammate', input);
  const child = await member(ctx, lead, 'verifier-mode');
  const run = sandbox_permissions => ({ workdir: fixture.root, command: 'npm test', sandbox_permissions });
  await call(ctx, child, 'bash', run('danger-full-access'));
  await call(ctx, child, 'bash', run('workspace-write'));
  mode = 'workspace-write';
  await call(ctx, child, 'bash', run('danger-full-access'), /cannot widen the sandbox beyond workspace-write/);
  assert.equal(bash.length, 2);
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

test('full-power mode blocks ordinary delegation and local work for the enabled root', options, async t => {
  const fixture = workspace(t);
  const { ctx, lead: createLead } = await fixture.start({ coordinatorMode: 'full-power' });
  const reads = probe(ctx, 'read', ['file_path']);
  const lead = await createLead();
  const unrelated = await ctx.agentLoop.create('unrelated', route, { cwd: fixture.root });
  const file_path = join(fixture.root, 'allowed');
  await call(ctx, lead, 'subagent', ordinary('denied'), /Full-power mode/);
  await call(ctx, lead, 'read', { file_path }, /Full-power mode/);
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
  updateMode('full-power');
  await call(ctx, lead, 'read', { file_path }, /Full-power mode/);
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

test('reloading the plugin restores scoped tools on the same live Agents and accepts the legacy strict value', options, async t => {
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
  await call(ctx, lead, 'read', allowed, /Full-power mode/);

  const reloaded = await import('../src/index.mjs?reload');
  await ctx.plugin(reloaded, { coordinatorMode: 'full-power' });
  assert.equal(ctx.agents.get(child.id), child);
  await call(ctx, child, 'read', allowed);
  await call(ctx, child, 'read', outside, /outside/);
  await call(ctx, lead, 'read', allowed, /Full-power mode/);
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
