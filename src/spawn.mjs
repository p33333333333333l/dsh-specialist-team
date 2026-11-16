import { assignmentFrom, ROLES, ROLE_TOOLS } from './policy.mjs';

const text = description => ({ type: 'string', required: true, description });
const paths = description => ({ type: 'array', required: true, items: { type: 'string' }, description });
export function specialistSpawn(base, cwd) {
  return {
    ...base,
    description: `${base.description} A specialist category and bounded assignment are required. Implementers do not run tests; verifier checks use exact assigned commands.`,
    parameters: {
      ...base.parameters,
      specialist: { type: 'string', required: true, enum: ROLES, description: 'Domain responsible for this specific deliverable.' },
      assignment: {
        type: 'object', required: true, additionalProperties: false,
        properties: {
          deliverable: text('Concrete expected output.'),
          read_paths: paths('Allowed absolute paths or directories; no glob syntax.'),
          write_paths: paths('Allowed write paths; empty for research, architecture and verification.'),
          allowed_tools: { type: 'array', required: true, items: { type: 'string' }, description: `Choose only tools needed for this assignment. Allowed by role: ${JSON.stringify(ROLE_TOOLS)}. send_message to Lead is always available.` },
          commands: { type: 'array', items: { type: 'string' }, description: 'Exact shell command strings, only for verifier checks. Empty otherwise.' },
          reviewer: text('Lead or independent verifier responsible for checking this delivery.'),
          stop_when: text('Stop and report as soon as this condition holds.'),
        },
      },
    },
    async execute(args, exec) {
      const assignment = assignmentFrom(args, cwd(exec.agent));
      return base.execute({ ...args, specialistAssignment: assignment }, exec);
    },
  };
}
