import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { relativeInside } from '../../path-key.ts';
import type {
  ActivityKind,
  AgentLanguage,
  Agent,
  ApprovalDecision,
  RuntimeCommand,
  RuntimeDescriptor,
  RuntimeModelCatalog,
  RuntimeModelOption,
  FileChange,
  PermissionMode,
  PermissionModeAvailability,
  RuntimeBilling,
} from '../../../../shared/protocol.ts';
import { PERMISSION_MODES } from '../../../../shared/protocol.ts';
import { claudeLimitName, L, type Localized, N, NoticeError, type NoticeText, zhText } from '../../../../shared/notices.ts';
import {
  cwdKey as dirKey,
  denyText,
  REQUEST_GONE,
  REQUEST_INTERRUPTED,
  SKILL_NAME,
  SKILLS_TTL_MS,
  type SkillInfo,
  type SkillList,
  unsupportedDecision,
} from '../types.ts';
import {
  type AgentSession,
  type ApprovalAnswer,
  type EffectiveModel,
  type EffectivePermission,
  type ModelConfig,
  type OpenSessionArgs,
  ResumeFailedError,
  type RuntimeAdapter,
  type TeamMcpConfig,
  type TurnAttachment,
  type TurnEventSink,
  type TurnInput,
  type TurnResult,
  type TurnUsage,
} from '../types.ts';
import { type ClaudeAuthSummary, claudeLogin, type ClaudeLogin, nativeClaudeEnv } from './detect.ts';
import { StreamJsonProcess } from './process.ts';

/**
 * Claude Code runtime through the user's own, unmodified `claude` CLI (backend "claude-native-cli").
 *
 * - One long-lived `claude -p --input-format stream-json --output-format stream-json` process per agent session,
 *   started with an exact `--session-id` (new) or `--resume <id>` (existing). Never `--continue`, never `--bare`,
 *   never a bypass/skip-permissions mode: Claude Code's own permission rules, tools, CLAUDE.md, Skills, MCP and
 *   Hooks stay in charge.
 * - A member on Claude Code's own login runs with the user's environment and login as a terminal would (an API key
 *   or cloud provider is used and billed as there, and shown on the member). Billing is checked on every process
 *   (initialize → account, each turn's init → apiKeySource): if the member shows the subscription and the process
 *   bills per token, it is killed and the turn fails. Harness Team never switches billing on its own.
 * - Tool permission prompts arrive as `can_use_tool` control requests (`--permission-prompt-tool stdio`). They
 *   are shown in the room and held until the local user decides in the group chat (`respondApproval`, called only
 *   by the Core), answered on the exact request_id. "allow" is sent only for that user decision, with the tool's
 *   original input and no permission-rule updates; interrupt, turn end, process exit and stray requests are denied.
 *   "Allow for this session" is offered only when Claude Code suggests rules for the request: those allow rules and
 *   directories are sent back with destination `session` (never a settings file) and last while this process runs.
 */

export const CLAUDE_BACKEND = 'claude-native-cli' as const;

/** Fixed CLI flags. Kept in one place so tests can assert nothing unsafe is ever added. */
export const CLAUDE_FLAGS = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
  '--include-hook-events',
  '--permission-prompt-tool',
  'stdio',
] as const;

// --fallback-model would let the CLI silently run another model than the one chosen.
/**
 * Slash commands of a Claude Code member. `/compact` is sent alone as the user message, so Claude Code runs it itself;
 * model and effort are what Harness Team starts Claude Code with, so they change in the member settings.
 */
const CLAUDE_COMMANDS: RuntimeCommand[] = [
  {
    name: 'compact',
    action: 'native',
    args: L('[保留重点]', '[instructions]'),
    description: L('压缩本会话的上下文（Claude Code /compact）', 'Compact this session’s context (Claude Code /compact)'),
  },
  { name: 'model', action: 'settings', description: L('更换模型（成员设置）', 'Change the model (member settings)') },
  { name: 'effort', action: 'settings', description: L('更换 Effort（成员设置）', 'Change the effort (member settings)') },
];

const FORBIDDEN_FLAGS = /^--(bare|dangerously-skip-permissions|allow-dangerously-skip-permissions|continue|fallback-model)$|^-c$|bypassPermissions/;

/**
 * `--model` / `--effort` / `--permission-mode` for an explicit per-agent choice; nothing for "follow Claude Code's
 * default". Only the modes in PERMISSION_MODES.claude are ever passed; bypassPermissions only as this mode value, when
 * the user chose it after the risk warning (the Core checks that), never as --dangerously-skip-permissions.
 */
export function modelArgs(cfg: ModelConfig | null | undefined): string[] {
  const out: string[] = [];
  if (cfg?.model) out.push('--model', cfg.model);
  if (cfg?.effort) out.push('--effort', cfg.effort);
  if (cfg?.permissionMode) {
    if (!PERMISSION_MODES.claude.includes(cfg.permissionMode)) {
      throw new NoticeError(L('内部错误：拒绝使用权限模式 {mode}', 'Internal error: refusing the permission mode {mode}', { mode: cfg.permissionMode }));
    }
    out.push('--permission-mode', cfg.permissionMode);
  }
  return out;
}

const sameConfig = (a: ModelConfig, b: ModelConfig) =>
  (a.model ?? null) === (b.model ?? null) && (a.effort ?? null) === (b.effort ?? null) && (a.permissionMode ?? null) === (b.permissionMode ?? null);

/** Claude Code's own name for a mode: `manual` is the CLI's alias of its internal "default". */
const nativeMode = (m: PermissionMode) => (m === 'manual' ? 'default' : m);

/**
 * The permission mode Claude Code reported (`initialize.current_permission_mode`, `system/init.permissionMode`),
 * compared with the agent's choice. Modes that run tools without asking you, or that deny them silently, are
 * flagged so the member card says so, whether they were chosen for the member or come from the user's own settings.
 */
export function claudePermission(reported: unknown, want: PermissionMode | null | undefined, source: Localized): EffectivePermission {
  const native = typeof reported === 'string' && reported ? reported : null;
  const mode = native === 'default' ? 'manual' : PERMISSION_MODES.claude.find((m) => m === native) ?? null;
  const mismatch =
    want && native !== nativeMode(want)
      ? L('Claude Code 报告的权限模式是 {got}，不是所选的 {want}', 'Claude Code reports the permission mode {got}, not the chosen {want}', { got: native ?? '?', want })
      : null;
  const risky =
    native === 'bypassPermissions'
      ? L(
          'Claude Code 当前的权限模式是 bypassPermissions：工具调用不会在群里请求审批，会直接执行。',
          'Claude Code runs in the permission mode bypassPermissions: tool calls run without asking for approval in the chat.',
        )
      : native === 'dontAsk'
        ? L(
            'Claude Code 当前的权限模式是 dontAsk：没有预先允许的工具调用会被直接拒绝，不会在群里请求审批。',
            'Claude Code runs in the permission mode dontAsk: tool calls that are not allowed in advance are refused without asking for approval in the chat.',
          )
        : null;
  return { native: native ?? '?', mode, source, mismatch, risky };
}

const CATALOG_TTL_MS = 10 * 60_000;

/**
 * Modes Claude Code itself can refuse on a machine (settings `disableBypassPermissionsMode` / `disableAutoMode`, managed
 * policy, safe mode, an account without auto mode). Each is checked in the member's folder with an initialize-only
 * process started with that `--permission-mode`; the mode it reports back decides.
 */
const GATED_CLAUDE_MODES: readonly PermissionMode[] = ['bypassPermissions', 'auto'];

/**
 * Skills and custom commands from Claude Code's own `initialize.commands`: everything not marked `builtin` (Claude
 * Code's built-in commands are never offered: several are billed, change settings or act remotely). Claude Code tags
 * the description with where the entry comes from: "… (user)", "… (project)", "… (claude.ai sync)", or a
 * "(plugin) …" prefix.
 */
export function skillsFromInit(init: any, reserved: string[] = []): SkillInfo[] {
  const raw: any[] = Array.isArray(init?.commands) ? init.commands : [];
  const out: SkillInfo[] = [];
  const seen = new Set(reserved.map((n) => n.toLowerCase()));
  for (const c of raw) {
    if (!c || c.builtin || typeof c.name !== 'string' || !SKILL_NAME.test(c.name)) continue;
    if (seen.has(c.name.toLowerCase())) continue;
    seen.add(c.name.toLowerCase());
    let desc = typeof c.description === 'string' ? c.description.trim() : '';
    let source: Localized | null = null;
    const pre = /^\(([^()]{1,60})\)\s+/.exec(desc);
    const post = /\s*\(([^()]{1,40})\)$/.exec(desc);
    if (pre) {
      source = L('插件 {name}', 'plugin {name}', { name: pre[1]! });
      desc = desc.slice(pre[0].length);
    } else if (post) {
      const s = post[1]!;
      source = s === 'user' ? L('用户', 'user') : s === 'project' ? L('项目', 'project') : s;
      desc = desc.slice(0, post.index);
    }
    const hint = typeof c.argumentHint === 'string' && c.argumentHint.trim() ? c.argumentHint.trim() : null;
    out.push({ name: c.name, description: desc, args: hint, source });
  }
  return out;
}


/** Catalog from the CLI's own `initialize` response (`models[]` with per-model effort levels) and `get_settings`. */
export function catalogFromInit(init: any, applied: { model?: unknown; effort?: unknown } | null): RuntimeModelCatalog {
  const raw: any[] = Array.isArray(init?.models) ? init.models : [];
  const def = raw.find((m) => m?.value === 'default') ?? null;
  const levels = (m: any): string[] =>
    m?.supportsEffort === false ? [] : Array.isArray(m?.supportedEffortLevels) ? m.supportedEffortLevels.map(String) : [];
  const defResolved = typeof def?.resolvedModel === 'string' ? def.resolvedModel : null;
  const models: RuntimeModelOption[] = raw
    .filter((m) => m && typeof m.value === 'string' && m.value && m.value !== 'default')
    .map((m) => ({
      id: m.value,
      displayName: String(m.displayName ?? m.value),
      description: typeof m.description === 'string' ? m.description : null,
      resolvedModel: typeof m.resolvedModel === 'string' ? m.resolvedModel : null,
      efforts: levels(m),
      defaultEffort: null,
      isDefault: false,
    }));
  const first = models.find((m) => defResolved && m.resolvedModel === defResolved);
  if (first) first.isDefault = true;
  const appliedModel = typeof applied?.model === 'string' ? applied.model : null;
  const appliedEffort = typeof applied?.effort === 'string' ? applied.effort : null;
  return {
    runtimeKind: 'claude',
    available: models.length > 0,
    source: 'Claude Code initialize.models + get_settings.applied',
    error: models.length ? null : L('Claude Code 的 initialize 响应没有提供模型列表', 'Claude Code’s initialize response has no model list'),
    models,
    nativeDefault: {
      model: appliedModel ?? defResolved,
      effort: appliedEffort,
      efforts: def ? levels(def) : [],
      note: def ? L('Claude Code 的默认模型（{name}）', 'Claude Code’s default model ({name})', { name: def.displayName ?? 'Default' }) : null,
    },
    fetchedAt: new Date().toISOString(),
  };
}

export interface ClaudeAdapterOptions {
  /** Executable to spawn (claude.exe, or `node` for tests). */
  command: string;
  /** Arguments placed before the CLI flags (tests: the fake CLI script and its files). */
  argsPrefix?: string[];
  version?: string | null;
  /** Non-secret summary of `claude auth status --json`; with the environment it decides how the login is billed. */
  auth?: ClaudeAuthSummary | null;
  /** Why no Claude Code member can run (too old, no longer found). */
  problem?: NoticeText | null;
  /** Environment the child env is derived from (default: process.env). Never modified. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Append every protocol line to this JSONL file (opt-in receipts; account identifiers are redacted). */
  protocolLog?: string;
  /** How long to wait for the turn's `result` after an interrupt before reporting failure. */
  interruptTimeoutMs?: number;
  /**
   * After a background agent reported finished, how long to wait for Claude Code to start the follow-up it runs by
   * itself before the turn is closed with what it has (default 60 s).
   */
  followUpTimeoutMs?: number;
  /** How long to wait for the `initialize` control response when starting a process. */
  startTimeoutMs?: number;
  /** How long to wait for the killed process to exit before declaring its state unknown (default 5000 ms). */
  killConfirmTimeoutMs?: number;
  /** Process-tree kill used for forced stops (default: taskkill /T /F). Test seam only. */
  killTree?: (pid: number) => void;
}

export class ClaudeAdapter implements RuntimeAdapter {
  readonly kind = 'claude' as const;
  opts: ClaudeAdapterOptions;
  private readonly sessions = new Set<ClaudeSession>();
  private catalog: { at: number; cwd: string; value: RuntimeModelCatalog } | null = null;
  private probing: Promise<RuntimeModelCatalog> | null = null;
  /** cwd key -> skills Claude Code reported there (from probes and from every session start). */
  private readonly skills = new Map<string, { at: number; value: SkillInfo[] }>();
  private readonly skillProbes = new Map<string, Promise<SkillList>>();
  /** cwd key -> availability of the permission modes there (GATED_CLAUDE_MODES checked, the others always offered). */
  private readonly modeChecks = new Map<string, { at: number; value: Promise<PermissionModeAvailability[]> }>();

  constructor(opts: ClaudeAdapterOptions) {
    this.opts = opts;
  }

  /** New detection results (Check again). Running sessions keep their process; new ones use these. */
  update(found: Partial<ClaudeAdapterOptions>): void {
    this.opts = { ...this.opts, ...found };
    this.catalog = null;
    this.skills.clear();
    this.modeChecks.clear();
  }

  /** Claude Code's own login and how it is billed, from detection and the environment the members get. */
  login(): ClaudeLogin {
    return claudeLogin(this.opts.auth, this.opts.baseEnv ?? process.env);
  }

  /** Why no member can run on Claude Code's own login: the CLI's problem (too old / gone), then the login's. */
  private nativeProblem(): NoticeText | null {
    return this.opts.problem ?? this.login().problem;
  }

  describe(): RuntimeDescriptor {
    const problem = this.nativeProblem();
    const login = this.login();
    return {
      kind: 'claude',
      backend: CLAUDE_BACKEND,
      label: 'Claude Code',
      isMock: false,
      available: !problem,
      installed: !this.opts.problem,
      problem,
      note: problem
        ? L('不可用：{problem}', 'Not available: {problem}', { problem })
        : L(
            '{version} · {login}。使用你本机未修改的 Claude Code（-p stream-json），和在终端里一样沿用你的登录、环境变量、CLAUDE.md / Skills / MCP / Hooks 与权限规则。需要确认的工具请求显示在群聊中，只有你在群内点选才会批准，Harness Team 从不自动批准。',
            '{version} · {login}. Uses your own unmodified Claude Code (-p stream-json) with your login, environment, CLAUDE.md / Skills / MCP / Hooks and permission rules, as in your terminal. Tool requests that need confirmation appear in the chat and are approved only when you click there; Harness Team never approves anything on its own.',
            {
              version: this.opts.version ?? 'claude',
              login:
                login.billing === 'subscription'
                  ? L('claude.ai 登录（{plan}）', 'claude.ai login ({plan})', { plan: this.opts.auth?.subscriptionType ?? L('订阅', 'subscription') })
                  : L('按 token 计费（{source}）', 'billed per token ({source})', { source: login.source ?? '?' }),
            },
          ),
      requiresWorkspace: true,
      version: this.opts.version ?? null,
      billing: problem ? null : login.billing,
      capabilities: {
        streaming: true,
        nativeTools: true,
        nativeApprovals: true,
        interrupt: true,
        resume: true,
        steer: false,
        teamMcp: true,
        standingInstructions: true,
        commands: CLAUDE_COMMANDS,
      },
    };
  }

  async openSession(args: OpenSessionArgs): Promise<AgentSession> {
    const problem = this.nativeProblem();
    if (problem) throw new NoticeError(problem);
    const cwd = args.agent.workspace;
    if (!cwd) throw new NoticeError(L('Claude Code 成员需要工作目录（workspace）', 'Claude Code members need a working folder (workspace)'));
    const resumeId = args.resumeNativeSessionId;
    const session = new ClaudeSession(
      this,
      cwd,
      resumeId ?? randomUUID(),
      !!resumeId,
      args.teamMcp,
      { model: args.agent.model, effort: args.agent.effort, permissionMode: args.agent.permissionMode },
      args.instructions ?? null,
      args.readableDirs ?? [],
    );
    if (args.language) session.language = args.language;
    if (args.billing) session.shownBilling = args.billing;
    if (args.onBilling) session.onBilling = args.onBilling;
    await session.start();
    this.sessions.add(session);
    return session;
  }

  forget(s: ClaudeSession) {
    this.sessions.delete(s);
  }

  /** Keeps the catalog fresh from every real session start (same CLI, same login). */
  noteCatalog(init: any, cwd: string) {
    this.skills.set(dirKey(cwd), { at: Date.now(), value: skillsFromInit(init, CLAUDE_COMMANDS.map((c) => c.name)) });
    const cat = catalogFromInit(init, null);
    if (!cat.available) return;
    // Session processes may run with --model/--effort, so their get_settings is not the native default: keep the
    // default reported by the last flag-free probe.
    if (this.catalog?.value.nativeDefault) cat.nativeDefault = { ...this.catalog.value.nativeDefault, efforts: cat.nativeDefault?.efforts ?? [] };
    else cat.nativeDefault = cat.nativeDefault ? { ...cat.nativeDefault, effort: null } : null;
    this.catalog = { at: Date.now(), cwd, value: cat };
  }

  /**
   * Models/efforts reported by the CLI itself. A short-lived `claude -p` process is asked only for `initialize` and
   * `get_settings` (no user message, so no model request and no usage), with no --model/--effort so the native
   * default is what Claude Code itself resolves. The subscription check applies to this process too.
   */
  async listModels(opts: { refresh?: boolean; cwd?: string | null } = {}): Promise<RuntimeModelCatalog> {
    const [cat, modes] = await Promise.all([this.modelCatalog(opts), this.permissionModes(opts.cwd ?? null, opts.refresh)]);
    return cat.available && modes ? { ...cat, permissionModes: modes } : cat;
  }

  /**
   * Whether each permission mode can be used in `cwd`: GATED_CLAUDE_MODES are started once each (initialize only, no
   * user message, so no model request) and compared with the mode Claude Code reports. null when it could not be
   * checked (Claude Code not usable here). Failures are not cached.
   */
  permissionModes(cwd: string | null, refresh = false): Promise<PermissionModeAvailability[] | null> {
    if (this.nativeProblem()) return Promise.resolve(null);
    const key = cwd ? dirKey(cwd) : '';
    const hit = this.modeChecks.get(key);
    if (hit && !refresh && Date.now() - hit.at < CATALOG_TTL_MS) return hit.value;
    let failed = false;
    const value = Promise.all(
      GATED_CLAUDE_MODES.map((m) =>
        this.probeMode(cwd, m).then((r) => {
          if (!r.definite) failed = true;
          return r.entry;
        }),
      ),
    ).then((gated) => PERMISSION_MODES.claude.map((id) => gated.find((g) => g.id === id) ?? { id, available: true, reason: null }));
    this.modeChecks.set(key, { at: Date.now(), value });
    void value.then(() => {
      if (failed && this.modeChecks.get(key)?.value === value) this.modeChecks.delete(key);
    });
    return value;
  }

  private async probeMode(cwd: string | null, mode: PermissionMode): Promise<{ entry: PermissionModeAvailability; definite: boolean }> {
    const o = this.opts;
    const args = [...(o.argsPrefix ?? []), ...CLAUDE_FLAGS, '--no-session-persistence', '--session-id', randomUUID(), '--permission-mode', mode];
    const env = nativeClaudeEnv(o.baseEnv ?? process.env);
    const proc = new StreamJsonProcess(o.command, args, { cwd: cwd ?? tmpdir(), env, killTree: o.killTree }, { onMessage() {}, onExit() {} });
    try {
      proc.start();
      // Only `initialize`: no model request, so there is no billing to check here.
      const init: any = await proc.control({ subtype: 'initialize' }, o.startTimeoutMs ?? 60_000);
      const got = init?.current_permission_mode;
      // An older CLI that does not report the mode: nothing to compare, the session start checks it again.
      if (typeof got !== 'string' || got === mode) return { entry: { id: mode, available: true, reason: null }, definite: true };
      return {
        entry: {
          id: mode,
          available: false,
          reason: L('Claude Code 在这个工作目录以 {mode} 启动时报告的权限模式是 {got}：你的 Claude Code 设置或管理策略没有开启它', 'Started with {mode} in this working folder, Claude Code reports the permission mode {got}: your Claude Code settings or managed policy do not allow it', { mode, got }),
        },
        definite: true,
      };
    } catch (e) {
      const why = proc.stderrTail.trim().split('\n').pop() || (e as Error).message;
      return { entry: { id: mode, available: false, reason: L('Claude Code 拒绝以 {mode} 启动：{error}', 'Claude Code refused to start with {mode}: {error}', { mode, error: why }) }, definite: false };
    } finally {
      await proc.terminate().catch(() => {});
    }
  }

  private modelCatalog(opts: { refresh?: boolean; cwd?: string | null }): Promise<RuntimeModelCatalog> {
    const c = this.catalog;
    if (c && !opts.refresh && Date.now() - c.at < CATALOG_TTL_MS && c.value.nativeDefault?.model !== undefined) return Promise.resolve(c.value);
    if (!this.probing) {
      this.probing = this.probe(opts.cwd ?? null).finally(() => {
        this.probing = null;
      });
    }
    return this.probing;
  }

  private async probe(cwd: string | null): Promise<RuntimeModelCatalog> {
    const fail = (error: Localized): RuntimeModelCatalog => ({
      runtimeKind: 'claude',
      available: false,
      source: 'Claude Code initialize',
      error,
      models: [],
      nativeDefault: null,
      fetchedAt: new Date().toISOString(),
    });
    const problem = this.nativeProblem();
    if (problem) return fail(problem);
    const o = this.opts;
    const args = [...(o.argsPrefix ?? []), ...CLAUDE_FLAGS, '--no-session-persistence', '--session-id', randomUUID()];
    const env = nativeClaudeEnv(o.baseEnv ?? process.env);
    const dir = cwd ?? tmpdir();
    const proc = new StreamJsonProcess(o.command, args, { cwd: dir, env, killTree: o.killTree }, { onMessage() {}, onExit() {} });
    try {
      proc.start();
      // Only `initialize` and `get_settings`: no model request, so there is no billing to check here.
      const init: any = await proc.control({ subtype: 'initialize' }, o.startTimeoutMs ?? 60_000);
      let applied: any = null;
      try {
        applied = ((await proc.control({ subtype: 'get_settings' }, 10_000)) as any)?.applied ?? null;
      } catch {
        applied = null; // older CLI: the default model still comes from initialize.models
      }
      const cat = catalogFromInit(init, applied);
      if (cat.available) this.catalog = { at: Date.now(), cwd: dir, value: cat };
      if (cwd) this.skills.set(dirKey(cwd), { at: Date.now(), value: skillsFromInit(init, CLAUDE_COMMANDS.map((c) => c.name)) });
      return cat;
    } catch (e) {
      return fail(
        L('无法从 Claude Code 读取模型列表：{error}', 'Could not read the model list from Claude Code: {error}', {
          error: proc.stderrTail.trim().split('\n').pop() || (e as Error).message,
        }),
      );
    } finally {
      await proc.terminate().catch(() => {});
    }
  }

  /**
   * Skills Claude Code reports for `cwd` (project skills depend on it). Taken from the last session start or probe in
   * that folder; otherwise a short-lived `claude -p` is asked for `initialize` only (no user message, no model request,
   * same subscription check as every process).
   */
  listSkills(opts: { cwd: string; refresh?: boolean }): Promise<SkillList> {
    const key = dirKey(opts.cwd);
    const hit = this.skills.get(key);
    if (hit && !opts.refresh && Date.now() - hit.at < SKILLS_TTL_MS) return Promise.resolve({ skills: hit.value, error: null });
    let p = this.skillProbes.get(key);
    if (!p) {
      p = this.probeSkills(opts.cwd).finally(() => this.skillProbes.delete(key));
      this.skillProbes.set(key, p);
    }
    return p;
  }

  private async probeSkills(cwd: string): Promise<SkillList> {
    const problem = this.nativeProblem();
    if (problem) return { skills: [], error: problem };
    const o = this.opts;
    const args = [...(o.argsPrefix ?? []), ...CLAUDE_FLAGS, '--no-session-persistence', '--session-id', randomUUID()];
    const env = nativeClaudeEnv(o.baseEnv ?? process.env);
    const proc = new StreamJsonProcess(o.command, args, { cwd, env, killTree: o.killTree }, { onMessage() {}, onExit() {} });
    try {
      proc.start();
      // Only `initialize`: no model request, so there is no billing to check here.
      const init: any = await proc.control({ subtype: 'initialize' }, o.startTimeoutMs ?? 60_000);
      const value = skillsFromInit(init, CLAUDE_COMMANDS.map((c) => c.name));
      this.skills.set(dirKey(cwd), { at: Date.now(), value });
      return { skills: value, error: null };
    } catch (e) {
      return {
        skills: [],
        error: L('无法从 Claude Code 读取 Skills：{error}', 'Could not read the skills from Claude Code: {error}', {
          error: proc.stderrTail.trim().split('\n').pop() || (e as Error).message,
        }),
      };
    } finally {
      await proc.terminate().catch(() => {});
    }
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.sessions].map((s) => s.close().catch(() => {})));
    this.sessions.clear();
  }
}

// ---------------------------------------------------------------------------------------------------------------

/** How a Claude Code process is billed, from its `initialize` account (null = not reported). */
function accountBilling(init: any): { billing: RuntimeBilling | null; src: string } {
  const acct = init?.account;
  if (!acct || typeof acct !== 'object') return { billing: null, src: '?' };
  return {
    billing: acct.apiProvider === 'firstParty' && acct.subscriptionType ? 'subscription' : 'metered_api',
    src: `apiProvider=${JSON.stringify(acct.apiProvider ?? null)}, subscriptionType=${JSON.stringify(acct.subscriptionType ?? null)}`,
  };
}

/**
 * The member shows the subscription, and the process now bills per token (an automatic switch as far as the user can
 * see): stopped, and the member is marked per-token from then on, so sending again is the user's own choice.
 * Per-token logins the member already shows are fine.
 */
export function billingSwitched(expected: RuntimeBilling | null | undefined, actual: RuntimeBilling | null, src: string): NoticeText | null {
  if (expected !== 'subscription' || actual !== 'metered_api') return null;
  return L(
    'Claude Code 报告的计费方式是 {src}，但该成员显示的是 claude.ai 订阅，已立即停止该进程。该成员现在标为按量计费：再发一次消息就按 token 计费运行。想继续用订阅，请先在终端里改回 claude.ai 登录、去掉 API Key 设置，再发消息。Harness Team 不会自行切换计费方式。',
    'Claude Code reports {src}, but this member shows the claude.ai subscription, so the process was stopped at once. The member is now marked as billed per token: send the message again to run it per token. To stay on the subscription, switch back to the claude.ai login and remove the API key setting in a terminal first, then send it again. Harness Team never switches billing on its own.',
    { src },
  );
}

class ClaudeSession implements AgentSession {
  nativeSessionId: string;
  info: NoticeText[] = [];
  private proc: StreamJsonProcess | null = null;
  private turn: ClaudeTurn | null = null;
  /** True once the CLI has a transcript for this id (resumed, or at least one turn was sent). */
  private persisted: boolean;
  private closed = false;
  initShownForPid: number | undefined;
  overageWarned = false;
  /** How the member's own login was billed when its current process started (what the member shows). */
  billing: RuntimeBilling | null = null;
  /** What the member shows now (OpenSessionArgs.billing); default the detection. */
  shownBilling: () => RuntimeBilling | null = () => this.adapter.login().billing;
  /** Reports how the runtime says the own login is billed (OpenSessionArgs.onBilling). */
  onBilling: (billing: RuntimeBilling) => void = () => {};
  /** Permission mode Claude Code last reported (initialize, then system/init of every turn). */
  permission: EffectivePermission | null = null;
  /** You approved a plan (ExitPlanMode): Claude Code leaves plan mode inside the process, without reporting it. */
  planApproved = false;
  /**
   * A process that was force-killed after an unconfirmed interrupt but has not been seen to exit. While it may
   * still be running (and editing files), no new turn is dispatched for this member.
   */
  unconfirmedStop: StreamJsonProcess | null = null;
  readonly adapter: ClaudeAdapter;
  readonly cwd: string;
  readonly teamMcp: TeamMcpConfig | undefined;
  /**
   * Harness Team rules passed with --append-system-prompt on every process start of this session. Claude Code records
   * the system prompt on the conversation's first request and reuses that record on resume.
   */
  readonly instructions: string | null;
  /** Directories this session may read without a prompt (the room's attachments), see readAllowRule. */
  readonly readableDirs: string[];
  /** The room's agent language, for the reasons sent back with a "no" (OpenSessionArgs.language). */
  language: () => AgentLanguage = () => 'zh';
  /** The agent's model settings the next process start uses. */
  private config: ModelConfig;
  /** What the running process was started with (--model/--effort are per process). */
  private procConfig: ModelConfig | null = null;
  /** What Claude Code reported as applied for the running process. */
  current: EffectiveModel | null = null;

  constructor(
    adapter: ClaudeAdapter,
    cwd: string,
    sessionId: string,
    persisted: boolean,
    teamMcp?: TeamMcpConfig,
    config?: ModelConfig,
    instructions: string | null = null,
    readableDirs: string[] = [],
  ) {
    this.adapter = adapter;
    this.instructions = instructions;
    this.readableDirs = readableDirs;
    this.cwd = cwd;
    this.teamMcp = teamMcp;
    this.nativeSessionId = sessionId;
    this.persisted = persisted;
    this.config = config ?? { model: null, effort: null, permissionMode: null };
  }

  get effective(): EffectiveModel | null {
    return this.current;
  }

  get configForInfo(): ModelConfig {
    return this.procConfig ?? this.config;
  }

  get process(): StreamJsonProcess | null {
    return this.proc;
  }

  /** Spawns the CLI for this exact session id and verifies the subscription before any turn is sent. */
  async start(): Promise<void> {
    const o = this.adapter.opts;
    const resume = this.persisted;
    const config = { ...this.config };
    const env = nativeClaudeEnv(o.baseEnv ?? process.env);
    this.billing = this.shownBilling();
    const mcpFile = this.teamMcp ? writeTeamMcpConfig(this.teamMcp) : null;
    const args = [
      ...(o.argsPrefix ?? []),
      ...CLAUDE_FLAGS,
      ...teamMcpArgs(mcpFile && this.teamMcp ? { serverName: this.teamMcp.serverName, configFile: mcpFile.file } : undefined, this.readableDirs),
      ...(this.instructions ? ['--append-system-prompt', this.instructions] : []),
      ...modelArgs(config),
      resume ? '--resume' : '--session-id',
      this.nativeSessionId,
    ];
    // The chosen mode's value right after --permission-mode is the one place bypassPermissions may appear.
    const chosenMode = (a: string, i: number) => a === config.permissionMode && args[i - 1] === '--permission-mode';
    const unsafe = args.find((a, i) => a !== this.instructions && !chosenMode(a, i) && FORBIDDEN_FLAGS.test(a));
    if (unsafe) {
      mcpFile?.remove();
      throw new NoticeError(L('内部错误：拒绝使用参数 {arg}', 'Internal error: refusing the argument {arg}', { arg: unsafe }));
    }
    const proc = new StreamJsonProcess(o.command, args, { cwd: this.cwd, env, protocolLog: o.protocolLog, killTree: o.killTree }, {
      onMessage: (m) => (this.proc === proc ? this.onMessage(m) : undefined),
      onExit: (reason) => {
        mcpFile?.remove();
        if (this.proc === proc) this.turn?.onExit(reason);
      },
    });
    this.proc = proc;
    proc.start();
    let init: any;
    try {
      init = await proc.control({ subtype: 'initialize' }, o.startTimeoutMs ?? 60_000);
    } catch (e) {
      await proc.terminate();
      const why = proc.stderrTail.trim().split('\n').pop() || (e as Error).message;
      if (resume && /no conversation found/i.test(proc.stderrTail)) {
        throw new ResumeFailedError(`Claude Code 找不到会话 ${this.nativeSessionId}：${why}`, 'missing', why);
      }
      throw new NoticeError(L('无法启动 Claude Code：{why}', 'Could not start Claude Code: {why}', { why }));
    }
    const got = accountBilling(init);
    const problem = billingSwitched(this.billing, got.billing, got.src);
    // The account in `initialize` is the claude.ai login even when an API key in the environment pays for the turns,
    // so only a per-token account is reported from here; each turn's apiKeySource reports both ways.
    if (got.billing === 'metered_api') this.onBilling('metered_api');
    if (problem) {
      await proc.terminate();
      throw new NoticeError(problem);
    }
    this.adapter.noteCatalog(init, this.cwd);
    // The permission mode in effect, as Claude Code reports it at connect time: an explicit choice it did not apply is
    // refused before anything is sent (e.g. auto when auto mode is not available to this account).
    const permission = claudePermission(init?.current_permission_mode, config.permissionMode, 'Claude Code initialize');
    if (config.permissionMode && permission.mismatch) {
      await proc.terminate();
      throw new NoticeError(
        init?.current_permission_mode
          ? L(
              'Claude Code 未应用所选的权限模式 {want}（报告：{got}）；本消息未发送。请在成员设置中改选其他权限模式，或选「跟随我的设置」。',
              'Claude Code did not apply the chosen permission mode {want} (it reports {got}); this message was not sent. Choose another permission mode in the member settings, or “Follow my settings”.',
              { want: config.permissionMode, got: String(init.current_permission_mode) },
            )
          : L(
              '无法确认 Claude Code 已应用所选的权限模式 {want}（initialize 未报告权限模式）；本消息未发送',
              'Cannot confirm that Claude Code applied the chosen permission mode {want} (initialize reported no permission mode); this message was not sent',
              { want: config.permissionMode },
            ),
      );
    }
    this.permission = permission;
    this.planApproved = false;
    this.procConfig = config;
    try {
      this.current = await this.verifyApplied(proc, init, config);
    } catch (e) {
      // An explicit choice the CLI did not apply: never run a turn with something else.
      await proc.terminate();
      this.procConfig = null;
      throw e;
    }
    // Refreshed on every (re)start so the member detail view reflects the running process; core posts it only once at open.
    this.info = describeSession(init, this, resume, o.version);
  }

  /**
   * Reads what Claude Code itself applied (`get_settings.applied`) and refuses a process that ignored an explicit
   * model/effort (e.g. `--effort` on a model without effort support is silently dropped by the CLI).
   */
  private async verifyApplied(proc: StreamJsonProcess, init: any, cfg: ModelConfig): Promise<EffectiveModel> {
    const models: any[] = Array.isArray(init?.models) ? init.models : [];
    if (cfg.model && models.length && !models.some((m) => m?.value === cfg.model)) {
      throw new NoticeError(
        L('模型 {model} 不在 Claude Code 报告的可用模型中；本消息未发送，请在成员设置中重新选择', 'The model {model} is not among the models Claude Code reports; this message was not sent. Choose again in the member settings.', { model: cfg.model }),
      );
    }
    const explicit = !!(cfg.model || cfg.effort);
    const refuse = (why: NoticeText): never => {
      throw new NoticeError(
        L('无法确认 Claude Code 已应用所选配置（{why}）；为避免以其他模型 / Effort 运行，本消息未发送', 'Cannot confirm that Claude Code applied the chosen settings ({why}); to avoid running with another model / effort, this message was not sent', { why }),
      );
    };
    let applied: any;
    try {
      applied = ((await proc.control({ subtype: 'get_settings' }, 10_000)) as any)?.applied;
    } catch (e) {
      // An explicit choice must be confirmed before anything is sent; the default only is reported as unconfirmed.
      const error = (e as Error).message;
      if (explicit) refuse(L('get_settings 不可用：{error}', 'get_settings is not available: {error}', { error }));
      return {
        model: null,
        effort: null,
        source: L('未确认：Claude Code get_settings 不可用（{error}），跟随 Claude Code 默认配置', 'Unconfirmed: Claude Code get_settings is not available ({error}); following Claude Code’s default configuration', { error }),
      };
    }
    const model = typeof applied?.model === 'string' && applied.model ? applied.model : null;
    const effort = typeof applied?.effort === 'string' && applied.effort ? applied.effort : null;
    if (cfg.effort && effort !== cfg.effort) {
      if (!effort) refuse(L('get_settings 未报告生效的 Effort', 'get_settings reported no effort in effect'));
      throw new NoticeError(
        L('Claude Code 未应用所选 Effort {want}（实际：{got}）；为避免以其他配置运行，本消息未发送', 'Claude Code did not apply the chosen effort {want} (it reports {got}); to avoid running with other settings, this message was not sent', { want: cfg.effort, got: String(effort) }),
      );
    }
    if (cfg.model) {
      if (!model) refuse(L('get_settings 未报告生效的模型', 'get_settings reported no model in effect'));
      const entry = models.find((m) => m?.value === cfg.model);
      const expected = [cfg.model, entry?.resolvedModel].filter((x): x is string => typeof x === 'string');
      if (!expected.some((x) => model === x || model!.startsWith(`${x}[`))) {
        throw new NoticeError(
          L('Claude Code 实际使用模型 {got}，不是所选的 {want}（{expected}）；本消息未发送', 'Claude Code actually uses the model {got}, not the chosen {want} ({expected}); this message was not sent', { got: String(model), want: cfg.model, expected: expected.join(' / ') }),
        );
      }
    }
    if (!explicit && (!model || !effort)) {
      const what = L(`${!model ? '模型' : ''}${!model && !effort ? '与' : ''}${!effort ? ' Effort' : ''}`, [!model && 'model', !effort && 'effort'].filter(Boolean).join(' and '));
      return {
        model,
        effort,
        source: L('Claude Code get_settings.applied（未报告{what}，跟随默认配置，未完全确认）', 'Claude Code get_settings.applied ({what} not reported; following the default configuration, not fully confirmed)', { what }),
      };
    }
    return { model, effort, source: 'Claude Code get_settings.applied' };
  }

  async runTurn(input: TurnInput, sink: TurnEventSink, signal: AbortSignal): Promise<TurnResult> {
    if (this.turn) return { status: 'failed', error: L('该 Claude Code 会话正在运行另一个回合', 'This Claude Code session is already running another turn') };
    if (signal.aborted) return { status: 'interrupted' }; // nothing was sent
    if (this.closed) return { status: 'failed', error: L('会话已关闭', 'The session is closed') };
    const stuck = this.unconfirmedStop;
    if (stuck) {
      // Never start a turn while a previous claude process may still be working in this directory.
      if (stuck.running && !(await stuck.terminate(this.adapter.opts.killConfirmTimeoutMs ?? 5000))) {
        return {
          status: 'failed',
          error: L(
            '上一回合的 claude 进程（PID {pid}）仍未确认退出，可能仍在工作目录中运行。为避免与其并行执行，本消息未派发。请在任务管理器中确认该进程已结束、并核对工作目录的改动后再发送。',
            'The claude process of the previous turn (PID {pid}) has not been confirmed to exit and may still be running in the working folder. To avoid running alongside it, this message was not sent. Check in Task Manager that the process has ended and review the changes in the working folder before sending again.',
            { pid: String(stuck.pid ?? '?') },
          ),
        };
      }
      this.unconfirmedStop = null;
    }
    if (input.config) this.config = { model: input.config.model ?? null, effort: input.config.effort ?? null, permissionMode: input.config.permissionMode ?? null };
    // A process whose mode moved away from the chosen one during a turn (e.g. leaving plan mode after you approved the
    // plan) is restarted with the chosen mode, like a changed setting.
    const drifted = !!(
      this.procConfig?.permissionMode &&
      (this.planApproved || (this.permission && this.permission.native !== nativeMode(this.procConfig.permissionMode)))
    );
    if (this.proc?.running && this.procConfig && (drifted || !sameConfig(this.procConfig, this.config))) {
      // --model/--effort are per process: between turns (never during one) the idle process is closed and the same
      // session is resumed by id with the new flags. The conversation stays; nothing is interrupted.
      await this.proc.close();
      try {
        await this.start();
      } catch (e) {
        return { status: 'failed', error: (e as Error).message };
      }
      sink(
        noticeEvent(
          N('claude.restartedConfig', {
            model: this.config.model ?? N('word.followDefault'),
            effort: this.config.effort ?? N('word.default'),
            perm: N(this.config.permissionMode ? `perm.${this.config.permissionMode}` : 'perm.follow'),
            how: N(this.persisted ? 'word.resume' : 'word.create'),
            id: this.nativeSessionId,
          }),
        ),
      );
      if (this.current) sink({ type: 'config.effective', effective: this.current });
      if (this.permission) sink({ type: 'permission.effective', permission: this.permission });
    } else if (!this.proc?.running || this.proc.killRequested) {
      // The process died or is being killed (crash, kill, billing guard). Start it again on this exact id — never
      // "most recent" — once the old one is gone, so nothing reaches a process that was stopped.
      try {
        if (this.proc?.running) await this.proc.terminate();
        await this.start();
      } catch (e) {
        return { status: 'failed', error: (e as Error).message };
      }
      sink(noticeEvent(N('claude.restarted', { how: N(this.persisted ? 'word.resume' : 'word.create'), id: this.nativeSessionId })));
      if (this.current) sink({ type: 'config.effective', effective: this.current });
      if (this.permission) sink({ type: 'permission.effective', permission: this.permission });
    }
    const turn = new ClaudeTurn(this, this.proc!, sink, signal);
    this.turn = turn;
    this.persisted = true;
    try {
      return await turn.run(input.text, input.attachments ?? [], !!input.command);
    } finally {
      this.turn = null;
    }
  }

  respondApproval(nativeRequestId: string, decision: ApprovalDecision): ApprovalAnswer {
    if (!this.turn) return { ok: false, error: L('该成员当前没有进行中的回合，请求已失效', 'This member has no turn running; the request is no longer valid') };
    return this.turn.respond(nativeRequestId, decision);
  }

  private onMessage(msg: any) {
    if (this.turn) return this.turn.onMessage(msg);
    // Between turns nothing may be granted: deny stray permission prompts, refuse other host requests.
    if (msg?.type === 'control_request') {
      if (msg.request?.subtype === 'can_use_tool') this.proc?.respond(msg.request_id, { behavior: 'deny', message: denyText('noTurn', this.language()) });
      else this.proc?.respondError(msg.request_id, `Harness Team 不支持 ${msg.request?.subtype}`);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.adapter.forget(this);
    await this.proc?.close();
  }
}

/**
 * Adds the built-in Team MCP server on top of the user's own MCP configuration (no --strict-mcp-config) and
 * pre-allows only that server's tools: they are collaboration-only (messages/tasks) and cannot approve anything.
 * Also pre-allows reading (only reading) the room's attachments directory, so a member can open a PDF or file the
 * user sent without a prompt (user approved, 2026-11-07). The user's own permission rules still govern every other
 * tool, and their deny / ask rules still win over these (Claude Code checks deny, then ask, then allow).
 */
export function teamMcpArgs(team: { serverName: string; configFile: string } | undefined, readableDirs: string[] = []): string[] {
  const allowed = readableDirs.map((d) => readAllowRule(d)).filter((r): r is string => !!r);
  if (team) allowed.unshift(`mcp__${team.serverName}`);
  const config = team ? ['--mcp-config', team.configFile] : [];
  return [...config, ...(allowed.length ? ['--allowedTools', ...allowed] : [])];
}

/** Private folders holding a Team MCP config, removed at the latest when the Core exits. */
const liveMcpDirs = new Set<string>();
let exitHooked = false;
const MCP_DIR = /^ht-mcp-(\d+)-/;

/**
 * Removes Team MCP folders that a Core which no longer runs left behind (a hard kill skips the exit cleanup). The
 * folder name carries the owning Core's pid; a folder is removed only when that process is gone and, on macOS /
 * Linux, the folder belongs to this user. A reused pid only means a folder is kept a while longer.
 */
export function sweepStaleMcpDirs(root = tmpdir()): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return 0;
  }
  for (const name of names) {
    const pid = Number(MCP_DIR.exec(name)?.[1]);
    if (!pid || pid === process.pid || processAlive(pid)) continue;
    const dir = join(root, name);
    try {
      if (process.platform !== 'win32' && statSync(dir).uid !== process.getuid?.()) continue;
      rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch {
      // left for a later start
    }
  }
  return removed;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * The Team MCP URL carries the session's token, so it is never put on the command line: on macOS and Linux every
 * local user can read a process's arguments (`ps`). It is written to a file only this user can read, inside a fresh
 * private folder (0700, created by mkdtemp), and `--mcp-config` gets the file's path. The folder is removed when the
 * claude process exits, and any left over when the Core itself exits. A hard kill of the Core can leave one behind
 * (its token was only valid inside that Core run); the next Core removes it before writing its first one.
 */
export function writeTeamMcpConfig(team: TeamMcpConfig): { file: string; remove(): void } {
  if (!exitHooked) {
    exitHooked = true;
    sweepStaleMcpDirs();
    process.once('exit', () => {
      for (const d of liveMcpDirs) {
        try {
          rmSync(d, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    });
  }
  const dir = mkdtempSync(join(tmpdir(), `ht-mcp-${process.pid}-`));
  const file = join(dir, 'mcp.json');
  const remove = () => {
    if (!liveMcpDirs.delete(dir)) return;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };
  liveMcpDirs.add(dir);
  try {
    writeFileSync(file, JSON.stringify({ mcpServers: { [team.serverName]: { type: 'http', url: team.url } } }), { mode: 0o600 });
  } catch (e) {
    remove();
    throw e;
  }
  return { file, remove };
}

/**
 * Claude Code permission rule that allows reading everything under `dir`: `Read(//<absolute path>/**)`. Rules use
 * gitignore syntax, `//` is the filesystem root, and Windows paths are matched in POSIX form (`C:\x` → `/c/x`).
 * Returns null when no exact rule can be written: relative, UNC or device paths (Claude Code never pre-allows reads
 * from network paths anyway), or a path with gitignore special characters (hand-written rules are not escaped, so it
 * could match something else). Then reads keep going through Claude Code's normal prompts.
 */
export function readAllowRule(dir: string, platform: NodeJS.Platform = process.platform): string | null {
  let p: string;
  if (platform === 'win32') {
    const m = /^([A-Za-z]):[\\/](.*)$/.exec(dir);
    if (!m) return null;
    p = `/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, '/')}`;
  } else {
    if (!dir.startsWith('/')) return null;
    p = dir;
  }
  p = p.replace(/\/+$/, '');
  if (p.length < 3 || /[*?[\]!#\\\u0000-\u001f]/.test(p) || /\/\/|\/\.\.?(\/|$)/.test(p)) return null;
  return `Read(/${p}/**)`;
}

function describeSession(init: any, s: ClaudeSession, resumed: boolean, version: string | null | undefined): NoticeText[] {
  const acct = init.account ?? {};
  const model = Array.isArray(init.models) ? init.models.find((m: any) => m?.value === 'default') ?? init.models[0] : null;
  const auth =
    s.billing === 'subscription'
      ? N('claude.authSub', { plan: String(acct.subscriptionType), provider: String(acct.apiProvider) })
      : N('claude.authOwn', { source: s.adapter.login().source ?? String(acct.apiProvider) });
  const args = modelArgs(s.configForInfo);
  return [
    N(resumed ? 'claude.sessionResumed' : 'claude.sessionNew'),
    N('session.id', { id: s.nativeSessionId }),
    N('claude.backend', { backend: CLAUDE_BACKEND, version: init.claude_code_version ?? version ?? '?' }),
    auth,
    N('claude.modelLine', {
      model: s.current?.model ?? (model ? `${model.value} → ${model.resolvedModel ?? '?'}` : '?'),
      effort: s.current?.effort ? N('claude.effort', { effort: s.current.effort }) : null,
      args: args.length ? N('claude.modelArgs', { args: args.join(' ').replace(/^--/, '') }) : N('claude.modelDefault'),
      mode: init.current_permission_mode ?? '?',
    }),
    N('session.cwd', { path: s.cwd }),
    ...s.readableDirs.map((d) => {
      const rule = readAllowRule(d);
      return rule ? N('claude.attachRule', { dir: d, rule }) : N('claude.attachNoRule', { dir: d });
    }),
  ];
}

// ---------------------------------------------------------------------------------------------------------------

const DETAIL_MAX = 6000;

interface ToolState {
  name: string;
  input: any;
  sub: boolean;
  mapped: MappedTool;
}

/** One turn: sends one user message and maps stream-json output until the CLI's `result`. */
class ClaudeTurn {
  private finished = false;
  private finish!: (r: TurnResult) => void;
  private readonly done: Promise<TurnResult>;
  private interruptRequested = false;
  private interruptTimer: NodeJS.Timeout | null = null;
  /** Set once an unconfirmed interrupt escalated to a forced stop; all further output of this process is ignored. */
  private forcing = false;
  /** request_id -> the tool request as Claude Code sent it (input is echoed back unchanged on allow). */
  private readonly pending = new Map<string, { toolUseId: string | null; toolName: string; input: unknown; session: ClaudePermissionUpdate[] }>();
  private readonly tools = new Map<string, ToolState>();
  private curMsgId = '';
  private readonly streamIdx = new Map<number, string>();
  private readonly streamTextCount = new Map<string, number>();
  private readonly doneTextCount = new Map<string, number>();
  private rateLimit: any = null;
  private quotaNoticed = false;
  private assistantError: string | null = null;
  private assistantErrorText: string | null = null;
  private usage: TurnUsage[] | null = null;
  /**
   * Background agents this turn started that have not reported finished (tool_use id -> task id). Claude Code ends
   * its query while they run and, as each one finishes, goes on by itself in a further query of its own; the turn
   * stays open until none is left, so those replies reach the room.
   */
  private readonly background = new Map<string, string | null>();
  /** The outcome of the last query, kept while background agents still run. */
  private waiting: TurnResult | null = null;
  /** A follow-up query is running (its `system/init` arrived after a `result`). */
  private followUp = false;
  private followUpTimer: NodeJS.Timeout | null = null;

  private readonly session: ClaudeSession;
  private readonly proc: StreamJsonProcess;
  private readonly sink: TurnEventSink;
  private readonly signal: AbortSignal;

  constructor(session: ClaudeSession, proc: StreamJsonProcess, sink: TurnEventSink, signal: AbortSignal) {
    this.session = session;
    this.proc = proc;
    this.sink = sink;
    this.signal = signal;
    this.done = new Promise((r) => (this.finish = r));
  }

  /** `command`: `text` is a slash command, sent alone as the user message so Claude Code runs it itself. */
  async run(text: string, attachments: TurnAttachment[] = [], command = false): Promise<TurnResult> {
    // Images as content blocks of the user message (the Agent SDK's streaming-input shape); other files only by path.
    let images: unknown[];
    try {
      images = await Promise.all(
        attachments
          .filter((a) => a.kind === 'image')
          .map(async (a) => ({ type: 'image', source: { type: 'base64', media_type: a.mime, data: (await readFile(a.path)).toString('base64') } })),
      );
    } catch (e) {
      return { status: 'failed', error: L('无法读取附件：{error}', 'Could not read an attachment: {error}', { error: (e as Error).message }) };
    }
    const onAbort = () => void this.interrupt();
    this.signal.addEventListener('abort', onAbort, { once: true });
    try {
      this.proc.send({ type: 'user', message: { role: 'user', content: command ? text : [{ type: 'text', text }, ...images] }, parent_tool_use_id: null });
      return await this.done;
    } finally {
      this.signal.removeEventListener('abort', onAbort);
      if (this.interruptTimer) clearTimeout(this.interruptTimer);
      if (this.followUpTimer) clearTimeout(this.followUpTimer);
    }
  }

  private emit: TurnEventSink = (ev) => {
    if (!this.finished) this.sink(ev);
  };

  private end(r: TurnResult) {
    if (this.finished) return;
    for (const [requestId] of this.pending) {
      this.proc.respond(requestId, { behavior: 'deny', message: denyText('turnEnded', this.session.language()) });
      this.sink({ type: 'approval.resolved', nativeRequestId: requestId, decision: 'cancelled' });
    }
    this.pending.clear();
    this.finished = true;
    this.finish(this.usage ? { ...r, usage: this.usage } : r);
  }

  onExit(reason: Localized) {
    if (this.forcing || this.stopping) return; // forceStop / endStoppingBackground report the outcome themselves
    this.end({ status: 'failed', error: reason });
  }

  /** Set while background agents are stopped and the process closed at the end of the turn; its output is ignored. */
  private stopping = false;

  /**
   * Ends the turn. Background agents still running are stopped first and the process is closed (the next turn resumes
   * the same session by id), so nothing Claude Code does after they finish can reach this or a later turn.
   */
  private async endStoppingBackground(r: TurnResult) {
    if (this.followUpTimer) clearTimeout(this.followUpTimer);
    this.waiting = null;
    if (this.background.size && !this.finished && !this.forcing) {
      const tasks = [...this.background.values()].filter((t): t is string => !!t);
      this.background.clear();
      this.stopping = true;
      await Promise.all(tasks.map((task_id) => this.proc.control({ subtype: 'stop_task', task_id }, 5000).catch(() => undefined)));
      await this.proc.close();
    }
    this.end(r);
  }

  /** A background agent Claude Code started in this turn (`system/task_started`, or the Agent tool's launch result). */
  private backgroundStarted(toolUseId: string | null, taskId: string | null) {
    const key = toolUseId ?? taskId;
    if (key) this.background.set(key, taskId ?? this.background.get(key) ?? null);
  }

  private backgroundFinished(msg: any) {
    const toolUseId = msg.tool_use_id ? String(msg.tool_use_id) : null;
    const taskId = msg.task_id ? String(msg.task_id) : null;
    const key = toolUseId && this.background.has(toolUseId) ? toolUseId : [...this.background].find(([, t]) => t && t === taskId)?.[0];
    if (!key) return;
    this.background.delete(key);
    // Claude Code now runs a follow-up query by itself. Should none start, the turn ends with what it has.
    if (this.waiting && !this.followUp && !this.background.size) {
      if (this.followUpTimer) clearTimeout(this.followUpTimer);
      this.followUpTimer = setTimeout(() => {
        if (this.waiting && !this.followUp) void this.endStoppingBackground(this.waiting);
      }, this.session.adapter.opts.followUpTimeoutMs ?? 60_000);
    }
  }

  private async interrupt() {
    if (this.finished || this.interruptRequested) return;
    this.interruptRequested = true;
    const ms = this.session.adapter.opts.interruptTimeoutMs ?? 20_000;
    this.interruptTimer = setTimeout(() => void this.forceStop(ms), ms);
    // The CLI cancels its own pending permission prompts on interrupt (control_cancel_request); anything it
    // leaves open afterwards is denied explicitly. Nothing is ever allowed.
    try {
      await this.proc.control({ subtype: 'interrupt' }, 15_000);
    } catch (e) {
      this.emit(noticeEvent(N('claude.interruptFailed', { error: (e as Error).message })));
    }
    for (const [requestId] of this.pending) {
      this.proc.respond(requestId, { behavior: 'deny', message: denyText('interrupted', this.session.language()) });
      this.emit({ type: 'approval.resolved', nativeRequestId: requestId, decision: 'cancelled' });
    }
    this.pending.clear();
    // Only background agents were running (no query, so no `result` follows): they are stopped and the turn ends.
    if (this.waiting && !this.followUp) await this.endStoppingBackground({ status: 'interrupted' });
  }

  /**
   * The CLI did not confirm the interrupt in time. Its process can no longer be trusted for this session: stop
   * mapping its output (late events must not be attributed to this or any later turn), kill the process tree and
   * only then release the turn. The next turn starts a fresh process with `--resume <same id>`.
   */
  private async forceStop(ms: number) {
    if (this.finished || this.forcing) return;
    this.forcing = true;
    const pid = this.proc.pid;
    const confirmed = await this.proc.terminate(this.session.adapter.opts.killConfirmTimeoutMs ?? 5000);
    if (!confirmed) this.session.unconfirmedStop = this.proc;
    const params = { ms, pid: String(pid ?? '?') };
    this.end({
      status: 'failed',
      error: confirmed
        ? L(
            '已请求中断，但 {ms} ms 内未收到 Claude Code 的结束确认。已强制结束该 claude 进程（PID {pid}）及其子进程；中断前已执行的工具操作可能已生效，请核对工作目录。下一条消息将按同一会话 ID 重新启动并恢复。',
            'You asked to interrupt, but Claude Code did not confirm the end within {ms} ms. The claude process (PID {pid}) and its child processes were force-stopped; tool actions taken before the interrupt may already have taken effect, so check the working folder. The next message restarts and resumes the same session ID.',
            params,
          )
        : L(
            '已请求中断，但 {ms} ms 内未收到 Claude Code 的结束确认。已尝试强制结束 claude 进程（PID {pid}），但未能确认其退出，它可能仍在运行。在确认其退出前不会向该成员派发新消息；请核对工作目录。',
            'You asked to interrupt, but Claude Code did not confirm the end within {ms} ms. Force-stopping the claude process (PID {pid}) was attempted, but its exit could not be confirmed and it may still be running. No new messages go to this member until it has exited; check the working folder.',
            params,
          ),
    });
  }

  onMessage(msg: any) {
    if (this.finished || this.forcing || this.stopping || !msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'system':
        return this.onSystem(msg);
      case 'stream_event':
        return this.onStreamEvent(msg);
      case 'assistant':
        return this.onAssistant(msg);
      case 'user':
        return this.onUser(msg);
      case 'rate_limit_event':
        return this.onRateLimit(msg.rate_limit_info ?? {});
      case 'control_request':
        return this.onControlRequest(msg);
      case 'control_cancel_request': {
        const id = String(msg.request_id);
        if (this.pending.delete(id)) this.emit({ type: 'approval.resolved', nativeRequestId: id, decision: 'cancelled' });
        return;
      }
      case 'result':
        return this.onResult(msg);
      default:
        return;
    }
  }

  private onSystem(msg: any) {
    switch (msg.subtype) {
      case 'init': {
        if (msg.session_id && msg.session_id !== this.session.nativeSessionId) {
          this.proc.kill();
          return this.end({
            status: 'failed',
            error: L('Claude Code 报告了不同的会话 {got}（期望 {want}），已停止', 'Claude Code reported a different session {got} (expected {want}); stopped', { got: String(msg.session_id), want: this.session.nativeSessionId }),
          });
        }
        // Billing guard: the member shows the subscription, and this turn would bill per token (API key,
        // apiKeyHelper, Console key). A member that shows per-token billing runs as detected.
        const actual = msg.apiKeySource === 'none' ? 'subscription' : 'metered_api';
        const switched = billingSwitched(this.session.billing, actual, `apiKeySource=${JSON.stringify(msg.apiKeySource)}`);
        if (msg.apiKeySource !== undefined) this.session.onBilling(actual);
        if (switched) {
          this.proc.kill();
          return this.end({ status: 'failed', error: switched });
        }
        if (this.waiting) {
          // The follow-up query Claude Code runs by itself after a background agent finished.
          this.followUp = true;
          if (this.followUpTimer) clearTimeout(this.followUpTimer);
        }
        this.emit({ type: 'turn.started', nativeTurnId: String(msg.uuid ?? '') });
        if (msg.permissionMode !== undefined) {
          // Reported on every turn: shows a mode that changed inside the session (e.g. after a plan was approved).
          const permission = claudePermission(msg.permissionMode, this.session.configForInfo.permissionMode, 'Claude Code system/init');
          this.session.permission = permission;
          this.emit({ type: 'permission.effective', permission });
        }
        if (this.session.initShownForPid !== this.proc.pid) {
          this.session.initShownForPid = this.proc.pid;
          this.emit(noticeEvent(describeInit(msg)));
          const trust = untrustedWorkspaceNotice(this.proc.stderrTail);
          if (trust) this.emit(noticeEvent(trust));
        }
        return;
      }
      case 'hook_started':
        // Shown only once it produced output or failed (user plugins fire several silent hooks per tool call).
        return;
      case 'hook_response': {
        const out = [msg.stdout, msg.stderr, typeof msg.output === 'string' ? msg.output : null].filter((x) => typeof x === 'string' && x.trim()).join('\n');
        const failed = msg.outcome ? msg.outcome !== 'success' : typeof msg.exit_code === 'number' && msg.exit_code !== 0;
        if (!out && !failed) return;
        return this.emit({
          type: 'activity',
          itemId: `hook:${msg.hook_id}`,
          activity: 'other',
          title: `Hook · ${msg.hook_name ?? msg.hook_event}`,
          detail: [`outcome: ${msg.outcome ?? '?'} · exit code: ${msg.exit_code ?? '?'}`, clip(out)].filter(Boolean).join('\n'),
          nativeStatus: msg.outcome ?? null,
          done: true,
          failed,
        });
      }
      case 'compact_boundary':
        return this.emit(noticeEvent(N('claude.compacted')));
      case 'task_started':
        // Only agents of this session that run in the background (a background shell may run for good, e.g. a server).
        if (msg.is_backgrounded === true && !msg.owned_by_subagent && !msg.parent_task_id && BACKGROUND_AGENT_TASKS.has(msg.task_type)) {
          this.backgroundStarted(msg.tool_use_id ? String(msg.tool_use_id) : null, msg.task_id ? String(msg.task_id) : null);
        }
        return;
      case 'task_notification':
        return this.backgroundFinished(msg);
      case 'status': {
        // A mode change inside the turn (live 2.1.319: `system/status` permissionMode "default" right after the plan
        // sign-off was approved). Leaving plan mode that way is expected, not a mismatch: the next turn restarts in plan.
        if (typeof msg.permissionMode !== 'string' || msg.permissionMode === this.session.permission?.native) return;
        const want = this.session.configForInfo.permissionMode;
        const permission = claudePermission(msg.permissionMode, want, 'Claude Code system/status');
        if (want === 'plan' && this.session.planApproved) permission.mismatch = null;
        this.session.permission = permission;
        return this.emit({ type: 'permission.effective', permission });
      }
      default:
        if (typeof msg.subtype === 'string' && /retry/i.test(msg.subtype)) {
          this.emit(noticeEvent(N('claude.retrying', { detail: `${msg.subtype}${msg.error ? `：${typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error)}` : ''}` })));
        }
        return;
    }
  }

  private onStreamEvent(msg: any) {
    if (msg.parent_tool_use_id) return; // sub-agent internals are summarized by their tool activity
    const ev = msg.event ?? {};
    switch (ev.type) {
      case 'message_start':
        this.curMsgId = String(ev.message?.id ?? msg.api_message_id ?? '');
        this.streamIdx.clear();
        return;
      case 'content_block_start':
        if (ev.content_block?.type === 'text') {
          const n = this.streamTextCount.get(this.curMsgId) ?? 0;
          this.streamTextCount.set(this.curMsgId, n + 1);
          this.streamIdx.set(ev.index, `${this.curMsgId}#${n}`);
        }
        return;
      case 'content_block_delta': {
        if (ev.delta?.type !== 'text_delta') return;
        const itemId = this.streamIdx.get(ev.index);
        if (itemId) this.emit({ type: 'text.delta', itemId, text: String(ev.delta.text ?? '') });
        return;
      }
      default:
        return;
    }
  }

  private onAssistant(msg: any) {
    const m = msg.message ?? {};
    const sub = !!msg.parent_tool_use_id;
    if (msg.error) {
      this.assistantError = String(msg.error);
      this.assistantErrorText = (m.content ?? []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n') || null;
    }
    for (const block of Array.isArray(m.content) ? m.content : []) {
      if (block?.type === 'text' && !sub) {
        const n = this.doneTextCount.get(m.id) ?? 0;
        this.doneTextCount.set(m.id, n + 1);
        this.emit({ type: 'text.done', itemId: `${m.id}#${n}`, text: String(block.text ?? '') });
      } else if (block?.type === 'tool_use' && block.id) {
        const mapped = mapTool(String(block.name), block.input ?? {}, this.session.cwd);
        this.tools.set(block.id, { name: block.name, input: block.input, sub, mapped });
        this.emit({
          type: 'activity',
          itemId: block.id,
          activity: mapped.activity,
          ...subTitled(mapped, sub),
          detail: mapped.detail,
          files: mapped.files,
          nativeStatus: 'running',
          done: false,
        });
      }
    }
  }

  private onUser(msg: any) {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block?.type !== 'tool_result' || !block.tool_use_id) continue;
      const t = this.tools.get(block.tool_use_id);
      if (!t) continue;
      const failed = block.is_error === true;
      const out = resultText(block.content);
      // As Claude Code 2.1.319 answers an Agent call it runs in the background.
      const launched = !t.sub && !failed && (t.name === 'Agent' || t.name === 'Task') ? /^Async agent launched/.exec(out ?? '') : null;
      if (launched) this.backgroundStarted(block.tool_use_id, /agentId:\s*([\w-]+)/.exec(out ?? '')?.[1] ?? null);
      this.emit({
        type: 'activity',
        itemId: block.tool_use_id,
        activity: t.mapped.activity,
        ...subTitled(t.mapped, t.sub),
        detail: [t.mapped.detail, out ? `${failed ? '错误' : '结果'}：\n${t.name === 'Read' ? head(out, 2000) : clip(out)}` : null].filter(Boolean).join('\n\n') || null,
        nativeStatus: failed ? 'error' : 'completed',
        files: t.mapped.files,
        done: true,
        failed,
      });
    }
  }

  private onRateLimit(info: any) {
    this.rateLimit = info;
    if (info.status === 'rejected' && !this.quotaNoticed) {
      this.quotaNoticed = true;
      this.emit(noticeEvent(N('claude.quotaReached', { type: claudeLimitName(info.rateLimitType), reset: info.resetsAt ? N('claude.quotaReset', { time: fmtTime(info.resetsAt) }) : null })));
    } else if (info.status === 'allowed_warning') {
      this.emit(
        noticeEvent(
          N('claude.quotaWarning', { type: claudeLimitName(info.rateLimitType), used: typeof info.utilization === 'number' ? N('claude.quotaUsed', { pct: Math.round(info.utilization * 100) }) : null }),
        ),
      );
    }
    if (!this.session.overageWarned && (info.isUsingOverage === true || info.overageStatus === 'allowed' || info.overageStatus === 'allowed_warning')) {
      this.session.overageWarned = true;
      this.emit(noticeEvent(N(info.isUsingOverage ? 'claude.overageUsing' : 'claude.overageEnabled')));
    }
  }

  /** The user's decision for one pending permission prompt of this turn, sent on its exact request_id. */
  respond(requestId: string, decision: ApprovalDecision): ApprovalAnswer {
    const p = this.pending.get(requestId);
    if (this.finished || this.forcing || !p) return { ok: false, error: REQUEST_GONE };
    if (this.interruptRequested || this.signal.aborted) return { ok: false, error: REQUEST_INTERRUPTED };
    if (!claudeApprovalOptions(p.toolName, p.session).includes(decision)) return { ok: false, error: unsupportedDecision(p.toolName, decision) };
    this.pending.delete(requestId);
    if (decision === 'allow_session') {
      this.proc.respond(requestId, { behavior: 'allow', updatedInput: p.input, updatedPermissions: p.session });
      return { ok: true, nativeDecision: 'allow (session rules)' };
    }
    if (decision === 'allow') {
      this.proc.respond(requestId, { behavior: 'allow', updatedInput: p.input });
      if (p.toolName === 'ExitPlanMode') this.session.planApproved = true;
      return { ok: true, nativeDecision: 'allow' };
    }
    this.proc.respond(requestId, { behavior: 'deny', message: denyText('denied', this.session.language()) });
    return { ok: true, nativeDecision: 'deny' };
  }

  private onControlRequest(msg: any) {
    const req = msg.request ?? {};
    const requestId = String(msg.request_id);
    if (req.subtype !== 'can_use_tool') {
      this.proc.respondError(requestId, `Harness Team 不支持 ${req.subtype}`);
      return;
    }
    if (this.interruptRequested || this.signal.aborted) {
      this.proc.respond(requestId, { behavior: 'deny', message: denyText('interrupting', this.session.language()) });
      return;
    }
    const toolUseId = req.tool_use_id ? String(req.tool_use_id) : null;
    const toolName = String(req.tool_name);
    const session = sessionPermissionUpdates(req.permission_suggestions ?? req.suggestions);
    this.pending.set(requestId, { toolUseId, toolName, input: req.input ?? {}, session });
    const mapped = mapTool(toolName, req.input ?? {}, this.session.cwd);
    this.emit({
      type: 'approval.requested',
      nativeRequestId: requestId,
      nativeMethod: 'can_use_tool',
      itemId: toolUseId,
      ...titled(N('approval.useTool', { tool: String(req.display_name ?? req.tool_name), title: mapped.label ?? mapped.title })),
      reason: req.decision_reason ? String(req.decision_reason) : null,
      // The tool's own description is often the same text as the mapped detail (Bash `description`): show it once.
      detail:
        [req.description && !(mapped.detail ?? '').includes(String(req.description)) ? String(req.description) : null, mapped.detail]
          .filter(Boolean)
          .join('\n') || null,
      options: claudeApprovalOptions(toolName, session),
    });
  }

  private onResult(msg: any) {
    // Tokens were spent whether the turn succeeded, failed or was interrupted (each query of the turn reports its own).
    this.usage = addUsage(this.usage, claudeUsage(msg, this.session.effective?.model ?? null));
    const denials: any[] = Array.isArray(msg.permission_denials) ? msg.permission_denials : [];
    if (denials.length) {
      this.emit(noticeEvent(N('claude.denied', { list: denials.map((d) => mapTool(String(d.tool_name), d.tool_input ?? {}, this.session.cwd).label ?? N('tool.other', { name: String(d.tool_name) })) })));
    }
    this.followUp = false;
    let r: TurnResult;
    if (msg.subtype === 'success' && !msg.is_error) r = { status: 'completed' };
    else if (this.interruptRequested && (msg.subtype === 'error_during_execution' || /^aborted/.test(String(msg.terminal_reason ?? '')))) r = { status: 'interrupted' };
    else r = { status: 'failed', error: this.describeFailure(msg) };
    // Background agents still run: Claude Code goes on by itself once they finish, within this turn.
    if (r.status === 'completed' && !this.interruptRequested && this.background.size) {
      this.waiting = r;
      return;
    }
    void this.endStoppingBackground(r);
  }

  private describeFailure(msg: any): Localized {
    const raw =
      [Array.isArray(msg.errors) ? msg.errors.join('; ') : null, typeof msg.result === 'string' ? msg.result : null, this.assistantErrorText]
        .filter((x) => x && String(x).trim())
        .join(' · ') || `terminal_reason=${msg.terminal_reason ?? msg.subtype ?? '?'}`;
    if (this.rateLimit?.status === 'rejected' || this.assistantError === 'rate_limit') {
      return L(
        'Claude 订阅额度已用尽（{kind}{reset}）。Harness Team 不会切换到 API Key 或其他付费方式，请等待额度恢复。原始信息：{raw}',
        'The Claude subscription limit is used up ({kind}{reset}). Harness Team never switches to an API key or other paid options; wait for the limit to reset. Original message: {raw}',
        {
          kind: claudeLimitName(this.rateLimit?.rateLimitType),
          reset: this.rateLimit?.resetsAt ? L('，约 {at} 重置', ', resets around {at}', { at: fmtTime(this.rateLimit.resetsAt) }) : null,
          raw,
        },
      );
    }
    if (this.assistantError === 'authentication_failed' || /\b401\b|authenticat|oauth|\/login|not logged in/i.test(raw)) {
      return L(
        'Claude Code 认证失败。请在你自己的终端运行 claude 并用 /login 登录 claude.ai（Harness Team 不处理登录凭据）。原始信息：{raw}',
        'Claude Code authentication failed. Run claude in your own terminal and log in to claude.ai with /login (Harness Team does not handle login credentials). Original message: {raw}',
        { raw },
      );
    }
    if (this.assistantError === 'billing_error') {
      return L('Claude 账户计费错误；Harness Team 不会改用其他付费方式。原始信息：{raw}', 'Claude account billing error; Harness Team does not switch to other paid options. Original message: {raw}', { raw });
    }
    return raw;
  }
}

/** Claude Code task types that are agents (`system/task_started` task_type); shells and monitors are not waited for. */
const BACKGROUND_AGENT_TASKS = new Set(['local_agent', 'remote_agent', 'local_workflow']);

/** Usage of several queries of one turn, added up per model. */
export function addUsage(a: TurnUsage[] | null, b: TurnUsage[] | null): TurnUsage[] | null {
  if (!a?.length) return b;
  if (!b?.length) return a;
  const out = a.map((r) => ({ ...r }));
  for (const r of b) {
    const same = out.find((x) => x.model === r.model);
    if (!same) {
      out.push({ ...r });
      continue;
    }
    same.input += r.input;
    same.cacheRead += r.cacheRead;
    same.cacheWrite += r.cacheWrite;
    same.output += r.output;
    same.reasoning += r.reasoning;
    same.costUsd = same.costUsd === null || r.costUsd === null ? null : same.costUsd + r.costUsd;
  }
  return out;
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/**
 * Usage from Claude Code's stream-json `result` event. `modelUsage` (per model, including helper models such as the one
 * used for titles or subagents) is preferred; otherwise the turn-level `usage` is attributed to `fallbackModel`.
 * Claude's input_tokens already exclude cache reads and cache writes. Returns null when the event carries no usage.
 */
export function claudeUsage(msg: any, fallbackModel: string | null): TurnUsage[] | null {
  const per = msg?.modelUsage;
  if (per && typeof per === 'object' && !Array.isArray(per)) {
    const out: TurnUsage[] = [];
    for (const [model, u] of Object.entries<any>(per)) {
      if (!u || typeof u !== 'object') continue;
      const row: TurnUsage = {
        model,
        input: count(u.inputTokens),
        cacheRead: count(u.cacheReadInputTokens),
        cacheWrite: count(u.cacheCreationInputTokens),
        output: count(u.outputTokens),
        reasoning: 0,
        costUsd: typeof u.costUSD === 'number' && Number.isFinite(u.costUSD) ? u.costUSD : null,
      };
      if (row.input + row.cacheRead + row.cacheWrite + row.output > 0) out.push(row);
    }
    if (out.length) return out;
  }
  const u = msg?.usage;
  if (!u || typeof u !== 'object') return null;
  const row: TurnUsage = {
    model: fallbackModel,
    input: count(u.input_tokens),
    cacheRead: count(u.cache_read_input_tokens),
    cacheWrite: count(u.cache_creation_input_tokens),
    output: count(u.output_tokens),
    reasoning: 0,
    costUsd: typeof msg.total_cost_usd === 'number' && Number.isFinite(msg.total_cost_usd) ? msg.total_cost_usd : null,
  };
  return row.input + row.cacheRead + row.cacheWrite + row.output > 0 ? [row] : null;
}

/**
 * Claude Code ignores a project's `.claude/settings.json` permissions.allow rules in `-p` mode until the user has
 * trusted that folder interactively. Harness Team never trusts folders on the user's behalf; it only says so.
 */
/**
 * Decisions offered for a Claude Code permission prompt. "allow" answers this one request with the original input;
 * "allow_session" also sends Claude Code's own suggested rules for the session, offered only when there are some.
 * AskUserQuestion expects the user's own answers, so it can only be refused from the group chat. ExitPlanMode (the
 * plan sign-off of plan mode) can be approved once: the original input is the plan itself, and what Claude Code does
 * next still goes through its own prompts.
 */
export function claudeApprovalOptions(toolName: string, session: ClaudePermissionUpdate[] = []): ApprovalDecision[] {
  if (toolName === 'AskUserQuestion') return ['deny'];
  return session.length && toolName !== 'ExitPlanMode' ? ['allow', 'allow_session', 'deny'] : ['allow', 'deny'];
}

export type ClaudePermissionUpdate =
  | { type: 'addRules'; rules: { toolName: string; ruleContent?: string }[]; behavior: 'allow'; destination: 'session' }
  | { type: 'addDirectories'; directories: string[]; destination: 'session' };

/**
 * Claude Code's suggested permission updates for one request, kept for "allow for this session": only allow rules and
 * extra directories, always with destination `session` (a suggestion aimed at a settings file is not written there).
 * Mode changes are left out: they would move the process off the member's chosen mode. Anything malformed is dropped.
 */
export function sessionPermissionUpdates(raw: unknown): ClaudePermissionUpdate[] {
  if (!Array.isArray(raw)) return [];
  const out: ClaudePermissionUpdate[] = [];
  for (const u of raw) {
    if (u?.type === 'addRules' && u.behavior === 'allow' && Array.isArray(u.rules)) {
      const rules = u.rules
        .filter((r: any) => r && typeof r.toolName === 'string' && r.toolName && (r.ruleContent === undefined || typeof r.ruleContent === 'string'))
        .map((r: any) => (r.ruleContent === undefined ? { toolName: r.toolName } : { toolName: r.toolName, ruleContent: r.ruleContent }));
      if (rules.length) out.push({ type: 'addRules', rules, behavior: 'allow', destination: 'session' });
    } else if (u?.type === 'addDirectories' && Array.isArray(u.directories)) {
      const directories = u.directories.filter((d: unknown) => typeof d === 'string' && d);
      if (directories.length) out.push({ type: 'addDirectories', directories, destination: 'session' });
    }
  }
  return out;
}

export function untrustedWorkspaceNotice(stderr: string): NoticeText | null {
  const line = stderr.split('\n').find((l) => /has not been trusted/i.test(l));
  if (!line) return null;
  const n = /Ignoring (\d+) permissions?\.allow/i.exec(line)?.[1];
  return N('claude.untrusted', { count: n ? N('claude.untrustedCount', { n }) : null });
}

export function untrustedWorkspaceWarning(stderr: string): string | null {
  const n = untrustedWorkspaceNotice(stderr);
  return n ? zhText(n) : null;
}

function describeInit(msg: any): NoticeText {
  const list = (v: any) => (Array.isArray(v) ? v : []);
  const skills = list(msg.skills).map(String);
  const mcp = list(msg.mcp_servers).map((s: any) => `${s.name}（${s.status}）`);
  const source = msg.apiKeySource === 'none' ? N('claude.sourceSub') : N('claude.sourceOther', { source: String(msg.apiKeySource) });
  const lines = [
    N('claude.initMode', { mode: msg.permissionMode ?? '?', source: String(msg.apiKeySource) }),
    N('claude.initCounts', { tools: list(msg.tools).length, plugins: list(msg.plugins).length, agents: list(msg.agents).length, commands: list(msg.slash_commands).length }),
    N('claude.initMcp', { list: mcp.length ? mcp.join('，') : N('word.none') }),
    N('claude.initSkills', { n: skills.length, list: head(skills.join(', '), 1500) ?? N('word.none') }),
  ];
  return N('claude.ready', { version: msg.claude_code_version ?? '', model: msg.model ?? '?', source, lines: { lines } });
}

// ---------------------------------------------------------------------------------------------------------------

type MappedTool = { activity: ActivityKind; title: string; label?: NoticeText; detail: string | null; files?: FileChange[] };

function noticeEvent(n: NoticeText): { type: 'notice'; text: string; notice: NoticeText } {
  return { type: 'notice', text: zhText(n), notice: n };
}

/** title (Chinese, stored as the body) + label (translatable). */
function titled(n: NoticeText): { title: string; label: NoticeText } {
  return { title: zhText(n), label: n };
}

/** Title of a tool call, marked when a subagent made it. Raw command lines have no label and stay as they are. */
function subTitled(m: MappedTool, sub: boolean): { title: string; label?: NoticeText } {
  if (!sub) return { title: m.title, label: m.label };
  return titled(N('tool.sub', { title: m.label ?? m.title }));
}

/** Edit-tool input as -/+ lines (Claude Code reports the replaced text, not line numbers). */
function snippetDiff(oldText: unknown, newText: unknown): string {
  const lines = (s: unknown, mark: string) => (typeof s === 'string' && s !== '' ? s.split('\n').map((l) => mark + l) : []);
  return [...lines(oldText, '-'), ...lines(newText, '+')].join('\n');
}

function clip(s: string | null | undefined, max = DETAIL_MAX): string | null {
  if (!s) return null;
  return s.length > max ? `…（已截断，仅显示末尾 ${max} 字符）\n${s.slice(-max)}` : s;
}

function head(s: string | null | undefined, max = DETAIL_MAX): string | null {
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max)}\n…（已截断）` : s;
}

function fmtTime(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  return Number.isNaN(d.getTime()) ? String(epochSeconds) : d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c: any) => (c?.type === 'text' ? String(c.text ?? '') : c?.type ? `[${c.type}]` : ''))
    .filter(Boolean)
    .join('\n');
}

function shortPath(p: unknown, cwd: string): string {
  if (typeof p !== 'string' || !p) return '(?)';
  if (!isAbsolute(p)) return p;
  return relativeInside(cwd, p) ?? p;
}

export function mapTool(name: string, input: any, cwd: string): MappedTool {
  const json = (v: unknown, max = 1500) => head(JSON.stringify(v, null, 1), max);
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return { activity: 'command', title: String(input.command ?? '(command)'), detail: [input.description ? String(input.description) : null, input.run_in_background ? '后台运行' : null].filter(Boolean).join(' · ') || null };
    case 'Edit':
      return {
        activity: 'fileChange',
        ...titled(N('tool.edit', { path: shortPath(input.file_path, cwd) })),
        // Plain -/+ lines: readable in either UI language (the runtime reports snippets, not line numbers).
        detail: head(`${snippetDiff(input.old_string, input.new_string)}${input.replace_all ? '\n(replace_all)' : ''}`, 3000),
        files: [{ path: shortPath(input.file_path, cwd), change: 'edit', diff: snippetDiff(input.old_string, input.new_string) }],
      };
    case 'MultiEdit': {
      const edits: any[] = Array.isArray(input.edits) ? input.edits : [];
      return {
        activity: 'fileChange',
        ...titled(N('tool.multiEdit', { path: shortPath(input.file_path, cwd), n: Array.isArray(input.edits) ? input.edits.length : '?' })),
        detail: head(edits.map((e: any) => snippetDiff(e?.old_string, e?.new_string)).join('\n@@\n'), 3000),
        files: [{ path: shortPath(input.file_path, cwd), change: 'edit', diff: edits.map((e) => snippetDiff(e?.old_string, e?.new_string)).join('\n@@\n') }],
      };
    }
    case 'Write':
      return {
        activity: 'fileChange',
        ...titled(N('tool.write', { path: shortPath(input.file_path, cwd) })),
        detail: head(String(input.content ?? ''), 3000),
        files: [{ path: shortPath(input.file_path, cwd), change: 'write', diff: snippetDiff('', String(input.content ?? '')) }],
      };
    case 'NotebookEdit':
      return {
        activity: 'fileChange',
        ...titled(N('tool.notebook', { path: shortPath(input.notebook_path, cwd) })),
        detail: head(String(input.new_source ?? ''), 3000),
        files: [{ path: shortPath(input.notebook_path, cwd), change: 'edit', diff: snippetDiff('', String(input.new_source ?? '')) }],
      };
    case 'Read':
      return { activity: 'other', ...titled(N('tool.read', { path: shortPath(input.file_path, cwd) })), detail: null };
    case 'Glob':
      return { activity: 'other', ...titled(N('tool.glob', { pattern: String(input.pattern ?? ''), where: input.path ? N('fmt.paren', { x: shortPath(input.path, cwd) }) : null })), detail: null };
    case 'Grep':
      return { activity: 'other', ...titled(N('tool.grep', { pattern: String(input.pattern ?? ''), where: input.path ? N('fmt.paren', { x: shortPath(input.path, cwd) }) : null })), detail: null };
    case 'WebSearch':
      return { activity: 'webSearch', ...titled(N('tool.webSearch', { query: String(input.query ?? '') })), detail: null };
    case 'WebFetch':
      return { activity: 'webSearch', ...titled(N('tool.webFetch', { url: String(input.url ?? '') })), detail: input.prompt ? String(input.prompt) : null };
    case 'TodoWrite': {
      const todos: any[] = Array.isArray(input.todos) ? input.todos : [];
      const mark: Record<string, string> = { completed: '[x]', in_progress: '[~]', pending: '[ ]' };
      return {
        activity: 'plan',
        ...titled(N('tool.plan', { done: todos.filter((t) => t.status === 'completed').length, total: todos.length })),
        detail: todos.map((t) => `${mark[t.status] ?? '[ ]'} ${t.content ?? t.activeForm ?? ''}`).join('\n') || null,
      };
    }
    case 'Task':
    case 'Agent':
      return { activity: 'other', ...titled(N('tool.subagent', { name: String(input.description ?? input.subagent_type ?? '') })), detail: head(input.prompt ? String(input.prompt) : null, 2000) };
    case 'Skill':
      return { activity: 'other', ...titled(N('tool.skill', { name: String(input.skill ?? input.command ?? input.name ?? '') })), detail: input.args ? String(input.args) : null };
    default:
      if (name.startsWith('mcp__')) {
        const [, server, ...rest] = name.split('__');
        return { activity: 'mcpToolCall', title: `${server} · ${rest.join('__')}`, detail: json(input) };
      }
      return { activity: 'other', ...titled(N('tool.other', { name })), detail: json(input) };
  }
}
