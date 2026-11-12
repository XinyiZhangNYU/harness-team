import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { L, type Localized, type NoticeText } from '../../../../shared/notices.ts';
import type { PermissionMode, RuntimeBilling } from '../../../../shared/protocol.ts';
import { PERMISSION_MODES } from '../../../../shared/protocol.ts';
import { AcpAdapter, type AcpAdapterOptions } from '../acp/adapter.ts';
import { type CliLaunch, cliFromPath, findCli } from '../cli-path.ts';

/**
 * Antigravity through Google's official, unmodified ACP runtime (`agy acp`, or the Registry binary `antigravity-acp`
 * set with HT_ANTIGRAVITY_PATH), spoken as ACP v1 over stdio (agentclientprotocol.com).
 *
 * Harness Team never reads, stores or forwards Google credentials: it does not call `authenticate` and does not read
 * anything under ~/.gemini. The runtime gets the user's environment as a terminal has it; API-key / Vertex variables
 * there are shown as per-token billing on the member. A runtime that is not logged in answers "Authentication
 * required" and the user logs in with `agy` in a terminal.
 * Permission requests are answered only with the user's choice in the chat (allow once / reject once), never
 * "always". A member's permission mode is the runtime's own session mode, set before the turn like the model (nothing
 * is sent for "follow my settings"). Only a member whose mode is skip-permissions (chosen by the user after the risk
 * warning, never a default) gets its own `agy acp` process started with --dangerously-skip-permissions.
 * Questions the model asks the user come as elicitation/create forms (offered in initialize) and are answered only
 * with what the user fills in.
 */

/** How the runtime is started: `agy acp` (the CLI) or the Registry ACP binary itself. */
export type AntigravityFlavor = 'agy' | 'registry';

export interface AntigravityDetection {
  command: string | null;
  argsPrefix: string[];
  flavor: AntigravityFlavor;
  version: string | null;
  /** `agy acp --help` lists --dangerously-skip-permissions (null: not checked). */
  skipPermissionsFlag?: boolean | null;
  /** Not found / could not run. */
  error: Localized | null;
}

export interface AntigravityAdapterOptions extends AcpAdapterOptions {
  /** Default `args`: `acp` for agy, none for the Registry binary. */
  flavor?: AntigravityFlavor;
  /** `agy acp --help` lists --dangerously-skip-permissions (detection). null/undefined: not known. */
  skipPermissionsFlag?: boolean | null;
  /** Per-token when an API-key / Vertex / ADC variable is set for the runtime, else the Google account's plan. */
  billing?: RuntimeBilling | null;
}

/** Variables with which the runtime may bill per token instead of the Google account (API key / Vertex / ADC). */
const METERED_VARS = new Set(['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'AGY_ADC_AUTH']);

/** Names (never values) of the per-token variables set in `env`. */
export function antigravityMeteredEnvNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env)
    .filter((k) => METERED_VARS.has(k.toUpperCase()) && !!env[k] && !/^(0|false)$/i.test(env[k]!.trim()))
    .sort();
}

export function antigravityBilling(env: NodeJS.ProcessEnv = process.env): RuntimeBilling {
  return antigravityMeteredEnvNames(env).length ? 'metered_api' : 'subscription';
}

const isAgy = (file: string) => /^agy(\.exe|\.cmd|\.bat|\.ps1)?$/i.test(basename(file));

/** Finds `agy` (or HT_ANTIGRAVITY_PATH) without logging in or touching its credentials. */
export async function detectAntigravity(env: NodeJS.ProcessEnv = process.env): Promise<AntigravityDetection> {
  let found: CliLaunch | null;
  if (env.HT_ANTIGRAVITY_PATH) {
    found = cliFromPath(env.HT_ANTIGRAVITY_PATH, env);
    if (!found) {
      return {
        command: null,
        argsPrefix: [],
        flavor: 'agy',
        version: null,
        error: L('HT_ANTIGRAVITY_PATH 指向的文件不存在或不是可执行文件：{path}', 'The file HT_ANTIGRAVITY_PATH points to does not exist or is not an executable: {path}', {
          path: env.HT_ANTIGRAVITY_PATH,
        }),
      };
    }
  } else found = findCli('agy', env);
  if (!found) return { command: null, argsPrefix: [], flavor: 'agy', version: null, error: L('未找到 agy', 'agy was not found') };
  const flavor: AntigravityFlavor = isAgy(found.path) ? 'agy' : 'registry';
  const base = { command: found.command, argsPrefix: found.argsPrefix, flavor };
  // The Registry binary only speaks ACP (its version comes with `initialize`).
  if (flavor === 'registry') return { ...base, version: null, error: null };
  // Whether this agy's ACP server has --dangerously-skip-permissions (the skip-permissions mode), from its own help.
  const skipPermissionsFlag = await run(found.command, [...found.argsPrefix, 'acp', '--help'], env)
    .catch((e) => String((e as { output?: string }).output ?? ''))
    .then((help) => (help ? /--dangerously-skip-permissions\b/.test(help) : null));
  try {
    const out = await run(found.command, [...found.argsPrefix, '--version'], env);
    return { ...base, skipPermissionsFlag, version: out.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null, error: null };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EACCES') {
      return { ...base, version: null, error: L('无法运行 agy：{error}', 'Could not run agy: {error}', { error: (e as Error).message.split('\n')[0] ?? '' }) };
    }
    // Ran but did not print a version: the version is reported by `initialize` instead.
    return { ...base, skipPermissionsFlag, version: null, error: null };
  }
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: 20_000, windowsHide: true, env }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { output: `${stdout}${stderr}` }));
      else resolve(`${stdout}${stderr}`);
    });
    child.stdin?.end();
  });
}

const SKIP_FLAG = '--dangerously-skip-permissions';

export class AntigravityAdapter extends AcpAdapter<AntigravityAdapterOptions> {
  readonly kind = 'antigravity' as const;
  readonly label = 'Antigravity';
  readonly backend = 'antigravity-acp';
  readonly processName = 'agy acp';
  readonly notLoggedIn: NoticeText = L(
    'Antigravity 未登录：请在你自己的终端运行 agy 并登录 Google 账户，然后重试',
    'Antigravity is not logged in: run agy in your own terminal and sign in to your Google account, then try again',
  );
  override readonly ruleFiles = ['AGENTS.md', 'GEMINI.md'];
  override readonly skipPermissionsFlag = SKIP_FLAG;
  /** Its question tool asks through elicitation/create (a form in the chat) when the client offers it. */
  protected override readonly formElicitation = true;

  get permissionModes(): readonly PermissionMode[] {
    return PERMISSION_MODES.antigravity;
  }

  protected billing(): RuntimeBilling {
    return antigravityBilling(this.opts.baseEnv ?? process.env);
  }

  protected availableNote(version: string | null): Localized {
    const metered = antigravityMeteredEnvNames(this.opts.baseEnv ?? process.env);
    return L(
      '{version} · 官方 ACP 运行时，和在终端里一样使用你在 agy 中的登录和环境变量{metered}。需要确认的请求显示在群聊中，只有你在群内点选才会批准。',
      '{version} · official ACP runtime with your own agy login and environment, as in your terminal{metered}. Requests that need confirmation appear in the chat and are approved only when you click there.',
      {
        version: version ?? 'agy acp',
        metered: metered.length ? L('；{names} 已设置，可能按 token 计费', '; {names} is set, so it may be billed per token', { names: metered.join(', ') }) : null,
      },
    );
  }

  protected defaultArgs(): string[] {
    return (this.opts.flavor ?? 'agy') === 'agy' ? ['acp'] : [];
  }

  /** HTTP MCP needs a worker per session with `agy acp` (--process-per-session). */
  protected override extraArgs(withHttpMcp: boolean): string[] {
    return withHttpMcp && (this.opts.flavor ?? 'agy') === 'agy' && !this.opts.args ? ['--process-per-session'] : [];
  }

  override skipPermissionsProblem(): Localized | null {
    if ((this.opts.flavor ?? 'agy') !== 'agy') {
      return L('只有 agy 命令行的 ACP 服务器（agy acp）有 --dangerously-skip-permissions', 'Only the ACP server of the agy CLI (agy acp) has --dangerously-skip-permissions');
    }
    if (this.opts.skipPermissionsFlag === false) {
      return L('这个版本的 agy acp 没有 --dangerously-skip-permissions（agy acp --help 未列出）', 'This version of agy acp has no --dangerously-skip-permissions (agy acp --help does not list it)');
    }
    return null;
  }
}
