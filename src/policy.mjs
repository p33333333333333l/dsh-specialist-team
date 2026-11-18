import { pluginRecordOf } from '@deepseek-ai/dsh-session';
import { realpathSync, lstatSync } from 'node:fs';
import { resolve, dirname, basename, relative, isAbsolute } from 'node:path';

export const ROLES = ['designer', 'researcher', 'engineer', 'architect', 'verifier'];
const READ = ['read', 'glob', 'grep', 'read_image'];
const OBSERVE = ['job_list', 'job_output', 'list_agents', 'team_task_get', 'team_task_list'];
const WEB = ['web_search', 'web_fetch', 'mcp__huashu-chrome__read_text', 'mcp__huashu-chrome__query', 'mcp__huashu-chrome__snapshot', 'mcp__huashu-chrome__screenshot'];
export const ROLE_TOOLS = {
  designer: [...READ, ...OBSERVE, 'edit', 'write'],
  researcher: [...READ, ...OBSERVE, ...WEB],
  engineer: [...READ, ...OBSERVE, 'edit', 'write'],
  architect: [...READ, ...OBSERVE, ...WEB],
  verifier: [...READ, ...OBSERVE, ...WEB, 'bash'],
};
const nonempty = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`specialist assignment requires ${field}`);
  return value.trim();
};
export function canonical(path, cwd) {
  let current = resolve(cwd, path);
  const tail = [];
  while (true) {
    try { lstatSync(current); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(current);
    if (parent === current) break;
    tail.unshift(basename(current));
    current = parent;
  }
  return resolve(realpathSync(current), ...tail);
}
function inside(path, roots) {
  return roots.some(root => { const rel = relative(root, path); return rel === '' || (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel)); });
}
export function assignmentFrom(args, cwd) {
  const role = args.specialist;
  if (!ROLES.includes(role)) throw new Error('Choose one of the five specialist categories before spawning.');
  const a = args.assignment;
  if (!a || typeof a !== 'object') throw new Error('A structured specialist assignment is required.');
  const paths = (value, field) => {
    if (!Array.isArray(value) || value.some(p => typeof p !== 'string' || !p.trim())) throw new Error(`${field} must be an array of non-empty paths`);
    return [...new Set(value.map(p => canonical(p, cwd)))];
  };
  const reads = paths(a.read_paths, 'read_paths');
  const writes = paths(a.write_paths, 'write_paths');
  if (!reads.length) throw new Error('read_paths must explicitly identify the allowed workspace');
  if (writes.some(path => !inside(path, reads))) throw new Error('write_paths must be within read_paths');
  if (!['designer', 'engineer'].includes(role) && writes.length) throw new Error(`${role} cannot receive file-write paths`);
  if (!Array.isArray(a.allowed_tools) || !a.allowed_tools.length || a.allowed_tools.some(t => !ROLE_TOOLS[role].includes(t))) throw new Error(`allowed_tools must be a non-empty subset of the ${role} tool policy`);
  const commands = a.commands ?? [];
  if (!Array.isArray(commands) || commands.some(c => typeof c !== 'string' || !c.trim())) throw new Error('commands must be exact shell command strings');
  if (a.allowed_tools.includes('bash') && !commands.length) throw new Error('verifier bash requires exact commands approved by Lead');
  if (role !== 'verifier' && commands.length) throw new Error('Only verifier assignments can execute checks');
  return {
    version: 1, role, cwd: canonical(cwd, cwd),
    deliverable: nonempty(a.deliverable, 'deliverable'),
    read_paths: reads, write_paths: writes,
    allowed_tools: [...new Set(a.allowed_tools)], commands,
    reviewer: nonempty(a.reviewer, 'reviewer'),
    stop_when: nonempty(a.stop_when, 'stop_when'),
  };
}
export const ASSIGNMENT_RECORD = 'plugin:specialist-team/assignment';
export function assignmentIn(root, memberId) {
  for (const event of root.session.snapshotEvents(root.session.inheritedEventCount ?? 0)) {
    const record = pluginRecordOf(event);
    if (record?.type !== ASSIGNMENT_RECORD || record.data?.memberId !== memberId) continue;
    const a = record.data.assignment;
    if (!a || a.version !== 1 || typeof a.cwd !== 'string' || !isAbsolute(a.cwd)) throw new Error('Invalid persisted specialist assignment');
    const validated = assignmentFrom({ specialist: a.role, assignment: a }, a.cwd);
    // A changed symlink must not silently widen a saved scope during recovery.
    for (const field of ['cwd', 'read_paths', 'write_paths']) {
      if (JSON.stringify(validated[field]) !== JSON.stringify(a[field])) throw new Error(`Persisted specialist ${field} changed; Lead must review the assignment`);
    }
    return validated;
  }
}
export function toolDenial(assignment, exec, cwd = assignment.cwd) {
  if (!assignment.allowed_tools.includes(exec.name)) return `${assignment.role} assignment does not allow ${exec.name}; report the need to Lead.`;
  const args = exec.arguments ?? {};
  if (exec.name === 'glob' && (typeof args.pattern !== 'string' || isAbsolute(args.pattern) || args.pattern.includes('..'))) return 'Glob patterns must stay relative to the assigned search path.';
  if (exec.name === 'mcp__huashu-chrome__screenshot' && (args.savePath || args.focus)) return 'Specialist screenshots may not write files or take browser focus.';
  if (args.sandbox_permissions !== undefined && ['edit', 'write', 'bash'].includes(exec.name)) return 'Specialist tools cannot request a different sandbox mode.';
  if (exec.name === 'bash') {
    if (!assignment.commands.includes(args.command)) return 'Only exact check commands assigned by Lead may run.';
    if (args.run_in_background) return 'Assigned checks must run in the foreground.';
  }
  if (['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash'].includes(exec.name)) {
    const pathField = exec.name === 'bash' ? 'workdir' : ['glob', 'grep'].includes(exec.name) ? 'path' : 'file_path';
    const path = args[pathField] ?? cwd;
    try {
      const allowed = ['write', 'edit'].includes(exec.name) ? assignment.write_paths : [...assignment.read_paths, ...assignment.write_paths];
      if (!inside(canonical(path, cwd), allowed)) return `Path is outside the assigned ${['write','edit'].includes(exec.name) ? 'write' : 'read'} scope.`;
    } catch { return 'Cannot resolve the assigned path safely.'; }
  }
}
// Strict coordinator mode: exact names only. Anything not listed, including unknown, renamed or
// MCP tools, is denied. No prefix or wildcard grants, so new tools stay blocked until reviewed.
export const COORDINATOR_TOOLS = Object.freeze([
  'spawn_teammate', 'list_subagent_models', 'list_agents', 'send_message', 'interrupt_agent', 'wait_agent',
  'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  'ask_user_question', 'todo_write', 'create_goal', 'get_goal', 'update_goal', 'exit_plan_mode',
  'compress', 'decompress', 'search_context', 'acp_status', 'acp_cache', 'skill',
  'job_list', 'job_output', 'job_kill', 'present',
]);
const COORDINATOR_SET = new Set(COORDINATOR_TOOLS);
export function leadToolDenial(exec) {
  const name = exec?.name;
  if (typeof name !== 'string' || !COORDINATOR_SET.has(name)) {
    return `Strict coordinator mode: Lead cannot use ${typeof name === 'string' ? name : 'an unnamed tool'}. Delegate this work to a specialist with spawn_teammate, or ask the user.`;
  }
  const args = exec.arguments ?? {};
  // decompress may write restored content or images to files; Lead keeps it in context only.
  if (name === 'decompress' && (args.toFile !== undefined || args.imageRef !== undefined)) {
    return 'Strict coordinator mode: Lead may not write decompressed content or images to files; delegate file work to a specialist.';
  }
}
export function rolePrompt(a) {
  return `You are the ${a.role} specialist. Your assignment is persisted by the specialist-team plugin.\nDeliverable: ${a.deliverable}\nRead paths: ${a.read_paths.join(', ')}\nWrite paths: ${a.write_paths.join(', ') || '(none)'}\nWorking directory: ${a.cwd}\nAllowed tools: ${a.allowed_tools.join(', ')}\nExact check commands (JSON): ${JSON.stringify(a.commands)}\nCheck owner: ${a.reviewer}\nStop when: ${a.stop_when}\nDo only this role's assigned work. Do not delegate, submit commits, push, run unassigned checks, or repair another role's findings. Report completed work, unperformed checks and blockers to Lead, then stop. Tool guards enforce only these registered tool calls; they are not an OS sandbox.`;
}
