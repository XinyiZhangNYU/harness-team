import type { Localized, NoticeText } from './notices.ts';

export type { Localized, NoticeText } from './notices.ts';
// Shared wire types between the Core (server) and the Web UI.
// Keep this file free of runtime dependencies so both sides can import it.

/** `chat` = a chat member: Harness Team calls a model API with the user's own key (no external harness). */
export type RuntimeKind = 'mock' | 'codex' | 'claude' | 'antigravity' | 'dsh' | 'opencode' | 'cursor' | 'grok' | 'kimi' | 'chat';

/**
 * How far other members may orchestrate an Antigravity member (an automatic-orchestration permission, not an auth or
 * billing type). restricted = only the local user wakes it, and its Team MCP is read-only; full = the same automatic
 * collaboration as Claude Code / Codex (queue, pause, relay limit). Native approvals always stay with the user.
 */
export type CollabMode = 'restricted' | 'full';
/**
 * Version of the full-mode risk warning. Enabling full mode must send this exact value (the user ticked the box under
 * this text); a new text gets a new version, so an old confirmation does not carry over.
 */
export const COLLAB_WARNING_VERSION = 'ag-full-2026-11-07';
/** Antigravity terms page linked from the warning. */
export const ANTIGRAVITY_TERMS_URL = 'https://antigravity.google/terms';

export type SenderKind = 'user' | 'agent' | 'system';

/** chat = normal message; activity = tool/runtime activity; approval = native approval request; system = notices. */
export type MessageKind = 'chat' | 'activity' | 'approval' | 'system';

export type MessageStatus = 'streaming' | 'complete' | 'failed' | 'interrupted';

/** waiting = has queued work but another agent is using the same workspace directory. */
export type AgentStatus = 'idle' | 'working' | 'waiting' | 'offline' | 'error';

/**
 * Language Harness Team uses with the agents of a room: the framing it adds around messages, the standing rules, the
 * Team tool descriptions, and the closing "reply in …" line. The agents' replies follow it; the UI language is separate.
 */
export type AgentLanguage = 'zh' | 'en';

export interface Room {
  id: string;
  name: string;
  createdAt: string;
  /** Agent-to-agent pushes are held (not dispatched) while paused. User messages are still delivered. */
  autoPaused: boolean;
  /**
   * Max consecutive agent-to-agent hops since the last user message before pushes are skipped; null = no limit
   * (the default for new rooms; pausing still stops the relay).
   */
  autoHopLimit: number | null;
  /** Project folder the room is grouped under in the sidebar (display only; members keep their own workspaces). */
  projectDir: string | null;
  /** Shown first in its group. */
  pinned: boolean;
  /** Moved to the archived section of the sidebar. Display only: the room keeps working. */
  archived: boolean;
  /** Takes effect from each member's next turn. */
  agentLanguage: AgentLanguage;
  /**
   * Agent members (ids, joining order) that a user message without any @mention goes to. Empty: such a message goes
   * to the member that last posted a chat message in the room; with no such member it wakes nobody.
   */
  defaultResponders: string[];
}

export interface RoomPatch {
  /** 1-80 characters after trimming. */
  name?: string;
  autoPaused?: boolean;
  autoHopLimit?: number | null;
  /** null = not grouped under a project. */
  projectDir?: string | null;
  pinned?: boolean;
  archived?: boolean;
  agentLanguage?: AgentLanguage;
}

export type TaskStatus = 'todo' | 'doing' | 'done';

/** Token counts summed over turns. Disjoint: total = input + cacheRead + cacheWrite + output (reasoning is part of output). */
export interface UsageTotals {
  /** Member turns that reported usage. */
  turns: number;
  /** Of those, the turns that reported token counts (the others reported only a cost: their tokens are unknown). */
  tokenTurns: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  /**
   * Estimated cost at API list prices: Claude Code's own estimate, plus Codex / Antigravity tokens priced from the
   * built-in list-price table (server/src/pricing.ts). null when nothing in the group could be priced.
   */
  costUsd: number | null;
  /** Some turns in the group used a model without a price, so costUsd leaves them out. */
  costPartial: boolean;
}

export interface UsageGroup extends UsageTotals {
  /** Project folder, model id, agent id or local date (YYYY-MM-DD); null = unknown. */
  key: string | null;
  /** Display text where the key alone is not readable (agents: "@handle"). */
  label?: string;
  /** byModel: the runtime that reported the model. */
  runtimeKind?: string;
}

/** Only turns run by members inside Harness Team; usage from the CLIs used elsewhere is not counted. */
export interface UsageSummary {
  from: string | null;
  to: string | null;
  totals: UsageTotals;
  byProject: UsageGroup[];
  byModel: UsageGroup[];
  byAgent: UsageGroup[];
  /** Local calendar days, oldest first; days without usage are omitted. */
  byDay: UsageGroup[];
}

/**
 * Share of the prompt (all input tokens) that was read from the runtime's cache: cacheRead ÷ (input + cacheRead +
 * cacheWrite). null when there was no input at all.
 */
export const cacheHitRate = (u: Pick<UsageTotals, 'input' | 'cacheRead' | 'cacheWrite'>): number | null => {
  const prompt = u.input + u.cacheRead + u.cacheWrite;
  return prompt > 0 ? u.cacheRead / prompt : null;
};

export const usageTotal =(u: Pick<UsageTotals, 'input' | 'cacheRead' | 'cacheWrite' | 'output'>): number =>
  u.input + u.cacheRead + u.cacheWrite + u.output;

export interface Task {
  id: number;
  roomId: string;
  title: string;
  /** This stored title replaced source content; omitted on unchanged data. */
  titleRedacted?: true;
  /** A pre-provenance row contains a replacement marker of unknown origin. */
  titleRedactionUncertain?: true;
  status: TaskStatus;
  /** Agent id of the assignee, or null when unassigned. */
  assigneeId: string | null;
  /** 'user' or the creating agent's id. Assigned by the Core from the trusted identity, never by the caller. */
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Delivery of one message to one agent. Stages are recorded separately: stored (message row) → queued/held →
 * dispatched (sent to the runtime) → accepted (runtime confirmed the native turn) → replied (first output observed)
 * → completed / interrupted / failed. `unknown` = the Core stopped after dispatch; never re-run automatically.
 * `skipped` = not delivered because the room's automatic hop budget was used up.
 */
export type DeliveryState =
  | 'queued'
  | 'held'
  | 'skipped'
  | 'dispatched'
  | 'accepted'
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'unknown';

export interface DeliveryInfo {
  id: string;
  roomId: string;
  messageId: string;
  agentId: string;
  state: DeliveryState;
  /** user = the source message came from the user; agent = from another agent (automatic push). */
  origin: 'user' | 'agent';
  /** Agent-to-agent hops since the last user message (0 for user messages). */
  hop: number;
  replyMessageId: string | null;
  /** Why it was not delivered (Chinese, or the runtime's own text). */
  error: string | null;
  /** The same reason in both languages, when the server wrote it that way. */
  errorNotice?: NoticeText | null;
  createdAt: string;
  dispatchedAt: string | null;
  acceptedAt: string | null;
  repliedAt: string | null;
  finishedAt: string | null;
}

export interface Agent {
  id: string;
  handle: string;
  displayName: string;
  runtimeKind: RuntimeKind;
  /** True when the agent is backed by a mock/simulated runtime. Never hide this in the UI. */
  isMock: boolean;
  /** Absolute working directory the native runtime operates in (required by real coding runtimes). */
  workspace: string | null;
  /**
   * Native model id chosen for this agent (Codex `model/list` id, or the value given to Claude Code `--model`).
   * null = follow the runtime's own default configuration. Absent in rows written before Phase 5 → null.
   */
  model: string | null;
  /** Native effort level (Codex reasoning effort / Claude Code `--effort`). null = the runtime's default for the model. */
  effort: string | null;
  /**
   * Native permission mode chosen for this agent (see PERMISSION_MODES). null = follow the user's own Claude Code /
   * Codex configuration (no flag or override is sent; the only behaviour before this setting existed).
   */
  permissionMode: PermissionMode | null;
  createdAt: string;
  /** Set when the agent was deleted: it is in no room any more and is kept only so its old messages keep an author. */
  deletedAt: string | null;
  /**
   * Chat members: the model provider (ChatProvider.id) the member calls, with `model` as the model id there. Any other
   * runtime: set only for members created on the removed model-provider route (Claude Code with an API / plan key,
   * schema v7–16), which no longer run.
   */
  providerId: string | null;
  /** Chat members only (null for other runtimes): see ChatMemberSettings. */
  chat: ChatMemberSettings | null;
  /**
   * Picture chosen by the user for this member, as a small data URL (see AGENT_AVATAR_RE). Display only in this app:
   * it is never sent to Claude Code or Codex. null = the runtime's letter mark ("CC" / "Cx").
   */
  avatar: string | null;
  /** Antigravity only (null for other runtimes): see CollabMode. Enforced by the Core. */
  collabMode: CollabMode | null;
  /** When the user last confirmed the full-mode warning, and which version of it (null = never). */
  collabConfirmedAt: string | null;
  collabWarningVersion: string | null;
  /**
   * How the runtime itself last reported this member's own login is billed (null = not reported yet). Shown instead
   * of the detection when they differ, e.g. an API key from a settings file detection does not see.
   */
  billingSeen: RuntimeBilling | null;
  /** Language this member is spoken to and replies in; null = the room's (Room.agentLanguage). */
  language: AgentLanguage | null;
}

/** A member avatar: a base64 WebP / PNG / JPEG data URL, as the page makes it (128 px square). */
export const AGENT_AVATAR_RE = /^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;
/** Upper bound on the stored data URL; a 128 px WebP is a few KB, a PNG of a photo stays well under this. */
export const AGENT_AVATAR_MAX = 120_000;
export const isAgentAvatar = (v: unknown): v is string => typeof v === 'string' && v.length <= AGENT_AVATAR_MAX && AGENT_AVATAR_RE.test(v);

/** Runtimes that can have a default member avatar: shown for that runtime's members without a picture of their own. */
export const AVATAR_DEFAULT_KINDS = ['claude', 'codex', 'antigravity', 'dsh', 'opencode', 'cursor', 'grok', 'kimi'] as const;
export type AvatarDefaultKind = (typeof AVATAR_DEFAULT_KINDS)[number];
/** Chat members take their default avatar per saved model provider: `chat:<ChatProvider.id>`. */
export type AvatarDefaultKey = AvatarDefaultKind | `chat:${string}`;
/** Default avatar per runtime or model provider (data URLs, see AGENT_AVATAR_RE); a missing key = the letter mark. Display only. */
export type AvatarDefaults = Partial<Record<AvatarDefaultKey, string>>;
export const isAvatarDefaultKind = (v: unknown): v is AvatarDefaultKind => (AVATAR_DEFAULT_KINDS as readonly unknown[]).includes(v);
export const chatAvatarKey = (providerId: string): AvatarDefaultKey => `chat:${providerId}`;
export const isAvatarDefaultKey = (v: unknown): v is AvatarDefaultKey =>
  isAvatarDefaultKind(v) || (typeof v === 'string' && /^chat:[A-Za-z0-9_-]{1,64}$/.test(v));
/** Which default avatar a member shows without a picture of its own (null = none can be set: mock members). */
export function avatarDefaultKey(agent: { runtimeKind: string; providerId?: string | null }): AvatarDefaultKey | null {
  if (agent.runtimeKind === 'chat') return agent.providerId ? chatAvatarKey(agent.providerId) : null;
  return isAvatarDefaultKind(agent.runtimeKind) ? agent.runtimeKind : null;
}

/** How a harness's own login is billed: its plan (subscription) or per token (API key, cloud provider). */
export type RuntimeBilling = 'subscription' | 'metered_api';
/**
 * Permission modes a member can be given: every mode the runtime itself offers.
 * - Claude Code: `--permission-mode` (manual is the CLI's name for "default").
 * - Codex: sandbox + approval policy + approvals reviewer, as the presets of Codex's own permission menu (auto-review
 *   routes approvals to Codex's own reviewer subagent; full-access is danger-full-access with approval policy never).
 * - Antigravity: the ACP session mode (`mode` config option / session/set_mode), and skip-permissions, which starts
 *   that member's `agy acp` process with `--dangerously-skip-permissions` (the session mode then follows agy).
 * - DeepSeek Harness (dsh): its permission preset, which `dsh --profile acp` reads from DSH_PERMISSION_MODE when that
 *   member's process starts (read-only / workspace-write / danger-full-access; dsh's ACP server has no session modes).
 * - OpenCode: its ACP session mode (`mode` config option): build, or plan (read-only). For "follow my settings" nothing
 *   is sent and OpenCode's own permission rules apply.
 * - Cursor: its ACP session mode: agent (tools still ask through session/request_permission), plan (read-only
 *   planning) or ask (read-only Q&A). Offered only when `agent acp` reports them.
 * - Kimi Code: its ACP session mode: default (asks before edits and commands), plan (read-only planning), auto
 *   (Kimi approves what it considers safe and asks for the rest) or yolo (approves everything). Offered only when
 *   `kimi acp` reports them.
 * - Chat members: Harness Team runs their tools itself and asks itself: read-only (the read tools at most; also when
 *   nothing is chosen), manual (every file write and command asks), acceptEdits (file writes inside the project run,
 *   commands ask) or full-access (nothing asks, no sandbox). Writes and commands need the chat's project folder.
 * Whether this machine allows a mode (local settings, managed requirements, what the runtime reports) is in
 * RuntimeModelCatalog.permissionModes.
 * The modes in RISKY_PERMISSION_MODES run tools without any approval and need the user's confirmation of
 * PERMISSION_WARNING_VERSION when chosen.
 */
export type ClaudePermissionMode = 'manual' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';
export type CodexPermissionMode = 'read-only' | 'workspace-write' | 'untrusted' | 'auto-review' | 'full-access';
export type AntigravityPermissionMode = 'default' | 'accept-edits' | 'plan' | 'skip-permissions';
export type OpenCodePermissionMode = 'build' | 'plan';
export type CursorPermissionMode = 'agent' | 'plan' | 'ask';
export type KimiPermissionMode = 'default' | 'plan' | 'auto' | 'yolo';
export type ChatPermissionMode = 'read-only' | 'manual' | 'acceptEdits' | 'full-access';
export type PermissionMode =
  | ClaudePermissionMode
  | CodexPermissionMode
  | AntigravityPermissionMode
  | OpenCodePermissionMode
  | CursorPermissionMode
  | KimiPermissionMode
  | ChatPermissionMode;
export const PERMISSION_MODES: Record<RuntimeKind, readonly PermissionMode[]> = {
  claude: ['manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'],
  codex: ['read-only', 'workspace-write', 'untrusted', 'auto-review', 'full-access'],
  antigravity: ['default', 'accept-edits', 'plan', 'skip-permissions'],
  dsh: ['read-only', 'workspace-write', 'full-access'],
  opencode: ['build', 'plan'],
  cursor: ['agent', 'plan', 'ask'],
  // `grok agent stdio` reports no session modes and ignores plan: Grok's own permission setting applies.
  grok: [],
  kimi: ['default', 'plan', 'auto', 'yolo'],
  mock: [],
  chat: ['read-only', 'manual', 'acceptEdits', 'full-access'],
};
/** Modes in which nothing asks for approval at all. Choosing one needs `acknowledgePermissionRisk`. */
export const RISKY_PERMISSION_MODES: readonly PermissionMode[] = ['bypassPermissions', 'full-access', 'skip-permissions', 'yolo'];
/** Version of the warning shown before a risky mode is chosen; a new text gets a new version. */
export const PERMISSION_WARNING_VERSION = 'perm-skip-2026-11-08';

/** The permission mode the native runtime itself last reported for this agent. */
export interface AgentPermissionReport {
  /** As the runtime reports it, e.g. "default" (Claude Code) or "workspaceWrite · on-request" (Codex). */
  native: string;
  /** The reported mode as one of PERMISSION_MODES, when it is one of them. */
  mode: PermissionMode | null;
  source: Localized;
  reportedAt: string;
  /** Set when the runtime reported something other than the mode chosen for the agent. */
  mismatch?: Localized | null;
  /** Set when the mode in effect runs tools without asking you (bypass / full access / never ask) or denies silently. */
  risky?: Localized | null;
}

/** What the native runtime itself last reported as in effect for this agent (not what was requested). */
export interface AgentEffectiveConfig {
  model: string | null;
  effort: string | null;
  /** Where it came from, e.g. "Codex thread/start 响应" or "Claude Code get_settings.applied". */
  source: Localized;
  reportedAt: string;
  /** Set when the runtime reported something different from what the agent is configured for. */
  mismatch?: Localized | null;
}

export interface AgentWithStatus extends Agent {
  status: AgentStatus;
  /** Latest config reported by the native runtime in this server run; null until a session reported it. */
  effective?: AgentEffectiveConfig | null;
  /** Permission mode the native runtime last reported in this server run; null until a session reported it. */
  permission?: AgentPermissionReport | null;
  /** True when a saved model/effort/permission change waits for the current turn to end before it is applied. */
  configPending?: boolean;
  /** How this member is billed: the harness's own login as detected or reported (null = unknown). */
  billing?: RuntimeBilling | null;
}

/** One model the native runtime offers, as discovered from the runtime itself (never a hardcoded list). */
export interface RuntimeModelOption {
  /** Native id passed back to the runtime (Codex model id / Claude Code `--model` value). */
  id: string;
  displayName: string;
  description?: Localized | null;
  /** Full model the runtime resolves an alias to (Claude Code), when reported. */
  resolvedModel?: string | null;
  /** Effort levels this model supports, as reported by the runtime. Empty = effort cannot be chosen. */
  efforts: string[];
  /** The runtime's default effort for this model, when reported. */
  defaultEffort: string | null;
  /** The runtime's own default model. */
  isDefault: boolean;
  /** How this model is billed when the runtime's model id tells (absent = the runtime's billing). */
  billing?: RuntimeBilling | null;
}

/** Where a recent workspace was found: Codex threads, Claude Code session logs, or existing Harness Team members. */
export type WorkspaceSource = 'codex' | 'claude' | 'harness';

export interface RecentWorkspace {
  /** Absolute directory that exists right now. */
  path: string;
  /** Last path segment, for display. */
  name: string;
  sources: WorkspaceSource[];
  /** Last use reported by any source (ISO), when known. */
  lastUsedAt: string | null;
}

export interface RecentWorkspacesResponse {
  workspaces: RecentWorkspace[];
  /** Sources that could not be read (Chinese). The list from the other sources is still returned. */
  errors: { source: WorkspaceSource; message: Localized }[];
}

export type DirPlaceId = 'home' | 'desktop' | 'oneDriveDesktop' | 'documents' | 'downloads';

/** One level of the in-app folder browser. Directory names only. */
export interface DirListing {
  /** null = the starting level (drives on Windows, `/` elsewhere). */
  path: string | null;
  /** null = go back to the starting level. */
  parent: string | null;
  /** `git`: the folder has a `.git` entry (a repository or worktree root). */
  dirs: { name: string; path: string; git?: boolean }[];
  /** Shortcuts such as the home, Desktop, Documents and Downloads folders that exist. `id` lets the UI translate. */
  places: { id: DirPlaceId; label: string; path: string }[];
  /** More subdirectories exist than were returned. */
  truncated: boolean;
}

export interface RuntimeModelCatalog {
  runtimeKind: RuntimeKind;
  /** True when the list came from the runtime; false = discovery failed or the runtime has no model choice. */
  available: boolean;
  /** How the list was obtained, e.g. "codex app-server model/list". */
  source: Localized;
  /** Reason when unavailable. Creating with the default configuration is still possible. */
  error: Localized | null;
  models: RuntimeModelOption[];
  /** What "跟随默认配置" resolves to right now, when the runtime reports it. */
  nativeDefault: { model: string | null; effort: string | null; efforts: string[]; note?: Localized | null } | null;
  /**
   * Whether each of PERMISSION_MODES[runtimeKind] can be used on this machine (for the catalog's folder), as the
   * runtime itself reports it. Omitted when it could not be checked: every mode is then offered and the runtime's own
   * report at the start of a turn decides.
   */
  permissionModes?: PermissionModeAvailability[];
  fetchedAt: string;
}

export interface PermissionModeAvailability {
  id: PermissionMode;
  available: boolean;
  /** Why it is not available (what turned it off), when available is false. */
  reason: Localized | null;
}

/**
 * Effort a Codex turn runs with when the model is chosen explicitly and effort is left at "Default": the configured
 * (native default) effort when this model supports it, else the model's own default. Shared by the Core and the UI label.
 */
export function codexImplicitEffort(entry: Pick<RuntimeModelOption, 'efforts' | 'defaultEffort'>, configured: string | null | undefined): string | null {
  return configured && entry.efforts.includes(configured) ? configured : entry.defaultEffort;
}

/** A file the local user attached to a message. The bytes stay in the app's data directory, never in a workspace. */
export interface AttachmentInfo {
  id: string;
  /** Safe display and on-disk name; the original name is not retained. */
  name: string;
  nameRedacted?: true;
  nameRedactionUncertain?: true;
  /**
   * Images: detected from the file's own bytes. Other files: `application/pdf` only when the bytes say so, otherwise
   * a type from the extension (display only; such files are always served as downloads). Never taken from the client.
   */
  mime: string;
  kind: 'image' | 'file';
  size: number;
}

/** Image types sent to the runtimes as images (decided by file signature; SVG is never treated as an image). */
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export const ATTACHMENT_LIMITS = {
  perMessage: 10,
  imageBytes: 5 * 1024 * 1024,
  fileBytes: 20 * 1024 * 1024,
  roomBytes: 1024 * 1024 * 1024,
} as const;

export interface Message {
  id: string;
  roomId: string;
  /** Per-room monotonically increasing order assigned by the Core. */
  seq: number;
  kind: MessageKind;
  senderKind: SenderKind;
  /** Agent id for agent messages, 'user' for the local user, 'system' for Core notices. Assigned by the Core, never by clients. */
  senderId: string;
  body: string;
  /** The stored body or display metadata replaced source content. */
  contentRedacted?: true;
  /** A pre-provenance row contains a replacement marker of unknown origin. */
  redactionUncertain?: true;
  status: MessageStatus;
  mentions: string[];
  replyTo: string | null;
  /** Structured details for activity/approval messages (and native ids for chat items). Set by the Core only. */
  meta: MessageMeta | null;
  /** Files the local user attached (images only for now). Absent when there are none. */
  attachments?: AttachmentInfo[];
  createdAt: string;
  updatedAt: string;
}

export type ActivityKind = 'command' | 'fileChange' | 'mcpToolCall' | 'webSearch' | 'plan' | 'notice' | 'reasoning' | 'other';

/**
 * One file an agent's edit tool changed, as the runtime reported it (Codex: its own unified diff; Claude Code: the
 * Edit/Write tool input, so `diff` holds the replaced and new text as -/+ lines without line numbers). Changes made by
 * shell commands are not included: the runtimes do not report them.
 */
export interface FileChange {
  /** Relative to the agent's workspace when inside it. */
  path: string;
  change: 'add' | 'update' | 'delete' | 'edit' | 'write';
  diff: string;
  /** The diff was cut to keep the message small. */
  truncated?: boolean;
}

/**
 * `restore` = bring the archived session back and continue in it, `retry` = try to resume again, `new` = start a new
 * native session (the old one's context is gone). Messages to that member wait until the user picks one.
 */
export type SessionChoiceOption = 'restore' | 'retry' | 'new';
export interface SessionChoice {
  agentId: string;
  nativeSessionId: string;
  reason: 'archived' | 'missing' | 'other';
  options: SessionChoiceOption[];
  state: 'pending' | SessionChoiceOption;
}

/** Where native items/requests came from. `nativeItemId`/`nativeRequestId` are the runtime's own ids. */
export type MessageMeta =
  /**
   * A slash command the local user sent to one member (`@handle /name args`, the whole message). Run through the
   * runtime's own protocol method; never sent as chat text, never part of other members' context, never relayed.
   * `@all /compact` is one such message delivered to every member whose runtime has `/compact`; its agentId is
   * ALL_HANDLE.
   */
  | { type: 'command'; agentId: string; name: string; args: string; skill?: true }
  /** System notice written by the server: `notice` is the translatable form of the body. */
  | {
      type: 'notice';
      notice: NoticeText;
      /** A member's stored session could not be resumed: the user decides what happens (see `Core.chooseSession`). */
      sessionChoice?: SessionChoice;
      /** A member's reply that ended as a notice (failed, no text): how the member was billed then. */
      billing?: RuntimeBilling | null;
    }
  | {
      type: 'chat';
      runtime: RuntimeKind;
      nativeTurnId?: string;
      nativeItemId?: string;
      phase?: string | null;
      /** Set when the agent posted this through the Team MCP `send_message` tool (not its turn reply). */
      via?: 'team_mcp';
      intent?: MessageIntent | null;
      /** How the member was billed when it wrote this (absent on older messages: its current billing is shown). */
      billing?: RuntimeBilling | null;
    }
  | {
      type: 'activity';
      runtime: RuntimeKind;
      nativeTurnId?: string;
      nativeItemId: string;
      activity: ActivityKind;
      /** One-line summary, e.g. the command line or "修改 2 个文件". */
      title: string;
      /** Longer details (command output tail, diff), shown collapsed. */
      detail?: string | null;
      /** Runtime's own status string, e.g. inProgress / completed / failed / declined. */
      nativeStatus?: string | null;
      /** fileChange only: the files and their diffs (absent on older messages). */
      files?: FileChange[];
      /** `title` as a translatable text (absent on older messages and for raw command lines). */
      label?: NoticeText;
    }
  | {
      type: 'approval';
      runtime: RuntimeKind;
      nativeTurnId?: string;
      nativeItemId?: string | null;
      /** JSON-RPC id of the runtime's server request; the decision must be sent back on this exact id. */
      nativeRequestId: string;
      /** Native method, e.g. item/commandExecution/requestApproval. */
      nativeMethod: string;
      title: string;
      detail?: string | null;
      /**
       * pending → waiting for a human; resolved → answered (by the user in the group, or the runtime's own lifecycle);
       * cancelled → the turn ended / was interrupted / the process restarted first (never approved).
       */
      state: 'pending' | 'resolved' | 'cancelled';
      /** Native decision value sent back (e.g. accept, decline, allow, deny) or reported by the runtime. */
      decision?: string | null;
      /** Decisions the user may choose while pending (Phase 5). Absent on older messages: not answerable. */
      options?: ApprovalDecision[];
      /** Set when the local user decided in the group chat. */
      decidedBy?: 'user' | null;
      userDecision?: ApprovalDecision | null;
      decidedAt?: string | null;
      /** Working directory of the agent that asked (scope shown on the card). */
      workspace?: string | null;
      /** `title` as a translatable text (absent on older messages). */
      label?: NoticeText;
      /** The runtime's own reason for asking, shown on its own line (older messages have it inside `detail`). */
      reason?: string | null;
      /** Chat members: the command prefix that `allow_prefix` lets through for the rest of the session. */
      prefix?: string | null;
      /** Claude Code: the rules and folders that `allow_session` adds for the rest of the session. */
      scope?: string | null;
    };

/**
 * A human decision on a native approval request, chosen by the local user in the group chat.
 * allow = this request only; allow_session = the runtime's own session-scoped approval (Codex acceptForSession; for
 * chat members: this exact command, or this file, for the rest of the session); allow_prefix = chat members: commands
 * that start with the request's `prefix` for the rest of the session; allow_all_edits = chat members: every file write
 * for the rest of the session; deny = refuse (the turn continues and the agent may try something else).
 */
export type ApprovalDecision = 'allow' | 'allow_session' | 'allow_prefix' | 'allow_all_edits' | 'deny';

/** Optional label an agent attaches via Team MCP. Informational only; it never grants anything. */
export type MessageIntent = 'chat' | 'progress' | 'blocked' | 'help' | 'review';

export interface RuntimeCapabilities {
  streaming: boolean;
  nativeTools: boolean;
  nativeApprovals: boolean;
  interrupt: boolean;
  resume: boolean;
  steer: boolean;
  teamMcp: boolean;
  /** Takes the fixed Harness Team rules once per native session through an official instructions option. */
  standingInstructions: boolean;
  /** Slash commands members of this runtime offer in the chat (`@handle /name`). Absent = none. */
  commands?: RuntimeCommand[];
  /**
   * A skill turn (`@handle /skill args`) carries the normal Harness Team turn text next to the native skill input
   * (Codex: a `skill` input item beside the text). Absent/false = the skill is sent bare as `/name args`, which the
   * runtime expands itself (Claude Code), so the member sees no chat context in that turn.
   */
  skillContext?: boolean;
  /**
   * A bare slash command runs without the member's saved model, effort and permission mode (Codex: review/start and
   * thread/compact/start take no overrides), so a changed setting is still pending after it.
   */
  commandsSkipConfig?: boolean;
}

/**
 * A slash command offered in the chat. `native` = run through the runtime's own protocol method (never sent as chat
 * text); `settings` = changed in the member's settings, where Harness Team keeps what the runtime is started with.
 */
export interface RuntimeCommand {
  name: string;
  description: Localized;
  /** What may follow the name, e.g. "[instructions]"; absent = takes no arguments (skills always take them). */
  args?: Localized | null;
  /** `skill` = a skill or custom command installed for this member's runtime (listed per member, see AgentCommands). */
  action: 'native' | 'settings' | 'skill';
  /** Skills: where it is installed (user, project, a plugin …) as the runtime reports it. */
  source?: Localized | null;
}

/**
 * `GET /api/agents/:id/commands`: what `@handle /` offers for one member. `commands` = the runtime's built-in commands
 * of Harness Team (always first); `skills` = skills the member's own runtime reports as installed for its workspace
 * (never the runtime's own built-in commands). Members on an API / plan-key provider list no skills.
 */
export interface AgentCommands {
  agentId: string;
  commands: RuntimeCommand[];
  skills: RuntimeCommand[];
  /** Why the skills could not be listed (shown in the list); null = listed (possibly none). */
  skillsError: Localized | null;
  /** Listed, but some skills failed to load (shown under the list). */
  skillsWarning: Localized | null;
  fetchedAt: string;
}

/** `@handle /name args` as the whole message: the handle as typed, the command name (lower case) and the arguments. */
export function parseSlashCommand(text: string): { handle: string; name: string; args: string } | null {
  const m = /^\s*@([^\s@]+)\s+\/([A-Za-z][\w:-]*)(?:\s+([\s\S]*))?$/.exec(text);
  return m ? { handle: m[1]!, name: m[2]!.toLowerCase(), args: (m[3] ?? '').trim() } : null;
}

/**
 * Concrete integration behind a runtime kind. Kept distinct on purpose: these are native harnesses with their
 * own tools, sessions and auth, not interchangeable "LLM providers".
 * - codex-app-server: official `codex app-server` (ChatGPT login)
 * - claude-native-cli: user's unmodified `claude` CLI in -p stream-json mode (claude.ai subscription login)
 * - claude-agent-sdk-api: planned, Claude Agent SDK with the user's own Console API key (not implemented)
 */
export type RuntimeBackend = 'mock' | 'codex-app-server' | 'claude-native-cli' | 'claude-agent-sdk-api' | 'antigravity-acp' | 'dsh-acp' | 'opencode-acp' | 'cursor-acp' | 'grok-acp' | 'kimi-acp' | 'chat-api';

export interface RuntimeDescriptor {
  kind: RuntimeKind;
  /** Which integration serves this kind (absent for placeholders). */
  backend?: RuntimeBackend | null;
  label: string;
  isMock: boolean;
  /** Whether this runtime can currently be used to create agents. */
  available: boolean;
  /** Human-readable reason when unavailable (e.g. "not implemented until Phase 2"). */
  note: Localized | null;
  /**
   * False when the CLI was not found, could not run or is too old: nothing of this kind can run (not even on a model
   * provider). Absent = true.
   */
  installed?: boolean;
  /** Short reason, shown on the runtime's card, when it cannot be chosen (not found, too old, not logged in…). */
  problem?: Localized | null;
  /** Agents of this runtime need an absolute workspace directory. */
  requiresWorkspace: boolean;
  /** Detected native version, e.g. "codex-cli 0.166.0-alpha.6". */
  version?: string | null;
  /** How the harness's own login is billed, as detected (null = unknown or not logged in). Never changed by Harness Team. */
  billing?: RuntimeBilling | null;
  capabilities: RuntimeCapabilities;
}

// ---- WebSocket server -> client events ----

export type ServerEvent =
  | { type: 'hello'; serverVersion: string; eventSeq: number }
  | { type: 'room.created'; eventSeq: number; room: Room }
  | { type: 'agent.created'; eventSeq: number; agent: AgentWithStatus }
  | { type: 'agent.updated'; eventSeq: number; agent: AgentWithStatus }
  | { type: 'member.added'; eventSeq: number; roomId: string; agentId: string }
  /** The agent left the room (removed by the user, or deleted). The agent itself may still exist. */
  | { type: 'member.removed'; eventSeq: number; roomId: string; agentId: string }
  /** The room's member list was put in a new order (dragged in the members panel). */
  | { type: 'members.reordered'; eventSeq: number; roomId: string; agentIds: string[] }
  | { type: 'agent.status'; eventSeq: number; agentId: string; status: AgentStatus }
  | { type: 'message.created'; eventSeq: number; message: Message }
  /** `offset` = body length before this delta, so clients can reconcile deltas with a (partially flushed) snapshot. */
  | { type: 'message.delta'; eventSeq: number; roomId: string; messageId: string; offset: number; delta: string }
  | { type: 'message.updated'; eventSeq: number; message: Message }
  | { type: 'room.updated'; eventSeq: number; room: Room }
  /** The room and everything in it were deleted by the local user. */
  | { type: 'room.deleted'; eventSeq: number; roomId: string }
  | { type: 'delivery.updated'; eventSeq: number; delivery: DeliveryInfo }
  | { type: 'task.updated'; eventSeq: number; task: Task }
  /** The default member avatars changed (set or removed in the settings or the member dialog). */
  | { type: 'avatar-defaults.updated'; eventSeq: number; defaults: AvatarDefaults }
  /** The installed runtimes were detected again (Check again in the add-member form). */
  | { type: 'runtimes.updated'; eventSeq: number; runtimes: RuntimeDescriptor[] };

/** Distributes Omit over a union so each event variant keeps its own fields. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type ServerEventInput = DistributiveOmit<Exclude<ServerEvent, { type: 'hello' }>, 'eventSeq'>;

// ---- HTTP API payloads ----

export interface CreateRoomRequest {
  name: string;
  projectDir?: string | null;
  /** Default 'zh'. */
  agentLanguage?: AgentLanguage;
}

export interface CreateAgentRequest {
  /** Optional: when omitted or empty the Core generates a unique handle from the display name / runtime. */
  handle?: string;
  displayName: string;
  runtimeKind: RuntimeKind;
  workspace?: string;
  /**
   * Phase 5: create a separate Git worktree of `workspace` (a Git repository) for this agent, on a new branch
   * `ht/<handle>` from the repository's current HEAD, so it can edit in parallel without touching the same files.
   * A worktree only separates working copies; it is not a security sandbox.
   */
  worktree?: boolean;
  /** Native model id from the runtime's catalog; omitted/null = follow the runtime's default configuration. */
  model?: string | null;
  /** Effort supported by the chosen model; omitted/null = the runtime's default. */
  effort?: string | null;
  /** One of PERMISSION_MODES[runtimeKind]; omitted/null = follow the user's own runtime configuration. */
  permissionMode?: PermissionMode | null;
  /** PERMISSION_WARNING_VERSION, sent only after the user confirmed the warning for a mode in RISKY_PERMISSION_MODES. */
  acknowledgePermissionRisk?: string;
  /** Antigravity members only; omitted = restricted. 'full' needs `acknowledgeCollabRisk`. */
  collabMode?: CollabMode;
  /** COLLAB_WARNING_VERSION, sent only after the user ticked the full-mode warning. */
  acknowledgeCollabRisk?: string;
  /** Omitted/null = follow the room's language. */
  language?: AgentLanguage | null;
  /** Chat members: the provider whose `model` they call (required for runtimeKind 'chat', refused otherwise). */
  providerId?: string;
  /** Chat members only; omitted fields take the defaults (DEFAULT_CHAT_MEMBER). */
  chat?: Partial<ChatMemberSettings>;
}

/** Only these can change after creation. Handle, runtime and workspace are fixed (sessions and @mentions depend on them). */
export interface UpdateAgentRequest {
  displayName?: string;
  model?: string | null;
  effort?: string | null;
  permissionMode?: PermissionMode | null;
  /** PERMISSION_WARNING_VERSION, sent only after the user confirmed the warning for a mode in RISKY_PERMISSION_MODES. */
  acknowledgePermissionRisk?: string;
  /** A data URL matching AGENT_AVATAR_RE, or null to go back to the letter mark. */
  avatar?: string | null;
  /** Antigravity members only. 'full' needs `acknowledgeCollabRisk`. */
  collabMode?: CollabMode;
  /** COLLAB_WARNING_VERSION, sent only after the user ticked the full-mode warning. */
  acknowledgeCollabRisk?: string;
  /** null = follow the room's language. */
  language?: AgentLanguage | null;
  /** Chat members only: `model` is another model of the same provider; these change the member's own settings. */
  chat?: Partial<ChatMemberSettings>;
}

export interface UpdateAgentResponse {
  agent: AgentWithStatus;
  /** now = applies from the next turn (agent idle); after_turn = saved, the running turn keeps its config. */
  applies: 'now' | 'after_turn' | 'unchanged';
}

/** Member detail view: native sessions per room (exact ids) and what the runtime reported. */
export interface AgentSessionDetail {
  roomId: string;
  roomName: string | null;
  nativeSessionId: string;
  status: 'active' | 'lost' | 'closed' | string;
  /** True when a native session/process is open in this server run. */
  live: boolean;
  /** Settings the runtime reported when the session was opened (auth, permissions, sandbox, model), one per line. */
  info: NoticeText[] | null;
}

export interface AgentDetailResponse {
  agent: AgentWithStatus;
  sessions: AgentSessionDetail[];
}

export interface AddMemberRequest {
  agentId: string;
  /** Make the member a default responder of the room (Room.defaultResponders). */
  defaultReply?: boolean;
}

export interface UpdateMemberRequest {
  defaultReply: boolean;
}

export interface PostMessageRequest {
  body: string;
  /** Client-generated id used for idempotent retries. */
  clientMessageId: string;
}

export interface RoomSnapshot {
  room: Room;
  members: AgentWithStatus[];
  messages: Message[];
  /** Deliveries whose source message is in `messages`. */
  deliveries: DeliveryInfo[];
  tasks: Task[];
}

export interface UpdateRoomRequest {
  autoPaused?: boolean;
  autoHopLimit?: number | null;
}

export interface CreateTaskRequest {
  title: string;
  assigneeId?: string | null;
}

export interface UpdateTaskRequest {
  title?: string;
  status?: TaskStatus;
  assigneeId?: string | null;
}

export interface ApiError {
  error: string;
}

/** Applies a streamed delta to a body that may already contain part of it (e.g. after a resync). */
export function applyDelta(body: string, offset: number, delta: string): string | null {
  if (offset > body.length) return null; // gap: wait for the final message.updated
  const end = offset + delta.length;
  if (end <= body.length) return body; // already included
  return body + delta.slice(body.length - offset);
}

/**
 * Handles may use letters and digits of any script (Chinese, Japanese, Cyrillic…) plus "_" and "-", starting with a
 * letter; length is counted in code points. Kept as typed apart from NFKC (full-width -> half-width).
 */
export const HANDLE_PATTERN = /^\p{L}[\p{L}\p{M}\p{N}_-]{0,31}$/u;
export const HANDLE_MAX = 32;
export const handleLength = (h: string): number => [...h].length;

/** Same key everywhere a handle is compared (dedupe, mentions, assignees): NFKC + lower case. */
export const handleKey = (h: string): string => h.normalize('NFKC').toLowerCase();

/** `@all` addresses every agent member of the room; it can never be an agent handle. */
export const ALL_HANDLE = 'all';
export const RESERVED_HANDLES = new Set([ALL_HANDLE, 'user', 'system', 'everyone', 'here']);

const ASCII_WORD = /[A-Za-z0-9_-]/;

/**
 * Extract @handles (as `handleKey`s) from a message body. "@" must start the text or follow a character that is not
 * an ASCII letter/digit/_/@, so "mail a@b.com" is not a mention while "请@codex 看" is.
 *
 * With `known` (the room's handles), a token also matches the longest known handle it starts with when the next
 * character is not an ASCII letter/digit/_/-: scripts without spaces work ("@codex-前端请看" -> codex-前端), while
 * "@codex-frontend2" never matches "codex-frontend".
 */
/** A path as typed or pasted, without surrounding spaces and the quotes of Explorer's "Copy as path". */
export function unquotePath(path: string): string {
  const p = path.trim();
  return p.length >= 2 && (p[0] === '"' || p[0] === "'") && p[p.length - 1] === p[0] ? p.slice(1, -1).trim() : p;
}

export function parseMentions(body: string, known?: Iterable<string>): string[] {
  const out = new Set<string>();
  const keys = known ? [...new Set([...known].map(handleKey))].sort((a, b) => b.length - a.length) : null;
  const re = /(^|[^A-Za-z0-9_@])@(\p{L}[\p{L}\p{M}\p{N}_-]*)/gu;
  // Only the token is normalized: NFKC on the whole body would turn a full-width "＠" (used to quote without
  // waking anyone) into a real "@".
  for (const m of body.matchAll(re)) {
    const token = handleKey(m[2] ?? '');
    if (!token) continue;
    if (!keys || keys.includes(token)) {
      out.add(token);
      continue;
    }
    const hit = keys.find((k) => token.startsWith(k) && !ASCII_WORD.test(token.charAt(k.length)));
    if (hit) out.add(hit);
  }
  return [...out];
}

// ---- Chat members: model providers called with the user's own API key ----

/** Wire format of a model API. The Base URL is written up to the version; the format appends the path. */
export type ChatApiFormat = 'openai_chat' | 'anthropic' | 'openai_responses' | 'gemini';
export const CHAT_API_FORMATS: readonly ChatApiFormat[] = ['openai_chat', 'anthropic', 'openai_responses', 'gemini'];

/** Per-member settings of a chat member (stored in its config). */
export interface ChatMemberSettings {
  /** Read-only project tools (list_dir, glob, read_file, search) in the room's project folder. */
  projectTools: boolean;
  /** The model's native web search, when the model has the capability. */
  webSearch: boolean;
  /** fetch_url: GET requests Harness Team makes for the model, each approved by the user unless in full access. */
  webFetch: boolean;
  /** Tokens (all kinds) this member may use per local day; 0 = no limit. */
  dailyTokenLimit: number;
  /** Tool rounds per turn before the turn stops. */
  maxToolRounds: number;
}
export const DEFAULT_CHAT_MEMBER: ChatMemberSettings = { projectTools: false, webSearch: false, webFetch: false, dailyTokenLimit: 2_000_000, maxToolRounds: 20 };

/** USD per 1M tokens. */
export interface ChatModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Everything a model can be configured with. Fields the user did not set follow the recommended values. */
export interface ChatModelFields {
  displayName: string;
  enabled: boolean;
  contextTokens: number;
  maxOutputTokens: number;
  image: boolean;
  pdf: boolean;
  tools: boolean;
  webSearch: boolean;
  /** Tags from low to high; empty = reasoning is not controlled. */
  reasoningLevels: string[];
  /** JSON text merged into the request body: a "{level}" template, or one entry per tag. '' = none. */
  reasoningMapping: string;
  /** JSON object text merged into every request body ("{session}" = a stable hash of member and chat). '' = none. */
  extraBody: string;
  /** JSON object text of extra request headers (string values, "{session}" allowed). '' = none. */
  extraHeaders: string;
  /** cache_control markers on the system prompt and the last message. */
  explicitCache: boolean;
  /** Send the model's reasoning back across turns (inside one turn's tool loop it is always sent back). */
  replayReasoning: boolean;
  /** Fraction of the context window at which the conversation is compacted. */
  compactAt: number;
  price: ChatModelPrice | null;
}
export const CHAT_MODEL_FIELD_NAMES = [
  'displayName', 'enabled', 'contextTokens', 'maxOutputTokens', 'image', 'pdf', 'tools', 'webSearch', 'reasoningLevels',
  'reasoningMapping', 'extraBody', 'extraHeaders', 'explicitCache', 'replayReasoning', 'compactAt', 'price',
] as const satisfies readonly (keyof ChatModelFields)[];

export interface ChatModel extends ChatModelFields {
  /** Model id sent to the API. */
  id: string;
  /** What the known-model table recommends for this id, Base URL and format (or the conservative defaults). */
  recommended: ChatModelFields;
  /** Fields the user set by hand: they no longer follow `recommended`. */
  manual: (keyof ChatModelFields)[];
  /** True when the known-model table has this id (otherwise `recommended` is the conservative default). */
  known: boolean;
  /** The built-in list price right now (server/src/pricing.ts), used when `price` is null; null when unknown. */
  listPrice: ChatModelPrice | null;
}

/** Where the provider's key comes from. The key itself never leaves the Core; only its last 4 characters are shown. */
export type ChatKeySource = { kind: 'none' } | { kind: 'env'; name: string; present: boolean } | { kind: 'app'; hint: string };

export interface ChatProvider {
  id: string;
  label: string;
  /** Preset it was made from (null = custom). */
  presetId: string | null;
  format: ChatApiFormat;
  baseUrl: string;
  key: ChatKeySource;
  /** Gemini format on Vertex AI: project and location (null project = the global endpoint without a project). */
  vertexProject: string | null;
  vertexLocation: string | null;
  enabled: boolean;
  models: ChatModel[];
  /** A provider row left by the removed Claude Code provider route: shown, but needs its format and key again. */
  legacy: boolean;
  createdAt: string;
}

export interface ChatPreset {
  id: string;
  label: string;
  format: ChatApiFormat;
  baseUrl: string;
  /** The Vertex AI preset: project / location fields are offered. */
  vertex: boolean;
  /** Model ids added when a provider is created from this preset (from the known-model table). */
  models: string[];
}

export interface ChatProvidersResponse {
  providers: ChatProvider[];
  presets: ChatPreset[];
  /** Whether keys can be stored encrypted in the app (desktop app); otherwise only environment variables work. */
  appKeys: boolean;
}

export interface SaveChatProviderRequest {
  label?: string;
  presetId?: string | null;
  format?: ChatApiFormat;
  baseUrl?: string;
  enabled?: boolean;
  vertexProject?: string | null;
  vertexLocation?: string | null;
  /** Set the key: an environment variable name, a key to encrypt in the app, or none. Omitted = unchanged. */
  key?: { kind: 'none' } | { kind: 'env'; name: string } | { kind: 'app'; value: string };
}

/** A model change: a field set to null goes back to following the recommended value. */
export interface SaveChatModelRequest {
  fields: { [K in keyof ChatModelFields]?: ChatModelFields[K] | null };
}

export interface ChatConnectionCheck {
  ok: boolean;
  /** Model ids the provider's model list returned (empty when it has none). */
  models: string[];
  /** Whether the provider answered with a model list (DeepSeek's Anthropic endpoint and Vertex AI have none). */
  listed: boolean;
  error: Localized | null;
}

/** Result of one short (billed) test message to a model. */
export interface ChatModelTest {
  ok: boolean;
  /** The start of the answer. */
  text: string;
  /** Tokens as the API reported them (input without cache reads; output with reasoning). */
  usage: { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number } | null;
  error: Localized | null;
}
