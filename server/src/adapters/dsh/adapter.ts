import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { L, type Localized, type NoticeText } from '../../../../shared/notices.ts';
import type { PermissionMode, RuntimeBilling } from '../../../../shared/protocol.ts';
import { PERMISSION_MODES, RISKY_PERMISSION_MODES } from '../../../../shared/protocol.ts';
import { AcpAdapter, type AcpAdapterOptions } from '../acp/adapter.ts';
import type { EffectivePermission } from '../types.ts';
import { type CliLaunch, cliFromPath, cliVersion, findCli } from '../cli-path.ts';
import { scanPatch } from './patch-scan.ts';

/**
 * DeepSeek Harness through DeepSeek's official, unmodified ACP server (`dsh --profile acp`, package @deepseek-ai/dsh),
 * spoken as ACP v1 over stdio.
 *
 * Harness Team never reads, stores or forwards the DeepSeek key: dsh resolves it itself (its credentials file under
 * DSH_HOME, then DEEPSEEK_API_KEY in the environment, then .env files). The runtime gets the user's environment as a
 * terminal has it. Every request is billed per token to the user's DeepSeek account, so members are shown as metered.
 * dsh's ACP server has no session modes: the member's permission mode is dsh's own permission preset, which it reads
 * from DSH_PERMISSION_MODE when that member's process starts (nothing is set for "follow my settings").
 */

export interface DshDetection {
  command: string | null;
  argsPrefix: string[];
  version: string | null;
  /** Not found / could not run. */
  error: Localized | null;
}

export type DshAdapterOptions = AcpAdapterOptions;

/** The member's permission mode → dsh's preset name (DSH_PERMISSION_MODE). */
const PRESET: Partial<Record<PermissionMode, string>> = {
  'read-only': 'read-only',
  'workspace-write': 'workspace-write',
  'full-access': 'danger-full-access',
};
/** dsh's preset when DSH_PERMISSION_MODE is not set. */
const DEFAULT_PRESET = 'workspace-write';
const FROM_PRESET: Record<string, PermissionMode> = { 'read-only': 'read-only', 'workspace-write': 'workspace-write', 'danger-full-access': 'full-access' };
/**
 * dsh applies the user's patch layers ($DSH_HOME/profiles/acp/cordis.patch.yml, then $DSH_HOME/cordis.patch.yml) after
 * its own bundles, so a patch on the entries that read DSH_PERMISSION_MODE overrides it (dsh 0.2.2-rc.1, dsh-base).
 */
/**
 * The user's dsh patch files that change the permission entries (an `id` naming one, see scanPatch), those that
 * exist but could not be read, and those written in YAML Harness Team cannot check. Read only for that; nothing else
 * is used.
 */
export function dshPermissionPatches(env: NodeJS.ProcessEnv = process.env): { patched: string[]; unreadable: string[]; unverifiable: string[] } {
  const home = env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  const out = { patched: [] as string[], unreadable: [] as string[], unverifiable: [] as string[] };
  for (const f of [join(home, 'profiles', 'acp', 'cordis.patch.yml'), join(home, 'cordis.patch.yml')]) {
    let text: string;
    try {
      text = readFileSync(f, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') out.unreadable.push(f);
      continue;
    }
    const scan = scanPatch(text);
    if (scan === 'permission') out.patched.push(f);
    else if (scan === 'unknown') out.unverifiable.push(f);
  }
  return out;
}

/** Finds `dsh` (or HT_DSH_PATH) without touching its credentials. */
export async function detectDsh(env: NodeJS.ProcessEnv = process.env): Promise<DshDetection> {
  let found: CliLaunch | null;
  if (env.HT_DSH_PATH) {
    found = cliFromPath(env.HT_DSH_PATH, env);
    if (!found) {
      return {
        command: null,
        argsPrefix: [],
        version: null,
        error: L('HT_DSH_PATH 指向的文件不存在或不是可执行文件：{path}', 'The file HT_DSH_PATH points to does not exist or is not an executable: {path}', { path: env.HT_DSH_PATH }),
      };
    }
  } else found = findCli('dsh', env);
  if (!found) return { command: null, argsPrefix: [], version: null, error: L('未找到 dsh', 'dsh was not found') };
  const base = { command: found.command, argsPrefix: found.argsPrefix };
  const r = await cliVersion(found, env);
  if (r.failure !== null) return { ...base, version: null, error: L('无法运行 dsh：{error}', 'Could not run dsh: {error}', { error: r.failure }) };
  return { ...base, version: r.output.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null, error: null };
}

/**
 * dsh's answer when no DeepSeek key is configured or the stored one is malformed, and DeepSeek's own answer to a key it
 * rejects ("Authentication Fails, Your api key: ****0000 is invalid", seen through dsh 0.2.2-rc.1).
 */
const NO_KEY = /no API key for provider route|MISSING_CREDENTIAL|INVALID_CREDENTIAL|Authentication Fails|api key: \S+ is invalid/i;

export class DshAdapter extends AcpAdapter<DshAdapterOptions> {
  readonly kind = 'dsh' as const;
  readonly label = 'DeepSeek Harness';
  readonly backend = 'dsh-acp';
  readonly processName = 'dsh --profile acp';
  readonly notLoggedIn: NoticeText = L(
    'DeepSeek Harness 的 DeepSeek API Key 未设置或无效：请在你自己的终端运行 dsh web，在 Models 页面保存有效的 Key（或设置 DEEPSEEK_API_KEY），然后重试',
    'DeepSeek Harness has no valid DeepSeek API key (not set, or rejected): run dsh web in your own terminal and save a valid key on its Models page (or set DEEPSEEK_API_KEY), then try again',
  );
  override readonly ruleFiles = ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md'];

  get permissionModes(): readonly PermissionMode[] {
    return PERMISSION_MODES.dsh;
  }

  protected billing(): RuntimeBilling {
    return 'metered_api';
  }

  protected availableNote(version: string | null): Localized {
    return L(
      '{version} · DeepSeek 官方 ACP 运行时，和在终端里一样使用你在 dsh 中保存的 Key 和环境变量；按 token 计费。需要确认的请求显示在群聊中，只有你在群内点选才会批准。',
      '{version} · DeepSeek’s official ACP runtime with the key you saved in dsh and your environment, as in your terminal; billed per token. Requests that need confirmation appear in the chat and are approved only when you click there.',
      { version: version ?? 'dsh --profile acp' },
    );
  }

  protected defaultArgs(): string[] {
    return ['--profile', 'acp'];
  }

  override isProcessMode(mode: PermissionMode | null | undefined): mode is PermissionMode {
    return !!mode && mode in PRESET;
  }

  protected override processLaunch(mode: PermissionMode): { args: string[]; env?: Record<string, string> } {
    return { args: [], env: { DSH_PERMISSION_MODE: PRESET[mode]! } };
  }

  override processModeProblem(mode: PermissionMode): Localized | null {
    return mode in PRESET ? null : this.t('{name} 没有这个权限模式', '{name} has no such permission mode');
  }

  override processModeLabel(mode: PermissionMode): string {
    return `DSH_PERMISSION_MODE=${PRESET[mode] ?? mode}`;
  }

  override processPermission(mode: PermissionMode, _native: string | null): EffectivePermission {
    return this.presetPermission(PRESET[mode] ?? mode, this.t('{name} 进程环境变量 DSH_PERMISSION_MODE', '{name} process environment DSH_PERMISSION_MODE'));
  }

  /** "Follow my settings": DSH_PERMISSION_MODE from the user's environment, else dsh's default preset. */
  override defaultPermission(): EffectivePermission | null {
    const set = (this.opts.baseEnv ?? process.env).DSH_PERMISSION_MODE?.trim();
    return set
      ? this.presetPermission(set, this.t('你环境中的 DSH_PERMISSION_MODE', 'DSH_PERMISSION_MODE in your environment'))
      : this.presetPermission(DEFAULT_PRESET, this.t('{name} 默认（未设置 DSH_PERMISSION_MODE；dsh 自己的配置文件可能另有设置）', '{name} default (DSH_PERMISSION_MODE is not set; dsh’s own profile files may set otherwise)'));
  }

  private presetPermission(preset: string, source: Localized): EffectivePermission {
    const mode = FROM_PRESET[preset] ?? null;
    const patches = dshPermissionPatches(this.opts.baseEnv ?? process.env);
    return {
      native: preset,
      mode,
      source,
      mismatch: patches.patched.length
        ? this.t('你的 dsh 配置补丁（{files}）改了权限相关设置，会覆盖 DSH_PERMISSION_MODE；实际权限以 dsh 为准', 'Your dsh patch file ({files}) changes the permission settings, which overrides DSH_PERMISSION_MODE; dsh decides the actual permissions', { files: patches.patched.join(', ') })
        : patches.unreadable.length
          ? this.t('无法读取你的 dsh 配置补丁（{files}），无法核对它是否改了权限设置；实际权限以 dsh 为准', 'Your dsh patch file ({files}) could not be read, so whether it changes the permission settings cannot be checked; dsh decides the actual permissions', { files: patches.unreadable.join(', ') })
          : patches.unverifiable.length
            ? this.t('你的 dsh 配置补丁（{files}）用了 Harness Team 无法核对的 YAML 写法（如锚点、转义或多行值），无法确认它是否改了权限设置；实际权限以 dsh 为准', 'Your dsh patch file ({files}) uses YAML Harness Team cannot check (such as anchors, escapes or values over several lines), so whether it changes the permission settings cannot be confirmed; dsh decides the actual permissions', { files: patches.unverifiable.join(', ') })
            : null,
      risky:
        mode && RISKY_PERMISSION_MODES.includes(mode)
          ? this.t('{name} 以 {preset} 运行：没有沙箱，工具调用不会请求审批。', '{name} runs with {preset}: no sandbox, and tool calls do not ask for approval.', { preset })
          : null,
    };
  }

  override isNotLoggedIn(e: unknown): boolean {
    return super.isNotLoggedIn(e) || NO_KEY.test((e as Error)?.message ?? '');
  }
}
