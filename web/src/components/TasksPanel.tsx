import { useState } from 'react';
import type { AgentWithStatus, Task, TaskStatus } from '../../../shared/protocol.ts';
import { api } from '../api.ts';
import { useT } from '../i18n.tsx';
import { Icon } from './Icon.tsx';

const STATUSES: TaskStatus[] = ['todo', 'doing', 'done'];

/** Minimal shared task board (todo / doing / done). Agents use the Team MCP tools; the user uses this panel. */
export function TasksPanel(props: {
  roomId: string;
  tasks: Task[];
  members: AgentWithStatus[];
  agents: Record<string, AgentWithStatus>;
  onError: (err: unknown) => void;
}) {
  const t = useT();
  const [title, setTitle] = useState('');
  const [assignee, setAssignee] = useState('');
  const memberOptions = props.members.map((a) => (
    <option key={a.id} value={a.id}>
      @{a.handle}
    </option>
  ));

  return (
    <section className="panel tasks">
      <div className="panel-head">
        <h3>{t('tasks.title')}</h3>
        {props.tasks.length > 0 && <span className="count">{props.tasks.length}</span>}
      </div>
      {STATUSES.map((key) => {
        const list = props.tasks.filter((x) => x.status === key);
        if (list.length === 0) return null;
        return (
          <div key={key} className="task-group">
            <div className="task-group-label">
              {t(`tasks.${key}`)} <span className="count">{list.length}</span>
            </div>
            <ul className="task-list">
              {list.map((task) => (
                <li key={task.id} className={`task task-${task.status}`}>
                  <div className="task-title">{task.title}</div>
                  <div className="task-meta">
                    <select
                      aria-label={t('tasks.assignee')}
                      value={task.assigneeId ?? ''}
                      onChange={(e) => api.updateTask(props.roomId, task.id, { assigneeId: e.target.value || null }).catch(props.onError)}
                    >
                      <option value="">{t('tasks.unassigned')}</option>
                      {memberOptions}
                    </select>
                    <select
                      aria-label={t('tasks.status')}
                      value={task.status}
                      onChange={(e) => api.updateTask(props.roomId, task.id, { status: e.target.value as TaskStatus }).catch(props.onError)}
                    >
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {t(`tasks.${s}`)}
                        </option>
                      ))}
                    </select>
                    <span className="task-id">#{task.id}</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      <form
        className="task-new"
        onSubmit={async (e) => {
          e.preventDefault();
          const v = title.trim();
          if (!v) return;
          try {
            await api.createTask(props.roomId, v, assignee || null);
            setTitle('');
          } catch (err) {
            props.onError(err);
          }
        }}
      >
        <input value={title} maxLength={200} placeholder={t('tasks.new')} aria-label={t('tasks.new')} onChange={(e) => setTitle(e.target.value)} />
        {title.trim() && (
          <div className="task-new-row">
            <select value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label={t('tasks.assignee')}>
              <option value="">{t('tasks.unassigned')}</option>
              {memberOptions}
            </select>
            <button type="submit" className="icon-btn" title={t('common.add')} aria-label={t('common.add')}>
              <Icon name="plus" />
            </button>
          </div>
        )}
      </form>
    </section>
  );
}
