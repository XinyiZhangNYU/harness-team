import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { L, type Localized, type NoticeText } from '../../../../shared/notices.ts';
import type { PermissionMode, RuntimeBilling } from '../../../../shared/protocol.ts';
import { PERMISSION_MODES } from '../../../../shared/protocol.ts';
import { AcpAdapter, type AcpAdapterOptions, type ExtensionReply } from '../acp/adapter.ts';
import { type CliLaunch, cliFromPath, cliVersion, findCli } from '../cli-path.ts';
import { redactText } from '../../redact.ts';

/**
 * Kimi Code through its official, unmodified ACP server (`kimi acp`), spoken as ACP v1 over stdio
 * (github.com/MoonshotAI/kimi-code, packages/acp-server).
 *
 * Harness Team never reads, stores or forwards Kimi's credentials and never calls `authenticate`: the user signs in
 * with `/login` in `kimi` (or `kimi acp --login`) in their own terminal, and the runtime gets the user's environment
 * as a terminal has it. With a Kimi Code login, usage counts against the user's Kimi membership (Kimi Code needs a
 * paid membership; there is no free quota). With a Moonshot Open Platform API key configured in Kimi instead, it is
 * billed per token; the note says so.
 * Tool approvals come through session/request_permission; "Approve for this session" is never chosen. Kimi's session
 * modes (default / plan / auto / yolo) are the member's permission modes; yolo approves everything and is risky.
 * Questions Kimi asks the user (AskUserQuestion) come as elicitation/create forms (offered in initialize; every
 * question, multi-select included) and are answered only with what the user fills in. Should Kimi fall back to its
 * request_permission bridge (`q<n>_*` options), the question is skipped instead of picking an answer. A plan review is
 * an approval card whose answers are Kimi's own.
 * `kimi acp` runs no update check of its own (only the interactive `kimi` does).
 */

export interface KimiDetection {
  command: string | null;
  argsPrefix: string[];
  version: string | null;
  /** Not found / could not run. */
  error: Localized | null;
}

export type KimiAdapterOptions = AcpAdapterOptions;

const NAME = 'kimi';

/** Where Kimi Code's native installer puts the CLI: ~/.kimi-code/bin (KIMI_INSTALL_DIR overrides it). */
function installDirs(env: NodeJS.ProcessEnv): string[] {
  return [...(env.KIMI_INSTALL_DIR ? [env.KIMI_INSTALL_DIR] : []), join(homedir(), '.kimi-code', 'bin')];
}

/** Finds `kimi` (or HT_KIMI_PATH) without touching its credentials. */
export async function detectKimi(env: NodeJS.ProcessEnv = process.env): Promise<KimiDetection> {
  let found: CliLaunch | null;
  if (env.HT_KIMI_PATH) {
    found = cliFromPath(env.HT_KIMI_PATH, env);
    if (!found) {
      return {
        command: null,
        argsPrefix: [],
        version: null,
        error: L('HT_KIMI_PATH 指向的文件不存在或不是可执行文件：{path}', 'The file HT_KIMI_PATH points to does not exist or is not an executable: {path}', { path: env.HT_KIMI_PATH }),
      };
    }
  } else found = findCli(NAME, env, installDirs(env));
  if (!found) return { command: null, argsPrefix: [], version: null, error: L('未找到 kimi（Kimi Code CLI）', 'kimi (Kimi Code CLI) was not found') };
  const base = { command: found.command, argsPrefix: found.argsPrefix };
  const r = await cliVersion(found, env);
  if (r.failure !== null) return { ...base, version: null, error: L('无法运行 kimi：{error}', 'Could not run kimi: {error}', { error: r.failure }) };
  return { ...base, version: r.output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null, error: null };
}

const NOT_LOGGED_IN = /auth_required|not (?:logged|signed) in|authenticat(?:e|ion) (?:is )?required|unauthori[sz]ed|\/login/i;
/** Kimi's answer when the account is signed in but its plan has no Kimi Code access (also an auth_required error). */
const NO_PLAN_ACCESS = /subscription does not have access|upgrade your plan/i;
const QUESTION_OPTION = /^q\d+_(?:opt_\d+|skip)$/;
const PLAN_OPTION = /^plan_(?:approve|opt_\d+)$/;

export class KimiAdapter extends AcpAdapter<KimiAdapterOptions> {
  readonly kind = 'kimi' as const;
  readonly label = 'Kimi';
  readonly backend = 'kimi-acp';
  readonly processName = 'kimi acp';
  readonly notLoggedIn: NoticeText = L(
    'Kimi Code 未登录：请在你自己的终端运行 kimi，输入 /login 登录（或运行 kimi acp --login），然后重试',
    'Kimi Code is not logged in: run kimi in your own terminal and log in with /login (or run kimi acp --login), then try again',
  );
  override readonly ruleFiles = ['AGENTS.md', 'CLAUDE.md'];
  /** Its question tool asks through elicitation/create (a form in the chat) when the client offers it. */
  protected override readonly formElicitation = true;

  get permissionModes(): readonly PermissionMode[] {
    return PERMISSION_MODES.kimi;
  }

  protected billing(): RuntimeBilling {
    return 'subscription';
  }

  /**
   * Kimi's model ids are `<provider>/<model>` from its config: the Kimi Code login (`kimi-code/…`, and the catalog's
   * `kimi-code-plan-*` providers) counts against the membership; any other provider (Moonshot Open Platform,
   * OpenAI, …) is an API key billed per token.
   */
  override modelBilling(model: string | null): RuntimeBilling | null {
    const slash = model?.indexOf('/') ?? -1;
    if (!model || slash <= 0) return null;
    return /^kimi-code(?:-|$)/.test(model.slice(0, slash)) ? 'subscription' : 'metered_api';
  }

  protected availableNote(version: string | null): Localized {
    return L(
      '{version} · Kimi Code 官方 ACP 运行时，使用你在 Kimi Code CLI 中的登录；用 Kimi 账号登录时用量计入你的 Kimi 会员额度（与 Kimi 其他客户端共用，5 小时滚动窗口），如果在 Kimi 中配置的是开放平台 API Key，则按 token 计费。需要确认的请求和要开始执行的计划显示在群聊中，只有你在群内点选才会批准。',
      '{version} · Kimi Code’s official ACP runtime with your Kimi Code CLI login; with a Kimi account login, usage counts against your Kimi membership quota (shared with Kimi’s other clients, rolling 5-hour window); with an Open Platform API key configured in Kimi it is billed per token. Requests that need confirmation and plans it wants to start on appear in the chat and are approved only when you click there.',
      { version: version ?? 'kimi acp' },
    );
  }

  protected defaultArgs(): string[] {
    return ['acp'];
  }

  override isNotLoggedIn(e: unknown): boolean {
    return super.isNotLoggedIn(e) || NOT_LOGGED_IN.test(String((e as Error)?.message ?? ''));
  }

  override knownError(e: unknown): NoticeText | null {
    const message = String((e as Error)?.message ?? '');
    if (!NO_PLAN_ACCESS.test(message)) return null;
    return L(
      'Kimi Code 已登录，但当前 Kimi 会员套餐暂时不能使用 Kimi Code。请在 kimi.com/code 查看或升级会员后重试。Kimi 的原始信息：{error}',
      'Kimi Code is logged in, but your current Kimi membership plan has no Kimi Code access right now. Check or upgrade the plan at kimi.com/code, then try again. Kimi said: {error}',
      { error: message },
    );
  }

  /**
   * Kimi ends a turn whose model request failed (model not found, rate limit, provider error) with `end_turn` and no
   * error over ACP (acp-server `turnEndReasonToStopReason`; only auth errors and content filtering get through). The
   * reason is in the session's own turn record, where Kimi documents it (`$KIMI_CODE_HOME/sessions/…`): only the
   * lines written during this prompt are read, never credentials or config.
   */
  override silentFailureCheck(sessionId: string): (() => Promise<NoticeText | null>) | null {
    const home = kimiHome(this.childEnv());
    let file = kimiWirePath(home, sessionId);
    const start = file ? fileSize(file) : 0;
    return async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        file ??= kimiWirePath(home, sessionId);
        const end = file ? readTurnEnd(file, start) : null;
        if (end) return end.reason === 'failed' ? this.failedTurnNotice(end.error) : null;
        await new Promise((r) => setTimeout(r, 200));
      }
      return null;
    };
  }

  private failedTurnNotice(error: KimiTurnError): NoticeText {
    const message = redactText(
      error.message.replace(/\s*<ak-[^>]*>/g, '').replace(/\borg-[0-9a-z]{8,}\b/gi, 'org-…'),
    );
    if (error.code === 'provider.rate_limit' || error.status === 429) {
      return L(
        'Kimi 的模型供应商限速，本回合没有完成（Kimi 已自动重试过）。请稍后再发。Kimi 的原始信息：{error}',
        'Kimi’s model provider rate-limited the request, so this turn did not finish (Kimi already retried). Send it again a little later. Kimi said: {error}',
        { error: message },
      );
    }
    if (error.status === 404) {
      return L(
        'Kimi 所选模型不可用：供应商找不到这个模型，或你的账号没有它的权限。请在成员设置里换一个模型。Kimi 的原始信息：{error}',
        'The model chosen for Kimi is not available: the provider cannot find it, or your account has no access to it. Choose another model in the member’s settings. Kimi said: {error}',
        { error: message },
      );
    }
    return L('Kimi 的模型请求失败，本回合没有完成。Kimi 的原始信息：{error}', 'Kimi’s model request failed, so this turn did not finish. Kimi said: {error}', {
      error: message,
    });
  }

  override permissionRequest(p: any): ExtensionReply | null {
    const options: any[] = Array.isArray(p?.options) ? p.options : [];
    const ids = options.map((o) => String(o?.optionId ?? ''));
    const text = contentText(p?.toolCall);
    const question = ids.find((id) => /^q\d+_skip$/.test(id));
    if (question && ids.every((id) => QUESTION_OPTION.test(id))) {
      const answers = options.filter((o) => String(o?.optionId) !== question).map((o) => `  - ${String(o?.name ?? o?.optionId)}`);
      return {
        kind: 'answer',
        result: { outcome: { outcome: 'selected', optionId: question } },
        activity: {
          title: this.t('{name} 提问（已跳过，请在回复中提问）', '{name} question (skipped; asked to ask in its reply)'),
          detail: [text, ...answers].filter(Boolean).join('\n') || null,
        },
      };
    }
    const approve = ids.find((id) => PLAN_OPTION.test(id));
    if (approve && ids.includes('plan_revise')) {
      const approach = approve === 'plan_approve' ? null : String(options.find((o) => String(o?.optionId) === approve)?.name ?? approve);
      return {
        kind: 'approval',
        title: approach ? this.t('请求按计划开始（方案：{plan}）', 'Wants to start on the plan (approach: {plan})', { plan: approach }) : this.t('请求按计划开始', 'Wants to start on the plan'),
        detail: text,
        allowName: approve,
        rejectName: 'plan_revise',
        answer: (d) =>
          d === 'allow'
            ? { outcome: { outcome: 'selected', optionId: approve } }
            : d === 'reject'
              ? { outcome: { outcome: 'selected', optionId: 'plan_revise' } }
              : { outcome: { outcome: 'cancelled' } },
      };
    }
    return null;
  }
}

/** The text of a tool call's content blocks (what Kimi shows with a question or a plan). */
function contentText(call: any): string | null {
  const blocks: any[] = Array.isArray(call?.content) ? call.content : [];
  const parts = blocks
    .map((b) => (b?.type === 'content' && b.content?.type === 'text' ? String(b.content.text ?? '').trim() : ''))
    .filter(Boolean);
  return parts.length ? parts.join('\n\n') : null;
}

/** Kimi's data root, as Kimi documents it: KIMI_CODE_HOME, else ~/.kimi-code. */
export function kimiHome(env: NodeJS.ProcessEnv): string {
  return env.KIMI_CODE_HOME || join(homedir(), '.kimi-code');
}

/** A session's own turn record: `<home>/sessions/<workspace>/<sessionId>/agents/main/wire.jsonl`; null = not found. */
export function kimiWirePath(home: string, sessionId: string): string | null {
  if (!/^[\w-]+$/.test(sessionId)) return null;
  const root = join(home, 'sessions');
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return null;
  }
  for (const d of dirs) {
    if (d.startsWith('.')) continue;
    const p = join(root, d, sessionId, 'agents', 'main', 'wire.jsonl');
    if (existsSync(p)) return p;
  }
  return null;
}

function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

export interface KimiTurnError {
  code: string | null;
  message: string;
  status: number | null;
}

/** The main agent's last `turn.ended` written after `start` (at most the last 1 MB of it); null = none yet. */
export function readTurnEnd(file: string, start: number): { reason: string; error: KimiTurnError } | null {
  const size = fileSize(file);
  const from = Math.max(start, size - 1024 * 1024);
  if (size <= from) return null;
  const buf = Buffer.alloc(size - from);
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    readSync(fd, buf, 0, buf.length, from);
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
  let last: any = null;
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line.includes('"turn.ended"')) continue;
    try {
      const r = JSON.parse(line);
      if (r?.type === 'turn.ended' && (r.agentId ?? 'main') === 'main') last = r;
    } catch {
      // A line cut by the 1 MB window, or one still being written.
    }
  }
  if (!last) return null;
  const e = last.error ?? {};
  const status = Number(e.details?.statusCode);
  return {
    reason: String(last.reason ?? ''),
    error: {
      code: typeof e.code === 'string' ? e.code : null,
      message: String(e.message ?? e.code ?? last.reason ?? ''),
      status: Number.isFinite(status) ? status : null,
    },
  };
}
