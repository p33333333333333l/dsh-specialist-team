import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assignmentFrom, assignmentIn, toolDenial, ASSIGNMENT_RECORD } from '../src/policy.mjs';
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
test('spawn validates before calling existing model route implementation', async () => {
  let called = 0;
  const base = { parameters: {}, execute: args => { called++; return args; } };
  const tool = specialistSpawn(base, () => tmpdir());
  await assert.rejects(tool.execute({ specialist: 'engineer' }, {}), /structured/);
  assert.equal(called, 0);
  const result = await tool.execute(make(tmpdir()), {});
  assert.equal(called, 1); assert.equal(result.specialistAssignment.role, 'engineer');
});
