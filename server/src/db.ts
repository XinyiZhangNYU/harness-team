import { backup, DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { errorNotice, isNotice, L, NoticeError, renderNotice, type Localized } from '../../shared/notices.ts';
import type { AttachmentInfo, MessageMeta } from '../../shared/protocol.ts';
import { replacementName, safeAttachmentName } from './attachments.ts';
import { redactMessageCopy } from './message-copy.ts';
import { hasLegacySecretMarker, redactLegacyLocalized, redactLegacyMessageCopy, redactLegacyText } from './legacy-copy.ts';
import { commonProjectDir } from './workspaces.ts';
import { redactText } from './redact.ts';

export interface Migration {
  version: number;
  name: string;
  sql: string;
  /** Data step run after `sql`, in the same transaction. */
  after?: (db: DatabaseSync) => void;
  /**
   * Rebuilds a table other tables reference: foreign keys are switched off around the transaction (a DROP TABLE would
   * otherwise run the ON DELETE actions of the referencing rows) and `PRAGMA foreign_key_check` must be clean before
   * the commit.
   */
  rebuildsReferencedTable?: boolean;
}

// Append-only. Never edit a migration that has shipped; add a new one instead.
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial core schema',
    sql: `
      CREATE TABLE rooms (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );

      CREATE TABLE agents (
        id            TEXT PRIMARY KEY,
        handle        TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name  TEXT NOT NULL,
        runtime_kind  TEXT NOT NULL CHECK (runtime_kind IN ('mock','codex','claude')),
        is_mock       INTEGER NOT NULL CHECK (is_mock IN (0,1)),
        config_json   TEXT NOT NULL DEFAULT '{}',
        created_at    TEXT NOT NULL
      );

      CREATE TABLE room_members (
        room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        joined_at  TEXT NOT NULL,
        PRIMARY KEY (room_id, agent_id)
      );

      CREATE TABLE messages (
        id                 TEXT PRIMARY KEY,
        room_id            TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        seq                INTEGER NOT NULL,
        kind               TEXT NOT NULL CHECK (kind IN ('chat','activity','approval','system')),
        sender_kind        TEXT NOT NULL CHECK (sender_kind IN ('user','agent','system')),
        sender_id          TEXT NOT NULL,
        body               TEXT NOT NULL,
        status             TEXT NOT NULL CHECK (status IN ('streaming','complete','failed','interrupted')),
        mentions_json      TEXT NOT NULL DEFAULT '[]',
        reply_to           TEXT REFERENCES messages(id),
        client_message_id  TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        UNIQUE (room_id, seq)
      );
      CREATE UNIQUE INDEX messages_client_id ON messages(room_id, client_message_id)
        WHERE client_message_id IS NOT NULL;

      -- Exact native session/thread id per (agent, room). Never guessed from "most recent".
      CREATE TABLE native_session_bindings (
        id                 TEXT PRIMARY KEY,
        agent_id           TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        room_id            TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        runtime_kind       TEXT NOT NULL,
        native_session_id  TEXT NOT NULL,
        status             TEXT NOT NULL CHECK (status IN ('active','closed','lost')),
        meta_json          TEXT NOT NULL DEFAULT '{}',
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        UNIQUE (agent_id, room_id)
      );

      -- Delivery of a message to an agent. Saved != dispatched != processed.
      CREATE TABLE deliveries (
        id                  TEXT PRIMARY KEY,
        message_id          TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        agent_id            TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        state               TEXT NOT NULL CHECK (state IN ('queued','dispatched','completed','failed','unknown')),
        reply_message_id    TEXT REFERENCES messages(id),
        error               TEXT,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        UNIQUE (message_id, agent_id)
      );
      CREATE INDEX deliveries_state ON deliveries(state);
    `,
  },
  {
    version: 2,
    name: 'message meta for native activity/approval items',
    sql: `
      ALTER TABLE messages ADD COLUMN meta_json TEXT;
    `,
  },
  {
    version: 3,
    name: 'cross-agent collaboration: delivery stages, hops, auto-collab settings, tasks, read cursors',
    // SQLite cannot alter a CHECK constraint, so deliveries is rebuilt. Nothing references deliveries.
    sql: `
      ALTER TABLE rooms ADD COLUMN auto_paused INTEGER NOT NULL DEFAULT 0 CHECK (auto_paused IN (0,1));
      ALTER TABLE rooms ADD COLUMN auto_hop_limit INTEGER NOT NULL DEFAULT 6;

      CREATE TABLE deliveries_v3 (
        id                  TEXT PRIMARY KEY,
        room_id             TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        message_id          TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        agent_id            TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        state               TEXT NOT NULL CHECK (state IN ('queued','held','skipped','dispatched','accepted',
                                                           'completed','interrupted','failed','unknown')),
        origin              TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user','agent')),
        hop                 INTEGER NOT NULL DEFAULT 0,
        reply_message_id    TEXT REFERENCES messages(id),
        error               TEXT,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        dispatched_at       TEXT,
        accepted_at         TEXT,
        replied_at          TEXT,
        finished_at         TEXT,
        UNIQUE (message_id, agent_id)
      );
      INSERT INTO deliveries_v3 (id, room_id, message_id, agent_id, state, origin, hop, reply_message_id, error,
                                 created_at, updated_at)
        SELECT d.id, m.room_id, d.message_id, d.agent_id, d.state, 'user', 0, d.reply_message_id, d.error,
               d.created_at, d.updated_at
        FROM deliveries d JOIN messages m ON m.id = d.message_id;
      DROP TABLE deliveries;
      ALTER TABLE deliveries_v3 RENAME TO deliveries;
      CREATE INDEX deliveries_state ON deliveries(state);
      CREATE INDEX deliveries_room ON deliveries(room_id, created_at);

      CREATE TABLE tasks (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id            TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        title              TEXT NOT NULL,
        status             TEXT NOT NULL CHECK (status IN ('todo','doing','done')),
        assignee_agent_id  TEXT REFERENCES agents(id) ON DELETE SET NULL,
        created_by         TEXT NOT NULL,
        source_message_id  TEXT REFERENCES messages(id) ON DELETE SET NULL,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      );
      CREATE INDEX tasks_room ON tasks(room_id, id);

      -- Highest room seq each agent has been shown (in a turn envelope or via Team MCP read_messages).
      CREATE TABLE agent_room_cursors (
        agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        last_seq   INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, room_id)
      );
    `,
  },
  {
    version: 4,
    name: 'separate Team MCP read cursor from the envelope cursor',
    // last_seq: how far turn envelopes have covered (context is never repeated).
    // read_seq: where get_messages starts by default; it stays before messages the envelope had to omit.
    // Existing rows keep their previous behaviour (read_seq = last_seq).
    sql: `
      ALTER TABLE agent_room_cursors ADD COLUMN read_seq INTEGER NOT NULL DEFAULT 0;
      UPDATE agent_room_cursors SET read_seq = last_seq;
    `,
  },
  {
    version: 5,
    name: 'room project directory, pinned and archived flags',
    // project_dir only groups rooms in the sidebar (no runtime reads it). Existing rooms take the project most of
    // their members work in (a member worktree counts as the repository it was made from).
    sql: `
      ALTER TABLE rooms ADD COLUMN project_dir TEXT;
      ALTER TABLE rooms ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1));
      ALTER TABLE rooms ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1));
    `,
    after: (db) => {
      const rooms = db.prepare('SELECT id FROM rooms').all() as { id: string }[];
      const members = db.prepare(
        'SELECT a.config_json AS config FROM room_members m JOIN agents a ON a.id = m.agent_id WHERE m.room_id = ? ORDER BY m.joined_at, m.rowid',
      );
      const workspaceOf = (config: string): string | null => {
        try {
          const w = (JSON.parse(config) as { workspace?: unknown }).workspace;
          return typeof w === 'string' ? w : null;
        } catch {
          return null;
        }
      };
      const set = db.prepare('UPDATE rooms SET project_dir = ? WHERE id = ?');
      for (const r of rooms) {
        const dir = commonProjectDir((members.all(r.id) as { config: string }[]).map((m) => workspaceOf(m.config)));
        if (dir) set.run(dir, r.id);
      }
    },
  },
  {
    version: 6,
    name: 'deleted agents',
    // A deleted agent keeps its row so old messages still show who wrote them. Its handle is freed by renaming it to
    // "<handle>~<id>" ("~" is not allowed in handles); the store shows the original part.
    sql: `ALTER TABLE agents ADD COLUMN deleted_at TEXT;`,
  },
  {
    version: 7,
    name: 'model providers',
    // API / plan-key providers. The database never holds a key: key_ref is "env:NAME" (the variable is read when a
    // member's process starts) or "app" (encrypted in <dataDir>/secrets; added later and since removed with the route, no
    // schema change). agents.provider_id NULL = the runtime's subscription login (all rows before v7). No foreign
    // key on agents.provider_id: deleted agents keep their row; the Core refuses to delete a provider in use.
    sql: `
      CREATE TABLE providers (
        id          TEXT PRIMARY KEY,
        label       TEXT NOT NULL,
        format      TEXT NOT NULL,
        billing     TEXT NOT NULL,
        base_url    TEXT NOT NULL,
        auth_header TEXT NOT NULL,
        key_ref     TEXT NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL
      );
      CREATE TABLE provider_models (
        provider_id    TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        model_id       TEXT NOT NULL,
        display_name   TEXT,
        context_tokens INTEGER,
        vision         INTEGER NOT NULL DEFAULT 0,
        enabled        INTEGER NOT NULL DEFAULT 1,
        position       INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (provider_id, model_id)
      );
      ALTER TABLE agents ADD COLUMN provider_id TEXT;
    `,
  },
  {
    version: 8,
    name: 'token usage',
    // One row per (turn, model) with the token counts the runtime itself reported. No foreign keys: usage history is
    // kept when a room is deleted (agents keep their rows anyway). project_dir is the room's project at the time,
    // workspace the folder the member ran in. Counts are disjoint (see TurnUsage in adapters/types.ts).
    sql: `
      CREATE TABLE usage_records (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        at                 TEXT NOT NULL,
        room_id            TEXT NOT NULL,
        agent_id           TEXT NOT NULL,
        runtime_kind       TEXT NOT NULL,
        provider_id        TEXT,
        model              TEXT,
        project_dir        TEXT,
        workspace          TEXT,
        reply_message_id   TEXT NOT NULL,
        turn_status        TEXT NOT NULL,
        input_tokens       INTEGER NOT NULL,
        cache_read_tokens  INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        output_tokens      INTEGER NOT NULL,
        reasoning_tokens   INTEGER NOT NULL,
        cost_usd           REAL
      );
      CREATE INDEX usage_records_at ON usage_records(at);
    `,
  },
  {
    version: 9,
    name: 'standing instructions',
    // Fingerprint of the Harness Team rules a native session was started with as standing instructions. NULL for
    // sessions started before (or on runtimes without the option): their turns keep carrying the rules in full.
    sql: `ALTER TABLE native_session_bindings ADD COLUMN instructions_version TEXT;`,
  },
  {
    version: 10,
    name: 'attachments',
    // Files the local user attaches. Bytes live in <dataDir>/attachments/<room>/<id>/, never in the database or a
    // workspace. message_id is NULL while uploaded but not sent yet (swept after a day). messages.attachments_json is
    // the AttachmentInfo list shown with the message, written in the same transaction that binds the rows.
    sql: `
      CREATE TABLE attachments (
        id          TEXT PRIMARY KEY,
        room_id     TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        message_id  TEXT REFERENCES messages(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        mime        TEXT NOT NULL,
        kind        TEXT NOT NULL CHECK (kind IN ('image','file')),
        size        INTEGER NOT NULL,
        sha256      TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX attachments_room ON attachments(room_id);
      CREATE INDEX attachments_message ON attachments(message_id);
      ALTER TABLE messages ADD COLUMN attachments_json TEXT;
    `,
  },
  {
    version: 11,
    name: 'agent language',
    // Language Harness Team speaks to the room's agents in (Room.agentLanguage). Existing rooms keep Chinese.
    sql: `ALTER TABLE rooms ADD COLUMN agent_language TEXT NOT NULL DEFAULT 'zh' CHECK (agent_language IN ('zh','en'));`,
  },
  {
    version: 12,
    name: 'default responders',
    // Members a user message without an @mention goes to (Room.defaultResponders). Existing members are not defaults.
    sql: `ALTER TABLE room_members ADD COLUMN default_reply INTEGER NOT NULL DEFAULT 0 CHECK (default_reply IN (0,1));`,
  },
  {
    version: 13,
    name: 'antigravity runtime and collaboration mode',
    // Antigravity (official ACP harness) as a third runtime kind. SQLite cannot alter the runtime_kind CHECK, so agents
    // is rebuilt with the same columns plus the collaboration mode of Antigravity members (NULL for other runtimes):
    // only the mode, when the user confirmed the full-mode warning and which version of it. No Google account or plan.
    rebuildsReferencedTable: true,
    sql: `
      CREATE TABLE agents_v13 (
        id                     TEXT PRIMARY KEY,
        handle                 TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name           TEXT NOT NULL,
        runtime_kind           TEXT NOT NULL CHECK (runtime_kind IN ('mock','codex','claude','antigravity')),
        is_mock                INTEGER NOT NULL CHECK (is_mock IN (0,1)),
        config_json            TEXT NOT NULL DEFAULT '{}',
        created_at             TEXT NOT NULL,
        deleted_at             TEXT,
        provider_id            TEXT,
        collab_mode            TEXT CHECK (collab_mode IN ('restricted','full')),
        collab_confirmed_at    TEXT,
        collab_warning_version TEXT,
        CHECK ((runtime_kind = 'antigravity') = (collab_mode IS NOT NULL))
      );
      INSERT INTO agents_v13 (id, handle, display_name, runtime_kind, is_mock, config_json, created_at, deleted_at, provider_id)
        SELECT id, handle, display_name, runtime_kind, is_mock, config_json, created_at, deleted_at, provider_id FROM agents;
      DROP TABLE agents;
      ALTER TABLE agents_v13 RENAME TO agents;
    `,
  },
  {
    version: 14,
    name: 'default member avatars',
    // One picture per runtime, shown for its members without their own (display only, like an agent's own avatar).
    sql: `
      CREATE TABLE avatar_defaults (
        runtime_kind TEXT PRIMARY KEY CHECK (runtime_kind IN ('codex','claude','antigravity')),
        avatar       TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
    `,
  },
  {
    version: 15,
    name: 'dsh runtime',
    // DeepSeek Harness (dsh, official ACP harness) as a fourth runtime kind: the runtime_kind CHECKs are rebuilt with the
    // same columns and rows. dsh members have no collaboration mode (that is Antigravity's).
    rebuildsReferencedTable: true,
    sql: `
      CREATE TABLE agents_v15 (
        id                     TEXT PRIMARY KEY,
        handle                 TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name           TEXT NOT NULL,
        runtime_kind           TEXT NOT NULL CHECK (runtime_kind IN ('mock','codex','claude','antigravity','dsh')),
        is_mock                INTEGER NOT NULL CHECK (is_mock IN (0,1)),
        config_json            TEXT NOT NULL DEFAULT '{}',
        created_at             TEXT NOT NULL,
        deleted_at             TEXT,
        provider_id            TEXT,
        collab_mode            TEXT CHECK (collab_mode IN ('restricted','full')),
        collab_confirmed_at    TEXT,
        collab_warning_version TEXT,
        CHECK ((runtime_kind = 'antigravity') = (collab_mode IS NOT NULL))
      );
      INSERT INTO agents_v15 (id, handle, display_name, runtime_kind, is_mock, config_json, created_at, deleted_at, provider_id, collab_mode, collab_confirmed_at, collab_warning_version)
        SELECT id, handle, display_name, runtime_kind, is_mock, config_json, created_at, deleted_at, provider_id, collab_mode, collab_confirmed_at, collab_warning_version FROM agents;
      DROP TABLE agents;
      ALTER TABLE agents_v15 RENAME TO agents;
      CREATE TABLE avatar_defaults_v15 (
        runtime_kind TEXT PRIMARY KEY CHECK (runtime_kind IN ('codex','claude','antigravity','dsh')),
        avatar       TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
      INSERT INTO avatar_defaults_v15 (runtime_kind, avatar, updated_at) SELECT runtime_kind, avatar, updated_at FROM avatar_defaults;
      DROP TABLE avatar_defaults;
      ALTER TABLE avatar_defaults_v15 RENAME TO avatar_defaults;
    `,
  },
  {
    version: 16,
    name: 'opencode runtime',
    // OpenCode (official ACP server) as a runtime kind: the runtime_kind CHECKs are rebuilt with the same columns and rows.
    rebuildsReferencedTable: true,
    sql: `
      CREATE TABLE agents_v16 (
        id                     TEXT PRIMARY KEY,
        handle                 TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name           TEXT NOT NULL,
        runtime_kind           TEXT NOT NULL CHECK (runtime_kind IN ('mock','codex','claude','antigravity','dsh','opencode')),
        is_mock                INTEGER NOT NULL CHECK (is_mock IN (0,1)),
        config_json            TEXT NOT NULL DEFAULT '{}',
        created_at             TEXT NOT NULL,
        deleted_at             TEXT,
        provider_id            TEXT,
        collab_mode            TEXT CHECK (collab_mode IN ('restricted','full')),
        collab_confirmed_at    TEXT,
        collab_warning_version TEXT,
        CHECK ((runtime_kind = 'antigravity') = (collab_mode IS NOT NULL))
      );
      INSERT INTO agents_v16 (id, handle, display_name, runtime_kind, is_mock, config_json, created_at, deleted_at, provider_id, collab_mode, collab_confirmed_at, collab_warning_version)
        SELECT id, handle, display_name, runtime_kind, is_mock, config_json, created_at, deleted_at, provider_id, collab_mode, collab_confirmed_at, collab_warning_version FROM agents;
      DROP TABLE agents;
      ALTER TABLE agents_v16 RENAME TO agents;
      CREATE TABLE avatar_defaults_v16 (
        runtime_kind TEXT PRIMARY KEY CHECK (runtime_kind IN ('codex','claude','antigravity','dsh','opencode')),
        avatar       TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
      INSERT INTO avatar_defaults_v16 (runtime_kind, avatar, updated_at) SELECT runtime_kind, avatar, updated_at FROM avatar_defaults;
      DROP TABLE avatar_defaults;
      ALTER TABLE avatar_defaults_v16 RENAME TO avatar_defaults;
    `,
  },
  {
    version: 17,
    name: 'adapter state per binding',
    // What an adapter must remember about one native session across processes (ACP: the options Harness Team changed
    // and the runtime's values before that, so "follow" restores them after a resume). Cleared when the session changes.
    sql: `ALTER TABLE native_session_bindings ADD COLUMN adapter_state TEXT;`,
  },
  {
    version: 18,
    name: 'usage token counts known',
    // 0 for a record of a cost the runtime reported without token counts (its zeros are not real counts). The index
    // finds the records of one reply: a cost the runtime reported covers the tokens of that reply, which are then not
    // priced again from the list-price table.
    sql: `
      ALTER TABLE usage_records ADD COLUMN tokens_known INTEGER NOT NULL DEFAULT 1;
      CREATE INDEX usage_records_reply ON usage_records(reply_message_id);
    `,
  },
  {
    version: 19,
    name: 'usage cost-only records from before 18',
    // Before 18, a cost reported without token counts (ACP's usage_update cost alone, during or after a turn) was
    // stored with zero tokens, and 18 marked those zeros as known. A record with a cost and no token at all is such a
    // record: its token counts are not known. Records with any token count are left as they are.
    sql: `
      UPDATE usage_records SET tokens_known = 0
        WHERE tokens_known = 1 AND cost_usd IS NOT NULL AND input_tokens = 0 AND cache_read_tokens = 0 AND cache_write_tokens = 0
          AND output_tokens = 0 AND reasoning_tokens = 0;
    `,
  },
  {
    version: 20,
    name: 'redacted message and task copy provenance',
    sql: `
      ALTER TABLE messages ADD COLUMN content_redacted INTEGER;
      ALTER TABLE tasks ADD COLUMN title_redacted INTEGER;
    `,
    after: (db) => {
      // Old replacement markers have no provenance: distinguish uncertainty from a known replacement or literal.
      const provenance = (changed: boolean, text: string) => changed ? 1 : text.includes('[redacted') ? null : 0;
      const message = db.prepare('UPDATE messages SET body = ?, meta_json = ?, content_redacted = ? WHERE id = ?');
      for (const row of db.prepare('SELECT id, body, meta_json FROM messages').iterate()) {
        const raw = String(row.body);
        const body = redactText(raw);
        const meta = row.meta_json === null ? null : JSON.parse(String(row.meta_json));
        let changed = body !== raw;
        if (meta?.type === 'command' && typeof meta.args === 'string') {
          const args = redactText(meta.args);
          changed ||= args !== meta.args;
          meta.args = args;
        }
        const json = meta === null ? null : JSON.stringify(meta);
        message.run(body, json, provenance(changed, body + (json ?? '')), row.id!);
      }
      const task = db.prepare('UPDATE tasks SET title = ?, title_redacted = ? WHERE id = ?');
      for (const row of db.prepare('SELECT id, title FROM tasks').iterate()) {
        const raw = String(row.title);
        const title = redactText(raw);
        task.run(title, provenance(title !== raw, title), row.id!);
      }
    },
  },
  {
    version: 21,
    name: 'safe message metadata and attachment names',
    sql: 'ALTER TABLE attachments ADD COLUMN name_redacted INTEGER;',
    after: (db) => {
      const attachments = new Map<string, AttachmentInfo>();
      const updateAttachment = db.prepare('UPDATE attachments SET name = ?, name_redacted = ? WHERE id = ?');
      for (const row of db.prepare('SELECT id, name, mime FROM attachments').iterate()) {
        const raw = String(row.name), safe = safeAttachmentName(raw, String(row.mime));
        const provenance = safe.redacted ? 1 : raw.includes('[redacted') ? null : 0;
        updateAttachment.run(safe.name, provenance, row.id!);
        attachments.set(String(row.id), {
          id: String(row.id), name: safe.name,
          ...(provenance === 1 ? { nameRedacted: true } : provenance === null ? { nameRedactionUncertain: true } : {}),
        } as AttachmentInfo);
      }
      const update = db.prepare('UPDATE messages SET body = ?, meta_json = ?, attachments_json = ?, content_redacted = ? WHERE id = ?');
      for (const row of db.prepare('SELECT id, body, meta_json, attachments_json, content_redacted FROM messages').iterate()) {
        const meta = row.meta_json === null ? null : JSON.parse(String(row.meta_json)) as MessageMeta;
        const copy = redactMessageCopy(String(row.body), meta);
        const atts = row.attachments_json === null ? null : (JSON.parse(String(row.attachments_json)) as AttachmentInfo[]).map(a => {
          const stored = attachments.get(a.id);
          if (stored) return { ...a, name: stored.name, ...(stored.nameRedacted ? { nameRedacted: true as const } : {}),
            ...(stored.nameRedactionUncertain ? { nameRedactionUncertain: true as const } : {}) };
          const safe = safeAttachmentName(a.name, a.mime);
          return { ...a, name: safe.name, ...(safe.redacted ? { nameRedacted: true as const } : {}) };
        });
        // Check the rendered copies too; safe JSON parts alone do not prove safe interpolation.
        const label = copy.meta?.type === 'notice' ? copy.meta.notice
          : copy.meta?.type === 'activity' || copy.meta?.type === 'approval' ? copy.meta.label : null;
        if (label) for (const lang of ['zh', 'en'] as const) {
          const rendered = renderNotice(label, lang);
          if (redactText(rendered) !== rendered) throw new Error('message metadata redaction did not stabilize');
        }
        update.run(copy.body, copy.meta === null ? null : JSON.stringify(copy.meta), atts === null ? null : JSON.stringify(atts),
          copy.changed ? 1 : row.content_redacted ?? null, row.id!);
      }
    },
  },
  {
    version: 22,
    name: 'stored copies under the fail-closed quote rules',
    sql: '',
    after: rescanStoredCopies,
  },
  {
    version: 23,
    name: 'repair legacy partial copies and identify safe attachments',
    sql: '',
    after: repairLegacyStoredCopies,
  },
  {
    version: 24,
    name: 'repair encoded request headers in stored display copies',
    sql: '',
    after: repairLegacyStoredCopies,
  },
  {
    version: 25,
    name: 'chat members',
    // Chat members (runtime_kind 'chat') call a model provider with the user's own key. The agents CHECK is rebuilt with
    // the same columns and rows. Providers and models keep their v7 rows; `chat` = 1 marks a provider of the chat member
    // page (0 = a row left by the removed route: shown, needs its format and key again). config_json holds the
    // provider's preset, Vertex project / location and key hint, and per model the fields the user set by hand. The key
    // itself is never in the database (key_ref "env:NAME", "app" = encrypted in <dataDir>/secrets, or "none").
    // A chat member's conversation is its own: chat_sessions (one per member and chat; nativeSessionId = its id) and
    // chat_items (append-only; compaction moves from_seq instead of deleting).
    rebuildsReferencedTable: true,
    sql: `
      CREATE TABLE agents_v25 (
        id                     TEXT PRIMARY KEY,
        handle                 TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name           TEXT NOT NULL,
        runtime_kind           TEXT NOT NULL CHECK (runtime_kind IN ('mock','codex','claude','antigravity','dsh','opencode','chat')),
        is_mock                INTEGER NOT NULL CHECK (is_mock IN (0,1)),
        config_json            TEXT NOT NULL DEFAULT '{}',
        created_at             TEXT NOT NULL,
        deleted_at             TEXT,
        provider_id            TEXT,
        collab_mode            TEXT CHECK (collab_mode IN ('restricted','full')),
        collab_confirmed_at    TEXT,
        collab_warning_version TEXT,
        CHECK ((runtime_kind = 'antigravity') = (collab_mode IS NOT NULL))
      );
      INSERT INTO agents_v25 (id, handle, display_name, runtime_kind, is_mock, config_json, created_at, deleted_at, provider_id, collab_mode, collab_confirmed_at, collab_warning_version)
        SELECT id, handle, display_name, runtime_kind, is_mock, config_json, created_at, deleted_at, provider_id, collab_mode, collab_confirmed_at, collab_warning_version FROM agents;
      DROP TABLE agents;
      ALTER TABLE agents_v25 RENAME TO agents;
      ALTER TABLE providers ADD COLUMN chat INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE providers ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE provider_models ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}';
      CREATE TABLE chat_sessions (
        id          TEXT PRIMARY KEY,
        agent_id    TEXT NOT NULL,
        room_id     TEXT NOT NULL,
        from_seq    INTEGER NOT NULL DEFAULT 1,
        state_json  TEXT NOT NULL DEFAULT '{}',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX chat_sessions_agent ON chat_sessions(agent_id, room_id);
      CREATE TABLE chat_items (
        session_id  TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        seq         INTEGER NOT NULL,
        data_json   TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
    `,
  },
  {
    version: 26,
    name: 'member order and model provider avatars',
    // position: the member's place in the room's list, set when the user drags members (NULL = after the ordered ones,
    // in joining order). avatar_defaults also takes one picture per saved model provider ("chat:<provider id>").
    sql: `
      ALTER TABLE room_members ADD COLUMN position INTEGER;
      CREATE TABLE avatar_defaults_v26 (
        runtime_kind TEXT PRIMARY KEY CHECK (runtime_kind IN ('codex','claude','antigravity','dsh','opencode') OR runtime_kind LIKE 'chat:%'),
        avatar       TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
      INSERT INTO avatar_defaults_v26 (runtime_kind, avatar, updated_at) SELECT runtime_kind, avatar, updated_at FROM avatar_defaults;
      DROP TABLE avatar_defaults;
      ALTER TABLE avatar_defaults_v26 RENAME TO avatar_defaults;
    `,
  },
  {
    version: 27,
    name: 'cursor runtime',
    // Cursor (official ACP server, `cursor-agent acp`) as a runtime kind: the runtime_kind CHECKs are rebuilt with the
    // same columns and rows.
    rebuildsReferencedTable: true,
    sql: `
      CREATE TABLE agents_v27 (
        id                     TEXT PRIMARY KEY,
        handle                 TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name           TEXT NOT NULL,
        runtime_kind           TEXT NOT NULL CHECK (runtime_kind IN ('mock','codex','claude','antigravity','dsh','opencode','cursor','chat')),
        is_mock                INTEGER NOT NULL CHECK (is_mock IN (0,1)),
        config_json            TEXT NOT NULL DEFAULT '{}',
        created_at             TEXT NOT NULL,
        deleted_at             TEXT,
        provider_id            TEXT,
        collab_mode            TEXT CHECK (collab_mode IN ('restricted','full')),
        collab_confirmed_at    TEXT,
        collab_warning_version TEXT,
        CHECK ((runtime_kind = 'antigravity') = (collab_mode IS NOT NULL))
      );
      INSERT INTO agents_v27 (id, handle, display_name, runtime_kind, is_mock, config_json, created_at, deleted_at, provider_id, collab_mode, collab_confirmed_at, collab_warning_version)
        SELECT id, handle, display_name, runtime_kind, is_mock, config_json, created_at, deleted_at, provider_id, collab_mode, collab_confirmed_at, collab_warning_version FROM agents;
      DROP TABLE agents;
      ALTER TABLE agents_v27 RENAME TO agents;
      CREATE TABLE avatar_defaults_v27 (
        runtime_kind TEXT PRIMARY KEY CHECK (runtime_kind IN ('codex','claude','antigravity','dsh','opencode','cursor') OR runtime_kind LIKE 'chat:%'),
        avatar       TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
      INSERT INTO avatar_defaults_v27 (runtime_kind, avatar, updated_at) SELECT runtime_kind, avatar, updated_at FROM avatar_defaults;
      DROP TABLE avatar_defaults;
      ALTER TABLE avatar_defaults_v27 RENAME TO avatar_defaults;
    `,
  },
  {
    version: 28,
    name: 'grok runtime',
    // Grok Build (official ACP server, `grok agent stdio`) as a runtime kind: the runtime_kind CHECKs are rebuilt with
    // the same columns and rows.
    rebuildsReferencedTable: true,
    sql: `
      CREATE TABLE agents_v28 (
        id                     TEXT PRIMARY KEY,
        handle                 TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name           TEXT NOT NULL,
        runtime_kind           TEXT NOT NULL CHECK (runtime_kind IN ('mock','codex','claude','antigravity','dsh','opencode','cursor','grok','chat')),
        is_mock                INTEGER NOT NULL CHECK (is_mock IN (0,1)),
        config_json            TEXT NOT NULL DEFAULT '{}',
        created_at             TEXT NOT NULL,
        deleted_at             TEXT,
        provider_id            TEXT,
        collab_mode            TEXT CHECK (collab_mode IN ('restricted','full')),
        collab_confirmed_at    TEXT,
        collab_warning_version TEXT,
        CHECK ((runtime_kind = 'antigravity') = (collab_mode IS NOT NULL))
      );
      INSERT INTO agents_v28 (id, handle, display_name, runtime_kind, is_mock, config_json, created_at, deleted_at, provider_id, collab_mode, collab_confirmed_at, collab_warning_version)
        SELECT id, handle, display_name, runtime_kind, is_mock, config_json, created_at, deleted_at, provider_id, collab_mode, collab_confirmed_at, collab_warning_version FROM agents;
      DROP TABLE agents;
      ALTER TABLE agents_v28 RENAME TO agents;
      CREATE TABLE avatar_defaults_v28 (
        runtime_kind TEXT PRIMARY KEY CHECK (runtime_kind IN ('codex','claude','antigravity','dsh','opencode','cursor','grok') OR runtime_kind LIKE 'chat:%'),
        avatar       TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
      INSERT INTO avatar_defaults_v28 (runtime_kind, avatar, updated_at) SELECT runtime_kind, avatar, updated_at FROM avatar_defaults;
      DROP TABLE avatar_defaults;
      ALTER TABLE avatar_defaults_v28 RENAME TO avatar_defaults;
    `,
  },
];

/**
 * Applies the current redaction rules to every stored copy: task titles, attachment names, message bodies, display
 * metadata and the attachment lists inside messages. A database that ran an earlier migration kept what the rules of
 * that time missed, so each later change to the rules appends a migration that calls this again. Provenance only ever
 * gains a replacement (1); 0 and NULL stay as they were when nothing changes.
 */
export function rescanStoredCopies(db: DatabaseSync): void {
  const task = db.prepare('UPDATE tasks SET title = ?, title_redacted = 1 WHERE id = ?');
  for (const row of db.prepare('SELECT id, title FROM tasks').iterate()) {
    const raw = String(row.title), title = redactText(raw);
    if (title !== raw) task.run(title, row.id!);
  }
  const attachments = new Map<string, { name: string; redacted: boolean; uncertain: boolean }>();
  const attachment = db.prepare('UPDATE attachments SET name = ?, name_redacted = 1 WHERE id = ?');
  for (const row of db.prepare('SELECT id, name, mime, name_redacted FROM attachments').iterate()) {
    const raw = String(row.name), mime = String(row.mime);
    // A name redacted under older rules may still hold the rest of a secret: none of it is kept.
    const safe = row.name_redacted === 1 ? { name: replacementName(mime), redacted: true } : safeAttachmentName(raw, mime);
    if (safe.name !== raw) attachment.run(safe.name, row.id!);
    attachments.set(String(row.id), { name: safe.name, redacted: safe.redacted, uncertain: !safe.redacted && row.name_redacted === null });
  }
  const message = db.prepare('UPDATE messages SET body = ?, meta_json = ?, attachments_json = ?, content_redacted = 1 WHERE id = ?');
  const attachmentsOnly = db.prepare('UPDATE messages SET attachments_json = ? WHERE id = ?');
  for (const row of db.prepare('SELECT id, body, meta_json, attachments_json FROM messages').iterate()) {
    const meta = row.meta_json === null ? null : JSON.parse(String(row.meta_json)) as MessageMeta;
    const copy = redactMessageCopy(String(row.body), meta);
    const rawAtts = row.attachments_json === null ? null : String(row.attachments_json);
    const atts = rawAtts === null ? null : JSON.stringify((JSON.parse(rawAtts) as AttachmentInfo[]).map(a => {
      const { nameRedacted: _r, nameRedactionUncertain: _u, ...rest } = a;
      const stored = attachments.get(a.id);
      const safe = stored ?? (a.nameRedacted ? { name: replacementName(a.mime), redacted: true, uncertain: false }
        : { ...safeAttachmentName(a.name, a.mime), uncertain: !!a.nameRedactionUncertain });
      return { ...rest, name: safe.name, ...(safe.redacted ? { nameRedacted: true as const } : {}),
        ...(safe.uncertain ? { nameRedactionUncertain: true as const } : {}) };
    }));
    const label = copy.meta?.type === 'notice' ? copy.meta.notice
      : copy.meta?.type === 'activity' || copy.meta?.type === 'approval' ? copy.meta.label : null;
    if (label) for (const lang of ['zh', 'en'] as const) {
      const rendered = renderNotice(label, lang);
      if (redactText(rendered) !== rendered) throw new Error('message metadata redaction did not stabilize');
    }
    if (copy.changed) message.run(copy.body, copy.meta === null ? null : JSON.stringify(copy.meta), atts, row.id!);
    else if (atts !== rawAtts) attachmentsOnly.run(atts, row.id!);
  }
}


/** Migration 23: repair old partial copies, include delivery errors, and give safe attachment names stable identities. */
export function repairLegacyStoredCopies(db: DatabaseSync): void {
  const task = db.prepare('UPDATE tasks SET title = ?, title_redacted = 1 WHERE id = ?');
  for (const row of db.prepare('SELECT id, title FROM tasks').iterate()) {
    const raw = String(row.title), title = redactLegacyText(raw);
    if (title !== raw) task.run(title, row.id!);
  }

  const attachments = new Map<string, { name: string; redacted: boolean; uncertain: boolean }>();
  const attachment = db.prepare('UPDATE attachments SET name = ?, name_redacted = 1 WHERE id = ?');
  for (const row of db.prepare('SELECT id, name, mime, name_redacted FROM attachments').iterate()) {
    const id = String(row.id), raw = String(row.name), mime = String(row.mime);
    const safe = row.name_redacted === 1 || hasLegacySecretMarker(raw)
      ? { name: replacementName(mime, id), redacted: true }
      : safeAttachmentName(raw, mime, id);
    if (safe.name !== raw) attachment.run(safe.name, row.id!);
    attachments.set(id, { name: safe.name, redacted: safe.redacted, uncertain: !safe.redacted && row.name_redacted === null });
  }

  const message = db.prepare('UPDATE messages SET body = ?, meta_json = ?, attachments_json = ?, content_redacted = 1 WHERE id = ?');
  const attachmentsOnly = db.prepare('UPDATE messages SET attachments_json = ? WHERE id = ?');
  for (const row of db.prepare('SELECT id, body, meta_json, attachments_json FROM messages').iterate()) {
    const meta = row.meta_json === null ? null : JSON.parse(String(row.meta_json)) as MessageMeta;
    const copy = redactLegacyMessageCopy(String(row.body), meta);
    const rawAtts = row.attachments_json === null ? null : String(row.attachments_json);
    const atts = rawAtts === null ? null : JSON.stringify((JSON.parse(rawAtts) as AttachmentInfo[]).map(a => {
      const { nameRedacted: _r, nameRedactionUncertain: _u, ...rest } = a;
      const stored = attachments.get(a.id);
      const safe = stored ?? (a.nameRedacted || hasLegacySecretMarker(a.name)
        ? { name: replacementName(a.mime, a.id), redacted: true, uncertain: false }
        : { ...safeAttachmentName(a.name, a.mime, a.id), uncertain: !!a.nameRedactionUncertain });
      return { ...rest, name: safe.name, ...(safe.redacted ? { nameRedacted: true as const } : {}),
        ...(safe.uncertain ? { nameRedactionUncertain: true as const } : {}) };
    }));
    if (copy.changed) message.run(copy.body, copy.meta === null ? null : JSON.stringify(copy.meta), atts, row.id!);
    else if (atts !== rawAtts) attachmentsOnly.run(atts, row.id!);
  }

  const delivery = db.prepare('UPDATE deliveries SET error = ? WHERE id = ?');
  for (const row of db.prepare('SELECT id, error FROM deliveries WHERE error IS NOT NULL').iterate()) {
    const raw = String(row.error);
    let source: Localized = raw;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isNotice(parsed)) source = parsed;
    } catch { /* A plain error may start with a brace without being a serialized NoticeText. */ }
    const safe = redactLegacyLocalized(source);
    const value = typeof safe.value === 'string' ? safe.value : JSON.stringify(safe.value);
    if (safe.changed) delivery.run(value, row.id!);
  }
}

export function openDatabase(file: string): DatabaseSync {
  const db = openRaw(file);
  try {
    migrate(db);
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}

function openRaw(file: string): DatabaseSync {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

export const LATEST_SCHEMA_VERSION = Math.max(...MIGRATIONS.map((m) => m.version));

/** Highest applied schema version (0 = empty / new database). */
export function schemaVersion(db: DatabaseSync): number {
  const t = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!t) return 0;
  const r = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  return r.v ?? 0;
}

export interface PreparedDatabase {
  db: DatabaseSync;
  /** Backup written before anything was changed (null for a new database). */
  backupFile: string | null;
  fromVersion: number;
  migrated: number[];
}

/**
 * Opens the app database for a Core start:
 * - refuses a database written by a newer Harness Team (no silent downgrade);
 * - copies an existing database into `backupDir` (consistent online backup) before migrating or using it; every
 *   start gets its own file and never overwrites an earlier backup, and a failed backup stops the start before
 *   any migration;
 * - keeps the newest `keepBackups` copies.
 */
export async function prepareDatabase(
  file: string,
  opts: { backupDir: string; keepBackups?: number; now?: Date },
): Promise<PreparedDatabase> {
  const existed = existsSync(file);
  const db = openRaw(file);
  try {
    const fromVersion = schemaVersion(db);
    if (fromVersion > LATEST_SCHEMA_VERSION) {
      throw new NoticeError(
        L(
          '数据库 {file} 的结构版本为 {from}，高于本程序支持的 {latest}（由更新版本的 Harness Team 写入）。为避免数据损坏，本程序不会打开它；请使用更新的版本，或换一个数据目录。',
          'The database {file} has schema version {from}, newer than the {latest} this program supports (a newer Harness Team wrote it). To avoid damaging it, it is not opened; use a newer version or another data folder.',
          { file, from: fromVersion, latest: LATEST_SCHEMA_VERSION },
        ),
      );
    }
    let backupFile: string | null = null;
    if (existed && fromVersion > 0) {
      const prefix = basename(file, '.sqlite');
      const stamp = (opts.now ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
      const pending = fromVersion < LATEST_SCHEMA_VERSION ? `-before-v${LATEST_SCHEMA_VERSION}` : '';
      try {
        backupFile = await writeBackup(db, opts.backupDir, prefix, fromVersion, (seq) =>
          `${prefix}-${stamp}${seq > 1 ? `-${seq}` : ''}-v${fromVersion}${pending}.sqlite`,
        );
      } catch (e) {
        throw new NoticeError(
          L('启动前备份数据库失败，已停止启动（数据库未迁移、未修改）：{error}', 'Backing up the database before starting failed, so startup stopped (the database was not migrated or changed): {error}', {
            error: errorNotice(e),
          }),
        );
      }
      pruneBackups(opts.backupDir, prefix, opts.keepBackups ?? 10);
    }
    const migrated = migrate(db);
    return { db, backupFile, fromVersion, migrated };
  } catch (e) {
    db.close();
    throw e;
  }
}

/**
 * Backs up into a private temp file, checks that the copy opens, passes `quick_check` and has the expected schema
 * version, then moves it to the first free name (`name(1)`, `name(2)`, …). Each name is claimed with an exclusive
 * create before the move, so an existing backup (for example one from an earlier start in the same second) is
 * never replaced.
 */
async function writeBackup(db: DatabaseSync, dir: string, prefix: string, version: number, name: (seq: number) => string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${prefix}-${process.pid}-${randomUUID()}.partial`);
  try {
    await backup(db, tmp);
    const copy = new DatabaseSync(tmp);
    try {
      // The copy inherits WAL mode; a standalone restore point should be one self-contained file that opening it
      // (even read-only) does not surround with -wal/-shm files.
      copy.exec('PRAGMA journal_mode = DELETE;');
      const check = copy.prepare('PRAGMA quick_check').get() as Record<string, unknown>;
      if (Object.values(check)[0] !== 'ok') throw new NoticeError(L('备份副本校验失败：{check}', 'The backup copy failed its check: {check}', { check: JSON.stringify(check) }));
      const v = schemaVersion(copy);
      if (v !== version) throw new NoticeError(L('备份副本的结构版本为 {v}，应为 {version}', 'The backup copy has schema version {v}; it should be {version}', { v, version }));
    } finally {
      copy.close();
    }
    for (let seq = 1; seq <= 1000; seq++) {
      const target = join(dir, name(seq));
      try {
        closeSync(openSync(target, 'wx'));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw e;
      }
      try {
        renameSync(tmp, target); // replaces only the empty placeholder this call just created
      } catch (e) {
        try {
          unlinkSync(target);
        } catch {
          // ignore
        }
        throw e;
      }
      return target;
    }
    throw new NoticeError(L('备份目录 {dir} 中同一时间戳的备份过多', 'Too many backups with the same timestamp in {dir}', { dir }));
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // moved into place, or never created
    }
  }
}

// `<prefix>-YYYYMMDD-HHMMSS[-N]-v…`: the start time and the sequence number within that second.
function backupKey(prefix: string, f: string): [string, number] {
  const m = f.slice(prefix.length + 1).match(/^(\d{8}-\d{6})(?:-(\d+))?-v/);
  return m ? [m[1]!, Number(m[2] ?? 1)] : ['', 0];
}

function pruneBackups(dir: string, prefix: string, keep: number) {
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(prefix + '-') && f.endsWith('.sqlite'))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs, k: backupKey(prefix, f) }))
    // Newest first: by write time, then by the name's timestamp and sequence (several backups can share a second).
    .sort((a, b) => b.t - a.t || (a.k[0] < b.k[0] ? 1 : a.k[0] > b.k[0] ? -1 : b.k[1] - a.k[1]));
  for (const { f } of files.slice(Math.max(keep, 1))) {
    try {
      unlinkSync(join(dir, f));
    } catch {
      // a backup we cannot delete is harmless
    }
  }
}

export function migrate(db: DatabaseSync): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    applied_at  TEXT NOT NULL
  );`);
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version),
  );
  const newlyApplied: number[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    // PRAGMA foreign_keys has no effect inside a transaction: switch it around the transaction.
    const fk = m.rebuildsReferencedTable && Number((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys) === 1;
    if (fk) db.exec('PRAGMA foreign_keys = OFF');
    // BEGIN itself can fail (database locked): foreign keys are switched back on all the same.
    let began = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      began = true;
      db.exec(m.sql);
      m.after?.(db);
      if (m.rebuildsReferencedTable) {
        const broken = db.prepare('PRAGMA foreign_key_check').all();
        if (broken.length) throw new Error(`migration ${m.version} left ${broken.length} broken foreign key reference(s)`);
      }
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
      newlyApplied.push(m.version);
    } catch (err) {
      if (began && db.isTransaction) db.exec('ROLLBACK');
      throw err;
    } finally {
      if (fk) db.exec('PRAGMA foreign_keys = ON');
    }
  }
  return newlyApplied;
}
