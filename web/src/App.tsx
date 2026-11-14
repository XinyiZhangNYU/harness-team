import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { pendingApprovals, useAttention, useDesktopNotifications } from './attention.ts';
import { api, ApiError, connectEvents } from './api.ts';
import { initialState, reducer } from './state.ts';
import type { DeliveryInfo, ScheduledTask, Task } from '../../shared/protocol.ts';
import { groupRooms, Sidebar } from './components/Sidebar.tsx';
import { ChatView } from './components/ChatView.tsx';
import { MembersPanel } from './components/MembersPanel.tsx';
import { TasksPanel } from './components/TasksPanel.tsx';
import { SchedulesPanel } from './components/SchedulesPanel.tsx';
import { SettingsDialog } from './components/SettingsDialog.tsx';
import { UsageDialog } from './components/UsageDialog.tsx';
import { usePrefs } from './i18n.tsx';
import { saveDraft } from './composer-logic.ts';
import { Icon } from './components/Icon.tsx';
import { AvatarDefaultsContext } from './components/RuntimeBadge.tsx';

type AuthState = 'checking' | 'ok' | 'denied';

/**
 * How much of the app fits the window. Measured against Windows snap sizes: a full or 2/3-width window keeps the
 * three columns; a half-width one (~950–1280px) keeps the chat list and moves the members into a drawer; anything
 * narrower than 900px, or shorter than 620px (a window snapped to the top or bottom half), shows only the chat, with
 * the chat list and the members in drawers, as the Claude Code and Codex desktop apps do.
 */
type LayoutMode = 'full' | 'medium' | 'compact';
const COMPACT_QUERY = '(max-width: 899px), (max-height: 619px)';
const MEDIUM_QUERY = '(max-width: 1279px)';

function currentMode(): LayoutMode {
  if (typeof window === 'undefined' || !window.matchMedia) return 'full';
  if (window.matchMedia(COMPACT_QUERY).matches) return 'compact';
  return window.matchMedia(MEDIUM_QUERY).matches ? 'medium' : 'full';
}

function useLayoutMode(): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>(currentMode);
  useEffect(() => {
    if (!window.matchMedia) return;
    const queries = [window.matchMedia(COMPACT_QUERY), window.matchMedia(MEDIUM_QUERY)];
    const on = () => setMode(currentMode());
    for (const q of queries) q.addEventListener('change', on);
    return () => {
      for (const q of queries) q.removeEventListener('change', on);
    };
  }, []);
  return mode;
}

type Drawer = 'rooms' | 'members' | null;

/** Side panels the user hid in the wide layouts (per window, localStorage). Drawers in smaller windows are unaffected. */
type Collapsed = { rooms: boolean; members: boolean };
const PANELS_KEY = 'ht.panels';

function useCollapsedPanels(): [Collapsed, (which: keyof Collapsed, collapsed: boolean) => void] {
  const [c, setC] = useState<Collapsed>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(PANELS_KEY) ?? 'null') as Partial<Collapsed> | null;
      return { rooms: v?.rooms === true, members: v?.members === true };
    } catch {
      return { rooms: false, members: false };
    }
  });
  const set = useCallback((which: keyof Collapsed, collapsed: boolean) => {
    setC((cur) => {
      const next = { ...cur, [which]: collapsed };
      try {
        localStorage.setItem(PANELS_KEY, JSON.stringify(next));
      } catch {
        // storage unavailable: the choice lasts until the window closes
      }
      return next;
    });
  }, []);
  return [c, set];
}

const NO_DELIVERIES: DeliveryInfo[] = [];
const NO_TASKS: Task[] = [];
const NO_SCHEDULES: ScheduledTask[] = [];
/** The task board is on hold until it becomes a model-maintained board (docs/DETAILED_DESIGN.md §12). */
const SHOW_TASK_BOARD = false;

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [auth, setAuth] = useState<AuthState>('checking');
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const [newChatSignal, setNewChatSignal] = useState(0);
  const mode = useLayoutMode();
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [collapsed, setCollapsed] = useCollapsedPanels();
  // A member whose settings were asked for from the chat (e.g. "/model"); `n` makes asking again reopen them.
  const [openMember, setOpenMember] = useState<{ agentId: string; n: number } | null>(null);
  const { t, lang } = usePrefs();
  // Application menu (desktop app): "Add member" and "Next approval".
  const [addMember, setAddMember] = useState(0);
  const [focusApproval, setFocusApproval] = useState<{ roomId: string; seq: number; n: number } | null>(null);
  const lastApprovalRef = useRef<string | null>(null);
  const currentRoomRef = useRef<string | null>(null);
  currentRoomRef.current = state.currentRoomId;

  const report = useCallback((err: unknown) => {
    if (err instanceof ApiError && err.status === 401) setAuth('denied');
    setError(err instanceof Error ? err.message : String(err));
  }, []);

  const resync = useCallback(async () => {
    try {
      const [rooms, agents, runtimes] = await Promise.all([api.rooms(), api.agents(), api.runtimes()]);
      dispatch({ type: 'bootstrap', rooms, agents, runtimes });
      dispatch({ type: 'avatarDefaults', defaults: await api.avatarDefaults() });
      const roomId = currentRoomRef.current ?? rooms[0]?.id;
      if (roomId && rooms.some((r) => r.id === roomId)) {
        dispatch({ type: 'snapshot', snapshot: await api.room(roomId) });
      }
    } catch (err) {
      report(err);
    }
  }, [report]);

  useEffect(() => {
    api
      .session()
      .then(() => setAuth('ok'))
      .catch((err) => (err instanceof ApiError && err.status === 401 ? setAuth('denied') : report(err)));
  }, [report]);

  useEffect(() => {
    if (auth !== 'ok') return;
    return connectEvents({
      onEvent: (event) => dispatch({ type: 'event', event }),
      onState: (s) => dispatch({ type: 'connection', state: s }),
      onOpen: () => void resync(),
    });
  }, [auth, resync]);

  // Load the snapshot whenever the selected room changes.
  useEffect(() => {
    const id = state.currentRoomId;
    if (auth !== 'ok' || !id) return;
    api
      .room(id)
      .then((snapshot) => dispatch({ type: 'snapshot', snapshot }))
      .catch(report);
  }, [auth, state.currentRoomId, report]);

  const pending = useMemo(() => pendingApprovals(state.messages), [state.messages]);
  const pendingByRoom = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of pending) m[p.roomId] = (m[p.roomId] ?? 0) + 1;
    return m;
  }, [pending]);
  const notify = useDesktopNotifications();
  useAttention(pending, state.rooms, notify.state, t);

  // A drawer only exists in the smaller layouts; it closes when the chat changes or the window grows.
  const roomsDrawer = mode === 'compact';
  const membersDrawer = mode !== 'full';
  // A docked panel the user hid stays mounted (its dialogs and state survive) but takes no space.
  const roomsHidden = !roomsDrawer && collapsed.rooms;
  const membersHidden = !membersDrawer && collapsed.members;
  useEffect(() => {
    if ((drawer === 'rooms' && !roomsDrawer) || (drawer === 'members' && !membersDrawer)) setDrawer(null);
  }, [drawer, roomsDrawer, membersDrawer]);
  useEffect(() => setDrawer((d) => (d === 'rooms' ? null : d)), [state.currentRoomId]);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      // A dialog or menu above the drawer handles its own Escape first.
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('.dialog-backdrop, .context-menu')) return;
      setDrawer(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer]);

  // ---- Application menu (desktop app): what it lists, and its commands ----
  const ordered = useMemo(() => groupRooms(state.rooms, t).flatMap((g) => g.rooms), [state.rooms, t]);
  const currentFolder = state.rooms.find((r) => r.id === state.currentRoomId)?.projectDir ?? null;
  useEffect(() => {
    if (auth !== 'ok') return;
    window.harnessDesktop?.setMenuState?.({
      rooms: ordered.map((r) => ({ id: r.id, name: r.name })),
      currentRoomId: state.currentRoomId,
      folder: currentFolder,
      lang,
    });
  }, [auth, ordered, state.currentRoomId, currentFolder, lang]);
  const commandRef = useRef<(id: string, arg: string | null) => void>(() => {});
  commandRef.current = (id, arg) => {
    if (auth !== 'ok') return;
    const hasRoom = state.rooms.some((r) => r.id === state.currentRoomId);
    const select = (roomId: string) => {
      // The row clicked earlier keeps focus, and the menu's keys make its ring show: drop it so only the new chat looks selected.
      const el = document.activeElement;
      if (el instanceof HTMLElement && el.closest('.sidebar .room-row')) el.blur();
      dispatch({ type: 'select', roomId });
    };
    if (id === 'new-chat') setNewChatSignal((n) => n + 1);
    else if (id === 'add-member') {
      if (hasRoom) setAddMember((n) => n + 1);
    } else if (id === 'settings') setShowSettings(true);
    else if (id === 'usage') setShowUsage(true);
    else if (id === 'toggle-rooms') {
      if (roomsDrawer) setDrawer((d) => (d === 'rooms' ? null : 'rooms'));
      else setCollapsed('rooms', !collapsed.rooms);
    } else if (id === 'toggle-members') {
      if (!hasRoom) return;
      if (membersDrawer) setDrawer((d) => (d === 'members' ? null : 'members'));
      else setCollapsed('members', !collapsed.members);
    } else if (id === 'prev-room' || id === 'next-room') {
      if (!ordered.length) return;
      const i = ordered.findIndex((r) => r.id === state.currentRoomId);
      const step = id === 'next-room' ? 1 : -1;
      select(i < 0 ? ordered[0]!.id : ordered[(i + step + ordered.length) % ordered.length]!.id);
    } else if (id === 'room') {
      if (arg && state.rooms.some((r) => r.id === arg)) select(arg);
    } else if (id === 'next-approval') {
      // Waiting approvals in sidebar order, then oldest first; each press moves to the next one.
      const rank = (roomId: string) => {
        const i = ordered.findIndex((r) => r.id === roomId);
        return i < 0 ? ordered.length : i;
      };
      const list = [...pending].sort((a, b) => rank(a.roomId) - rank(b.roomId) || a.seq - b.seq);
      if (!list.length) return;
      const at = list.findIndex((m) => m.id === lastApprovalRef.current);
      const m = list[(at + 1) % list.length]!;
      lastApprovalRef.current = m.id;
      if (m.roomId !== state.currentRoomId) select(m.roomId);
      setFocusApproval((f) => ({ roomId: m.roomId, seq: m.seq, n: (f?.n ?? 0) + 1 }));
    }
  };
  useEffect(() => window.harnessDesktop?.onCommand?.((id, arg) => commandRef.current(id, arg)), []);

  if (auth === 'denied') {
    return (
      <div className="gate">
        <h1>{t('gate.title')}</h1>
        <p>{t('gate.body')}</p>
      </div>
    );
  }
  if (auth === 'checking') return <div className="gate">{t('gate.connecting')}</div>;

  const room = state.rooms.find((r) => r.id === state.currentRoomId) ?? null;
  const memberIds = room ? (state.members[room.id] ?? []) : [];
  const members = memberIds.map((id) => state.agents[id]).filter((a) => !!a);
  const offline = state.connection !== 'open';
  const pendingElsewhere = pending.filter((p) => p.roomId !== room?.id).length;
  const drawerProps = (which: Exclude<Drawer, null>, enabled: boolean) =>
    enabled ? { className: `drawer drawer-${which}${drawer === which ? ' open' : ''}`, inert: drawer !== which } : {};
  const openRooms = roomsDrawer ? () => setDrawer('rooms') : roomsHidden ? () => setCollapsed('rooms', false) : undefined;
  const openMembers = membersDrawer ? () => setDrawer('members') : membersHidden ? () => setCollapsed('members', false) : undefined;
  const columns = [
    roomsDrawer || roomsHidden ? null : mode === 'full' ? '248px' : '232px',
    'minmax(0, 1fr)',
    membersDrawer || membersHidden || !room ? null : '300px',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <AvatarDefaultsContext.Provider value={state.avatarDefaults}>
    <div className={`layout mode-${mode}${offline ? ' is-offline' : ''}${room ? '' : ' no-room'}`} style={{ gridTemplateColumns: columns }}>
      {drawer && <div className="drawer-backdrop" onMouseDown={() => setDrawer(null)} aria-hidden="true" />}
      <Sidebar
        {...(roomsHidden ? { className: 'is-collapsed', inert: true } : drawerProps('rooms', roomsDrawer))}
        onClose={roomsDrawer ? () => setDrawer(null) : undefined}
        onCollapse={roomsDrawer ? undefined : () => setCollapsed('rooms', true)}
        rooms={state.rooms}
        currentRoomId={state.currentRoomId}
        connection={state.connection}
        pendingByRoom={pendingByRoom}
        newChatSignal={newChatSignal}
        onOpenSettings={() => setShowSettings(true)}
        onOpenUsage={() => setShowUsage(true)}
        onSelect={(roomId) => dispatch({ type: 'select', roomId })}
        onCreate={async (name, projectDir, agentLanguage, parallelInFolder) => {
          const r = await api.createRoom(name, projectDir, agentLanguage, parallelInFolder);
          dispatch({ type: 'event', event: { type: 'room.created', eventSeq: 0, room: r } });
          dispatch({ type: 'select', roomId: r.id });
        }}
        onUpdate={async (roomId, patch) => {
          const r = await api.updateRoom(roomId, patch);
          dispatch({ type: 'event', event: { type: 'room.updated', eventSeq: 0, room: r } });
        }}
        onError={report}
        onDelete={async (roomId) => {
          await api.deleteRoom(roomId);
          saveDraft(roomId, ''); // its unsent text goes with it
          dispatch({ type: 'event', event: { type: 'room.deleted', eventSeq: 0, roomId } });
        }}
      />
      <main className="main">
        {error && (
          <div className="error-bar" role="alert">
            <span>{error}</span>
            <button className="icon-btn" aria-label={t('common.close')} onClick={() => setError(null)}>
              ×
            </button>
          </div>
        )}
        {!room && openRooms && (
          <div className="compact-bar">
            <button type="button" className="icon-btn" aria-label={t('layout.chats')} title={t('layout.chats')} onClick={openRooms}>
              <Icon name="menu" />
            </button>
            <span className="compact-bar-title">Harness Team</span>
          </div>
        )}
        {room ? (
          <ChatView
            room={room}
            offline={offline}
            onOpenRooms={openRooms}
            pendingElsewhere={pendingElsewhere}
            focusApproval={focusApproval?.roomId === room.id ? focusApproval : null}
            onOpenMembers={openMembers}
            messages={state.messages[room.id] ?? null}
            agents={state.agents}
            members={members}
            deliveries={state.deliveries[room.id] ?? NO_DELIVERIES}
            runtimes={state.runtimes}
            onOpenMember={(agentId) => {
              setOpenMember((o) => ({ agentId, n: (o?.n ?? 0) + 1 }));
              if (membersDrawer) setDrawer('members');
              else if (membersHidden) setCollapsed('members', false);
            }}
            onSend={async (body, clientMessageId, attachmentIds, steer, quotedFrom) =>
              (await api.postMessage(room.id, body, clientMessageId, attachmentIds, steer, quotedFrom)).queued ?? []
            }
            onError={report}
          />
        ) : (
          <div className="welcome">
            <h1>{t('welcome.title')}</h1>
            <p className="welcome-sub">{t('welcome.body')}</p>
            <ol className="welcome-steps">
              <li>{t('welcome.step1')}</li>
              <li>{t('welcome.step2')}</li>
              <li>{t('welcome.step3')}</li>
            </ol>
            <button type="button" className="primary" onClick={() => setNewChatSignal((n) => n + 1)}>
              {t('welcome.newChat')}
            </button>
          </div>
        )}
      </main>
      {room && (
        <div
          className={`side${membersDrawer ? ` drawer drawer-members${drawer === 'members' ? ' open' : ''}` : membersHidden ? ' is-collapsed' : ''}`}
          inert={(membersDrawer && drawer !== 'members') || membersHidden}
        >
          <MembersPanel
            onClose={membersDrawer ? () => setDrawer(null) : undefined}
            onCollapse={membersDrawer ? undefined : () => setCollapsed('members', true)}
            room={room}
            members={members}
            allAgents={Object.values(state.agents)}
            runtimes={state.runtimes}
            openMember={openMember}
            addMember={addMember}
            onError={report}
          />
          <SchedulesPanel
            roomId={room.id}
            schedules={state.schedules[room.id] ?? NO_SCHEDULES}
            members={members}
            agents={state.agents}
            onError={report}
          />
          {SHOW_TASK_BOARD && (
            <TasksPanel
              roomId={room.id}
              tasks={state.tasks[room.id] ?? NO_TASKS}
              members={members}
              agents={state.agents}
              onError={report}
            />
          )}
        </div>
      )}
      {showSettings && (
        <SettingsDialog
          notify={notify.state}
          onToggleNotify={notify.toggle}
          onClose={() => setShowSettings(false)}
        />
      )}
      {showUsage && <UsageDialog onClose={() => setShowUsage(false)} />}
    </div>
    </AvatarDefaultsContext.Provider>
  );
}
