import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assignmentFrom, assignmentIn, coordinatorAssignmentFrom, groupIdOf, scopedAssignment, rolePrompt,
  toolDenial, leadToolDenial, COORDINATOR_TOOLS, ASSIGNMENT_RECORD,
} from '../src/policy.mjs';
import { specialistSpawn } from '../src/spawn.mjs';

const make = (dir, role = 'engineer') => ({ specialist: role, assignment: {
  deliverable: 'Implement the assigned change', read_paths: [dir],
  write_paths: role === 'engineer' ? [join(dir, 'src')] : [],
  allowed_tools: role === 'engineer' ? ['read', 'edit'] : ['read'],
  commands: [], reviewer: 'lead', stop_when: 'Patch delivered',
}});

test('rejects missing assignments and cross-role capabilities before dispatch', () => {
  assert.throws(() => assignmentFrom({ specialist: 'engineer' }, tmpdir()), /structured/);
  const a = make(tmpdir(), 'researcher');
  a.assignment.allowed_tools.push('edit');
  assert.throws(() => assignmentFrom(a, tmpdir()), /subset/);
  a.assignment.allowed_tools = ['read']; a.assignment.write_paths = [tmpdir()];
  assert.throws(() => assignmentFrom(a, tmpdir()), /write/);
});

test('enforces path boundaries, sibling prefixes and symbolic links', () => {
  const dir = mkdtempSync(join(tmpdir(), 'specialist-policy-'));
  try {
    mkdirSync(join(dir, 'src')); mkdirSync(join(dir, 'outside'));
    symlinkSync(join(dir, 'outside'), join(dir, 'src', 'escape'));
    symlinkSync(join(dir, 'missing'), join(dir, 'src', 'dangling'));
    const a = assignmentFrom(make(dir), dir);
    assert.equal(toolDenial(a, { name: 'edit', arguments: { file_path: join(dir, 'src', 'new.js') } }), undefined);
    for (const path of ['src2/file', 'src/../outside/file', 'src/escape/file', 'src/dangling/file']) {
      assert.ok(toolDenial(a, { name: 'edit', arguments: { file_path: join(dir, path) } }), path);
    }
    assert.ok(toolDenial(a, { name: 'bash', arguments: { command: 'npm test' } }));
    assert.ok(toolDenial(a, { name: 'subagent', arguments: {} }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verifier can execute only exact assigned commands without escalation', () => {
  const a = make(tmpdir(), 'verifier');
  a.assignment.allowed_tools = ['read', 'bash'];
  a.assignment.commands = ['npm test'];
  const policy = assignmentFrom(a, tmpdir());
  assert.equal(toolDenial(policy, { name: 'bash', arguments: { command: 'npm test' } }), undefined);
  assert.ok(toolDenial(policy, { name: 'bash', arguments: { command: 'npm test; echo nope' } }));
  assert.ok(toolDenial(policy, { name: 'bash', arguments: { command: 'npm test', run_in_background: true } }));
  assert.ok(toolDenial(policy, { name: 'bash', arguments: { command: 'npm test', sandbox_permissions: 'danger-full-access' } }));
});

test('uses each tool actual path field despite extraneous path aliases', () => {
  const dir = mkdtempSync(join(tmpdir(), 'specialist-alias-'));
  try {
    const input = make(dir, 'verifier');
    input.assignment.allowed_tools = ['read', 'grep', 'glob', 'bash'];
    input.assignment.commands = ['npm test'];
    const policy = assignmentFrom(input, dir);
    const outside = join(dir, '..', 'outside');
    for (const name of ['grep', 'glob']) {
      assert.match(toolDenial(policy, { name, arguments: { file_path: dir, path: outside, pattern: '*' } }), /outside/);
      assert.equal(toolDenial(policy, { name, arguments: { file_path: outside, path: dir, pattern: '*' } }), undefined);
    }
    assert.match(toolDenial(policy, { name: 'bash', arguments: { command: 'npm test', file_path: dir, path: dir, workdir: outside } }), /outside/);
    assert.equal(toolDenial(policy, { name: 'bash', arguments: { command: 'npm test', file_path: outside, path: outside, workdir: dir } }), undefined);
    assert.match(toolDenial(policy, { name: 'read', arguments: { file_path: outside, path: dir, workdir: dir } }), /outside/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('preset tools, filesystem escalation and a changed session cwd do not widen an assignment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'specialist-preset-'));
  try {
    mkdirSync(join(dir, 'src'));
    const a = assignmentFrom(make(dir), dir);
    for (const name of ['subagent', 'subagent_fork', 'workflow', 'run_code', 'apply_patch', 'working_directory']) {
      assert.ok(toolDenial(a, { name, arguments: {} }), name);
    }
    assert.ok(toolDenial(a, { name: 'edit', arguments: { file_path: 'src/ok', sandbox_permissions: 'danger-full-access' } }));
    assert.ok(toolDenial(a, { name: 'read', arguments: { file_path: 'outside' } }, tmpdir()));
    assert.equal(toolDenial(a, { name: 'edit', arguments: { file_path: 'ok' } }, join(dir, 'src')), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('persisted assignments fail closed and ignore inherited records', () => {
  const dir = mkdtempSync(join(tmpdir(), 'specialist-replay-'));
  try {
    const assignment = assignmentFrom(make(dir), dir);
    const record = data => ({ type: ASSIGNMENT_RECORD, ignorable: true, data: { memberId: 'child', assignment: data } });
    const root = events => ({ session: { inheritedEventCount: 0, snapshotEvents: start => events.slice(start) } });
    assert.deepEqual(assignmentIn(root([record(assignment)]), 'child'), assignment);
    assert.throws(() => assignmentIn(root([record(null)]), 'child'), /Invalid persisted/);
    assert.throws(() => assignmentIn(root([record({ ...assignment, allowed_tools: ['bash'] })]), 'child'), /subset/);
    const inherited = root([record(null)]);
    inherited.session.inheritedEventCount = 1;
    assert.equal(assignmentIn(inherited, 'child'), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
const makeGroup = () => ({
  task_id: 'task-1', deliverable: 'Review the patch', stop_when: 'Review delivered',
  read_paths: ['project'], write_paths: ['project/src'], max_specialists: 2,
});

test('coordinator assignments require a native card and validate Lead scope', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'specialist-group-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const group = makeGroup();
  const coordinator = coordinatorAssignmentFrom(group, cwd);
  assert.equal(coordinator.version, 1);
  assert.equal(coordinator.role, 'coordinator');
  assert.equal(coordinator.task_id, group.task_id);
  assert.equal(coordinator.max_specialists, 2);
  assert.deepEqual(coordinator.read_paths, [join(coordinator.cwd, 'project')]);
  assert.deepEqual(coordinator.write_paths, [join(coordinator.cwd, 'project', 'src')]);
  assert.deepEqual(coordinator.commands, []);
  for (const max_specialists of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => coordinatorAssignmentFrom({ ...group, max_specialists }, cwd), /max_specialists/);
  }
  assert.throws(() => coordinatorAssignmentFrom({ ...group, task_id: ' ' }, cwd), /task_id/);
  assert.throws(() => coordinatorAssignmentFrom({ ...group, read_paths: [] }, cwd), /read_paths/);
  assert.throws(() => coordinatorAssignmentFrom({ ...group, write_paths: ['project-other'] }, cwd), /write_paths/);
  assert.throws(() => coordinatorAssignmentFrom({ ...group, commands: [' '] }, cwd), /exact shell command/);
});

test('scoped leaves cannot widen matching paths or Lead-approved commands or use a native card', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'specialist-group-scope-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const group = coordinatorAssignmentFrom({ ...makeGroup(), commands: ['npm test'] }, cwd);
  const input = make(join(group.cwd, 'project'));
  const leaf = assignmentFrom(input, cwd);
  const scoped = scopedAssignment(leaf, group, 'parent');
  assert.deepEqual(scoped, { ...leaf, coordinator_id: 'parent', coordinator_chain: [{ id: 'parent', max_specialists: 2 }] });
  assert.throws(() => scopedAssignment(leaf, group, ' '), /coordinator_id/);
  assert.throws(() => scopedAssignment({ ...leaf, task_id: group.task_id }, group, 'parent'), /task_id/);
  assert.throws(() => scopedAssignment({ ...leaf, read_paths: [join(group.cwd, 'project-other')] }, group, 'parent'), /read_paths/);
  assert.throws(() => scopedAssignment({ ...leaf, write_paths: [join(group.cwd, 'project', 'docs')] }, group, 'parent'), /write_paths/);
  assert.throws(() => assignmentFrom({ ...input, assignment: { ...input.assignment, coordinator_id: 'parent' } }, cwd), /coordinator_id/);
  assert.throws(() => assignmentFrom({ ...input, assignment: { ...input.assignment, coordinator_chain: [] } }, cwd), /coordinator_chain/);

  const verifier = make(join(group.cwd, 'project'), 'verifier');
  verifier.assignment.allowed_tools.push('bash');
  verifier.assignment.commands = ['npm test'];
  assert.equal(scopedAssignment(assignmentFrom(verifier, cwd), group, 'parent').coordinator_id, 'parent');
  verifier.assignment.commands = ['npm test '];
  assert.throws(() => scopedAssignment(assignmentFrom(verifier, cwd), group, 'parent'), /exact commands/);

  assert.match(rolePrompt(group), /Spawn only fresh leaf specialists with spawn_teammate/);
  assert.match(rolePrompt(group), /Maximum specialists for this group: 2/);
  assert.match(rolePrompt(scoped), /report_specialist_result to send the final result to your immediate coordinator/);
  assert.match(rolePrompt(scoped), /Do not delegate/);
  assert.doesNotMatch(rolePrompt(scoped), /Lead/);
});

test('sub-coordinators share the parent card, narrow its scope and carry the budget chain', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'specialist-subgroup-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const top = coordinatorAssignmentFrom({ ...makeGroup(), max_specialists: 5, commands: ['npm test'] }, cwd);
  const sub = scopedAssignment(coordinatorAssignmentFrom({ ...makeGroup(), max_specialists: 2 }, cwd), top, 'top');
  assert.equal(sub.coordinator_id, 'top');
  assert.deepEqual(sub.coordinator_chain, [{ id: 'top', max_specialists: 5 }]);
  assert.throws(() => scopedAssignment(coordinatorAssignmentFrom({ ...makeGroup(), task_id: 'other' }, cwd), top, 'top'), /parent group task_id/);
  assert.throws(() => scopedAssignment(coordinatorAssignmentFrom({ ...makeGroup(), read_paths: ['.'], write_paths: [] }, cwd), top, 'top'), /read_paths/);
  const leaf = scopedAssignment(assignmentFrom(make(join(top.cwd, 'project')), cwd), sub, 'sub');
  assert.deepEqual(leaf.coordinator_chain, [{ id: 'top', max_specialists: 5 }, { id: 'sub', max_specialists: 2 }]);
  assert.equal(groupIdOf(leaf, 'leaf'), 'top');
  assert.equal(groupIdOf(sub, 'sub'), 'top');
  assert.equal(groupIdOf(top, 'top'), 'top');
  assert.equal(groupIdOf({ coordinator_id: 'legacy' }, 'leaf'), 'legacy');
  assert.match(rolePrompt(top, true), /spawn_specialist_coordinator/);
  assert.match(rolePrompt(top, true), /send Lead a scoped group receipt/);
  assert.match(rolePrompt(sub), /send your immediate coordinator a scoped subgroup receipt/);
  assert.match(rolePrompt(sub), /without waiting for an assignment/);
  assert.doesNotMatch(rolePrompt(sub), /spawn_specialist_coordinator/);
});

test('replay validates durable coordinator and scoped leaf records and rejects path drift', () => {
  const dir = mkdtempSync(join(tmpdir(), 'specialist-group-replay-'));
  try {
    mkdirSync(join(dir, 'project'));
    const group = coordinatorAssignmentFrom(makeGroup(), dir);
    const leaf = scopedAssignment(assignmentFrom(make(join(dir, 'project')), dir), group, 'parent');
    const replay = (memberId, assignment) => assignmentIn({ session: {
      snapshotEvents: () => [{ type: ASSIGNMENT_RECORD, ignorable: true, data: { memberId, assignment } }],
    } }, memberId);
    assert.deepEqual(replay('parent', group), group);
    assert.deepEqual(replay('leaf', leaf), leaf);
    assert.throws(() => replay('parent', { ...group, coordinator_id: 'grandparent' }), /coordinator_chain/);
    const { coordinator_chain: _chain, ...legacyLeaf } = leaf;
    assert.deepEqual(replay('leaf', legacyLeaf), legacyLeaf);
    assert.throws(() => replay('leaf', { ...legacyLeaf, coordinator_chain: [{ id: 'other', max_specialists: 2 }] }), /end with coordinator_id/);
    const { coordinator_id: _id, ...unlinked } = leaf;
    assert.throws(() => replay('leaf', unlinked), /requires coordinator_id/);
    const sub = scopedAssignment(coordinatorAssignmentFrom({ ...makeGroup(), write_paths: [] }, dir), group, 'parent');
    assert.deepEqual(replay('sub', sub), sub);
    assert.throws(() => replay('sub', { ...sub, coordinator_chain: [{ id: 'parent', max_specialists: 0 }] }), /budgets/);
    assert.throws(() => replay('leaf', { ...leaf, coordinator_id: ' ' }), /coordinator_id/);
    assert.throws(() => replay('leaf', { ...leaf, task_id: group.task_id }), /task_id/);

    mkdirSync(join(dir, 'project', 'target'));
    symlinkSync(join(dir, 'project', 'target'), join(dir, 'project', 'src'));
    for (const [id, assignment] of [['parent', group], ['leaf', leaf]]) {
      assert.throws(() => replay(id, assignment), /Persisted specialist write_paths changed/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const COORDINATOR_EXPECTED = [
  'spawn_teammate', 'spawn_specialist_coordinator', 'list_subagent_models', 'list_agents', 'send_message', 'interrupt_agent', 'wait_agent',
  'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  'ask_user_question', 'todo_write', 'create_goal', 'get_goal', 'update_goal', 'exit_plan_mode',
  'compress', 'decompress', 'search_context', 'acp_status', 'acp_cache', 'skill',
  'job_list', 'job_output', 'job_kill', 'present',
];

test('coordinator allowlist is the exact reviewed set of names', () => {
  assert.deepEqual([...COORDINATOR_TOOLS].sort(), [...COORDINATOR_EXPECTED].sort());
  assert.equal(new Set(COORDINATOR_TOOLS).size, COORDINATOR_TOOLS.length);
  assert.ok(Object.isFrozen(COORDINATOR_TOOLS));
  for (const name of COORDINATOR_EXPECTED) assert.equal(leadToolDenial({ name, arguments: {} }), undefined, name);
  assert.equal(leadToolDenial({ name: 'spawn_teammate' }), undefined);
});

test('coordinator denies work tools, unknown names and name lookalikes', () => {
  const denied = [
    'read', 'glob', 'grep', 'read_image', 'edit', 'write', 'bash',
    'git_status', 'git_diff', 'git_commit', 'git_log', 'git_branch', 'create_worktree', 'working_directory',
    'web_search', 'web_fetch', 'load_workspace_dependencies',
    'mcp__huashu-chrome__read_text', 'mcp__huashu-chrome__navigate', 'mcp__huashu-chrome__eval',
    'list_mcp_resources', 'read_mcp_resource',
    'session_search', 'session_event_read', 'session_event_search', 'session_event_trace', 'session_trace',
    'subagent', 'subagent_fork', 'workflow', 'run_code',
    'schedule_create', 'schedule_update', 'schedule_delete', 'schedule_list',
    'spawn_teammate2', 'team_task_delete', 'team_', 'mcp__', 'acp_', 'job_', 'send_message ', 'Read', 'SPAWN_TEAMMATE',
    '__proto__', 'constructor', 'toString', 'hasOwnProperty', '', 'unknown_tool',
  ];
  for (const name of denied) assert.match(leadToolDenial({ name, arguments: {} }) ?? '', /Strict coordinator mode/, JSON.stringify(name));
  for (const name of [undefined, null, 7, {}, ['read']]) assert.match(leadToolDenial({ name, arguments: {} }) ?? '', /Strict coordinator mode/, String(name));
  assert.match(leadToolDenial(undefined) ?? '', /Strict coordinator mode/);
  assert.match(leadToolDenial({}) ?? '', /Strict coordinator mode/);
});

test('coordinator never grants a tool through its arguments', () => {
  assert.ok(leadToolDenial({ name: 'bash', arguments: { command: 'git status' } }));
  assert.ok(leadToolDenial({ name: 'read', arguments: { file_path: tmpdir() } }));
  assert.ok(leadToolDenial({ name: 'edit', arguments: { file_path: join(tmpdir(), 'x'), old_string: 'a', new_string: 'b' } }));
  assert.ok(leadToolDenial({ name: 'subagent', arguments: { prompt: 'work' } }));
  assert.ok(leadToolDenial({ name: 'run_code', arguments: { code: 'bash("ls")' } }));
  assert.ok(leadToolDenial({ name: 'mcp__huashu-chrome__fetch', arguments: { url: 'https://example.com' } }));
  assert.ok(leadToolDenial({ name: 'session_search', arguments: { query: 'x' } }));
});

test('coordinator decompress may not write files or images', () => {
  assert.equal(leadToolDenial({ name: 'decompress', arguments: { blockId: 'b1' } }), undefined);
  assert.equal(leadToolDenial({ name: 'decompress', arguments: { blockId: 'b1', full: true } }), undefined);
  assert.match(leadToolDenial({ name: 'decompress', arguments: { blockId: 'b1', toFile: '/tmp/out.txt' } }), /Strict coordinator mode/);
  assert.match(leadToolDenial({ name: 'decompress', arguments: { blockId: 'b1', imageRef: 'm00001' } }), /Strict coordinator mode/);
  assert.match(leadToolDenial({ name: 'decompress', arguments: { blockId: 'b1', imageRef: 'list' } }), /Strict coordinator mode/);
  assert.match(leadToolDenial({ name: 'decompress', arguments: { blockId: 'b1', toFile: '' } }), /Strict coordinator mode/);
  assert.match(leadToolDenial({ name: 'decompress', arguments: { blockId: 'b1', toFile: null } }), /Strict coordinator mode/);
});

test('spawn validates before calling existing model route implementation', async () => {
  let called = 0;
  const base = { parameters: {}, execute: args => { called++; return args; } };
  const tool = specialistSpawn(base, () => tmpdir());
  await assert.rejects(tool.execute({ specialist: 'engineer' }, {}), /structured/);
  assert.equal(called, 0);
  const result = await tool.execute({ ...make(tmpdir()), name: 'engineer-implement' }, {});
  assert.equal(called, 1); assert.equal(result.specialistAssignment.role, 'engineer');
});
