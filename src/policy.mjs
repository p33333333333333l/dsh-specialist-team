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
function pathScope(a, cwd) {
  const paths = (value, field) => {
    if (!Array.isArray(value) || value.some(p => typeof p !== 'string' || !p.trim())) throw new Error(`${field} must be an array of non-empty paths`);
    return [...new Set(value.map(p => canonical(p, cwd)))];
  };
  const read_paths = paths(a.read_paths, 'read_paths');
  const write_paths = paths(a.write_paths, 'write_paths');
  if (!read_paths.length) throw new Error('read_paths must explicitly identify the allowed workspace');
  if (write_paths.some(path => !inside(path, read_paths))) throw new Error('write_paths must be within read_paths');
  return { read_paths, write_paths };
}
function exactCommands(value) {
  const commands = value ?? [];
  if (!Array.isArray(commands) || commands.some(c => typeof c !== 'string' || !c.trim())) throw new Error('commands must be exact shell command strings');
  return commands;
}
export function assignmentFrom(args, cwd) {
  const role = args.specialist;
  if (!ROLES.includes(role)) throw new Error('Choose one of the five specialist categories before spawning.');
  const a = args.assignment;
  if (!a || typeof a !== 'object') throw new Error('A structured specialist assignment is required.');
  for (const field of ['coordinator_id', 'coordinator_chain']) {
    if (Object.hasOwn(a, field)) throw new Error(`${field} is assigned by the specialist-team plugin.`);
  }
  const scope = pathScope(a, cwd);
  if (!['designer', 'engineer'].includes(role) && scope.write_paths.length) throw new Error(`${role} cannot receive file-write paths`);
  if (!Array.isArray(a.allowed_tools) || !a.allowed_tools.length || a.allowed_tools.some(t => !ROLE_TOOLS[role].includes(t))) throw new Error(`allowed_tools must be a non-empty subset of the ${role} tool policy`);
  const commands = exactCommands(a.commands);
  if (a.allowed_tools.includes('bash') && !commands.length) throw new Error('verifier bash requires exact commands approved by Lead');
  if (role !== 'verifier' && commands.length) throw new Error('Only verifier assignments can execute checks');
  return {
    version: 1, role, cwd: canonical(cwd, cwd),
    ...(a.task_id === undefined ? {} : { task_id: nonempty(a.task_id, 'task_id') }),
    deliverable: nonempty(a.deliverable, 'deliverable'),
    ...scope,
    allowed_tools: [...new Set(a.allowed_tools)], commands,
    reviewer: nonempty(a.reviewer, 'reviewer'),
    stop_when: nonempty(a.stop_when, 'stop_when'),
  };
}
export function coordinatorAssignmentFrom(group, cwd) {
  if (!group || typeof group !== 'object') throw new Error('A structured coordinator assignment is required.');
  if (!Number.isSafeInteger(group.max_specialists) || group.max_specialists < 1) {
    throw new Error('max_specialists must be a positive safe integer');
  }
  return {
    version: 1, role: 'coordinator', cwd: canonical(cwd, cwd),
    task_id: nonempty(group.task_id, 'task_id'),
    deliverable: nonempty(group.deliverable, 'deliverable'),
    stop_when: nonempty(group.stop_when, 'stop_when'),
    ...pathScope(group, cwd), commands: exactCommands(group.commands),
    max_specialists: group.max_specialists,
  };
}
// coordinator_chain lists every coordinator above a scoped member, top first; its last entry is coordinator_id.
function chainFrom(chain, coordinatorId) {
  if (!Array.isArray(chain) || !chain.length) throw new Error('coordinator_chain must list the coordinators above this member');
  const entries = chain.map(entry => {
    if (!Number.isSafeInteger(entry?.max_specialists) || entry.max_specialists < 1) throw new Error('coordinator_chain budgets must be positive safe integers');
    return { id: nonempty(entry.id, 'coordinator_id'), max_specialists: entry.max_specialists };
  });
  if (entries.at(-1).id !== coordinatorId) throw new Error('coordinator_chain must end with coordinator_id');
  return entries;
}
function withCoordinator(assignment, coordinatorId, chain) {
  if (assignment.role !== 'coordinator' && assignment.task_id !== undefined) throw new Error('Scoped specialists cannot receive a native task_id.');
  const id = nonempty(coordinatorId, 'coordinator_id');
  // Specialists persisted before nested groups carry no chain; their coordinator is the group top.
  if (chain === undefined && assignment.role !== 'coordinator') return { ...assignment, coordinator_id: id };
  return { ...assignment, coordinator_id: id, coordinator_chain: chainFrom(chain, id) };
}
export function scopedAssignment(assignment, coordinator, coordinatorId) {
  for (const field of ['read_paths', 'write_paths']) {
    if (assignment[field].some(path => !inside(path, coordinator[field]))) {
      throw new Error(`Specialist ${field} must be within the coordinator's assigned ${field}.`);
    }
  }
  if (assignment.commands.some(command => !coordinator.commands.includes(command))) {
    throw new Error('Specialist commands must match exact commands approved by Lead for this coordinator.');
  }
  if (assignment.role === 'coordinator' && assignment.task_id !== coordinator.task_id) {
    throw new Error('A sub-coordinator must use its parent group task_id.');
  }
  const chain = [...(coordinator.coordinator_chain ?? []), { id: coordinatorId, max_specialists: coordinator.max_specialists }];
  return withCoordinator(assignment, coordinatorId, chain);
}
/** Id of the top coordinator that owns the native group card of a scoped member or coordinator. */
export const groupIdOf = (assignment, selfId) => assignment.coordinator_chain?.[0]?.id ?? assignment.coordinator_id ?? selfId;
export const ASSIGNMENT_RECORD = 'plugin:specialist-team/assignment';
export function assignmentIn(root, memberId) {
  for (const event of root.session.snapshotEvents(root.session.inheritedEventCount ?? 0)) {
    const record = pluginRecordOf(event);
    if (record?.type !== ASSIGNMENT_RECORD || record.data?.memberId !== memberId) continue;
    const a = record.data.assignment;
    if (!a || a.version !== 1 || typeof a.cwd !== 'string' || !isAbsolute(a.cwd)) throw new Error('Invalid persisted specialist assignment');
    const { coordinator_id, coordinator_chain, ...fields } = a;
    const hasCoordinator = Object.hasOwn(a, 'coordinator_id');
    if (!hasCoordinator && Object.hasOwn(a, 'coordinator_chain')) throw new Error('A persisted coordinator_chain requires coordinator_id.');
    let validated = a.role === 'coordinator'
      ? coordinatorAssignmentFrom(fields, a.cwd)
      : assignmentFrom({ specialist: a.role, assignment: fields }, a.cwd);
    if (hasCoordinator) validated = withCoordinator(validated, coordinator_id, coordinator_chain);
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
  // Models often send an empty placeholder; only a real mode request is an escalation.
  if (args.sandbox_permissions != null && args.sandbox_permissions !== '' && ['edit', 'write', 'bash'].includes(exec.name)) {
    return 'Specialist tools cannot request a different sandbox mode. Retry the same call once without sandbox_permissions and justification; if it fails again, report the blocker instead of retrying.';
  }
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
  'spawn_teammate', 'spawn_specialist_coordinator', 'list_subagent_models', 'list_agents', 'send_message', 'interrupt_agent', 'wait_agent',
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
export function rolePrompt(a, canNest = false) {
  if (a.role === 'coordinator') {
    const nested = a.coordinator_id !== undefined;
    const card = nested
      ? 'Your parent group card is assigned to the top group coordinator; check it with team_task_get, then dispatch without waiting for an assignment to you.'
      : "Check your group card with team_task_get before dispatch. If Lead has not assigned it to you yet, end your turn so Lead's confirmation can wake you.";
    const dispatch = canNest
      ? 'Spawn fresh specialists with spawn_teammate. When part of the group splits into an independent subgroup, you may start a sub-coordinator with spawn_specialist_coordinator: reuse your group task_id, keep its paths and commands within yours, and give it a max_specialists budget that fits your remaining budget. A sub-coordinator start costs 1 plus its budget.'
      : 'Spawn only fresh leaf specialists with spawn_teammate.';
    const budget = canNest ? ' (every start in this group subtree counts, including sub-coordinators)' : '';
    const report = nested
      ? 'Receive the results, then use report_specialist_result once to send your immediate coordinator a scoped subgroup receipt. Summarize the deliverable, actual checks, uncovered cases and blockers.'
      : 'Receive the results, then use report_specialist_result once to send Lead a scoped group receipt after Lead assigns you the card. Summarize the deliverable, actual checks, uncovered cases and blockers. Lead reviews the receipt and updates the task board.';
    return `You are the specialist group coordinator. Your assignment is persisted by the specialist-team plugin.\nNative group task: ${a.task_id}\nDeliverable: ${a.deliverable}\nLead-approved read paths: ${a.read_paths.join(', ')}\nLead-approved write paths: ${a.write_paths.join(', ') || '(none)'}\nWorking directory: ${a.cwd}\nLead-approved exact check commands (JSON): ${JSON.stringify(a.commands)}\nMaximum specialists for this group: ${a.max_specialists}${budget}\nStop when: ${a.stop_when}\n${card} ${dispatch} Leave implementation and checks to those specialists. Keep each assignment within the matching read and write paths and exact check commands approved by Lead. Use the group's single native card and omit task_id on specialist assignments. ${report}`;
  }
  const scoped = a.coordinator_id !== undefined;
  const handoff = scoped
    ? '\nUse report_specialist_result to send the final result to your immediate coordinator. Report actual checks and uncovered cases. Use expected_failure only when a run reproduced the agreed failure. Keep logs and diffs out of the receipt.'
    : a.task_id === undefined ? '' : `\nNative task: ${a.task_id}\nUse report_specialist_result for the final handoff once Lead assigns the card to you on the native board. Report the actual checks and uncovered cases. Use expected_failure only when a run reproduced the agreed failure. Keep logs and diffs out of the receipt. Lead reviews the receipt and updates the task board.`;
  return `You are the ${a.role} specialist. Your assignment is persisted by the specialist-team plugin.\nDeliverable: ${a.deliverable}\nRead paths: ${a.read_paths.join(', ')}\nWrite paths: ${a.write_paths.join(', ') || '(none)'}\nWorking directory: ${a.cwd}\nAllowed tools: ${a.allowed_tools.join(', ')}\nExact check commands (JSON): ${JSON.stringify(a.commands)}\nCheck owner: ${a.reviewer}\nStop when: ${a.stop_when}${handoff}\nDo only this role's assigned work. Never pass sandbox_permissions. Do not delegate, submit commits, push, run unassigned checks, or repair another role's findings. Report completed work, unperformed checks and blockers to ${scoped ? 'your immediate coordinator via report_specialist_result' : 'Lead'}, then stop. Tool guards enforce only these registered tool calls; they are not an OS sandbox.`;
}
