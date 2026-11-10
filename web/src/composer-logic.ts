import type { RuntimeCommand } from '../../shared/protocol.ts';

/** Text quoted from the chat into the composer, with the user's note on it. */
export interface Quote {
  id: string;
  text: string;
  note: string;
}

/**
 * The message sent with quotes: each one as a Markdown block quote followed by its note, then the typed text. An "@" in
 * quoted text becomes the full-width "＠", so quoting a message does not mention anyone again.
 */
export function withQuotes(quotes: Quote[], typed: string): string {
  const parts = quotes.map((q) => {
    const text = q.text.trim().replace(/@/g, '＠');
    const quoted = text ? text.split(/\r?\n/).map((l) => `> ${l}`.trimEnd()).join('\n') : '';
    return [quoted, q.note.trim()].filter(Boolean).join('\n\n');
  });
  return [...parts, typed.trim()].filter(Boolean).join('\n\n');
}

/**
 * Commands whose name matches what was typed after "/": names starting with it first (in their own order), then names
 * containing it. Case-insensitive.
 */
export function matchCommands<T extends Pick<RuntimeCommand, 'name'>>(list: T[], query: string): T[] {
  const q = query.toLowerCase();
  if (!q) return list;
  const starts = list.filter((c) => c.name.toLowerCase().startsWith(q));
  const contains = list.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q));
  return [...starts, ...contains];
}

/** What the local user sent in this room, oldest first, for ↑ / ↓ (repeats in a row kept once). */
export function sentHistory(messages: { kind: string; senderKind: string; body: string }[] | null): string[] {
  const out: string[] = [];
  for (const m of messages ?? []) {
    if (m.kind !== 'chat' || m.senderKind !== 'user' || !m.body.trim()) continue;
    if (out[out.length - 1] !== m.body) out.push(m.body);
  }
  return out.slice(-100);
}

/** The caret is on the first line (↑ there recalls history instead of moving inside the text). */
export const onFirstLine = (text: string, caret: number) => !text.slice(0, caret).includes('\n');
/** The caret is on the last line. */
export const onLastLine = (text: string, caret: number) => !text.slice(caret).includes('\n');

/**
 * One step through the sent history. `index` null = not browsing (the draft is shown). Returns the next index (null =
 * back to the draft) or undefined when there is nowhere to go.
 */
export function historyStep(length: number, index: number | null, dir: 'up' | 'down'): number | null | undefined {
  if (dir === 'up') {
    if (!length) return undefined;
    if (index === null) return length - 1;
    return index > 0 ? index - 1 : undefined;
  }
  if (index === null) return undefined;
  return index + 1 < length ? index + 1 : null;
}

const draftKey = (roomId: string) => `ht.draft.${roomId}`;

/** The unsent text of a room (this browser only). Storage may be unavailable: then there is simply no draft. */
export function loadDraft(roomId: string): string {
  try {
    return localStorage.getItem(draftKey(roomId)) ?? '';
  } catch {
    return '';
  }
}

/** After a send: the room's kept draft goes, unless it was changed since (then it is newer than what was sent). */
export function clearSentDraft(roomId: string, sent: string): void {
  if (loadDraft(roomId).trim() === sent) saveDraft(roomId, '');
}

/** What a key does to an open @ / command list (null: not the list's key). */
export function menuKey(
  e: { key: string; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean },
  list: { open: boolean; length: number; exact: boolean },
): 'close' | 'next' | 'prev' | 'pick' | null {
  if (!list.open) return null;
  // Esc closes the list even when nothing in it matches.
  if (e.key === 'Escape') return 'close';
  if (!list.length || e.altKey || e.ctrlKey || e.metaKey) return null;
  if (e.key === 'ArrowDown' && !e.shiftKey) return 'next';
  if (e.key === 'ArrowUp' && !e.shiftKey) return 'prev';
  // Tab picks (Shift+Tab moves the focus as usual); Enter picks unless a command is typed out in full (then it sends).
  if (e.key === 'Tab' && !e.shiftKey) return 'pick';
  if (e.key === 'Enter' && !e.shiftKey && !list.exact) return 'pick';
  return null;
}

export function saveDraft(roomId: string, text: string): void {
  try {
    if (text.trim()) localStorage.setItem(draftKey(roomId), text);
    else localStorage.removeItem(draftKey(roomId));
  } catch {
    // no storage: drafts just are not kept
  }
}
