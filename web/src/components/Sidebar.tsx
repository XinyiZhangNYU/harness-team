import { useMemo, useState } from 'react';
import type { AgentLanguage, Room, RoomPatch } from '../../../shared/protocol.ts';
import { api, ApiError, type ConnectionState } from '../api.ts';
import { usePrefs, useT, type TFunc } from '../i18n.tsx';
import { ContextMenu, type MenuItem } from './ContextMenu.tsx';
import { Dialog, errorText } from './Dialog.tsx';
import { Icon } from './Icon.tsx';
import { WorkspacePicker } from './WorkspacePicker.tsx';

export function Sidebar(props: {
  rooms: Room[];
  currentRoomId: string | null;
  connection: ConnectionState;
  /** Pending native approvals per room (rooms opened in this window). */
  pendingByRoom: Record<string, number>;
  onOpenSettings: () => void;
  onOpenUsage: () => void;
  onSelect: (id: string) => void;
  /** Rejects with the server's reason. */
  onCreate: (name: string, projectDir: string | null, agentLanguage: AgentLanguage) => Promise<void>;
  /** Rejects with the server's reason. */
  onUpdate: (roomId: string, patch: RoomPatch) => Promise<void>;
  /** Rejects with the server's reason (e.g. a member is still running in the room). */
  onDelete: (roomId: string) => Promise<void>;
  onError: (err: unknown) => void;
  /** Bumped by the app to open the new-chat dialog (welcome screen button). */
  newChatSignal?: number;
  /** Set when the list is shown as a drawer (small windows). */
  className?: string;
  inert?: boolean;
  onClose?: () => void;
  /** Hides the docked list (wide layouts); the chat header then shows a button to bring it back. */
  onCollapse?: () => void;
}) {
  const t = useT();
  const [creating, setCreating] = useState<{ projectDir: string | null } | null>(null);
  const [deleting, setDeleting] = useState<Room | null>(null);
  const [projectFor, setProjectFor] = useState<Room | null>(null);
  const [renaming, setRenaming] = useState<Room | null>(null);
  const [menu, setMenu] = useState<{ room: Room; x: number; y: number } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(loadJson<string[]>(COLLAPSED_KEY, [])));
  const [archivedOpen, setArchivedOpen] = useState<boolean>(() => loadJson<boolean>(ARCHIVED_OPEN_KEY, false));
  const [lastSignal, setLastSignal] = useState(props.newChatSignal ?? 0);
  if ((props.newChatSignal ?? 0) !== lastSignal) {
    setLastSignal(props.newChatSignal ?? 0);
    setCreating({ projectDir: null });
  }

  const current = props.rooms.find((r) => r.id === props.currentRoomId) ?? null;
  const groups = useMemo(() => groupRooms(props.rooms, t), [props.rooms, t]);
  const archived = props.rooms.filter((r) => r.archived);
  // A folded group (or the archived section) still shows the open room.
  const visible = (rooms: Room[], open: boolean) => (open ? rooms : rooms.filter((r) => r.id === current?.id));

  function toggleGroup(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveJson(COLLAPSED_KEY, [...next]);
      return next;
    });
  }

  function update(r: Room, patch: RoomPatch) {
    props.onUpdate(r.id, patch).catch(props.onError);
  }

  const roomActions = (r: Room): MenuItem[] => [
    { label: t('room.rename'), onSelect: () => setRenaming(r) },
    ...(r.archived ? [] : [{ label: r.pinned ? t('room.unpin') : t('room.pin'), onSelect: () => update(r, { pinned: !r.pinned }) }]),
    { label: t('room.setProject'), onSelect: () => setProjectFor(r) },
    { label: r.archived ? t('room.unarchive') : t('room.archive'), onSelect: () => update(r, { archived: !r.archived }) },
    {
      label: r.agentLanguage === 'en' ? t('room.agentLangToZh') : t('room.agentLangToEn'),
      onSelect: () => update(r, { agentLanguage: r.agentLanguage === 'en' ? 'zh' : 'en' }),
    },
    { label: t('room.delete'), danger: true, separator: true, onSelect: () => setDeleting(r) },
  ];

  function openMenu(r: Room, e: React.MouseEvent, anchor?: HTMLElement) {
    e.preventDefault();
    // Keyboard (menu key / Shift+F10) and the "⋯" button open the menu under the element instead of the pointer.
    const el = anchor ?? (e.currentTarget as HTMLElement);
    const fromKeyboard = e.clientX === 0 && e.clientY === 0;
    if (anchor || fromKeyboard) {
      const rect = el.getBoundingClientRect();
      setMenu({ room: r, x: anchor ? rect.right - 4 : rect.left + 12, y: rect.bottom + 2 });
    } else {
      setMenu({ room: r, x: e.clientX, y: e.clientY });
    }
  }

  const roomRow = (r: Room) => {
    const active = r.id === props.currentRoomId;
    const pending = props.pendingByRoom[r.id];
    return (
      <div key={r.id} className={`room-row${active ? ' active' : ''}${menu?.room.id === r.id ? ' menu-open' : ''}`} onContextMenu={(e) => openMenu(r, e)}>
        <button className="room" title={r.name} aria-current={active ? 'page' : undefined} onClick={() => props.onSelect(r.id)}>
          <Icon name="hash" size={14} className="room-hash" />
          <span className="room-name">{r.name}</span>
          {r.pinned && <Icon name="pin" size={12} className="room-pin" />}
          {pending ? (
            <span className="room-badge" title={t('sidebar.pending', { n: pending })}>
              {pending}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          className="room-more icon-btn"
          aria-label={t('common.more')}
          aria-haspopup="menu"
          aria-expanded={menu?.room.id === r.id}
          data-menu-toggle
          onClick={(e) => (menu?.room.id === r.id ? setMenu(null) : openMenu(r, e, e.currentTarget))}
        >
          <Icon name="more" />
        </button>
      </div>
    );
  };

  // Without any project the list stays flat (no lone "Other" header).
  const flat = groups.length === 1 && groups[0]!.dir === null;

  return (
    <aside className={`sidebar${props.className ? ` ${props.className}` : ''}`} inert={props.inert}>
      <div className="sidebar-head">
        <div className="brand">
          <svg className="brand-mark" viewBox="0 0 64 64" aria-hidden="true">
            <rect width="64" height="64" rx="14" fill="#17172B" />
            <rect x="11" y="19" width="42" height="7" rx="3.5" fill="#FFC94A" />
            <rect x="19" y="11" width="7" height="42" rx="3.5" fill="#FF5C8A" />
            <rect x="38" y="11" width="7" height="42" rx="3.5" fill="#22D3EE" />
            <rect x="11" y="38" width="42" height="7" rx="3.5" fill="#8B7CFF" />
          </svg>
          Harness Team
          <span className={`conn-dot conn-${props.connection}`} role="status" title={t(`conn.${props.connection}`)} aria-label={t(`conn.${props.connection}`)} />
        </div>
        <span className="sidebar-head-actions">
          <button type="button" className="icon-btn" title={t('sidebar.newChat')} aria-label={t('sidebar.newChat')} onClick={() => setCreating({ projectDir: null })}>
            <Icon name="plus" />
          </button>
          {props.onCollapse && (
            <button type="button" className="icon-btn" title={t('layout.hideChats')} aria-label={t('layout.hideChats')} onClick={props.onCollapse}>
              <Icon name="sidebar" />
            </button>
          )}
          {props.onClose && (
            <button type="button" className="icon-btn" title={t('common.close')} aria-label={t('common.close')} onClick={props.onClose}>
              <Icon name="x" />
            </button>
          )}
        </span>
      </div>
      {props.connection !== 'open' && (
        <div className="sidebar-conn" role="status">
          {t(`conn.${props.connection}`)}
        </div>
      )}
      <nav className="room-list" aria-label={t('sidebar.chats')}>
        {flat
          ? groups[0]!.rooms.map(roomRow)
          : groups.map((g) => {
              const open = !collapsed.has(g.key);
              return (
                <section key={g.key} className="room-group">
                  <div className="group-head" title={g.dir ?? undefined}>
                    <button type="button" className="group-toggle" aria-expanded={open} onClick={() => toggleGroup(g.key)}>
                      <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
                      <span className="group-name">{g.label}</span>
                      {!open && <span className="group-count">{g.rooms.length}</span>}
                    </button>
                    {g.dir && (
                      <button
                        type="button"
                        className="group-add icon-btn"
                        title={t('sidebar.newInProject', { name: g.label })}
                        aria-label={t('sidebar.newInProject', { name: g.label })}
                        onClick={() => setCreating({ projectDir: g.dir })}
                      >
                        <Icon name="plus" size={14} />
                      </button>
                    )}
                  </div>
                  {visible(g.rooms, open).map(roomRow)}
                </section>
              );
            })}
        {props.rooms.length === 0 && <div className="sidebar-empty">{t('sidebar.noChats')}</div>}
        {archived.length > 0 && (
          <section className="room-group archived-group">
            <div className="group-head">
              <button
                type="button"
                className="group-toggle"
                aria-expanded={archivedOpen}
                onClick={() => {
                  setArchivedOpen(!archivedOpen);
                  saveJson(ARCHIVED_OPEN_KEY, !archivedOpen);
                }}
              >
                <Icon name={archivedOpen ? 'chevronDown' : 'chevronRight'} size={12} />
                <span className="group-name">{t('sidebar.archived')}</span>
                <span className="group-count">{archived.length}</span>
              </button>
            </div>
            {visible(archived, archivedOpen).map(roomRow)}
          </section>
        )}
      </nav>
      <div className="sidebar-foot">
        <button type="button" className="sidebar-settings" onClick={props.onOpenUsage}>
          <Icon name="chart" />
          {t('sidebar.usage')}
        </button>
        <button type="button" className="sidebar-settings" onClick={props.onOpenSettings}>
          <Icon name="gear" />
          {t('sidebar.settings')}
        </button>
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} label={t('room.menu', { name: menu.room.name })} items={roomActions(menu.room)} onClose={() => setMenu(null)} />
      )}
      {creating && <NewChatDialog projectDir={creating.projectDir} onCreate={props.onCreate} onClose={() => setCreating(null)} />}
      {deleting && <DeleteRoomDialog room={deleting} onDelete={props.onDelete} onClose={() => setDeleting(null)} />}
      {renaming && (
        <RenameRoomDialog room={renaming} onClose={() => setRenaming(null)} onSave={(name) => props.onUpdate(renaming.id, { name })} />
      )}
      {projectFor && (
        <ProjectDialog
          initial={projectFor.projectDir}
          onClose={() => setProjectFor(null)}
          onSave={(dir) => props.onUpdate(projectFor.id, { projectDir: dir })}
        />
      )}
    </aside>
  );
}

const COLLAPSED_KEY = 'ht.sidebar.collapsedProjects';
const ARCHIVED_OPEN_KEY = 'ht.sidebar.archivedOpen';

/** Folded groups are a per-window convenience: storage may be unavailable, then everything starts unfolded. */
function loadJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Nothing to do: only which groups are folded is lost.
  }
}

function trimSlashes(path: string): string {
  return path.replace(/[\\/]+$/, '');
}

function basenameOf(path: string): string {
  return trimSlashes(path).split(/[\\/]/).pop() || path;
}

interface RoomGroup {
  key: string;
  dir: string | null;
  label: string;
  rooms: Room[];
}

/**
 * Non-archived rooms by project folder (case-insensitive, as Windows paths are), groups by name with the ungrouped
 * ones last; inside a group pinned rooms first, otherwise creation order. Folders with the same name get their parent.
 */
export function groupRooms(rooms: Room[], t: TFunc): RoomGroup[] {
  const byKey = new Map<string, RoomGroup>();
  for (const r of rooms) {
    if (r.archived) continue;
    const key = r.projectDir ? trimSlashes(r.projectDir).toLowerCase() : '';
    let g = byKey.get(key);
    if (!g) {
      g = { key, dir: r.projectDir, label: r.projectDir ? basenameOf(r.projectDir) : t('sidebar.ungrouped'), rooms: [] };
      byKey.set(key, g);
    }
    g.rooms.push(r);
  }
  const groups = [...byKey.values()];
  const count = new Map<string, number>();
  for (const g of groups) if (g.dir) count.set(g.label.toLowerCase(), (count.get(g.label.toLowerCase()) ?? 0) + 1);
  for (const g of groups) {
    if (g.dir && (count.get(g.label.toLowerCase()) ?? 0) > 1) {
      const parent = trimSlashes(g.dir).split(/[\\/]/).slice(-2, -1)[0];
      if (parent) g.label = `${parent}/${g.label}`;
    }
    g.rooms.sort((a, b) => Number(b.pinned) - Number(a.pinned));
  }
  groups.sort((a, b) =>
    a.dir === null ? 1 : b.dir === null ? -1 : a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }),
  );
  return groups;
}

function NewChatDialog(props: {
  projectDir: string | null;
  onCreate: (name: string, projectDir: string | null, agentLanguage: AgentLanguage) => Promise<void>;
  onClose: () => void;
}) {
  const { t, lang } = usePrefs();
  const [name, setName] = useState('');
  // Members reply in the UI language unless the user picks the other one.
  const [agentLang, setAgentLang] = useState<AgentLanguage>(lang === 'en' ? 'en' : 'zh');
  const [dir, setDir] = useState(props.projectDir ?? '');
  // Picking a folder names the chat after it, until you type a name of your own.
  const [autoName, setAutoName] = useState(true);
  const pickDir = (value: string) => {
    setDir(value);
    if (autoName && value.trim()) setName(basenameOf(value.trim()).slice(0, 80));
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.onCreate(name.trim(), dir.trim() || null, agentLang);
      props.onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={t('newChat.title')}
      busy={busy}
      onClose={props.onClose}
      actions={
        <>
          <button type="button" disabled={busy} onClick={props.onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" form="new-chat-form" className="primary" disabled={busy || !name.trim()}>
            {t('common.create')}
          </button>
        </>
      }
    >
      <form id="new-chat-form" className="form" onSubmit={(e) => void submit(e)}>
        <div className="field">
          <label className="field-label" htmlFor="new-chat-name">
            {t('newChat.name')}
          </label>
          <input
            id="new-chat-name"
            value={name}
            maxLength={80}
            autoFocus
            onChange={(e) => {
              setName(e.target.value);
              setAutoName(!e.target.value);
            }}
          />
        </div>
        <WorkspacePicker label={`${t('newChat.project')} (${t('common.optional')})`} value={dir} onChange={pickDir} />
        <div className="field">
          <label className="field-label" htmlFor="new-chat-agent-lang">
            {t('newChat.agentLang')}
          </label>
          <select id="new-chat-agent-lang" value={agentLang} onChange={(e) => setAgentLang(e.target.value === 'en' ? 'en' : 'zh')}>
            <option value="zh">{t('agentLang.zh')}</option>
            <option value="en">{t('agentLang.en')}</option>
          </select>
        </div>
        {error && <div className="error-text">{error}</div>}
      </form>
    </Dialog>
  );
}

function RenameRoomDialog(props: { room: Room; onSave: (name: string) => Promise<void>; onClose: () => void }) {
  const t = useT();
  const [name, setName] = useState(props.room.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = name.trim();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!value || busy) return;
    if (value === props.room.name) return props.onClose();
    setBusy(true);
    setError(null);
    try {
      await props.onSave(value);
      props.onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={t('rename.title')}
      busy={busy}
      onClose={props.onClose}
      actions={
        <>
          <button type="button" disabled={busy} onClick={props.onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" form="rename-room-form" className="primary" disabled={busy || !value}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <form id="rename-room-form" className="form" onSubmit={(e) => void submit(e)}>
        <div className="field">
          <label className="field-label" htmlFor="rename-room-name">
            {t('newChat.name')}
          </label>
          <input
            id="rename-room-name"
            value={name}
            maxLength={80}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        {error && <div className="error-text">{error}</div>}
      </form>
    </Dialog>
  );
}

function ProjectDialog(props: { initial: string | null; onSave: (dir: string | null) => Promise<void>; onClose: () => void }) {
  const t = useT();
  const [dir, setDir] = useState(props.initial ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(value: string | null) {
    setBusy(true);
    setError(null);
    try {
      await props.onSave(value);
      props.onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={t('project.title')}
      busy={busy}
      onClose={props.onClose}
      actions={
        <>
          {props.initial && (
            <button type="button" className="push-left" disabled={busy} onClick={() => void save(null)}>
              {t('project.none')}
            </button>
          )}
          <button type="button" disabled={busy} onClick={props.onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" form="project-form" className="primary" disabled={busy || !dir.trim()}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <form
        id="project-form"
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && dir.trim()) void save(dir.trim());
        }}
      >
        <WorkspacePicker label={t('project.title')} value={dir} onChange={setDir} />
        {error && <div className="error-text">{error}</div>}
      </form>
    </Dialog>
  );
}

function DeleteRoomDialog(props: { room: Room; onDelete: (roomId: string) => Promise<void>; onClose: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await props.onDelete(props.room.id);
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
      await api.interruptRoom(props.room.id);
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
      title={t('deleteRoom.title', { name: props.room.name })}
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
            {busy ? t('common.deleting') : t('common.delete')}
          </button>
        </>
      }
    >
      <p>{t('deleteRoom.body')}</p>
      {error && <div className="error-text">{error}</div>}
    </Dialog>
  );
}
