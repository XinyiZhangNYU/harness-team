import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ALL_HANDLE, type AgentCommands, type AgentWithStatus, handleKey, parseSlashCommand, type RuntimeCommand, type RuntimeDescriptor, type SteerSkip } from '../../../shared/protocol.ts';
import { api, newClientMessageId } from '../api.ts';
import { clearSentDraft, historyStep, loadDraft, matchCommands, menuKey, onFirstLine, onLastLine, type Quote, saveDraft, withQuotes } from '../composer-logic.ts';
import type { AttachmentDrafts } from '../attachments.ts';
import { DraftStrip } from './Attachments.tsx';
import { Dialog } from './Dialog.tsx';
import { useLocalized, useT } from '../i18n.tsx';
import { Icon } from './Icon.tsx';
import { configSummary } from './MembersPanel.tsx';

/** Finds an "@prefix" token that ends at the caret. */
function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|[^A-Za-z0-9_@])@([\p{L}\p{M}\p{N}_-]{0,32})$/u.exec(before);
  if (!m) return null;
  return { start: caret - m[2]!.length - 1, query: m[2]!.toLowerCase() };
}

/** "@handle /partial" from the start of the message to the caret: that member's slash commands are offered. */
function commandQuery(text: string, caret: number): { handle: string; start: number; query: string; implicit?: boolean } | null {
  const m = /^(\s*@([^\s@]+)\s+)\/([\w:-]*)$/.exec(text.slice(0, caret));
  return m ? { handle: m[2]!, start: m[1]!.length, query: m[3]!.toLowerCase() } : null;
}

/** "/partial" with no member before it: the commands of the member an unaddressed message goes to. */
function implicitCommandQuery(text: string, caret: number, handle: string): { handle: string; start: number; query: string; implicit: true } | null {
  const m = /^(\s*)\/([\w:-]*)$/.exec(text.slice(0, caret));
  return m ? { handle, start: m[1]!.length, query: m[2]!.toLowerCase(), implicit: true } : null;
}

/** A "/name" with no member mentioned before it (commands always go to one member). */
const BARE_COMMAND = /^\s*\/[A-Za-z][\w:-]*(\s|$)/;

type Suggestion = Pick<AgentWithStatus, 'id' | 'handle' | 'displayName'> & { isMock?: boolean };

/** Per member: its commands and skills as last listed (shared by every room's composer; refreshed after 5 minutes). */
const commandCache = new Map<string, { at: number; data: AgentCommands | null; loading: boolean; error: unknown }>();
const COMMANDS_TTL_MS = 5 * 60_000;
/** Every mounted composer re-renders when a listing it may show starts or finishes. */
const commandListeners = new Set<() => void>();
const commandsChanged = () => commandListeners.forEach((f) => f());

function loadCommands(agentId: string, refresh = false) {
  const hit = commandCache.get(agentId);
  if (hit?.loading) return;
  commandCache.set(agentId, { at: Date.now(), data: hit?.data ?? null, loading: true, error: null });
  commandsChanged();
  api
    .agentCommands(agentId, refresh)
    .then((data) => commandCache.set(agentId, { at: Date.now(), data, loading: false, error: null }))
    .catch((error) => commandCache.set(agentId, { at: Date.now(), data: hit?.data ?? null, loading: false, error }))
    .finally(commandsChanged);
}

/** Quotes not yet sent, per room (kept while this window is open, also across room switches). */
const roomQuotes = new Map<string, Quote[]>();
let quoteSeq = 0;

export function Composer(props: {
  roomName: string;
  members: AgentWithStatus[];
  attachments: AttachmentDrafts;
  /** The members' runtimes, for the slash commands each offers. */
  runtimes: RuntimeDescriptor[];
  /** The one member a message without an @mention goes to (a "/command" typed alone goes there too). */
  defaultMemberId?: string | null;
  /** Opens a member's settings (where /model and /effort are changed). */
  onOpenMember?: (agentId: string) => void;
  /** `steer` (Ctrl+Enter): into the addressed members' running turns; resolves with those that got it queued instead. */
  onSend: (body: string, clientMessageId: string, attachmentIds: string[], steer: boolean) => Promise<SteerSkip[]>;
  onError: (err: unknown) => void;
  /** No live connection to the server: typing is fine, sending waits until it is back. */
  offline?: boolean;
  /** The room (its unsent draft is kept per room in this browser). */
  roomId: string;
  /** What the local user sent in this room, oldest first (↑ / ↓ recall); read when browsing starts. */
  history: () => string[];
  /** Set by the composer: adds text selected in the chat as a quote. */
  quoteRef?: { current: ((text: string, note: string) => void) | null };
}) {
  const t = useT();
  const lz = useLocalized();
  const fileRef = useRef<HTMLInputElement>(null);
  const atts = props.attachments;
  const [text, setText] = useState(() => loadDraft(props.roomId));
  const [caret, setCaret] = useState(0);
  const [sending, setSending] = useState(false);
  const [highlight, setHighlight] = useState(0);
  // Esc hides the pop-up list for the text and caret it was pressed at.
  const [dismissed, setDismissed] = useState<string | null>(null);
  // ↑ / ↓ through what was sent: the entry shown (null = the draft), and the draft kept while browsing.
  const [browse, setBrowse] = useState<number | null>(null);
  const draft = useRef('');
  const sent = useRef<string[]>([]);
  const [, setTick] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = `${useId()}-list`;
  const optionId = (i: number) => `${listId}-${i}`;
  // The text as last rendered, and whether this composer is still shown (a send can finish after a room switch).
  const textNow = useRef(text);
  textNow.current = text;
  const [quotes, setQuotes] = useState<Quote[]>(() => roomQuotes.get(props.roomId) ?? []);
  const [openQuote, setOpenQuote] = useState<string | null>(null);
  /** "@all /compact" waiting for the user to accept the billed requests of these chat members. */
  const [billed, setBilled] = useState<AgentWithStatus[] | null>(null);
  /** Members a Ctrl+Enter message was queued for instead (shown for a few seconds). */
  const [steerSkips, setSteerSkips] = useState<SteerSkip[]>([]);
  useEffect(() => {
    if (!steerSkips.length) return;
    const timer = setTimeout(() => setSteerSkips([]), 5000);
    return () => clearTimeout(timer);
  }, [steerSkips]);
  const quotesNow = useRef(quotes);
  quotesNow.current = quotes;
  useEffect(() => {
    if (quotes.length) roomQuotes.set(props.roomId, quotes);
    else roomQuotes.delete(props.roomId);
  }, [props.roomId, quotes]);
  const patchQuote = (id: string, patch: Partial<Quote>) => setQuotes((qs) => qs.map((q) => (q.id === id ? { ...q, ...patch } : q)));
  const removeQuote = (id: string) => {
    setQuotes((qs) => qs.filter((q) => q.id !== id));
    setOpenQuote((o) => (o === id ? null : o));
    ref.current?.focus();
  };
  useEffect(() => {
    if (!props.quoteRef) return;
    const sink = props.quoteRef;
    sink.current = (text, note) => {
      setQuotes((qs) => [...qs, { id: `q${++quoteSeq}`, text, note }]);
      setOpenQuote(null);
      ref.current?.focus();
    };
    return () => {
      sink.current = null;
    };
  }, [props.quoteRef]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const f = () => setTick((n) => n + 1);
    commandListeners.add(f);
    return () => {
      mounted.current = false;
      commandListeners.delete(f);
    };
  }, []);

  // The unsent text stays with the room (not while a sent message is only being looked at).
  useEffect(() => {
    if (browse === null) saveDraft(props.roomId, text);
  }, [props.roomId, text, browse]);
  // Reused across retries of the same draft so a retried POST cannot create a duplicate message.
  const pendingId = useRef<string>(newClientMessageId());

  // Grows with the text up to about six lines, then scrolls. Measured again when its width changes: a page laid out
  // while hidden (a background tab) measures at no width, and a resized window or sidebar rewraps the text.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.height = 'auto';
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
      const max = Math.round(lh * 6 + 12);
      el.style.height = `${Math.min(el.scrollHeight, max)}px`;
      el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
    };
    fit();
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);

  // No pop-up list while a sent message is only being looked at (↓ keeps walking through them).
  const listOff = browse !== null || dismissed === `${caret}:${text}`;
  const mention = listOff ? null : mentionQuery(text, caret);
  const suggestions = useMemo((): Suggestion[] => {
    if (!mention) return [];
    const list: Suggestion[] = props.members.filter(
      (a) => a.handle.toLowerCase().startsWith(mention.query) || a.displayName.toLowerCase().includes(mention.query),
    );
    if (props.members.length > 1 && ALL_HANDLE.startsWith(mention.query)) list.push({ id: '@all', handle: ALL_HANDLE, displayName: t('composer.everyone') });
    return list;
  }, [mention?.query, mention?.start, props.members, t]);

  const memberByHandle = (handle: string) => props.members.find((a) => handleKey(a.handle) === handleKey(handle));
  const commandsOf = (a: AgentWithStatus | undefined): RuntimeCommand[] =>
    (a && props.runtimes.find((r) => r.kind === a.runtimeKind)?.capabilities.commands) || [];
  const fallback = props.members.find((a) => a.id === props.defaultMemberId);
  const cmd = mention || listOff ? null : (commandQuery(text, caret) ?? (fallback ? implicitCommandQuery(text, caret, fallback.handle) : null));
  const cmdAgent = cmd ? memberByHandle(cmd.handle) : undefined;
  // "@all /…" offers only /compact, run by every member whose runtime has it.
  const allCmd = !!cmd && !cmdAgent && handleKey(cmd.handle) === ALL_HANDLE && props.members.length > 0;
  const compactBy = props.members.filter((a) => commandsOf(a).some((c) => c.name === 'compact' && c.action === 'native'));

  // The member's skills are listed by its own runtime (on demand, when "@member /" is typed).
  useEffect(() => {
    if (!cmdAgent) return;
    const hit = commandCache.get(cmdAgent.id);
    if (!hit || (!hit.loading && Date.now() - hit.at > COMMANDS_TTL_MS)) loadCommands(cmdAgent.id);
  }, [cmdAgent?.id]);
  const listed = cmdAgent ? commandCache.get(cmdAgent.id) : undefined;
  // Built-in commands first (from the runtime description until the member's own list arrives), then its skills.
  const builtins = cmd && cmdAgent ? matchCommands(listed?.data?.commands ?? commandsOf(cmdAgent), cmd.query) : [];
  const skills = cmd && cmdAgent ? matchCommands(listed?.data?.skills ?? [], cmd.query) : [];
  const allCommands: RuntimeCommand[] = compactBy.length
    ? [{ name: 'compact', description: t('composer.compactAll', { who: compactBy.map((a) => '@' + a.handle).join(t('common.listSep')) }), action: 'native' }]
    : [];
  const commands = allCmd ? matchCommands(allCommands, cmd!.query) : [...builtins, ...skills];
  // Only the composer's own text decides: a bare "/name" gets a hint instead of being sent as chat.
  const bare = !fallback && !mention && !cmd && BARE_COMMAND.test(text.slice(0, caret)) && !text.slice(0, caret).includes('\n');
  const listLength = suggestions.length || commands.length;
  // A list is shown (the command list also when nothing matches); Esc closes it.
  const menuOpen = suggestions.length > 0 || !!(cmd && (cmdAgent || allCmd));
  const active = listLength > 0 ? Math.min(highlight, listLength - 1) : -1;

  // Keep the highlighted row in view in a long (scrolling) list.
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [highlight, listLength]);

  // Caret to place once the new text is rendered. Set in a layout effect (before the next key event), not a later
  // animation frame, which could land after a key typed right away and move the caret back in front of it.
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const pos = pendingCaret.current;
    const el = ref.current;
    if (pos === null || !el) return;
    pendingCaret.current = null;
    if (document.activeElement !== el) el.focus();
    el.setSelectionRange(pos, pos);
  });
  const moveCaret = (next: string, pos: number) => {
    setText(next);
    setCaret(pos);
    setHighlight(0);
    pendingCaret.current = pos;
  };
  const pickCommand = (c: RuntimeCommand) => {
    if (!cmd) return;
    if (allCmd) {
      const insert = `/${c.name}`;
      moveCaret(text.slice(0, cmd.start) + insert + text.slice(caret), cmd.start + insert.length);
      return;
    }
    if (!cmdAgent) return;
    if (c.action === 'settings') {
      // Changed in the member settings: the "/…" goes away, the mention stays. The focus goes to the settings dialog.
      setText(text.slice(0, cmd.start) + text.slice(caret));
      setCaret(cmd.start);
      setHighlight(0);
      props.onOpenMember?.(cmdAgent.id);
      return;
    }
    const insert = `${cmd.implicit ? `@${cmdAgent.handle} ` : ''}/${c.name}${c.args || c.action === 'skill' ? ' ' : ''}`;
    moveCaret(text.slice(0, cmd.start) + insert + text.slice(caret), cmd.start + insert.length);
  };

  const insertMention = (a: Suggestion) => {
    if (!mention) return;
    const next = text.slice(0, mention.start) + '@' + a.handle + ' ' + text.slice(caret);
    moveCaret(next, mention.start + a.handle.length + 2);
  };

  const hasAttachments = atts.drafts.length > 0;
  const quoted = quotes.filter((q) => q.text.trim() || q.note.trim());
  const canSend = !sending && !props.offline && atts.ready && (!!text.trim() || hasAttachments || quoted.length > 0);
  const send = async (confirmed = false, steer = false) => {
    const typed = text.trim();
    if (!canSend) return;
    const sentQuotes = quotes;
    // A "/command" typed alone goes to the member an unaddressed message goes to.
    const body = withQuotes(quoted, !quoted.length && fallback && BARE_COMMAND.test(typed) ? `@${fallback.handle} ${typed}` : typed);
    // Commands are only what the composer holds alone; with quotes it is a message.
    if (!quoted.length && BARE_COMMAND.test(body)) {
      props.onError(new Error(t('composer.commandHint')));
      return;
    }
    const slash = quoted.length ? null : parseSlashCommand(body);
    const target = slash ? memberByHandle(slash.handle) : undefined;
    if (slash && target && commandsOf(target).find((c) => c.name === slash.name)?.action === 'settings') {
      // "/model" and "/effort" are member settings: open them instead of sending anything.
      setText('');
      setCaret(0);
      props.onOpenMember?.(target.id);
      return;
    }
    if (!confirmed && slash && !hasAttachments && handleKey(slash.handle) === ALL_HANDLE && slash.name === 'compact' && !slash.args.trim()) {
      // Chat members summarize through their provider's API: each one is a billed request.
      const paid = compactBy.filter((a) => a.runtimeKind === 'chat');
      if (paid.length) {
        setBilled(paid);
        return;
      }
    }
    const roomId = props.roomId;
    setSending(true);
    try {
      const queued = await props.onSend(body, pendingId.current, atts.drafts.map((d) => d.info!.id), steer && !slash);
      pendingId.current = newClientMessageId();
      if (mounted.current) setSteerSkips(queued);
      // The room's kept draft goes unless it was changed since (the composer may be gone after a room switch).
      clearSentDraft(roomId, typed);
      if (roomQuotes.get(roomId) === sentQuotes) roomQuotes.delete(roomId);
      atts.clear();
      if (mounted.current && quotesNow.current === sentQuotes) {
        setQuotes([]);
        setOpenQuote(null);
      }
      if (!mounted.current || textNow.current.trim() !== typed) return;
      setBrowse(null);
      setText('');
      setCaret(0);
    } catch (err) {
      props.onError(err);
    } finally {
      setSending(false);
    }
  };

  /** Shows a sent message (or the draft again) in the composer; ↑ puts the caret at the start, ↓ at the end. */
  const showEntry = (value: string, pos: number) => {
    moveCaret(value, pos);
  };
  const recall = (dir: 'up' | 'down'): boolean => {
    if (browse === null) sent.current = props.history();
    const list = sent.current;
    const next = historyStep(list.length, browse, dir);
    if (next === undefined) return false;
    if (browse === null) draft.current = text;
    setBrowse(next);
    if (next === null) showEntry(draft.current, draft.current.length);
    else showEntry(list[next]!, dir === 'up' ? 0 : list[next]!.length);
    return true;
  };

  const commandRow = (c: RuntimeCommand, i: number) => (
    <li
      key={`${c.action}:${c.name}`}
      id={optionId(i)}
      role="option"
      aria-selected={i === highlight}
      className={i === highlight ? 'active' : ''}
      onMouseDown={(e) => {
        e.preventDefault();
        pickCommand(c);
      }}
    >
      <strong>/{c.name}</strong>
      {c.args && <span className="muted">{lz(c.args)}</span>}
      <span className="command-desc" title={lz(c.description)}>
        {lz(c.description)}
      </span>
      {c.action === 'settings' && <span className="badge">{t('composer.inSettings')}</span>}
      {c.action === 'skill' && c.source && <span className="badge">{lz(c.source)}</span>}
    </li>
  );

  const editing = quotes.find((q) => q.id === openQuote);
  return (
    <div className={`composer${hasAttachments ? ' has-attachments' : ''}${quotes.length ? ' has-quotes' : ''}`}>
      {steerSkips.length > 0 && (
        <div className="steer-notice" role="status">
          {(['unsupported', 'elsewhere'] as const).map((reason) => {
            const handles = steerSkips.filter((s) => s.reason === reason).map((s) => `@${s.handle}`);
            return handles.length ? <div key={reason}>{t(reason === 'unsupported' ? 'composer.steerUnsupported' : 'composer.steerElsewhere', { handles: handles.join(t('common.listSep')) })}</div> : null;
          })}
        </div>
      )}
      <DraftStrip drafts={atts.drafts} onRemove={atts.remove} />
      {quotes.length > 0 && (
        <ul className="quote-strip" aria-label={t('quote.list')}>
          {quotes.map((q, i) => (
            <li key={q.id} className={`quote-chip${q.id === openQuote ? ' open' : ''}`}>
              <button
                type="button"
                className="quote-chip-btn"
                aria-expanded={q.id === openQuote}
                title={q.note ? `${q.text}\n\n${q.note}` : q.text}
                onClick={() => setOpenQuote((o) => (o === q.id ? null : q.id))}
              >
                <Icon name="quote" size={13} />
                {t('quote.n', { n: i + 1 })}
              </button>
              <button type="button" className="quote-remove" title={t('quote.remove', { n: i + 1 })} aria-label={t('quote.remove', { n: i + 1 })} onClick={() => removeQuote(q.id)}>
                <Icon name="x" size={11} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <div
          className="quote-edit"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              setOpenQuote(null);
              ref.current?.focus();
            }
          }}
        >
          <textarea className="quote-edit-text" rows={3} aria-label={t('quote.text')} value={editing.text} onChange={(e) => patchQuote(editing.id, { text: e.target.value })} />
          <textarea
            className="quote-edit-note"
            rows={1}
            aria-label={t('quote.note')}
            placeholder={t('quote.note')}
            value={editing.note}
            onChange={(e) => patchQuote(editing.id, { note: e.target.value })}
          />
        </div>
      )}
      {suggestions.length > 0 && (
        <ul id={listId} className="mention-list" role="listbox" aria-label={t('composer.mentions')}>
          {suggestions.map((a, i) => (
            <li
              key={a.id}
              id={optionId(i)}
              role="option"
              aria-selected={i === highlight}
              className={i === highlight ? 'active' : ''}
              onMouseDown={(e) => {
                e.preventDefault();
                insertMention(a);
              }}
            >
              <strong>@{a.handle}</strong> <span className="muted">{a.displayName}</span>
              {a.isMock && <span className="badge">Mock</span>}
            </li>
          ))}
        </ul>
      )}
      {cmd && cmdAgent && (
        <div ref={listRef} className="mention-list command-list">
          <div className="list-head">
            <span aria-hidden="true">
              {cmd.implicit ? t('composer.commandsDefault', { handle: cmdAgent.handle, model: configSummary(cmdAgent, t) }) : t('composer.commands', { handle: cmdAgent.handle })}
            </span>
            {/* Stays a button while reading, so a keyboard user keeps the focus on it. */}
            <button
              type="button"
              className={listed?.loading ? 'link-btn muted' : 'link-btn'}
              title={t('composer.skillsRefresh')}
              aria-busy={!!listed?.loading}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => loadCommands(cmdAgent.id, true)}
            >
              {listed?.loading ? t('composer.skillsLoading') : t('composer.skillsRefresh')}
            </button>
          </div>
          <ul id={listId} role="listbox" aria-label={t('composer.commands', { handle: cmdAgent.handle })}>
            {builtins.map((c, i) => commandRow(c, i))}
            {/* The skills section is left out when typing narrowed the list to built-in commands only. */}
            {(!cmd.query || skills.length > 0 || !builtins.length) && (
              <li className="list-head skills-head" role="presentation" aria-hidden="true">
                {t('composer.skills')}
              </li>
            )}
            {skills.map((c, i) => commandRow(c, builtins.length + i))}
          </ul>
          <div aria-live="polite">
            {!cmd.query && !listed?.loading && listed?.data && !listed.data.skills.length && (
              <div className="list-status muted">{listed.data.skillsError ? lz(listed.data.skillsError) : t('composer.noSkills')}</div>
            )}
            {!listed?.loading && listed?.data?.skillsWarning && <div className="list-status muted">{lz(listed.data.skillsWarning)}</div>}
            {!listed?.loading && !!listed?.error && <div className="list-status muted">{t('composer.skillsFailed')}</div>}
            {!commands.length && !listed?.loading && (
              <div className="list-status muted">{t('composer.noCommand', { handle: cmdAgent.handle, name: cmd.query })}</div>
            )}
          </div>
        </div>
      )}
      {cmd && allCmd && (
        <div ref={listRef} className="mention-list command-list">
          <div className="list-head">
            <span aria-hidden="true">{t('composer.commands', { handle: ALL_HANDLE })}</span>
          </div>
          <ul id={listId} role="listbox" aria-label={t('composer.commands', { handle: ALL_HANDLE })}>
            {commands.map((c, i) => commandRow(c, i))}
          </ul>
          <div aria-live="polite">
            {!commands.length && (
              <div className="list-status muted">{t(compactBy.length ? 'composer.allOnlyCompact' : 'composer.noCompact')}</div>
            )}
          </div>
        </div>
      )}
      {billed && (
        <Dialog
          alert
          title={t('composer.compactAllTitle')}
          onClose={() => setBilled(null)}
          actions={
            <>
              <button type="button" onClick={() => setBilled(null)} autoFocus>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  setBilled(null);
                  void send(true);
                }}
              >
                {t('composer.compactAllConfirm')}
              </button>
            </>
          }
        >
          <p>{t('composer.compactAllBilled', { n: billed.length, who: billed.map((a) => '@' + a.handle).join(t('common.listSep')) })}</p>
        </Dialog>
      )}
      {bare && (
        <ul className="mention-list command-list" aria-live="polite">
          <li className="muted" aria-disabled="true">
            {t('composer.commandHint')}
          </li>
        </ul>
      )}
      <button type="button" className="icon-btn attach-btn" title={t('attach.add')} aria-label={t('attach.add')} onClick={() => fileRef.current?.click()}>
        <Icon name="paperclip" />
      </button>
      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          atts.add(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
      <textarea
        ref={ref}
        value={text}
        rows={1}
        placeholder={t('composer.placeholder', { room: props.roomName })}
        onChange={(e) => {
          // Editing a recalled message makes it the draft; any edit brings back a list closed with Esc.
          setBrowse(null);
          setDismissed(null);
          setText(e.target.value);
          setCaret(e.target.selectionStart);
          setHighlight(0);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        aria-autocomplete="list"
        aria-controls={menuOpen ? listId : undefined}
        aria-activedescendant={menuOpen && active >= 0 ? optionId(active) : undefined}
        onPaste={(e) => {
          // A pasted screenshot becomes an attachment; pasted text (even with an image alongside) stays text.
          const files = Array.from(e.clipboardData.files);
          if (!files.length || e.clipboardData.getData('text/plain')) return;
          e.preventDefault();
          atts.add(files);
        }}
        onKeyDown={(e) => {
          // Keys typed into an input method (composing text) belong to it: no list, history or send keys.
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          const exact = commands.some((c) => c.name.toLowerCase() === cmd?.query && c.action !== 'settings');
          const key = menuKey(e, { open: menuOpen, length: listLength, exact });
          if (key) {
            e.preventDefault();
            if (key === 'close') setDismissed(`${caret}:${text}`);
            else if (key === 'next') setHighlight((h) => (h + 1) % listLength);
            else if (key === 'prev') setHighlight((h) => (h - 1 + listLength) % listLength);
            else if (suggestions.length) insertMention(suggestions[active]!);
            else pickCommand(commands[active]!);
            return;
          }
          // ↑ on the first line / ↓ on the last line walk through what was sent here; Esc returns to the (empty) draft.
          const el = e.currentTarget;
          const plain = !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && el.selectionStart === el.selectionEnd;
          // Only from an empty composer (or while already browsing), so a typed draft is never replaced.
          if (plain && e.key === 'ArrowUp' && (browse !== null || !text.trim()) && onFirstLine(text, el.selectionStart) && recall('up')) {
            e.preventDefault();
            return;
          }
          if (plain && e.key === 'ArrowDown' && browse !== null && onLastLine(text, el.selectionEnd) && recall('down')) {
            e.preventDefault();
            return;
          }
          if (e.key === 'Escape' && browse !== null) {
            e.preventDefault();
            setBrowse(null);
            showEntry(draft.current, draft.current.length);
            return;
          }
          // Enter queues for a busy member; Ctrl/Cmd+Enter adds the message to its running turn when it can take it.
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void send(false, e.ctrlKey || e.metaKey);
          }
        }}
      />
      <button
        type="button"
        className="send primary icon-btn"
        title={props.offline ? t('conn.sendLater') : hasAttachments && !atts.ready ? t('attach.notReady') : t('composer.send')}
        aria-label={t('composer.send')}
        onClick={() => void send()}
        disabled={!canSend}
      >
        <Icon name="send" />
      </button>
    </div>
  );
}
