import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ChatItem } from './wire.ts';

/**
 * A chat member's own conversation in one chat (chat_sessions / chat_items). Items are only appended; compaction and
 * clearing move `from_seq` (the first item still sent), so the request prefix never changes behind the model's back.
 */

export interface TranscriptState {
  /** Total input tokens (all kinds) of the last request, and the last item seq it contained. */
  lastInput?: number;
  lastSeq?: number;
  /** Tool results of items before this seq are sent as a one-line placeholder. */
  slimBefore?: number;
}

export interface StoredItem {
  seq: number;
  item: ChatItem;
}

export class Transcripts {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  create(agentId: string, roomId: string): string {
    const id = `chat-${randomUUID()}`;
    const now = new Date().toISOString();
    this.db
      .prepare('INSERT INTO chat_sessions (id, agent_id, room_id, from_seq, state_json, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)')
      .run(id, agentId, roomId, '{}', now, now);
    return id;
  }

  /** The session when it exists and belongs to this member and chat. */
  find(id: string, agentId: string, roomId: string): boolean {
    const r = this.db.prepare('SELECT agent_id, room_id FROM chat_sessions WHERE id = ?').get(id) as { agent_id: string; room_id: string } | undefined;
    return !!r && r.agent_id === agentId && r.room_id === roomId;
  }

  fromSeq(id: string): number {
    const r = this.db.prepare('SELECT from_seq FROM chat_sessions WHERE id = ?').get(id) as { from_seq: number } | undefined;
    return Number(r?.from_seq ?? 1);
  }

  setFromSeq(id: string, seq: number): void {
    this.db.prepare('UPDATE chat_sessions SET from_seq = ?, updated_at = ? WHERE id = ?').run(seq, new Date().toISOString(), id);
  }

  state(id: string): TranscriptState {
    const r = this.db.prepare('SELECT state_json FROM chat_sessions WHERE id = ?').get(id) as { state_json: string } | undefined;
    try {
      const v = JSON.parse(r?.state_json ?? '{}') as unknown;
      return v && typeof v === 'object' ? (v as TranscriptState) : {};
    } catch {
      return {};
    }
  }

  patchState(id: string, patch: TranscriptState): void {
    const next = { ...this.state(id), ...patch };
    this.db.prepare('UPDATE chat_sessions SET state_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(next), new Date().toISOString(), id);
  }

  /** Items from `from_seq` on (or from `from`), oldest first. */
  items(id: string, from?: number): StoredItem[] {
    const start = from ?? this.fromSeq(id);
    const rows = this.db.prepare('SELECT seq, data_json FROM chat_items WHERE session_id = ? AND seq >= ? ORDER BY seq').all(id, start) as {
      seq: number;
      data_json: string;
    }[];
    const out: StoredItem[] = [];
    for (const r of rows) {
      try {
        out.push({ seq: Number(r.seq), item: JSON.parse(r.data_json) as ChatItem });
      } catch {
        // a damaged row is skipped (the next request still has a valid order: see normalize in the adapter)
      }
    }
    return out;
  }

  append(id: string, item: ChatItem): number {
    const r = this.db.prepare('SELECT MAX(seq) AS m FROM chat_items WHERE session_id = ?').get(id) as { m: number | null } | undefined;
    const seq = Number(r?.m ?? 0) + 1;
    this.db.prepare('INSERT INTO chat_items (session_id, seq, data_json, created_at) VALUES (?, ?, ?, ?)').run(id, seq, JSON.stringify(item), new Date().toISOString());
    this.db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
    return seq;
  }

  nextSeq(id: string): number {
    const r = this.db.prepare('SELECT MAX(seq) AS m FROM chat_items WHERE session_id = ?').get(id) as { m: number | null } | undefined;
    return Number(r?.m ?? 0) + 1;
  }
}
