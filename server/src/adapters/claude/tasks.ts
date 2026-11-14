/**
 * The task list Claude Code keeps with its TaskCreate / TaskUpdate tools (on by default since TodoWrite was turned
 * off). Claude Code itself rebuilds the list from the conversation the same way: a TaskCreate is pending until its
 * result names the new task's id ("Task #3 created successfully…") and is dropped if the call failed; a TaskUpdate
 * changes or deletes the task with that id. Only the member's own calls count, not a subagent's.
 */
export type BoardStatus = 'pending' | 'in_progress' | 'completed';

export interface BoardTask {
  content: string;
  activeForm: string;
  status: BoardStatus;
}

const STATUSES = new Set<string>(['pending', 'in_progress', 'completed']);
const CREATED = /^Task #(\S+) created successfully/;

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

export class TaskBoard {
  private readonly tasks = new Map<string, BoardTask>();
  private readonly creating = new Map<string, BoardTask>();

  /** A TaskCreate call (by its tool_use id). */
  create(toolUseId: string, input: any): void {
    const content = text(input?.subject) ?? '';
    this.creating.set(toolUseId, { content, activeForm: text(input?.activeForm) ?? content, status: 'pending' });
  }

  /** The result of a TaskCreate call. */
  created(toolUseId: string, failed: boolean, result: string): void {
    const t = this.creating.get(toolUseId);
    if (!t) return;
    if (failed) {
      this.creating.delete(toolUseId);
      return;
    }
    const id = CREATED.exec(result.trim())?.[1];
    if (!id) return;
    this.creating.delete(toolUseId);
    if (!this.tasks.has(id)) this.tasks.set(id, t);
  }

  /** A TaskUpdate call. */
  update(input: any): void {
    const id = input?.taskId == null ? '' : String(input.taskId);
    if (!id) return;
    if (input.status === 'deleted') {
      this.tasks.delete(id);
      return;
    }
    const prev = this.tasks.get(id);
    const subject = text(input.subject);
    this.tasks.set(id, {
      content: subject ?? prev?.content ?? id,
      activeForm: text(input.activeForm) ?? prev?.activeForm ?? subject ?? id,
      status: STATUSES.has(input.status) ? input.status : (prev?.status ?? 'pending'),
    });
  }

  list(): BoardTask[] {
    return [...this.tasks.values(), ...this.creating.values()];
  }

  /** `[x]` done, `[~]` in progress, `[ ]` not started: one line each. */
  lines(): string {
    const mark: Record<BoardStatus, string> = { completed: '[x]', in_progress: '[~]', pending: '[ ]' };
    return this.list()
      .map((t) => `${mark[t.status]} ${t.content}`)
      .join('\n');
  }
}
