import { useState } from 'react';
import type { ActivityKind, AgentWithStatus, ApprovalAnswers, ApprovalAnswerValue, ApprovalDecision, ApprovalField, ApprovalForm, Message, SessionChoiceOption } from '../../../shared/protocol.ts';
import { api } from '../api.ts';
import { readableCommand } from '../format.ts';
import { localizeApprovalDetail, localizeDetail } from '../../../shared/notices.ts';
import { usePrefs, useT, type TFunc, useNoticeText } from '../i18n.tsx';
import { errorText } from './Dialog.tsx';
import { HelpTip } from './HelpTip.tsx';
import { Icon, type IconName } from './Icon.tsx';
import { AgentAvatar, RUNTIME_NAME } from './RuntimeBadge.tsx';

/** The member's avatar in the left gutter, on the first runtime row after someone else's message. */
const lead = (show: boolean | undefined, sender: AgentWithStatus | undefined) => (show && sender ? <AgentAvatar agent={sender} className="avatar-gutter" /> : null);

/**
 * Real runtime events: tool activity and native approval requests reported by the runtime itself. Mock agents never
 * produce these. Approval buttons send the local user's decision to the server, which forwards it on the exact native
 * request id; nothing here decides on its own.
 */

const ACTIVITY_ICON: Record<ActivityKind, IconName> = {
  command: 'terminal',
  fileChange: 'file',
  mcpToolCall: 'wrench',
  webSearch: 'search',
  plan: 'list',
  notice: 'info',
  reasoning: 'bulb',
  other: 'wrench',
};

const activityLabel = (t: TFunc, k: ActivityKind) => t(`activity.${k}`);

function statusText(t: TFunc, s: Message['status']): string {
  return t(`activity.${s}`);
}

/** Native statuses worth showing next to ours; plain synonyms ("completed", "inProgress"…) only go in the tooltip. */
function nativeStatusText(t: TFunc, s: string): string | undefined {
  if (s === 'declined' || s === 'denied' || s === 'rejected') return t('activity.declined');
  if (s === 'cancelled' || s === 'canceled') return t('activity.cancelled');
  if (s === 'sessionApproved') return t('activity.sessionApproved');
  return undefined;
}

export function ActivityItem({ message, sender, showAvatar }: { message: Message; sender?: AgentWithStatus; showAvatar?: boolean }) {
  const t = useT();
  const { lang } = usePrefs();
  const noticeText = useNoticeText();
  const meta = message.meta?.type === 'activity' ? message.meta : null;
  const kind = meta?.activity ?? 'other';
  const nativeExtra = meta?.nativeStatus ? nativeStatusText(t, meta.nativeStatus) : undefined;
  const status = nativeExtra ? `${statusText(t, message.status)} · ${nativeExtra}` : statusText(t, message.status);
  const rawTitle = noticeText(meta?.label, meta?.title ?? message.body);
  const title = kind === 'command' ? readableCommand(rawTitle) : rawTitle;
  const head = (
    <>
      <Icon name={ACTIVITY_ICON[kind]} size={14} className="activity-icon" />
      <span className="activity-kind">{activityLabel(t, kind)}</span>
      {sender && <span className="activity-who">@{sender.handle}</span>}
      {kind !== 'reasoning' && (
        <code className="activity-title" title={rawTitle !== title ? rawTitle : undefined}>
          {title}
        </code>
      )}
      <span className={`msg-status st-${message.status}`} title={meta?.nativeStatus ?? undefined}>
        {status}
      </span>
    </>
  );
  return (
    <div className={`activity activity-${message.status}`} data-seq={message.seq} data-native-item={meta?.nativeItemId}>
      {lead(showAvatar, sender)}
      {meta?.detail ? (
        <details className="activity-detail">
          <summary className="activity-head">{head}</summary>
          <pre>{localizeDetail(meta.detail, lang)}</pre>
        </details>
      ) : (
        <div className="activity-head">{head}</div>
      )}
    </div>
  );
}

type ApprovalMeta = Extract<NonNullable<Message['meta']>, { type: 'approval' }>;
/** Chat members ask for a command, a file or a website, and "for this session" covers exactly that one. */
const chatTarget = (meta: ApprovalMeta | null) =>
  meta?.runtime !== 'chat' ? null : meta.nativeMethod === 'chat/run_command' ? 'command' : meta.nativeMethod === 'chat/fetch_url' ? 'site' : 'file';
const SESSION_LABEL = { command: 'approval.allow_session_command', file: 'approval.allow_session_file', site: 'approval.allow_session_site' } as const;
const SESSION_HELP = { command: 'approval.help_allow_session_command', file: 'approval.help_allow_session_file', site: 'approval.help_allow_session_site' } as const;

function decisionLabel(t: TFunc, d: ApprovalDecision, meta: ApprovalMeta | null): string {
  if (d === 'allow' && meta?.form) return t(meta.form.url ? 'approval.urlDone' : meta.form.fields.length ? 'approval.submit' : 'approval.allow');
  if (d === 'allow_prefix') return t('approval.allow_prefix', { prefix: meta?.prefix ?? '' });
  if (d === 'allow_session' && meta?.scope) return t('approval.allow_session_scope', { scope: meta.scope });
  const target = chatTarget(meta);
  if (d === 'allow_session' && target) return t(SESSION_LABEL[target]);
  return t(`approval.${d}`);
}

function decisionHelp(t: TFunc, d: ApprovalDecision, meta: ApprovalMeta | null): string {
  const target = chatTarget(meta);
  if (d === 'allow_session' && target) return t(SESSION_HELP[target]);
  return t(`approval.help_${d}`);
}

export function ApprovalCard({ message, sender, showAvatar }: { message: Message; sender?: AgentWithStatus; showAvatar?: boolean }) {
  const t = useT();
  const { lang } = usePrefs();
  const noticeText = useNoticeText();
  const meta = message.meta?.type === 'approval' ? message.meta : null;
  const state = meta?.state ?? 'pending';
  const [busy, setBusy] = useState<ApprovalDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const options = meta?.options ?? [];
  const form = meta?.form ?? null;
  const [values, setValues] = useState<ApprovalAnswers>(() => (form ? initialAnswers(form) : {}));
  const incomplete = form ? form.fields.some((f) => f.required && !answered(values[f.id])) : false;
  const decide = (d: ApprovalDecision) => {
    setBusy(d);
    setError(null);
    api.decideApproval(message.id, d, form && d !== 'deny' ? values : undefined).then(
      () => setBusy(null),
      (e: unknown) => {
        setBusy(null);
        setError(errorText(e));
      },
    );
  };
  let outcome: string | null = null;
  if (meta && state === 'resolved') {
    outcome =
      meta.decidedBy === 'user'
        ? t('approval.chose', { decision: decisionLabel(t, meta.userDecision ?? 'deny', meta) })
        : t('approval.closed', { runtime: RUNTIME_NAME[meta.runtime] }) + (meta.decision ? ` (${meta.decision})` : '');
  }
  const body = noticeText(meta?.label, meta?.title ?? message.body);
  // Answered or closed: one line like a tool row; the details open on click.
  if (state !== 'pending') {
    const short = meta?.decidedBy === 'user' ? decisionLabel(t, meta.userDecision ?? 'deny', meta) : t(`approval.${state}`);
    return (
      <div className={`activity approval-done approval-${state}`} data-seq={message.seq} role="group" aria-label={t('approval.title')}>
        {lead(showAvatar, sender)}
        <details className="activity-detail">
          <summary className="activity-head">
            <Icon name="shield" size={14} className="activity-icon" />
            <span className="activity-kind">{t('approval.title')}</span>
            {sender && <span className="activity-who">@{sender.handle}</span>}
            <span className="activity-title">{body}</span>
            <span className="msg-status">{short}</span>
          </summary>
          <div className="approval-done-body">
            {meta?.reason && (
              <div className="approval-reason">
                <span className="approval-reason-label">{t('approval.reason')}</span> {meta.reason}
              </div>
            )}
            {meta?.detail && <pre className="approval-detail">{localizeApprovalDetail(meta.detail, lang)}</pre>}
            {meta?.workspace && (
              <div className="approval-where" title={`${meta.runtime} · ${meta.nativeMethod} · ${meta.nativeRequestId}`}>
                {meta.workspace}
              </div>
            )}
            {meta?.answers && (
              <dl className="approval-answers">
                {Object.entries(meta.answers).map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            )}
            {outcome && <div className="approval-outcome">{outcome}</div>}
          </div>
        </details>
      </div>
    );
  }
  return (
    <div className={`approval approval-${state}`} data-seq={message.seq} role="group" aria-label={t('approval.title')}>
      {lead(showAvatar, sender)}
      <div className="approval-title">
        <Icon name="shield" size={14} />
        <span>{t('approval.title')}</span>
        <HelpTip
          text={[t(chatTarget(meta) ? 'approval.help_chat' : 'approval.help'), ...options.map((d) => decisionHelp(t, d, meta))].join(' ')}
        />
        {sender && <span className="approval-who">@{sender.handle}</span>}
        <span className={`approval-state state-${state}`}>{t(`approval.${state}`)}</span>
      </div>
      <div className="approval-body">{body}</div>
      {meta?.reason && (
        <div className="approval-reason">
          <span className="approval-reason-label">{t('approval.reason')}</span> {meta.reason}
        </div>
      )}
      {meta?.detail && <pre className="approval-detail">{localizeApprovalDetail(meta.detail, lang)}</pre>}
      {meta?.workspace && (
        <div className="approval-where" title={`${meta.runtime} · ${meta.nativeMethod} · ${meta.nativeRequestId}`}>
          {meta.workspace}
        </div>
      )}
      {outcome && <div className="approval-outcome">{outcome}</div>}
      {form?.url && options.includes('allow') && (
        <a className="approval-url" href={form.url} target="_blank" rel="noopener noreferrer" title={form.url}>
          <Icon name="external" size={13} /> {t('approval.openUrl')} <span>{form.url}</span>
        </a>
      )}
      {form && form.fields.length > 0 && options.includes('allow') && (
        <div className="approval-form">
          {form.fields.map((f) => (
            <FormField key={f.id} field={f} value={values[f.id]} disabled={busy !== null} onChange={(v) => setValues((cur) => ({ ...cur, [f.id]: v }))} />
          ))}
        </div>
      )}
      {state === 'pending' && options.length > 0 && (
        <div className="approval-actions">
          {options.map((d) => (
            <button
              key={d}
              type="button"
              className={d === 'deny' ? 'danger-outline' : d === 'allow' ? 'primary' : undefined}
              disabled={busy !== null || (d === 'allow' && incomplete)}
              onClick={() => decide(d)}
            >
              {busy === d ? t('approval.sending') : decisionLabel(t, d, meta)}
            </button>
          ))}
        </div>
      )}
      {state === 'pending' && options.length === 0 && <div className="hint">{t('approval.cannotAnswer')}</div>}
      {error && <div className="error-text">{t('approval.notSent', { error })}</div>}
    </div>
  );
}

const answered = (v: ApprovalAnswerValue | undefined) =>
  v !== undefined && v !== '' && !(typeof v === 'object' && !v.selected.length && !(v.other ?? '').trim());

function initialAnswers(form: ApprovalForm): ApprovalAnswers {
  const out: ApprovalAnswers = {};
  for (const f of form.fields) {
    if (f.kind === 'choice') out[f.id] = { selected: f.default ?? [] };
    else if (f.kind === 'boolean') out[f.id] = f.default ?? false;
    else if (f.default != null) out[f.id] = f.default;
  }
  return out;
}

const INPUT_TYPE = { email: 'email', uri: 'url', date: 'date', 'date-time': 'datetime-local' } as const;

/** One field of a native form (questions from Codex / Claude Code, or an MCP server's form). */
function FormField({ field: f, value, disabled, onChange }: { field: ApprovalField; value: ApprovalAnswerValue | undefined; disabled: boolean; onChange: (v: ApprovalAnswerValue) => void }) {
  const t = useT();
  const head = (
    <>
      {'header' in f && f.header && <span className="approval-field-header">{f.header}</span>}
      <span className="approval-field-label">
        {f.label}
        {f.required && f.kind !== 'boolean' && <span className="approval-field-req"> *</span>}
      </span>
      {f.description && <span className="approval-field-desc">{f.description}</span>}
    </>
  );
  if (f.kind === 'boolean') {
    return (
      <label className="approval-field approval-check">
        <input type="checkbox" checked={value === true} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span>{head}</span>
      </label>
    );
  }
  if (f.kind === 'choice') {
    const cur = value && typeof value === 'object' ? value : { selected: [] as string[], other: null };
    const otherOn = cur.other != null;
    const pick = (v: string, on: boolean) => {
      if (!f.multiple) return onChange({ selected: on ? [v] : [] });
      const sel = on ? [...cur.selected.filter((x) => x !== v), v] : cur.selected.filter((x) => x !== v);
      onChange(otherOn ? { selected: sel, other: cur.other } : { selected: sel });
    };
    const name = `f-${f.id}`;
    return (
      <fieldset className="approval-field">
        <legend>{head}</legend>
        {f.options.map((o) => (
          <label key={o.value} className="approval-option">
            <input
              type={f.multiple ? 'checkbox' : 'radio'}
              name={name}
              checked={cur.selected.includes(o.value)}
              disabled={disabled}
              onChange={(e) => pick(o.value, e.target.checked)}
            />
            <span>
              {o.label}
              {o.description && <span className="approval-option-desc">{o.description}</span>}
            </span>
          </label>
        ))}
        {f.other && (
          <label className="approval-option approval-other">
            <input
              type={f.multiple ? 'checkbox' : 'radio'}
              name={name}
              checked={otherOn}
              disabled={disabled}
              onChange={(e) => onChange(e.target.checked ? { selected: f.multiple ? cur.selected : [], other: cur.other ?? '' } : { selected: cur.selected })}
            />
            <span>{t('approval.other')}</span>
            <input
              type="text"
              value={cur.other ?? ''}
              disabled={disabled}
              aria-label={t('approval.other')}
              onFocus={() => !otherOn && onChange({ selected: f.multiple ? cur.selected : [], other: '' })}
              onChange={(e) => onChange({ selected: f.multiple ? cur.selected : [], other: e.target.value })}
            />
          </label>
        )}
      </fieldset>
    );
  }
  if (f.kind === 'number') {
    return (
      <label className="approval-field">
        {head}
        <input
          type="number"
          value={typeof value === 'number' ? value : typeof value === 'string' ? value : ''}
          min={f.min ?? undefined}
          max={f.max ?? undefined}
          step={f.integer ? 1 : 'any'}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        />
      </label>
    );
  }
  return (
    <label className="approval-field">
      {head}
      <input
        type={f.secret ? 'password' : f.format ? INPUT_TYPE[f.format] : 'text'}
        value={typeof value === 'string' ? value : ''}
        maxLength={f.maxLength ?? undefined}
        autoComplete="off"
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/**
 * "A member's session could not be resumed": the notice text plus the user's choice (restore the archived session /
 * retry / start a new one). Messages to that member wait until one is picked.
 */
export function SessionChoiceCard({ message, sender }: { message: Message; sender?: AgentWithStatus }) {
  const t = useT();
  const noticeText = useNoticeText();
  const meta = message.meta?.type === 'notice' ? message.meta : null;
  const sc = meta?.sessionChoice;
  const [busy, setBusy] = useState<SessionChoiceOption | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!meta || !sc) return null;
  const [summary = '', ...rest] = noticeText(meta.notice, message.body).split('\n');
  const choose = (c: SessionChoiceOption) => {
    setBusy(c);
    setError(null);
    api.chooseSession(message.id, c).then(
      () => setBusy(null),
      (e: unknown) => {
        setBusy(null);
        setError(errorText(e));
      },
    );
  };
  const done = sc.state !== 'pending';
  return (
    <div className={`approval session-choice${done ? ' approval-resolved' : ' approval-pending'}`} data-seq={message.seq} role="group" aria-label={t('choice.title')}>
      <div className="approval-title">
        <Icon name="info" size={14} />
        <span>{t('choice.title')}</span>
        {sender && <span className="approval-who">@{sender.handle}</span>}
        <span className={`approval-state state-${done ? 'resolved' : 'pending'}`}>{done ? t('choice.decided') : t('choice.waiting')}</span>
      </div>
      <div className="approval-body">{summary}</div>
      {rest.length > 0 && <pre className="approval-detail">{rest.join('\n')}</pre>}
      {sc.state !== 'pending' && <div className="approval-outcome">{t(`choice.did_${sc.state}`)}</div>}
      {!done && (
        <div className="approval-actions">
          {sc.options.map((c) => (
            <button key={c} type="button" className={c === sc.options[0] ? 'primary' : undefined} disabled={busy !== null} onClick={() => choose(c)}>
              {busy === c ? t('approval.sending') : t(`choice.${c}`)}
            </button>
          ))}
        </div>
      )}
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}

/** What a folded group still shows: the latest item and anything still running. Failures are counted in the head. */
export const foldedActivities = (messages: Message[]) =>
  messages.filter((m, i) => i === messages.length - 1 || m.status === 'streaming');

/**
 * A run of consecutive tool activities by one member, folded to a summary line so long tool logs do not bury the
 * conversation.
 */
export function ActivityGroup({ messages, sender, showAvatar }: { messages: Message[]; sender?: AgentWithStatus; showAvatar?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const running = messages.filter((m) => m.status === 'streaming').length;
  const failed = messages.filter((m) => m.status === 'failed').length;
  const kinds = new Map<ActivityKind, number>();
  for (const m of messages) {
    const k = m.meta?.type === 'activity' ? m.meta.activity : 'other';
    kinds.set(k, (kinds.get(k) ?? 0) + 1);
  }
  const summary = [...kinds].map(([k, n]) => `${activityLabel(t, k)} ${n}`).join(' · ');
  const last = messages[messages.length - 1]!;
  const visible = open ? messages : foldedActivities(messages);
  return (
    <div className="activity-group" data-seq={messages[0]!.seq} data-last-seq={last.seq}>
      {lead(showAvatar, sender)}
      <button type="button" className="activity-group-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
        <span>
          {t('activity.group', { n: messages.length })}
          {sender ? ` · @${sender.handle}` : ''}
        </span>
        <span className="muted">{summary}</span>
        {running > 0 && <span className="msg-status st-streaming">{t('activity.running', { n: running })}</span>}
        {failed > 0 && <span className="msg-status st-failed">{t('activity.failedN', { n: failed })}</span>}
      </button>
      {visible.map((m) => (
        <ActivityItem key={m.id} message={m} sender={sender} />
      ))}
    </div>
  );
}
