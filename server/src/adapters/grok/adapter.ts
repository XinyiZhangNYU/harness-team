import { homedir } from 'node:os';
import { join } from 'node:path';
import { L, type Localized, type NoticeText } from '../../../../shared/notices.ts';
import type { PermissionMode, RuntimeBilling } from '../../../../shared/protocol.ts';
import type { EffectivePermission } from '../types.ts';
import { PERMISSION_MODES } from '../../../../shared/protocol.ts';
import { AcpAdapter, type AcpAdapterOptions } from '../acp/adapter.ts';
import { type CliLaunch, cliFromPath, cliVersion, findCli } from '../cli-path.ts';

/**
 * Grok Build through its official, unmodified ACP server (`grok agent stdio`), spoken as ACP v1 over stdio
 * (~/.grok/docs/user-guide/15-agent-mode.md).
 *
 * Harness Team never reads, stores or forwards Grok's credentials and never calls `authenticate`: the user signs in
 * with `grok login` in their own terminal, and the runtime gets the user's environment as a terminal has it. Usage
 * counts against the user's Grok plan (free tier or SuperGrok). Grok falls back to XAI_API_KEY (billed per token by
 * the xAI API) only when no signed-in session is stored; the note says so.
 * It is started without `--always-approve` and without `_meta.yoloMode`, so tools that need approval ask through
 * session/request_permission. `grok agent stdio` reports no session modes and ignores plan mode, so a member follows
 * Grok's own permission setting (Ask unless the user changed it in Grok).
 * A process Harness Team starts does not update the user's Grok install on its own (GROK_DISABLE_AUTOUPDATER).
 */

export interface GrokDetection {
  command: string | null;
  argsPrefix: string[];
  version: string | null;
  /** Not found / could not run. */
  error: Localized | null;
}

export type GrokAdapterOptions = AcpAdapterOptions;

const NAME = 'grok';

/** Where Grok's installer puts the CLI on every platform: ~/.grok/bin. */
function installDirs(): string[] {
  return [join(homedir(), '.grok', 'bin')];
}

/** Finds `grok` (or HT_GROK_PATH) without touching its credentials. */
export async function detectGrok(env: NodeJS.ProcessEnv = process.env): Promise<GrokDetection> {
  let found: CliLaunch | null;
  if (env.HT_GROK_PATH) {
    found = cliFromPath(env.HT_GROK_PATH, env);
    if (!found) {
      return {
        command: null,
        argsPrefix: [],
        version: null,
        error: L('HT_GROK_PATH 指向的文件不存在或不是可执行文件：{path}', 'The file HT_GROK_PATH points to does not exist or is not an executable: {path}', { path: env.HT_GROK_PATH }),
      };
    }
  } else found = findCli(NAME, env, installDirs());
  if (!found) return { command: null, argsPrefix: [], version: null, error: L('未找到 grok（Grok Build CLI）', 'grok (Grok Build CLI) was not found') };
  const base = { command: found.command, argsPrefix: found.argsPrefix };
  const r = await cliVersion(found, { ...env, GROK_DISABLE_AUTOUPDATER: '1' });
  if (r.failure !== null) return { ...base, version: null, error: L('无法运行 grok：{error}', 'Could not run grok: {error}', { error: r.failure }) };
  // "grok 1.0.77 (50ca579fa996) [stable]"
  return { ...base, version: r.output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null, error: null };
}

const NOT_LOGGED_IN = /not (?:logged|signed) in|authenticat(?:e|ion) (?:is )?required|unauthori[sz]ed|grok login/i;

export class GrokAdapter extends AcpAdapter<GrokAdapterOptions> {
  readonly kind = 'grok' as const;
  readonly label = 'Grok';
  readonly backend = 'grok-acp';
  readonly processName = 'grok agent stdio';
  readonly notLoggedIn: NoticeText = L(
    'Grok 未登录：请在你自己的终端运行 grok login，然后重试',
    'Grok is not signed in: run grok login in your own terminal, then try again',
  );
  override readonly ruleFiles = ['AGENTS.md', 'CLAUDE.md'];

  get permissionModes(): readonly PermissionMode[] {
    return PERMISSION_MODES.grok;
  }

  /** Grok falls back to XAI_API_KEY (billed as xAI API usage) when its login is missing or expired. */
  protected billing(): RuntimeBilling {
    return (this.opts.baseEnv ?? process.env).XAI_API_KEY?.trim() ? 'metered_api' : 'subscription';
  }

  protected availableNote(version: string | null): Localized {
    return L(
      '{version} · Grok Build 官方 ACP 运行时，使用你在 Grok CLI 中的登录；用量计入你的 Grok 套餐（免费额度或 SuperGrok）。如果没有登录、只设置了 XAI_API_KEY，Grok 会改用 API Key，按 xAI API 用量计费。需要确认的请求显示在群聊中，只有你在群内点选才会批准。',
      '{version} · Grok Build’s official ACP runtime with your Grok CLI login; usage counts against your Grok plan (free tier or SuperGrok). Without a login and with XAI_API_KEY set, Grok uses the API key instead, billed as xAI API usage. Requests that need confirmation appear in the chat and are approved only when you click there.',
      { version: version ?? 'grok agent stdio' },
    );
  }

  protected defaultArgs(): string[] {
    // --no-leader: this member's own agent process, not a shared leader that other Grok windows also use.
    return ['agent', '--no-leader', 'stdio'];
  }

  /** A process Harness Team starts must not upgrade the user's Grok install on its own. */
  override childEnv(): NodeJS.ProcessEnv {
    return { ...super.childEnv(), GROK_DISABLE_AUTOUPDATER: '1' };
  }

  /** `grok agent stdio` reports no session mode: Grok's own permission setting applies. */
  override defaultPermission(): EffectivePermission | null {
    return {
      native: 'Grok',
      mode: null,
      source: this.t('{name} 自己的权限设置（默认 Ask：编辑文件和执行命令前请求审批）', '{name}’s own permission setting (Ask by default: it asks before editing files and running commands)'),
      mismatch: null,
      risky: null,
    };
  }

  override isNotLoggedIn(e: unknown): boolean {
    return super.isNotLoggedIn(e) || NOT_LOGGED_IN.test(String((e as Error)?.message ?? ''));
  }
}
