import { execFile } from 'node:child_process';
import { L, type Localized, type NoticeText } from '../../../../shared/notices.ts';
import type { RuntimeBilling } from '../../../../shared/protocol.ts';
import { type CliLaunch, cliFromPath, findCli, olderThan, versionLabel } from '../cli-path.ts';

/**
 * Discovery and billing helpers for the official Claude Code CLI.
 *
 * Harness Team never reads, stores or forwards Claude credentials. It runs the user's own `claude` binary
 * (`--version`, `auth status --json`) with the user's own environment, as a terminal would, keeps the non-secret
 * fields and works out how that login is billed (shown on the member, never changed).
 */

/** Variables kept although they match the stripped prefixes: they select the user's own config, not billing. */
const KEEP = new Set(['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_GIT_BASH_PATH']);

function stripped(name: string): boolean {
  if (KEEP.has(name.toUpperCase())) return false;
  if (/^(ANTHROPIC_|CLAUDE)/i.test(name)) return true;
  // Bedrock bearer token does not carry the ANTHROPIC_/CLAUDE prefix.
  return /^AWS_BEARER_TOKEN_BEDROCK$/i.test(name);
}

/** Names that could route requests to API-key / Console / cloud billing or disable the subscription login. */
const ROUTING = /(API_KEY|AUTH_TOKEN|OAUTH_TOKEN|BASE_URL|USE_BEDROCK|USE_VERTEX|USE_FOUNDRY|BEDROCK|VERTEX|FOUNDRY|SIMPLE|API_KEY_HELPER)/i;

/**
 * A copy of `base` without Anthropic/Claude routing and credential variables (see nativeClaudeEnv). The parent process
 * environment is never modified. Returns the removed names (never values).
 */
export function sanitizeClaudeEnv(base: NodeJS.ProcessEnv = process.env): { env: NodeJS.ProcessEnv; removed: string[] } {
  const env: NodeJS.ProcessEnv = {};
  const removed: string[] = [];
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (stripped(k)) removed.push(k);
    else env[k] = v;
  }
  return { env, removed: removed.sort() };
}

/** Of the removed names, those that would actually affect auth/billing routing (names only). */
export function routingEnvNames(removed: string[]): string[] {
  return removed.filter((n) => ROUTING.test(n));
}

/** Variables with which `claude -p` bills per token instead of the claude.ai login (API key, gateway token, cloud). */
const METERED_ENV = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|AWS_BEARER_TOKEN_BEDROCK|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY))$/i;

/** Names (never values) of the per-token billing variables a member on the own login gets (see nativeClaudeEnv). */
export function meteredClaudeEnvNames(base: NodeJS.ProcessEnv = process.env): string[] {
  const env = nativeClaudeEnv(base);
  return Object.keys(env)
    .filter((k) => METERED_ENV.test(k) && !!env[k] && !/^(0|false)$/i.test(env[k]!.trim()))
    .sort();
}

/**
 * Environment of a member on the harness's own login: the user's environment as a terminal has it (API keys and other
 * login variables included). When Harness Team itself runs inside a Claude Code session (CLAUDECODE is set), the
 * Anthropic/Claude variables belong to that session (its proxy, its mode), not to the user, and are left out.
 */
export function nativeClaudeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (base.CLAUDECODE) return sanitizeClaudeEnv(base).env;
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  return env;
}

/** Non-secret fields of `claude auth status --json`. email / org ids are deliberately dropped. */
export interface ClaudeAuthSummary {
  loggedIn: boolean;
  authMethod: string | null;
  apiProvider: string | null;
  subscriptionType: string | null;
}

export interface ClaudeDetection {
  command: string | null;
  /** Arguments before Claude Code's own (an npm install on Windows may run `node <cli.js>`). */
  argsPrefix: string[];
  version: string | null;
  auth: ClaudeAuthSummary | null;
  /** Names (no values) of the per-token billing variables in the Core's environment; the CLI sees them as set. */
  meteredEnvNames: string[];
  /** Not found / could not run. */
  error: Localized | null;
  /** Found, but too old: no Claude Code member can run (not even on a provider). */
  problem: NoticeText | null;
}

/**
 * Oldest Claude Code that accepts every flag and control request Harness Team uses. Checked against published builds
 * without any model request: 2.1.87 rejects --include-hook-events (and before 2.1.42 `auth status --json` is
 * missing); 2.1.89 starts, answers initialize and get_settings.
 */
export const MIN_CLAUDE_VERSION = '2.1.89';

export interface ClaudeLogin {
  /** How a terminal `claude -p` with this login and environment is billed (null = not logged in / unknown). */
  billing: RuntimeBilling | null;
  /** What it bills through, for display: variable names, or the login's method / provider. */
  source: string | null;
  /** Why no member can run on the login (not logged in, unknown). An API-key login is not a problem. */
  problem: NoticeText | null;
}

/**
 * How Claude Code's own login is billed, as in the user's terminal: per-token variables in the environment take
 * precedence in `-p` mode; otherwise a claude.ai login on Anthropic is the subscription, anything else is per token.
 */
export function claudeLogin(auth: ClaudeAuthSummary | null | undefined, env: NodeJS.ProcessEnv = process.env): ClaudeLogin {
  const names = meteredClaudeEnvNames(env);
  if (names.length) return { billing: 'metered_api', source: names.join(', '), problem: null };
  if (!auth) return { billing: null, source: null, problem: L('无法确认 Claude Code 的登录状态', 'Cannot confirm Claude Code’s login status') };
  if (!auth.loggedIn) {
    return {
      billing: null,
      source: null,
      problem: L('Claude Code 未登录：请在你自己的终端运行 `claude` 并用 /login 登录', 'Claude Code is not logged in: run `claude` in your own terminal and log in with /login'),
    };
  }
  const subscription = auth.authMethod === 'claude.ai' && (!auth.apiProvider || auth.apiProvider === 'firstParty');
  return {
    billing: subscription ? 'subscription' : 'metered_api',
    source: [auth.authMethod, auth.apiProvider].filter(Boolean).join(' · ') || null,
    problem: null,
  };
}

export async function detectClaude(env: NodeJS.ProcessEnv = process.env): Promise<ClaudeDetection> {
  const childEnv = nativeClaudeEnv(env);
  const metered = meteredClaudeEnvNames(env);
  const none = { auth: null, meteredEnvNames: metered, problem: null };
  const found = findClaudeBinary(env);
  if (!found) {
    return {
      command: null,
      argsPrefix: [],
      version: null,
      ...none,
      error: env.HT_CLAUDE_PATH
        ? L('HT_CLAUDE_PATH 指向的文件不存在或不是可执行文件：{path}', 'The file HT_CLAUDE_PATH points to does not exist or is not an executable: {path}', { path: env.HT_CLAUDE_PATH })
        : L('未找到 claude', 'claude was not found'),
    };
  }
  const base = { command: found.command, argsPrefix: found.argsPrefix };
  const claude = (args: string[]) => run(found.command, [...found.argsPrefix, ...args], childEnv);
  let version: string;
  try {
    version = (await claude(['--version'])).stdout.trim();
  } catch (e) {
    return { ...base, version: null, ...none, error: L('无法运行 claude：{error}', 'Could not run claude: {error}', { error: (e as Error).message.split('\n')[0] ?? 'error' }) };
  }
  if (olderThan(version, MIN_CLAUDE_VERSION)) {
    return {
      ...base,
      version,
      ...none,
      error: null,
      problem: L('Claude Code {v} 版本过旧，需要 {min} 或更高版本', 'Claude Code {v} is too old; {min} or later is needed', { v: versionLabel(version), min: MIN_CLAUDE_VERSION }),
    };
  }
  let auth: ClaudeAuthSummary;
  try {
    auth = parseAuthStatus((await claude(['auth', 'status', '--json'])).stdout);
  } catch (e) {
    // `auth status` exits non-zero when logged out; its JSON (if any) is still on stdout.
    const out = (e as { stdout?: string }).stdout ?? '';
    try {
      auth = parseAuthStatus(out);
    } catch {
      auth = { loggedIn: false, authMethod: null, apiProvider: null, subscriptionType: null };
    }
  }
  return { ...base, version, auth, meteredEnvNames: metered, error: null, problem: null };
}

export function parseAuthStatus(stdout: string): ClaudeAuthSummary {
  const j = JSON.parse(stdout);
  const s = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return { loggedIn: j.loggedIn === true, authMethod: s(j.authMethod), apiProvider: s(j.apiProvider), subscriptionType: s(j.subscriptionType) };
}

function findClaudeBinary(env: NodeJS.ProcessEnv): CliLaunch | null {
  if (env.HT_CLAUDE_PATH) return cliFromPath(env.HT_CLAUDE_PATH, env);
  return findCli('claude', env);
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30_000, windowsHide: true, env }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(`${err.message}\n${stderr}`), { stdout }));
      else resolve({ stdout });
    });
  });
}
