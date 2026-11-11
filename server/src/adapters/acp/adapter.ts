import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { relativeInside } from '../../path-key.ts';
import { L, type Localized, localizedError, NoticeError, type NoticeText, type NoticeValue, zhText } from '../../../../shared/notices.ts';
import type {
  ActivityKind,
  AgentLanguage,
  ApprovalDecision,
  FileChange,
  PermissionMode,
  PermissionModeAvailability,
  RuntimeBackend,
  RuntimeBilling,
  RuntimeDescriptor,
  RuntimeKind,
  RuntimeModelCatalog,
  RuntimeModelOption,
} from '../../../../shared/protocol.ts';
import { JsonRpcProcess, RpcError, type RpcId } from '../codex/rpc.ts';
import { redactText } from '../../redact.ts';
import {
  type AgentSession,
  type ApprovalAnswer,
  type EffectiveModel,
  type EffectivePermission,
  NO_TURN,
  type OpenSessionArgs,
  REQUEST_GONE,
  REQUEST_INTERRUPTED,
  ResumeFailedError,
  type RuntimeAdapter,
  type TeamMcpConfig,
  type TurnAttachment,
  type TurnEvent,
  type TurnEventSink,
  type TurnInput,
  type TurnResult,
  type TurnUsage,
  unsupportedDecision,
} from '../types.ts';

/**
 * A coding runtime spoken to as ACP v1 over stdio (agentclientprotocol.com): the runtime's own official ACP server,
 * unmodified. What differs between runtimes (how it is found and started, its login, billing, permission modes and
 * names) is in the subclass; sessions, turns, native approvals, model / mode options, cancel and resume are here.
 *
 * Harness Team never reads, stores or forwards the runtime's credentials: it does not call `authenticate`. The runtime
 * gets the user's environment as a terminal has it. Permission requests are answered only with the user's choice in
 * the chat (allow once / reject once), never "always". A member's permission mode is the runtime's own session mode,
 * set before the turn like the model (nothing is sent for "follow my settings").
 */

export interface AcpAdapterOptions {
  command: string;
  argsPrefix?: string[];
  /** Arguments that start the ACP server (default: the runtime's own, see `defaultArgs`). */
  args?: string[];
  version?: string | null;
  problem?: Localized | null;
  protocolLog?: string;
  /** How long to wait for the runtime to confirm a cancel before failing closed. Default 20 s. */
  interruptTimeoutMs?: number;
  /** Model catalog read (temporary session) timeout. Default 60 s. */
  catalogTimeoutMs?: number;
  /** Environment the child starts from (default this process's; passed as it is). */
  baseEnv?: NodeJS.ProcessEnv;
}

// ACP wire helpers

/** ACP `Authentication required`. */
const AUTH_REQUIRED = -32000;

interface SelectOption {
  value: string;
  name: string;
  description?: string | null;
}

interface ConfigOption {
  id: string;
  name?: string;
  category?: string | null;
  type?: string;
  currentValue?: unknown;
  options?: unknown;
}

interface UnstableModels {
  currentModelId?: string;
  availableModels?: { modelId: string; name?: string; description?: string | null }[];
}

interface ModeState {
  currentModeId?: string;
  availableModes?: { id: string; name?: string; description?: string | null }[];
}

/** Flattens the options of a select config option (flat list or groups). */
function selectOptions(o: ConfigOption | undefined): SelectOption[] {
  if (!o || !Array.isArray(o.options)) return [];
  const out: SelectOption[] = [];
  for (const x of o.options as any[]) {
    if (x && Array.isArray(x.options)) {
      for (const y of x.options) if (y && typeof y.value === 'string') out.push({ value: y.value, name: String(y.name ?? y.value), description: y.description ?? null });
    } else if (x && typeof x.value === 'string') out.push({ value: x.value, name: String(x.name ?? x.value), description: x.description ?? null });
  }
  return out;
}

const byCategory = (opts: ConfigOption[], category: string) => opts.find((o) => o.category === category && (o.type ?? 'select') === 'select');
const current = (o: ConfigOption | undefined): string | null => (o && typeof o.currentValue === 'string' ? o.currentValue : null);

type ConfigKind = 'model' | 'effort' | 'mode';
const CONFIG_KINDS: readonly ConfigKind[] = ['model', 'effort', 'mode'];
const EMPTY_CONFIG: Record<ConfigKind, string | null> = { model: null, effort: null, mode: null };

export function errText(e: unknown): string {
  return redactText((e as Error)?.message ?? String(e));
}

export const isAuthError = (e: unknown) => e instanceof RpcError && (e.code === AUTH_REQUIRED || /auth(entication)? required/i.test(e.message));

/** Names (not values) of risky modes: they let the runtime act without asking. */
const RISKY_MODE = /yolo|bypass|skip|dangerous|auto[-_ ]?approve|full[-_ ]?auto/i;

const DETAIL_MAX = 6000;

function clip(s: string | null | undefined, max = DETAIL_MAX): string | null {
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max)}\n…（已截断）` : s;
}

function titled(n: NoticeText): { title: string; label: NoticeText } {
  return { title: zhText(n), label: n };
}

function noticeEvent(n: NoticeText): { type: 'notice'; text: string; notice: NoticeText } {
  return { type: 'notice', text: zhText(n), notice: n };
}


/**
 * How the adapter answers a runtime-specific agent→client request (an ACP extension method such as Cursor's
 * `cursor/create_plan`):
 * - `answer`: replied at once with `result`; `activity` (if any) is shown in the turn's activity list.
 * - `approval`: shown in the chat as an approval card; `answer` builds the reply for the user's decision, and for
 *   `cancelled` (no turn running, an interrupt, the turn ending first). Nothing is ever accepted without a click.
 */
export type ExtensionReply =
  | { kind: 'answer'; result: unknown; activity?: { title: NoticeText; detail: string | null } }
  | {
      kind: 'approval';
      title: NoticeText;
      detail: string | null;
      /** The runtime's own names of the two answers (shown as the decision). */
      allowName: string;
      rejectName: string;
      answer: (decision: 'allow' | 'reject' | 'cancelled') => unknown;
    };

// ---------------------------------------------------------------------------------------------------------------
// Adapter

const CATALOG_TTL_MS = 5 * 60_000;

export abstract class AcpAdapter<O extends AcpAdapterOptions = AcpAdapterOptions> implements RuntimeAdapter {
  abstract readonly kind: RuntimeKind;
  /** Shown to the user ("Antigravity"). */
  abstract readonly label: string;
  /** RuntimeDescriptor.backend ("antigravity-acp"). */
  abstract readonly backend: RuntimeBackend;
  /** The process in logs and in the version line before `initialize` answers ("agy acp"). */
  abstract readonly processName: string;
  /** Answer to ACP "Authentication required": where the user logs in themself. */
  abstract readonly notLoggedIn: NoticeText;
  /** Instruction files in the working folder the runtime may or may not load (named in the session info). */
  readonly ruleFiles: readonly string[] = ['AGENTS.md'];
  /** The process flag behind the skip-permissions mode (null: the runtime has none). */
  readonly skipPermissionsFlag: string | null = null;
  protected opts: O;
  /** Latest catalog, from a live session or a temporary one (never a model request). */
  private catalog: { at: number; value: Promise<RuntimeModelCatalog> } | null = null;
  private readonly sessions = new Set<AcpSession>();
  /** Temporary sessions reading the model list (closed by dispose). */
  private readonly probes = new Set<AcpSession>();
  /** The catalog read in progress: a concurrent call (refresh or not) joins it instead of starting another process. */
  private catalogRead: Promise<RuntimeModelCatalog> | null = null;
  private disposed = false;
  /** What the runtime said about itself in its last `initialize` (name / version). */
  protected agentInfo: string | null = null;

  constructor(opts: O) {
    this.opts = opts;
  }

  /** The member's permission modes for this runtime (PERMISSION_MODES[kind]). */
  abstract get permissionModes(): readonly PermissionMode[];
  /** Billing as far as the environment tells. */
  protected abstract billing(): RuntimeBilling;
  /** RuntimeDescriptor.note for an available runtime. */
  protected abstract availableNote(version: string | null): Localized;
  /** Arguments that start the ACP server when the options give none. */
  protected abstract defaultArgs(): string[];

  /** A notice with the runtime's name as its {name} parameter. */
  t(zh: string, en: string, params?: Record<string, NoticeValue | null | undefined>): NoticeText {
    return L(zh, en, { name: this.label, ...params });
  }

  describe(): RuntimeDescriptor {
    const problem = this.opts.problem ?? null;
    const version = this.agentInfo ?? this.opts.version ?? null;
    return {
      kind: this.kind,
      backend: this.backend,
      label: this.label,
      isMock: false,
      available: !problem,
      installed: true,
      problem,
      note: problem ? L('不可用：{problem}', 'Not available: {problem}', { problem }) : this.availableNote(version),
      requiresWorkspace: true,
      version,
      billing: problem ? null : this.billing(),
      capabilities: {
        streaming: true,
        nativeTools: true,
        nativeApprovals: true,
        interrupt: true,
        resume: true,
        steer: false,
        teamMcp: true,
        // The Harness Team rules travel with every turn's text (ACP has no official instructions option in v1).
        standingInstructions: false,
      },
    };
  }

  /** New detection results (Check again): new sessions use them; running ones keep their process. */
  update(found: Partial<O>): void {
    this.opts = { ...this.opts, ...found };
    this.catalog = null;
  }

  /**
   * Command line of the ACP server. `withHttpMcp`: the sessions get Team MCP over HTTP. `mode` only for a member whose
   * chosen mode is set when the process starts (see isProcessMode; that member's own process). `env` is added to the
   * child's environment.
   */
  launch(withHttpMcp: boolean, mode: PermissionMode | null = null): { command: string; args: string[]; env?: Record<string, string> } {
    const problem = mode ? this.processModeProblem(mode) : null;
    if (problem) throw localizedError(problem);
    const proc = mode ? this.processLaunch(mode) : { args: [] };
    return {
      command: this.opts.command,
      args: [...(this.opts.argsPrefix ?? []), ...(this.opts.args ?? this.defaultArgs()), ...this.extraArgs(withHttpMcp), ...proc.args],
      ...(proc.env ? { env: proc.env } : {}),
    };
  }

  /**
   * Whether a member's mode is set when its process starts (a flag or the environment) instead of as a session mode.
   * Changing it restarts that member's process and resumes the same session by id.
   */
  isProcessMode(mode: PermissionMode | null | undefined): mode is PermissionMode {
    return mode === 'skip-permissions';
  }

  /** What starts the process in that mode. */
  protected processLaunch(mode: PermissionMode): { args: string[]; env?: Record<string, string> } {
    return mode === 'skip-permissions' && this.skipPermissionsFlag ? { args: [this.skipPermissionsFlag] } : { args: [] };
  }

  /** Why the process cannot start in that mode (null = it can). */
  processModeProblem(mode: PermissionMode): Localized | null {
    return mode === 'skip-permissions' ? this.skipPermissionsProblem() : null;
  }

  /** How that mode is named in notices ("--dangerously-skip-permissions"). */
  processModeLabel(mode: PermissionMode): string {
    return mode === 'skip-permissions' ? (this.skipPermissionsFlag ?? '?') : mode;
  }

  /** The permission in effect in a process started in that mode (`native`: the session mode it reports, if any). */
  processPermission(mode: PermissionMode, native: string | null): EffectivePermission {
    const flag = this.processModeLabel(mode);
    return {
      native: `${native ?? '?'} · ${flag}`,
      mode,
      source: this.t('{name} 进程参数与会话模式', '{name} process flag and session mode'),
      mismatch: null,
      risky:
        mode === 'skip-permissions'
          ? this.t(
              '{name} 以 {flag} 运行：工具的权限请求会被自动批准，不会在群里请求审批。',
              '{name} runs with {flag}: tool permission requests are approved automatically, without asking for approval in the chat.',
              { flag },
            )
          : null,
    };
  }

  /** The permission in effect when the member follows the runtime's own setting and no session mode is reported. */
  defaultPermission(): EffectivePermission | null {
    return null;
  }

  /** An error that means the user is not logged in to the runtime (answered with `notLoggedIn`). */
  isNotLoggedIn(e: unknown): boolean {
    return isAuthError(e);
  }

  /** Runtime-specific arguments after the ones that start the server. */
  protected extraArgs(_withHttpMcp: boolean): string[] {
    return [];
  }

  /**
   * A runtime-specific agent→client request (not session/request_permission). null = not provided (answered with
   * "method not found").
   */
  extensionRequest(_method: string, _params: any): ExtensionReply | null {
    return null;
  }

  /** Why skip-permissions cannot be used with this runtime (null = it can). */
  skipPermissionsProblem(): Localized | null {
    return this.skipPermissionsFlag ? null : this.t('{name} 没有跳过权限确认的启动参数', '{name} has no flag that skips permission requests');
  }

  childEnv(): NodeJS.ProcessEnv {
    return { ...(this.opts.baseEnv ?? process.env) };
  }

  get interruptTimeoutMs(): number {
    return this.opts.interruptTimeoutMs ?? 20_000;
  }

  get protocolLog(): string | undefined {
    return this.opts.protocolLog;
  }

  noteAgentInfo(info: string | null) {
    if (info) this.agentInfo = info;
  }

  async openSession(args: OpenSessionArgs): Promise<AgentSession> {
    if (this.opts.problem) throw localizedError(this.opts.problem);
    const cwd = args.agent.workspace;
    if (!cwd) throw new NoticeError(this.t('{name} 成员需要工作目录（workspace）', '{name} members need a working folder (workspace)'));
    const s = new AcpSession(this, cwd, args.teamMcp);
    s.processMode = this.isProcessMode(args.agent.permissionMode) ? args.agent.permissionMode : null;
    if (args.language) s.language = args.language;
    if (args.resumeNativeSessionId) s.restoreState(args.adapterState);
    s.hooks = { saveState: args.onAdapterState, lateUsage: args.onLateUsage };
    try {
      await s.connect(args.resumeNativeSessionId);
    } catch (e) {
      await s.close();
      throw e;
    }
    this.sessions.add(s);
    this.rememberCatalog(s.catalogFromSession());
    return s;
  }

  forget(s: AcpSession) {
    this.sessions.delete(s);
  }

  private rememberCatalog(c: RuntimeModelCatalog | null) {
    if (c?.available) this.catalog = { at: Date.now(), value: Promise.resolve(c) };
  }

  /**
   * Models and Thinking levels as the runtime reports them for a session (`configOptions`). Read from a running session
   * when there is one, otherwise from a temporary process: initialize + session/new without MCP, then closed. No prompt
   * is sent, so no model request is made.
   */
  listModels(opts: { refresh?: boolean; cwd?: string | null } = {}): Promise<RuntimeModelCatalog> {
    if (!opts.refresh && this.catalog && Date.now() - this.catalog.at < CATALOG_TTL_MS) return this.catalog.value;
    if (this.catalogRead) return this.catalogRead;
    const value = this.readCatalog(opts.cwd ?? null).finally(() => {
      if (this.catalogRead === value) this.catalogRead = null;
    });
    this.catalogRead = value;
    this.catalog = { at: Date.now(), value };
    value.then((c) => {
      if (!c.available && this.catalog?.value === value) this.catalog = null;
    });
    return value;
  }

  private async readCatalog(cwd: string | null): Promise<RuntimeModelCatalog> {
    const fail = (error: Localized): RuntimeModelCatalog => ({
      runtimeKind: this.kind,
      available: false,
      source: this.t('{name} ACP session/new', '{name} ACP session/new'),
      error,
      models: [],
      nativeDefault: null,
      fetchedAt: new Date().toISOString(),
    });
    if (this.opts.problem) return fail(this.opts.problem);
    if (this.disposed) return fail(L('Harness Team 正在退出', 'Harness Team is shutting down'));
    const live = [...this.sessions].map((s) => s.catalogFromSession()).find((c) => c?.available);
    if (live) return live;
    const timeoutMs = this.opts.catalogTimeoutMs ?? 60_000;
    const probe = new AcpSession(this, cwd && isAbsolute(cwd) && existsSync(cwd) ? cwd : tmpdir(), undefined);
    this.probes.add(probe);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        probe.connect(undefined, timeoutMs),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new NoticeError(this.t('读取 {name} 模型目录超时（{s} 秒）', 'Reading the {name} model list timed out ({s} s)', { s: Math.round(timeoutMs / 1000) }))),
            timeoutMs,
          );
        }),
      ]);
      return probe.catalogFromSession() ?? fail(this.t('{name} 没有报告可选的模型', '{name} reported no model choice'));
    } catch (e) {
      return fail(e instanceof NoticeError ? e.notice : this.isNotLoggedIn(e) ? this.notLoggedIn : this.t('无法读取 {name} 模型目录：{error}', 'Could not read the {name} model list: {error}', { error: errText(e) }));
    } finally {
      if (timer) clearTimeout(timer);
      await probe.close();
      this.probes.delete(probe);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.sessions, ...this.probes].map((s) => s.close()));
    await this.catalogRead?.catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Session: one ACP process per Harness Team session (member × room)

export class AcpSession implements AgentSession {
  nativeSessionId = '';
  info: NoticeText[] = [];
  /** The room's agent language, for the reason sent back with a "no". */
  language: () => AgentLanguage = () => 'zh';
  permission: EffectivePermission | null = null;
  private rpc: JsonRpcProcess | null = null;
  private caps: any = {};
  private configOptions: ConfigOption[] = [];
  private models: UnstableModels | null = null;
  private modes: ModeState | null = null;
  /** Per option, the runtime's value just before Harness Team first changed it (restored when "follow" is chosen again). */
  private baseline: Record<ConfigKind, string | null> = { ...EMPTY_CONFIG };
  /** Last value confirmed by a linked HT request, never an unrelated native report. */
  private applied: Record<ConfigKind, string | null> = { ...EMPTY_CONFIG };
  /** Options Harness Team has changed in this native session and not restored yet. */
  private overridden: Record<ConfigKind, boolean> = { model: false, effort: false, mode: false };
  /**
   * Options whose value this session does not know for sure: a request to change one got no confirmed answer (it was
   * refused, timed out, or returned no option state) and may still have been applied. Never skipped as "already set"
   * until the runtime reports the options again.
   */
  private unsure: Record<ConfigKind, boolean> = { model: true, effort: true, mode: true };
  /**
   * Options an option request without a confirmed answer may have changed on the side, with their value before it
   * (see applyConfig). Not "changed by Harness Team": a different value later may also be the user's own.
   */
  private maybe: Partial<Record<ConfigKind, string | null>> = {};
  /** Per option, how many reports of it this object has taken (takeReport, current_mode_update). */
  private reportGen: Record<ConfigKind, number> = { model: 0, effort: 0, mode: 0 };
  /**
   * Per noted option (`maybe`): the count of its reports when the request that noted it went out, and whether the
   * runtime confirmed that request with a report received before its answer. Reports that arrive later have no
   * request id and cannot establish ownership. Not saved: notes from another process are unconfirmed.
   */
  private maybeAt: Partial<Record<ConfigKind, { gen: number; linked: boolean; pending?: boolean }>> = {};
  /** Saved state of the session to resume (restoreState), applied when exactly that session is resumed. */
  private saved: {
    sessionId: string;
    baseline: Record<ConfigKind, string | null>;
    applied: Record<ConfigKind, string | null>;
    overridden: Record<ConfigKind, boolean>;
    maybe: Partial<Record<ConfigKind, string | null>>;
    cost: number | null;
  } | null = null;
  /** The Core's callbacks: save the adapter state (before an option request goes out), and a cost that came late. */
  hooks: { saveState?: (nativeSessionId: string, state: string | null) => void; lateUsage?: (usage: TurnUsage) => void } = {};
  /** The member's chosen session mode for the current turn (null = follow the runtime's own setting). */
  private wantMode: string | null = null;
  /** The member's mode that this session's process was started in (see AcpAdapter.isProcessMode), else null. */
  processMode: PermissionMode | null = null;
  private turn: AcpTurn | null = null;
  private running = false;
  private unsettled: Promise<void> | null = null;
  private replaying = false;
  /**
   * The session's running cost in USD as the runtime last reported it in usage_update (`cost` is the session total,
   * e.g. OpenCode sends its session.cost). 0 for a session created here; null while unknown (a resumed session before
   * its first report), and then no per-turn cost is derived.
   */
  private costTotal: number | null = null;
  /**
   * Whether the session total was known when the current (or last) turn began. Only then is a later total that turn's
   * cost: a total first learned during the turn may already include part of it, so that turn's cost is not known.
   */
  private costCounted = false;
  /** The last turn (with a known start) reported no usage: an unchanged total after it is its cost of 0, recorded once. */
  private lateZero = false;
  /** While the process starts and the session opens: cost reports then only set the session's starting total. */
  private connecting = false;
  private closed = false;
  private turnSeq = 0;
  private readonly adapter: AcpAdapter;
  private readonly cwd: string;
  private readonly teamMcp: TeamMcpConfig | undefined;

  constructor(adapter: AcpAdapter, cwd: string, teamMcp: TeamMcpConfig | undefined) {
    this.adapter = adapter;
    this.cwd = cwd;
    this.teamMcp = teamMcp;
  }

  private t(zh: string, en: string, params?: Record<string, NoticeValue | null | undefined>): NoticeText {
    return this.adapter.t(zh, en, params);
  }

  private get notLoggedIn(): NoticeText {
    return this.adapter.notLoggedIn;
  }

  get effective(): EffectiveModel | null {
    const model = current(byCategory(this.configOptions, 'model')) ?? this.models?.currentModelId ?? null;
    const effort = current(byCategory(this.configOptions, 'thought_level'));
    if (!model && !effort) return null;
    return { model, effort, source: this.t('{name} 会话选项', '{name} session options') };
  }

  /**
   * Starts the ACP process and opens (or resumes, by exact id) the session. On failure the process is closed, so a
   * later turn starts it again and resumes the session instead of prompting a session that was never opened.
   */
  async connect(resumeId?: string, timeoutMs = 60_000): Promise<void> {
    this.connecting = true;
    try {
      await this.open(resumeId, timeoutMs);
    } catch (e) {
      const rpc = this.rpc;
      this.rpc = null;
      await rpc?.close().catch(() => {});
      throw e;
    } finally {
      this.connecting = false;
    }
  }

  private async open(resumeId: string | undefined, timeoutMs: number): Promise<void> {
    this.forgetReports();
    const withMcp = !!this.teamMcp;
    const { command, args, env } = this.adapter.launch(withMcp, this.processMode);
    const rpc = new JsonRpcProcess(
      command,
      args,
      {
        // Only the session's current process speaks for it: one that is being closed (a failed open, a restart) is
        // ignored, and its requests are answered on that process itself.
        onNotification: (m, p) => {
          if (!this.connecting && m === 'session/update' && (p?.update?.sessionUpdate === 'config_option_update' || p?.update?.sessionUpdate === 'current_mode_update')) {
            // Keep configuration reports in wire order relative to request continuations, including one stdout batch.
            queueMicrotask(() => {
              if (this.rpc === rpc) this.onNotification(m, p);
            });
          } else if (this.rpc === rpc) this.onNotification(m, p);
        },
        onServerRequest: (id, m, p) => this.onServerRequest(rpc, id, m, p),
        onExit: (reason) => {
          if (this.rpc === rpc) this.turn?.processGone(reason);
        },
      },
      { cwd: this.cwd, protocolLog: this.adapter.protocolLog, env: { ...this.adapter.childEnv(), ...env }, name: this.adapter.processName },
    );
    this.rpc = rpc;
    rpc.start();
    const init = await rpc.request<any>(
      'initialize',
      {
        protocolVersion: 1,
        // Harness Team offers no file system or terminal of its own: the runtime uses its own tools.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'harness-team', title: 'Harness Team', version: '0' },
      },
      timeoutMs,
    );
    if (Number(init?.protocolVersion) !== 1) {
      throw new NoticeError(this.t('{name} ACP 协议版本 {v} 不受支持（需要 1）', '{name} ACP protocol version {v} is not supported (1 is needed)', { v: String(init?.protocolVersion ?? '?') }));
    }
    this.caps = init?.agentCapabilities ?? {};
    const agent = init?.agentInfo;
    const agentLine = agent?.name ? `${agent.title ?? agent.name}${agent.version ? ` ${agent.version}` : ''}` : null;
    this.adapter.noteAgentInfo(agentLine);
    const mcpServers: unknown[] = [];
    const info: NoticeText[] = [];
    if (agentLine) info.push(this.t('运行时：{v}', 'Runtime: {v}', { v: agentLine }));
    if (this.teamMcp) {
      if (this.caps?.mcpCapabilities?.http) {
        // Team MCP over streamable HTTP; the per-session token is in the URL (never logged: see redactForLog).
        mcpServers.push({ type: 'http', name: this.teamMcp.serverName, url: this.teamMcp.url, headers: [] });
      } else info.push(this.t('运行时未声明 HTTP MCP 支持：Team MCP 不可用', 'The runtime does not declare HTTP MCP support: Team MCP is not available'));
    }
    let res: any;
    try {
      if (resumeId) {
        // Set first: cost reports while the session resumes (or replays) belong to it and set its starting total.
        // A total known before (this object's last report, or a saved one) is never the start, also when this object
        // reconnects to the same session: the session may have been used elsewhere since, and that cost would be
        // counted as the next turn's. Only a report from this process sets it; until then no turn cost is derived.
        const hadTotal = (resumeId === this.nativeSessionId && this.costTotal !== null) || (this.saved?.sessionId === resumeId && this.saved.cost !== null);
        this.costTotal = null;
        this.nativeSessionId = resumeId;
        res = await this.resume(rpc, resumeId, mcpServers, timeoutMs);
        info.unshift(this.t('已恢复 {name} 会话 {id}', 'Resumed {name} session {id}', { id: resumeId }));
        if (this.saved?.sessionId === resumeId) {
          this.baseline = this.saved.baseline;
          this.applied = this.saved.applied;
          this.overridden = this.saved.overridden;
          this.maybe = this.saved.maybe;
          this.maybeAt = {};
          for (const k of CONFIG_KINDS) if (k in this.maybe) this.maybeAt[k] = { gen: this.reportGen[k], linked: false };
        }
        // The runtime may not report the session total on resume (OpenCode 2.2.6 does not).
        if (this.costTotal === null && hadTotal) {
          info.push(
            this.t(
              '{name} 恢复会话时没有报告累计费用：下一回合的费用无法与会话在别处的用量区分，不计入',
              '{name} did not report the session total on resume: the next turn’s cost cannot be told apart from use of the session elsewhere and is not counted',
            ),
          );
        }
        this.saved = null;
      } else {
        res = await rpc.request<any>('session/new', { cwd: this.cwd, mcpServers }, timeoutMs);
        if (!res?.sessionId) throw new NoticeError(this.t('{name} 没有返回会话 id', '{name} returned no session id'));
        this.nativeSessionId = String(res.sessionId);
        this.costTotal = 0;
        info.unshift(this.t('已新建 {name} 会话 {id}', 'New {name} session {id}', { id: this.nativeSessionId }));
      }
    } catch (e) {
      if (e instanceof ResumeFailedError || e instanceof NoticeError) throw e;
      if (this.adapter.isNotLoggedIn(e)) throw new NoticeError(this.notLoggedIn);
      throw new NoticeError(this.t('无法打开 {name} 会话：{error}', 'Could not open the {name} session: {error}', { error: errText(e) }));
    }
    // The runtime reported (some of) its options as they are now.
    this.takeReport(res ?? {});
    const eff = this.effective;
    if (eff?.model) {
      // The runtime's own name for it (dsh's values are JSON pairs such as ["deepseek-official","deepseek-v4-flash"]).
      const model =
        selectOptions(byCategory(this.configOptions, 'model')).find((o) => o.value === eff.model)?.name ??
        this.models?.availableModels?.find((m) => m.modelId === eff.model)?.name ??
        eff.model;
      info.push(this.t('打开时模型：{model}', 'Model at open: {model}', { model }));
    }
    if (eff?.effort) info.push(this.t('打开时 Thinking：{effort}', 'Thinking at open: {effort}', { effort: eff.effort }));
    this.notePermission();
    if (this.permission) info.push(this.t('模式：{mode}', 'Mode: {mode}', { mode: this.permission.native }));
    const rules = this.adapter.ruleFiles.filter((f) => existsSync(join(this.cwd, f)));
    if (rules.length) {
      info.push(this.t('工作目录中有 {files}；{name} ACP 是否加载它们未确认', 'The working folder has {files}; whether {name} ACP loads them is not confirmed', { files: rules.join(', ') }));
    }
    this.info = info;
  }

  /** Exact session by id: `session/resume` when offered, else `session/load` (its history replay is ignored). */
  private async resume(rpc: JsonRpcProcess, id: string, mcpServers: unknown[], timeoutMs: number): Promise<any> {
    const fail = (e: unknown) => {
      if (this.adapter.isNotLoggedIn(e)) return new NoticeError(this.notLoggedIn);
      const msg = errText(e);
      return new ResumeFailedError(`${this.adapter.label} session ${id} could not be resumed: ${msg}`, /not found|unknown session|no such/i.test(msg) ? 'missing' : 'other', msg);
    };
    const params = { sessionId: id, cwd: this.cwd, mcpServers };
    if (this.caps?.sessionCapabilities?.resume) {
      try {
        return await rpc.request('session/resume', params, timeoutMs);
      } catch (e) {
        throw fail(e);
      }
    }
    if (this.caps?.loadSession) {
      this.replaying = true;
      try {
        return await rpc.request('session/load', params, timeoutMs);
      } catch (e) {
        throw fail(e);
      } finally {
        this.replaying = false;
      }
    }
    throw new ResumeFailedError(`${this.adapter.label} session ${id} could not be resumed: the runtime offers neither session/resume nor session/load`, 'other', null);
  }

  /** The value of an option as the runtime last reported it (config option, else the older model / mode interface). */
  private reported(kind: ConfigKind): string | null {
    const opt = byCategory(this.configOptions, kind === 'model' ? 'model' : kind === 'effort' ? 'thought_level' : 'mode');
    if (opt) return current(opt);
    return kind === 'model' ? (this.models?.currentModelId ?? null) : kind === 'mode' ? (this.modes?.currentModeId ?? null) : null;
  }

  /** The session mode id the runtime reports (`mode` config option, else the ACP session modes). */
  private currentMode(): string | null {
    const modeOpt = byCategory(this.configOptions, 'mode');
    return modeOpt ? current(modeOpt) : (this.modes?.currentModeId ?? null);
  }

  /** The mode the runtime reports, compared with the member's choice (if any). */
  private notePermission() {
    const modeOpt = byCategory(this.configOptions, 'mode');
    let native: string | null = null;
    if (modeOpt) {
      const v = current(modeOpt);
      native = selectOptions(modeOpt).find((o) => o.value === v)?.name ?? v;
    } else if (this.modes?.currentModeId) {
      native = this.modes.availableModes?.find((m) => m.id === this.modes!.currentModeId)?.name ?? this.modes.currentModeId;
    }
    if (this.processMode) {
      this.permission = this.adapter.processPermission(this.processMode, native);
      return;
    }
    if (!native) {
      const d = this.adapter.defaultPermission();
      if (d) this.permission = d;
      return;
    }
    const id = this.currentMode();
    const mode = (this.adapter.permissionModes as readonly string[]).includes(id ?? '') ? (id as PermissionMode) : null;
    this.permission = {
      native,
      mode,
      source: this.t('{name} 会话模式', '{name} session mode'),
      mismatch:
        this.wantMode && id !== this.wantMode
          ? this.t('{name} 报告的模式是 {got}，不是所选的 {want}', '{name} reports the mode {got}, not the chosen {want}', { got: id ?? '?', want: this.wantMode })
          : null,
      risky: RISKY_MODE.test(`${native} ${id ?? ''}`)
        ? this.t('{name} 报告的模式（{mode}）可能不经确认就执行工具', 'The mode {name} reports ({mode}) may run tools without asking', { mode: native })
        : null,
    };
  }

  catalogFromSession(): RuntimeModelCatalog | null {
    const modelOpt = byCategory(this.configOptions, 'model');
    const thought = byCategory(this.configOptions, 'thought_level');
    const efforts = selectOptions(thought).map((o) => o.value);
    const effort = current(thought);
    let models: RuntimeModelOption[] = [];
    let source: Localized;
    let def: string | null;
    if (modelOpt) {
      def = current(modelOpt);
      source = this.t('{name} ACP 会话选项（configOptions）', '{name} ACP session options (configOptions)');
      models = selectOptions(modelOpt).map((o) => ({
        id: o.value,
        displayName: o.name,
        description: o.description ?? null,
        efforts,
        defaultEffort: effort,
        isDefault: o.value === def,
      }));
    } else if (this.models?.availableModels?.length) {
      def = this.models.currentModelId ?? null;
      source = this.t('{name} ACP 会话模型列表（不稳定接口）', '{name} ACP session model list (unstable interface)');
      models = this.models.availableModels.map((m) => ({
        id: m.modelId,
        displayName: m.name ?? m.modelId,
        description: m.description ?? null,
        efforts,
        defaultEffort: effort,
        isDefault: m.modelId === def,
      }));
    } else return null;
    return {
      runtimeKind: this.adapter.kind,
      available: models.length > 0,
      source,
      error: models.length ? null : this.t('{name} 没有报告可选的模型', '{name} reported no model choice'),
      models,
      nativeDefault: { model: def, effort, efforts },
      permissionModes: this.modeAvailability(),
      fetchedAt: new Date().toISOString(),
    };
  }

  /** The session modes this runtime reports (`mode` config option, else ACP session modes), and skip-permissions. */
  private modeAvailability(): PermissionModeAvailability[] {
    const modeOpt = byCategory(this.configOptions, 'mode');
    const reported: string[] | null = modeOpt
      ? selectOptions(modeOpt).map((o) => o.value)
      : this.modes?.availableModes
        ? this.modes.availableModes.map((m) => m.id)
        : null;
    return this.adapter.permissionModes.map((id): PermissionModeAvailability => {
      if (this.adapter.isProcessMode(id)) {
        const problem = this.adapter.processModeProblem(id);
        return { id, available: !problem, reason: problem };
      }
      if (reported?.includes(id)) return { id, available: true, reason: null };
      return {
        id,
        available: false,
        reason: reported
          ? this.t('{name} 没有报告这个模式（它报告的是：{list}）', '{name} does not report this mode (it reports: {list})', { list: reported.join(', ') || '-' })
          : this.t('{name} 没有报告可选的模式', '{name} reports no modes'),
      };
    });
  }

  /**
   * Saves baselines before setting options. Complete responses can confirm linked changes; a legacy acknowledgement
   * confirms only its own option. Unassociated reports never transfer ownership, and ambiguous baselines block
   * "follow" before any restoration. An explicit choice can confirm a value without erasing that ambiguity.
   */
  private async applyConfig(input: TurnInput, sink: TurnEventSink): Promise<Localized | null> {
    const rpc = this.rpc!;
    const cfg = input.config ?? { model: null, effort: null, permissionMode: null };
    // A process mode (skip-permissions) is set when the process starts: the session mode follows the runtime's own setting.
    const want: Record<ConfigKind, string | null> = {
      model: cfg.model ?? null,
      effort: cfg.effort ?? null,
      mode: this.adapter.isProcessMode(cfg.permissionMode) ? null : (cfg.permissionMode ?? null),
    };
    const steps: { kind: ConfigKind; value: string; restore: boolean }[] = [];
    /** Options on "follow" that Harness Team changed (also on the side, by a request in this loop): restored. */
    const addRestores = () => {
      for (const kind of CONFIG_KINDS) {
        if (!want[kind] && this.overridden[kind] && this.baseline[kind] && !steps.some((s) => s.kind === kind)) steps.push({ kind, value: this.baseline[kind]!, restore: true });
      }
    };
    for (const kind of CONFIG_KINDS) {
      const w = want[kind];
      if (w) steps.push({ kind, value: w, restore: false });
    }
    addRestores();
    this.wantMode = want.mode;
    let changed = false;
    let modeChanged = false;
    const category = (kind: ConfigKind) => (kind === 'model' ? 'model' : kind === 'effort' ? 'thought_level' : 'mode');
    const what = (kind: ConfigKind) => (kind === 'model' ? this.t('模型', 'model') : kind === 'effort' ? 'Thinking' : this.t('模式', 'mode'));
    const nowOf = (kind: ConfigKind) => this.reported(kind);
    const snapshot = (): Record<ConfigKind, string | null> => ({ model: nowOf('model'), effort: nowOf('effort'), mode: nowOf('mode') });
    const notOffered = (st: { kind: ConfigKind; value: string; restore: boolean }) =>
      st.restore
        ? this.t('{name} 当前不提供{what}“{value}”，无法恢复为 Harness Team 改动之前的值，本回合未运行', '{name} does not currently offer the {what} “{value}”, so the value from before Harness Team changed it cannot be restored; this turn did not run', {
            what: what(st.kind),
            value: st.value,
          })
        : this.t('{name} 当前不提供{what}“{value}”', '{name} does not currently offer the {what} “{value}”', {
            what: st.kind === 'model' ? this.t('模型', 'model') : st.kind === 'effort' ? this.t(' Thinking 级别', 'Thinking level') : this.t('模式', 'mode'),
            value: st.value,
          });
    /** Before a request that sets `kind`: see above. Throws (nothing noted, nothing sent) when it cannot be saved. */
    const begin = (kind: ConfigKind) => {
      const before = snapshot();
      const reports = { ...this.reportGen };
      const known = Object.fromEntries(CONFIG_KINDS.map((k) => [k, !this.unsure[k] && before[k] !== null])) as Record<ConfigKind, boolean>;
      const prev = { baseline: { ...this.baseline }, overridden: { ...this.overridden }, maybe: { ...this.maybe }, maybeAt: { ...this.maybeAt } };
      // The durable intent must not claim that a request was sent or confirmed. Existing ambiguities stay intact.
      const fresh: ConfigKind[] = [];
      for (const k of CONFIG_KINDS) {
        if (k in this.maybe || (k !== kind && !known[k] && !this.overridden[k])) continue;
        this.maybe[k] = known[k] ? before[k] : null;
        this.maybeAt[k] = { gen: this.reportGen[k], linked: false, pending: true };
        fresh.push(k);
      }
      try {
        this.persistState(true);
      } catch (e) {
        this.baseline = prev.baseline;
        this.overridden = prev.overridden;
        this.maybe = prev.maybe;
        this.maybeAt = prev.maybeAt;
        throw e;
      }
      return { before, fresh, reports, known };
    };
    const unconfirmed = (m: ReturnType<typeof begin>) => {
      for (const k of CONFIG_KINDS) if (m.known[k]) this.unsure[k] = true;
      for (const k of m.fresh) {
        const at = this.maybeAt[k];
        if (at) at.pending = false;
      }
    };
    const confirmed = (m: ReturnType<typeof begin>, kind: ConfigKind) => {
      changed = true;
      if (kind === 'mode' || nowOf('mode') !== m.before.mode) modeChanged = true;
      // Even a previously chosen option may have changed on the side. An acknowledgement alone cannot confirm it.
      for (const k of CONFIG_KINDS) {
        if ((k === kind || m.known[k]) && this.reportGen[k] <= m.reports[k]) this.unsure[k] = true;
      }
      if (nowOf(kind) === null) this.unsure[kind] = true;
      for (const k of m.fresh) {
        const at = this.maybeAt[k];
        if (k in this.maybe && at) {
          at.linked = m.known[k] && !this.unsure[k] && this.reportGen[k] > at.gen;
          at.pending = false;
        }
      }
      this.settleMaybe();
      this.persistState();
      addRestores();
    };
    const ambiguousFollow = (): Localized | null => {
      this.settleMaybe();
      for (const k of CONFIG_KINDS) {
        if (want[k]) continue;
        if (k in this.maybe) {
          const before = this.maybe[k] ?? null;
          const at = this.maybeAt[k];
          if (this.unsure[k] || at?.pending || (at && this.reportGen[k] <= at.gen)) {
            return this.t(
              '{name} 未确认设置请求之后的{what}，本回合未运行。可在 {name} 中改回 {before} 并让它报告当前值，或新建会话后跟随原生设置。显式选值仍须确认全部所选项，且不会清除恢复基线的歧义。',
              '{name} has not confirmed the current {what} after an option request; this turn did not run. Set it back to {before} in {name} and have it report the value, or start a new session following the runtime. Explicit choices still require every chosen value to be confirmed and do not clear an ambiguous restore baseline.',
              { what: what(k), before: before ?? '-' },
            );
          }
          return this.t(
            '{name} 报告的{what}是 {now}；之前设置请求前是 {before}，无法确定是谁改的，本回合未运行。可在 {name} 中改回 {before} 并让它报告当前值，或新建会话后跟随原生设置。显式选值不会清除恢复基线的歧义。',
            '{name} reports the {what} {now}; before an earlier option request it was {before}, and who changed it is not known, so this turn did not run. Set it back to {before} in {name} and have it report the value, or start a new session following the runtime. Explicit choices do not clear an ambiguous restore baseline.',
            { what: what(k), now: nowOf(k) ?? '-', before: before ?? '-' },
          );
        }
        if (this.overridden[k] && this.baseline[k] === null) {
          return this.t(
            '{name} 没有报告 Harness Team 改动之前的{what}，无法确认如何恢复，本回合未运行。请新建会话后跟随原生设置。',
            '{name} did not report the {what} from before Harness Team changed it, so its restoration cannot be confirmed; this turn did not run. Start a new session following the runtime.',
            { what: what(k) },
          );
        }
      }
      return null;
    };
    const initialAmbiguity = ambiguousFollow();
    if (initialAmbiguity) return initialAmbiguity;
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i]!;
      if (st.restore) {
        const ambiguity = ambiguousFollow();
        if (ambiguity) return ambiguity;
        // An intervening native report may have relinquished this queued restoration.
        if (!this.overridden[st.kind]) continue;
      }
      const opt = byCategory(this.configOptions, category(st.kind));
      if (opt) {
        if (!this.unsure[st.kind] && !(st.kind in this.maybe) && current(opt) === st.value) continue;
        if (!selectOptions(opt).some((o) => o.value === st.value)) return notOffered(st);
        const m = begin(st.kind);
        let res: any;
        try {
          res = await rpc.request<any>('session/set_config_option', { sessionId: this.nativeSessionId, configId: opt.id, value: st.value }, 30_000);
        } catch (e) {
          // No confirmed answer: it may still have been applied, and may have changed other options with it.
          this.unsure = { model: true, effort: true, mode: true };
          unconfirmed(m);
          return this.t('{name} 拒绝设置 {what}：{error}', '{name} refused to set the {what}: {error}', { what: opt.name ?? opt.id, error: errText(e) });
        }
        // The response must carry the full option state (ACP); without it nothing confirms the value, so no turn runs.
        if (!Array.isArray(res?.configOptions)) {
          this.unsure = { model: true, effort: true, mode: true };
          unconfirmed(m);
          return this.t('{name} 设置{what}后没有返回当前选项，无法确认，本回合未运行', '{name} did not return the current options after setting the {what}, so it cannot be confirmed; this turn did not run', {
            what: what(st.kind),
          });
        }
        this.takeReport({ configOptions: res.configOptions });
        confirmed(m, st.kind);
        this.notePermission();
        continue;
      } else if (st.kind === 'model' && this.models?.availableModels) {
        if (!this.unsure.model && !('model' in this.maybe) && this.models.currentModelId === st.value) continue;
        if (!this.models.availableModels.some((m) => m.modelId === st.value)) return notOffered(st);
        const m = begin('model');
        try {
          await rpc.request('session/set_model', { sessionId: this.nativeSessionId, modelId: st.value }, 30_000);
          // The acknowledgement confirms only the model; other options need their own current report.
          this.models = { ...this.models, currentModelId: st.value };
          this.unsure.model = false;
          this.reportGen.model++;
        } catch (e) {
          // A failed request can also have changed the other known options.
          this.unsure.model = true;
          unconfirmed(m);
          return this.t('{name} 拒绝设置模型：{error}', '{name} refused to set the model: {error}', { error: errText(e) });
        }
        confirmed(m, 'model');
        this.notePermission();
      } else if (st.kind === 'mode' && this.modes?.availableModes) {
        if (!this.unsure.mode && !('mode' in this.maybe) && this.modes.currentModeId === st.value) continue;
        if (!this.modes.availableModes.some((m) => m.id === st.value)) return notOffered(st);
        const m = begin('mode');
        try {
          await rpc.request('session/set_mode', { sessionId: this.nativeSessionId, modeId: st.value }, 30_000);
          // session/set_mode answers with nothing (a current_mode_update may follow): its success is the confirmation.
          this.modes = { ...this.modes, currentModeId: st.value };
          this.unsure.mode = false;
          this.reportGen.mode++;
        } catch (e) {
          this.unsure.mode = true;
          unconfirmed(m);
          return this.t('{name} 拒绝设置模式：{error}', '{name} refused to set the mode: {error}', { error: errText(e) });
        }
        confirmed(m, 'mode');
        this.notePermission();
      } else if (st.restore) {
        return notOffered(st);
      } else {
        return st.kind === 'model'
          ? this.t('{name} 没有报告可选的模型，无法使用所选模型“{value}”', '{name} reported no model choice, so the chosen model “{value}” cannot be used', { value: st.value })
          : st.kind === 'effort'
            ? this.t('{name} 没有报告 Thinking 级别，无法使用所选级别“{value}”', '{name} reported no Thinking levels, so the chosen level “{value}” cannot be used', { value: st.value })
            : this.t('{name} 没有报告可选的模式，无法使用所选模式“{value}”', '{name} reported no modes, so the chosen mode “{value}” cannot be used', { value: st.value });
      }
    }
    // Setting one option can reset another (a Thinking level that changes the model): every chosen or restored value
    // is checked against the final state the runtime reported, and so are the model and mode on "follow" that a request
    // here changed on the side. Any difference stops the turn before the prompt.
    const finalAmbiguity = ambiguousFollow();
    if (finalAmbiguity) return finalAmbiguity;
    const expected = new Map<ConfigKind, string>();
    for (const st of steps) if (!st.restore || this.overridden[st.kind]) expected.set(st.kind, st.value);
    for (const k of CONFIG_KINDS) {
      if (!want[k] && this.overridden[k] && this.baseline[k] !== null && !expected.has(k)) expected.set(k, this.baseline[k]!);
    }
    for (const [k, value] of expected) {
      const now = nowOf(k);
      if (this.unsure[k]) {
        return this.t(
          '{name} 设置选项后未确认当前{what}，无法确认所选值 {value}，本回合未运行。请让运行时报告当前选项，或新建会话后跟随原生设置。',
          '{name} has not confirmed the current {what} after setting an option, so the chosen value {value} cannot be confirmed; this turn did not run. Have the runtime report its current options, or start a new session following the runtime.',
          { what: what(k), value },
        );
      }
      if (now !== value) {
        return this.t('{name} 报告的{what}（{now}）与所选（{value}）不一致，本回合未运行', '{name} reports the {what} {now}, not the chosen {value}; this turn did not run', {
          what: what(k),
          now: now ?? '?',
          value,
        });
      }
    }
    let save = false;
    // An option back on "follow" that has the runtime's own value again (or whose value the runtime never reported)
    // is not changed any more.
    for (const kind of CONFIG_KINDS) {
      if (want[kind] || !this.overridden[kind]) continue;
      if (this.baseline[kind] === null || expected.get(kind) === this.baseline[kind]) {
        this.overridden[kind] = false;
        this.baseline[kind] = null;
        this.applied[kind] = null;
        save = true;
      }
    }
    if (save) this.persistState();
    this.notePermission();
    if (changed) {
      const eff = this.effective;
      if (eff) sink({ type: 'config.effective', effective: { ...eff, source: this.t('{name} session/set_config_option 响应', '{name} session/set_config_option response') } });
    }
    if (this.permission && modeChanged) sink({ type: 'permission.effective', permission: this.permission });
    return null;
  }

  /** What an earlier process reported is not this one's state: every option is unknown until this one reports it. */
  private forgetReports() {
    this.configOptions = [];
    this.models = null;
    this.modes = null;
    this.unsure = { model: true, effort: true, mode: true };
    // A note waits for this process's reports, and an answer the earlier process gave no longer settles it.
    this.maybeAt = {};
    for (const k of CONFIG_KINDS) if (k in this.maybe) this.maybeAt[k] = { gen: this.reportGen[k], linked: false };
  }

  /**
   * Takes the option state the runtime reported (an open answer, a set_config_option answer, config_option_update)
   * and marks as known only the options it covers: `models` / `modes` (the older interface) the model / mode; a full
   * `configOptions` list Thinking, and the model and mode when it has them or the older interface is not used.
   */
  private takeReport(r: { configOptions?: unknown; models?: unknown; modes?: unknown }) {
    if (r.models && typeof r.models === 'object') this.models = r.models as UnstableModels;
    if (r.modes && typeof r.modes === 'object') this.modes = r.modes as ModeState;
    const list = Array.isArray(r.configOptions) ? (r.configOptions as ConfigOption[]) : null;
    if (list) this.configOptions = list;
    const inList = (c: string) => !!list && !!byCategory(list, c);
    const known = (k: ConfigKind) => {
      this.unsure[k] = false;
      this.reportGen[k]++;
    };
    if (list) known('effort');
    if (inList('model') || (r.models && !byCategory(this.configOptions, 'model')) || (list && !this.models)) known('model');
    if (inList('mode') || (r.modes && !byCategory(this.configOptions, 'mode')) || (list && !this.modes)) known('mode');
    this.settleMaybe();
  }

  /**
   * A report within a confirmed request can establish a linked change. Later reports can only establish that an
   * ambiguous option is back at its original value; a different value remains ambiguous. Reports received while a
   * request is pending wait for its answer, including an unchanged report followed by a change.
   */
  private settleMaybe() {
    let save = false;
    for (const k of CONFIG_KINDS) {
      if (!(k in this.maybe) || this.unsure[k]) continue;
      const at = this.maybeAt[k];
      if (at?.pending || (at && this.reportGen[k] <= at.gen)) continue;
      const before = this.maybe[k] ?? null;
      if (this.reported(k) !== before && !at?.linked) continue;
      if (this.reported(k) !== before && !this.overridden[k]) {
        this.overridden[k] = true;
        this.baseline[k] = before;
      }
      if (this.overridden[k] && at?.linked) this.applied[k] = this.reported(k);
      delete this.maybe[k];
      delete this.maybeAt[k];
      save = true;
    }
    for (const k of CONFIG_KINDS) {
      if (!this.overridden[k] || k in this.maybe || this.unsure[k] || this.applied[k] === null) continue;
      const now = this.reported(k);
      if (now === null || now === this.applied[k]) continue;
      // A fresh value outside a setting request belongs to the user. It also becomes the next HT choice's baseline.
      this.overridden[k] = false;
      this.baseline[k] = null;
      this.applied[k] = null;
      save = true;
    }
    if (save) this.persistState();
  }

  /**
   * What Harness Team changed in this native session and the runtime's values before that, saved with the binding so
   * that "follow" still restores them after the session is opened again (another process, a Core restart). Version 3
   * also keeps the last applied value; a differing native report relinquishes that option without restoring it.
   */
  adapterState(): string | null {
    const noted = Object.keys(this.maybe).length > 0;
    if (!this.nativeSessionId || (!CONFIG_KINDS.some((k) => this.overridden[k]) && !noted && this.costTotal === null)) return null;
    return JSON.stringify({ v: 3, sessionId: this.nativeSessionId, baseline: this.baseline, applied: this.applied, overridden: this.overridden, maybe: this.maybe, cost: this.costTotal });
  }

  /**
   * Hands adapterState() to the Core. `critical`: before an option request goes out; if saving fails, the request
   * is not sent (and the turn does not run), so a crash can never lose what Harness Team changed.
   */
  private persistState(critical = false) {
    if (!this.hooks.saveState || !this.nativeSessionId) return;
    try {
      this.hooks.saveState(this.nativeSessionId, this.adapterState());
    } catch (e) {
      if (critical) {
        throw new NoticeError(this.t('无法保存该会话的选项状态，本回合未运行：{error}', 'Could not save this session’s option state; this turn did not run: {error}', { error: errText(e) }));
      }
    }
  }

  /** The state adapterState() saved; used only when the same native session is resumed. */
  restoreState(saved: string | null | undefined) {
    this.saved = null;
    if (!saved) return;
    try {
      const p = JSON.parse(saved);
      if ((p?.v !== 1 && p?.v !== 2 && p?.v !== 3) || typeof p.sessionId !== 'string') return;
      const baseline = { ...EMPTY_CONFIG };
      const applied = { ...EMPTY_CONFIG };
      const overridden = { model: false, effort: false, mode: false };
      const maybe: Partial<Record<ConfigKind, string | null>> = {};
      for (const k of CONFIG_KINDS) {
        baseline[k] = typeof p.baseline?.[k] === 'string' ? p.baseline[k] : null;
        overridden[k] = p.overridden?.[k] === true;
        const m = p.maybe?.[k];
        if (p.maybe && Object.hasOwn(p.maybe, k) && (typeof m === 'string' || m === null)) maybe[k] = m;
        applied[k] = p.v === 3 && typeof p.applied?.[k] === 'string' && p.applied[k] ? p.applied[k] : null;
        // Older states cannot distinguish the last HT value from a later user change.
        if (overridden[k] && applied[k] === null) {
          if (!(k in maybe)) maybe[k] = baseline[k];
          overridden[k] = false;
          baseline[k] = null;
        }
      }
      const cost = typeof p.cost === 'number' && Number.isFinite(p.cost) && p.cost >= 0 ? p.cost : null;
      this.saved = { sessionId: p.sessionId, baseline, applied, overridden, maybe, cost };
    } catch {
      // unreadable: treated as nothing saved
    }
  }

  async runTurn(input: TurnInput, sink: TurnEventSink, signal: AbortSignal): Promise<TurnResult> {
    if (this.running) return { status: 'failed', error: `this ${this.adapter.label} session is already running a turn` };
    if (this.unsettled) {
      return {
        status: 'failed',
        error: this.t('{name} 尚未确认该会话的上一回合已结束，本消息未发送', '{name} has not confirmed that the previous turn of this session ended; this message was not sent'),
      };
    }
    if (signal.aborted) return { status: 'interrupted' };
    if (input.command) return { status: 'failed', error: this.t('{name} 成员不支持斜杠命令', '{name} members do not support slash commands') };
    this.running = true;
    const chosen = input.config?.permissionMode;
    const wantProcess = this.adapter.isProcessMode(chosen) ? chosen : null;
    try {
      if (!this.rpc?.running) {
        // The ACP process is gone: start it again and resume this exact session (never a new or "latest" one).
        const id = this.nativeSessionId;
        await this.rpc?.close().catch(() => {});
        this.processMode = wantProcess;
        await this.connect(id);
        sink(noticeEvent(this.t('{name} ACP 进程已重启，已按 id 恢复会话 {id}', 'The {name} ACP process restarted; session {id} was resumed by id', { id })));
      }
      if (wantProcess !== this.processMode) {
        // The mode belongs to the process: start this member's process again in the chosen mode and resume this exact
        // session by id. Nothing else is restarted.
        const id = this.nativeSessionId;
        const before = this.processMode;
        await this.rpc?.close().catch(() => {});
        this.processMode = wantProcess;
        await this.connect(id);
        sink(
          noticeEvent(
            wantProcess
              ? this.t('已以 {flag} 重启该成员的 {name} ACP 进程，并按 id 恢复会话 {id}', 'Restarted this member’s {name} ACP process with {flag} and resumed session {id} by id', { id, flag: this.adapter.processModeLabel(wantProcess) })
              : this.t('已不带 {flag} 重启该成员的 {name} ACP 进程，并按 id 恢复会话 {id}', 'Restarted this member’s {name} ACP process without {flag} and resumed session {id} by id', { id, flag: this.adapter.processModeLabel(before!) }),
          ),
        );
      }
      if (signal.aborted) return { status: 'interrupted' };
      const configError = await this.applyConfig(input, sink);
      if (configError) return { status: 'failed', error: configError };
      // Stopped while the session was prepared: the prompt is not sent.
      if (signal.aborted) return { status: 'interrupted' };
      if (this.permission) sink({ type: 'permission.effective', permission: this.permission });
      const turn = new AcpTurn(this.adapter, this.rpc!, this.nativeSessionId, `${this.nativeSessionId}:${++this.turnSeq}`, sink, signal, this.adapter.interruptTimeoutMs, this.cwd);
      turn.language = this.language;
      this.costCounted = this.costTotal !== null;
      this.lateZero = false;
      this.turn = turn;
      const model = this.effective?.model ?? null;
      const result = await turn.run(this.promptBlocks(input.text, input.attachments ?? []));
      // A turn with no usage at all: a cost of 0 reported after it still records it (tokens unknown).
      this.lateZero = this.costCounted && !result.usage?.length;
      if (result.usage) result.usage = result.usage.map((u) => ({ ...u, model: u.model ?? model }));
      const settled = result.nativeSettled;
      if (settled) {
        this.unsettled = settled;
        void settled.then(() => {
          if (this.unsettled === settled) this.unsettled = null;
        });
      }
      return result;
    } catch (e) {
      if (e instanceof NoticeError) return { status: 'failed', error: e.notice };
      return { status: 'failed', error: errText(e) };
    } finally {
      this.turn = null;
      this.running = false;
    }
  }

  /** Text, plus images as ACP image blocks when the runtime declares image prompts (other files: by path in the text). */
  private promptBlocks(text: string, attachments: TurnAttachment[]): unknown[] {
    const blocks: unknown[] = [{ type: 'text', text }];
    if (!this.caps?.promptCapabilities?.image) return blocks;
    for (const a of attachments) {
      if (a.kind !== 'image') continue;
      try {
        blocks.push({ type: 'image', mimeType: a.mime, data: readFileSync(a.path).toString('base64') });
      } catch {
        // The text names the file; a missing copy is not fatal.
      }
    }
    return blocks;
  }

  respondApproval(nativeRequestId: string, decision: ApprovalDecision): ApprovalAnswer {
    if (!this.turn) return { ok: false, error: NO_TURN };
    return this.turn.respond(nativeRequestId, decision);
  }

  private onNotification(method: string, p: any) {
    if (method !== 'session/update') return;
    if (p?.sessionId && this.nativeSessionId && p.sessionId !== this.nativeSessionId) return;
    const u = p?.update ?? {};
    // A cost report while a resumed session replays its history is still the session total: it sets the baseline.
    if (u.sessionUpdate === 'usage_update') return this.noteCost(u.cost);
    if (this.replaying) return;
    switch (u.sessionUpdate) {
      case 'config_option_update':
        if (Array.isArray(u.configOptions)) {
          this.takeReport({ configOptions: u.configOptions });
          this.notePermission();
          const eff = this.effective;
          if (eff) this.turn?.emitPublic({ type: 'config.effective', effective: { ...eff, source: this.t('{name} config_option_update', '{name} config_option_update') } });
          if (this.permission) this.turn?.emitPublic({ type: 'permission.effective', permission: this.permission });
        }
        return;
      case 'current_mode_update':
        if (typeof u.currentModeId === 'string') {
          this.modes = { ...(this.modes ?? {}), currentModeId: u.currentModeId };
          if (!byCategory(this.configOptions, 'mode')) {
            this.unsure.mode = false;
            this.reportGen.mode++;
            this.settleMaybe();
          }
          this.notePermission();
          if (this.permission) this.turn?.emitPublic({ type: 'permission.effective', permission: this.permission });
        }
        return;
      default:
        this.turn?.onUpdate(u);
    }
  }

  /**
   * usage_update `cost` ({amount, currency}, the session total): the running turn gets the increase since the last
   * report. A report while the session opens (or replays) only sets the starting total. An increase while no turn
   * runs came after the turn that just ended: it goes to that turn (the Core's lateUsage), at once, so a close or a
   * restart cannot lose it. Without that callback (a model-list probe) it stays in the difference. A total lower than
   * before (the runtime reset it) becomes the new start. An increase while a turn runs goes to that turn: ACP does not
   * say which turn a cost belongs to, so the late cost of a turn that arrives once the next one runs is counted there.
   * A turn that began while the total was not known (a resumed session before its first report) has no known cost:
   * reports then only set the start.
   */
  private noteCost(cost: any) {
    const amount = cost?.amount;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || String(cost?.currency ?? '').toUpperCase() !== 'USD') return;
    const before = this.costTotal;
    if (before === null || this.connecting || amount < before || !this.costCounted) {
      this.costTotal = amount;
      return;
    }
    // An unchanged total is a reported cost of 0: for the running turn (the turn is still counted), or once for the
    // turn that just ended if it reported no usage at all.
    if (amount === before) {
      if (this.turn?.addCost(0)) return;
      if (!this.lateZero || !this.hooks.lateUsage) return;
      this.lateZero = false;
      try {
        this.hooks.lateUsage({ model: this.effective?.model ?? null, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: 0, tokensUnknown: true });
      } catch {
        // usage is informational
      }
      return;
    }
    if (this.turn?.addCost(amount - before)) {
      this.costTotal = amount;
      return;
    }
    if (!this.hooks.lateUsage) return;
    this.costTotal = amount;
    this.lateZero = false;
    try {
      this.hooks.lateUsage({ model: this.effective?.model ?? null, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: amount - before, tokensUnknown: true });
    } catch {
      // usage is informational
    }
    this.persistState();
  }

  private onServerRequest(rpc: JsonRpcProcess, id: RpcId, method: string, p: any) {
    // The current turn handles its own failures (onPermission never throws); only answering a process that is going
    // away can fail here, and that process is not waited for.
    if (method === 'session/request_permission') {
      if (rpc === this.rpc && p?.sessionId === this.nativeSessionId && this.turn && this.turn.onPermission(id, p)) return;
      // No turn of ours is running on this process (or the process is being closed): nothing may be approved.
      try {
        rpc.respond(id, { outcome: { outcome: 'cancelled' } });
      } catch {}
      return;
    }
    let ext: ExtensionReply | null = null;
    try {
      ext = this.adapter.extensionRequest(method, p);
    } catch {
      ext = null;
    }
    if (ext?.kind === 'approval') {
      // Shown only for the turn running on this process; otherwise nothing may be accepted.
      if (rpc === this.rpc && this.turn && this.turn.onExtensionApproval(id, method, ext)) return;
      try {
        rpc.respond(id, ext.answer('cancelled'));
      } catch {}
      return;
    }
    if (ext) {
      try {
        rpc.respond(id, ext.result);
      } catch {}
      if (ext.activity && rpc === this.rpc) this.turn?.noteActivity(String(id), ext.activity.title, ext.activity.detail);
      return;
    }
    // fs / terminal were not offered in clientCapabilities.
    try {
      rpc.respondError(id, -32601, `Harness Team does not provide ${method}`);
    } catch {}
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.adapter.forget(this);
    await this.rpc?.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------------------------
// One prompt turn

interface ToolState {
  title: string;
  kind: string | null;
  status: string | null;
  content: any[];
  rawInput: unknown;
  rawOutput: unknown;
  locations: { path: string }[];
}

interface PendingPermission {
  id: RpcId;
  allow: string | null;
  reject: string | null;
  /** An extension request shown as an approval (ExtensionReply 'approval'): builds its reply. */
  answer?: (decision: 'allow' | 'reject' | 'cancelled') => unknown;
}

/** The reply that cancels a pending request without approving anything. */
function cancelReply(p: PendingPermission): unknown {
  return p.answer ? p.answer('cancelled') : { outcome: { outcome: 'cancelled' } };
}

const ACTIVITY_OF: Record<string, ActivityKind> = {
  execute: 'command',
  edit: 'fileChange',
  delete: 'fileChange',
  move: 'fileChange',
  fetch: 'webSearch',
};

class AcpTurn {
  language: () => AgentLanguage = () => 'zh';
  private readonly pending = new Map<string, PendingPermission>();
  private readonly tools = new Map<string, ToolState>();
  private text = '';
  private textSeg = 0;
  private finished = false;
  private finish!: (r: TurnResult) => void;
  private readonly done: Promise<TurnResult>;
  private nativeEnded = false;
  private settleNative!: () => void;
  private readonly nativeSettled = new Promise<void>((r) => (this.settleNative = r));
  private interruptTimer: NodeJS.Timeout | null = null;
  private cancelling = false;
  /** Why this turn was cancelled by Harness Team itself (a request it could not show): the turn then failed. */
  private failure: NoticeText | null = null;
  /** USD the runtime reported for this turn (usage_update cost increases), null when it reported none. */
  private costUsd: number | null = null;

  private readonly rt: AcpAdapter;
  private readonly rpc: JsonRpcProcess;
  private readonly sessionId: string;
  private readonly turnId: string;
  private readonly sink: TurnEventSink;
  private readonly signal: AbortSignal;
  private readonly interruptTimeoutMs: number;
  private readonly cwd: string;

  constructor(rt: AcpAdapter, rpc: JsonRpcProcess, sessionId: string, turnId: string, sink: TurnEventSink, signal: AbortSignal, interruptTimeoutMs: number, cwd: string) {
    this.rt = rt;
    this.rpc = rpc;
    this.sessionId = sessionId;
    this.turnId = turnId;
    this.sink = sink;
    this.signal = signal;
    this.interruptTimeoutMs = interruptTimeoutMs;
    this.cwd = cwd;
    this.done = new Promise((r) => (this.finish = r));
  }

  private t(zh: string, en: string, params?: Record<string, NoticeValue | null | undefined>): NoticeText {
    return this.rt.t(zh, en, params);
  }

  private get notLoggedIn(): NoticeText {
    return this.rt.notLoggedIn;
  }

  async run(prompt: unknown[]): Promise<TurnResult> {
    if (this.signal.aborted) return { status: 'interrupted' };
    const onAbort = () => this.cancel();
    this.signal.addEventListener('abort', onAbort, { once: true });
    try {
      this.emit({ type: 'turn.started', nativeTurnId: this.turnId });
      this.rpc
        .request<any>('session/prompt', { sessionId: this.sessionId, prompt }, 0)
        .then((res) => {
          this.markNativeEnded();
          this.flushText();
          const stop = String(res?.stopReason ?? '');
          const usage = acpUsage(res?.usage);
          if (this.failure) return this.end({ status: 'failed', error: this.failure, usage });
          if (stop === 'cancelled') return this.end({ status: 'interrupted', usage });
          if (stop === 'refusal') return this.end({ status: 'failed', error: this.t('{name} 拒绝继续（refusal）', '{name} refused to continue (refusal)'), usage });
          if (stop === 'max_tokens' || stop === 'max_turn_requests') {
            this.emit(noticeEvent(this.t('{name} 因 {reason} 结束了本回合', '{name} ended this turn because of {reason}', { reason: stop })));
          }
          this.end({ status: 'completed', usage });
        })
        .catch((e) => {
          this.markNativeEnded();
          this.flushText();
          if (this.failure) return this.end({ status: 'failed', error: this.failure });
          this.end({ status: 'failed', error: this.rt.isNotLoggedIn(e) ? this.notLoggedIn : this.t('session/prompt 失败：{error}', 'session/prompt failed: {error}', { error: errText(e) }) });
        });
      return await this.done;
    } finally {
      this.signal.removeEventListener('abort', onAbort);
      if (this.interruptTimer) clearTimeout(this.interruptTimer);
    }
  }

  /** The ACP process exited (crash, kill): the native turn is over, and failed. */
  processGone(reason: string) {
    this.markNativeEnded();
    this.end({ status: 'failed', error: this.t('{name} ACP 进程已退出：{reason}', 'The {name} ACP process exited: {reason}', { reason }) });
  }

  emitPublic(ev: TurnEvent) {
    this.emit(ev);
  }

  /** False when this turn has already ended (the amount is then left for the next turn). */
  addCost(usd: number): boolean {
    if (this.finished) return false;
    this.costUsd = (this.costUsd ?? 0) + usd;
    return true;
  }

  private emit(ev: TurnEvent) {
    if (!this.finished) this.sink(ev);
  }

  private markNativeEnded() {
    if (this.nativeEnded) return;
    this.nativeEnded = true;
    this.settleNative();
  }

  private end(r: TurnResult) {
    if (this.finished) return;
    for (const [key, p] of this.pending) {
      this.rpc.respond(p.id, cancelReply(p));
      this.sink({ type: 'approval.resolved', nativeRequestId: key, decision: 'cancelled' });
    }
    this.pending.clear();
    this.finished = true;
    if (this.costUsd !== null) {
      // The reported cost goes on the first usage record; a turn that reported a cost but no tokens (a failed or
      // interrupted prompt, or a runtime without token usage) still records it, with zero tokens.
      r = r.usage?.length
        ? { ...r, usage: r.usage.map((u, i) => (i === 0 ? { ...u, costUsd: this.costUsd } : u)) }
        : { ...r, usage: [{ model: null, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: this.costUsd, tokensUnknown: true }] };
    }
    if (r.usage === undefined) delete r.usage;
    this.finish(this.nativeEnded ? r : { ...r, nativeSettled: this.nativeSettled });
  }

  /** session/cancel: pending permission requests are answered "cancelled" first (never approved), then the end is awaited. */
  private cancel() {
    if (this.finished || this.cancelling) return;
    this.cancelling = true;
    const answered = [...this.pending.entries()];
    this.pending.clear();
    for (const [, p] of answered) {
      try {
        this.rpc.respond(p.id, cancelReply(p));
      } catch {}
    }
    try {
      this.rpc.notify('session/cancel', { sessionId: this.sessionId });
    } catch {}
    this.interruptTimer = setTimeout(
      () =>
        this.end({
          status: 'failed',
          error: this.failure ?? this.t(
            '已请求中断，但 {ms} ms 内未收到 {name} 的结束确认；原生回合可能仍在运行，确认结束前不会向该成员或同一工作目录派发新任务',
            'You asked to interrupt, but {name} did not confirm the end within {ms} ms; the native turn may still be running, and nothing new goes to this member or the same working folder until it has ended',
            { ms: this.interruptTimeoutMs },
          ),
        }),
      this.interruptTimeoutMs,
    );
    for (const [key] of answered) {
      try {
        this.emit({ type: 'approval.resolved', nativeRequestId: key, decision: 'cancelled' });
      } catch {}
    }
  }

  respond(key: string, decision: ApprovalDecision): ApprovalAnswer {
    const p = this.pending.get(key);
    if (this.finished || !p) return { ok: false, error: REQUEST_GONE };
    if (this.signal.aborted || this.cancelling) return { ok: false, error: REQUEST_INTERRUPTED };
    if (decision === 'allow_session' || (decision === 'allow' && !p.allow)) return { ok: false, error: unsupportedDecision('session/request_permission', decision) };
    this.pending.delete(key);
    if (p.answer) {
      const allowed = decision === 'allow';
      this.rpc.respond(p.id, p.answer(allowed ? 'allow' : 'reject'));
      const native = (allowed ? p.allow : p.reject) ?? decision;
      this.emit({ type: 'approval.resolved', nativeRequestId: key, decision: native });
      return { ok: true, nativeDecision: native };
    }
    if (decision === 'allow') {
      this.rpc.respond(p.id, { outcome: { outcome: 'selected', optionId: p.allow } });
      this.emit({ type: 'approval.resolved', nativeRequestId: key, decision: p.allow });
      return { ok: true, nativeDecision: p.allow! };
    }
    if (p.reject) this.rpc.respond(p.id, { outcome: { outcome: 'selected', optionId: p.reject } });
    else this.rpc.respond(p.id, { outcome: { outcome: 'cancelled' } });
    const native = p.reject ?? 'cancelled';
    this.emit({ type: 'approval.resolved', nativeRequestId: key, decision: native });
    return { ok: true, nativeDecision: native };
  }

  /**
   * A native permission request: shown in the chat; only "allow once" / "reject once" are ever chosen. Never throws:
   * a request that cannot be shown (the chat could not store it) could never be answered, so it is answered
   * "cancelled" at once and the turn is cancelled and fails with the reason.
   */
  onPermission(id: RpcId, p: any): boolean {
    if (this.finished || this.signal.aborted || this.cancelling) return false;
    const key = String(id);
    try {
      this.showPermission(id, key, p);
    } catch (e) {
      this.pending.delete(key);
      try {
        this.rpc.respond(id, { outcome: { outcome: 'cancelled' } });
      } catch {}
      this.failure = this.t('无法在聊天中显示 {name} 的审批请求（{error}）：已拒绝该请求并取消本回合', 'Could not show the {name} approval request in the chat ({error}): the request was refused and the turn cancelled', {
        error: errText(e),
      });
      this.cancel();
    }
    return true;
  }

  /**
   * A runtime-specific request shown as an approval card (a plan to accept, ...). Like onPermission: a card that cannot
   * be shown is answered "cancelled" and the turn fails with the reason.
   */
  onExtensionApproval(id: RpcId, method: string, ext: Extract<ExtensionReply, { kind: 'approval' }>): boolean {
    if (this.finished || this.signal.aborted || this.cancelling) return false;
    const key = String(id);
    try {
      this.pending.set(key, { id, allow: ext.allowName, reject: ext.rejectName, answer: ext.answer });
      this.flushText();
      this.emit({
        type: 'approval.requested',
        nativeRequestId: key,
        nativeMethod: method,
        itemId: null,
        ...titled(ext.title),
        reason: null,
        detail: clip(ext.detail ? redactText(ext.detail) : null),
        options: ['allow', 'deny'],
      });
    } catch (e) {
      this.pending.delete(key);
      try {
        this.rpc.respond(id, ext.answer('cancelled'));
      } catch {}
      this.failure = this.t('无法在聊天中显示 {name} 的审批请求（{error}）：已拒绝该请求并取消本回合', 'Could not show the {name} approval request in the chat ({error}): the request was refused and the turn cancelled', {
        error: errText(e),
      });
      this.cancel();
    }
    return true;
  }

  /** A finished activity line (a runtime-specific request answered at once). */
  noteActivity(id: string, title: NoticeText, detail: string | null) {
    if (this.finished) return;
    this.flushText();
    this.emit({ type: 'activity', itemId: `ext:${this.turnId}:${id}`, activity: 'other', ...titled(title), detail: clip(detail ? redactText(detail) : null), nativeStatus: null, done: true });
  }

  private showPermission(id: RpcId, key: string, p: any) {
    const options: any[] = Array.isArray(p?.options) ? p.options : [];
    const allow = options.find((o) => o?.kind === 'allow_once')?.optionId ?? null;
    const reject = options.find((o) => o?.kind === 'reject_once')?.optionId ?? null;
    this.pending.set(key, { id, allow: allow != null ? String(allow) : null, reject: reject != null ? String(reject) : null });
    const call = p?.toolCall ?? {};
    const known = call.toolCallId ? this.tools.get(String(call.toolCallId)) : undefined;
    const state = this.mergeTool(known, call);
    this.flushText();
    this.emit({
      type: 'approval.requested',
      nativeRequestId: key,
      nativeMethod: 'session/request_permission',
      itemId: call.toolCallId ? String(call.toolCallId) : null,
      title: this.relTitle(state) || this.rt.label,
      reason: null,
      detail: clip([this.detailOf(state, true), ...this.filesOf(state).map((f) => f.diff)].filter(Boolean).join('\n')),
      options: allow ? ['allow', 'deny'] : ['deny'],
    });
  }

  onUpdate(u: any) {
    if (this.finished) return;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const t = u.content?.type === 'text' ? String(u.content.text ?? '') : '';
        if (!t) return;
        this.text += t;
        this.emit({ type: 'text.delta', itemId: this.textItem(), text: t, phase: null });
        return;
      }
      case 'tool_call':
      case 'tool_call_update': {
        if (!u.toolCallId) return;
        const id = String(u.toolCallId);
        this.flushText();
        const state = this.mergeTool(this.tools.get(id), u);
        this.tools.set(id, state);
        this.emitTool(id, state);
        return;
      }
      case 'plan': {
        const entries: any[] = Array.isArray(u.entries) ? u.entries : [];
        const mark: Record<string, string> = { completed: '[x]', in_progress: '[~]', pending: '[ ]' };
        this.emit({
          type: 'activity',
          itemId: `plan:${this.turnId}`,
          activity: 'plan',
          ...titled(this.t('计划（{done}/{total}）', 'Plan ({done}/{total})', { done: entries.filter((e) => e?.status === 'completed').length, total: entries.length })),
          detail: entries.map((e) => `${mark[e?.status] ?? '[ ]'} ${String(e?.content ?? '')}`).join('\n'),
          nativeStatus: null,
          done: false,
        });
        return;
      }
      default:
        // agent_thought_chunk (Thinking text), user_message_chunk, available_commands_update, session_info_update,
        // usage_update (context window) are not shown in the chat.
        return;
    }
  }

  private textItem(): string {
    return `${this.turnId}:msg:${this.textSeg}`;
  }

  /** Ends the current text segment (a tool call or the end of the turn follows), with its authoritative text. */
  private flushText() {
    if (!this.text) return;
    this.emit({ type: 'text.done', itemId: this.textItem(), text: this.text, phase: null });
    this.text = '';
    this.textSeg++;
  }

  private mergeTool(prev: ToolState | undefined, u: any): ToolState {
    return {
      title: typeof u.title === 'string' && u.title ? u.title : (prev?.title ?? ''),
      kind: typeof u.kind === 'string' ? u.kind : (prev?.kind ?? null),
      status: typeof u.status === 'string' ? u.status : (prev?.status ?? null),
      content: Array.isArray(u.content) ? u.content : (prev?.content ?? []),
      rawInput: u.rawInput !== undefined ? u.rawInput : prev?.rawInput,
      rawOutput: u.rawOutput !== undefined ? u.rawOutput : prev?.rawOutput,
      locations: Array.isArray(u.locations) ? u.locations : (prev?.locations ?? []),
    };
  }

  private rel(raw: string): string {
    // Some runtimes (agy) report Windows paths as file-URL paths ("/C:/Users/...") in finished tool calls.
    const p = raw.replace(/^\/([A-Za-z]:[\\/])/, '$1');
    if (!isAbsolute(p)) return p;
    return relativeInside(this.cwd, p) ?? p;
  }

  /** The runtime's title with the absolute paths of its own locations shown relative to the workspace. */
  private relTitle(s: ToolState): string {
    let t = s.title;
    for (const l of s.locations) {
      const p = String(l.path ?? '');
      if (p && t.includes(p)) t = t.split(p).join(this.rel(p));
    }
    return t;
  }

  private filesOf(s: ToolState): FileChange[] {
    const out: FileChange[] = [];
    for (const c of s.content) {
      if (c?.type !== 'diff' || typeof c.path !== 'string') continue;
      const lines = (t: unknown, mark: string) => {
        if (typeof t !== 'string' || t === '') return [];
        const text = t.replace(/\r\n/g, '\n');
        const out = text.replace(/\n$/, '').split('\n').map((l) => mark + l);
        return text.endsWith('\n') ? out : [...out, '\\ No newline at end of file'];
      };
      // Only the runtime's own delete is a deletion: an edit that empties a file is still an edit.
      const change: FileChange['change'] = c.oldText == null ? 'add' : s.kind === 'delete' ? 'delete' : 'edit';
      out.push({ path: this.rel(c.path), change, diff: [...lines(c.oldText, '-'), ...lines(c.newText, '+')].join('\n') });
    }
    return out;
  }

  /** `withInput`: always include the tool's raw input (command, paths, arguments), as an approval must show it. */
  private detailOf(s: ToolState, withInput = false): string {
    const parts: string[] = [];
    const raw = s.rawInput === undefined ? null : typeof s.rawInput === 'string' ? s.rawInput : JSON.stringify(s.rawInput, null, 2);
    if (withInput && raw) parts.push(raw);
    for (const c of s.content) {
      if (c?.type === 'content' && c.content?.type === 'text' && c.content.text) parts.push(String(c.content.text));
      else if (c?.type === 'diff' && typeof c.path === 'string') parts.push(this.rel(c.path));
      else if (c?.type === 'terminal' && c.terminalId) parts.push(`terminal ${String(c.terminalId)}`);
    }
    if (!parts.length && raw) parts.push(raw);
    for (const l of s.locations) parts.push(this.rel(String(l.path)));
    return [...new Set(parts)].join('\n');
  }

  private emitTool(id: string, s: ToolState) {
    const activity = ACTIVITY_OF[s.kind ?? ''] ?? 'other';
    const files = activity === 'fileChange' ? this.filesOf(s) : [];
    const done = s.status === 'completed' || s.status === 'failed';
    this.emit({
      type: 'activity',
      itemId: id,
      activity,
      title: this.relTitle(s) || (s.kind ?? 'tool'),
      detail: clip(this.detailOf(s)),
      nativeStatus: s.status,
      ...(files.length ? { files } : {}),
      done,
      failed: done ? s.status === 'failed' : undefined,
    });
  }
}

/** ACP `usage` on the prompt response (unstable field), when the runtime reports it. The cost comes from usage_update. */
function acpUsage(u: any): TurnUsage[] | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const input = n(u.inputTokens);
  const output = n(u.outputTokens);
  const cacheRead = n(u.cachedReadTokens);
  const cacheWrite = n(u.cachedWriteTokens);
  if (!input && !output && !cacheRead && !cacheWrite) return undefined;
  return [{ model: null, input, cacheRead, cacheWrite, output, reasoning: n(u.thoughtTokens), costUsd: null }];
}