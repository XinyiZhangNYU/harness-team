import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type CliLaunch, cliFromPath, findCli, olderThan, parseVersion, versionLabel } from '../cli-path.ts';
import {
  type ActivityKind,
  type AgentLanguage,
  type Agent,
  type ApprovalAnswers,
  type ApprovalDecision,
  type ApprovalField,
  type ApprovalForm,
  codexImplicitEffort,
  type CodexPermissionMode,
  PERMISSION_MODES,
  type PermissionMode,
  type PermissionModeAvailability,
  type RuntimeBilling,
  type RuntimeCommand,
  type RuntimeDescriptor,
  type RuntimeModelCatalog,
  type RuntimeModelOption,
  type RuntimeSpeedOption,
  STANDARD_SPEED,
  type FileChange,
} from '../../../../shared/protocol.ts';
import { L, type Localized, N, NoticeError, type NoticeText, zhText } from '../../../../shared/notices.ts';
import {
  type AgentSession,
  type ApprovalAnswer,
  denyText,
  type EffectiveModel,
  type EffectivePermission,
  type ModelConfig,
  type OpenSessionArgs,
  ResumeFailedError,
  type RuntimeAdapter,
  SKILL_NAME,
  SKILLS_TTL_MS,
  cwdKey,
  type SkillInfo,
  type SkillList,
  type SteerAnswer,
  type SteerInput,
  type TeamMcpConfig,
  type TurnEvent,
  type TurnAttachment,
  type TurnEventSink,
  type TurnInput,
  type TurnResult,
  type TurnUsage,
  NO_TURN,
  REQUEST_GONE,
  REQUEST_INTERRUPTED,
  unsupportedDecision,
} from '../types.ts';
import { JsonRpcProcess, type RpcId, RpcError } from './rpc.ts';
import { choiceTexts, elicitationContent, fieldsFromSchema } from '../forms.ts';

/**
 * Codex runtime through the official `codex app-server` (stdio JSON-RPC, protocol v2).
 *
 * - One shared app-server process per adapter, started lazily; notifications and server requests are routed by threadId.
 * - A thread is started/resumed with the reviewer of the member's permission mode: `approvalsReviewer: "user"` (native
 *   approvals come to the group chat, decided by a human) for every chosen mode except auto-review, which the user
 *   chose for Codex's own reviewer subagent. On "follow" the user's own `approvals_reviewer` (config/read) is kept.
 *   Sandbox and approval policy are inherited from the user's Codex config unless a permission mode is chosen.
 * - Which modes this machine allows is read from configRequirements/read (managed allowed sandbox modes / approval
 *   policies / feature requirements) and experimentalFeature/list (guardian_approval = auto-review).
 * - Approval requests are surfaced as events and left pending until the local user decides in the group chat
 *   (`respondApproval`, called only by the Core). The decision is sent back on the exact JSON-RPC request id.
 *   Nothing here answers "accept" on its own: turn end, interrupt, process exit and requests outside a turn are
 *   always cancelled/declined.
 */

export interface CodexAdapterOptions {
  /** Executable to spawn (codex.exe, or `node` for tests). */
  command: string;
  /** Arguments before Codex's own (an npm install on Windows runs `node <codex.js>`). */
  argsPrefix?: string[];
  /** Defaults to ["app-server"]. */
  args?: string[];
  /** Why no Codex member can run right now (too old, not logged in, no longer found). */
  problem?: NoticeText | null;
  /** How Codex's own login is billed, from `codex login status` (ChatGPT plan or API key). */
  billing?: RuntimeBilling | null;
  version?: string | null;
  /** Output of `codex login status` (no secrets), for display. */
  loginStatus?: Localized | null;
  /** Append every protocol line to this JSONL file (opt-in receipts). */
  protocolLog?: string;
  /** How long to wait for `turn/completed` after `turn/interrupt` before reporting failure. */
  interruptTimeoutMs?: number;
  clientVersion?: string;
  /**
   * Finds the Codex binary again. Used when the remembered executable is gone (the Codex desktop app replaces its
   * versioned bin directory when it updates itself while Harness Team runs).
   */
  redetect?: () => Promise<CodexDetection>;
}

export interface CodexDetection {
  command: string | null;
  /** Arguments before Codex's own (an npm install on Windows runs `node <codex.js>`). */
  argsPrefix?: string[];
  /** The `--version` line. */
  version: string | null;
  loginStatus: Localized | null;
  loggedIn: boolean;
  /** Not found / could not run. */
  error: Localized | null;
  /** Found, but no Codex member can run: too old or not logged in. */
  problem?: NoticeText | null;
  /** ChatGPT login = subscription; API-key login = per token (allowed, shown on the member). Null when logged out. */
  billing?: RuntimeBilling | null;
}

/**
 * Oldest Codex whose app-server has every method Harness Team calls (thread/compact/start, thread/unarchive,
 * skills/list, config/read). Checked against published builds without any model request: 0.95.0 lacks
 * thread/compact/start; 0.96.0 has all of them.
 */
export const MIN_CODEX_VERSION = '0.96.0';
/**
 * thread/resume `excludeTurns` (skip sending the whole history back) is experimental before 0.151.0: those builds
 * refuse it ("requires experimentalApi capability") and Harness Team does not opt into experimental APIs. Checked in
 * the published protocol sources (`#[experimental("thread/resume.excludeTurns")]` through rust-v0.150.1).
 */
const EXCLUDE_TURNS_SINCE = '0.151.0';

/** Finds the official Codex CLI binary without touching its credentials (`login status` is Codex's own check). */
export async function detectCodex(env: NodeJS.ProcessEnv = process.env): Promise<CodexDetection> {
  const found = findCodexBinary(env);
  if (!found) {
    return {
      command: null,
      version: null,
      loginStatus: null,
      loggedIn: false,
      error: env.HT_CODEX_PATH
        ? L('HT_CODEX_PATH 指向的文件不存在或不是可执行文件：{path}', 'The file HT_CODEX_PATH points to does not exist or is not an executable: {path}', { path: env.HT_CODEX_PATH })
        : L('未找到 codex', 'codex was not found'),
    };
  }
  const base = { command: found.command, argsPrefix: found.argsPrefix };
  let version: string;
  try {
    version = versionLine(await run(found.command, [...found.argsPrefix, '--version'], env));
  } catch (e) {
    return { ...base, version: null, loginStatus: null, loggedIn: false, error: L('无法运行 codex：{error}', 'Could not run codex: {error}', { error: firstLine(e) }) };
  }
  if (olderThan(version, MIN_CODEX_VERSION)) {
    return { ...base, version, loginStatus: null, loggedIn: false, error: null, problem: tooOld(version) };
  }
  let loginStatus: Localized;
  let loggedIn = false;
  try {
    const out = statusLines(await run(found.command, [...found.argsPrefix, 'login', 'status'], env));
    loginStatus = out;
    loggedIn = /logged in/i.test(out) && !/not logged in/i.test(out);
  } catch (e) {
    // `codex login status` exits non-zero when logged out.
    const out = statusLines((e as { output?: string }).output ?? '');
    loginStatus = out || L('未登录或无法确认：{error}', 'Not logged in, or it cannot be confirmed: {error}', { error: firstLine(e) });
  }
  const apiKey = loggedIn && typeof loginStatus === 'string' && /api key/i.test(loginStatus);
  const problem = loggedIn ? null : L('Codex 未登录：在终端运行 codex login', 'Codex is not logged in: run codex login in a terminal');
  return { ...base, version, loginStatus, loggedIn, error: null, problem, billing: loggedIn ? (apiKey ? 'metered_api' : 'subscription') : null };
}

/** How the app-server's account is billed (`account/read`). Null = not reported (older Codex, custom provider). */
export function codexAccountBilling(res: any): RuntimeBilling | null {
  const type = res?.account?.type;
  if (typeof type !== 'string') return null;
  return type === 'chatgpt' ? 'subscription' : 'metered_api';
}

function tooOld(version: string): NoticeText {
  return L('Codex {v} 版本过旧，需要 {min} 或更高版本', 'Codex {v} is too old; {min} or later is needed', { v: versionLabel(version), min: MIN_CODEX_VERSION });
}

/** Codex may print warnings before its answer; keep the line with the version. */
function versionLine(out: string): string {
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => parseVersion(l) && !/^warning/i.test(l)) ?? lines[0] ?? '';
}

function statusLines(out: string): string {
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^warning/i.test(l))
    .join(' ');
}

function firstLine(e: unknown): string {
  return (e as Error).message.split('\n')[0] ?? 'error';
}

function findCodexBinary(env: NodeJS.ProcessEnv): CliLaunch | null {
  if (env.HT_CODEX_PATH) return cliFromPath(env.HT_CODEX_PATH, env);
  const found = findCli('codex', env);
  if (found) return found;
  // The Codex desktop app keeps its CLI in a versioned folder: take the newest.
  if (process.platform === 'win32' && env.LOCALAPPDATA) {
    const root = join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    if (existsSync(root)) {
      const candidates = readdirSync(root)
        .map((d) => join(root, d, 'codex.exe'))
        .filter((p) => existsSync(p))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      if (candidates[0]) return { command: candidates[0], argsPrefix: [], path: candidates[0] };
    }
  }
  return null;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 20_000, windowsHide: true, env }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(`${err.message}\n${stderr}`), { output: `${stdout}${stderr}` }));
      else resolve(`${stdout}${stderr}`);
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------

const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
  // legacy v1 shapes (keyed by conversationId)
  'execCommandApproval',
  'applyPatchApproval',
]);

interface ThreadListener {
  onNotification(method: string, params: any): void;
  onServerRequest(id: RpcId, method: string, params: any): boolean;
  onExit(reason: string): void;
}

/** One running app-server process. */
class CodexConnection {
  readonly rpc: JsonRpcProcess;
  readonly ready: Promise<void>;
  private readonly listeners = new Map<string, ThreadListener>();
  /** Notifications that belong to no thread (e.g. `skills/changed`). */
  onGlobal: ((method: string, params: any) => void) | null = null;
  alive = true;
  exitReason: string | null = null;
  /** Whether thread/resume may send `excludeTurns` (EXCLUDE_TURNS_SINCE). */
  readonly excludeTurns: boolean;

  constructor(opts: CodexAdapterOptions) {
    this.excludeTurns = !olderThan(opts.version, EXCLUDE_TURNS_SINCE);
    const rpc: JsonRpcProcess = new JsonRpcProcess(
      opts.command,
      [...(opts.argsPrefix ?? []), ...(opts.args ?? ['app-server'])],
      {
        onNotification: (method, params) => {
          const tid = threadIdOf(params);
          if (tid) this.listeners.get(tid)?.onNotification(method, params);
          else this.onGlobal?.(method, params);
        },
        onServerRequest: (id, method, params) => {
          const tid = threadIdOf(params);
          const l = tid ? this.listeners.get(tid) : undefined;
          if (l && l.onServerRequest(id, method, params)) return;
          // Nothing is waiting for it: never approve; decline/cancel where the protocol allows, else error.
          respondCancel(rpc, id, method, 'no active Harness Team turn for this request');
        },
        onExit: (reason) => {
          this.alive = false;
          this.exitReason = reason;
          for (const l of [...this.listeners.values()]) l.onExit(reason);
        },
      },
      { protocolLog: opts.protocolLog },
    );
    this.rpc = rpc;
    this.rpc.start();
    this.ready = (async () => {
      await rpc.request(
        'initialize',
        {
          clientInfo: { name: 'harness-team', title: 'Harness Team', version: opts.clientVersion ?? '0.0.0' },
          capabilities: { experimentalApi: false, requestAttestation: false },
        },
        30_000,
      );
      rpc.notify('initialized');
    })();
    this.ready.catch(() => {});
  }

  listen(threadId: string, l: ThreadListener): () => void {
    this.listeners.set(threadId, l);
    return () => {
      if (this.listeners.get(threadId) === l) this.listeners.delete(threadId);
    };
  }

  close() {
    this.alive = false;
    return this.rpc.close();
  }
}

function threadIdOf(params: any): string | undefined {
  if (!params || typeof params !== 'object') return undefined;
  return params.threadId ?? params.conversationId ?? params.thread?.id ?? undefined;
}

/** Decisions a human may give for each native request type. Anything we cannot express safely is deny-only. */
export function approvalOptions(method: string, form: ApprovalForm | null = null): ApprovalDecision[] {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return ['allow', 'allow_session', 'deny'];
    case 'item/tool/requestUserInput':
    case 'mcpServer/elicitation/request':
      // Answered with the user's own answers (or, for an MCP yes / no question, a plain accept).
      return form ? ['allow', 'deny'] : ['deny'];
    default:
      // permissions (needs an explicit permission profile): only refusing is supported from the group chat.
      return ['deny'];
  }
}

/**
 * The form a request asks the user to fill in: request_user_input questions, or an MCP elicitation (a flat form, an
 * empty yes / no form such as the browser plugin's "Allow Codex to use Chrome?", or a link to open). null = nothing
 * we can answer faithfully (the request stays refuse-only).
 */
export function requestForm(method: string, p: any): ApprovalForm | null {
  if (method === 'item/tool/requestUserInput') {
    const qs: any[] = Array.isArray(p?.questions) ? p.questions : [];
    if (!qs.length) return null;
    const fields: ApprovalField[] = [];
    for (const q of qs) {
      const id = typeof q?.id === 'string' && q.id ? q.id : null;
      if (!id || fields.some((f) => f.id === id)) return null;
      const label = String(q.question || q.header || id);
      const header = typeof q.header === 'string' && q.header && q.header !== label ? q.header : null;
      const options = Array.isArray(q.options) ? q.options.filter((o: any) => typeof o?.label === 'string' && o.label) : [];
      if (options.length && !q.isSecret) {
        fields.push({
          kind: 'choice',
          id,
          label,
          header,
          options: options.map((o: any) => ({ value: o.label, label: o.label, description: typeof o.description === 'string' ? o.description : null })),
          multiple: false,
          other: !!q.isOther,
          required: true,
        });
      } else fields.push({ kind: 'text', id, label, header, secret: !!q.isSecret, required: true });
    }
    return { fields };
  }
  if (method === 'mcpServer/elicitation/request') {
    if (p?.mode === 'url') return typeof p.url === 'string' && /^https?:\/\//i.test(p.url) ? { fields: [], url: p.url } : null;
    if (p?.mode === 'form' || p?.mode === 'openai/form' || p?.mode === 'openaiForm') {
      const fields = fieldsFromSchema(p.requestedSchema);
      return fields ? { fields } : null;
    }
  }
  return null;
}

/** Sends the user's decision for one native request. Returns the native decision label. */
function respondDecision(rpc: JsonRpcProcess, id: RpcId, p: PendingRequest, decision: ApprovalDecision, lang: AgentLanguage, answers: ApprovalAnswers = {}): string {
  switch (p.method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval': {
      const d = decision === 'allow' ? 'accept' : decision === 'allow_session' ? 'acceptForSession' : 'decline';
      rpc.respond(id, { decision: d });
      return d;
    }
    case 'execCommandApproval':
    case 'applyPatchApproval': {
      if (decision === 'deny') {
        rpc.respond(id, { decision: { denied: { rejection: denyText('denied', lang) } } });
        return 'denied';
      }
      const d = decision === 'allow' ? 'approved' : 'approved_for_session';
      rpc.respond(id, { decision: d });
      return d;
    }
    case 'mcpServer/elicitation/request':
      if (decision === 'allow' && p.form) {
        rpc.respond(id, { action: 'accept', content: p.form.url ? null : elicitationContent(p.form, answers), _meta: null });
        return 'accept';
      }
      rpc.respond(id, { action: 'decline', content: null, _meta: null });
      return 'decline';
    case 'item/tool/requestUserInput':
      if (decision === 'allow' && p.form) {
        const form = p.form;
        rpc.respond(id, { answers: Object.fromEntries(form.fields.map((f) => [f.id, { answers: choiceTexts(f, answers[f.id]) }])) });
        return 'answered';
      }
      rpc.respondError(id, -32000, 'declined by the user in Harness Team');
      return 'declined';
    default:
      rpc.respondError(id, -32000, 'denied by the user in Harness Team');
      return 'denied';
  }
}

/** Answers a pending server request without granting anything. */
function respondCancel(rpc: JsonRpcProcess, id: RpcId, method: string, why: string) {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return rpc.respond(id, { decision: 'cancel' });
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return rpc.respond(id, { decision: 'abort' });
    case 'mcpServer/elicitation/request':
      return rpc.respond(id, { action: 'cancel', content: null, _meta: null });
    default:
      // permissions / requestUserInput / dynamic tools / token refresh / attestation: we grant nothing.
      return rpc.respondError(id, -32000, why);
  }
}

const CATALOG_TTL_MS = 60_000;

export class CodexAdapter implements RuntimeAdapter {
  readonly kind = 'codex' as const;
  private opts: CodexAdapterOptions;
  private conn: CodexConnection | null = null;
  private starting: Promise<CodexConnection> | null = null;
  /** cwd ('' = none) -> catalog; config/read is cwd-specific (project config layers). */
  private readonly catalogs = new Map<string, { at: number; value: Promise<RuntimeModelCatalog> }>();
  /** cwd -> enabled skills from `skills/list` (cleared on `skills/changed`). */
  private readonly skillLists = new Map<string, { at: number; value: Promise<SkillList> }>();

  constructor(opts: CodexAdapterOptions) {
    this.opts = opts;
  }

  describe(): RuntimeDescriptor {
    const problem = this.opts.problem ?? null;
    return {
      kind: 'codex',
      backend: 'codex-app-server',
      label: 'Codex',
      isMock: false,
      available: !problem,
      installed: true,
      problem,
      note: problem ? L('不可用：{problem}', 'Not available: {problem}', { problem }) : L(
        '{version} · {login}。沙箱与审批策略沿用你的 Codex 配置；审批人是你，选了「自动审批（auto-review）」权限模式的成员除外（由 Codex 的审核代理决定，结果显示在群聊中）。需要你确认的请求显示在群聊中，只有你在群内点选才会批准。',
        '{version} · {login}. Sandbox and approval policy follow your Codex configuration; the approver is you, except for members set to the Auto-review permission mode (Codex’s reviewer agent decides; its decisions appear in the chat). Requests that need your confirmation appear in the chat and are approved only when you click there.',
        { version: this.opts.version ?? 'codex', login: this.opts.loginStatus ?? L('登录状态未知', 'login status unknown') },
      ),
      requiresWorkspace: true,
      version: this.opts.version ?? null,
      billing: problem ? null : (this.opts.billing ?? null),
      capabilities: {
        streaming: true,
        nativeTools: true,
        nativeApprovals: true,
        interrupt: true,
        resume: true,
        // turn/steer (app-server protocol of the installed Codex: threadId, input, expectedTurnId).
        steer: true,
        teamMcp: true,
        standingInstructions: true,
        commands: CODEX_COMMANDS,
        skillContext: true,
        commandsSkipConfig: true,
      },
    };
  }

  /** New detection results (Check again): the next app-server start uses them; a running one is kept. */
  update(found: Partial<CodexAdapterOptions>): void {
    this.opts = { ...this.opts, ...found };
    this.catalogs.clear();
    this.skillLists.clear();
  }

  /** Shared app-server connection; restarted after a crash (threads are then re-resumed by id). */
  async connection(): Promise<CodexConnection> {
    if (this.opts.problem) throw new NoticeError(this.opts.problem);
    if (this.conn?.alive) {
      await this.conn.ready;
      return this.conn;
    }
    if (!this.starting) {
      this.starting = (async () => {
        if (!existsSync(this.opts.command)) await this.redetect();
        let c = new CodexConnection(this.opts);
        try {
          await c.ready;
        } catch (e) {
          await c.close().catch(() => {});
          if (existsSync(this.opts.command) || !this.opts.redetect) {
            throw new NoticeError(L('无法启动 codex app-server：{error}', 'Could not start codex app-server: {error}', { error: (e as Error).message }));
          }
          // The binary vanished between the check and the spawn (self-update in progress): look once more.
          await this.redetect();
          c = new CodexConnection(this.opts);
          try {
            await c.ready;
          } catch (e2) {
            await c.close().catch(() => {});
            throw new NoticeError(L('无法启动 codex app-server：{error}', 'Could not start codex app-server: {error}', { error: (e2 as Error).message }));
          }
        }
        // Codex watches the skill folders and says when they changed: list again on the next request.
        c.onGlobal = (method) => {
          if (method === 'skills/changed') this.skillLists.clear();
        };
        this.conn = c;
        return c;
      })().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  /**
   * Before a member's thread is opened: the account the app-server reports (`account/read`) is reported to the Core,
   * and a member shown on the ChatGPT plan whose account now bills per token is stopped (the member is then marked
   * per-token, so sending again is the user's own choice). A Codex without `account/read` is not checked.
   */
  private async checkBilling(c: CodexConnection, args: OpenSessionArgs): Promise<void> {
    let res: any;
    try {
      res = await c.rpc.request('account/read', { refreshToken: false }, 15_000);
    } catch {
      return;
    }
    const actual = codexAccountBilling(res);
    if (!actual) return;
    const shown = args.billing ? args.billing() : (this.opts.billing ?? null);
    args.onBilling?.(actual);
    if (shown !== 'subscription' || actual !== 'metered_api') return;
    throw new NoticeError(
      L(
        'Codex 报告的账户类型是 {type}，按 token 计费，但该成员显示的是 ChatGPT 账户，本消息未发送。该成员现在标为按量计费：再发一次消息就按 token 计费运行。想继续用 ChatGPT 账户，请先在终端里运行 codex login 改回，再发消息。Harness Team 不会自行切换计费方式。',
        'Codex reports the account type {type}, which is billed per token, but this member shows the ChatGPT account, so the message was not sent. The member is now marked as billed per token: send the message again to run it per token. To stay on the ChatGPT account, run codex login in a terminal first, then send it again. Harness Team never switches billing on its own.',
        { type: String(res.account.type) },
      ),
    );
  }

  /** Re-locates the Codex binary after it disappeared; throws (with what happened) if none is found. */
  private async redetect(): Promise<void> {
    const old = this.opts.command;
    const found = this.opts.redetect ? await this.opts.redetect().catch(() => null) : null;
    if (!found?.command || !found.version || !existsSync(found.command)) {
      throw new NoticeError(
        L(
          'codex 可执行文件已不存在：{old}（Codex 可能已自动更新）{again}。请确认 Codex 已安装后重启 Harness Team，或用 HT_CODEX_PATH 指定路径。',
          'The codex executable no longer exists: {old} (Codex may have updated itself){again}. Make sure Codex is installed and restart Harness Team, or set the path with HT_CODEX_PATH.',
          {
            old,
            again: this.opts.redetect
              ? L('；重新探测也未找到可用的 codex{why}', '; looking again found no usable codex either{why}', { why: found?.error ? L('（{e}）', ' ({e})', { e: found.error }) : null })
              : null,
          },
        ),
      );
    }
    this.opts = { ...this.opts, command: found.command, argsPrefix: found.argsPrefix ?? [], version: found.version, loginStatus: found.loginStatus, billing: found.billing ?? null };
    this.catalogs.clear();
    console.log(`Codex runtime re-detected after the old executable disappeared: ${found.version} (${found.command})`);
  }

  async openSession(args: OpenSessionArgs): Promise<AgentSession> {
    const cwd = args.agent.workspace;
    if (!cwd) throw new NoticeError(L('Codex 成员需要工作目录（workspace）', 'Codex members need a working folder (workspace)'));
    const conn = await this.connection();
    await this.checkBilling(conn, args);
    const want = codexMode(args.agent.permissionMode);
    const res = await openThread(conn, cwd, args.resumeNativeSessionId, args.teamMcp, args.instructions, want, want ? 'user' : await this.ownReviewer(cwd), args.browserMcp);
    const s = new CodexSession(this, conn, res.threadId, cwd, res.info, this.opts.interruptTimeoutMs ?? 20_000, args.teamMcp, args.instructions);
    s.browserMcp = args.browserMcp;
    if (args.language) s.language = args.language;
    const source = args.resumeNativeSessionId ? RESUME_SOURCE : L('Codex thread/start 响应', 'Codex thread/start response');
    s.current = { model: res.model, effort: res.effort, source };
    s.notePermission(res.sandbox, res.approvalPolicy, want, source, res.reviewer);
    if (want) s.overridden = true;
    else if (!args.resumeNativeSessionId) {
      // A new thread opened without an override: what Codex reports is the user's own setting, restored when "follow"
      // is chosen again after a mode.
      s.baseline = { sandbox: res.sandbox, approvalPolicy: res.approvalPolicy };
    } else {
      // A resumed thread keeps the sandbox / approval policy of its last turn, which may be a mode chosen earlier
      // (verified with Codex 0.167). "Follow" means the user's own config.toml; when the thread differs from it, the
      // next turn sends the user's settings back. When config.toml does not set both, what the thread reports is kept.
      const own = await this.permissionDefaults(cwd);
      if (own && !samePermission(own.sandboxPolicy, own.approvalPolicy, res.sandbox, res.approvalPolicy)) {
        s.baseline = { sandbox: own.sandboxPolicy, approvalPolicy: own.approvalPolicy };
        s.overridden = true;
      } else s.baseline = { sandbox: res.sandbox, approvalPolicy: res.approvalPolicy };
    }
    return s;
  }

  /**
   * The user's own sandbox / approval policy from `config/read` (config.toml), to go back to after a permission mode
   * was chosen and then set to "follow" again. null when the configuration does not set both (Codex then decides
   * from its built-in rules, which Harness Team does not guess).
   */
  async permissionDefaults(cwd: string): Promise<{ approvalPolicy: unknown; sandboxPolicy: Record<string, unknown> } | null> {
    try {
      const conn = await this.connection();
      const cfg: any = (await conn.rpc.request('config/read', { cwd }, 15_000))?.config ?? {};
      const mode = cfg.sandbox_mode;
      if (!cfg.approval_policy || typeof mode !== 'string') return null;
      if (mode === 'read-only') return { approvalPolicy: cfg.approval_policy, sandboxPolicy: { type: 'readOnly', networkAccess: false } };
      if (mode === 'danger-full-access') return { approvalPolicy: cfg.approval_policy, sandboxPolicy: { type: 'dangerFullAccess' } };
      if (mode === 'workspace-write') return { approvalPolicy: cfg.approval_policy, sandboxPolicy: workspaceWritePolicy(cfg.sandbox_workspace_write) };
      return null;
    } catch {
      return null;
    }
  }

  /**
   * The approver of the user's own configuration (`approvals_reviewer` in config.toml): what "follow" uses. Anything but
   * auto_review (or its legacy name guardian_subagent), or an unreadable configuration, is the user.
   */
  async ownReviewer(cwd: string): Promise<CodexReviewer> {
    try {
      const conn = await this.connection();
      const v = (await conn.rpc.request('config/read', { cwd }, 15_000) as any)?.config?.approvals_reviewer;
      return codexReviewer(v) === 'auto_review' ? 'auto_review' : 'user';
    } catch {
      return 'user';
    }
  }

  /** The workspace-write settings (writable roots, network) of the user's config.toml, when it sets them. */
  async workspaceWriteDefaults(cwd: string): Promise<Record<string, unknown> | null> {
    try {
      const conn = await this.connection();
      const ww = (await conn.rpc.request('config/read', { cwd }, 15_000) as any)?.config?.sandbox_workspace_write;
      return ww && typeof ww === 'object' ? workspaceWritePolicy(ww) : null;
    } catch {
      return null;
    }
  }

  /**
   * Working directories of the user's Codex threads (CLI, IDE/desktop app; Codex's default "interactive" sources), from
   * the official `thread/list` read from Codex's local thread index (`useStateDbOnly`). No model request is made.
   */
  /** The official `thread/unarchive` (same as unarchiving the thread in the Codex app). No model request. */
  async restoreSession(threadId: string): Promise<void> {
    const conn = await this.connection();
    await conn.rpc.request('thread/unarchive', { threadId }, 30_000);
  }

  async recentWorkspaces(): Promise<{ path: string; at: number | null }[]> {
    const conn = await this.connection();
    const out: { path: string; at: number | null }[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const res: any = await conn.rpc.request(
        'thread/list',
        { limit: 100, sortKey: 'updated_at', useStateDbOnly: true, ...(cursor ? { cursor } : {}) },
        15_000,
      );
      for (const t of Array.isArray(res?.data) ? res.data : []) {
        if (typeof t?.cwd !== 'string' || !t.cwd) continue;
        const sec = typeof t.updatedAt === 'number' ? t.updatedAt : typeof t.createdAt === 'number' ? t.createdAt : null;
        out.push({ path: t.cwd, at: sec === null ? null : sec * 1000 });
      }
      cursor = typeof res?.nextCursor === 'string' && res.nextCursor ? res.nextCursor : null;
      if (!cursor) break;
    }
    return out;
  }

  /**
   * Enabled skills from the official `skills/list` for `cwd` (user, repo, system and admin scopes as Codex reports
   * them). Reads skill files only; no model request.
   */
  listSkills(opts: { cwd: string; refresh?: boolean }): Promise<SkillList> {
    const key = cwdKey(opts.cwd);
    const hit = this.skillLists.get(key);
    if (hit && !opts.refresh && Date.now() - hit.at < SKILLS_TTL_MS) return hit.value;
    const value = this.fetchSkills(opts.cwd, !!opts.refresh);
    this.skillLists.set(key, { at: Date.now(), value });
    void value.then((r) => {
      if (r.error && this.skillLists.get(key)?.value === value) this.skillLists.delete(key); // never cache failures
    });
    return value;
  }

  private async fetchSkills(cwd: string, forceReload: boolean): Promise<SkillList> {
    try {
      const conn = await this.connection();
      const res: any = await conn.rpc.request('skills/list', { cwds: [cwd], ...(forceReload ? { forceReload: true } : {}) }, 20_000);
      const entry = (Array.isArray(res?.data) ? res.data : [])[0];
      const reserved = new Set(CODEX_COMMANDS.map((c) => c.name));
      const seen = new Set<string>();
      const skills: SkillInfo[] = [];
      for (const s of Array.isArray(entry?.skills) ? entry.skills : []) {
        if (!s || s.enabled === false || typeof s.name !== 'string' || !SKILL_NAME.test(s.name)) continue;
        const k = s.name.toLowerCase();
        if (reserved.has(k) || seen.has(k)) continue;
        seen.add(k);
        const scope = String(s.scope ?? '');
        const source: Localized | null = s.pluginId
          ? L('插件 {name}', 'plugin {name}', { name: String(s.pluginId) })
          : scope === 'user'
            ? L('用户', 'user')
            : scope === 'repo'
              ? L('仓库', 'repo')
              : scope === 'system'
                ? L('Codex 自带', 'Codex system')
                : scope === 'admin'
                  ? L('管理员', 'admin')
                  : scope || null;
        const short = s.interface?.shortDescription ?? s.interface?.short_description ?? s.shortDescription;
        skills.push({
          name: s.name,
          description: String((typeof short === 'string' && short.trim()) || s.description || ''),
          args: null,
          source,
          path: typeof s.path === 'string' ? s.path : null,
        });
      }
      const errs: any[] = Array.isArray(entry?.errors) ? entry.errors : [];
      const first = String(errs[0]?.message ?? JSON.stringify(errs[0]));
      const error = !skills.length && errs.length
        ? L('Codex skills/list 报告错误：{error}', 'Codex skills/list reported an error: {error}', { error: first })
        : null;
      // Some loaded and some did not: keep the usable ones and say the list is incomplete.
      const warning = skills.length && errs.length
        ? L('有 {n} 个 Skill 未能加载：{error}', '{n} skill(s) failed to load: {error}', { n: errs.length, error: first })
        : null;
      return { skills, error, warning };
    } catch (e) {
      return { skills: [], error: L('无法从 Codex 读取 Skills：{error}', 'Could not read the skills from Codex: {error}', { error: (e as Error).message }) };
    }
  }

  /**
   * Models from the official `model/list` (visible ones only, every page) and the native defaults from `config/read`
   * (user/project config.toml; falls back to the model Codex marks isDefault). No model request is made.
   */
  listModels(opts: { refresh?: boolean; cwd?: string | null } = {}): Promise<RuntimeModelCatalog> {
    const key = opts.cwd ?? '';
    const hit = this.catalogs.get(key);
    if (hit && !opts.refresh && Date.now() - hit.at < CATALOG_TTL_MS) return hit.value;
    const value = this.fetchCatalog(opts.cwd ?? null);
    this.catalogs.set(key, { at: Date.now(), value });
    void value.then((c) => {
      if (!c.available && this.catalogs.get(key)?.value === value) this.catalogs.delete(key); // never cache failures
    });
    return value;
  }

  private async fetchCatalog(cwd: string | null): Promise<RuntimeModelCatalog> {
    const base = { runtimeKind: 'codex' as const, source: 'codex app-server model/list + config/read', fetchedAt: new Date().toISOString() };
    try {
      const conn = await this.connection();
      const models: RuntimeModelOption[] = [];
      // Every model this Codex build knows, hidden ones included (a configured hidden model still runs).
      const known = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < 20; page++) {
        const res: any = await conn.rpc.request('model/list', { includeHidden: true, ...(cursor ? { cursor } : {}) }, 20_000);
        for (const m of Array.isArray(res?.data) ? res.data : []) {
          const id = String(m?.model ?? m?.id ?? '');
          if (!id) continue;
          known.add(id);
          if (m.hidden) continue;
          models.push({
            id,
            displayName: String(m.displayName ?? id),
            description: typeof m.description === 'string' ? m.description : null,
            resolvedModel: null,
            efforts: (Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : [])
              .map((e: any) => String(e?.reasoningEffort ?? e ?? ''))
              .filter(Boolean),
            defaultEffort: typeof m.defaultReasoningEffort === 'string' ? m.defaultReasoningEffort : null,
            isDefault: !!m.isDefault,
            speeds: codexSpeeds(m.serviceTiers),
          });
        }
        cursor = typeof res?.nextCursor === 'string' && res.nextCursor ? res.nextCursor : null;
        if (!cursor) break;
      }
      if (!models.length) return { ...base, available: false, error: L('Codex model/list 未返回可用模型', 'Codex model/list returned no usable model'), models, nativeDefault: null };
      let cfgModel: string | null = null;
      let cfgEffort: string | null = null;
      let note: Localized | null = null;
      let unknownModel = false;
      try {
        const cfg: any = await conn.rpc.request('config/read', cwd ? { cwd } : {}, 15_000);
        cfgModel = typeof cfg?.config?.model === 'string' ? cfg.config.model : null;
        cfgEffort = typeof cfg?.config?.model_reasoning_effort === 'string' ? cfg.config.model_reasoning_effort : null;
        // A model this Codex build does not know (config.toml written by a newer Codex, e.g. the desktop app) fails on
        // the first request; the default is then the one this build marks. Other providers' models are not in model/list.
        const provider = cfg?.config?.model_provider;
        if (cfgModel && !known.has(cfgModel) && (provider == null || provider === 'openai')) {
          note = L('你的 Codex 配置的模型 {model} 不是这个版本的 Codex（{version}）提供的模型', 'The model {model} in your Codex configuration is not offered by this Codex version ({version})', {
            model: cfgModel,
            version: this.opts.version ?? 'codex',
          });
          cfgModel = null;
          unknownModel = true;
        }
      } catch (e) {
        note = L('config/read 失败（{error}），默认模型按 model/list 的 isDefault 推断', 'config/read failed ({error}); the default model is inferred from isDefault in model/list', { error: (e as Error).message });
      }
      const permissionModes = await codexModeAvailability(conn);
      const defModel = cfgModel ?? models.find((m) => m.isDefault)?.id ?? null;
      const entry = models.find((m) => m.id === defModel);
      return {
        ...base,
        available: true,
        error: null,
        models,
        nativeDefault: {
          model: defModel,
          // Replacing an unknown model, it is sent explicitly, so the effort must be one that model takes.
          effort: unknownModel && entry ? codexImplicitEffort(entry, cfgEffort) : (cfgEffort ?? entry?.defaultEffort ?? null),
          efforts: entry?.efforts ?? [],
          speeds: entry?.speeds ?? [],
          note: note ?? (cfgModel ? L('来自你的 Codex 配置（config.toml）', 'From your Codex configuration (config.toml)') : L('来自 Codex model/list 标记的默认模型', 'The default model marked by Codex model/list')),
        },
        ...(permissionModes ? { permissionModes } : {}),
      };
    } catch (e) {
      return { ...base, available: false, error: L('无法读取 Codex 模型列表：{error}', 'Could not read the Codex model list: {error}', { error: (e as Error).message }), models: [], nativeDefault: null };
    }
  }

  async dispose(): Promise<void> {
    const c = this.conn;
    this.conn = null;
    if (c) await c.close();
  }
}

/** The service tiers model/list offers this account for a model (e.g. "priority" = Fast; "ultrafast" only on the plans
 *  that have it). The standard tier is not listed: it is always available. */
export function codexSpeeds(tiers: unknown): RuntimeSpeedOption[] {
  const out: RuntimeSpeedOption[] = [];
  for (const t of Array.isArray(tiers) ? tiers : []) {
    const id = typeof t?.id === 'string' ? t.id : '';
    if (!id || id === 'default' || id === STANDARD_SPEED || out.some((o) => o.id === id)) continue;
    out.push({ id, name: typeof t.name === 'string' && t.name ? t.name : id, description: typeof t.description === 'string' && t.description ? t.description : null, available: true });
  }
  return out;
}

/** thread/start or exact thread/resume. Refuses to continue unless the runtime confirms the human reviewer. */
/**
 * Per-thread config override that adds the built-in Team MCP server next to the user's own MCP servers (a dotted
 * key replaces only this one entry). Its tools are collaboration-only, so they are approved without a prompt; every
 * other tool keeps the user's sandbox/approval policy and human reviewer.
 */
export function teamMcpThreadConfig(team: TeamMcpConfig | undefined, browser?: TeamMcpConfig): Record<string, unknown> {
  if (!team && !browser) return {};
  return {
    config: {
      ...(team
        ? {
            [`mcp_servers.${team.serverName}`]: {
              url: team.url,
              required: false,
              startup_timeout_sec: 20,
              tool_timeout_sec: 60,
              default_tools_approval_mode: 'approve',
            },
          }
        : {}),
      // Harness Team's browser (Agent.browser) asks the user in the chat itself, so Codex does not ask again; a call
      // may wait that long for the user's answer.
      ...(browser
        ? {
            [`mcp_servers.${browser.serverName}`]: {
              url: browser.url,
              required: false,
              startup_timeout_sec: 20,
              tool_timeout_sec: 3600,
              default_tools_approval_mode: 'approve',
            },
          }
        : {}),
    },
  };
}

/**
 * Permission modes as Codex settings, the presets of Codex's own permission menu plus untrusted. The approver is the
 * user except in auto-review (Codex's reviewer subagent decides); full-access runs without a sandbox and never asks.
 */
export type CodexReviewer = 'user' | 'auto_review';
export const CODEX_MODES: Record<
  CodexPermissionMode,
  { sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'; approvalPolicy: 'on-request' | 'untrusted' | 'never'; reviewer: CodexReviewer }
> = {
  'read-only': { sandbox: 'read-only', approvalPolicy: 'on-request', reviewer: 'user' },
  'workspace-write': { sandbox: 'workspace-write', approvalPolicy: 'on-request', reviewer: 'user' },
  untrusted: { sandbox: 'workspace-write', approvalPolicy: 'untrusted', reviewer: 'user' },
  'auto-review': { sandbox: 'workspace-write', approvalPolicy: 'on-request', reviewer: 'auto_review' },
  'full-access': { sandbox: 'danger-full-access', approvalPolicy: 'never', reviewer: 'user' },
};

/**
 * Which modes this machine's Codex allows: the managed requirements (`configRequirements/read`, i.e. requirements.toml
 * or MDM) for sandbox modes and approval policies, and Codex's own auto-review feature (`guardian_approval` in
 * `experimentalFeature/list`, or a requirement that turns it off). null when neither could be read.
 */
export async function codexModeAvailability(conn: CodexConnection): Promise<PermissionModeAvailability[] | null> {
  let req: any = null;
  let reqRead = false;
  try {
    req = ((await conn.rpc.request('configRequirements/read', {}, 15_000)) as any)?.requirements ?? null;
    reqRead = true;
  } catch {
    // older Codex: no managed requirements to compare with
  }
  let autoReview: boolean | null = null;
  let featuresRead = false;
  try {
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const res: any = await conn.rpc.request('experimentalFeature/list', cursor ? { cursor } : {}, 15_000);
      featuresRead = true;
      const f = (Array.isArray(res?.data) ? res.data : []).find((x: any) => x?.name === 'guardian_approval');
      if (f) {
        autoReview = f.enabled === true;
        break;
      }
      cursor = typeof res?.nextCursor === 'string' && res.nextCursor ? res.nextCursor : null;
      if (!cursor) break;
    }
  } catch {
    // older Codex: the thread/start check still refuses a reviewer it does not take
  }
  if (!reqRead && !featuresRead) return null;
  const sandboxes: unknown[] | null = Array.isArray(req?.allowedSandboxModes) ? req.allowedSandboxModes : null;
  const policies: unknown[] | null = Array.isArray(req?.allowedApprovalPolicies) ? req.allowedApprovalPolicies : null;
  return PERMISSION_MODES.codex.map((id): PermissionModeAvailability => {
    const spec = CODEX_MODES[id as CodexPermissionMode];
    const off = (reason: Localized): PermissionModeAvailability => ({ id, available: false, reason });
    if (sandboxes && !sandboxes.includes(spec.sandbox)) {
      return off(L('你的 Codex 管理要求（requirements.toml）不允许沙箱模式 {v}', 'Your Codex requirements (requirements.toml) do not allow the sandbox mode {v}', { v: spec.sandbox }));
    }
    if (policies && !policies.includes(spec.approvalPolicy)) {
      return off(L('你的 Codex 管理要求（requirements.toml）不允许审批策略 {v}', 'Your Codex requirements (requirements.toml) do not allow the approval policy {v}', { v: spec.approvalPolicy }));
    }
    if (spec.reviewer === 'auto_review') {
      if (req?.featureRequirements?.guardian_approval === false) {
        return off(L('你的 Codex 管理要求（requirements.toml）关闭了 auto-review（guardian_approval）', 'Your Codex requirements (requirements.toml) turn off auto-review (guardian_approval)'));
      }
      if (autoReview === false) return off(L('Codex 的 auto-review 功能（guardian_approval）没有开启', 'Codex’s auto-review feature (guardian_approval) is not turned on'));
    }
    return { id, available: true, reason: null };
  });
}

/** The reviewer Codex reported (`guardian_subagent` is its legacy name for auto_review); unknown values stay as they are. */
export function codexReviewer(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  return v === 'guardian_subagent' ? 'auto_review' : v;
}

function codexMode(m: PermissionMode | null | undefined): CodexPermissionMode | null {
  if (!m) return null;
  if (!(m in CODEX_MODES)) throw new NoticeError(L('内部错误：拒绝使用权限模式 {mode}', 'Internal error: refusing the permission mode {mode}', { mode: m }));
  return m as CodexPermissionMode;
}

/** A workspace-write SandboxPolicy from config.toml's [sandbox_workspace_write] (or the conservative default). */
function workspaceWritePolicy(ww: any): Record<string, unknown> {
  return {
    type: 'workspaceWrite',
    writableRoots: Array.isArray(ww?.writable_roots) ? ww.writable_roots.map(String) : [],
    networkAccess: ww?.network_access === true,
    excludeTmpdirEnvVar: ww?.exclude_tmpdir_env_var === true,
    excludeSlashTmp: ww?.exclude_slash_tmp === true,
  };
}

/** SandboxPolicy.type of a reported sandbox (object form, or the SandboxMode string some responses use). */
/** Same sandbox kind and approval policy (the details of a workspace-write sandbox are not compared). */
function samePermission(sandboxA: unknown, approvalA: unknown, sandboxB: unknown, approvalB: unknown): boolean {
  return sandboxType(sandboxA) === sandboxType(sandboxB) && JSON.stringify(approvalA) === JSON.stringify(approvalB);
}

function sandboxType(sb: unknown): string | null {
  if (typeof sb === 'string') return ({ 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' } as Record<string, string>)[sb] ?? sb;
  const t = (sb as any)?.type;
  return typeof t === 'string' ? t : null;
}

/**
 * The sandbox / approval policy Codex reported, as a permission mode, compared with the agent's choice. Running
 * without a sandbox or never asking is flagged so the chat says so.
 */
export function codexPermission(
  sandbox: unknown,
  approvalPolicy: unknown,
  want: PermissionMode | null | undefined,
  source: Localized,
  reviewer: string | null = 'user',
): EffectivePermission {
  const type = sandboxType(sandbox);
  const policy = typeof approvalPolicy === 'string' ? approvalPolicy : approvalPolicy == null ? null : JSON.stringify(approvalPolicy);
  const rev = reviewer ?? 'user';
  let mode: CodexPermissionMode | null = null;
  for (const [m, spec] of Object.entries(CODEX_MODES) as [CodexPermissionMode, (typeof CODEX_MODES)[CodexPermissionMode]][]) {
    if (sandboxType(spec.sandbox) === type && spec.approvalPolicy === policy && spec.reviewer === rev) mode = m;
  }
  const native = `${type ?? '?'} · ${policy ?? '?'}${rev !== 'user' ? ` · ${rev}` : ''}`;
  const mismatch =
    want && mode !== want
      ? L('Codex 报告的权限是 {got}，不是所选的 {want}', 'Codex reports the permissions {got}, not the chosen {want}', { got: native, want })
      : null;
  const noSandbox = type === 'dangerFullAccess';
  const neverAsks = policy === 'never';
  const risky =
    noSandbox || neverAsks
      ? L('{a}{b}如不希望这样，请在成员设置中选择一个权限模式。', '{a}{b}If you do not want that, choose a permission mode in the member settings.', {
          a: noSandbox ? L('Codex 报告当前不使用沙箱（danger-full-access）：命令可以改动工作目录以外的文件。', 'Codex reports that it runs without a sandbox (danger-full-access): commands can change files outside the working folder. ') : null,
          b: neverAsks ? L('Codex 报告当前的审批策略是 never：不会在群里向你请求审批。', 'Codex reports the approval policy never: it will not ask you for approval in the chat. ') : null,
        })
      : null;
  return { native, mode, source, mismatch, risky };
}

async function openThread(
  conn: CodexConnection,
  cwd: string,
  resumeId?: string,
  team?: TeamMcpConfig,
  instructions?: string,
  perm?: CodexPermissionMode | null,
  followReviewer: CodexReviewer = 'user',
  browser?: TeamMcpConfig,
): Promise<{ threadId: string; info: NoticeText[]; model: string | null; effort: string | null; sandbox: unknown; approvalPolicy: unknown; reviewer: string }> {
  let res: any;
  // The approver: the one of the chosen mode (Codex's own reviewer for auto-review, otherwise the user), or for
  // "follow" the one of the user's own config.toml (approvals_reviewer).
  const reviewer: CodexReviewer = perm ? CODEX_MODES[perm].reviewer : followReviewer;
  // developerInstructions: the official per-thread option for extra developer instructions (the Harness Team rules).
  // A chosen permission mode is the official sandbox / approvalPolicy thread option; nothing is sent for "follow".
  const extra = {
    ...teamMcpThreadConfig(team, browser),
    ...(instructions ? { developerInstructions: instructions } : {}),
    ...(perm ? { sandbox: CODEX_MODES[perm].sandbox, approvalPolicy: CODEX_MODES[perm].approvalPolicy } : {}),
  };
  if (resumeId) {
    try {
      res = await conn.rpc.request('thread/resume', { threadId: resumeId, cwd, approvalsReviewer: reviewer, ...(conn.excludeTurns ? { excludeTurns: true } : {}), ...extra });
    } catch (e) {
      if (!conn.alive) throw e;
      const msg = (e as Error).message;
      // Codex's own wording: "session <id> is archived. Run `codex unarchive <id>` …" / "no rollout found for thread id".
      const reason = /\bis archived\b/i.test(msg) ? 'archived' : /no rollout found|not found|does not exist/i.test(msg) ? 'missing' : 'other';
      throw new ResumeFailedError(`无法恢复 Codex 线程 ${resumeId}：${msg}`, reason, msg);
    }
    if (res?.thread?.id !== resumeId) throw new ResumeFailedError(`Codex 返回了不同的线程 ${res?.thread?.id}，拒绝使用`, 'other', `thread/resume returned another thread (${res?.thread?.id})`);
  } else {
    res = await conn.rpc.request('thread/start', { cwd, approvalsReviewer: reviewer, ...extra });
  }
  const threadId = String(res?.thread?.id ?? '');
  if (!threadId) throw new NoticeError(L('Codex 未返回线程 id', 'Codex returned no thread id'));
  if (res.approvalsReviewer !== undefined && codexReviewer(res.approvalsReviewer) !== reviewer) {
    throw new NoticeError(
      reviewer === 'user'
        ? L('Codex 未接受人工审批人（approvalsReviewer={v}），拒绝运行', 'Codex did not accept you as the approver (approvalsReviewer={v}); it will not run', { v: String(JSON.stringify(res.approvalsReviewer)) })
        : L('Codex 未接受所选的审批人 {want}（approvalsReviewer={v}），拒绝运行', 'Codex did not accept the chosen approver {want} (approvalsReviewer={v}); it will not run', {
            want: reviewer,
            v: String(JSON.stringify(res.approvalsReviewer)),
          }),
    );
  }
  return {
    threadId,
    info: describeThread(res, !!resumeId),
    model: typeof res.model === 'string' ? res.model : null,
    effort: typeof res.reasoningEffort === 'string' ? res.reasoningEffort : null,
    sandbox: res.sandbox ?? null,
    approvalPolicy: res.approvalPolicy ?? null,
    reviewer: codexReviewer(res.approvalsReviewer) ?? reviewer,
  };
}

/** What turn/start must carry so the turn runs with `cfg`. Throws (Chinese) instead of running with something else. */
export async function turnOverrides(
  adapter: CodexAdapter,
  cwd: string,
  cfg: ModelConfig | undefined,
  current: EffectiveModel | null,
): Promise<{ model?: string; effort?: string; note?: NoticeText }> {
  const explicit = !!(cfg && (cfg.model || cfg.effort));
  if (!explicit) {
    // Follow Codex's own default. Only when an earlier override (this or a previous run) left the thread on another
    // model/effort is the native default sent back explicitly; otherwise nothing is sent and Codex decides.
    if (!current?.model) return {};
    const cat = await adapter.listModels({ cwd });
    const d = cat.available ? cat.nativeDefault : null;
    if (!d?.model) return { note: N('codex.defaultsUnreadable', { error: cat.error ?? L('未知原因', 'unknown reason'), model: current.model }) };
    if (d.model === current.model && (d.effort ?? null) === (current.effort ?? null)) return {};
    return { model: d.model, ...(d.effort ? { effort: d.effort } : {}) };
  }
  const cat = await adapter.listModels({ cwd });
  if (!cat.available) {
    throw new NoticeError(
      L('无法确认所选模型/Effort 是否可用：{error}。为避免以其他配置运行，本消息未发送', 'Cannot confirm that the chosen model / effort is available: {error}. To avoid running with other settings, this message was not sent', { error: cat.error }),
    );
  }
  const model = cfg!.model ?? cat.nativeDefault?.model ?? null;
  if (!model) throw new NoticeError(L('无法确定 Codex 默认模型，无法应用所选 Effort；本消息未发送', 'Cannot tell Codex’s default model, so the chosen effort cannot be applied; this message was not sent'));
  const entry = cat.models.find((m) => m.id === model);
  if (!entry) {
    throw new NoticeError(
      L('模型 {model} 已不在 Codex model/list 的可用列表中；本消息未发送，请在成员设置中重新选择', 'The model {model} is no longer listed by Codex model/list; this message was not sent. Choose again in the member settings.', { model }),
    );
  }
  let effort = cfg!.effort;
  if (effort) {
    if (!entry.efforts.includes(effort)) {
      throw new NoticeError(
        L('模型 {model} 不支持 Effort {effort}（可选：{options}）；本消息未发送', 'The model {model} does not support the effort {effort} (available: {options}); this message was not sent', {
          model,
          effort,
          options: entry.efforts.length ? entry.efforts : L('无', 'none'),
        }),
      );
    }
  } else {
    // "Default effort" with an explicit model: the configured effort when this model supports it, else the model's own default.
    effort = codexImplicitEffort(entry, cat.nativeDefault?.effort);
  }
  return { model, ...(effort ? { effort } : {}) };
}

/** The serviceTierForTurn value for a member's speed: null = nothing sent (Codex uses the thread's own tier, i.e. the
 *  user's config.toml), "default" for standard, else a tier model/list still offers for the model this turn uses.
 *  Throws (no message sent) rather than run at another speed. */
export async function turnServiceTier(adapter: CodexAdapter, cwd: string, speed: string | null, model: string | null): Promise<string | null> {
  if (!speed) return null;
  if (speed === STANDARD_SPEED) return 'default';
  const cat = await adapter.listModels({ cwd });
  if (!cat.available) {
    throw new NoticeError(L('无法确认所选速度是否可用：{error}；本消息未发送', 'Cannot confirm that the chosen speed is available: {error}; this message was not sent', { error: cat.error }));
  }
  const id = model ?? cat.nativeDefault?.model ?? null;
  const speeds = (id ? cat.models.find((m) => m.id === id)?.speeds : null) ?? cat.nativeDefault?.speeds ?? [];
  if (!speeds.some((s) => s.id === speed && s.available)) {
    throw new NoticeError(
      L('Codex 没有为模型 {model} 提供速度 {speed}（可选：{options}）；本消息未发送，请在成员设置中重新选择', 'Codex does not offer the speed {speed} for the model {model} (available: {options}); this message was not sent. Choose again in the member settings.', {
        model: id ?? '?',
        speed,
        options: speeds.length ? speeds.map((s) => s.name).join(', ') : L('仅标准', 'standard only'),
      }),
    );
  }
  return speed;
}

function describeThread(res: any, resumed: boolean): NoticeText[] {
  const sb = res.sandbox ?? {};
  const sandbox =
    typeof sb === 'string'
      ? N('codex.sandbox', { type: sb })
      : N('codex.sandbox', {
          type: sb.type ?? '?',
          net: sb.networkAccess ? N('codex.sandboxNet') : null,
          roots: Array.isArray(sb.writableRoots) && sb.writableRoots.length ? N('codex.sandboxRoots', { list: sb.writableRoots.join(', ') }) : null,
        });
  const policy = typeof res.approvalPolicy === 'string' ? res.approvalPolicy : JSON.stringify(res.approvalPolicy);
  const lines = [
    N(resumed ? 'codex.threadResumed' : 'codex.threadNew'),
    N('session.id', { id: String(res.thread?.id) }),
    N('codex.model', { model: res.model ?? '?', effort: res.reasoningEffort ? N('fmt.paren', { x: res.reasoningEffort }) : null }),
    N('session.cwd', { path: res.cwd ?? '?' }),
    sandbox,
    N('codex.policy', { policy, reviewer: res.approvalsReviewer ?? '?' }),
  ];
  if (Array.isArray(res.instructionSources) && res.instructionSources.length) {
    lines.push(N('session.instructions', { list: res.instructionSources.join(', ') }));
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------

const DETAIL_MAX = 6000;

class CodexSession implements AgentSession {
  readonly nativeSessionId: string;
  readonly info: NoticeText[];
  /** Model/effort Codex last reported for this thread (thread/start|resume, thread/settings/updated, model/rerouted). */
  current: EffectiveModel | null = null;
  /** Set while a previous turn's native end is unconfirmed (see TurnResult.nativeSettled). */
  private unsettled: Promise<void> | null = null;
  private conn: CodexConnection;
  private running = false;
  private turn: TurnRun | null = null;
  /** Thread-cumulative token counts Codex last reported (the baseline for the next turn's usage). */
  private usageTotal: TokenBreakdown | null = null;
  private readonly adapter: CodexAdapter;
  private readonly cwd: string;
  private readonly interruptTimeoutMs: number;
  private readonly teamMcp: TeamMcpConfig | undefined;
  /** Harness Team's browser this thread was opened with (Agent.browser); given again on a re-resume. */
  browserMcp: TeamMcpConfig | undefined;
  /** Harness Team rules this thread was opened with; given again when it is re-resumed after an app-server restart. */
  private readonly instructions: string | undefined;
  /** The room's agent language, for the reason sent back with a "no" (OpenSessionArgs.language). */
  language: () => AgentLanguage = () => 'zh';
  /** Sandbox / approval policy Codex last reported for this thread, as a permission mode. */
  permission: EffectivePermission | null = null;
  /** The sandbox policy object Codex last reported (its writable roots / network are reused for workspace-write). */
  private sandbox: unknown = null;
  /** The approver Codex last reported for this thread (`user`, or `auto_review` when that mode was chosen). */
  private reviewer: string = 'user';
  /** What Codex used before any override: the user's own setting (known when the thread was opened without one). */
  baseline: { sandbox: unknown; approvalPolicy: unknown } | null = null;
  /** A permission mode was applied to this thread (opened with one, or sent on turn/start). */
  overridden = false;

  constructor(
    adapter: CodexAdapter,
    conn: CodexConnection,
    threadId: string,
    cwd: string,
    info: NoticeText[],
    interruptTimeoutMs: number,
    teamMcp?: TeamMcpConfig,
    instructions?: string,
  ) {
    this.teamMcp = teamMcp;
    this.instructions = instructions;
    this.adapter = adapter;
    this.cwd = cwd;
    this.interruptTimeoutMs = interruptTimeoutMs;
    this.conn = conn;
    this.nativeSessionId = threadId;
    this.info = info;
  }

  async runTurn(input: TurnInput, sink: TurnEventSink, signal: AbortSignal): Promise<TurnResult> {
    if (this.running) return { status: 'failed', error: 'this Codex thread is already running a turn' };
    if (this.unsettled) {
      // Never start a turn on a thread whose previous turn Codex has not confirmed as ended.
      return { status: 'failed', error: L('该 Codex 线程的上一回合尚未被 Codex 确认结束，本消息未发送', 'Codex has not confirmed that the previous turn of this thread ended; this message was not sent') };
    }
    if (signal.aborted) return { status: 'interrupted' }; // nothing was sent
    this.running = true;
    try {
      if (!this.conn.alive) {
        // app-server restarted: resume this exact thread on the new process (never "most recent").
        this.conn = await this.adapter.connection();
        const want = codexMode(input.config?.permissionMode);
        const r = await openThread(this.conn, this.cwd, this.nativeSessionId, this.teamMcp, this.instructions, want, want ? 'user' : await this.adapter.ownReviewer(this.cwd), this.browserMcp);
        this.current = { model: r.model, effort: r.effort, source: RESUME_SOURCE };
        this.notePermission(r.sandbox, r.approvalPolicy, want, RESUME_SOURCE, r.reviewer);
        if (want) this.overridden = true;
        sink(noticeEvent(N('codex.restarted', { id: this.nativeSessionId })));
      }
      // A slash command's method takes no model or permission override: a changed setting goes with the next turn.
      // A skill is an ordinary turn with the skill's own input item next to the text.
      const command = input.command && !input.command.skill ? input.command : null;
      let skill: { name: string; path: string } | null = null;
      if (input.command?.skill) {
        let path = input.command.skill.path;
        if (!path) {
          const list = await this.adapter.listSkills({ cwd: this.cwd });
          path = list.skills.find((s) => s.name === input.command!.name)?.path ?? null;
        }
        if (!path) return { status: 'failed', error: L('Codex 没有报告 Skill {name} 的位置', 'Codex did not report where the skill {name} is', { name: input.command.name }) };
        skill = { name: input.command.name, path };
      }
      let overrides: { model?: string; effort?: string; note?: NoticeText } = {};
      let serviceTier: string | null = null;
      if (!command) {
        try {
          overrides = await turnOverrides(this.adapter, this.cwd, input.config, this.current);
          serviceTier = await turnServiceTier(this.adapter, this.cwd, input.config?.speed ?? null, overrides.model ?? this.current?.model ?? null);
        } catch (e) {
          return { status: 'failed', error: (e as Error).message };
        }
      }
      if (overrides.note) sink(noticeEvent(overrides.note));
      const want = codexMode(input.config?.permissionMode);
      const perm: { approvalPolicy?: unknown; sandboxPolicy?: unknown; approvalsReviewer?: CodexReviewer; note?: NoticeText } = command ? {} : await this.permissionOverrides(want);
      if (perm.note) sink(noticeEvent(perm.note));
      const requested = overrides.model || overrides.effort ? { model: overrides.model ?? null, effort: overrides.effort ?? null } : null;
      const turn = new TurnRun(this.conn, this.nativeSessionId, sink, signal, this.interruptTimeoutMs, {
        requested,
        explicit: !!(input.config && (input.config.model || input.config.effort)),
        serviceTier,
        onSettings: (e) => {
          this.current = e;
          sink({ type: 'config.effective', effective: e });
        },
        permission:
          perm.approvalPolicy !== undefined
            ? { approvalPolicy: perm.approvalPolicy, sandboxPolicy: perm.sandboxPolicy, approvalsReviewer: perm.approvalsReviewer ?? 'user' }
            : null,
        onPermission: (sandbox, approvalPolicy, source, reviewer) => {
          this.notePermission(sandbox, approvalPolicy, want, source, reviewer);
          sink({ type: 'permission.effective', permission: this.permission! });
        },
      }, {
        base: this.usageTotal,
        model: () => this.current?.model ?? null,
        onTotal: (t) => (this.usageTotal = t),
      });
      turn.language = this.language;
      this.turn = turn;
      const result = await turn.run(input.text, requested, input.attachments ?? [], command, skill);
      const settled = result.nativeSettled;
      if (settled) {
        this.unsettled = settled;
        void settled.then(() => {
          if (this.unsettled === settled) this.unsettled = null;
        });
      }
      return result;
    } catch (e) {
      return { status: 'failed', error: (e as Error).message };
    } finally {
      this.turn = null;
      this.running = false;
    }
  }

  respondApproval(nativeRequestId: string, decision: ApprovalDecision, answers?: ApprovalAnswers): ApprovalAnswer {
    if (!this.turn) return { ok: false, error: NO_TURN };
    return this.turn.respond(nativeRequestId, decision, answers);
  }

  steer(input: SteerInput): Promise<SteerAnswer> {
    if (!this.turn) return Promise.resolve({ ok: false, error: NO_TURN });
    return this.turn.steer(input);
  }

  /** Records what Codex reported (thread open, thread/settings/updated, or the accepted turn/start parameters). */
  notePermission(sandbox: unknown, approvalPolicy: unknown, want: CodexPermissionMode | null, source: Localized, reviewer?: unknown) {
    if (sandbox != null) this.sandbox = sandbox;
    const r = codexReviewer(reviewer);
    if (r) this.reviewer = r;
    this.permission = codexPermission(sandbox ?? this.sandbox, approvalPolicy, want, source, this.reviewer);
  }

  /**
   * What turn/start must carry for the chosen mode ("for this turn and subsequent turns"): nothing when Codex already
   * reports it. Back on "follow" after an override, the user's own setting is sent back (as reported when the thread
   * was opened without an override, else from config.toml); when neither is known the thread keeps its current
   * permissions and the chat says so.
   */
  private async permissionOverrides(
    want: CodexPermissionMode | null,
  ): Promise<{ approvalPolicy?: unknown; sandboxPolicy?: unknown; approvalsReviewer?: CodexReviewer; note?: NoticeText }> {
    if (want) {
      this.overridden = true;
      if (this.permission?.mode === want) return {};
      const spec = CODEX_MODES[want];
      const approvalsReviewer = spec.reviewer;
      if (spec.sandbox === 'read-only') return { approvalPolicy: spec.approvalPolicy, sandboxPolicy: { type: 'readOnly', networkAccess: false }, approvalsReviewer };
      if (spec.sandbox === 'danger-full-access') return { approvalPolicy: spec.approvalPolicy, sandboxPolicy: { type: 'dangerFullAccess' }, approvalsReviewer };
      // Keep the writable roots / network access the user configured for workspace-write.
      const known = [this.sandbox, this.baseline?.sandbox].find((s) => sandboxType(s) === 'workspaceWrite' && typeof s === 'object');
      const sandboxPolicy = known ? { ...(known as Record<string, unknown>) } : ((await this.adapter.workspaceWriteDefaults(this.cwd)) ?? workspaceWritePolicy(null));
      return { approvalPolicy: spec.approvalPolicy, sandboxPolicy, approvalsReviewer };
    }
    if (!this.overridden) return {};
    const base = this.baseline
      ? { approvalPolicy: this.baseline.approvalPolicy, sandboxPolicy: this.baseline.sandbox }
      : await this.adapter.permissionDefaults(this.cwd);
    if (!base || base.approvalPolicy == null || base.sandboxPolicy == null) {
      return {
        note: L(
          '无法确定你自己的 Codex 权限设置（config.toml 未同时设置 sandbox_mode 与 approval_policy）；该成员在本会话中保持当前的权限（{now}）。',
          'Cannot tell your own Codex permission settings (config.toml does not set both sandbox_mode and approval_policy); this member keeps its current permissions ({now}) in this session.',
          { now: this.permission?.native ?? '?' },
        ),
      };
    }
    this.overridden = false;
    // Back to "follow": the approver of the user's own configuration too.
    return { ...base, approvalsReviewer: await this.adapter.ownReviewer(this.cwd) };
  }

  get effective(): EffectiveModel | null {
    return this.current;
  }

  async unload(): Promise<void> {
    // thread/resume on a thread the app-server still has loaded keeps that thread's MCP servers; unsubscribed, the
    // thread is unloaded and the next thread/resume starts it with the new ones.
    if (!this.conn.alive || this.running) return;
    await this.conn.rpc.request('thread/unsubscribe', { threadId: this.nativeSessionId }).catch(() => {});
  }

  async close(): Promise<void> {
    // The shared process is owned by the adapter; the thread stays resumable on disk.
  }
}

interface PendingRequest {
  id: RpcId;
  method: string;
  form: ApprovalForm | null;
  options: ApprovalDecision[];
}

interface TurnSettingsHooks {
  /** What turn/start carried (null = nothing; Codex keeps the thread's own settings). */
  requested: { model: string | null; effort: string | null } | null;
  /** The agent asked for this explicitly (a different report is then a mismatch the user must see). */
  explicit: boolean;
  onSettings(e: EffectiveModel): void;
  /** Sandbox / approval policy turn/start carries (null = nothing; Codex keeps the thread's own). */
  permission?: { approvalPolicy: unknown; sandboxPolicy: unknown; approvalsReviewer: CodexReviewer } | null;
  onPermission?(sandbox: unknown, approvalPolicy: unknown, source: Localized, reviewer?: unknown): void;
  /** The service tier for this turn only (serviceTierForTurn; "default" = standard). Omitted: the thread's own tier. */
  serviceTier?: string | null;
}

/** Codex TokenUsageBreakdown (thread/tokenUsage/updated). inputTokens includes cachedInputTokens. */
interface TokenBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

const tokenNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

function breakdown(v: any): TokenBreakdown | null {
  if (!v || typeof v !== 'object') return null;
  return {
    inputTokens: tokenNum(v.inputTokens),
    cachedInputTokens: tokenNum(v.cachedInputTokens),
    cacheWriteInputTokens: tokenNum(v.cacheWriteInputTokens),
    outputTokens: tokenNum(v.outputTokens),
    reasoningOutputTokens: tokenNum(v.reasoningOutputTokens),
  };
}

const minus = (a: TokenBreakdown, b: TokenBreakdown): TokenBreakdown => ({
  inputTokens: Math.max(0, a.inputTokens - b.inputTokens),
  cachedInputTokens: Math.max(0, a.cachedInputTokens - b.cachedInputTokens),
  cacheWriteInputTokens: Math.max(0, a.cacheWriteInputTokens - b.cacheWriteInputTokens),
  outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
  reasoningOutputTokens: Math.max(0, a.reasoningOutputTokens - b.reasoningOutputTokens),
});

/**
 * One turn's usage from Codex's thread-cumulative totals: `total` at the end minus the total before the turn. The
 * baseline is the previous turn's last total; for the first turn seen on a thread (new, or resumed after a restart) it
 * is the first report's total minus its `last` (the one model call that report covers). Disjoint counts as TurnUsage.
 */
export function codexTurnUsage(base: TokenBreakdown, end: TokenBreakdown, model: string | null): TurnUsage | null {
  const d = minus(end, base);
  const cached = Math.min(d.cachedInputTokens, d.inputTokens);
  const row: TurnUsage = {
    model,
    input: d.inputTokens - cached,
    cacheRead: cached,
    cacheWrite: d.cacheWriteInputTokens,
    output: d.outputTokens,
    reasoning: Math.min(d.reasoningOutputTokens, d.outputTokens),
    costUsd: null,
  };
  return row.input + row.cacheRead + row.cacheWrite + row.output > 0 ? row : null;
}

interface TurnUsageHooks {
  base: TokenBreakdown | null;
  model(): string | null;
  onTotal(total: TokenBreakdown): void;
}

/** State for one turn on one thread. */
class TurnRun {
  private turnId: string | null = null;
  private turnIdWaiters: ((id: string | null) => void)[] = [];
  private readonly pending = new Map<string, PendingRequest>();
  private readonly phases = new Map<string, string | null>();
  private readonly output = new Map<string, { text: string; lastEmit: number }>();
  private readonly items = new Map<string, any>();
  private lastError: string | null = null;
  /** `/review`: the finished review, shown only when Codex sends no agentMessage with it. */
  private reviewText: string | null = null;
  /** The review was already shown as a reply: a non-commentary agentMessage after it, or one with the same text. */
  private reviewShown = false;
  private replyTexts = new Set<string>();
  private finish!: (r: TurnResult) => void;
  private readonly done: Promise<TurnResult>;
  private finished = false;
  private interruptTimer: NodeJS.Timeout | null = null;
  /** The native turn is known to be over (turn/completed, turn/start rejected, or app-server gone). */
  private nativeEnded = false;
  private settleNative!: () => void;
  private readonly nativeSettled: Promise<void> = new Promise((r) => (this.settleNative = r));

  private readonly conn: CodexConnection;
  private readonly threadId: string;
  private readonly sink: TurnEventSink;
  private readonly signal: AbortSignal;
  private readonly interruptTimeoutMs: number;
  private readonly settings: TurnSettingsHooks | null;
  private settingsReported = false;
  private permissionReported = false;
  private readonly usageHooks: TurnUsageHooks | null;
  private usageBase: TokenBreakdown | null;
  private usageEnd: TokenBreakdown | null = null;
  /** Set by the session (OpenSessionArgs.language). */
  language: () => AgentLanguage = () => 'zh';
  /** A slash command's turn (`/review`, `/compact`): Codex takes no added input there. */
  private command = false;

  constructor(
    conn: CodexConnection,
    threadId: string,
    sink: TurnEventSink,
    signal: AbortSignal,
    interruptTimeoutMs: number,
    settings: TurnSettingsHooks | null = null,
    usage: TurnUsageHooks | null = null,
  ) {
    this.settings = settings;
    this.usageHooks = usage;
    this.usageBase = usage?.base ?? null;
    this.conn = conn;
    this.threadId = threadId;
    this.sink = sink;
    this.signal = signal;
    this.interruptTimeoutMs = interruptTimeoutMs;
    this.done = new Promise((r) => (this.finish = r));
  }

  async run(
    text: string,
    overrides: { model: string | null; effort: string | null } | null = null,
    attachments: TurnAttachment[] = [],
    command: { name: string; args: string } | null = null,
    skill: { name: string; path: string } | null = null,
  ): Promise<TurnResult> {
    this.command = !!command;
    const start = command
      ? codexCommandRequest(this.threadId, command)
      : {
          method: 'turn/start',
          params: {
            threadId: this.threadId,
            // Images as Codex's own local-image input (as the Codex desktop app sends them); other files only by path in the text.
            input: [
              { type: 'text', text, text_elements: [] },
              ...attachments.filter((a) => a.kind === 'image').map((a) => ({ type: 'localImage', path: a.path })),
              // `@member /skill`: Codex's own skill input (as its composer sends a chosen skill).
              ...(skill ? [{ type: 'skill', name: skill.name, path: skill.path }] : []),
            ],
            // Official per-turn override ("for this turn and subsequent turns"); omitted = Codex keeps its own settings.
            ...(overrides?.model ? { model: overrides.model } : {}),
            ...(overrides?.effort ? { effort: overrides.effort } : {}),
            // Official per-turn tier: does not change the thread's own tier, so a member back on "follow" sends nothing.
            ...(this.settings?.serviceTier ? { serviceTierForTurn: this.settings.serviceTier } : {}),
            ...(this.settings?.permission
              ? {
                  approvalPolicy: this.settings.permission.approvalPolicy,
                  sandboxPolicy: this.settings.permission.sandboxPolicy,
                  approvalsReviewer: this.settings.permission.approvalsReviewer,
                }
              : {}),
          },
        };
    const unlisten = this.conn.listen(this.threadId, {
      onNotification: (m, p) => this.onNotification(m, p),
      onServerRequest: (id, m, p) => this.onServerRequest(id, m, p),
      onExit: (reason) => {
        this.markNativeEnded();
        this.end({ status: 'failed', error: L('codex app-server 已退出：{reason}', 'codex app-server exited: {reason}', { reason }) });
      },
    });
    const onAbort = () => void this.interrupt();
    this.signal.addEventListener('abort', onAbort, { once: true });
    try {
      this.conn.rpc
        .request(start.method, start.params)
        .then((res: any) => {
          // thread/compact/start answers {} and announces its turn with turn/started only.
          if (!command || res?.turn?.id) this.setTurnId(String(res?.turn?.id ?? ''));
          // Accepted. If Codex does not echo the settings, record what was sent (labelled as such).
          if (overrides && this.settings && !this.settingsReported) {
            this.settings.onSettings({ model: overrides.model, effort: overrides.effort, source: L('turn/start 参数（已被 Codex 接受）', 'turn/start parameters (accepted by Codex)') });
          }
          const perm = this.settings?.permission;
          if (perm && !this.permissionReported) {
            this.settings!.onPermission?.(perm.sandboxPolicy, perm.approvalPolicy, L('turn/start 参数（已被 Codex 接受）', 'turn/start parameters (accepted by Codex)'), perm.approvalsReviewer);
          }
        })
        .catch((e) => {
          this.markNativeEnded(); // turn/start rejected: no native turn to wait for
          this.setTurnId(null);
          this.end({ status: 'failed', error: L('{method} 失败：{error}', '{method} failed: {error}', { method: start.method, error: (e as Error).message }) });
        });
      return await this.done;
    } finally {
      this.signal.removeEventListener('abort', onAbort);
      if (this.interruptTimer) clearTimeout(this.interruptTimer);
      // Unconfirmed native end: keep listening for the late turn/completed (or the process exit) that settles it.
      if (this.nativeEnded) unlisten();
      else void this.nativeSettled.then(unlisten);
    }
  }

  /** Tracks the thread total even after an unconfirmed end, so the next turn's baseline stays right. */
  private onTokenUsage(p: any) {
    if (p?.turnId && this.turnId && p.turnId !== this.turnId) return;
    const total = breakdown(p?.tokenUsage?.total);
    if (!total) return;
    if (!this.usageBase) {
      const last = breakdown(p?.tokenUsage?.last);
      this.usageBase = last ? minus(total, last) : total;
    }
    if (!this.finished) this.usageEnd = total;
    this.usageHooks?.onTotal(total);
  }

  private markNativeEnded() {
    if (this.nativeEnded) return;
    this.nativeEnded = true;
    this.settleNative();
  }

  private emit(ev: TurnEvent) {
    if (!this.finished) this.sink(ev);
  }

  private end(r: TurnResult) {
    if (this.finished) return;
    // Anything still waiting for a human can no longer be answered meaningfully.
    for (const [key, p] of this.pending) {
      respondCancel(this.conn.rpc, p.id, p.method, 'turn ended');
      this.sink({ type: 'approval.resolved', nativeRequestId: key, decision: 'cancelled' });
    }
    this.pending.clear();
    this.finished = true;
    const usage = this.usageBase && this.usageEnd ? codexTurnUsage(this.usageBase, this.usageEnd, this.usageHooks?.model() ?? null) : null;
    if (usage) r = { ...r, usage: [usage] };
    // Ended on our side only (interrupt timeout): the native turn may still run. Fail closed until Codex confirms.
    this.finish(this.nativeEnded ? r : { ...r, nativeSettled: this.nativeSettled });
  }

  private setTurnId(id: string | null) {
    if (id && !this.turnId) {
      this.turnId = id;
      this.emit({ type: 'turn.started', nativeTurnId: id });
    }
    for (const w of this.turnIdWaiters) w(this.turnId);
    this.turnIdWaiters = [];
  }

  private async interrupt() {
    if (this.finished) return;
    // 1) cancel pending human requests (never approve), 2) ask Codex to interrupt, 3) wait for turn/completed.
    for (const [key, p] of this.pending) {
      respondCancel(this.conn.rpc, p.id, p.method, 'interrupted by user');
      this.emit({ type: 'approval.resolved', nativeRequestId: key, decision: 'cancelled' });
    }
    this.pending.clear();
    const turnId = this.turnId ?? (await new Promise<string | null>((r) => this.turnIdWaiters.push(r)));
    if (this.finished || !turnId) return;
    this.interruptTimer = setTimeout(
      () =>
        this.end({
          status: 'failed',
          error: L(
            '已请求中断，但 {ms} ms 内未收到 Codex 的结束确认；原生回合可能仍在运行，确认结束前不会向该成员或同一工作目录派发新任务',
            'You asked to interrupt, but Codex did not confirm the end within {ms} ms; the native turn may still be running, and nothing new goes to this member or the same working folder until it has ended',
            { ms: this.interruptTimeoutMs },
          ),
        }),
      this.interruptTimeoutMs,
    );
    try {
      await this.conn.rpc.request('turn/interrupt', { threadId: this.threadId, turnId }, 15_000);
    } catch (e) {
      this.emit(noticeEvent(N('codex.interruptFailed', { error: (e as Error).message })));
    }
  }

  /**
   * Adds the user's message to this turn with `turn/steer`. `expectedTurnId` makes Codex refuse it when this turn is
   * no longer the active one, so it is never added to a later turn.
   */
  async steer(input: SteerInput): Promise<SteerAnswer> {
    if (this.command) return { ok: false, error: L('Codex 的命令回合不接受插话', 'A Codex command turn takes no added message') };
    const turnId = this.turnId ?? (await new Promise<string | null>((r) => this.turnIdWaiters.push(r)));
    if (this.finished || !turnId || this.signal.aborted || !this.conn.rpc.running) return { ok: false, error: NO_TURN };
    try {
      await this.conn.rpc.request(
        'turn/steer',
        {
          threadId: this.threadId,
          expectedTurnId: turnId,
          input: [
            { type: 'text', text: input.text, text_elements: [] },
            ...(input.attachments ?? []).filter((a) => a.kind === 'image').map((a) => ({ type: 'localImage', path: a.path })),
          ],
        },
        15_000,
      );
      return { ok: true };
    } catch (e) {
      const error = L('turn/steer 失败：{error}', 'turn/steer failed: {error}', { error: (e as Error).message });
      // An error answer is Codex refusing it; no answer (timed out, the app-server gone) leaves open whether it took it.
      return e instanceof RpcError && e.code !== undefined ? { ok: false, error } : { ok: false, error, unknown: true };
    }
  }

  /** The user's decision for one pending request of this turn, sent on its exact JSON-RPC id. */
  respond(key: string, decision: ApprovalDecision, answers?: ApprovalAnswers): ApprovalAnswer {
    const p = this.pending.get(key);
    if (this.finished || !p) return { ok: false, error: REQUEST_GONE };
    if (this.signal.aborted) return { ok: false, error: REQUEST_INTERRUPTED };
    if (!p.options.includes(decision)) return { ok: false, error: unsupportedDecision(p.method, decision) };
    this.pending.delete(key);
    return { ok: true, nativeDecision: respondDecision(this.conn.rpc, p.id, p, decision, this.language(), answers) };
  }

  private onServerRequest(id: RpcId, method: string, p: any): boolean {
    if (this.finished || !APPROVAL_METHODS.has(method)) return false;
    if (this.signal.aborted) return false; // interrupting: the connection-level handler cancels it
    const key = String(id);
    const form = requestForm(method, p);
    const options = approvalOptions(method, form);
    this.pending.set(key, { id, method, form, options });
    const { title, label, reason, detail } = describeRequest(method, p, this.items.get(p.itemId));
    this.emit({
      type: 'approval.requested',
      nativeRequestId: key,
      nativeMethod: method,
      itemId: p.itemId ?? p.callId ?? null,
      title,
      label,
      reason,
      // Questions shown as a form need no list of them above it.
      detail: form && method === 'item/tool/requestUserInput' ? null : detail,
      options,
      ...(form ? { form } : {}),
    });
    return true;
  }

  private onNotification(method: string, p: any) {
    if (method === 'thread/tokenUsage/updated') return this.onTokenUsage(p);
    if (this.finished) {
      // After an unconfirmed interrupt only the native end matters (late output is not shown).
      if (method === 'turn/completed' && (!this.turnId || !p.turn?.id || p.turn.id === this.turnId)) this.markNativeEnded();
      return;
    }
    switch (method) {
      case 'turn/started':
        this.setTurnId(String(p.turn?.id ?? ''));
        return;
      case 'turn/completed': {
        const t = p.turn ?? {};
        if (this.turnId && t.id && t.id !== this.turnId) return;
        this.markNativeEnded();
        const status = t.status === 'completed' ? 'completed' : t.status === 'interrupted' ? 'interrupted' : 'failed';
        if (status === 'completed' && this.reviewText && !this.reviewShown && !this.replyTexts.has(this.reviewText.trim())) {
          this.emit({ type: 'text.done', itemId: 'review', text: this.reviewText, phase: 'final_answer' });
        }
        const error = status === 'failed' ? (t.error?.message ?? this.lastError ?? `turn ended with status ${t.status}`) : undefined;
        this.end({ status, error });
        return;
      }
      case 'serverRequest/resolved': {
        const key = String(p.requestId);
        if (this.pending.delete(key)) this.emit({ type: 'approval.resolved', nativeRequestId: key });
        return;
      }
      case 'error': {
        const msg = p.error?.message ?? 'unknown error';
        if (p.willRetry) this.emit(noticeEvent(N('codex.retrying', { error: msg })));
        else this.lastError = msg;
        return;
      }
      case 'warning':
        if (p.message) this.emit(noticeEvent(N('codex.warning', { message: String(p.message) })));
        return;
      case 'item/autoApprovalReview/completed': {
        // Codex's own reviewer decided (auto-review): shown in the chat, since no approval card comes to the user.
        if (this.turnId && p.turnId && p.turnId !== this.turnId) return;
        const key = AUTO_REVIEW_NOTICE[String(p.review?.status ?? '')];
        if (!key) return;
        this.emit(
          noticeEvent(
            N(key, {
              action: autoReviewAction(p.action),
              risk: String(p.review?.riskLevel ?? '-'),
              rationale: clipHead(String(p.review?.rationale ?? '-'), 400),
            }),
          ),
        );
        return;
      }
      case 'thread/settings/updated': {
        const ts = p.threadSettings ?? {};
        if (ts.sandboxPolicy !== undefined || ts.approvalPolicy !== undefined || ts.approvalsReviewer !== undefined) {
          this.permissionReported = true;
          this.settings?.onPermission?.(ts.sandboxPolicy ?? null, ts.approvalPolicy ?? null, 'Codex thread/settings/updated', ts.approvalsReviewer);
        }
        const model = typeof ts.model === 'string' ? ts.model : null;
        const effort = typeof ts.effort === 'string' ? ts.effort : null;
        this.settingsReported = true;
        const req = this.settings?.requested;
        const differs = !!req && ((req.model !== null && req.model !== model) || (req.effort !== null && req.effort !== effort));
        this.settings?.onSettings({
          model,
          effort,
          source: 'Codex thread/settings/updated',
          mismatch:
            differs && this.settings.explicit
              ? L('Codex 报告的生效配置（{model} · {effort}）与所选（{wantModel} · {wantEffort}）不一致', 'The settings Codex reports ({model} · {effort}) differ from the chosen ones ({wantModel} · {wantEffort})', {
                  model: model ?? '?',
                  effort: effort ?? DEFAULT_WORD,
                  wantModel: req!.model ?? DEFAULT_WORD,
                  wantEffort: req!.effort ?? DEFAULT_WORD,
                })
              : null,
        });
        return;
      }
      case 'model/rerouted': {
        // Codex (server side) moved this turn to another model. Never hidden.
        const to = String(p.toModel ?? '?');
        this.settingsReported = true;
        this.settings?.onSettings({
          model: to,
          effort: this.settings.requested?.effort ?? null,
          source: 'Codex model/rerouted',
          mismatch: L(
            'Codex 将本回合从模型 {from} 改路由到 {to}（原因：{reason}）。这是 Codex 服务端的决定，Harness Team 未更改你的配置。',
            'Codex rerouted this turn from the model {from} to {to} (reason: {reason}). This was decided by the Codex server; Harness Team did not change your configuration.',
            { from: String(p.fromModel ?? '?'), to, reason: typeof p.reason === 'string' ? p.reason : String(JSON.stringify(p.reason)) },
          ),
        });
        return;
      }
      case 'item/agentMessage/delta':
        this.emit({ type: 'text.delta', itemId: p.itemId, text: String(p.delta ?? ''), phase: this.phases.get(p.itemId) ?? null });
        return;
      case 'item/commandExecution/outputDelta': {
        const o = this.output.get(p.itemId) ?? { text: '', lastEmit: 0 };
        o.text = (o.text + String(p.delta ?? '')).slice(-DETAIL_MAX);
        this.output.set(p.itemId, o);
        const item = this.items.get(p.itemId);
        if (item && Date.now() - o.lastEmit > 1000) {
          o.lastEmit = Date.now();
          this.emitItem(item, false);
        }
        return;
      }
      case 'turn/plan/updated': {
        const steps = Array.isArray(p.plan) ? p.plan : [];
        const mark: Record<string, string> = { completed: '[x]', inProgress: '[~]', pending: '[ ]' };
        const detail = [p.explanation, ...steps.map((s: any) => `${mark[s.status] ?? '[ ]'} ${s.step}`)].filter(Boolean).join('\n');
        this.emit({
          type: 'activity',
          itemId: `plan:${p.turnId ?? this.turnId}`,
          activity: 'plan',
          ...titled(N('tool.plan', { done: steps.filter((s: any) => s.status === 'completed').length, total: steps.length })),
          detail,
          nativeStatus: null,
          done: false,
        });
        return;
      }
      case 'item/started':
      case 'item/completed': {
        const item = p.item;
        if (!item?.id) return;
        this.items.set(item.id, item);
        if (item.type === 'exitedReviewMode') {
          // The finished review (`/review`). Codex 0.167 also sends it as an agentMessage right after (verified live);
          // kept for the end of the turn in case it does not.
          if (method === 'item/completed' && item.review) this.reviewText = String(item.review);
          return;
        }
        if (item.type === 'agentMessage') {
          this.phases.set(item.id, item.phase ?? null);
          if (method === 'item/completed') {
            // Progress (`commentary`) never stands in for the review result.
            if (item.text && item.phase !== 'commentary') {
              this.replyTexts.add(String(item.text).trim());
              if (this.reviewText !== null) this.reviewShown = true;
            }
            this.emit({ type: 'text.done', itemId: item.id, text: String(item.text ?? ''), phase: item.phase ?? null });
          }
          return;
        }
        this.emitItem(item, method === 'item/completed');
        return;
      }
      default:
        return; // token usage, hooks, mcp startup, diffs (covered by fileChange items), etc.
    }
  }

  private emitItem(item: any, done: boolean) {
    const mapped = mapItem(item, this.output.get(item.id)?.text);
    if (!mapped) return;
    this.emit({ type: 'activity', itemId: item.id, done, nativeStatus: item.status ?? null, ...mapped, failed: done ? mapped.failed : undefined });
  }
}

/** Slash commands of a Codex member, each the app-server method the Codex TUI uses for it. */
const CODEX_COMMANDS: RuntimeCommand[] = [
  { name: 'compact', action: 'native', description: L('压缩本会话的上下文（Codex thread/compact/start）', 'Compact this session’s context (Codex thread/compact/start)') },
  {
    name: 'review',
    action: 'native',
    args: L('[base <分支> | commit <sha> | 审查要求]', '[base <branch> | commit <sha> | instructions]'),
    description: L('审查代码改动（Codex review/start）；不带参数 = 未提交的改动', 'Review code changes (Codex review/start); no argument = uncommitted changes'),
  },
  { name: 'model', action: 'settings', description: L('更换模型（成员设置）', 'Change the model (member settings)') },
  { name: 'effort', action: 'settings', description: L('更换 Effort（成员设置）', 'Change the effort (member settings)') },
];

/** The app-server request behind a slash command. */
export function codexCommandRequest(threadId: string, command: { name: string; args: string }): { method: string; params: Record<string, unknown> } {
  switch (command.name) {
    case 'compact':
      return { method: 'thread/compact/start', params: { threadId } };
    case 'review':
      return { method: 'review/start', params: { threadId, target: reviewTarget(command.args), delivery: 'inline' } };
    default:
      throw new NoticeError(L('Codex 成员没有命令 /{name}', 'Codex members have no command /{name}', { name: command.name }));
  }
}

/** `/review` arguments: none = uncommitted changes, `base <branch>`, `commit <sha>`, anything else = instructions. */
export function reviewTarget(args: string): Record<string, unknown> {
  const text = args.trim();
  if (!text) return { type: 'uncommittedChanges' };
  const m = /^(base|commit)\s+(\S+)$/i.exec(text);
  if (m && m[1]!.toLowerCase() === 'base') return { type: 'baseBranch', branch: m[2] };
  if (m && /^[0-9a-f]{4,64}$/i.test(m[2]!)) return { type: 'commit', sha: m[2] };
  return { type: 'custom', instructions: text };
}

const RESUME_SOURCE = L('Codex thread/resume 响应', 'Codex thread/resume response');
const DEFAULT_WORD = L('默认', 'default');

function clip(s: string | null | undefined, max = DETAIL_MAX): string | null {
  if (!s) return null;
  return s.length > max ? `…（已截断，仅显示末尾 ${max} 字符）\n${s.slice(-max)}` : s;
}

function head(s: string | null | undefined, max = DETAIL_MAX): string | null {
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max)}\n…（已截断）` : s;
}

type MappedItem = { activity: ActivityKind; title: string; label?: NoticeText; detail: string | null; failed: boolean; files?: FileChange[] };

const AUTO_REVIEW_NOTICE: Record<string, 'codex.autoReview.approved' | 'codex.autoReview.denied' | 'codex.autoReview.timedOut' | 'codex.autoReview.aborted'> = {
  approved: 'codex.autoReview.approved',
  denied: 'codex.autoReview.denied',
  timedOut: 'codex.autoReview.timedOut',
  aborted: 'codex.autoReview.aborted',
};

/** One line naming what Codex's reviewer decided on ([UNSTABLE] GuardianApprovalReviewAction in Codex 0.167). */
function autoReviewAction(a: any): string {
  const s = (() => {
    switch (a?.type) {
      case 'command':
        return String(a.command ?? '');
      case 'execve':
        return [a.program, ...(Array.isArray(a.argv) ? a.argv.slice(1) : [])].join(' ');
      case 'applyPatch':
        return `apply_patch ${(a.files ?? []).join(', ')}`;
      case 'networkAccess':
        return `${a.protocol ?? 'network'} ${a.host ?? a.target ?? ''}${a.port ? `:${a.port}` : ''}`;
      case 'mcpToolCall':
        return `MCP ${a.server ?? ''}/${a.toolName ?? ''}`;
      case 'writeStdin':
        return 'write_stdin';
      case 'requestPermissions':
        return `request_permissions${a.reason ? ` (${a.reason})` : ''}`;
      default:
        return String(a?.type ?? '?');
    }
  })();
  return clipHead(s, 300);
}

function clipHead(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function noticeEvent(n: NoticeText): { type: 'notice'; text: string; notice: NoticeText } {
  return { type: 'notice', text: zhText(n), notice: n };
}

/** title (Chinese, stored as the body) + label (translatable). */
function titled(n: NoticeText): { title: string; label: NoticeText } {
  return { title: zhText(n), label: n };
}

function codexChange(kind: unknown): FileChange['change'] {
  const k = typeof kind === 'string' ? kind : typeof (kind as any)?.type === 'string' ? (kind as any).type : '';
  return k === 'add' || k === 'delete' ? k : 'update';
}

/**
 * Codex reports an added or deleted file with its whole content as `diff` (only updates carry a unified diff); as
 * +/- lines it reads like the other diffs and its lines are counted.
 */
function codexDiff(change: FileChange['change'], diff: unknown): string {
  if (typeof diff !== 'string' || !diff) return '';
  if (change !== 'add' && change !== 'delete') return diff;
  const mark = change === 'add' ? '+' : '-';
  return diff
    .replace(/\r?\n$/, '')
    .split(/\r?\n/)
    .map((l) => mark + l)
    .join('\n');
}

function mapItem(item: any, liveOutput?: string): MappedItem | null {
  const failedStatus = ['failed', 'declined'].includes(item.status);
  switch (item.type) {
    case 'reasoning':
    case 'userMessage':
    case 'hookPrompt':
    case 'agentMessage':
      return null;
    case 'commandExecution': {
      const out = item.aggregatedOutput ?? liveOutput ?? '';
      const meta = [
        item.cwd ? `cwd: ${item.cwd}` : null,
        item.exitCode !== null && item.exitCode !== undefined ? `exit code: ${item.exitCode}` : null,
        item.durationMs ? `耗时: ${item.durationMs} ms` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      return {
        activity: 'command',
        title: String(item.command ?? '(command)'),
        detail: [meta, clip(out)].filter(Boolean).join('\n\n') || null,
        failed: failedStatus || (typeof item.exitCode === 'number' && item.exitCode !== 0),
      };
    }
    case 'fileChange': {
      const changes: any[] = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes.map((c) => c.path);
      return {
        activity: 'fileChange',
        ...titled(paths.length ? N('tool.files', { n: paths.length, list: paths.join(', ') }) : N('tool.filesPlain')),
        detail: head(changes.map((c) => `--- ${c.path} (${typeof c.kind === 'string' ? c.kind : (c.kind?.type ?? '')})\n${c.diff ?? ''}`).join('\n')),
        failed: failedStatus,
        files: changes
          .filter((c) => typeof c?.path === 'string')
          .map((c) => {
            const change = codexChange(c.kind);
            return { path: c.path, change, diff: codexDiff(change, c.diff) };
          }),
      };
    }
    case 'mcpToolCall':
      return {
        activity: 'mcpToolCall',
        title: `${item.server} · ${item.tool}`,
        detail: item.error?.message ? `错误：${item.error.message}` : head(item.result ? JSON.stringify(item.result.content ?? item.result, null, 1) : null, 3000),
        failed: failedStatus || !!item.error,
      };
    case 'webSearch': {
      const q = item.query || item.action?.query || item.action?.url || '';
      return { activity: 'webSearch', ...titled(N('tool.webSearch', { query: q })), detail: null, failed: false };
    }
    case 'plan':
      return { activity: 'plan', ...titled(N('tool.planPlain')), detail: head(item.text), failed: false };
    case 'dynamicToolCall':
      return { activity: 'other', ...titled(N('tool.other', { name: `${item.namespace ? `${item.namespace}.` : ''}${item.tool}` })), detail: null, failed: failedStatus || item.success === false };
    case 'collabAgentToolCall':
    case 'subAgentActivity':
      return { activity: 'other', ...titled(N('tool.subActivity', { what: `${item.type}${item.tool ? ` · ${typeof item.tool === 'string' ? item.tool : JSON.stringify(item.tool)}` : ''}` })), detail: null, failed: failedStatus };
    case 'imageView':
      return { activity: 'other', ...titled(N('tool.viewImage', { path: String(item.path) })), detail: null, failed: false };
    case 'contextCompaction':
      return { activity: 'notice', ...titled(N('tool.compacted')), detail: null, failed: false };
    case 'enteredReviewMode':
      return { activity: 'notice', ...titled(N('tool.reviewStarted', { what: String(item.review ?? '') })), detail: null, failed: false };
    default:
      return { activity: 'other', title: String(item.type), detail: null, failed: failedStatus };
  }
}

function describeRequest(method: string, p: any, item: any): { title: string; label?: NoticeText; reason: string | null; detail: string | null } {
  const reason = p.reason ? String(p.reason) : null;
  const t = (n: NoticeText) => ({ ...titled(n), reason });
  switch (method) {
    case 'item/commandExecution/requestApproval':
    {
      // `command` is Codex's own quoted rendering (on Windows its backslashes are escaped, e.g. "C:\Users"); it stays
      // as reported. The parsed commands (`commandActions`) are listed under it as they will run, unescaped.
      const actions: string[] = Array.isArray(p.commandActions)
        ? p.commandActions.map((a: any) => (typeof a?.command === 'string' ? a.command : '')).filter(Boolean)
        : [];
      const lines = [...actions.map((c) => `$ ${c}`), p.cwd ? `cwd: ${p.cwd}` : null].filter(Boolean);
      return { ...t(N('approval.command', { command: p.command ?? item?.command ?? '(?)' })), detail: head(lines.join('\n'), 3000) || null };
    }
    case 'item/fileChange/requestApproval': {
      const changes: any[] = Array.isArray(item?.changes) ? item.changes : [];
      return {
        ...t(N('approval.files', { list: changes.length ? N('approval.filesList', { list: changes.map((c) => c.path).join(', ') }) : null })),
        detail: [p.grantRoot ? zhText(N('approval.grantRoot', { path: p.grantRoot })) : null, head(changes.map((c) => c.diff).join('\n'), 3000)].filter(Boolean).join('\n') || null,
      };
    }
    case 'item/permissions/requestApproval':
      return { ...t(N('approval.permissions')), detail: head(JSON.stringify(p.permissions, null, 1), 3000) };
    case 'item/tool/requestUserInput':
      return {
        ...t(N('approval.question')),
        detail: head((p.questions ?? []).map((q: any) => `- ${q.question ?? q.header ?? JSON.stringify(q)}`).join('\n'), 3000),
      };
    case 'mcpServer/elicitation/request':
      return { ...t(N('approval.mcpInput', { server: String(p.serverName) })), detail: [p.message, p.url].filter(Boolean).join('\n') || null };
    case 'execCommandApproval':
      return { ...t(N('approval.command', { command: Array.isArray(p.command) ? p.command.join(' ') : String(p.command) })), detail: p.cwd ? `cwd: ${p.cwd}` : null };
    case 'applyPatchApproval':
      return { ...t(N('approval.patch')), detail: null };
    default:
      return { title: method, reason, detail: null };
  }
}
