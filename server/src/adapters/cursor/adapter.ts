import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { L, type Localized, type NoticeText } from '../../../../shared/notices.ts';
import type { PermissionMode, RuntimeBilling } from '../../../../shared/protocol.ts';
import { PERMISSION_MODES } from '../../../../shared/protocol.ts';
import { AcpAdapter, type AcpAdapterOptions, type ExtensionReply } from '../acp/adapter.ts';
import { cursorQuestion } from '../acp/questions.ts';
import { type CliLaunch, cliFromPath, cliVersion, extraBinDirs, findCli, pathDirs } from '../cli-path.ts';

/**
 * Cursor CLI through its official, unmodified ACP server (`cursor-agent acp`, also installed as `agent`), spoken as
 * ACP v1 over stdio (cursor.com/docs/cli/acp).
 *
 * Harness Team never reads, stores or forwards Cursor's credentials and never calls `authenticate`: the user logs in
 * with `agent login` in their own terminal (or has CURSOR_API_KEY / CURSOR_AUTH_TOKEN in their environment), and the
 * runtime gets the user's environment as a terminal has it. Usage counts against the user's Cursor plan (on-demand
 * usage only if the user enabled it in Cursor).
 * The executable is looked up as `cursor-agent`, not `agent`: that generic name may belong to another program.
 * Cursor's blocking extension requests: `cursor/create_plan` is an approval card in the chat (accepted only on the
 * user's click, otherwise rejected / cancelled); `cursor/ask_question` is a form in the chat, answered only with the
 * options the user picks (refusing is Cursor's "skipped"). A question that cannot be shown is skipped and the model is
 * told to ask in its reply.
 */

export interface CursorDetection {
  command: string | null;
  argsPrefix: string[];
  version: string | null;
  /** Windows install (launcher + versions\): each start runs the newest installed version, as the launcher does. */
  installRoot?: string | null;
  /** Not found / could not run. */
  error: Localized | null;
}

export type CursorAdapterOptions = AcpAdapterOptions & { installRoot?: string | null };

const NAME = 'cursor-agent';

/** Where Cursor's installer puts the CLI: %LOCALAPPDATA%\cursor-agent on Windows, ~/.local/bin elsewhere. */
function installDirs(env: NodeJS.ProcessEnv): string[] {
  return process.platform === 'win32' && env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'cursor-agent')] : [];
}

const VERSION_DIR = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d{2})-(\d{2})-(\d{2}))?-[a-f0-9]+$/;

/**
 * The program Cursor's Windows launcher (cursor-agent.cmd → cursor-agent.ps1) runs: the newest
 * `versions\<YYYY.MM.DD[-HH-MM-SS]-commit>` folder's bundled node.exe with its index.js. Starting it directly avoids
 * a shell and PowerShell for every session; the launcher's own pre-start step only moves an update staged while an
 * agent was running into place, which the next start in a terminal still does.
 */
export function cursorBundledLaunch(root: string): CliLaunch | null {
  let names: string[];
  try {
    names = readdirSync(join(root, 'versions'));
  } catch {
    return null;
  }
  const key = (name: string) => {
    const m = VERSION_DIR.exec(name)!;
    return [m[1], m[2]!.padStart(2, '0'), m[3]!.padStart(2, '0'), m[4] ?? '00', m[5] ?? '00', m[6] ?? '00'].join('');
  };
  const ok = names
    .filter((n) => VERSION_DIR.test(n))
    .filter((n) => existsSync(join(root, 'versions', n, 'node.exe')) && existsSync(join(root, 'versions', n, 'index.js')))
    .sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));
  if (!ok.length) return null;
  const dir = join(root, 'versions', ok[0]!);
  return { command: join(dir, 'node.exe'), argsPrefix: [join(dir, 'index.js')], path: join(root, `${NAME}.cmd`) };
}

/** A Windows launcher of Cursor's installer (cursor-agent.cmd / .ps1 next to a versions folder): its install root. */
function launcherRoot(file: string): string | null {
  const name = basename(file).toLowerCase();
  if (!['cursor-agent.cmd', 'cursor-agent.ps1', 'agent.cmd', 'agent.ps1'].includes(name)) return null;
  const root = dirname(file);
  return existsSync(join(root, 'versions')) ? root : null;
}

/** Finds `cursor-agent` (or HT_CURSOR_PATH) without touching its credentials. */
export async function detectCursor(env: NodeJS.ProcessEnv = process.env): Promise<CursorDetection> {
  let found: CliLaunch | null;
  let installRoot: string | null = null;
  const bundled = (file: string) => {
    const root = process.platform === 'win32' ? launcherRoot(file) : null;
    const launch = root ? cursorBundledLaunch(root) : null;
    if (launch) installRoot = root;
    return launch;
  };
  if (env.HT_CURSOR_PATH) {
    found = bundled(env.HT_CURSOR_PATH) ?? cliFromPath(env.HT_CURSOR_PATH, env);
    if (!found) {
      return {
        command: null,
        argsPrefix: [],
        version: null,
        error: L('HT_CURSOR_PATH 指向的文件不存在或不是可执行文件：{path}', 'The file HT_CURSOR_PATH points to does not exist or is not an executable: {path}', { path: env.HT_CURSOR_PATH }),
      };
    }
  } else found = findCli(NAME, env, installDirs(env));
  if (!found) {
    // Windows: a launcher that only a shell can start (a .cmd that is not an npm shim, a .ps1) is named, not run.
    if (process.platform === 'win32') {
      for (const dir of [...pathDirs(env), ...extraBinDirs(env), ...installDirs(env)]) {
        for (const ext of ['.cmd', '.ps1']) {
          const p = join(dir, `${NAME}${ext}`);
          if (existsSync(p)) {
            found = bundled(p);
            if (found) break;
            return {
              command: null,
              argsPrefix: [],
              version: null,
              error: L('找到了 {path}，但它只能通过 shell 启动；请把 HT_CURSOR_PATH 设为它实际运行的程序', 'Found {path}, but it can only be started through a shell; set HT_CURSOR_PATH to the program it runs', { path: p }),
            };
          }
        }
        if (found) break;
      }
    }
    if (!found) return { command: null, argsPrefix: [], version: null, error: L('未找到 cursor-agent（Cursor CLI）', 'cursor-agent (Cursor CLI) was not found') };
  }
  const base = { command: found.command, argsPrefix: found.argsPrefix, installRoot };
  const r = await cliVersion(found, env);
  if (r.failure !== null) return { ...base, version: null, error: L('无法运行 cursor-agent：{error}', 'Could not run cursor-agent: {error}', { error: r.failure }) };
  return { ...base, version: r.output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null, error: null };
}

const NOT_LOGGED_IN = /not (?:logged in|authenticated)|authenticat(?:e|ion) (?:is )?required|unauthori[sz]ed|cursor_login|agent login/i;

export class CursorAdapter extends AcpAdapter<CursorAdapterOptions> {
  readonly kind = 'cursor' as const;
  readonly label = 'Cursor';
  readonly backend = 'cursor-acp';
  readonly processName = 'cursor-agent acp';
  readonly notLoggedIn: NoticeText = L(
    'Cursor CLI 未登录：请在你自己的终端运行 cursor-agent login（或 agent login），然后重试',
    'The Cursor CLI is not logged in: run cursor-agent login (or agent login) in your own terminal, then try again',
  );
  override readonly ruleFiles = ['AGENTS.md', 'CLAUDE.md'];

  get permissionModes(): readonly PermissionMode[] {
    return PERMISSION_MODES.cursor;
  }

  protected billing(): RuntimeBilling {
    return 'subscription';
  }

  protected availableNote(version: string | null): Localized {
    return L(
      '{version} · Cursor 官方 ACP 运行时，使用你在 Cursor CLI 中的登录；用量计入你的 Cursor 套餐（只有你在 Cursor 中开启了按需用量才会额外收费）。需要确认的请求和要开始执行的计划显示在群聊中，只有你在群内点选才会批准。',
      '{version} · Cursor’s official ACP runtime with your Cursor CLI login; usage counts against your Cursor plan (extra charges only if you enabled on-demand usage in Cursor). Requests that need confirmation and plans it wants to start on appear in the chat and are approved only when you click there.',
      { version: version ?? 'cursor-agent acp' },
    );
  }

  protected defaultArgs(): string[] {
    return ['acp'];
  }

  /** With a Windows install, each start runs the newest installed version (Cursor updates itself in the background). */
  override launch(withHttpMcp: boolean, mode: PermissionMode | null = null) {
    const l = super.launch(withHttpMcp, mode);
    const root = this.opts.installRoot;
    const now = root ? cursorBundledLaunch(root) : null;
    if (!root || !now) return l;
    const prefix = this.opts.argsPrefix ?? [];
    return {
      ...l,
      command: now.command,
      args: [...now.argsPrefix, ...l.args.slice(prefix.length)],
      // What the launcher sets: Cursor names the command in its own messages after it.
      env: { CURSOR_INVOKED_AS: `${NAME}.cmd`, ...(l.env ?? {}) },
    };
  }

  override isNotLoggedIn(e: unknown): boolean {
    return super.isNotLoggedIn(e) || NOT_LOGGED_IN.test(String((e as Error)?.message ?? ''));
  }

  override extensionRequest(method: string, p: any): ExtensionReply | null {
    if (method === 'cursor/create_plan') {
      const name = typeof p?.name === 'string' && p.name.trim() ? p.name.trim() : null;
      return {
        kind: 'approval',
        title: name ? this.t('请求按计划开始：{plan}', 'Wants to start on the plan: {plan}', { plan: name }) : this.t('请求按计划开始', 'Wants to start on the plan'),
        detail: planText(p),
        allowName: 'accepted',
        rejectName: 'rejected',
        answer: (d) =>
          d === 'allow'
            ? { outcome: { outcome: 'accepted' } }
            : d === 'reject'
              ? { outcome: { outcome: 'rejected', reason: 'The user did not accept this plan in the Harness Team chat.' } }
              : { outcome: { outcome: 'cancelled' } },
      };
    }
    if (method === 'cursor/ask_question') {
      const q = cursorQuestion(p);
      if (q) return this.questionReply(q, 'answered', 'skipped');
      return {
        kind: 'answer',
        result: {
          outcome: {
            outcome: 'skipped',
            reason: 'Harness Team cannot show interactive questions. Ask the user in your reply instead and wait for their next message.',
          },
        },
        activity: { title: this.t('{name} 提问（已跳过，请在回复中提问）', '{name} question (skipped; asked to ask in its reply)'), detail: questionText(p) },
      };
    }
    return null;
  }
}

function planText(p: any): string | null {
  const parts: string[] = [];
  if (typeof p?.overview === 'string' && p.overview.trim()) parts.push(p.overview.trim());
  if (typeof p?.plan === 'string' && p.plan.trim()) parts.push(p.plan.trim());
  const todos: any[] = Array.isArray(p?.todos) ? p.todos : [];
  if (todos.length) {
    const mark: Record<string, string> = { completed: '[x]', in_progress: '[~]', cancelled: '[-]' };
    parts.push(todos.map((t) => `${mark[t?.status] ?? '[ ]'} ${String(t?.content ?? '')}`).join('\n'));
  }
  return parts.length ? parts.join('\n\n') : null;
}

function questionText(p: any): string | null {
  const qs: any[] = Array.isArray(p?.questions) ? p.questions : [];
  const lines: string[] = [];
  if (typeof p?.title === 'string' && p.title.trim()) lines.push(p.title.trim());
  for (const q of qs) {
    lines.push(String(q?.prompt ?? ''));
    for (const o of Array.isArray(q?.options) ? q.options : []) lines.push(`  - ${String(o?.label ?? o?.id ?? '')}`);
  }
  return lines.filter(Boolean).join('\n') || null;
}
