/**
 * A plan activity's detail as a checklist. Every runtime reports its plan as one line per step: `[x]` done, `[~]` in
 * progress, `[ ]` not started; any other line (Codex's explanation) is a note shown above the steps.
 */
export type PlanState = 'done' | 'doing' | 'todo';

export interface Plan {
  notes: string[];
  steps: { state: PlanState; text: string }[];
}

const STEP = /^\[(x|~| )\] ?(.*)$/;
const STATE: Record<string, PlanState> = { x: 'done', '~': 'doing', ' ': 'todo' };

export function parsePlan(detail: string | null | undefined): Plan | null {
  if (!detail) return null;
  const plan: Plan = { notes: [], steps: [] };
  for (const line of detail.split('\n')) {
    const m = STEP.exec(line);
    if (m) plan.steps.push({ state: STATE[m[1]!]!, text: m[2]! });
    else if (line.trim()) plan.notes.push(line);
  }
  return plan.steps.length ? plan : null;
}
