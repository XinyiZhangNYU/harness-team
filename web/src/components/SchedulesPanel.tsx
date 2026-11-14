import { useState } from 'react';
import { ALL_HANDLE, SCHEDULE_MIN_INTERVAL_MINUTES, type AgentWithStatus, type ScheduledTask, type ScheduleRepeat } from '../../../shared/protocol.ts';
import { api } from '../api.ts';
import { formatTime, fullTime } from '../format.ts';
import { usePrefs, useT, useNoticeText, type TFunc } from '../i18n.tsx';
import { ContextMenu, type MenuItem } from './ContextMenu.tsx';
import { Dialog, errorText } from './Dialog.tsx';
import { Icon } from './Icon.tsx';
import { AgentAvatar } from './RuntimeBadge.tsx';
import { DateTimeField, TimeField } from './TimePicker.tsx';

/** How many assignee avatars a task shows before "+n". */
const SHOWN = 3;

/** Weekdays in the order shown (Monday first); 0 = Sunday as in Date#getDay. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];

function weekdayName(day: number, locale: string): string {
  // 1 January 2023 was a Sunday.
  return new Date(2023, 0, 1 + day).toLocaleDateString(locale, { weekday: 'short' });
}

export function repeatText(r: ScheduleRepeat, t: TFunc, locale: string): string {
  switch (r.kind) {
    case 'once':
      return t('sched.once');
    case 'daily':
      return t('sched.daily', { time: r.time });
    case 'weekly':
      return r.days.length === 7
        ? t('sched.daily', { time: r.time })
        : t('sched.weekly', { days: WEEK.filter((d) => r.days.includes(d)).map((d) => weekdayName(d, locale)).join(t('sched.daySep')), time: r.time });
    case 'interval':
      return r.minutes % 60 === 0 ? t('sched.everyHours', { n: r.minutes / 60 }) : t('sched.everyMinutes', { n: r.minutes });
  }
}

/** The members panel's list of scheduled tasks of this chat, each with its assignees' avatars. */
export function SchedulesPanel(props: {
  roomId: string;
  schedules: ScheduledTask[];
  members: AgentWithStatus[];
  agents: Record<string, AgentWithStatus>;
  onError: (err: unknown) => void;
}) {
  const t = useT();
  const { locale } = usePrefs();
  const noticeText = useNoticeText();
  const [editing, setEditing] = useState<ScheduledTask | 'new' | null>(null);
  const [menu, setMenu] = useState<{ s: ScheduledTask; x: number; y: number } | null>(null);
  const memberIds = new Set(props.members.map((m) => m.id));

  const finished = (s: ScheduledTask) => s.repeat.kind === 'once' && !s.enabled && s.lastResult !== null;
  const status = (s: ScheduledTask): string => {
    if (s.enabled && s.nextRunAt) return t('sched.next', { time: formatTime(s.nextRunAt, locale) });
    if (finished(s)) return s.lastResult === 'sent' ? t('sched.done') : s.lastResult === 'missed' ? t('sched.missed') : t('sched.failed');
    return t('sched.paused');
  };

  const actions = (s: ScheduledTask): MenuItem[] => [
    { label: t('sched.runNow'), disabled: s.agentIds === null ? memberIds.size === 0 : !s.agentIds.every((id) => memberIds.has(id)), onSelect: () => void api.runSchedule(props.roomId, s.id, s.revision).catch(props.onError) },
    ...(finished(s)
      ? []
      : [
          {
            label: s.enabled ? t('sched.pause') : s.pending ? t('sched.confirm') : t('sched.resume'),
            onSelect: () => void api.updateSchedule(props.roomId, s.id, s.enabled ? { enabled: false } : { enabled: true, revision: s.revision }).catch(props.onError),
          },
        ]),
    { label: t('common.edit'), onSelect: () => setEditing(s) },
    { label: t('common.delete'), danger: true, separator: true, onSelect: () => void api.deleteSchedule(props.roomId, s.id).catch(props.onError) },
  ];

  function openMenu(s: ScheduledTask, e: React.MouseEvent, anchor?: HTMLElement) {
    e.preventDefault();
    const rect = anchor?.getBoundingClientRect();
    setMenu(rect ? { s, x: rect.right - 4, y: rect.bottom + 2 } : { s, x: e.clientX, y: e.clientY });
  }

  return (
    <section className="panel schedules">
      <div className="panel-head">
        <h3>{t('sched.title')}</h3>
        {props.schedules.length > 0 && <span className="count">{props.schedules.length}</span>}
        <button
          type="button"
          className="icon-btn push-right"
          title={t('sched.add')}
          aria-label={t('sched.add')}
          disabled={props.members.length === 0}
          onClick={() => setEditing('new')}
        >
          <Icon name="plus" />
        </button>
      </div>
      {props.schedules.length > 0 && (
        <ul className="schedule-list">
          {props.schedules.map((s) => {
            const assignees = s.agentIds?.map((id) => props.agents[id]);
            const failed = s.lastResult === 'failed' && !finished(s);
            const creator = s.createdBy ? props.agents[s.createdBy] : undefined;
            return (
              <li
                key={s.id}
                className={`schedule${s.enabled ? '' : ' off'}${menu?.s.id === s.id ? ' menu-open' : ''}`}
                onContextMenu={(e) => openMenu(s, e)}
              >
                <button type="button" className="schedule-open" onClick={() => setEditing(s)}>
                  {assignees ? (
                    <span className="schedule-avatars" title={assignees.map((a) => (a ? `${a.displayName} @${a.handle}` : '?')).join('\n')}>
                      {assignees.slice(0, assignees.length > SHOWN ? SHOWN - 1 : SHOWN).map((a, i) => (
                        <AgentAvatar key={i} agent={a ?? { runtimeKind: 'mock', displayName: '?', avatar: null }} className="avatar-sm" />
                      ))}
                      {assignees.length > SHOWN && <span className="avatar avatar-sm avatar-all">+{assignees.length - SHOWN + 1}</span>}
                    </span>
                  ) : (
                    <span className="avatar avatar-sm avatar-all" title={`${t('sched.everyone')} @${ALL_HANDLE}`}>
                      <Icon name="users" size={14} />
                    </span>
                  )}
                  <span className="schedule-main">
                    <span className="schedule-prompt">{s.prompt}</span>
                    <span className="schedule-sub" title={s.nextRunAt ? fullTime(s.nextRunAt, locale) : undefined}>
                      <Icon name="clock" size={12} />
                      {repeatText(s.repeat, t, locale)} · {s.pending && !s.enabled ? <span className="warn-text">{t('sched.pending')}</span> : status(s)}
                      {creator && ` · ${t('sched.by', { handle: creator.handle })}`}
                      {failed && (
                        <span className="warn-text" title={noticeText(s.lastError, '')}>
                          {' '}
                          · {t('sched.failed')}
                        </span>
                      )}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="icon-btn member-more"
                  aria-label={t('sched.menu')}
                  aria-haspopup="menu"
                  aria-expanded={menu?.s.id === s.id}
                  data-menu-toggle
                  onClick={(e) => (menu?.s.id === s.id ? setMenu(null) : openMenu(s, e, e.currentTarget))}
                >
                  <Icon name="more" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={t('sched.menu')}
          items={actions(props.schedules.find((x) => x.id === menu.s.id) ?? menu.s)}
          onClose={() => setMenu(null)}
        />
      )}
      {editing && (
        <ScheduleDialog
          roomId={props.roomId}
          schedule={editing === 'new' ? null : editing}
          members={props.members}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** "YYYY-MM-DDTHH:MM" in local time, as a datetime-local input takes it. */
function localInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ScheduleDialog(props: { roomId: string; schedule: ScheduledTask | null; members: AgentWithStatus[]; onClose: () => void }) {
  const t = useT();
  const { locale } = usePrefs();
  const s = props.schedule;
  const r = s?.repeat;
  const inAnHour = new Date(Date.now() + 3600_000);
  inAnHour.setMinutes(0, 0, 0);
  // Every member (agentIds null), or the members picked, in the members' order.
  const [everyone, setEveryone] = useState(s?.agentIds === null);
  const [picked, setPicked] = useState<string[]>(
    s ? (s.agentIds ?? []).filter((id) => props.members.some((m) => m.id === id)) : props.members[0] ? [props.members[0].id] : [],
  );
  const agentIds = everyone ? null : props.members.filter((m) => picked.includes(m.id)).map((m) => m.id);
  const toggle = (id: string) => {
    setPicked(everyone ? [id] : picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
    setEveryone(false);
  };
  const [prompt, setPrompt] = useState(s?.prompt ?? '');
  const [kind, setKind] = useState<ScheduleRepeat['kind']>(r?.kind ?? 'daily');
  const [at, setAt] = useState(localInput(r?.kind === 'once' ? new Date(r.at) : inAnHour));
  const [time, setTime] = useState(r && 'time' in r ? r.time : '09:00');
  const [days, setDays] = useState<number[]>(r?.kind === 'weekly' ? r.days : [new Date().getDay()]);
  const hours = r?.kind === 'interval' && r.minutes % 60 === 0;
  const [every, setEvery] = useState(r?.kind === 'interval' ? String(hours ? r.minutes / 60 : r.minutes) : '1');
  const [unit, setUnit] = useState<'min' | 'hour'>(r?.kind === 'interval' && !hours ? 'min' : 'hour');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function repeat(): ScheduleRepeat | string {
    switch (kind) {
      case 'once': {
        const d = new Date(at);
        if (!at || Number.isNaN(d.getTime())) return t('sched.badTime');
        return { kind, at: d.toISOString() };
      }
      case 'daily':
        return { kind, time };
      case 'weekly':
        return days.length ? { kind, time, days } : t('sched.noDays');
      case 'interval': {
        const n = Number(every);
        const minutes = Math.round(n * (unit === 'hour' ? 60 : 1));
        if (!Number.isFinite(n) || minutes < SCHEDULE_MIN_INTERVAL_MINUTES) return t('sched.minInterval', { n: SCHEDULE_MIN_INTERVAL_MINUTES });
        return { kind, minutes };
      }
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const rep = repeat();
    if (typeof rep === 'string') return setError(rep);
    setBusy(true);
    setError(null);
    try {
      if (s) {
        // A one-time task that already ran starts again when given a new time.
        const restart = s.repeat.kind === 'once' && !s.enabled && s.lastResult !== null;
        await api.updateSchedule(props.roomId, s.id, { agentIds, prompt, repeat: rep, ...(restart ? { enabled: true } : {}) });
      } else {
        await api.createSchedule(props.roomId, { agentIds, prompt, repeat: rep });
      }
      props.onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  async function remove() {
    if (!s || busy) return;
    setBusy(true);
    try {
      await api.deleteSchedule(props.roomId, s.id);
      props.onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={s ? t('sched.edit') : t('sched.add')}
      busy={busy}
      onClose={props.onClose}
      actions={
        <>
          {s && (
            <button type="button" className="danger-outline push-left" disabled={busy} onClick={() => void remove()}>
              {t('common.delete')}
            </button>
          )}
          <button type="button" disabled={busy} onClick={props.onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" form="schedule-form" className="primary" disabled={busy || agentIds?.length === 0 || !prompt.trim()}>
            {s ? t('common.save') : t('common.create')}
          </button>
        </>
      }
    >
      <form id="schedule-form" className="form" onSubmit={(e) => void submit(e)}>
        <div className="field">
          <span className="field-label">{t('sched.assignee')}</span>
          <div className="schedule-assignees" role="group" aria-label={t('sched.assignee')}>
            <button type="button" aria-pressed={everyone} className={everyone ? 'on' : ''} onClick={() => setEveryone(true)}>
              <span className="avatar avatar-xs avatar-all">
                <Icon name="users" size={12} />
              </span>
              {t('sched.everyone')} @{ALL_HANDLE}
            </button>
            {props.members.map((m) => {
              const on = !everyone && picked.includes(m.id);
              return (
                <button key={m.id} type="button" aria-pressed={on} className={on ? 'on' : ''} title={m.displayName} onClick={() => toggle(m.id)}>
                  <AgentAvatar agent={m} className="avatar-xs" />@{m.handle}
                </button>
              );
            })}
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="schedule-prompt">
            {t('sched.prompt')}
          </label>
          <textarea id="schedule-prompt" rows={4} value={prompt} maxLength={10000} autoFocus onChange={(e) => setPrompt(e.target.value)} />
        </div>
        <div className="field">
          <span className="field-label">{t('sched.repeat')}</span>
          <div className="segmented" role="radiogroup" aria-label={t('sched.repeat')}>
            {(['once', 'daily', 'weekly', 'interval'] as const).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
                {t(`sched.kind.${k}`)}
              </button>
            ))}
          </div>
        </div>
        {kind === 'once' && (
          <div className="field">
            <label className="field-label" htmlFor="schedule-at">
              {t('sched.at')}
            </label>
            <DateTimeField id="schedule-at" value={at} onChange={setAt} />
          </div>
        )}
        {kind === 'weekly' && (
          <div className="field">
            <span className="field-label">{t('sched.days')}</span>
            <div className="schedule-days">
              {WEEK.map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={days.includes(d)}
                  className={days.includes(d) ? 'on' : ''}
                  onClick={() => setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]))}
                >
                  {weekdayName(d, locale)}
                </button>
              ))}
            </div>
          </div>
        )}
        {(kind === 'daily' || kind === 'weekly') && (
          <div className="field">
            <label className="field-label" htmlFor="schedule-time">
              {t('sched.at')}
            </label>
            <TimeField id="schedule-time" value={time} onChange={setTime} />
          </div>
        )}
        {kind === 'interval' && (
          <div className="field">
            <label className="field-label" htmlFor="schedule-every">
              {t('sched.every')}
            </label>
            <div className="schedule-every">
              <input id="schedule-every" type="number" min={1} step={1} value={every} onChange={(e) => setEvery(e.target.value)} />
              <select value={unit} aria-label={t('sched.every')} onChange={(e) => setUnit(e.target.value === 'min' ? 'min' : 'hour')}>
                <option value="min">{t('sched.unit.min')}</option>
                <option value="hour">{t('sched.unit.hour')}</option>
              </select>
            </div>
          </div>
        )}
        {error && <div className="error-text">{error}</div>}
      </form>
    </Dialog>
  );
}
