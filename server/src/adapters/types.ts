import { L, type Localized, type NoticeText } from '../../../shared/notices.ts';
import { pathKey } from '../path-key.ts';
import type {
  ActivityKind,
  Agent,
  AgentLanguage,
  ApprovalDecision,
  PermissionMode,
  RuntimeBilling,
  RuntimeDescriptor,
  RuntimeKind,
  RuntimeModelCatalog,
  FileChange,
} from '../../../shared/protocol.ts';

/**
 * Capability-driven runtime adapter contract.
 *
 * The Core only relies on what `describe().capabilities` declares. Adapters translate native events into
 * the TurnEvents below; they must never invent tool activity or approvals that the runtime did not report.
 */
export interface RuntimeAdapter {
  readonly kind: RuntimeKind;
  describe(): RuntimeDescriptor;
  /**
   * Open (or resume) the native session for one agent in one room.
   * `resumeNativeSessionId` is the exact stored id; adapters must never fall back to "most recent session".
   * If the exact session cannot be resumed the adapter throws `ResumeFailedError`; it does not start a new one.
   */
  openSession(args: OpenSessionArgs): Promise<AgentSession>;
  /**
   * Models and per-model effort levels as reported by the native runtime itself (no hardcoded lists). Must not make
   * a model request. Absent = the runtime offers no model choice (only the default configuration).
   */
  listModels?(opts?: { refresh?: boolean; cwd?: string | null }): Promise<RuntimeModelCatalog>;
  /**
   * How a model of the own login is billed when the model id itself tells (e.g. a provider prefix), else null (the
   * runtime's billing applies). A member with that model chosen is shown so before its first turn.
   */
  modelBilling?(model: string | null): RuntimeBilling | null;
  /**
   * Working directories the user already used with this runtime outside Harness Team, newest first, as reported by
   * the runtime itself. Must not make a model request. Absent = the runtime has no such listing.
   */
  recentWorkspaces?(): Promise<{ path: string; at: number | null }[]>;
  /**
   * Skills / custom commands installed for this runtime in `cwd`, as the runtime itself reports them (Claude Code
   * `initialize.commands` minus its built-ins, Codex `skills/list`). Must not make a model request. Absent = none.
   */
  listSkills?(opts: { cwd: string; refresh?: boolean }): Promise<SkillList>;
  /**
   * Bring back a session the user archived in the runtime's own app (Codex: `thread/unarchive`), so the exact same
   * session can be resumed. Called only after the user chose "restore" in the room. Absent = nothing to restore.
   */
  restoreSession?(nativeSessionId: string): Promise<void>;
  /** Stop any background processes. */
  dispose?(): Promise<void>;
}

/**
 * Why a stored session could not be resumed: `archived` = the user archived it in the runtime's own app (it can be
 * restored), `missing` = the runtime no longer has it (deleted), `other` = anything else (may be temporary).
 */
export type ResumeFailure = 'archived' | 'missing' | 'other';

export class ResumeFailedError extends Error {
  readonly reason: ResumeFailure;
  /** The runtime's own error text (shown to the user as is). */
  readonly detail: string | null;
  constructor(message: string, reason: ResumeFailure = 'other', detail: string | null = null) {
    super(message);
    this.name = 'ResumeFailedError';
    this.reason = reason;
    this.detail = detail;
  }
}

/** Built-in Team MCP server the Core exposes to this session (streamable HTTP on loopback). */
export interface TeamMcpConfig {
  /** MCP server name, e.g. "harness_team" (tools appear as mcp__harness_team__send_message in Claude Code). */
  serverName: string;
  /** Loopback URL including the per-session secret token. Never log it. */
  url: string;
}

/**
 * Why Harness Team answered a native permission request with "no". The text goes back to the agent as the tool
 * result, so it is in the room's agent language.
 */
export type DenyReason = 'noTurn' | 'turnEnded' | 'interrupted' | 'interrupting' | 'denied';

const DENY_TEXT: Record<DenyReason, { zh: string; en: string }> = {
  noTurn: { zh: 'Harness Team：当前没有进行中的回合，未批准', en: 'Harness Team: no turn is running; not allowed' },
  turnEnded: { zh: 'Harness Team：回合已结束，未批准此请求', en: 'Harness Team: the turn has ended; this request was not allowed' },
  interrupted: { zh: '用户在群聊中断了回合；Harness Team 未批准此请求', en: 'The user stopped the turn in the chat; Harness Team did not allow this request' },
  interrupting: { zh: '回合正在中断；Harness Team 未批准此请求', en: 'The turn is being stopped; Harness Team did not allow this request' },
  denied: { zh: '用户在 Harness Team 群聊中拒绝了此请求', en: 'The user declined this request in the Harness Team chat' },
};

export function denyText(reason: DenyReason, lang: AgentLanguage = 'zh'): string {
  return DENY_TEXT[reason][lang === 'en' ? 'en' : 'zh'];
}

export interface OpenSessionArgs {
  agent: Agent;
  roomId: string;
  /**
   * The room's current agent language (it can change while the session lives), for the few texts the adapter itself
   * sends to the agent, such as the reason a permission request was answered "no". Default 'zh'.
   */
  language?: () => AgentLanguage;
  resumeNativeSessionId?: string;
  /** What adapterState() last returned for the session being resumed (saved with the binding); absent for a new one. */
  adapterState?: string | null;
  /**
   * Saves the session's adapterState() with its binding right away. The adapter calls it before a request that changes
   * the runtime's options; a throw means it was not saved, and the request is then not sent.
   */
  onAdapterState?: (nativeSessionId: string, state: string | null) => void;
  /** A cost the runtime reported after the turn it belongs to ended (no turn runs): recorded for the last turn. */
  onLateUsage?: (usage: TurnUsage) => void;
  /** Present when the runtime declares capabilities.teamMcp and the Core serves Team MCP. */
  teamMcp?: TeamMcpConfig;
  /**
   * Fixed Harness Team rules for this session, when the runtime declares capabilities.standingInstructions. Passed
   * through the runtime's official option (Claude Code --append-system-prompt, Codex developerInstructions). The Core
   * only passes them to a new session, or on resume when the session was started with exactly this text.
   */
  instructions?: string;
  /**
   * Directories outside the workspace this session may read without a prompt: the room's attachments directory, so
   * a member can open files the user sent. Read-only. A runtime that can express a narrow read-only allow in its own
   * permission system uses it (Claude Code: a `Read(...)` allow rule); others ignore it and keep their own policy.
   */
  readableDirs?: string[];
  /**
   * How the member is shown as billed on the own login (what the runtime last reported, else the detection), read at
   * every check. A runtime that reports per-token billing for a member shown on the subscription is stopped.
   */
  billing?: () => RuntimeBilling | null;
  /** Tells the Core how the runtime itself reports the own login is billed (after the check above). */
  onBilling?: (billing: RuntimeBilling) => void;
}

/** Per-agent native model settings. null = leave it to the runtime's own default configuration. */
export interface ModelConfig {
  model: string | null;
  effort: string | null;
  /** One of PERMISSION_MODES for the runtime; null/absent = follow the user's own configuration (nothing is sent). */
  permissionMode?: PermissionMode | null;
}

/** The permission mode the runtime itself reported (AgentPermissionReport without the timestamp). */
export interface EffectivePermission {
  native: string;
  mode: PermissionMode | null;
  source: Localized;
  mismatch?: Localized | null;
  risky?: Localized | null;
}

/** Model/effort the runtime itself reported as in effect. */
export interface EffectiveModel {
  model: string | null;
  effort: string | null;
  source: Localized;
  /** Requested explicitly but reported differently (shown to the user; never hidden). */
  mismatch?: Localized | null;
}

export interface AgentSession {
  /** Exact native session/thread id, persisted in native_session_bindings. */
  readonly nativeSessionId: string;
  /** Human-readable effective settings reported by the runtime (model, sandbox, approval policy, cwd). */
  /** Session settings as reported by the runtime, one line each (shown folded in the chat and in the member detail). */
  readonly info?: NoticeText[];
  /** Latest model/effort the runtime reported for this session (after open, and updated during turns). */
  readonly effective?: EffectiveModel | null;
  /** Latest permission mode the runtime reported for this session (after open, and updated during turns). */
  readonly permission?: EffectivePermission | null;
  /**
   * Starts one turn. Resolves when the runtime reports a terminal state — not when input was accepted.
   * Events are delivered through `sink` while the turn runs. Aborting `signal` requests a native interrupt;
   * the result is `interrupted` only once the runtime confirms it.
   */
  runTurn(input: TurnInput, sink: TurnEventSink, signal: AbortSignal): Promise<TurnResult>;
  /**
   * Sends a human decision back on the exact native request id of the turn that is running now.
   * Only called by the Core for a decision the local user made in the group chat. Returns an error string (and sends
   * nothing) when the request is no longer pending in the current turn or the decision is not offered for it.
   */
  respondApproval?(nativeRequestId: string, decision: ApprovalDecision): ApprovalAnswer;
  /**
   * State this adapter needs again when the same native session is resumed by a later process (saved by the Core with
   * the binding after opening and after each turn, passed back as OpenSessionArgs.adapterState). Null = nothing.
   */
  adapterState?(): string | null;
  close(): Promise<void>;
}

export type ApprovalAnswer = { ok: true; nativeDecision: string } | { ok: false; error: Localized };

/** Answers shared by the runtimes when a decision cannot be sent. */
export const REQUEST_GONE = L('该原生请求已不在等待状态（已结束、已取消或已被处理）', 'The native request is no longer waiting (it ended, was cancelled or was already handled)');
export const REQUEST_INTERRUPTED = L('回合正在中断，请求已取消', 'The turn is being interrupted; the request was cancelled');
export const NO_TURN = L('该成员当前没有进行中的回合，请求已失效', 'This member has no turn running; the request is no longer valid');
export const unsupportedDecision = (kind: string, decision: string) =>
  L('此类请求（{kind}）不支持“{decision}”', 'This kind of request ({kind}) does not support “{decision}”', { kind, decision });

export interface TurnInput {
  /** Plain text as delivered to the agent, including sender attribution added by the Core. */
  text: string;
  messageId: string;
  /**
   * The agent's saved model settings at the moment this turn starts. Adapters apply them natively before the turn
   * (never in the middle of one) and must fail the turn rather than run it with something else.
   */
  config?: ModelConfig;
  /**
   * Images the local user attached to the triggering messages, to pass natively (Codex `localImage`, Claude Code
   * image content block). Files stay in the app's data directory; the text already names each one.
   */
  attachments?: TurnAttachment[];
  /**
   * A slash command from the local user (one of `describe().capabilities.commands`, action `native`): the adapter runs
   * it through the runtime's own method instead of sending chat. `text` is then just `/name args`.
   */
  command?: { name: string; args: string; skill?: { path: string | null } };
}

export interface SkillInfo {
  name: string;
  description: Localized;
  args?: Localized | null;
  source: Localized | null;
  /** Codex: the SKILL.md path `skills/list` reported (needed for the `skill` input item). */
  path?: string | null;
}

export interface SkillList {
  skills: SkillInfo[];
  /** The list could not be read: `skills` is empty and nothing may be run from an older list. */
  error: Localized | null;
  /** Read, but some skills failed to load (the ones in `skills` are usable). */
  warning?: Localized | null;
}

/** Names a skill can be invoked by in the chat (same characters `parseSlashCommand` accepts). */
export const SKILL_NAME = /^[A-Za-z][\w:-]*$/;

/** How long an adapter keeps a successful skill list for one folder (failures are never kept). */
export const SKILLS_TTL_MS = 5 * 60_000;
/** Cache key for a working folder, however it is spelled (see pathKey). */
export const cwdKey = (cwd: string) => pathKey(cwd);

export interface TurnAttachment {
  kind: 'image' | 'file';
  name: string;
  /** Detected from the file's bytes when it was uploaded. */
  mime: string;
  /** Absolute path in the app's data directory. */
  path: string;
}

export type TurnEvent =
  /** Native turn id, once the runtime has accepted the turn. */
  | { type: 'turn.started'; nativeTurnId: string }
  /** Assistant text. `itemId` groups deltas of one native message; omitted for single-message runtimes. */
  | { type: 'text.delta'; itemId?: string; text: string; phase?: string | null }
  /** Authoritative final text of one native message (replaces streamed text if they differ). */
  | { type: 'text.done'; itemId?: string; text: string; phase?: string | null }
  /** Real runtime tool/activity item. Mock adapters must not emit these. */
  | {
      type: 'activity';
      itemId: string;
      activity: ActivityKind;
      title: string;
      detail?: string | null;
      nativeStatus?: string | null;
      /** fileChange only: what changed, per file. */
      files?: FileChange[];
      /** `title` as a translatable text. */
      label?: NoticeText;
      done: boolean;
      /** Final outcome when done: failed/declined items are reported as failed. */
      failed?: boolean;
    }
  /** Real native request waiting for a human. Must carry the runtime's own request id. Mock adapters must not emit these. */
  | {
      type: 'approval.requested';
      nativeRequestId: string;
      nativeMethod: string;
      itemId?: string | null;
      title: string;
      label?: NoticeText;
      /** The runtime's reason for asking (shown on its own line). */
      reason?: string | null;
      detail?: string | null;
      /** Decisions the native request can take from a human; always includes 'deny'. */
      options: ApprovalDecision[];
      /** With `allow_prefix`: the command prefix it lets through (shown on the button). */
      prefix?: string | null;
      /** With `allow_session`: what it lets through for the rest of the session, when the runtime says (on the button). */
      scope?: string | null;
    }
  /** The runtime reported the request resolved (by our decision, a cancel, or its own lifecycle). */
  | { type: 'approval.resolved'; nativeRequestId: string; decision?: string | null }
  /** Non-fatal runtime notice (e.g. a retryable error). */
  /** `notice` is the translatable form; `text` its Chinese rendering (what agents and older clients see). */
  | { type: 'notice'; text: string; notice?: NoticeText }
  /** The runtime reported which model/effort is in effect (e.g. Codex thread/settings/updated, model/rerouted). */
  | { type: 'config.effective'; effective: EffectiveModel }
  /** The runtime reported which permission mode is in effect (Claude Code system/init, Codex thread/settings/updated). */
  | { type: 'permission.effective'; permission: EffectivePermission };

export type TurnEventSink = (event: TurnEvent) => void;

export interface TurnResult {
  status: 'completed' | 'interrupted' | 'failed';
  error?: Localized;
  /**
   * Set when the runtime could not confirm that the native turn has stopped (e.g. an interrupt that timed out): the
   * platform turn is over, the native one may still be running. Resolves once the runtime reports the native end (or
   * its process is gone). Until then the Core keeps the agent's workspace and dispatches nothing more to it (fail closed).
   */
  nativeSettled?: Promise<void>;
  /** Token usage the runtime itself reported for this turn (one entry per model). Absent when it reported none. */
  usage?: TurnUsage[];
}

/**
 * Tokens one model used in one turn, as the runtime reported them. The counts are disjoint, so
 * total = input + cacheRead + cacheWrite + output. `reasoning` is the part of `output` the runtime labelled as
 * reasoning (informational only). `costUsd` is the runtime's own estimate at API prices (Claude Code reports one even
 * on a subscription, where nothing is billed per token); null when the runtime gives none.
 */
export interface TurnUsage {
  model: string | null;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  costUsd: number | null;
  /** The runtime reported a cost but no token counts for this record: its zeros are not counts. */
  tokensUnknown?: true;
}
