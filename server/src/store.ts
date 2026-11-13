import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type {
  Agent,
  AttachmentInfo,
  DeliveryInfo,
  DeliveryState,
  Message,
  MessageKind,
  MessageMeta,
  MessageStatus,
  Room,
  RoomPatch,
  RuntimeKind,
  AgentLanguage,
  SenderKind,
  Task,
  TaskStatus,
  UsageGroup,
  UsageSummary,
  UsageTotals,
} from '../../shared/protocol.ts';
import type { TurnUsage } from './adapters/types.ts';
import { estimateCostUsd } from './pricing.ts';
import { redactMessageCopy } from './message-copy.ts';
import { isNotice, type Localized, type NoticeText, zhText } from '../../shared/notices.ts';
import { DEFAULT_CHAT_MEMBER, handleKey, isAgentAvatar, type ChatMemberSettings, isAvatarDefaultKey, PERMISSION_MODES, type AvatarDefaultKey, type AvatarDefaults, type CollabMode, type PermissionMode, type RuntimeBilling, type RuntimeKind as Kind } from '../../shared/protocol.ts';

export type { DeliveryState } from '../../shared/protocol.ts';

/** An attachment id given to insertMessage that is unknown, in another room, or already sent. */
export class AttachmentBindError extends Error {
  readonly attachmentId: string;
  constructor(attachmentId: string) {
    super(`attachment ${attachmentId} cannot be attached (unknown, in another room, or already sent)`);
    this.attachmentId = attachmentId;
  }
}
export type Delivery = DeliveryInfo;

type Row = Record<string, unknown>;

const now = () => new Date().toISOString();

/** rooms.auto_hop_limit is NOT NULL; a negative value stores "no limit" (Room.autoHopLimit = null). */
const NO_HOP_LIMIT = -1;

function toRoom(r: Row, defaultResponders: string[] = []): Room {
  return {
    id: String(r.id),
    name: String(r.name),
    createdAt: String(r.created_at),
    autoPaused: Number(r.auto_paused ?? 0) === 1,
    autoHopLimit: r.auto_hop_limit == null || Number(r.auto_hop_limit) < 0 ? null : Number(r.auto_hop_limit),
    projectDir: r.project_dir == null ? null : String(r.project_dir),
    pinned: Number(r.pinned ?? 0) === 1,
    archived: Number(r.archived ?? 0) === 1,
    agentLanguage: r.agent_language === 'en' ? 'en' : 'zh',
    parallelInFolder: Number(r.parallel_in_folder ?? 0) === 1,
    defaultResponders,
  };
}

const str = (v: unknown) => (v == null ? null : String(v));

/**
 * Delivery errors are stored as text; a translatable one is stored as its JSON (see `encodeError`), so the UI can show
 * it in the user's language while `error` stays the Chinese text.
 */
function encodeError(e: Localized | null | undefined): string | null {
  if (e === null || e === undefined) return null;
  return typeof e === 'string' ? e : JSON.stringify(e);
}

function decodeError(v: string | null): { error: string | null; errorNotice: NoticeText | null } {
  if (v && v.startsWith('{')) {
    try {
      const n: unknown = JSON.parse(v);
      if (isNotice(n)) return { error: zhText(n), errorNotice: n };
    } catch {
      // plain text that happens to start with "{"
    }
  }
  return { error: v, errorNotice: null };
}

function toDelivery(r: Row): DeliveryInfo {
  return {
    id: String(r.id),
    roomId: String(r.room_id),
    messageId: String(r.message_id),
    agentId: String(r.agent_id),
    state: r.state as DeliveryState,
    origin: r.origin as DeliveryInfo['origin'],
    hop: Number(r.hop),
    replyMessageId: str(r.reply_message_id),
    ...decodeError(str(r.error)),
    createdAt: String(r.created_at),
    dispatchedAt: str(r.dispatched_at),
    acceptedAt: str(r.accepted_at),
    repliedAt: str(r.replied_at),
    finishedAt: str(r.finished_at),
  };
}

function toTask(r: Row): Task {
  return {
    id: Number(r.id),
    roomId: String(r.room_id),
    title: String(r.title),
    ...(r.title_redacted === 1 ? { titleRedacted: true as const } : r.title_redacted === null ? { titleRedactionUncertain: true as const } : {}),
    status: r.status as TaskStatus,
    assigneeId: str(r.assignee_agent_id),
    createdBy: String(r.created_by),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function toAgent(r: Row): Agent {
  const c = parseConfig(r.config_json);
  return {
    id: String(r.id),
    // Deleted agents keep their row with the handle renamed to "<handle>~<id>" (frees the handle for reuse).
    handle: String(r.handle).split('~')[0]!,
    displayName: String(r.display_name),
    runtimeKind: r.runtime_kind as RuntimeKind,
    isMock: Number(r.is_mock) === 1,
    workspace: c.workspace ?? null,
    // Rows created before Phase 5 have no model/effort: they follow the runtime's default (unchanged behaviour).
    model: typeof c.model === 'string' && c.model ? c.model : null,
    effort: typeof c.effort === 'string' && c.effort ? c.effort : null,
    // Only a mode valid for this runtime is honoured; anything else (or nothing) follows the user's own configuration.
    permissionMode: (PERMISSION_MODES[r.runtime_kind as RuntimeKind] ?? []).includes(c.permissionMode as PermissionMode) ? (c.permissionMode as PermissionMode) : null,
    createdAt: String(r.created_at),
    deletedAt: r.deleted_at ? String(r.deleted_at) : null,
    providerId: r.provider_id ? String(r.provider_id) : null,
    avatar: isAgentAvatar(c.avatar) ? c.avatar : null,
    collabMode: r.runtime_kind === 'antigravity' ? (r.collab_mode === 'full' ? 'full' : 'restricted') : null,
    collabConfirmedAt: r.collab_confirmed_at ? String(r.collab_confirmed_at) : null,
    collabWarningVersion: r.collab_warning_version ? String(r.collab_warning_version) : null,
    billingSeen: c.billingSeen === 'subscription' || c.billingSeen === 'metered_api' ? c.billingSeen : null,
    language: c.language === 'zh' || c.language === 'en' ? c.language : null,
    // Members created before the setting have none: off.
    chrome: r.runtime_kind === 'claude' ? c.chrome === true : null,
    chat: r.runtime_kind === 'chat' ? chatSettings(c.chat) : null,
  };
}

/** A chat member's settings from its config (missing or invalid values take the defaults). */
function chatSettings(v: unknown): ChatMemberSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const int = (x: unknown, min: number, max: number, d: number) => (typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max ? x : d);
  return {
    projectTools: typeof o.projectTools === 'boolean' ? o.projectTools : DEFAULT_CHAT_MEMBER.projectTools,
    webSearch: typeof o.webSearch === 'boolean' ? o.webSearch : DEFAULT_CHAT_MEMBER.webSearch,
    webFetch: typeof o.webFetch === 'boolean' ? o.webFetch : DEFAULT_CHAT_MEMBER.webFetch,
    dailyTokenLimit: int(o.dailyTokenLimit, 0, 1e12, DEFAULT_CHAT_MEMBER.dailyTokenLimit),
    maxToolRounds: int(o.maxToolRounds, 1, 200, DEFAULT_CHAT_MEMBER.maxToolRounds),
  };
}

/** agents.config_json: per-agent settings. Unknown keys are preserved on update. */
interface AgentConfigJson {
  workspace?: string;
  model?: string | null;
  effort?: string | null;
  permissionMode?: string | null;
  /** Data URL of the user-chosen avatar (display only). */
  avatar?: string;
  /** How the runtime last reported the own login is billed (Agent.billingSeen). */
  billingSeen?: string;
  /** Agent.language; absent = the room's. */
  language?: string;
  /** Agent.chrome (Claude Code members); absent = off. */
  chrome?: boolean;
  /** Chat members only: ChatMemberSettings. */
  chat?: Partial<ChatMemberSettings>;
  [k: string]: unknown;
}

function parseConfig(v: unknown): AgentConfigJson {
  try {
    const c = JSON.parse(String(v ?? '{}'));
    return c && typeof c === 'object' ? c : {};
  } catch {
    return {};
  }
}

function toMessage(r: Row): Message {
  return {
    id: String(r.id),
    roomId: String(r.room_id),
    seq: Number(r.seq),
    kind: r.kind as MessageKind,
    senderKind: r.sender_kind as SenderKind,
    senderId: String(r.sender_id),
    body: String(r.body),
    ...(r.content_redacted === 1 ? { contentRedacted: true as const } : r.content_redacted === null ? { redactionUncertain: true as const } : {}),
    status: r.status as MessageStatus,
    mentions: JSON.parse(String(r.mentions_json)) as string[],
    replyTo: r.reply_to == null ? null : String(r.reply_to),
    meta: r.meta_json == null ? null : (JSON.parse(String(r.meta_json)) as MessageMeta),
    ...(r.attachments_json == null ? {} : { attachments: JSON.parse(String(r.attachments_json)) as AttachmentInfo[] }),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

/** An attachment row: the info shown to clients plus where it belongs. */
export interface StoredAttachment extends AttachmentInfo {
  roomId: string;
  messageId: string | null;
  sha256: string;
  createdAt: string;
}

function toAttachment(r: Row): StoredAttachment {
  return {
    id: String(r.id),
    roomId: String(r.room_id),
    messageId: r.message_id == null ? null : String(r.message_id),
    name: String(r.name),
    mime: String(r.mime),
    ...(r.name_redacted === 1 ? { nameRedacted: true as const } : r.name_redacted === null ? { nameRedactionUncertain: true as const } : {}),
    kind: r.kind === 'image' ? 'image' : 'file',
    size: Number(r.size),
    sha256: String(r.sha256),
    createdAt: String(r.created_at),
  };
}

const attachmentInfo = (a: StoredAttachment): AttachmentInfo => ({
  id: a.id, name: a.name, mime: a.mime, kind: a.kind, size: a.size,
  ...(a.nameRedacted ? { nameRedacted: true } : a.nameRedactionUncertain ? { nameRedactionUncertain: true } : {}),
});

export interface NewMessage {
  /** Chosen by the caller when it must know the id even if storing the message fails half way. */
  id?: string;
  roomId: string;
  kind: MessageKind;
  senderKind: SenderKind;
  senderId: string;
  body: string;
  /** null carries the unknown provenance of an older stored copy. */
  contentRedacted?: boolean | null;
  status: MessageStatus;
  mentions?: string[];
  replyTo?: string | null;
  clientMessageId?: string | null;
  meta?: MessageMeta | null;
  /** Unsent attachments of the same room to bind to this message (in this order). All must bind, or nothing is inserted. */
  attachmentIds?: string[];
}

export interface NewDelivery {
  roomId: string;
  messageId: string;
  agentId: string;
  state: Extract<DeliveryState, 'queued' | 'held' | 'skipped'>;
  origin: DeliveryInfo['origin'];
  hop: number;
  error?: string | null;
}

/** Which stage timestamp a delivery update records. */
export type DeliveryStamp = 'dispatched' | 'accepted' | 'replied' | 'finished';

export interface SessionBinding {
  id: string;
  agentId: string;
  roomId: string;
  runtimeKind: RuntimeKind;
  nativeSessionId: string;
  status: 'active' | 'closed' | 'lost';
  /** Fingerprint of the standing instructions the native session was started with; null = none (rules sent per turn). */
  instructionsVersion: string | null;
  /** Adapter-private state for this native session (AgentSession.adapterState), opaque to the Core. */
  adapterState: string | null;
}

/** SQL condition leaving out slash-command messages (meta type 'command'). */
const NO_COMMANDS = " AND COALESCE(json_extract(meta_json, '$.type'), '') <> 'command'";

export class Store {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  // ---- rooms ----
  createRoom(name: string, projectDir: string | null = null, agentLanguage: AgentLanguage = 'zh', parallelInFolder = false): Room {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO rooms (id, name, created_at, project_dir, auto_hop_limit, agent_language) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, name, now(), projectDir, NO_HOP_LIMIT, agentLanguage);
    // Only when asked: older databases (migration tests) create rooms before the column exists.
    if (parallelInFolder) this.db.prepare('UPDATE rooms SET parallel_in_folder = 1 WHERE id = ?').run(id);
    return this.getRoom(id)!;
  }

  updateRoom(id: string, patch: RoomPatch): Room {
    const cur = this.getRoom(id);
    if (!cur) throw new Error(`room ${id} not found`);
    const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Room;
    this.db
      .prepare('UPDATE rooms SET name = ?, auto_paused = ?, auto_hop_limit = ?, project_dir = ?, pinned = ?, archived = ?, agent_language = ?, parallel_in_folder = ? WHERE id = ?')
      .run(next.name, next.autoPaused ? 1 : 0, next.autoHopLimit ?? NO_HOP_LIMIT, next.projectDir, next.pinned ? 1 : 0, next.archived ? 1 : 0, next.agentLanguage, next.parallelInFolder ? 1 : 0, id);
    return this.getRoom(id)!;
  }

  /**
   * Deletes a room. Foreign keys cascade to its members, messages, deliveries, tasks, cursors and native session
   * bindings; agents themselves (and their native session files) are not touched.
   */
  // ---- token usage ----
  /** The reply message of the last turn of this agent in this room that has usage recorded, and its status. */
  /**
   * When the turn of a reply happened: its first usage record, else the reply message itself. A cost reported after
   * the turn is recorded at that time, so it falls on the same day (and in the same date range) as the turn's tokens.
   */
  usageTurnAt(replyMessageId: string): string | null {
    const u = this.db.prepare('SELECT MIN(at) AS at FROM usage_records WHERE reply_message_id = ?').get(replyMessageId) as { at: string | null } | undefined;
    if (u?.at) return u.at;
    const m = this.db.prepare('SELECT created_at FROM messages WHERE id = ?').get(replyMessageId) as { created_at: string } | undefined;
    return m?.created_at ?? null;
  }

  /** Tokens of every kind an agent used on the local calendar date of `at` (default now). */
  agentTokensOnDay(agentId: string, at: Date = new Date()): number {
    const pad = (n: number) => String(n).padStart(2, '0');
    const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
    const r = this.db
      .prepare(
        `SELECT SUM(input_tokens + cache_read_tokens + cache_write_tokens + output_tokens) AS n FROM usage_records
         WHERE agent_id = ? AND date(at, 'localtime') = ?`,
      )
      .get(agentId, day) as { n: number | null } | undefined;
    return Number(r?.n ?? 0);
  }

  /** Whether any member (also a deleted one) was created with this provider. */
  /** Handles of members (not deleted) that call this provider, or only this model of it. */
  providerInUse(providerId: string, modelId?: string): string[] {
    const rows =
      modelId === undefined
        ? this.db.prepare('SELECT handle FROM agents WHERE provider_id = ? AND deleted_at IS NULL').all(providerId)
        : this.db
            .prepare(`SELECT handle FROM agents WHERE provider_id = ? AND deleted_at IS NULL AND json_extract(config_json, '$.model') = ?`)
            .all(providerId, modelId);
    return (rows as { handle: string }[]).map((r) => r.handle);
  }

  lastUsageTurn(agentId: string, roomId: string): { replyMessageId: string; turnStatus: string } | null {
    const r = this.db
      .prepare('SELECT reply_message_id, turn_status FROM usage_records WHERE agent_id = ? AND room_id = ? ORDER BY id DESC LIMIT 1')
      .get(agentId, roomId) as { reply_message_id: string; turn_status: string } | undefined;
    return r ? { replyMessageId: r.reply_message_id, turnStatus: r.turn_status } : null;
  }

  insertUsage(input: {
    roomId: string;
    agentId: string;
    runtimeKind: string;
    providerId: string | null;
    projectDir: string | null;
    workspace: string | null;
    replyMessageId: string;
    turnStatus: string;
    usage: TurnUsage;
    at?: string;
  }): void {
    const u = input.usage;
    this.db
      .prepare(
        `INSERT INTO usage_records (at, room_id, agent_id, runtime_kind, provider_id, model, project_dir, workspace, reply_message_id,
           turn_status, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, cost_usd, tokens_known)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.at ?? now(),
        input.roomId,
        input.agentId,
        input.runtimeKind,
        input.providerId,
        u.model,
        input.projectDir,
        input.workspace,
        input.replyMessageId,
        input.turnStatus,
        u.input,
        u.cacheRead,
        u.cacheWrite,
        u.output,
        u.reasoning,
        u.costUsd,
        u.tokensUnknown ? 0 : 1,
      );
  }

  /**
   * Usage summed over [from, to) (ISO timestamps; null = open). Days are grouped by the server's local calendar date,
   * which is the user's (the server only listens on loopback).
   */
  usageSummary(from: string | null, to: string | null): Omit<UsageSummary, 'from' | 'to'> {
    const where = 'WHERE (? IS NULL OR at >= ?) AND (? IS NULL OR at < ?)';
    const args = [from, from, to, to];
    const cols = `COUNT(DISTINCT reply_message_id) AS turns, SUM(input_tokens) AS input, SUM(cache_read_tokens) AS cache_read,
      SUM(cache_write_tokens) AS cache_write, SUM(output_tokens) AS output, SUM(reasoning_tokens) AS reasoning, SUM(cost_usd) AS cost`;
    // Rows without the runtime's own cost (Codex, Antigravity) are priced from the list-price table, per model and
    // local date, so a price change applies from its date on. Rows neither carries make the group's cost partial.
    // Tokens of a reply the runtime reported a cost for (with the same model, or without one: ACP's cost reported
    // after the turn) are covered by that cost and not priced again; when that cost is not in the same group and date
    // range (another day, another model's row), the group's cost is partial: part of what it used is counted elsewhere.
    type Estimate = { cost: number; priced: boolean; partial: boolean };
    const mapKey = (k: unknown, runtimeKind: unknown) => `${k == null ? '\0' : String(k)}\u0001${runtimeKind == null ? '' : String(runtimeKind)}`;
    const keyed = (keyExpr: string) => `(SELECT *, ${keyExpr} AS k FROM usage_records ${where})`;
    const estimates = (keyExpr: string, byRuntime: boolean): Map<string, Estimate> => {
      const out = new Map<string, Estimate>();
      const covers = `c.reply_message_id = u.reply_message_id AND c.cost_usd IS NOT NULL AND (c.model IS NULL OR u.model IS NULL OR c.model = u.model)`;
      const rows = this.db
        .prepare(
          `SELECT u.k, u.runtime_kind, u.model, date(u.at, 'localtime') AS d, SUM(u.input_tokens) AS input, SUM(u.cache_read_tokens) AS cache_read,
             SUM(u.cache_write_tokens) AS cache_write, SUM(u.output_tokens) AS output,
             EXISTS (SELECT 1 FROM usage_records c WHERE ${covers}) AS covered,
             EXISTS (SELECT 1 FROM ${keyed(keyExpr)} c WHERE ${covers} AND c.k IS u.k) AS covered_here
           FROM ${keyed(keyExpr)} u WHERE u.cost_usd IS NULL
           GROUP BY 1, 2, 3, 4, 9, 10`,
        )
        .all(...args, ...args) as Row[];
      for (const r of rows) {
        const key = mapKey(r.k, byRuntime ? r.runtime_kind : null);
        const e = out.get(key) ?? { cost: 0, priced: false, partial: false };
        const tokens = { input: Number(r.input ?? 0), cacheRead: Number(r.cache_read ?? 0), cacheWrite: Number(r.cache_write ?? 0), output: Number(r.output ?? 0) };
        const used = tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output > 0;
        if (Number(r.covered)) {
          if (!Number(r.covered_here) && used) e.partial = true;
        } else {
          const c = estimateCostUsd(String(r.runtime_kind), r.model == null ? null : String(r.model), String(r.d), tokens);
          if (c !== null) {
            e.cost += c;
            e.priced = true;
          } else if (used) e.partial = true;
        }
        out.set(key, e);
      }
      return out;
    };
    // Replies whose token counts are known, per group: each model the reply used there has a record with real counts
    // (a cost-only record of a model that also has one does not make it unknown; one of a model without one does). A
    // cost-only record without a model (a cost reported after the turn) counts as known when the reply has counts.
    const tokenTurns = (keyExpr: string, byRuntime: boolean): Map<string, number> => {
      const out = new Map<string, number>();
      const rows = this.db
        .prepare(
          `WITH units AS (
             SELECT k, ${byRuntime ? 'runtime_kind' : 'NULL'} AS rk, reply_message_id AS reply, model, MAX(tokens_known) AS known
             FROM ${keyed(keyExpr)} GROUP BY 1, 2, 3, 4),
           replies AS (
             SELECT k, rk FROM units GROUP BY k, rk, reply
             HAVING MAX(known) = 1 AND COALESCE(MIN(CASE WHEN model IS NOT NULL THEN known END), 1) = 1)
           SELECT k, rk, COUNT(*) AS n FROM replies GROUP BY k, rk`,
        )
        .all(...args) as Row[];
      for (const r of rows) out.set(mapKey(r.k, r.rk), Number(r.n));
      return out;
    };
    const totals = (r: Row | undefined, e?: Estimate, known?: number): UsageTotals => {
      const native = r?.cost == null ? null : Number(r.cost);
      return {
        turns: Number(r?.turns ?? 0),
        tokenTurns: known ?? 0,
        input: Number(r?.input ?? 0),
        cacheRead: Number(r?.cache_read ?? 0),
        cacheWrite: Number(r?.cache_write ?? 0),
        output: Number(r?.output ?? 0),
        reasoning: Number(r?.reasoning ?? 0),
        costUsd: native === null && !e?.priced ? null : (native ?? 0) + (e?.cost ?? 0),
        costPartial: !!e?.partial,
      };
    };
    const order = 'ORDER BY SUM(input_tokens + cache_read_tokens + cache_write_tokens + output_tokens) DESC';
    const group = (keyExpr: string, extra = '', orderBy = order): UsageGroup[] => {
      const est = estimates(keyExpr, !!extra);
      const known = tokenTurns(keyExpr, !!extra);
      return (
        this.db
          .prepare(`SELECT ${keyExpr} AS k${extra ? `, ${extra}` : ''}, ${cols} FROM usage_records ${where} GROUP BY ${keyExpr}${extra ? `, ${extra}` : ''} ${orderBy}`)
          .all(...args) as Row[]
      ).map((r) => {
        const key = mapKey(r.k, extra ? r.runtime_kind : null);
        return {
          key: str(r.k),
          ...(r.runtime_kind != null ? { runtimeKind: String(r.runtime_kind) } : {}),
          ...totals(r, est.get(key), known.get(key)),
        };
      });
    };
    const all = mapKey('', null);
    return {
      totals: totals(this.db.prepare(`SELECT ${cols} FROM usage_records ${where}`).get(...args) as Row | undefined, estimates("''", false).get(all), tokenTurns("''", false).get(all)),
      byProject: group('COALESCE(project_dir, workspace)'),
      byModel: group('model', 'runtime_kind'),
      byAgent: group('agent_id'),
      byDay: group(`date(at, 'localtime')`, '', `ORDER BY date(at, 'localtime')`),
    };
  }

  deleteRoom(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM rooms WHERE id = ?').run(id).changes) > 0;
  }

  listRooms(): Room[] {
    const defaults = new Map<string, string[]>();
    for (const d of this.db.prepare('SELECT room_id, agent_id FROM room_members WHERE default_reply = 1 ORDER BY joined_at, rowid').all() as Row[]) {
      const k = String(d.room_id);
      defaults.set(k, [...(defaults.get(k) ?? []), String(d.agent_id)]);
    }
    return (this.db.prepare('SELECT * FROM rooms ORDER BY created_at, id').all() as Row[]).map((r) => toRoom(r, defaults.get(String(r.id))));
  }

  getRoom(id: string): Room | undefined {
    const r = this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as Row | undefined;
    return r ? toRoom(r, this.defaultResponders(id)) : undefined;
  }

  /** Agent ids of the room's default responders, in joining order. */
  defaultResponders(roomId: string): string[] {
    return (
      this.db.prepare('SELECT agent_id FROM room_members WHERE room_id = ? AND default_reply = 1 ORDER BY joined_at, rowid').all(roomId) as Row[]
    ).map((r) => String(r.agent_id));
  }

  setDefaultReply(roomId: string, agentId: string, on: boolean): boolean {
    return Number(this.db.prepare('UPDATE room_members SET default_reply = ? WHERE room_id = ? AND agent_id = ?').run(on ? 1 : 0, roomId, agentId).changes) > 0;
  }

  /** The agent member that last posted a chat message in the room (system notices and commands aside). */
  lastReplier(roomId: string): string | null {
    const r = this.db
      .prepare(
        `SELECT m.sender_id FROM messages m JOIN room_members rm ON rm.room_id = m.room_id AND rm.agent_id = m.sender_id
         WHERE m.room_id = ? AND m.sender_kind = 'agent' AND m.kind = 'chat' ORDER BY m.seq DESC LIMIT 1`,
      )
      .get(roomId) as Row | undefined;
    return r ? String(r.sender_id) : null;
  }

  // ---- agents ----
  createAgent(input: {
    handle: string;
    displayName: string;
    runtimeKind: RuntimeKind;
    isMock: boolean;
    workspace?: string | null;
    model?: string | null;
    effort?: string | null;
    permissionMode?: PermissionMode | null;
    language?: AgentLanguage | null;
    chrome?: boolean;
    /** Chat members: their provider. */
    providerId?: string | null;
    chat?: ChatMemberSettings | null;
  }): Agent {
    const agent: Agent = {
      id: randomUUID(),
      ...input,
      workspace: input.workspace ?? null,
      model: input.model ?? null,
      effort: input.effort ?? null,
      permissionMode: input.permissionMode ?? null,
      createdAt: now(),
      deletedAt: null,
      // Chat members call this provider; other members never have one (old rows of the removed route still may).
      providerId: input.runtimeKind === 'chat' ? (input.providerId ?? null) : null,
      avatar: null,
      // Antigravity members start restricted: only the user wakes them until full mode is confirmed.
      collabMode: input.runtimeKind === 'antigravity' ? 'restricted' : null,
      collabConfirmedAt: null,
      collabWarningVersion: null,
      billingSeen: null,
      language: input.language ?? null,
      chrome: input.runtimeKind === 'claude' ? input.chrome === true : null,
      chat: input.runtimeKind === 'chat' ? (input.chat ?? { ...DEFAULT_CHAT_MEMBER }) : null,
    };
    const config: AgentConfigJson = {};
    if (agent.chat) config.chat = agent.chat;
    if (agent.workspace) config.workspace = agent.workspace;
    if (agent.model) config.model = agent.model;
    if (agent.effort) config.effort = agent.effort;
    if (agent.permissionMode) config.permissionMode = agent.permissionMode;
    if (agent.language) config.language = agent.language;
    if (agent.chrome) config.chrome = true;
    this.db
      .prepare(
        `INSERT INTO agents (id, handle, display_name, runtime_kind, is_mock, config_json, created_at, provider_id, collab_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        agent.id,
        agent.handle,
        agent.displayName,
        agent.runtimeKind,
        agent.isMock ? 1 : 0,
        JSON.stringify(config),
        agent.createdAt,
        agent.providerId,
        agent.collabMode,
      );
    return agent;
  }

  /**
   * Sets an Antigravity member's collaboration mode. `confirmedVersion` is the warning version the user confirmed when
   * switching to full (recorded with the time); going back to restricted keeps the last confirmation on record.
   */
  setCollabMode(id: string, mode: CollabMode, confirmedVersion: string | null): Agent {
    if (mode === 'full') {
      if (!confirmedVersion) throw new Error('full mode needs a confirmed warning version');
      this.db
        .prepare(`UPDATE agents SET collab_mode = 'full', collab_confirmed_at = ?, collab_warning_version = ? WHERE id = ? AND runtime_kind = 'antigravity'`)
        .run(now(), confirmedVersion, id);
    } else {
      this.db.prepare(`UPDATE agents SET collab_mode = 'restricted' WHERE id = ? AND runtime_kind = 'antigravity'`).run(id);
    }
    return this.getAgent(id)!;
  }

  /** Changes only the editable fields; handle, runtime and workspace are never touched here. */
  updateAgent(
    id: string,
    patch: {
      displayName?: string;
      model?: string | null;
      effort?: string | null;
      permissionMode?: PermissionMode | null;
      avatar?: string | null;
      language?: AgentLanguage | null;
      chrome?: boolean;
      chat?: ChatMemberSettings;
    },
  ): Agent {
    const r = this.db.prepare('SELECT config_json FROM agents WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new Error(`agent ${id} not found`);
    const config = parseConfig(r.config_json);
    if (patch.chat !== undefined) config.chat = patch.chat;
    if (patch.model !== undefined) {
      if (patch.model) config.model = patch.model;
      else delete config.model;
    }
    if (patch.effort !== undefined) {
      if (patch.effort) config.effort = patch.effort;
      else delete config.effort;
    }
    if (patch.permissionMode !== undefined) {
      if (patch.permissionMode) config.permissionMode = patch.permissionMode;
      else delete config.permissionMode;
    }
    if (patch.avatar !== undefined) {
      if (patch.avatar) config.avatar = patch.avatar;
      else delete config.avatar;
    }
    if (patch.language !== undefined) {
      if (patch.language) config.language = patch.language;
      else delete config.language;
    }
    if (patch.chrome !== undefined) {
      if (patch.chrome) config.chrome = true;
      else delete config.chrome;
    }
    if (patch.displayName !== undefined) {
      this.db.prepare('UPDATE agents SET display_name = ?, config_json = ? WHERE id = ?').run(patch.displayName, JSON.stringify(config), id);
    } else {
      this.db.prepare('UPDATE agents SET config_json = ? WHERE id = ?').run(JSON.stringify(config), id);
    }
    return this.getAgent(id)!;
  }

  /** Records how the runtime reported the agent's own login is billed; false when nothing changed. */
  setAgentBillingSeen(id: string, billing: RuntimeBilling | null): boolean {
    const r = this.db.prepare('SELECT config_json FROM agents WHERE id = ?').get(id) as Row | undefined;
    if (!r) return false;
    const config = parseConfig(r.config_json);
    if ((config.billingSeen ?? null) === billing) return false;
    if (billing) config.billingSeen = billing;
    else delete config.billingSeen;
    this.db.prepare('UPDATE agents SET config_json = ? WHERE id = ?').run(JSON.stringify(config), id);
    return true;
  }

  /** Forgets what the runtime reported for every agent of `kind` (the user's login for it changed). */
  clearBillingSeen(kind: Kind): string[] {
    const ids = this.listAgents()
      .filter((a) => a.runtimeKind === kind && a.billingSeen)
      .map((a) => a.id);
    for (const id of ids) this.setAgentBillingSeen(id, null);
    return ids;
  }

  listAgents(): Agent[] {
    return (this.db.prepare('SELECT * FROM agents ORDER BY created_at, id').all() as Row[]).map(toAgent);
  }

  avatarDefaults(): AvatarDefaults {
    const out: AvatarDefaults = {};
    for (const r of this.db.prepare('SELECT runtime_kind, avatar FROM avatar_defaults').all() as Row[]) {
      if (isAvatarDefaultKey(r.runtime_kind) && isAgentAvatar(r.avatar)) out[r.runtime_kind] = r.avatar;
    }
    return out;
  }

  /** null removes the default (members without their own picture show the letter mark again). */
  setAvatarDefault(kind: AvatarDefaultKey, avatar: string | null): void {
    if (avatar) {
      this.db
        .prepare('INSERT INTO avatar_defaults (runtime_kind, avatar, updated_at) VALUES (?, ?, ?) ON CONFLICT(runtime_kind) DO UPDATE SET avatar = excluded.avatar, updated_at = excluded.updated_at')
        .run(kind, avatar, now());
    } else {
      this.db.prepare('DELETE FROM avatar_defaults WHERE runtime_kind = ?').run(kind);
    }
  }

  getAgent(id: string): Agent | undefined {
    const r = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Row | undefined;
    return r ? toAgent(r) : undefined;
  }

  /** Case-insensitive in every script: SQLite NOCASE folds ASCII only, so non-ASCII handles are compared in JS. */
  getAgentByHandle(handle: string): Agent | undefined {
    const r = this.db
      .prepare('SELECT * FROM agents WHERE handle = ? COLLATE NOCASE AND deleted_at IS NULL')
      .get(handle) as Row | undefined;
    if (r || !/[^ -~]/.test(handle)) return r ? toAgent(r) : undefined;
    const key = handleKey(handle);
    const rows = this.db.prepare('SELECT * FROM agents WHERE deleted_at IS NULL').all() as Row[];
    const hit = rows.find((x) => handleKey(String(x.handle)) === key);
    return hit ? toAgent(hit) : undefined;
  }

  // ---- membership ----
  addMember(roomId: string, agentId: string, defaultReply = false): boolean {
    const res = this.db
      .prepare('INSERT OR IGNORE INTO room_members (room_id, agent_id, joined_at, default_reply) VALUES (?, ?, ?, ?)')
      .run(roomId, agentId, now(), defaultReply ? 1 : 0);
    return Number(res.changes) > 0;
  }

  listMembers(roomId: string): Agent[] {
    return (
      this.db
        .prepare(
          `SELECT a.* FROM agents a JOIN room_members m ON m.agent_id = a.id
           WHERE m.room_id = ? ORDER BY m.position IS NULL, m.position, m.joined_at, a.id`,
        )
        .all(roomId) as Row[]
    ).map(toAgent);
  }

  /** Puts the room's members in this order (every current member, each once; the caller checks). */
  reorderMembers(roomId: string, agentIds: string[]): void {
    const set = this.db.prepare('UPDATE room_members SET position = ? WHERE room_id = ? AND agent_id = ?');
    this.db.exec('BEGIN');
    try {
      agentIds.forEach((id, i) => set.run(i, roomId, id));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  removeMember(roomId: string, agentId: string): boolean {
    return Number(this.db.prepare('DELETE FROM room_members WHERE room_id = ? AND agent_id = ?').run(roomId, agentId).changes) > 0;
  }

  /** Rooms the agent is a member of, in joining order. */
  roomsOf(agentId: string): string[] {
    return (
      this.db.prepare('SELECT room_id FROM room_members WHERE agent_id = ? ORDER BY joined_at, rowid').all(agentId) as Row[]
    ).map((r) => String(r.room_id));
  }

  /**
   * Marks the agent deleted: it leaves every room and its handle is freed. The row stays so messages it wrote keep
   * their author; deliveries, cursors and native session bindings are kept as history.
   */
  deleteAgent(id: string): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM room_members WHERE agent_id = ?').run(id);
      this.db
        .prepare("UPDATE agents SET deleted_at = ?, handle = handle || '~' || id WHERE id = ? AND deleted_at IS NULL")
        .run(now(), id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  isMember(roomId: string, agentId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND agent_id = ?').get(roomId, agentId);
  }

  // ---- messages ----

  /** Inserts a message with the next per-room seq inside a write transaction. */
  insertMessage(input: NewMessage): Message {
    const copy = redactMessageCopy(input.body, input.meta ?? null);
    const ts = now();
    const id = input.id ?? randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const next = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE room_id = ?')
        .get(input.roomId) as { next: number };
      const atts: StoredAttachment[] = [];
      for (const aid of input.attachmentIds ?? []) {
        const r = this.db.prepare('SELECT * FROM attachments WHERE id = ?').get(aid) as Row | undefined;
        const a = r ? toAttachment(r) : undefined;
        if (!a || a.roomId !== input.roomId || a.messageId !== null) throw new AttachmentBindError(aid);
        atts.push(a);
      }
      this.db
        .prepare(
          `INSERT INTO messages (id, room_id, seq, kind, sender_kind, sender_id, body, status, mentions_json,
                                 reply_to, client_message_id, meta_json, attachments_json, created_at, updated_at, content_redacted)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.roomId,
          next.next,
          input.kind,
          input.senderKind,
          input.senderId,
          copy.body,
          input.status,
          JSON.stringify(input.mentions ?? []),
          input.replyTo ?? null,
          input.clientMessageId ?? null,
          copy.meta ? JSON.stringify(copy.meta) : null,
          atts.length ? JSON.stringify(atts.map(attachmentInfo)) : null,
          ts,
          ts,
          copy.changed || input.contentRedacted ? 1 : input.contentRedacted === null ? null : 0,
        );
      for (const a of atts) this.db.prepare('UPDATE attachments SET message_id = ? WHERE id = ?').run(id, a.id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.getMessage(id)!;
  }

  getMessage(id: string): Message | undefined {
    const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined;
    return r ? toMessage(r) : undefined;
  }

  findByClientMessageId(roomId: string, clientMessageId: string): Message | undefined {
    const r = this.db
      .prepare('SELECT * FROM messages WHERE room_id = ? AND client_message_id = ?')
      .get(roomId, clientMessageId) as Row | undefined;
    return r ? toMessage(r) : undefined;
  }

  /**
   * The latest `limit` complete chat messages with seq in (afterSeq, upToSeq] (ascending), plus how many such messages
   * exist. Slash commands are not chat: they never go into a turn envelope.
   */
  chatSince(roomId: string, afterSeq: number, upToSeq: number, limit: number): { messages: Message[]; total: number } {
    const total = this.db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE room_id = ? AND seq > ? AND seq <= ? AND kind = 'chat' AND status = 'complete'${NO_COMMANDS}`)
      .get(roomId, afterSeq, upToSeq) as { n: number };
    const rows = this.db
      .prepare(
        `SELECT * FROM (SELECT * FROM messages WHERE room_id = ? AND seq > ? AND seq <= ? AND kind = 'chat' AND status = 'complete'${NO_COMMANDS}
           ORDER BY seq DESC LIMIT ?) ORDER BY seq`,
      )
      .all(roomId, afterSeq, upToSeq, limit) as Row[];
    return { messages: rows.map(toMessage), total: Number(total.n) };
  }

  /**
   * Unseen chat from other senders (seq in (afterSeq, upToSeq]) that is not in `shownIds`: how many, and the oldest seq.
   * Used to know which messages a turn envelope had to leave out.
   */
  chatOmitted(roomId: string, afterSeq: number, upToSeq: number, excludeSenderId: string, shownIds: string[]): { count: number; firstSeq: number | null } {
    const notIn = shownIds.length ? ` AND id NOT IN (${shownIds.map(() => '?').join(',')})` : '';
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n, MIN(seq) AS first FROM messages
         WHERE room_id = ? AND seq > ? AND seq <= ? AND kind = 'chat' AND status = 'complete' AND sender_id <> ?${NO_COMMANDS}${notIn}`,
      )
      .get(roomId, afterSeq, upToSeq, excludeSenderId, ...shownIds) as { n: number; first: number | null };
    return { count: Number(r.n), firstSeq: r.first === null ? null : Number(r.first) };
  }

  /**
   * Messages an agent may read through Team MCP (complete, non-empty chat and system messages), filtered in SQL
   * before LIMIT so tool activity can never push them out of a page. Ascending seq.
   */
  listTeamVisible(roomId: string, afterSeq: number, limit: number): Message[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM messages WHERE room_id = ? AND seq > ? AND kind IN ('chat', 'system') AND status = 'complete' AND (body <> '' OR attachments_json IS NOT NULL)${NO_COMMANDS}
           ORDER BY seq LIMIT ?`,
        )
        .all(roomId, afterSeq, limit) as Row[]
    ).map(toMessage);
  }

  countTeamVisible(roomId: string, afterSeq: number): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages WHERE room_id = ? AND seq > ? AND kind IN ('chat', 'system') AND status = 'complete' AND (body <> '' OR attachments_json IS NOT NULL)${NO_COMMANDS}`,
      )
      .get(roomId, afterSeq) as { n: number };
    return Number(r.n);
  }

  maxSeq(roomId: string): number {
    const r = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM messages WHERE room_id = ?').get(roomId) as { s: number };
    return Number(r.s);
  }

  /** Recent chat message from this sender with exactly this body (duplicate-send guard for Team MCP). */
  findRecentDuplicate(roomId: string, senderId: string, body: string, sinceIso: string): Message | undefined {
    const r = this.db
      .prepare(
        `SELECT * FROM messages WHERE room_id = ? AND sender_id = ? AND body = ? AND kind = 'chat' AND created_at >= ?
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(roomId, senderId, body, sinceIso) as Row | undefined;
    return r ? toMessage(r) : undefined;
  }

  /** Messages ordered by seq. `afterSeq` returns only newer ones (for resync); otherwise the latest `limit`. */
  listMessages(roomId: string, opts: { afterSeq?: number; limit?: number } = {}): Message[] {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    if (opts.afterSeq !== undefined) {
      return (
        this.db
          .prepare('SELECT * FROM messages WHERE room_id = ? AND seq > ? ORDER BY seq LIMIT ?')
          .all(roomId, opts.afterSeq, limit) as Row[]
      ).map(toMessage);
    }
    return (
      this.db
        .prepare('SELECT * FROM (SELECT * FROM messages WHERE room_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq')
        .all(roomId, limit) as Row[]
    ).map(toMessage);
  }

  updateMessage(
    id: string,
    patch: {
      body?: string;
      contentRedacted?: boolean;
      status?: MessageStatus;
      kind?: MessageKind;
      meta?: MessageMeta | null;
      mentions?: string[];
      /** Only to turn a reply placeholder into a system notice (sender 'system'). */
      sender?: { kind: Message['senderKind']; id: string };
    },
  ): Message {
    const cur = this.getMessage(id);
    if (!cur) throw new Error(`message ${id} not found`);
    const meta = patch.meta === undefined ? cur.meta : patch.meta;
    const copy = redactMessageCopy(patch.body ?? cur.body, meta);
    const contentRedacted = patch.contentRedacted === undefined
      ? cur.contentRedacted ? 1 : cur.redactionUncertain ? null : 0
      : patch.contentRedacted ? 1 : 0;
    this.db
      .prepare(
        'UPDATE messages SET body = ?, status = ?, kind = ?, meta_json = ?, mentions_json = ?, sender_kind = ?, sender_id = ?, updated_at = ?, content_redacted = ? WHERE id = ?',
      )
      .run(
        copy.body,
        patch.status ?? cur.status,
        patch.kind ?? cur.kind,
        copy.meta ? JSON.stringify(copy.meta) : null,
        JSON.stringify(patch.mentions ?? cur.mentions),
        patch.sender?.kind ?? cur.senderKind,
        patch.sender?.id ?? cur.senderId,
        now(),
        copy.changed ? 1 : contentRedacted,
        id,
      );
    return this.getMessage(id)!;
  }

  // ---- attachments ----

  insertAttachment(input: { id: string; roomId: string; name: string; nameRedacted?: true; mime: string; kind: 'image' | 'file'; size: number; sha256: string }): StoredAttachment {
    this.db
      .prepare(
        `INSERT INTO attachments (id, room_id, message_id, name, mime, kind, size, sha256, created_at, name_redacted)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.roomId, input.name, input.mime, input.kind, input.size, input.sha256, now(), input.nameRedacted ? 1 : 0);
    return this.getAttachment(input.id)!;
  }

  *redactedAttachments(): Iterable<StoredAttachment> {
    for (const row of this.db.prepare('SELECT * FROM attachments WHERE name_redacted = 1').iterate()) yield toAttachment(row);
  }

  getAttachment(id: string): StoredAttachment | undefined {
    const r = this.db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as Row | undefined;
    return r ? toAttachment(r) : undefined;
  }

  /** A message's attachments in the order they were attached. */
  messageAttachments(message: Message): StoredAttachment[] {
    return (message.attachments ?? []).map((a) => this.getAttachment(a.id)).filter((a): a is StoredAttachment => !!a);
  }

  roomAttachmentBytes(roomId: string): number {
    const r = this.db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM attachments WHERE room_id = ?').get(roomId) as { n: number };
    return Number(r.n);
  }

  /** Removes an attachment row only while it is not bound to a message. */
  deleteUnboundAttachment(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM attachments WHERE id = ? AND message_id IS NULL').run(id).changes) > 0;
  }

  /** Uploaded but never sent, created before `beforeIso`. */
  staleUnboundAttachments(beforeIso: string): StoredAttachment[] {
    return (
      this.db.prepare('SELECT * FROM attachments WHERE message_id IS NULL AND created_at < ?').all(beforeIso) as Row[]
    ).map(toAttachment);
  }

  // ---- deliveries ----

  /** Creates a delivery unless one already exists for (message, agent); returns null for a duplicate. */
  createDelivery(input: NewDelivery): DeliveryInfo | null {
    const ts = now();
    const id = randomUUID();
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO deliveries (id, room_id, message_id, agent_id, state, origin, hop, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.roomId, input.messageId, input.agentId, input.state, input.origin, input.hop, input.error ?? null, ts, ts);
    return Number(res.changes) > 0 ? this.getDelivery(id)! : null;
  }

  getDelivery(id: string): DeliveryInfo | undefined {
    const r = this.db.prepare('SELECT * FROM deliveries WHERE id = ?').get(id) as Row | undefined;
    return r ? toDelivery(r) : undefined;
  }

  updateDelivery(
    id: string,
    patch: { state?: DeliveryState; replyMessageId?: string | null; error?: Localized | null; stamp?: DeliveryStamp },
  ): DeliveryInfo {
    const ts = now();
    const col = patch.stamp ? `, ${patch.stamp}_at = COALESCE(${patch.stamp}_at, ?)` : '';
    const params: (string | null)[] = [patch.state ?? null, patch.replyMessageId ?? null, encodeError(patch.error), ts];
    if (patch.stamp) params.push(ts);
    params.push(id);
    this.db
      .prepare(
        `UPDATE deliveries SET state = COALESCE(?, state), reply_message_id = COALESCE(?, reply_message_id),
                error = COALESCE(?, error), updated_at = ?${col} WHERE id = ?`,
      )
      .run(...params);
    return this.getDelivery(id)!;
  }

  hasPendingDelivery(messageId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM deliveries WHERE message_id = ? AND state IN ('queued','held','dispatched','accepted') LIMIT 1").get(messageId);
  }

  listDeliveries(state?: DeliveryState): DeliveryInfo[] {
    const rows = (
      state
        ? this.db.prepare('SELECT * FROM deliveries WHERE state = ? ORDER BY created_at, rowid').all(state)
        : this.db.prepare('SELECT * FROM deliveries ORDER BY created_at, rowid').all()
    ) as Row[];
    return rows.map(toDelivery);
  }

  /** Deliveries to this agent in this room that were never dispatched (queued or held). */
  pendingDeliveries(agentId: string, roomId: string): DeliveryInfo[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM deliveries WHERE agent_id = ? AND room_id = ? AND state IN ('queued','held') ORDER BY created_at, rowid`,
      )
      .all(agentId, roomId) as Row[];
    return rows.map(toDelivery);
  }

  /** Deliveries of a room (optionally one state), for source messages with seq >= minSeq, in message order. */
  listRoomDeliveries(roomId: string, opts: { state?: DeliveryState; minSeq?: number } = {}): DeliveryInfo[] {
    const rows = this.db
      .prepare(
        `SELECT d.* FROM deliveries d JOIN messages m ON m.id = d.message_id
         WHERE d.room_id = ? AND (? IS NULL OR d.state = ?) AND m.seq >= ?
         ORDER BY m.seq, d.created_at, d.rowid`,
      )
      .all(roomId, opts.state ?? null, opts.state ?? null, opts.minSeq ?? 0) as Row[];
    return rows.map(toDelivery);
  }

  // ---- tasks ----
  createTask(input: {
    roomId: string;
    title: string;
    titleRedacted?: boolean;
    assigneeId: string | null;
    createdBy: string;
    sourceMessageId?: string | null;
    status?: TaskStatus;
  }): Task {
    const ts = now();
    const res = this.db
      .prepare(
        `INSERT INTO tasks (room_id, title, status, assignee_agent_id, created_by, source_message_id, created_at, updated_at, title_redacted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.roomId,
        input.title,
        input.status ?? 'todo',
        input.assigneeId,
        input.createdBy,
        input.sourceMessageId ?? null,
        ts,
        ts,
        input.titleRedacted ? 1 : 0,
      );
    return this.getTask(Number(res.lastInsertRowid))!;
  }

  getTask(id: number): Task | undefined {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return r ? toTask(r) : undefined;
  }

  listTasks(roomId: string): Task[] {
    return (this.db.prepare('SELECT * FROM tasks WHERE room_id = ? ORDER BY id').all(roomId) as Row[]).map(toTask);
  }

  updateTask(id: number, patch: { title?: string; titleRedacted?: boolean; status?: TaskStatus; assigneeId?: string | null }): Task {
    const cur = this.getTask(id);
    if (!cur) throw new Error(`task ${id} not found`);
    this.db
      .prepare('UPDATE tasks SET title = ?, status = ?, assignee_agent_id = ?, updated_at = ?, title_redacted = ? WHERE id = ?')
      .run(
        patch.title ?? cur.title,
        patch.status ?? cur.status,
        patch.assigneeId === undefined ? cur.assigneeId : patch.assigneeId,
        now(),
        patch.titleRedacted === undefined ? cur.titleRedacted ? 1 : cur.titleRedactionUncertain ? null : 0 : patch.titleRedacted ? 1 : 0,
        id,
      );
    return this.getTask(id)!;
  }

  // ---- cursors (per agent and room) ----
  // last_seq: how far turn envelopes have covered. read_seq: default start of Team MCP get_messages.
  /** Envelope cursor. */
  getCursor(agentId: string, roomId: string): number {
    const r = this.db
      .prepare('SELECT last_seq FROM agent_room_cursors WHERE agent_id = ? AND room_id = ?')
      .get(agentId, roomId) as { last_seq: number } | undefined;
    return r ? Number(r.last_seq) : 0;
  }

  /** Moves the envelope cursor forward only. */
  advanceCursor(agentId: string, roomId: string, seq: number) {
    this.db
      .prepare(
        `INSERT INTO agent_room_cursors (agent_id, room_id, last_seq, read_seq, updated_at) VALUES (?, ?, ?, 0, ?)
         ON CONFLICT (agent_id, room_id) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq),
           updated_at = excluded.updated_at`,
      )
      .run(agentId, roomId, seq, now());
  }

  /** Team MCP read cursor (default start of get_messages). */
  getReadCursor(agentId: string, roomId: string): number {
    const r = this.db
      .prepare('SELECT read_seq FROM agent_room_cursors WHERE agent_id = ? AND room_id = ?')
      .get(agentId, roomId) as { read_seq: number } | undefined;
    return r ? Number(r.read_seq) : 0;
  }

  /** Moves the read cursor forward only. */
  advanceReadCursor(agentId: string, roomId: string, seq: number) {
    this.db
      .prepare(
        `INSERT INTO agent_room_cursors (agent_id, room_id, last_seq, read_seq, updated_at) VALUES (?, ?, 0, ?, ?)
         ON CONFLICT (agent_id, room_id) DO UPDATE SET read_seq = MAX(read_seq, excluded.read_seq),
           updated_at = excluded.updated_at`,
      )
      .run(agentId, roomId, seq, now());
  }

  // ---- native session bindings ----
  getBinding(agentId: string, roomId: string): SessionBinding | undefined {
    const r = this.db
      .prepare('SELECT * FROM native_session_bindings WHERE agent_id = ? AND room_id = ?')
      .get(agentId, roomId) as Row | undefined;
    if (!r) return undefined;
    return {
      id: String(r.id),
      agentId: String(r.agent_id),
      roomId: String(r.room_id),
      runtimeKind: r.runtime_kind as RuntimeKind,
      nativeSessionId: String(r.native_session_id),
      status: r.status as SessionBinding['status'],
      instructionsVersion: r.instructions_version == null ? null : String(r.instructions_version),
      adapterState: r.adapter_state == null ? null : String(r.adapter_state),
    };
  }

  listBindings(agentId: string): (SessionBinding & { updatedAt: string })[] {
    const rows = this.db
      .prepare('SELECT * FROM native_session_bindings WHERE agent_id = ? ORDER BY updated_at DESC')
      .all(agentId) as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      agentId: String(r.agent_id),
      roomId: String(r.room_id),
      runtimeKind: r.runtime_kind as RuntimeKind,
      nativeSessionId: String(r.native_session_id),
      status: r.status as SessionBinding['status'],
      instructionsVersion: r.instructions_version == null ? null : String(r.instructions_version),
      adapterState: r.adapter_state == null ? null : String(r.adapter_state),
      updatedAt: String(r.updated_at),
    }));
  }

  /** instructionsVersion: what the session was started with (kept as-is when the same session is resumed). */
  upsertBinding(input: { agentId: string; roomId: string; runtimeKind: RuntimeKind; nativeSessionId: string; instructionsVersion: string | null }) {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO native_session_bindings
           (id, agent_id, room_id, runtime_kind, native_session_id, status, instructions_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
         ON CONFLICT (agent_id, room_id) DO UPDATE SET
           adapter_state = CASE WHEN native_session_id = excluded.native_session_id THEN adapter_state ELSE NULL END,
           native_session_id = excluded.native_session_id, status = 'active',
           instructions_version = excluded.instructions_version, updated_at = excluded.updated_at`,
      )
      .run(randomUUID(), input.agentId, input.roomId, input.runtimeKind, input.nativeSessionId, input.instructionsVersion, ts, ts);
  }

  /** Only for the session it was taken from: a binding that moved to another session meanwhile keeps its own. */
  /** False when no binding of this agent and room has that native session id (nothing was saved). */
  setBindingAdapterState(agentId: string, roomId: string, nativeSessionId: string, state: string | null): boolean {
    const r = this.db
      .prepare('UPDATE native_session_bindings SET adapter_state = ? WHERE agent_id = ? AND room_id = ? AND native_session_id = ?')
      .run(state, agentId, roomId, nativeSessionId);
    return Number(r.changes) > 0;
  }

  setBindingStatus(agentId: string, roomId: string, status: SessionBinding['status']) {
    this.db
      .prepare('UPDATE native_session_bindings SET status = ?, updated_at = ? WHERE agent_id = ? AND room_id = ?')
      .run(status, now(), agentId, roomId);
  }

  /**
   * Startup recovery: anything that was mid-flight when the Core stopped is NOT re-run automatically,
   * because a real coding turn may already have modified files. It is marked unknown/interrupted instead.
   */
  recoverAfterRestart(): { deliveries: number; unknown: DeliveryInfo[]; requeue: DeliveryInfo[]; messages: Message[] } {
    const ts = now();
    // Dispatched/accepted: the runtime may or may not have acted on it (and may have edited files).
    // Outcome unknown; it must be checked by a human, never re-run automatically.
    const inFlight = (
      this.db.prepare(`SELECT * FROM deliveries WHERE state IN ('dispatched','accepted') ORDER BY created_at`).all() as Row[]
    ).map(toDelivery);
    const d = this.db
      .prepare(
        `UPDATE deliveries SET state = 'unknown', error = COALESCE(error, 'core stopped after dispatch; outcome unknown'),
                updated_at = ? WHERE state IN ('dispatched','accepted')`,
      )
      .run(ts);
    // Queued (never dispatched): the agent never saw it, so the persistent queue resumes it. Held stays held.
    const requeue = this.listDeliveries('queued');
    const streaming = (this.db.prepare(`SELECT * FROM messages WHERE status = 'streaming'`).all() as Row[]).map(
      toMessage,
    );
    this.db.prepare(`UPDATE messages SET status = 'interrupted', updated_at = ? WHERE status = 'streaming'`).run(ts);
    return {
      deliveries: Number(d.changes),
      unknown: inFlight.map((x) => this.getDelivery(x.id)!),
      requeue,
      messages: streaming.map((m) => this.getMessage(m.id)!),
    };
  }
}
