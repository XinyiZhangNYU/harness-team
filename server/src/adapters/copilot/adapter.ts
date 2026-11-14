import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { L, type Localized, type NoticeText } from '../../../../shared/notices.ts';
import type { PermissionMode, RuntimeBilling } from '../../../../shared/protocol.ts';
import { PERMISSION_MODES } from '../../../../shared/protocol.ts';
import { AcpAdapter, type AcpAdapterOptions, type ConfigOption, type UnstableModels } from '../acp/adapter.ts';
import { type CliLaunch, cliFromPath, cliVersion, findCli, pathDirs } from '../cli-path.ts';
import { redactText } from '../../redact.ts';
import { BROWSER_MCP_SERVER } from '../../team/envelope.ts';

/**
 * GitHub Copilot CLI through its official ACP server (`copilot --acp --stdio`, public preview), spoken as ACP v1.
 *
 * Harness Team never reads, stores or forwards Copilot's credentials and never calls `authenticate`: the user signs in
 * with `copilot login` in their own terminal (or sets COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN themself), and the
 * runtime gets the user's environment as a terminal has it. Only the names of those variables and whether Copilot's
 * BYOK provider file exists are looked at, never their contents.
 *
 * Billing, per GitHub's documentation (usage-based billing for individuals, from 2026-06-01): every Copilot plan comes
 * with a monthly AI Credits allowance. Copilot Free / Student get a free allowance and automatic model selection only;
 * paid plans (Pro / Pro+ / Max, or a Business / Enterprise seat) get included credits, and further use is billed per
 * use only within an additional-usage budget the user (or their organization) set on GitHub. With BYOK
 * (COPILOT_PROVIDER_BASE_URL, or providers in providers.json) the model runs on the user's own provider and is billed
 * there per token. ACP reports no plan, so the plan is inferred from the model list: only `auto` = Free / Student.
 *
 * Copilot's session modes come as URLs (`https://agentclientprotocol.com/protocol/session-modes#agent`); the member's
 * modes are the part after `#`: agent, plan, autopilot (allow-all until the task is done: risky). Tool approvals come
 * through session/request_permission; "allow always" is never chosen.
 */

export interface CopilotDetection {
  command: string | null;
  argsPrefix: string[];
  version: string | null;
  /** Not found / could not run. */
  error: Localized | null;
}

export type CopilotAdapterOptions = AcpAdapterOptions;

const NAME = 'copilot';
const MODE_URL = 'https://agentclientprotocol.com/protocol/session-modes#';

/** Where the official installers put the CLI: WinGet (%LOCALAPPDATA%\GitHubCopilotCLI), the install script (~/.local/bin). */
function installDirs(env: NodeJS.ProcessEnv): string[] {
  return process.platform === 'win32' ? (env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'GitHubCopilotCLI')] : []) : [join(homedir(), '.local', 'bin')];
}

/** VS Code's `copilot` shim (…\bin\copilot-shim): it only forwards to an installed CLI, and fails without one. */
const isShimDir = (d: string) => /[\\/]copilot-shim[\\/]?$/i.test(d);

/** The flag that keeps a process Harness Team starts from updating the user's Copilot install. */
const NO_UPDATE = { COPILOT_AUTO_UPDATE: 'false' };

/** Finds `copilot` (or HT_COPILOT_PATH) without touching its credentials; the real CLI wins over VS Code's shim. */
export async function detectCopilot(env: NodeJS.ProcessEnv = process.env): Promise<CopilotDetection> {
  let found: CliLaunch | null;
  if (env.HT_COPILOT_PATH) {
    found = cliFromPath(env.HT_COPILOT_PATH, env);
    if (!found) {
      return {
        command: null,
        argsPrefix: [],
        version: null,
        error: L('HT_COPILOT_PATH 指向的文件不存在或不是可执行文件：{path}', 'The file HT_COPILOT_PATH points to does not exist or is not an executable: {path}', { path: env.HT_COPILOT_PATH }),
      };
    }
  } else {
    const path = pathDirs(env).filter((d) => !isShimDir(d)).join(delimiter);
    found = findCli(NAME, { ...env, PATH: path, Path: path }, installDirs(env)) ?? findCli(NAME, env);
  }
  if (!found) return { command: null, argsPrefix: [], version: null, error: L('未找到 copilot（GitHub Copilot CLI）', 'copilot (GitHub Copilot CLI) was not found') };
  const base = { command: found.command, argsPrefix: found.argsPrefix };
  const r = await cliVersion(found, { ...env, ...NO_UPDATE });
  if (r.failure !== null) {
    const shim = isShimDir(found.path.replace(/[\\/][^\\/]+$/, ''));
    return {
      ...base,
      version: null,
      error: shim
        ? L('只找到 VS Code 自带的 copilot 入口，GitHub Copilot CLI 本身没有安装或无法运行：{error}', 'Only VS Code’s copilot shim was found; GitHub Copilot CLI itself is not installed or cannot run: {error}', { error: r.failure })
        : L('无法运行 copilot：{error}', 'Could not run copilot: {error}', { error: r.failure }),
    };
  }
  // "GitHub Copilot CLI 1.0.110."
  const line = r.output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null;
  return { ...base, version: line ? line.replace(/\.$/, '') : null, error: null };
}

/** Copilot's data folder, as documented: COPILOT_HOME, else ~/.copilot. */
export function copilotHome(env: NodeJS.ProcessEnv): string {
  return env.COPILOT_HOME || join(homedir(), '.copilot');
}

/** BYOK through the environment: COPILOT_PROVIDER_BASE_URL (or offline mode, which needs a local provider). */
export function copilotByok(env: NodeJS.ProcessEnv): boolean {
  return !!env.COPILOT_PROVIDER_BASE_URL?.trim() || env.COPILOT_OFFLINE?.trim().toLowerCase() === 'true';
}

/** The GitHub token variable Copilot would use instead of its login, in Copilot's order (the name only). */
export function copilotTokenVar(env: NodeJS.ProcessEnv): string | null {
  return ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'].find((k) => env[k]?.trim()) ?? null;
}

/** The plan as far as the model list tells: only `auto` = Free / Student; other models = a paid plan; none = unknown. */
export function copilotPlan(report: { configOptions: readonly ConfigOption[]; models: UnstableModels | null }): 'free' | 'paid' | null {
  const opt = report.configOptions.find((o) => o.category === 'model');
  const ids = new Set<string>();
  if (opt && Array.isArray(opt.options)) {
    for (const x of opt.options as any[]) {
      if (x && Array.isArray(x.options)) for (const y of x.options) typeof y?.value === 'string' && ids.add(y.value);
      else if (typeof x?.value === 'string') ids.add(x.value);
    }
  } else for (const m of report.models?.availableModels ?? []) if (typeof m?.modelId === 'string') ids.add(m.modelId);
  if (!ids.size) return null;
  return [...ids].every((id) => id === 'auto') ? 'free' : 'paid';
}

const NOT_LOGGED_IN = /not (?:logged|signed) in|authenticat(?:e|ion) (?:is )?required|unauthori[sz]ed|copilot login|no (?:github )?(?:auth|token)/i;
/** Copilot's answer when the plan's AI Credits are used up (wording not seen yet: matched loosely). */
const OUT_OF_CREDITS = /(?:quota|ai credits?|premium requests?|usage limit)[^\n]{0,80}(?:exceeded|exhausted|used up|reached|run out|depleted)|(?:exceeded|reached|hit)[^\n]{0,40}(?:quota|ai credits?|premium requests?|usage limit|budget)/i;

export class CopilotAdapter extends AcpAdapter<CopilotAdapterOptions> {
  readonly kind = 'copilot' as const;
  readonly label = 'GitHub Copilot';
  readonly backend = 'copilot-acp';
  readonly processName = 'copilot --acp';
  readonly notLoggedIn: NoticeText = L(
    'GitHub Copilot 未登录：请在你自己的终端运行 copilot login，然后重试',
    'GitHub Copilot is not signed in: run copilot login in your own terminal, then try again',
  );
  override readonly ruleFiles = ['AGENTS.md', '.github/copilot-instructions.md', 'CLAUDE.md'];

  get permissionModes(): readonly PermissionMode[] {
    return PERMISSION_MODES.copilot;
  }

  private env(): NodeJS.ProcessEnv {
    return this.opts.baseEnv ?? process.env;
  }

  /** BYOK bills the user's own provider per token; otherwise usage counts against the Copilot plan's AI Credits. */
  protected billing(): RuntimeBilling {
    return copilotByok(this.env()) ? 'metered_api' : 'subscription';
  }

  protected availableNote(version: string | null): Localized {
    return L(
      '{version} · GitHub Copilot CLI 官方 ACP 运行时（公开预览），使用你在 Copilot CLI 中的 GitHub 登录。计费分三种：Copilot Free / Student 用每月的免费 AI Credits 额度（只能自动选模型）；付费套餐（Pro / Pro+ / Max 或组织席位）先用套餐包含的 AI Credits，用完后只有你在 GitHub 设置了额外用量预算才会按量付费；自带模型供应商（BYOK，COPILOT_PROVIDER_BASE_URL 或 providers.json）由你的供应商按 token 计费。需要确认的请求显示在群聊中，只有你在群内点选才会批准。',
      '{version} · GitHub Copilot CLI’s official ACP runtime (public preview) with your GitHub login in Copilot CLI. Billing comes in three kinds: Copilot Free / Student use the monthly free AI Credits allowance (automatic model selection only); paid plans (Pro / Pro+ / Max or an organization seat) use the plan’s included AI Credits first, and further use is billed per use only if you set an additional-usage budget on GitHub; your own model provider (BYOK, COPILOT_PROVIDER_BASE_URL or providers.json) bills you per token. Requests that need confirmation appear in the chat and are approved only when you click there.',
      { version: version ?? 'copilot --acp' },
    );
  }

  /**
   * Copilot asks its own permission for each MCP tool and reports only the bare tool name (no server), so a call to
   * Harness Team's browser server would be approved twice. `--allow-tool=<server>` lets Copilot run that server's tools
   * without asking; the server itself asks in the chat (Core.askInTurn). It exists only in sessions given it.
   */
  protected defaultArgs(): string[] {
    return ['--acp', '--stdio', `--allow-tool=${BROWSER_MCP_SERVER}`];
  }

  /** A process Harness Team starts must not update the user's Copilot install or plugins on its own. */
  override childEnv(): NodeJS.ProcessEnv {
    return { ...super.childEnv(), ...NO_UPDATE };
  }

  override memberModeId(native: string): string {
    return native.startsWith(MODE_URL) ? native.slice(MODE_URL.length) : native;
  }

  override nativeModeId(mode: string): string {
    return /^[a-z]+$/.test(mode) ? MODE_URL + mode : mode;
  }

  /** Copilot's `allow_all` option approves every tool, path and URL whatever the mode. */
  override optionRisk(configOptions: readonly ConfigOption[]): NoticeText | null {
    const all = configOptions.find((o) => o.id === 'allow_all' || o.category === 'permissions');
    return all?.currentValue === 'on'
      ? this.t('{name} 的 Allow All 已打开：工具、路径和网址请求会被自动批准，不会在群里请求审批', '{name}’s Allow All is on: tool, path and URL requests are approved automatically, without asking in the chat')
      : null;
  }

  override sessionNotes(report: { configOptions: readonly ConfigOption[]; models: UnstableModels | null }): NoticeText[] {
    const env = this.env();
    const notes: NoticeText[] = [];
    const token = copilotTokenVar(env);
    if (token) notes.push(this.t('{name} 使用环境变量 {var} 中的 GitHub 令牌，而不是 copilot login 的登录', '{name} uses the GitHub token in the environment variable {var}, not the copilot login', { var: token }));
    if (copilotByok(env)) {
      notes.push(this.t('计费：自带模型供应商（BYOK，COPILOT_PROVIDER_BASE_URL），由你的供应商按 token 计费', 'Billing: your own model provider (BYOK, COPILOT_PROVIDER_BASE_URL), billed per token by that provider'));
      return notes;
    }
    const plan = copilotPlan(report);
    if (plan === 'free') {
      notes.push(
        this.t(
          '计费：模型只有 Auto，按 GitHub 文档这是 Copilot Free / Student 套餐，用量计入每月的免费 AI Credits 额度',
          'Billing: the only model is Auto, which per GitHub’s documentation means Copilot Free / Student; usage counts against the monthly free AI Credits allowance',
        ),
      );
    } else if (plan === 'paid') {
      notes.push(
        this.t(
          '计费：有多个模型可选，是 Copilot 付费套餐；先用套餐包含的 AI Credits，用完后只在你于 GitHub 设置的额外用量预算内按量付费（不同模型消耗倍率不同）',
          'Billing: several models are offered, so this is a paid Copilot plan; the plan’s included AI Credits are used first, then use is billed only within the additional-usage budget you set on GitHub (models use credits at different rates)',
        ),
      );
    } else {
      notes.push(this.t('{name} 没有报告可用模型：可能还没有登录（在你自己的终端运行 copilot login）', '{name} reported no models: it may not be signed in yet (run copilot login in your own terminal)'));
    }
    const providers = env.COPILOT_PROVIDERS_CONFIG || join(copilotHome(env), 'providers.json');
    if (existsSync(providers)) {
      notes.push(
        this.t(
          '存在 Copilot 的自带供应商配置（providers.json）：选用其中供应商的模型时由该供应商按 token 计费',
          'Copilot’s own-provider configuration (providers.json) exists: models from those providers are billed per token by that provider',
        ),
      );
    }
    return notes;
  }

  override isNotLoggedIn(e: unknown): boolean {
    return super.isNotLoggedIn(e) || NOT_LOGGED_IN.test(String((e as Error)?.message ?? ''));
  }

  override knownError(e: unknown): NoticeText | null {
    const message = String((e as Error)?.message ?? '');
    if (!OUT_OF_CREDITS.test(message)) return null;
    return L(
      'GitHub Copilot 的 AI Credits 额度已用完。Copilot Free / Student：等每月额度重置，或升级套餐；付费套餐：可在 GitHub 设置额外用量预算继续使用（按量付费，Harness Team 不会替你设置或切换）。Copilot 的原始信息：{error}',
      'GitHub Copilot’s AI Credits are used up. Copilot Free / Student: wait for the monthly reset or upgrade the plan; paid plans: set an additional-usage budget on GitHub to continue (billed per use; Harness Team never sets or switches this for you). Copilot said: {error}',
      { error: redactText(message) },
    );
  }
}
