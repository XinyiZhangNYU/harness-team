import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import type { AgentWithStatus, AttachmentInfo, DeliveryInfo, Message, Room, RuntimeDescriptor, SteerSkip } from '../../../shared/protocol.ts';
import { api } from '../api.ts';
import { useAttachmentDrafts } from '../attachments.ts';
import { usePrefs, useT } from '../i18n.tsx';
import { sentHistory } from '../composer-logic.ts';
import { Composer } from './Composer.tsx';
import { HelpTip } from './HelpTip.tsx';
import { Icon } from './Icon.tsx';
import { MessageItem } from './MessageItem.tsx';
import { ActivityGroup } from './RuntimeEvents.tsx';
import { RUNTIME_NAME } from './RuntimeBadge.tsx';
import { ChangedFiles, collectTurnChanges } from './ChangedFiles.tsx';

/** Consecutive tool activities by the same member at least this long are folded into one group. */
const FOLD_MIN = 3;

/** Per-token billing notes closed in this run of the app, by room: the members listed when it was closed. */
const closedMetered = new Map<string, string>();

type Row = { kind: 'one'; message: Message } | { kind: 'group'; messages: Message[] };

const rowHead = (r: Row): Message => (r.kind === 'group' ? r.messages[0]! : r.message);
const isRuntimeRow = (m: Message) => m.kind === 'activity' || m.kind === 'approval';

/** A member's tool rows and approvals get its avatar once, where they follow a message from someone else. */
function leadsRun(prev: Row | undefined, row: Row): boolean {
  const m = rowHead(row);
  if (m.senderKind !== 'agent' || !isRuntimeRow(m)) return false;
  if (!prev) return true;
  const p = prev.kind === 'group' ? prev.messages[prev.messages.length - 1]! : prev.message;
  return p.senderKind !== 'agent' || p.senderId !== m.senderId;
}

type QuoteAt = { text: string; from: string[]; top: number; bottom: number; left: number };

/** Next to selected chat text: a small button that adds the text to the composer as a quote. */
function QuotePop({ at, onAdd, onClose }: { at: QuoteAt; onAdd: () => void; onClose: () => void }) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const below = at.bottom + 6 + h <= window.innerHeight - 8;
    const top = below ? at.bottom + 6 : at.top - 6 - h;
    setPos({ top: Math.max(8, Math.min(top, window.innerHeight - h - 8)), left: Math.max(8, Math.min(at.left, window.innerWidth - w - 8)) });
  }, [at]);
  useEffect(() => {
    const away = (e: Event) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', away, true);
    document.addEventListener('keydown', esc);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', away, true);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);
  return (
    <div ref={box} className="quote-pop" style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden' }}>
      <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={onAdd}>
        <Icon name="quote" size={14} />
        {t('quote.add')}
      </button>
    </div>
  );
}

function groupRows(messages: Message[]): Row[] {
  const rows: Row[] = [];
  let run: Message[] = [];
  const flush = () => {
    if (run.length >= FOLD_MIN) rows.push({ kind: 'group', messages: run });
    else for (const m of run) rows.push({ kind: 'one', message: m });
    run = [];
  };
  for (const m of messages) {
    if (m.kind === 'activity' && (run.length === 0 || run[0]!.senderId === m.senderId)) {
      run.push(m);
      continue;
    }
    flush();
    if (m.kind === 'activity') run.push(m);
    else rows.push({ kind: 'one', message: m });
  }
  flush();
  return rows;
}

export function ChatView(props: {
  room: Room;
  messages: Message[] | null;
  agents: Record<string, AgentWithStatus>;
  members: AgentWithStatus[];
  deliveries: DeliveryInfo[];
  runtimes: RuntimeDescriptor[];
  /** Opens a member's settings (from the slash-command list). */
  onOpenMember?: (agentId: string) => void;
  onSend: (body: string, clientMessageId: string, attachmentIds: string[], steer: boolean, quotedFrom: string[]) => Promise<SteerSkip[]>;
  onError: (err: unknown) => void;
  /** Loads the page before `beforeSeq` into the chat; resolves whether there may be more before it. */
  onLoadOlder?: (beforeSeq: number) => Promise<boolean>;
  /** The live connection to the server is down (it reconnects on its own). */
  offline?: boolean;
  /** Small windows: the chat list and the members are drawers opened from the header. */
  onOpenRooms?: () => void;
  onOpenMembers?: () => void;
  /** Approvals waiting in other chats (shown on the chat-list button when the list is hidden). */
  pendingElsewhere?: number;
  /** Scrolls to this approval card when `n` changes (application menu → Next approval). */
  focusApproval?: { seq: number; n: number } | null;
}) {
  const { t, lang } = usePrefs();
  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const attachments = useAttachmentDrafts(props.room.id, t, props.onError);
  // Read only when ↑ is pressed (not on every streamed update of the message list).
  const messagesRef = useRef(props.messages);
  messagesRef.current = props.messages;
  const history = useCallback(() => sentHistory(messagesRef.current), []);
  // Files dragged anywhere over the chat can be dropped to attach them (dragenter/leave fire per child element).
  const [dragDepth, setDragDepth] = useState(0);
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  const dropProps = {
    onDragEnter: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragDepth((n) => n + 1);
    },
    onDragOver: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (e: DragEvent) => {
      if (hasFiles(e)) setDragDepth((n) => Math.max(0, n - 1));
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragDepth(0);
      attachments.add(Array.from(e.dataTransfer.files));
    },
  };

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // Another chat starts at its newest message (a layout effect, so it runs before the two below).
  useLayoutEffect(() => {
    stickRef.current = true;
  }, [props.room.id]);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  });

  // Scrolling back: near the top, the page before the oldest loaded message is loaded, and the message that was at the
  // top of the view stays where it was. `doneBefore`: nothing is older than this seq (null: not known yet).
  const older = useRef<{ roomId: string; loading: boolean; doneBefore: number | null }>({ roomId: props.room.id, loading: false, doneBefore: null });
  const anchorRef = useRef<{ seq: string; offset: number } | null>(null);
  if (older.current.roomId !== props.room.id) {
    older.current = { roomId: props.room.id, loading: false, doneBefore: null };
    anchorRef.current = null;
  }
  const loadOlder = () => {
    const el = listRef.current;
    const first = props.messages?.[0];
    const st = older.current;
    const load = props.onLoadOlder;
    if (!el || !first || !load || st.loading || (st.doneBefore !== null && first.seq <= st.doneBefore)) return;
    const top = el.getBoundingClientRect().top;
    const shown = Array.from(el.querySelectorAll<HTMLElement>('[data-seq]')).find((n) => n.getBoundingClientRect().bottom > top);
    anchorRef.current = shown ? { seq: shown.dataset.seq!, offset: shown.getBoundingClientRect().top - top } : null;
    st.loading = true;
    load(first.seq)
      .then((more) => {
        if (!more) st.doneBefore = first.seq;
      }, onErrorNow.current)
      .finally(() => {
        st.loading = false;
      });
  };
  const firstSeq = props.messages?.[0]?.seq;
  useLayoutEffect(() => {
    const a = anchorRef.current;
    const el = listRef.current;
    if (!a || !el) return;
    const n = el.querySelector<HTMLElement>(`[data-seq="${a.seq}"]`);
    if (!n) return;
    anchorRef.current = null;
    el.scrollTop += n.getBoundingClientRect().top - el.getBoundingClientRect().top - a.offset;
  }, [firstSeq]);

  // An approval asked for from the menu: centered once its card is rendered (the chat may still be loading).
  const focusedRef = useRef(0);
  useLayoutEffect(() => {
    const f = props.focusApproval;
    if (!f || f.n === focusedRef.current) return;
    const card = listRef.current?.querySelector<HTMLElement>(`.approval[data-seq="${f.seq}"]`);
    if (!card) return;
    focusedRef.current = f.n;
    stickRef.current = false;
    card.scrollIntoView({ block: 'center' });
  });

  const hasMock = props.members.some((m) => m.isMock);
  const metered = props.members.filter((m) => m.billing === 'metered_api');
  const meteredKey = metered.map((m) => m.id).join(',');
  const [, setClosedTick] = useState(0);
  // Shown again after a restart, or once the billed members change.
  const showMetered = metered.length > 0 && closedMetered.get(props.room.id) !== meteredKey;
  const byMessage = useMemo(() => {
    const map = new Map<string, DeliveryInfo[]>();
    for (const d of props.deliveries) {
      const list = map.get(d.messageId);
      if (list) list.push(d);
      else map.set(d.messageId, [d]);
    }
    return map;
  }, [props.deliveries]);
  const rows = useMemo(() => groupRows(props.messages ?? []), [props.messages]);
  // Where a message without an @mention goes (as the server routes it): the room's one default responder, else the
  // member that last posted a chat message. Several default responders: none (a command goes to one member).
  const defaultMemberId = useMemo(() => {
    const ids = new Set(props.members.map((a) => a.id));
    const defaults = props.room.defaultResponders.filter((id) => ids.has(id));
    if (defaults.length) return defaults.length === 1 ? defaults[0]! : null;
    const msgs = props.messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!;
      if (m.kind === 'chat' && m.senderKind === 'agent' && ids.has(m.senderId)) return m.senderId;
    }
    return null;
  }, [props.room.defaultResponders, props.members, props.messages]);
  const turnChanges = useMemo(() => collectTurnChanges(props.messages ?? []), [props.messages]);
  // The "changed files" summary goes right after the row holding the last message of that member's turn.
  const changesAfter = (ids: Message[]) =>
    ids.map((m) => {
      const c = turnChanges.get(m.id);
      return c ? <ChangedFiles key={`d-${m.id}`} changes={c} handle={props.agents[m.senderId]?.handle} /> : null;
    });
  const waiting = props.deliveries.filter((d) => d.state === 'queued' || d.state === 'held').length;
  const room = props.room;
  const setAuto = (patch: { autoPaused?: boolean; autoHopLimit?: number | null; archived?: boolean }) => api.updateRoom(room.id, patch).catch(props.onError);
  const n = props.members.length;
  const busyMembers = props.members.filter((m) => m.status === 'working').length;
  const waitingMembers = props.members.filter((m) => m.status === 'waiting').length;

  // Text selected in the messages can be quoted into the composer.
  const quoteRef = useRef<((text: string, from: string[]) => void) | null>(null);
  // A queued message of the user's can be taken back; with "edit" its text and attachments return to the composer.
  const editRef = useRef<((body: string, attachments: AttachmentInfo[]) => void) | null>(null);
  const onErrorNow = useRef(props.onError);
  onErrorNow.current = props.onError;
  const withdraw = useCallback(async (m: Message, edit: boolean) => {
    try {
      const r = await api.withdrawMessage(m.id);
      if (!r.removed) return;
      if (edit && editRef.current) editRef.current(r.body, r.attachments);
      else for (const a of r.attachments) void api.deleteAttachment(a.id).catch(() => {});
    } catch (err) {
      onErrorNow.current(err);
    }
  }, []);
  // A queued message of the user's can be added to the running turn; members it cannot go to are shown by the composer.
  const steerSkipsRef = useRef<((skips: SteerSkip[]) => void) | null>(null);
  const steerQueued = useCallback(async (m: Message) => {
    try {
      steerSkipsRef.current?.((await api.steerQueuedMessage(m.id)).queued);
    } catch (err) {
      onErrorNow.current(err);
    }
  }, []);
  const [quotePop, setQuotePop] = useState<QuoteAt | null>(null);
  const closeQuote = useCallback(() => setQuotePop(null), []);
  useEffect(closeQuote, [room.id]);
  const pickQuote = () => {
    // After the browser has updated the selection for this click.
    setTimeout(() => {
      const sel = window.getSelection();
      const list = listRef.current;
      if (!sel || sel.isCollapsed || !sel.rangeCount || !list) return setQuotePop(null);
      const range = sel.getRangeAt(0);
      if (!list.contains(range.commonAncestorContainer)) return setQuotePop(null);
      const text = sel.toString().trim();
      if (!text) return setQuotePop(null);
      // The members whose messages the selection is in.
      const bySeq = new Map((props.messages ?? []).map((m) => [String(m.seq), m]));
      const from = new Set<string>();
      for (const el of list.querySelectorAll<HTMLElement>('article.msg[data-seq]')) {
        const m = bySeq.get(el.dataset.seq ?? '');
        if (m?.senderKind === 'agent' && range.intersectsNode(el)) from.add(m.senderId);
      }
      const r = range.getBoundingClientRect();
      setQuotePop({ text, from: [...from], top: r.top, bottom: r.bottom, left: r.left });
    }, 0);
  };
  const onListScroll = () => {
    onScroll();
    if (quotePop) setQuotePop(null);
    const el = listRef.current;
    if (el && el.scrollTop < 400) loadOlder();
  };

  return (
    <section className="chat" {...dropProps}>
      {dragDepth > 0 && (
        <div className="drop-zone" aria-hidden="true">
          <Icon name="image" size={28} />
          <span>{t('attach.drop')}</span>
        </div>
      )}
      <header className="chat-head">
        <div className="chat-title">
          {props.onOpenRooms && (
            <button type="button" className="icon-btn chat-nav" aria-label={t('layout.chats')} title={t('layout.chats')} onClick={props.onOpenRooms}>
              <Icon name="menu" />
              {props.pendingElsewhere ? <span className="nav-badge">{props.pendingElsewhere}</span> : null}
            </button>
          )}
          <Icon name="hash" size={18} className="muted chat-hash" />
          <h2 title={room.name}>{room.name}</h2>
          {!props.onOpenMembers && <span className="chat-sub">{n === 1 ? t('chat.member') : t('chat.members', { n })}</span>}
          {room.archived && <span className="badge">{t('chat.archivedBadge')}</span>}
          {room.agentLanguage !== lang && (
            <span className="badge" title={t('chat.agentLang', { lang: t(`agentLang.${room.agentLanguage}`) })}>
              {room.agentLanguage === 'en' ? 'EN' : '中'}
            </span>
          )}
        </div>
        {/* Agent-to-agent relay only matters once two agents share the room. */}
        {(n >= 2 || room.autoPaused) && (
          <div className="relay">
            {waiting > 0 && <span className="chip">{t('chat.queued', { n: waiting })}</span>}
            <label className="relay-limit">
              <span>{t('chat.relay')}</span>
              <HelpTip text={t('chat.relayHelp')} align="end" />
              <select
                value={room.autoHopLimit ?? 'none'}
                onChange={(e) => void setAuto({ autoHopLimit: e.target.value === 'none' ? null : Number(e.target.value) })}
              >
                <option value="none">{t('chat.relayUnlimited')}</option>
                {[...new Set([0, 1, 2, 3, 4, 6, 8, 10, 15, 20, ...(room.autoHopLimit === null ? [] : [room.autoHopLimit])])]
                  .sort((a, b) => a - b)
                  .map((v) => (
                    <option key={v} value={v}>
                      {v === 0 ? t('chat.relayOff') : v === 1 ? t('chat.relayRound') : t('chat.relayRounds', { n: v })}
                    </option>
                  ))}
              </select>
            </label>
            <button
              type="button"
              className={`icon-btn${room.autoPaused ? ' is-on' : ''}`}
              title={room.autoPaused ? t('chat.resume') : t('chat.pause')}
              aria-label={room.autoPaused ? t('chat.resume') : t('chat.pause')}
              onClick={() => void setAuto({ autoPaused: !room.autoPaused })}
            >
              <Icon name={room.autoPaused ? 'play' : 'pause'} />
            </button>
          </div>
        )}
        {props.onOpenMembers && (
          <button
            type="button"
            className={`chip-btn members-btn${busyMembers ? ' is-busy' : ''}`}
            title={t('layout.members')}
            aria-label={`${t('layout.members')} (${n})`}
            onClick={props.onOpenMembers}
          >
            <Icon name="users" size={14} />
            {n}
            {busyMembers > 0 && <span className="dot dot-working" aria-hidden="true" />}
            {waitingMembers > 0 && <span className="dot dot-waiting" aria-hidden="true" />}
          </button>
        )}
      </header>
      {props.offline && (
        <div className="banner banner-err" role="status">
          {t('conn.lost')}
        </div>
      )}
      {room.archived && (
        <div className="banner banner-row" role="note">
          <span>{t('chat.archived')}</span>
          <button type="button" onClick={() => void setAuto({ archived: false })}>
            {t('room.unarchive')}
          </button>
        </div>
      )}
      {room.autoPaused && (
        <div className="banner banner-warn" role="note">
          {t('chat.paused')}
        </div>
      )}
      {showMetered && (
        <div className="banner banner-closable" role="note">
          <span>
            {t('chat.metered', {
              list: metered
                .map((m) => `@${m.handle} · ${RUNTIME_NAME[m.runtimeKind]}`)
                .join(', '),
            })}
          </span>
          <button
            type="button"
            className="icon-btn"
            title={t('common.close')}
            aria-label={t('common.close')}
            onClick={() => {
              closedMetered.set(room.id, meteredKey);
              setClosedTick((n) => n + 1);
            }}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
      {hasMock && (
        <div className="banner" role="note">
          {t('chat.mock')}
        </div>
      )}
      <div className="messages" ref={listRef} onScroll={onListScroll} onMouseUp={pickQuote} onKeyUp={pickQuote} onTouchEnd={pickQuote}>
        {props.messages === null && <div className="empty-room">{t('common.loading')}</div>}
        {props.messages?.length === 0 && (
          <div className="empty-room">
            <Icon name={n === 0 ? 'users' : 'hash'} size={28} />
            <p>{n === 0 ? t('chat.noMembers') : t('chat.noMessages')}</p>
          </div>
        )}
        {rows.map((row, i) => {
          const showAvatar = leadsRun(rows[i - 1], row);
          if (row.kind === 'group') {
            const first = row.messages[0]!;
            // Keyed by the first item: the group keeps its open/closed state while new activities are appended.
            return [
              <ActivityGroup key={`g-${first.id}`} messages={row.messages} sender={props.agents[first.senderId]} showAvatar={showAvatar} />,
              ...changesAfter(row.messages),
            ];
          }
          const m = row.message;
          return [
            <MessageItem
              key={m.id}
              message={m}
              sender={m.senderKind === 'agent' ? props.agents[m.senderId] : undefined}
              senderWorkspace={m.senderKind === 'agent' ? props.room.memberWorkspaces[m.senderId] : undefined}
              deliveries={byMessage.get(m.id)}
              agents={props.agents}
              showAvatar={showAvatar}
              onWithdraw={withdraw}
              onSteer={steerQueued}
            />,
            ...changesAfter([m]),
          ];
        })}
      </div>
      {quotePop && (
        <QuotePop
          at={quotePop}
          onAdd={() => {
            quoteRef.current?.(quotePop.text, quotePop.from);
            window.getSelection()?.removeAllRanges();
            setQuotePop(null);
          }}
          onClose={closeQuote}
        />
      )}
      <Composer
        key={room.id}
        quoteRef={quoteRef}
        editRef={editRef}
        steerSkipsRef={steerSkipsRef}
        roomId={room.id}
        history={history}
        roomName={room.name}
        members={props.members}
        attachments={attachments}
        runtimes={props.runtimes}
        defaultMemberId={defaultMemberId}
        onOpenMember={props.onOpenMember}
        onSend={props.onSend}
        onError={props.onError}
        offline={props.offline}
      />
    </section>
  );
}
