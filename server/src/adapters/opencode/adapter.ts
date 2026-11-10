import { L, type Localized, type NoticeText } from '../../../../shared/notices.ts';
import type { PermissionMode, RuntimeBilling } from '../../../../shared/protocol.ts';
import { PERMISSION_MODES } from '../../../../shared/protocol.ts';
import { AcpAdapter, type AcpAdapterOptions } from '../acp/adapter.ts';
import { type CliLaunch, cliFromPath, cliVersion, findCli } from '../cli-path.ts';

/**
 * OpenCode through its official, unmodified ACP server (`opencode acp`, package @opencode/cli), spoken as ACP v1 over
 * stdio.
 *
 * Harness Team never reads, stores or forwards OpenCode's credentials: OpenCode resolves its providers itself (its own
 * `opencode auth login`, provider environment variables, Google ADC for Vertex). The runtime gets the user's
 * environment as a terminal has it. Billing depends on the provider of the chosen model (OpenCode's hosted free models
 * cost nothing; Vertex and other API providers bill per token), so members are shown as metered.
 * A member's permission mode is OpenCode's own session mode (Build / Plan), set before the turn like the model; for
 * "follow my settings" nothing is sent and OpenCode's own permission rules apply as they are (user's choice,
 * 2026-11-08).
 */

export interface OpenCodeDetection {
  command: string | null;
  argsPrefix: string[];
  version: string | null;
  /** Not found / could not run. */
  error: Localized | null;
}

export type OpenCodeAdapterOptions = AcpAdapterOptions;

/** Finds `opencode` (or HT_OPENCODE_PATH) without touching its credentials. */
export async function detectOpenCode(env: NodeJS.ProcessEnv = process.env): Promise<OpenCodeDetection> {
  let found: CliLaunch | null;
  if (env.HT_OPENCODE_PATH) {
    found = cliFromPath(env.HT_OPENCODE_PATH, env);
    if (!found) {
      return {
        command: null,
        argsPrefix: [],
        version: null,
        error: L('HT_OPENCODE_PATH 指向的文件不存在或不是可执行文件：{path}', 'The file HT_OPENCODE_PATH points to does not exist or is not an executable: {path}', { path: env.HT_OPENCODE_PATH }),
      };
    }
  } else found = findCli('opencode', env);
  if (!found) return { command: null, argsPrefix: [], version: null, error: L('未找到 opencode', 'opencode was not found') };
  const base = { command: found.command, argsPrefix: found.argsPrefix };
  // The version check must not update OpenCode on its own (the ACP process is started the same way, see childEnv).
  const r = await cliVersion(found, { ...env, OPENCODE_DISABLE_AUTOUPDATE: '1' });
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
  if (r.failure !== null) return { ...base, version: null, error: L('无法运行 opencode：{error}', 'Could not run opencode: {error}', { error: strip(r.failure) }) };
  // `opencode --version` colours its output even when it is not a terminal ("\x1b[1mopencode\x1b[0m v2.2.6").
  return { ...base, version: strip(r.output).split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null, error: null };
}

export class OpenCodeAdapter extends AcpAdapter<OpenCodeAdapterOptions> {
  readonly kind = 'opencode' as const;
  readonly label = 'OpenCode';
  readonly backend = 'opencode-acp';
  readonly processName = 'opencode acp';
  readonly notLoggedIn: NoticeText = L(
    'OpenCode 没有所选模型的可用凭据：请在你自己的终端运行 opencode auth login（Vertex 需要 gcloud 的 ADC 登录和 GOOGLE_CLOUD_PROJECT），然后重试',
    'OpenCode has no usable credentials for the chosen model: run opencode auth login in your own terminal (Vertex needs gcloud ADC and GOOGLE_CLOUD_PROJECT), then try again',
  );
  override readonly ruleFiles = ['AGENTS.md', 'CLAUDE.md'];

  get permissionModes(): readonly PermissionMode[] {
    return PERMISSION_MODES.opencode;
  }

  protected billing(): RuntimeBilling {
    return 'metered_api';
  }

  protected availableNote(version: string | null): Localized {
    return L(
      '{version} · OpenCode 官方 ACP 运行时，和在终端里一样使用你在 OpenCode 中配置的模型提供方和环境变量；按所选模型的提供方计费（OpenCode 托管的免费模型不收费）。需要确认的请求显示在群聊中，只有你在群内点选才会批准。',
      '{version} · OpenCode’s official ACP runtime with the model providers you configured in OpenCode and your environment, as in your terminal; billed by the chosen model’s provider (OpenCode’s hosted free models cost nothing). Requests that need confirmation appear in the chat and are approved only when you click there.',
      { version: version ?? 'opencode acp' },
    );
  }

  protected defaultArgs(): string[] {
    return ['acp'];
  }

  /** A process Harness Team starts must not upgrade the user's global OpenCode install on its own. */
  override childEnv(): NodeJS.ProcessEnv {
    return { ...super.childEnv(), OPENCODE_DISABLE_AUTOUPDATE: '1' };
  }
}
