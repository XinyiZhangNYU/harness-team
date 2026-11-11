import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type {
  AgentDetailResponse,
  AgentLanguage,
  AgentWithStatus,
  PermissionMode,
  PermissionModeAvailability,
  RuntimeDescriptor,
  RuntimeKind,
  RuntimeModelCatalog,
  Room,
} from '../../../shared/protocol.ts';
import {
  ANTIGRAVITY_TERMS_URL,
  COLLAB_WARNING_VERSION,
  HANDLE_MAX,
  HANDLE_PATTERN,
  isAgentAvatar,
  avatarDefaultKey,
  chatAvatarKey,
  isAvatarDefaultKind,
  PERMISSION_MODES,
  PERMISSION_WARNING_VERSION,
  RISKY_PERMISSION_MODES,
  RESERVED_HANDLES,
  codexImplicitEffort,
  handleKey,
  handleLength,
} from '../../../shared/protocol.ts';
import { N, permissionLabel } from '../../../shared/notices.ts';
import { api, ApiError } from '../api.ts';
import { AvatarError, avatarFromFile } from '../avatar.ts';
import { autoPickRuntime, defaultMemberName, pickAfterDetect, runtimeRadioHandlers, uniqueMemberName } from '../runtime-pick.ts';
import { usePrefs, useT, type TFunc, useLocalized, useNoticeText } from '../i18n.tsx';
import { ContextMenu, type MenuItem } from './ContextMenu.tsx';
import { Dialog, errorText } from './Dialog.tsx';
import { HelpTip } from './HelpTip.tsx';
import { Icon } from './Icon.tsx';
import { groupModels } from '../model-groups.ts';
import { AgentAvatar, AvatarDefaultsContext, MeteredBadge, RUNTIME_NAME, RuntimeBadge } from './RuntimeBadge.tsx';
import { ChatModelPicker, ChatSettingsFields, cachedChatModel, chatDefaults, usableProviders, useChatModel, useChatProviders } from './ChatProviders.tsx';
import { WorkspacePicker } from './WorkspacePicker.tsx';

// ---- model catalog (always discovered from the runtime through the Core; never a list in the UI) ----

const catalogCache = new Map<string, RuntimeModelCatalog>();
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The nearest ancestor that scrolls vertically. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if ((y === 'auto' || y === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

const catalogKey = (kind: RuntimeKind, cwd?: string | null) => `${kind}|${cwd ?? ''}`;

/**
 * The runtime's model catalog. A list loaded earlier shows at once and is asked for again every time (the Core keeps
 * its own short cache), so models the runtime adds later appear without reopening the app. `generation` changes after
 * the harnesses were detected again.
 */
function useCatalog(kind: RuntimeKind, cwd?: string | null, generation = 0) {
  const key = catalogKey(kind, cwd);
  const [state, setState] = useState<{ key: string; catalog: RuntimeModelCatalog | null; loading: boolean; error: string | null }>(
    () => ({ key, catalog: catalogCache.get(key) ?? null, loading: false, error: null }),
  );
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    const cached = catalogCache.get(key);
    setState({ key, catalog: cached ?? null, loading: !cached, error: null });
    api
      .modelCatalog(kind, { refresh: nonce > 0, ...(cwd ? { cwd } : {}) })
      .then((catalog) => {
        if (catalog.available) catalogCache.set(key, catalog);
        if (alive) setState({ key, catalog, loading: false, error: null });
      })
      .catch((err) => {
        // A failed request does not hide a list that loaded before.
        if (alive) setState(cached ? { key, catalog: cached, loading: false, error: null } : { key, catalog: null, loading: false, error: errorText(err) });
      });
    return () => {
      alive = false;
    };
  }, [key, nonce, generation]);
  const current = state.key === key ? state : { key, catalog: null, loading: true, error: null };
  return { ...current, reload: () => setNonce((n) => n + 1) };
}

/** Looks a model up in whatever catalog is already loaded (display only; no request). */
function knownModel(kind: RuntimeKind, id: string | null) {
  if (!id) return null;
  for (const [k, c] of catalogCache)
    if (k.startsWith(`${kind}|`)) {
      // The runtime reports the full model it resolved an alias to (e.g. "opus" -> "claude-opus-…").
      const m = c.models.find((x) => x.id === id) ?? c.models.find((x) => x.resolvedModel === id);
      if (m) return m;
    }
  return null;
}

/** A model value as people know it: dsh's values are JSON pairs such as ["deepseek-official","deepseek-flash"]. */
function plainModelId(id: string): string {
  if (!id.startsWith('[')) return id;
  try {
    const v: unknown = JSON.parse(id);
    if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string')) return v[v.length - 1] as string;
  } catch {
    // not JSON: shown as it is
  }
  return id;
}

const titleCase = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const EFFORTS = new Set(['none', 'off', 'on', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
/** Reasoning effort in the UI language; values this build does not know stay as the runtime reported them. */
const effortName = (t: TFunc, s: string) =>
  s === 'disabled' ? t('effort.off') : s === 'enabled' ? t('effort.on') : EFFORTS.has(s) ? t(`effort.${s}` as Parameters<TFunc>[0]) : titleCase(s);

/** e.g. "Opus · High"; "Default (GPT-5) · Default (Medium)" when following the runtime's own configuration. */
export function configSummary(a: AgentWithStatus, t: TFunc): string {
  if (a.isMock) return 'Mock';
  // When following the runtime's default, show what the runtime itself reported it is using.
  const eff = a.effective;
  const name = (id: string) =>
    a.runtimeKind === 'chat' ? cachedChatModel(a.providerId, id)?.displayName || id : (knownModel(a.runtimeKind, id)?.displayName ?? id);
  const model = a.model ? name(a.model) : eff?.model ? t('common.defaultOf', { value: name(eff.model) }) : t('common.default');
  const effort = a.effort ? effortName(t, a.effort) : eff?.effort ? t('common.defaultOf', { value: effortName(t, eff.effort) }) : null;
  return effort ? `${model} · ${effort}` : model;
}

/** Model + effort selects fed only by the runtime's own catalog. "" = follow the runtime's default. */
function ModelEffortFields(props: {
  runtimeKind: RuntimeKind;
  cwd?: string | null;
  /** Changes after the harnesses were detected again: the catalog is asked for again. */
  generation?: number;
  model: string;
  effort: string;
  onChange: (v: { model: string; effort: string }) => void;
  /** Whether the model that will run (the chosen one, else the runtime's default) is billed per token. */
  onMetered?: (metered: boolean) => void;
}) {
  const t = useT();
  const lz = useLocalized();
  const { catalog, loading, error, reload } = useCatalog(props.runtimeKind, props.cwd, props.generation);
  const models = catalog?.available ? catalog.models : [];
  const failed = error || (catalog && !catalog.available) ? (error ?? lz(catalog?.error)) : null;
  const status = loading ? (
    <div className="hint">{t('model.loading')}</div>
  ) : failed !== null ? (
    <div className="error-text">
      {t('model.error', { error: failed })}{' '}
      <button type="button" className="link" onClick={reload}>
        {t('common.retry')}
      </button>
    </div>
  ) : null;

  const selected = models.find((m) => m.id === props.model) ?? null;
  // A saved model that the runtime no longer lists stays visible (and is rejected by the Core) instead of vanishing.
  const unknownSaved = props.model && !selected;
  const efforts = props.model ? (selected?.efforts ?? []) : (catalog?.nativeDefault?.efforts ?? []);
  const unknownEffort = props.effort && !efforts.includes(props.effort);
  const nd = catalog?.nativeDefault;
  // What "Default" really runs with. Codex with an explicit model keeps the configured effort when the model supports it
  // (same rule as the Core's turn overrides), so the label must not just show the model's own default.
  const defEffort = props.model
    ? selected && (props.runtimeKind === 'codex' ? codexImplicitEffort(selected, nd?.effort) : selected.defaultEffort)
    : nd?.effort;
  const defaultEffortText = defEffort ? t('common.defaultOf', { value: effortName(t, defEffort) }) : t('common.default');
  const isMock = props.runtimeKind === 'mock';
  const metered = (id: string) => models.find((m) => m.id === id)?.billing === 'metered_api';
  const hosted = (id: string) =>
    props.runtimeKind === 'opencode' && id.startsWith('opencode/') ? ` · ${t('model.opencodeHosted')}` : metered(id) ? ` · ${t('billing.metered')}` : '';
  const modelOption = (m: (typeof models)[number]) => (
    <option key={m.id} value={m.id} title={lz(m.description) || m.resolvedModel || undefined}>
      {m.displayName}
      {m.displayName.toLowerCase().replace(/[\s.-]/g, '') !== plainModelId(m.id).toLowerCase().replace(/[\s.-]/g, '') ? ` · ${plainModelId(m.id)}` : ''}
      {hosted(m.id)}
    </option>
  );
  const runsMetered = metered(props.model || (nd?.model ?? ''));
  useEffect(() => props.onMetered?.(runsMetered), [runsMetered]);
  useEffect(() => () => props.onMetered?.(false), []);
  const groups = groupModels(props.runtimeKind, models);
  const defModel = nd?.model ? `${knownModel(props.runtimeKind, nd.model)?.displayName ?? nd.model}${hosted(nd.model)}` : null;

  return (
    <>
      <div className="field-row">
        <div className="field">
          <label className="field-label">{t('model.model')}</label>
          <select
            value={props.model}
            disabled={isMock}
            onChange={(e) => {
              const model = e.target.value;
              const next = model ? (models.find((m) => m.id === model)?.efforts ?? []) : (nd?.efforts ?? []);
              props.onChange({ model, effort: next.includes(props.effort) ? props.effort : '' });
            }}
          >
            <option value="">{defModel ? t('common.defaultOf', { value: defModel }) : t('common.default')}</option>
            {groups.main.map(modelOption)}
            {groups.pinned.length > 0 && <optgroup label={t('model.pinned')}>{groups.pinned.map(modelOption)}</optgroup>}
            {unknownSaved && <option value={props.model}>{t('model.notListed', { model: props.model })}</option>}
          </select>
        </div>
        <div className="field">
          <label className="field-label">{t('model.effort')}</label>
          <select
            value={props.effort}
            disabled={isMock || (efforts.length === 0 && !unknownEffort)}
            onChange={(e) => props.onChange({ model: props.model, effort: e.target.value })}
          >
            <option value="">{defaultEffortText}</option>
            {efforts.map((x) => (
              <option key={x} value={x}>
                {effortName(t, x)}
              </option>
            ))}
            {unknownEffort && <option value={props.effort}>{t('model.unsupported', { value: props.effort })}</option>}
          </select>
        </div>
      </div>
      {!isMock && status}
    </>
  );
}

const isRiskyMode = (m: string | null | undefined) => !!m && RISKY_PERMISSION_MODES.includes(m as PermissionMode);

/** What a request must carry to set `mode`: the warning version for a mode in which nothing asks for approval. */
const permissionRiskAck = (mode: string | null | undefined) => (isRiskyMode(mode) ? { acknowledgePermissionRisk: PERMISSION_WARNING_VERSION } : {});

/**
 * The permission mode select ("" = follow the user's own runtime settings); what the choice does is in the "?" tip.
 * A mode in which nothing asks for approval is taken only through the warning's own button.
 */
function PermissionField(props: {
  runtimeKind: RuntimeKind;
  value: string;
  handle: string;
  cwd?: string | null;
  generation?: number;
  onChange: (v: string) => void;
}) {
  const t = useT();
  const lz = useLocalized();
  const noticeText = useNoticeText();
  const [asking, setAsking] = useState<string | null>(null);
  // What this machine allows, as the runtime reports it.
  const { catalog } = useCatalog(props.runtimeKind, props.cwd, props.generation);
  const modes = PERMISSION_MODES[props.runtimeKind] ?? [];
  if (!modes.length) return null;
  const runtime = RUNTIME_NAME[props.runtimeKind];
  const label = (m: PermissionMode) => noticeText(permissionLabel(props.runtimeKind, m), m);
  const off = unavailableModes(catalog);
  const offTip = [...off].map(([m, why]) => `${label(m)}: ${lz(why)}`).join('\n');
  // A saved mode this build does not offer (cannot normally happen) stays visible instead of silently changing.
  const unknown = props.value && !modes.includes(props.value as PermissionMode);
  const help = props.value
    ? ((props.runtimeKind === 'opencode' || props.runtimeKind === 'cursor' || props.runtimeKind === 'kimi' ? `permHelp.${props.runtimeKind}.${props.value}` : `permHelp.${props.value}`) as Parameters<TFunc>[0])
    : 'permHelp.follow';
  return (
    <div className="field">
      <label className="field-label" htmlFor={`perm-${props.runtimeKind}`}>
        {t('perm.label')}{' '}
        <HelpTip text={`${unknown ? t('perm.help', { runtime }) : `${t(help, { runtime })} ${t('perm.help', { runtime })}`}${offTip ? `\n\n${offTip}` : ''}`} />
      </label>
      <select
        id={`perm-${props.runtimeKind}`}
        value={props.value}
        onChange={(e) => (isRiskyMode(e.target.value) ? setAsking(e.target.value) : props.onChange(e.target.value))}
      >
        <option value="">{noticeText(N('perm.follow'), '')}</option>
        {modes.map((m) => (
          <option key={m} value={m} disabled={off.has(m) && props.value !== m} title={off.has(m) ? lz(off.get(m)!) : undefined}>
            {label(m)}
          </option>
        ))}
        {unknown && <option value={props.value}>{props.value}</option>}
      </select>
      {asking && (
        <PermissionRiskDialog
          handle={props.handle}
          mode={label(asking as PermissionMode)}
          onKeep={() => setAsking(null)}
          onEnable={() => {
            props.onChange(asking);
            setAsking(null);
          }}
        />
      )}
    </div>
  );
}

/** Modes the runtime reports as turned off on this machine, with its reason (empty when it could not be checked). */
function unavailableModes(catalog: RuntimeModelCatalog | null | undefined): Map<PermissionMode, NonNullable<PermissionModeAvailability['reason']>> {
  const out = new Map<PermissionMode, NonNullable<PermissionModeAvailability['reason']>>();
  for (const m of catalog?.permissionModes ?? []) if (!m.available) out.set(m.id, m.reason ?? m.id);
  return out;
}

/** The warning before a mode in which nothing asks for approval. The checkbox starts unticked. */
function PermissionRiskDialog(props: { handle: string; mode: string; busy?: boolean; onKeep: () => void; onEnable: () => void }) {
  const t = useT();
  const [checked, setChecked] = useState(false);
  const handle = props.handle || '…';
  return (
    <Dialog
      title={t('permRisk.title', { handle: `@${handle}` })}
      className="collab-risk"
      alert
      busy={props.busy}
      onClose={props.onKeep}
      actions={
        <>
          <button type="button" autoFocus disabled={props.busy} onClick={props.onKeep}>
            {t('permRisk.keep')}
          </button>
          <button type="button" className="danger" disabled={!checked || props.busy} onClick={props.onEnable}>
            {t('permRisk.enable')}
          </button>
        </>
      }
    >
      <div className="form">
        <div className="banner banner-warn">{t('permRisk.body', { handle, mode: props.mode })}</div>
        <label className="check">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          <span>{t('permRisk.check')}</span>
        </label>
      </div>
    </Dialog>
  );
}

/**
 * Antigravity's collaboration mode. It is saved at once (not with the form): restricted needs no confirmation; full
 * opens the risk warning every time it is chosen, and only the warning's own button enables it.
 */
function CollabModeField(props: { agent: AgentWithStatus; onResult: (r: { ok: boolean; text: string }) => void }) {
  const { t, locale } = usePrefs();
  const a = props.agent;
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (a.runtimeKind !== 'antigravity') return null;
  const mode = a.collabMode ?? 'restricted';

  const apply = async (next: 'restricted' | 'full') => {
    setBusy(true);
    try {
      await api.updateAgent(a.id, next === 'full' ? { collabMode: 'full', acknowledgeCollabRisk: COLLAB_WARNING_VERSION } : { collabMode: 'restricted' });
      setAsking(false);
      props.onResult({ ok: true, text: t('agent.saved') });
    } catch (err) {
      props.onResult({ ok: false, text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <CollabModeSelect
      value={mode}
      busy={busy}
      asking={asking}
      title={a.collabConfirmedAt ? t('collab.confirmedAt', { time: new Date(a.collabConfirmedAt).toLocaleString(locale, { hourCycle: 'h23' }) }) : undefined}
      onAsk={setAsking}
      onRestricted={() => void apply('restricted')}
      onEnable={() => void apply('full')}
    />
  );
}

/** The collaboration mode field: choosing full opens the warning, which alone can enable it. */
function CollabModeSelect(props: {
  value: 'restricted' | 'full';
  busy: boolean;
  asking: boolean;
  title?: string;
  onAsk: (asking: boolean) => void;
  onRestricted: () => void;
  onEnable: () => void;
}) {
  const t = useT();
  return (
    <div className="field">
      <label className="field-label" htmlFor="collab-mode">
        {t('collab.label')} <HelpTip text={t('collab.help')} />
      </label>
      <select
        id="collab-mode"
        value={props.value}
        disabled={props.busy}
        title={props.title}
        onChange={(e) => (e.target.value === 'full' ? props.onAsk(true) : props.onRestricted())}
      >
        <option value="restricted">{t('collab.restricted')}</option>
        <option value="full">{t('collab.full')}</option>
      </select>
      {props.asking && <CollabRiskDialog busy={props.busy} onKeep={() => props.onAsk(false)} onEnable={props.onEnable} />}
    </div>
  );
}

/** The full-mode warning. The checkbox starts unticked; closing it in any other way keeps restricted mode. */
function CollabRiskDialog(props: { busy: boolean; onKeep: () => void; onEnable: () => void }) {
  const t = useT();
  const [checked, setChecked] = useState(false);
  return (
    <Dialog
      title={t('collab.riskTitle')}
      className="collab-risk"
      alert
      busy={props.busy}
      onClose={props.onKeep}
      actions={
        <>
          <button type="button" autoFocus disabled={props.busy} onClick={props.onKeep}>
            {t('collab.keep')}
          </button>
          <button type="button" className="danger" disabled={!checked || props.busy} onClick={props.onEnable}>
            {t('collab.enable')}
          </button>
        </>
      }
    >
      <div className="form">
        <div className="banner banner-warn">{t('collab.riskBody')}</div>
        <p>{t('collab.riskLegal')}</p>
        <p>
          <a href={ANTIGRAVITY_TERMS_URL} target="_blank" rel="noreferrer noopener">
            {t('collab.terms')}
          </a>
        </p>
        <label className="check">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          <span>{t('collab.riskCheck')}</span>
        </label>
      </div>
    </Dialog>
  );
}

function handleProblem(h: string, t: TFunc): string | null {
  if (!h) return null;
  if (handleLength(h) > HANDLE_MAX) return t('handle.tooLong');
  if (!/^\p{L}/u.test(h)) return t('handle.start');
  if (!HANDLE_PATTERN.test(h)) return t('handle.chars');
  if (RESERVED_HANDLES.has(handleKey(h))) return t('handle.reserved', { handle: h });
  return null;
}

/** A path compared as a folder: no trailing separator; Windows paths (drive letter or backslash) case-insensitively. */
function folderKey(p: string): string {
  const windows = /^[A-Za-z]:|\\/.test(p);
  const s = (windows ? p.replace(/\//g, '\\') : p).replace(/[\\/]+$/, '');
  return windows ? s.toLowerCase() : s;
}

/** A member's working folder that is neither the chat's project folder nor inside it. */
function outsideFolder(workspace: string, projectDir: string | null): boolean {
  if (!projectDir) return false;
  const w = folderKey(workspace);
  const d = folderKey(projectDir);
  return w !== d && !w.startsWith(d + '\\') && !w.startsWith(d + '/');
}

/** Mock is a developer tool: offered for new members only in dev builds (existing Mock members keep working). */
const SHOW_MOCK = import.meta.env.DEV;

type MemberMenu = { agent: AgentWithStatus; x: number; y: number };

export function MembersPanel(props: {
  room: Room;
  members: AgentWithStatus[];
  allAgents: AgentWithStatus[];
  runtimes: RuntimeDescriptor[];
  /** Opens this member's settings when it changes (asked for from the chat, e.g. "/model"). */
  openMember?: { agentId: string; n: number } | null;
  /** Opens the "Add member" dialog when it changes (application menu). */
  addMember?: number;
  onError: (err: unknown) => void;
  /** Shown as a drawer: a close button goes in the header. */
  onClose?: () => void;
  /** Hides the docked panel (wide layout); the chat header then shows a members button to bring it back. */
  onCollapse?: () => void;
}) {
  const t = useT();
  const lz = useLocalized();
  const roomId = props.room.id;
  const memberIds = new Set(props.members.map((m) => m.id));
  const others = props.allAgents.filter((a) => !memberIds.has(a.id) && !a.deletedAt);
  const defaults = new Set(props.room.defaultResponders.filter((id) => memberIds.has(id)));
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    if (props.openMember) setOpenId(props.openMember.agentId);
  }, [props.openMember]);
  const open = openId ? props.allAgents.find((a) => a.id === openId && !a.deletedAt) : undefined;
  const [menu, setMenu] = useState<MemberMenu | null>(null);
  // The permission-mode menu opened from a member's menu, and the warning before a mode in which nothing asks.
  const [modeMenu, setModeMenu] = useState<MemberMenu | null>(null);
  const [riskAsk, setRiskAsk] = useState<{ agent: AgentWithStatus; mode: PermissionMode } | null>(null);
  const [modeBusy, setModeBusy] = useState(false);
  const panelNoticeText = useNoticeText();
  const [removing, setRemoving] = useState<AgentWithStatus | null>(null);
  const [deleting, setDeleting] = useState<AgentWithStatus | null>(null);
  const [adding, setAdding] = useState(false);
  const addSeen = useRef(props.addMember ?? 0);
  useEffect(() => {
    if ((props.addMember ?? 0) === addSeen.current) return;
    addSeen.current = props.addMember ?? 0;
    setAdding(true);
  }, [props.addMember]);
  const [flash, setFlash] = useState<string | null>(null);
  // Drag to reorder: the order shown while dragging and until the server's `members.reordered` arrives.
  const memberKey = props.members.map((m) => m.id).join(',');
  const [order, setOrder] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  // The click that ends a drag does not open the member.
  const suppressClick = useRef(false);
  useEffect(() => setOrder(null), [memberKey]);
  // A member moved with Alt+arrow keeps the focus (moving its row in the page drops it).
  const refocus = useRef<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => {
    const id = refocus.current;
    if (!id) return;
    refocus.current = null;
    const btn = listRef.current?.querySelector<HTMLButtonElement>(`li[data-member="${CSS.escape(id)}"] .member-open`);
    if (btn && document.activeElement !== btn) btn.focus();
  });
  const shown = order ? order.map((id) => props.members.find((m) => m.id === id)).filter((m): m is AgentWithStatus => !!m) : props.members;
  const moveTo = (id: string, to: number) => {
    const ids = (order ?? props.members.map((m) => m.id)).filter((x) => x !== id);
    ids.splice(Math.max(0, Math.min(to, ids.length)), 0, id);
    setOrder(ids);
    return ids;
  };
  const saveOrder = (ids: string[]) => {
    if (ids.join(',') === memberKey) return setOrder(null);
    api.reorderMembers(roomId, ids).catch((e) => {
      setOrder(null);
      props.onError(e);
    });
  };
  // Rows glide to their new places whenever the order changes: a drop, Alt+arrow, another window's reorder, a removal.
  const shownKey = shown.map((m) => m.id).join(',');
  const lastLayout = useRef<{ key: string; tops: Map<string, number> } | null>(null);
  // Where each row was on screen when a drag ended, so the drop starts from there.
  const dropTops = useRef<Map<string, number> | null>(null);
  useLayoutEffect(() => {
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('li[data-member]') ?? [])];
    const prev = dropTops.current ?? (lastLayout.current?.key !== shownKey ? lastLayout.current?.tops : undefined);
    dropTops.current = null;
    lastLayout.current = { key: shownKey, tops: new Map(rows.map((li) => [li.dataset.member!, li.offsetTop])) };
    if (!prev || reducedMotion()) return;
    for (const li of rows) {
      const from = prev.get(li.dataset.member!);
      const dy = from === undefined ? 0 : from - li.offsetTop;
      if (dy && typeof li.animate === 'function') {
        li.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 200, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
      }
    }
  });
  // Pointer drag: past a few pixels the member follows the pointer and the others slide out of its way; the list
  // scrolls when the pointer nears its edge. Nothing is re-rendered until the drop. Esc puts it back.
  const drag = useRef<(() => void) | null>(null);
  useEffect(() => () => drag.current?.(), []);
  useEffect(() => drag.current?.(), [memberKey]);
  const startDrag = (e: React.PointerEvent<HTMLLIElement>, id: string) => {
    const list = listRef.current;
    if (e.button !== 0 || !e.isPrimary || shown.length < 2 || drag.current || !list) return;
    if ((e.target as HTMLElement).closest('.member-more, .member-stop')) return;
    const pointer = e.pointerId;
    const startY = e.clientY;
    let clientY = startY;
    const ids = shown.map((m) => m.id);
    const from = ids.indexOf(id);
    if (from < 0) return;
    let rows: HTMLElement[] = [];
    let tops: number[] = [];
    let heights: number[] = [];
    let step = 0;
    let listTop = 0;
    let to = from;
    let dy = 0;
    let started = false;
    let frame = 0;
    const scroller = scrollParent(list);
    const offset = (k: number) => (k === from ? dy : from < k && k <= to ? -step : to <= k && k < from ? step : 0);
    const place = () => {
      const lastBottom = tops[tops.length - 1]! + heights[heights.length - 1]!;
      dy = Math.max(tops[0]! - tops[from]!, Math.min(lastBottom - tops[from]! - heights[from]!, clientY - startY + listTop - list.getBoundingClientRect().top));
      // The slot whose top is nearest the dragged row's (a slot below lines up with that row's bottom: heights differ).
      const top = tops[from]! + dy;
      const slotTop = (j: number) => (j <= from ? tops[j]! : tops[j]! + heights[j]! - heights[from]!);
      to = tops.reduce((best, _, j) => (Math.abs(slotTop(j) - top) < Math.abs(slotTop(best) - top) ? j : best), from);
      rows.forEach((li, k) => (li.style.transform = `translateY(${offset(k)}px)`));
    };
    const autoScroll = () => {
      frame = 0;
      if (!scroller) return;
      const r = scroller.getBoundingClientRect();
      const edge = 40;
      const speed = clientY < r.top + edge ? -(r.top + edge - clientY) : clientY > r.bottom - edge ? clientY - (r.bottom - edge) : 0;
      if (!speed) return;
      const before = scroller.scrollTop;
      scroller.scrollTop += Math.max(-16, Math.min(16, speed / 2));
      if (scroller.scrollTop === before) return;
      place();
      frame = requestAnimationFrame(autoScroll);
    };
    const begin = () => {
      started = true;
      rows = [...list.querySelectorAll<HTMLElement>('li[data-member]')];
      tops = rows.map((li) => li.offsetTop);
      heights = rows.map((li) => li.offsetHeight);
      // Each row the dragged one passes moves by its height plus the list's gap.
      step = heights[from]! + (rows.length > 1 ? tops[1]! - tops[0]! - heights[0]! : 0);
      listTop = list.getBoundingClientRect().top;
      flushSync(() => setDragging(id));
    };
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointer) return;
      // The button came up where this window could not see it: a drag that had begun drops there, a press is forgotten.
      if (!(ev.buttons & 1)) return finish(true);
      clientY = ev.clientY;
      if (!started) {
        if (Math.abs(clientY - startY) < 6) return;
        begin();
      }
      ev.preventDefault();
      place();
      if (!frame) frame = requestAnimationFrame(autoScroll);
    };
    const detach = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onCancel, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
      if (frame) cancelAnimationFrame(frame);
      drag.current = null;
    };
    // drop: keep the new place; otherwise glide back.
    const finish = (drop: boolean) => {
      detach();
      if (!started) return;
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 0);
      dropTops.current = new Map(ids.map((x, k) => [x, tops[k]! + offset(k)]));
      for (const li of rows) li.style.transform = '';
      const next = ids.filter((x) => x !== id);
      next.splice(drop ? to : from, 0, id);
      flushSync(() => {
        setDragging(null);
        if (drop && next.join(',') !== ids.join(',')) setOrder(next);
      });
      if (drop) saveOrder(next);
    };
    const onUp = (ev: PointerEvent) => ev.pointerId === pointer && finish(true);
    const onCancel = (ev: PointerEvent) => ev.pointerId === pointer && finish(false);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || !started) return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(false);
    };
    // The list changed under the drag (a member joined or left): drop the drag without moving anything.
    drag.current = () => {
      detach();
      if (!started) return;
      for (const li of rows) li.style.transform = '';
      setDragging(null);
    };
    const onBlur = () => finish(false);
    // Capture phase, so nothing on the page that stops these events can leave the drag hanging.
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
  };
  // Display names for the summary come from the runtimes' own catalogs (cached by the Core; no prompt is sent).
  const [, setCatalogsLoaded] = useState(0);
  // Chat members' models come from the providers, not from a runtime catalog.
  useChatProviders();
  const kinds = [...new Set(props.members.filter((m) => !m.isMock && m.runtimeKind !== 'chat' && (m.model || m.effective?.model)).map((m) => m.runtimeKind))]
    .sort()
    .join(',');
  useEffect(() => {
    for (const kind of kinds ? (kinds.split(',') as RuntimeKind[]) : []) {
      if ([...catalogCache.keys()].some((k) => k.startsWith(`${kind}|`))) continue;
      api.modelCatalog(kind).then(
        (c) => {
          if (!c.available) return;
          catalogCache.set(catalogKey(kind), c);
          setCatalogsLoaded((n) => n + 1);
        },
        () => {},
      );
    }
  }, [kinds]);
  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(null), 4000);
    return () => window.clearTimeout(timer);
  }, [flash]);

  const memberActions = (a: AgentWithStatus): MenuItem[] => {
    const busy = a.status === 'working' || a.status === 'waiting';
    return [
      { label: t('members.details'), onSelect: () => setOpenId(a.id) },
      ...(PERMISSION_MODES[a.runtimeKind]?.length
        ? [
            {
              label: `${t('perm.menu')} ›`,
              onSelect: () => {
                setModeMenu({ agent: a, x: menu?.x ?? 0, y: menu?.y ?? 0 });
                loadModeCatalog(a);
              },
            },
          ]
        : []),
      ...(busy
        ? [{ label: a.status === 'waiting' ? t('members.cancelWait') : t('members.stop'), onSelect: () => void api.interrupt(a.id).catch(props.onError) }]
        : []),
      { label: t('members.remove'), separator: true, onSelect: () => setRemoving(a) },
      { label: t('members.deleteMember'), danger: true, onSelect: () => setDeleting(a) },
    ];
  };

  async function setMode(a: AgentWithStatus, mode: PermissionMode | null) {
    setModeBusy(true);
    try {
      const r = await api.updateAgent(a.id, { permissionMode: mode, ...permissionRiskAck(mode) });
      setRiskAsk(null);
      setFlash(r.applies === 'after_turn' ? t('agent.savedAfterTurn') : r.applies === 'now' ? t('agent.savedNext') : t('agent.noChange'));
    } catch (err) {
      setRiskAsk(null);
      props.onError(err);
    } finally {
      setModeBusy(false);
    }
  }

  /** The runtime's catalog for the member's folder (what this machine allows), loaded once in the background. */
  function loadModeCatalog(a: AgentWithStatus) {
    const key = catalogKey(a.runtimeKind, a.workspace);
    if (a.isMock || catalogCache.has(key)) return;
    api.modelCatalog(a.runtimeKind, a.workspace ? { cwd: a.workspace } : {}).then(
      (c) => {
        if (!c.available) return;
        catalogCache.set(key, c);
        setCatalogsLoaded((n) => n + 1);
      },
      () => {},
    );
  }

  const modeActions = (a: AgentWithStatus): MenuItem[] => {
    const modes = PERMISSION_MODES[a.runtimeKind] ?? [];
    const off = unavailableModes(catalogCache.get(catalogKey(a.runtimeKind, a.workspace)));
    const pick = (m: PermissionMode | null) => () => {
      if (m === a.permissionMode) return;
      if (m && isRiskyMode(m)) setRiskAsk({ agent: a, mode: m });
      else void setMode(a, m);
    };
    return [
      { label: panelNoticeText(N('perm.follow'), ''), checked: !a.permissionMode, onSelect: pick(null) },
      ...modes.map((m) => ({
        label: panelNoticeText(permissionLabel(a.runtimeKind, m), m),
        checked: a.permissionMode === m,
        danger: isRiskyMode(m),
        disabled: off.has(m) && a.permissionMode !== m,
        title: off.has(m) ? lz(off.get(m)!) : undefined,
        onSelect: pick(m),
      })),
    ];
  };

  function openMenu(a: AgentWithStatus, e: React.MouseEvent, anchor?: HTMLElement) {
    e.preventDefault();
    const fromKeyboard = e.clientX === 0 && e.clientY === 0;
    if (anchor || fromKeyboard) {
      const rect = (anchor ?? (e.currentTarget as HTMLElement)).getBoundingClientRect();
      setMenu({ agent: a, x: anchor ? rect.right - 4 : rect.left + 12, y: rect.bottom + 2 });
    } else setMenu({ agent: a, x: e.clientX, y: e.clientY });
  }

  return (
    <section className="panel members">
      <div className="panel-head">
        <h3>{t('members.title')}</h3>
        {props.members.length > 0 && <span className="count">{props.members.length}</span>}
        <button type="button" className="icon-btn push-right" title={t('chat.addMember')} aria-label={t('chat.addMember')} onClick={() => setAdding(true)}>
          <Icon name="plus" />
        </button>
        {props.onCollapse && (
          <button type="button" className="icon-btn" title={t('layout.hideMembers')} aria-label={t('layout.hideMembers')} onClick={props.onCollapse}>
            <Icon name="sidebarRight" />
          </button>
        )}
        {props.onClose && (
          <button type="button" className="icon-btn" title={t('common.close')} aria-label={t('common.close')} onClick={props.onClose}>
            <Icon name="x" />
          </button>
        )}
      </div>
      {flash &&<div className="flash">{flash}</div>}
      <ul className={`member-list${dragging ? ' reordering' : ''}`} ref={listRef}>
        {shown.map((a, i) => {
          const busy = a.status === 'working' || a.status === 'waiting';
          return (
            <li
              key={a.id}
              data-member={a.id}
              className={`member${menu?.agent.id === a.id ? ' menu-open' : ''}${dragging === a.id ? ' dragging' : ''}`}
              onContextMenu={(e) => openMenu(a, e)}
              onPointerDown={(e) => startDrag(e, a.id)}
            >
              <button
                type="button"
                className="member-open"
                onClick={() => !suppressClick.current && setOpenId(a.id)}
                onKeyDown={(e) => {
                  // Alt+↑ / Alt+↓ moves the member, as dragging does.
                  if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
                  e.preventDefault();
                  const to = i + (e.key === 'ArrowUp' ? -1 : 1);
                  if (to < 0 || to >= shown.length) return;
                  refocus.current = a.id;
                  saveOrder(moveTo(a.id, to));
                }}
              >
                <AgentAvatar agent={a}>
                  <span className={`dot dot-${a.status}`} />
                </AgentAvatar>
                <span className="member-main">
                  <span className="member-title">
                    <span className="member-name">{a.displayName}</span>
                    <span className="member-handle">@{a.handle}</span>
                    {defaults.has(a.id) && (
                      <span className="member-default" title={t('members.defaultReply')} aria-label={t('members.defaultReply')}>
                        <Icon name="reply" size={12} />
                      </span>
                    )}
                  </span>
                  <span className="member-sub">
                    <RuntimeBadge agent={a} />
                    <span className="member-config">
                      {configSummary(a, t)}
                      {a.permissionMode && ` · ${a.permissionMode}`}
                      {a.configPending && ` · ${t('members.pending')}`}
                    </span>
                    {(a.effective?.mismatch || a.permission?.mismatch) && (
                      <span className="warn-text" title={[a.effective?.mismatch, a.permission?.mismatch].map(lz).filter(Boolean).join('\n')}>
                        · {t('members.mismatch')}
                      </span>
                    )}
                    {a.permission?.risky && (
                      <span className="warn-text" title={lz(a.permission.risky)}>
                        · ⚠ {t('members.risky')}
                      </span>
                    )}
                  </span>
                  <span className={`member-status st-${a.status}`}>{t(`status.${a.status}`)}</span>
                </span>
              </button>
              {busy && (
                <button
                  type="button"
                  className="icon-btn member-stop"
                  title={a.status === 'waiting' ? t('members.cancelWait') : t('members.stop')}
                  aria-label={a.status === 'waiting' ? t('members.cancelWait') : t('members.stop')}
                  onClick={() => api.interrupt(a.id).catch(props.onError)}
                >
                  <Icon name="stop" size={14} />
                </button>
              )}
              <button
                type="button"
                className="icon-btn member-more"
                aria-label={t('members.menu', { name: a.displayName })}
                aria-haspopup="menu"
                aria-expanded={menu?.agent.id === a.id}
                data-menu-toggle
                onClick={(e) => (menu?.agent.id === a.id ? setMenu(null) : openMenu(a, e, e.currentTarget))}
              >
                <Icon name="more" />
              </button>
            </li>
          );
        })}
      </ul>
      {props.members.length === 0 && (
        <button type="button" className="empty-members" onClick={() => setAdding(true)}>
          <Icon name="plus" /> {t('chat.addMember')}
        </button>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={t('members.menu', { name: menu.agent.displayName })}
          items={memberActions(menu.agent)}
          onClose={() => setMenu(null)}
        />
      )}
      {modeMenu && (
        <ContextMenu
          x={modeMenu.x}
          y={modeMenu.y}
          label={t('perm.menu')}
          items={modeActions(props.allAgents.find((x) => x.id === modeMenu.agent.id) ?? modeMenu.agent)}
          onClose={() => setModeMenu(null)}
        />
      )}
      {riskAsk && (
        <PermissionRiskDialog
          handle={riskAsk.agent.handle}
          mode={panelNoticeText(permissionLabel(riskAsk.agent.runtimeKind, riskAsk.mode), riskAsk.mode)}
          busy={modeBusy}
          onKeep={() => setRiskAsk(null)}
          onEnable={() => void setMode(riskAsk.agent, riskAsk.mode)}
        />
      )}
      {open && (
        <AgentDialog
          agent={open}
          roomId={memberIds.has(open.id) ? roomId : null}
          roomLanguage={memberIds.has(open.id) ? props.room.agentLanguage : null}
          defaultReply={defaults.has(open.id)}
          onClose={() => setOpenId(null)}
          onRemove={() => {
            setOpenId(null);
            setRemoving(open);
          }}
          onDelete={() => {
            setOpenId(null);
            setDeleting(open);
          }}
        />
      )}
      {adding && (
        <AddMemberDialog
          room={props.room}
          firstMember={props.members.length === 0}
          others={others}
          existingNames={props.allAgents.filter((a) => !a.deletedAt).map((a) => ({ name: a.displayName, handle: a.handle }))}
          runtimes={props.runtimes}
          onClose={() => setAdding(false)}
          onAdded={(a) => {
            setAdding(false);
            setFlash(t('members.added', { handle: a.handle }));
          }}
          onEdit={(a) => setOpenId(a.id)}
          onDelete={setDeleting}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={t('remove.title', { name: removing.displayName })}
          body={t('remove.body')}
          confirmLabel={t('remove.confirm')}
          busyLabel={t('remove.busy')}
          onConfirm={() => api.removeMember(roomId, removing.id).then(() => undefined)}
          onInterrupt={() => api.interrupt(removing.id)}
          onClose={() => setRemoving(null)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={t('deleteMember.title', { name: deleting.displayName })}
          body={t('deleteMember.body')}
          confirmLabel={t('common.delete')}
          busyLabel={t('common.deleting')}
          onConfirm={() => api.deleteAgent(deleting.id).then(() => undefined)}
          onInterrupt={() => api.interrupt(deleting.id)}
          onClose={() => setDeleting(null)}
        />
      )}
    </section>
  );
}

function ConfirmDialog(props: {
  title: string;
  body: string;
  confirmLabel: string;
  busyLabel: string;
  onConfirm: () => Promise<void>;
  /** Stops the member when the action was refused because it is still running. */
  onInterrupt: () => Promise<unknown>;
  onClose: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await props.onConfirm();
      props.onClose();
    } catch (e) {
      setError(errorText(e));
      setRunning(e instanceof ApiError && e.status === 409);
      setBusy(false);
    }
  }
  async function interrupt() {
    setBusy(true);
    try {
      await props.onInterrupt();
      setError(null);
      setRunning(false);
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  }
  return (
    <Dialog
      alert
      title={props.title}
      busy={busy}
      onClose={props.onClose}
      actions={
        <>
          <button type="button" disabled={busy} onClick={props.onClose} autoFocus>
            {t('common.cancel')}
          </button>
          {running && (
            <button type="button" disabled={busy} onClick={() => void interrupt()}>
              {t('members.stop')}
            </button>
          )}
          <button type="button" className="danger" disabled={busy} onClick={() => void confirm()}>
            {busy ? props.busyLabel : props.confirmLabel}
          </button>
        </>
      }
    >
      <p>{props.body}</p>
      {error && <div className="error-text">{error}</div>}
    </Dialog>
  );
}

function AddMemberDialog(props: {
  room: Room;
  /** The room has no members yet: the new one is checked as a default responder. */
  firstMember: boolean;
  others: AgentWithStatus[];
  existingNames: { name: string; handle: string }[];
  runtimes: RuntimeDescriptor[];
  onClose: () => void;
  onAdded: (a: AgentWithStatus) => void;
  /** Settings and deletion of an existing member; both apply to every chat it is in. */
  onEdit: (a: AgentWithStatus) => void;
  onDelete: (a: AgentWithStatus) => void;
}) {
  const t = useT();
  const [tab, setTab] = useState<'new' | 'existing'>('new');
  const [chosen, setPick] = useState('');
  // A member deleted meanwhile is no longer picked.
  const pick = props.others.some((x) => x.id === chosen) ? chosen : '';
  const [menu, setMenu] = useState<MemberMenu | null>(null);
  const openMenu = (a: AgentWithStatus, e: React.MouseEvent, anchor?: HTMLElement) => {
    e.preventDefault();
    if (anchor) {
      const rect = anchor.getBoundingClientRect();
      setMenu({ agent: a, x: rect.right - 4, y: rect.bottom + 2 });
    } else setMenu({ agent: a, x: e.clientX, y: e.clientY });
  };
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [canCreate, setCanCreate] = useState(false);
  const [defaultReply, setDefaultReply] = useState(props.firstMember);
  const showNew = tab === 'new' || props.others.length === 0;
  const anyRunnable = props.runtimes.some((r) => (SHOW_MOCK || !r.isMock) && r.available);
  return (
    <Dialog
      title={t('add.title')}
      className="add-member"
      busy={busy}
      onClose={props.onClose}
      actions={
        <>
          <button type="button" disabled={busy} onClick={props.onClose}>
            {t('common.cancel')}
          </button>
          {showNew ? (
            <button type="submit" form="new-agent-form" className="primary" disabled={busy || !canCreate}>
              {busy ? t('add.busy') : t('add.submit')}
            </button>
          ) : (
            <button type="submit" form="join-agent-form" className="primary" disabled={!pick || busy}>
              {busy ? t('add.busy') : t('add.join')}
            </button>
          )}
        </>
      }
    >
      {props.others.length > 0 && (
        <div className="segmented tabs" role="tablist">
          <button type="button" role="tab" aria-selected={showNew} className={showNew ? 'on' : undefined} onClick={() => setTab('new')}>
            {t('add.new')}
          </button>
          <button type="button" role="tab" aria-selected={!showNew} className={!showNew ? 'on' : undefined} onClick={() => setTab('existing')}>
            {t('add.existing', { n: props.others.length })}
          </button>
        </div>
      )}
      {showNew ? (
        <NewAgentForm
          room={props.room}
          runtimes={props.runtimes}
          existingNames={props.existingNames}
          defaultReply={defaultReply}
          onAdded={props.onAdded}
          onBusy={setBusy}
          onCanSubmit={setCanCreate}
        />
      ) : (
        <form
          id="join-agent-form"
          className="form"
          onSubmit={async (e) => {
            e.preventDefault();
            const a = props.others.find((x) => x.id === pick);
            if (!a) return;
            setBusy(true);
            setError(null);
            try {
              await api.addMember(props.room.id, a.id, defaultReply);
              props.onAdded(a);
            } catch (err) {
              setError(errorText(err));
              setBusy(false);
            }
          }}
        >
          <ul className="pick-list">
            {props.others.map((a) => (
              <li key={a.id} className={`pick-row${menu?.agent.id === a.id ? ' menu-open' : ''}`} onContextMenu={(e) => openMenu(a, e)}>
                <label className={`choice${pick === a.id ? ' on' : ''}`}>
                  <input type="radio" name="pick" checked={pick === a.id} onChange={() => setPick(a.id)} />
                  <AgentAvatar agent={a} />
                  <span className="choice-main">
                    <span className="choice-title">
                      {a.displayName} <span className="member-handle">@{a.handle}</span> <RuntimeBadge agent={a} />
                    </span>
                    {a.workspace && (
                      <span className={`choice-sub mono${outsideFolder(a.workspace, props.room.projectDir) ? ' warn-text' : ''}`} title={a.workspace}>
                        {a.workspace}
                      </span>
                    )}
                  </span>
                </label>
                <button
                  type="button"
                  className="icon-btn member-more"
                  aria-label={t('members.menu', { name: a.displayName })}
                  aria-haspopup="menu"
                  aria-expanded={menu?.agent.id === a.id}
                  data-menu-toggle
                  onClick={(e) => (menu?.agent.id === a.id ? setMenu(null) : openMenu(a, e, e.currentTarget))}
                >
                  <Icon name="more" />
                </button>
              </li>
            ))}
          </ul>
          {error && <div className="error-text">{error}</div>}
        </form>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={t('members.menu', { name: menu.agent.displayName })}
          items={[
            { label: t('members.details'), onSelect: () => props.onEdit(menu.agent) },
            { label: t('members.deleteMember'), danger: true, separator: true, onSelect: () => props.onDelete(menu.agent) },
          ]}
          onClose={() => setMenu(null)}
        />
      )}
      {(anyRunnable || !showNew) && <DefaultReplyCheck checked={defaultReply} onChange={setDefaultReply} />}
    </Dialog>
  );
}

/** "Default responder" for the current room; the ? holds the routing rules (no text in the dialog itself). */
function DefaultReplyCheck(props: { checked: boolean; onChange: (v: boolean) => void }) {
  const t = useT();
  return (
    <label className="check">
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      <span>{t('members.defaultReply')}</span>
      <HelpTip text={t('members.defaultReplyHelp')} />
    </label>
  );
}

function NewAgentForm(props: {
  room: Room;
  runtimes: RuntimeDescriptor[];
  existingNames: { name: string; handle: string }[];
  defaultReply: boolean;
  onAdded: (a: AgentWithStatus) => void;
  onBusy: (busy: boolean) => void;
  onCanSubmit: (ok: boolean) => void;
}) {
  const t = useT();
  const lz = useLocalized();
  const offered = props.runtimes.filter((r) => SHOW_MOCK || !r.isMock);
  // Saved model providers (Settings) share one card; the provider is picked below. Without one, Chat stays greyed.
  const chatProviders = usableProviders(useChatProviders().data);
  // A harness that is not installed, too old or not logged in stays on the list, greyed with its reason.
  const runtimeUsable = (r: RuntimeDescriptor) => r.available && (r.kind !== 'chat' || chatProviders.length > 0);
  const available = offered.filter(runtimeUsable);
  const autoPick = autoPickRuntime(available);
  const [detecting, setDetecting] = useState(false);
  /** Counts finished detections: the Core then forgets its model catalogs, so the form asks for them again. */
  const [detected, setDetected] = useState(0);
  // Default to the first real runtime that is ready; Mock only when nothing else is (dev builds).
  const [runtimeKind, setRuntimeKind] = useState<RuntimeKind>(() => (autoPick ?? offered[0])?.kind ?? 'claude');
  /** null until the user edits the name: until then it follows the selected harness. */
  const [typedName, setTypedName] = useState<string | null>(null);
  /** Chat members: provider, model and reasoning level. */
  const [chatCfg, setChatCfg] = useState({ providerId: '', model: '', effort: '' });
  const chatProvider = runtimeKind === 'chat' ? chatProviders.find((p) => p.id === chatCfg.providerId) : undefined;
  const takenNames = props.existingNames.map((x) => x.name);
  const displayName = typedName ?? (chatProvider ? uniqueMemberName(chatProvider.label, takenNames) : defaultMemberName(runtimeKind, takenNames));
  /** The user chose the harness or its login in this form: detection results no longer change it while it works. */
  const userPicked = useRef(false);
  const [cfg, setCfg] = useState({ model: '', effort: '' });
  /** Chat members: the member's own settings. */
  const [chatSettings, setChatSettings] = useState(chatDefaults);
  const chatModel = useChatModel(chatCfg.providerId, chatCfg.model);
  /** '' = follow the user's own runtime settings. */
  const [perm, setPerm] = useState('');
  /** Antigravity only. Full only after the warning was confirmed in this form. */
  const [collab, setCollab] = useState<'restricted' | 'full'>('restricted');
  const [language, setLanguage] = useState('');
  const [askingCollab, setAskingCollab] = useState(false);
  // New members work in the room's project folder unless the user picks another one.
  const [workspace, setWorkspace] = useState(props.room.projectDir ?? '');
  const [worktree, setWorktree] = useState(false);
  const [handle, setHandle] = useState('');
  const [suggested, setSuggested] = useState('');
  const [error, setError] = useState<string | null>(null);
  // A failed create shows its error at the end of a long form: bring it into view; a taken @ name also focuses that field.
  const errorRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLInputElement>(null);
  const [handleFault, setHandleFault] = useState(false);
  useEffect(() => {
    if (!error) return;
    errorRef.current?.scrollIntoView({ block: 'nearest' });
    if (handleFault) handleRef.current?.focus();
  }, [error]);
  const runtime = props.runtimes.find((r) => r.kind === runtimeKind);
  const isChat = runtimeKind === 'chat';
  const needsWorkspace = runtime?.requiresWorkspace ?? false;
  // The harness's own login bills per token (API key, cloud provider): allowed as in a terminal, with a note.
  // A model of the runtime's own login that bills per token (Kimi: an API-key provider) counts as well.
  const [modelMetered, setModelMetered] = useState(false);
  const ownMetered = runtime?.available === true && (runtime.billing === 'metered_api' || (!isChat && modelMetered));
  const handleErr = handleProblem(handle.trim(), t);
  const sameName = props.existingNames.find((x) => x.name.trim().toLowerCase() === displayName.trim().toLowerCase());
  const blocked =
    !displayName.trim() ||
    !runtime ||
    !runtimeUsable(runtime) ||
    (needsWorkspace && !workspace.trim()) ||
    !!handleErr ||
    (isChat && (!chatCfg.providerId || !chatCfg.model));

  useEffect(() => props.onCanSubmit(!blocked), [blocked]);

  // Look for the CLIs again (installed or logged in since start); the result also arrives as runtimes.updated.
  const detect = () => {
    setDetecting(true);
    api
      .detectRuntimes()
      .then(() => setDetected((n) => n + 1), () => undefined)
      .finally(() => setDetecting(false));
  };
  useEffect(detect, []);

  // After detecting again: a harness the user chose stays (also when it stopped working: the form is then blocked);
  // an automatic choice follows the same rule as at the start (a subscription harness before one billed per token).
  useEffect(() => {
    const next = pickAfterDetect(runtime ? { kind: runtime.kind, usable: runtimeUsable(runtime) } : null, userPicked.current, autoPick);
    if (next) {
      setRuntimeKind(next);
      resetConfig();
    }
  }, [props.runtimes, chatProviders.length]);

  useEffect(() => {
    const name = displayName.trim();
    if (!name) return setSuggested('');
    const timer = window.setTimeout(() => {
      api.handleSuggestion(name, runtimeKind).then(setSuggested, () => setSuggested(''));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [displayName, runtimeKind]);

  function resetConfig() {
    setCfg({ model: '', effort: '' });
  }

  const typeField = (
    <div className="field">
      <div className="field-head">
        <span className="field-label">{t('add.type')}</span>
        <button type="button" className="icon-btn" title={t('add.redetect')} aria-label={t('add.redetect')} aria-busy={detecting} disabled={detecting} onClick={detect}>
          {detecting ? <span className="spinner" aria-hidden="true" /> : <Icon name="refresh" size={14} />}
        </button>
      </div>
      <div className="choice-grid" role="radiogroup" aria-label={t('add.type')}>
        {offered.flatMap((r) =>
          r.kind === 'chat' && r.available && chatProviders.length > 0
            ? [
                <label key="chat" className={`choice${isChat ? ' on' : ''}`}>
                  <input
                    type="radio"
                    name="runtime"
                    checked={isChat}
                    {...runtimeRadioHandlers(
                      () => (userPicked.current = true),
                      () => {
                        setRuntimeKind('chat');
                        resetConfig();
                      },
                    )}
                  />
                  <AgentAvatar agent={{ runtimeKind: 'chat', displayName: t('cp.providers'), avatar: null }} />
                  <span className="choice-main">
                    <span className="choice-title">{t('cp.providers')}</span>
                    <span className="choice-sub">{t('cp.providerCount', { n: chatProviders.length })}</span>
                  </span>
                </label>,
              ]
            : [
                <label key={r.kind} className={`choice${runtimeKind === r.kind ? ' on' : ''}${runtimeUsable(r) ? '' : ' disabled'}`} title={(r.kind === 'chat' && r.available ? t('add.chatNoProviderTip') : lz(r.problem ?? r.note)) || undefined}>
                  <input
                    type="radio"
                    name="runtime"
                    checked={runtimeKind === r.kind}
                    disabled={!runtimeUsable(r)}
                    {...runtimeRadioHandlers(
                      () => (userPicked.current = true),
                      () => {
                        setRuntimeKind(r.kind);
                        resetConfig();
                      },
                    )}
                  />
                  <AgentAvatar agent={{ runtimeKind: r.kind, displayName: RUNTIME_NAME[r.kind], avatar: null }} />
                  <span className="choice-main">
                    <span className="choice-title">{RUNTIME_NAME[r.kind]}</span>
                    <span className="choice-sub">
                      {r.kind === 'chat' && r.available
                        ? t('add.chatNoProvider')
                        : r.available
                          ? (r.version ?? '')
                          : runtimeUsable(r)
                            ? t('add.subscriptionMissing')
                            : lz(r.problem ?? r.note) || t('add.notAvailable')}
                    </span>
                  </span>
                </label>,
              ],
        )}
      </div>
    </div>
  );

  // Nothing can run yet: only the harnesses, each with what is missing.
  if (available.length === 0) return <div className="form">{typeField}</div>;

  return (
    <form
      id="new-agent-form"
      className="form"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        if (handleErr) {
          setHandleFault(true);
          return setError(handleErr);
        }
        if (blocked) return;
        props.onBusy(true);
        setError(null);
        try {
          const agent = await api.createAgent({
            displayName: displayName.trim(),
            runtimeKind,
            ...(handle.trim() ? { handle: handle.trim() } : {}),
            ...(isChat
              ? {
                  providerId: chatCfg.providerId,
                  model: chatCfg.model,
                  ...(chatCfg.effort ? { effort: chatCfg.effort } : {}),
                  chat: { ...chatSettings, webSearch: chatSettings.webSearch && !!chatModel?.webSearch },
                }
              : {
                  ...(cfg.model ? { model: cfg.model } : {}),
                  ...(cfg.effort ? { effort: cfg.effort } : {}),
                }),
            ...(perm && (PERMISSION_MODES[runtimeKind] ?? []).includes(perm as PermissionMode) ? { permissionMode: perm as PermissionMode, ...permissionRiskAck(perm) } : {}),
            ...(runtimeKind === 'antigravity' && collab === 'full' ? { collabMode: 'full' as const, acknowledgeCollabRisk: COLLAB_WARNING_VERSION } : {}),
            ...(needsWorkspace ? { workspace: workspace.trim(), ...(worktree ? { worktree: true } : {}) } : {}),
            ...(asLanguage(language) ? { language: asLanguage(language) } : {}),
          });
          await api.addMember(props.room.id, agent.id, props.defaultReply);
          props.onAdded(agent);
        } catch (err) {
          setHandleFault(err instanceof ApiError && err.status === 409 && !!handle.trim() && err.message.includes(`@${handle.trim().replace(/^@/, '').normalize('NFKC')}`));
          setError(errorText(err));
          props.onBusy(false);
        }
      }}
    >
      {typeField}
      <div className="field">
        <label className="field-label" htmlFor="agent-name">
          {t('add.name')}
        </label>
        <input
          id="agent-name"
          value={displayName}
          maxLength={60}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setTypedName(e.target.value)}
        />
        {sameName && <div className="hint warn-text">{t('add.sameName', { name: sameName.name })}</div>}
      </div>
      <div className="field">
        <label className="field-label" htmlFor="agent-handle">
          {t('add.handle')}
        </label>
        <div className="input-prefix">
          <span>@</span>
          <input
            id="agent-handle"
            ref={handleRef}
            value={handle}
            maxLength={40}
            placeholder={suggested}
            onChange={(e) => {
              setHandle(e.target.value);
              setError(null);
            }}
          />
        </div>
        {handleErr && <div className="hint warn-text">{handleErr}</div>}
      </div>
      <LanguageField id="agent-lang" value={language} roomLanguage={props.room.agentLanguage} onChange={setLanguage} />
      {needsWorkspace && <WorkspacePicker value={workspace} onChange={setWorkspace} />}
      {needsWorkspace && (
        <label className="check">
          <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} />
          <span>{t('add.worktree')}</span>
          <HelpTip text={t('add.worktreeHelp')} />
        </label>
      )}
      {isChat ? (
        <>
          <ChatModelPicker providerId={chatCfg.providerId} model={chatCfg.model} effort={chatCfg.effort} onChange={setChatCfg} />
          <ChatSettingsFields value={chatSettings} model={chatModel} onChange={setChatSettings} />
        </>
      ) : !runtime?.isMock && (
        <>
          <ModelEffortFields runtimeKind={runtimeKind} generation={detected} model={cfg.model} effort={cfg.effort} onChange={setCfg} onMetered={setModelMetered} />
          <PermissionField
            runtimeKind={runtimeKind}
            generation={detected}
            handle={handle.trim() || displayName.trim()}
            value={(PERMISSION_MODES[runtimeKind] ?? []).includes(perm as PermissionMode) ? perm : ''}
            onChange={setPerm}
          />
          {runtimeKind === 'antigravity' && (
            <CollabModeSelect
              value={collab}
              busy={false}
              asking={askingCollab}
              onAsk={setAskingCollab}
              onRestricted={() => setCollab('restricted')}
              onEnable={() => {
                setCollab('full');
                setAskingCollab(false);
              }}
            />
          )}
        </>
      )}
      {ownMetered && (
        <div className="banner">
          {isChat ? t('add.meteredChat') : runtimeKind === 'opencode' ? t('add.meteredOpenCode') : t('add.meteredOwn', { runtime: runtime!.label })}
        </div>
      )}
      {error && (
        <div className="error-text" ref={errorRef}>
          {error}
        </div>
      )}
    </form>
  );
}

/** Member detail and settings. */
/** Avatar choice in the member dialog; the picture is cropped and scaled in the page and saved with the form. */
function AvatarPicker(props: { agent: AgentWithStatus; value: string | null; onChange: (v: string | null) => void }) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const defaults = useContext(AvatarDefaultsContext);
  // Harness members share their runtime's default, chat members their model provider's.
  const kind = avatarDefaultKey(props.agent);
  // The picture shown here can become the default for new and picture-less members of the same runtime / provider.
  const canMakeDefault = !!props.value && !!kind && defaults[kind] !== props.value;
  // Without a picture of its own the member shows that default, so removing it is going back to that default.
  const hasDefault = !!kind && !!defaults[kind];
  const providers = useChatProviders().data?.providers;
  const kindName = !kind ? '' : isAvatarDefaultKind(kind) ? RUNTIME_NAME[kind] : (providers?.find((p) => chatAvatarKey(p.id) === kind)?.label ?? '');

  const makeDefault = async () => {
    if (!props.value || !kind) return;
    setError(null);
    setBusy(true);
    try {
      await api.setAvatarDefault(kind, props.value);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const url = await avatarFromFile(file);
      if (isAgentAvatar(url)) props.onChange(url);
      else setError(t('settings.avatarError'));
    } catch (e) {
      setError(e instanceof AvatarError && e.reason === 'tooBig' ? t('settings.avatarTooBig') : t('settings.avatarError'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="field">
      <div className="avatar-setting" role="group" aria-label={t('settings.avatar')}>
        <AgentAvatar agent={props.agent} src={props.value} className="avatar-lg" />
        <button type="button" disabled={busy} onClick={() => input.current?.click()}>
          {props.value ? t('settings.avatarChange') : t('settings.avatarUpload')}
        </button>
        {props.value && (
          <button type="button" disabled={busy} onClick={() => (setError(null), props.onChange(null))}>
            {hasDefault ? t('avatar.restoreDefault') : t('settings.avatarRemove')}
          </button>
        )}
        {canMakeDefault && (
          <button type="button" disabled={busy} onClick={() => void makeDefault()}>
            {t('avatar.makeDefault', { runtime: kindName })}
          </button>
        )}
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          onChange={(e) => {
            void pick(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>
      {error && (
        <div className="error-text" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

/** The member's reply language; '' follows the room (named in brackets when known). */
function LanguageField(props: { id: string; value: string; roomLanguage: AgentLanguage | null; onChange: (v: string) => void }) {
  const t = useT();
  return (
    <div className="field">
      <label className="field-label" htmlFor={props.id}>
        {t('add.replyLang')}
      </label>
      <select id={props.id} value={props.value} onChange={(e) => props.onChange(e.target.value)}>
        <option value="">{props.roomLanguage ? t('agentLang.followRoomIs', { lang: t(`agentLang.${props.roomLanguage}`) }) : t('agentLang.followRoom')}</option>
        <option value="zh">{t('agentLang.zh')}</option>
        <option value="en">{t('agentLang.en')}</option>
      </select>
    </div>
  );
}

const asLanguage = (v: string): AgentLanguage | null => (v === 'zh' || v === 'en' ? v : null);

function AgentDialog(props: {
  agent: AgentWithStatus;
  /** The room the member is in (null when opened for an agent outside it). */
  roomId: string | null;
  /** That room's language, which the member follows unless it has its own. */
  roomLanguage: AgentLanguage | null;
  defaultReply: boolean;
  onClose: () => void;
  onRemove: () => void;
  onDelete: () => void;
}) {
  const { t, locale } = usePrefs();
  const lz = useLocalized();
  const noticeText = useNoticeText();
  const a = props.agent;
  const [displayName, setDisplayName] = useState(a.displayName);
  const [cfg, setCfg] = useState({ model: a.model ?? '', effort: a.effort ?? '' });
  const isChat = a.runtimeKind === 'chat';
  const [chatSettings, setChatSettings] = useState(() => a.chat ?? chatDefaults());
  const chatModel = useChatModel(a.providerId ?? '', cfg.model);
  const chatProvider = useChatProviders().data?.providers.find((p) => p.id === a.providerId) ?? null;
  const [perm, setPerm] = useState<string>(a.permissionMode ?? '');
  const [avatar, setAvatar] = useState<string | null>(a.avatar);
  const [language, setLanguage] = useState<string>(a.language ?? '');
  const [defaultReply, setDefaultReply] = useState(props.defaultReply);
  const [detail, setDetail] = useState<AgentDetailResponse | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.agentDetail(a.id).then(setDetail, () => setDetail(null));
  }, [a.id, a.effective?.reportedAt, a.configPending]);

  const modelChanged = cfg.model !== (a.model ?? '') || cfg.effort !== (a.effort ?? '');
  const permChanged = perm !== (a.permissionMode ?? '');
  const chatChanged = isChat && JSON.stringify(chatSettings) !== JSON.stringify(a.chat ?? chatDefaults());
  const configChanged = modelChanged || permChanged || chatChanged;
  const avatarChanged = avatar !== a.avatar;
  const languageChanged = language !== (a.language ?? '');
  const defaultChanged = !!props.roomId && defaultReply !== props.defaultReply;
  const agentChanged = displayName.trim() !== a.displayName || configChanged || avatarChanged || languageChanged;
  const dirty = agentChanged || defaultChanged;
  const eff = a.effective;
  const reported = a.permission;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!dirty || busy || !displayName.trim()) return;
    setBusy(true);
    setResult(null);
    try {
      if (defaultChanged) await api.setDefaultReply(props.roomId!, a.id, defaultReply);
      const r = agentChanged
        ? await api.updateAgent(a.id, {
            ...(displayName.trim() !== a.displayName ? { displayName: displayName.trim() } : {}),
            ...(modelChanged ? { model: cfg.model || null, effort: cfg.effort || null } : {}),
            ...(permChanged ? { permissionMode: (perm || null) as PermissionMode | null, ...permissionRiskAck(perm) } : {}),
            ...(chatChanged ? { chat: chatSettings } : {}),
            ...(avatarChanged ? { avatar } : {}),
            ...(languageChanged ? { language: asLanguage(language) } : {}),
          })
        : null;
      setResult({
        ok: true,
        text: !configChanged
          ? t('agent.saved')
          : r?.applies === 'after_turn'
            ? t('agent.savedAfterTurn')
            : r?.applies === 'now'
              ? t('agent.savedNext')
              : t('agent.noChange'),
      });
    } catch (err) {
      setResult({ ok: false, text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={a.displayName}
      className="agent-dialog"
      onClose={props.onClose}
      actions={
        <>
          {props.roomId && (
            <button type="button" className="push-left" onClick={props.onRemove}>
              {t('members.remove')}
            </button>
          )}
          <button type="button" className={`danger-outline${props.roomId ? '' : ' push-left'}`} onClick={props.onDelete}>
            {t('members.deleteMember')}
          </button>
          <button type="submit" form="agent-form" className="primary" disabled={busy || !dirty || !displayName.trim()}>
            {busy ? t('common.saving') : t('common.save')}
          </button>
        </>
      }
    >
      <form id="agent-form" className="form" noValidate onSubmit={(e) => void save(e)}>
        <AvatarPicker agent={a} value={avatar} onChange={setAvatar} />
        <div className="field">
          <label className="field-label" htmlFor="agent-edit-name">
            {t('add.name')}
          </label>
          <input
            id="agent-edit-name"
            value={displayName}
            maxLength={60}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>
        <LanguageField id="agent-edit-lang" value={language} roomLanguage={props.roomLanguage} onChange={setLanguage} />
        {props.roomId && <DefaultReplyCheck checked={defaultReply} onChange={setDefaultReply} />}
        {isChat ? (
          <>
            <ChatModelPicker
              providerId={a.providerId ?? ''}
              model={cfg.model}
              effort={cfg.effort}
              fixedProvider
              onChange={(v) => setCfg({ model: v.model, effort: v.effort })}
            />
            <ChatSettingsFields value={chatSettings} model={chatModel} onChange={setChatSettings} />
          </>
        ) : !a.isMock && (
          <>
            <ModelEffortFields runtimeKind={a.runtimeKind} cwd={a.workspace} model={cfg.model} effort={cfg.effort} onChange={setCfg} />
            <PermissionField runtimeKind={a.runtimeKind} cwd={a.workspace} handle={a.handle} value={perm} onChange={setPerm} />
            <CollabModeField agent={a} onResult={setResult} />
          </>
        )}
        {result && <div className={result.ok ? 'ok-text' : 'error-text'}>{result.text}</div>}
      </form>

      <dl className="kv">
        <dt>{t('agent.handle')}</dt>
        <dd>@{a.handle}</dd>
        <dt>{t('agent.type')}</dt>
        <dd>{RUNTIME_NAME[a.runtimeKind]}</dd>
        {!a.isMock && (
          <>
            <dt>{t('agent.account')}</dt>
            <dd>
              {isChat ? (
                <>
                  {chatProvider?.label ?? a.providerId} <MeteredBadge />
                </>
              ) : a.providerId ? (
                <span className="warn-text">{t('agent.unavailable')}</span>
              ) : a.billing === 'metered_api' ? (
                <>
                  {t('add.ownLogin')} <MeteredBadge />
                </>
              ) : (
                t('add.subscription')
              )}
            </dd>
          </>
        )}
        {a.workspace && (
          <>
            <dt>{t('agent.workspace')}</dt>
            <dd className="mono">{a.workspace}</dd>
          </>
        )}
        {!a.isMock && (
          <>
            <dt>{t('agent.running')}</dt>
            <dd title={eff ? `${lz(eff.source)} · ${new Date(eff.reportedAt).toLocaleString(locale, { hourCycle: 'h23' })}` : undefined}>
              {eff ? t('agent.runningValue', { model: eff.model ? (knownModel(a.runtimeKind, eff.model)?.displayName ?? plainModelId(eff.model)) : '—', effort: eff.effort ? effortName(t, eff.effort) : '—' }) : t('agent.notReported')}
              {a.configPending && <span className="muted"> · {t('members.pending')}</span>}
              {eff?.mismatch && <div className="warn-text">{lz(eff.mismatch)}</div>}
            </dd>
            {PERMISSION_MODES[a.runtimeKind]?.length ? (
              <>
                <dt>{t('perm.running')}</dt>
                <dd title={reported ? `${lz(reported.source)} · ${new Date(reported.reportedAt).toLocaleString(locale, { hourCycle: 'h23' })}` : undefined}>
                  {reported ? (
                    <>
                      {reported.mode ? noticeText(permissionLabel(a.runtimeKind, reported.mode), reported.native) : reported.native}
                      {reported.mode && <span className="muted mono"> · {reported.native}</span>}
                    </>
                  ) : (
                    t('agent.notReported')
                  )}
                  {reported?.mismatch && <div className="warn-text">{lz(reported.mismatch)}</div>}
                  {reported?.risky && <div className="warn-text">{lz(reported.risky)}</div>}
                </dd>
              </>
            ) : null}
          </>
        )}
      </dl>

      {!a.isMock && (
        <details className="sessions">
          <summary>
            {t('agent.sessions')}
            {detail?.sessions.length ? <span className="count">{detail.sessions.length}</span> : null}
          </summary>
          {detail?.sessions.length ? (
            <ul className="session-list">
              {detail.sessions.map((s) => (
                <li key={s.roomId}>
                  <div>
                    #{s.roomName ?? s.roomId} · <code>{s.nativeSessionId}</code> ·{' '}
                    {s.status === 'active' || s.status === 'lost' || s.status === 'closed' ? t(`agent.session_${s.status}`) : s.status}
                    {s.live ? ` · ${t('agent.live')}` : ''}
                  </div>
                  {s.info?.length ? (
                    <details>
                      <summary className="hint">{t('agent.info')}</summary>
                      <pre className="session-info">{s.info.map((l) => noticeText(l, '')).join('\n')}</pre>
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <div className="hint">{t('agent.noSessions')}</div>
          )}
        </details>
      )}
    </Dialog>
  );
}
