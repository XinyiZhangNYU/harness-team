import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { claudeLogin } from './adapters/claude/detect.ts';
import { startApp, type RunningApp } from './app.ts';
import { parentPortSecretBox } from './adapters/chat/secrets.ts';
import { detectRuntimes } from './harnesses.ts';
import { errorNotice, localized } from '../../shared/notices.ts';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

const { values } = parseArgs({
  options: {
    port: { type: 'string' },
    'data-dir': { type: 'string' },
    dev: { type: 'boolean', default: false },
    open: { type: 'boolean', default: false },
    'no-codex': { type: 'boolean', default: false },
    'no-claude': { type: 'boolean', default: false },
    'no-antigravity': { type: 'boolean', default: false },
    'no-dsh': { type: 'boolean', default: false },
    'no-opencode': { type: 'boolean', default: false },
  },
});

const port = Number(values.port ?? process.env.HT_PORT ?? 4317);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`invalid port: ${values.port ?? process.env.HT_PORT}`);
  process.exit(2);
}
const dataDir = resolve(values['data-dir'] ?? process.env.HT_DATA_DIR ?? resolve(REPO_ROOT, 'data'));

// The official CLIs, each optional. Codex: `codex --version` / `codex login status`. Claude Code: `claude --version` /
// `claude auth status --json` (non-secret fields only) in a sanitized environment. Credentials are never read.
// The add-member form can run the same detection again (no restart needed after installing or logging in).
const detectOpts = {
  codex: !values['no-codex'],
  claude: !values['no-claude'],
  antigravity: !values['no-antigravity'],
  dsh: !values['no-dsh'],
  opencode: !values['no-opencode'],
  codexProtocolLog: process.env.HT_CODEX_PROTOCOL_LOG || undefined,
  claudeProtocolLog: process.env.HT_CLAUDE_PROTOCOL_LOG || undefined,
  antigravityProtocolLog: process.env.HT_ANTIGRAVITY_PROTOCOL_LOG || undefined,
  dshProtocolLog: process.env.HT_DSH_PROTOCOL_LOG || undefined,
  opencodeProtocolLog: process.env.HT_OPENCODE_PROTOCOL_LOG || undefined,
};
const found = await detectRuntimes(detectOpts);
const codex = found.codex.detection;
const claude = found.claude.detection;

// Electron utilityProcess.fork: the desktop shell's channel (shutdown, readiness, and the system key store for chat member keys).
const parentPort = (process as unknown as { parentPort?: { on(e: 'message', f: (ev: { data: unknown }) => void): void; postMessage(m: unknown): void } }).parentPort;

let app: RunningApp;
try {
  app = await startApp({
  port,
  dataDir,
  dev: values.dev,
  webDistDir: resolve(REPO_ROOT, 'web/dist'),
  codex: found.codex.options ?? null,
  claude: found.claude.options ?? null,
  antigravity: found.antigravity.options ?? null,
  dsh: found.dsh.options ?? null,
  opencode: found.opencode.options ?? null,
  missingRuntimes: { codex: found.codex.missing, claude: found.claude.missing, antigravity: found.antigravity.missing, dsh: found.dsh.missing, opencode: found.opencode.missing },
  detectRuntimes: () => detectRuntimes(detectOpts),
  secrets: parentPort ? parentPortSecretBox(parentPort) : null,
  });
} catch (e) {
  // The desktop shell shows this text in its dialog, in the language it passes as HT_LANG (English otherwise).
  console.error(`Harness Team could not start: ${localized(errorNotice(e), process.env.HT_LANG === 'zh' ? 'zh' : 'en')}`);
  process.exit(1);
}

console.log(`Harness Team ${values.dev ? '(dev) ' : ''}listening on ${app.url} (loopback only)`);
console.log(`Data directory: ${dataDir}`);
if (app.startup.backupFile) {
  console.log(`Database backup (taken before use${app.startup.migrated.length ? ', migrated afterwards' : ''}): ${app.startup.backupFile}`);
}
console.log(`Open this link to sign in to the local UI (keep it private):`);
console.log(`  ${app.launchUrl}`);
if (found.codex.options) {
  console.log(`Codex runtime: ${codex!.version} (${[codex!.command, ...(codex!.argsPrefix ?? [])].join(' ')}) - ${localized(codex!.loginStatus ?? 'login status unknown', 'en')}`);
  if (codex!.problem) console.log(`  Codex members cannot run: ${localized(codex!.problem, 'en')}`);
  else if (codex!.billing === 'metered_api') console.log('  Codex is logged in with an API key: members are billed per token, as in your terminal');
  if (process.env.HT_CODEX_PROTOCOL_LOG) console.log(`  Raw Codex protocol log: ${process.env.HT_CODEX_PROTOCOL_LOG}`);
} else {
  console.log(`Codex runtime: not available (${localized(found.codex.missing!, 'en')})`);
}
if (found.claude.options) {
  const a = claude!.auth;
  console.log(`Claude Code runtime: ${claude!.version} (${[claude!.command, ...claude!.argsPrefix].join(' ')}) - auth ${a?.authMethod ?? 'unknown'} / ${a?.apiProvider ?? '?'} / ${a?.subscriptionType ?? '?'}`);
  const login = claudeLogin(a);
  const problem = claude!.problem ?? login.problem;
  if (problem) console.log(`  Claude Code agents on its own login are disabled: ${localized(problem, 'en')}`);
  else if (login.billing === 'metered_api') console.log(`  Billed per token, as in your terminal (${login.source ?? '?'}; values not shown)`);
  if (process.env.HT_CLAUDE_PROTOCOL_LOG) console.log(`  Raw Claude Code protocol log: ${process.env.HT_CLAUDE_PROTOCOL_LOG}`);
} else {
  console.log(`Claude Code runtime: not available (${localized(found.claude.missing!, 'en')})`);
}
if (found.antigravity.options) {
  const ag = found.antigravity.detection!;
  console.log(`Antigravity runtime: ${ag.version ?? 'version reported at initialize'} (${[ag.command, ...ag.argsPrefix].join(' ')}, ${ag.flavor === 'agy' ? 'agy acp' : 'ACP binary'})`);
  if (process.env.HT_ANTIGRAVITY_PROTOCOL_LOG) console.log(`  Raw Antigravity ACP protocol log: ${process.env.HT_ANTIGRAVITY_PROTOCOL_LOG}`);
} else {
  console.log(`Antigravity runtime: not available (${localized(found.antigravity.missing!, 'en')})`);
}
if (found.dsh.options) {
  const d = found.dsh.detection!;
  console.log(`DeepSeek Harness runtime: ${d.version ?? 'version reported at initialize'} (${[d.command, ...d.argsPrefix].join(' ')}, --profile acp) - billed per token to your DeepSeek account`);
  if (process.env.HT_DSH_PROTOCOL_LOG) console.log(`  Raw DeepSeek Harness ACP protocol log: ${process.env.HT_DSH_PROTOCOL_LOG}`);
} else {
  console.log(`DeepSeek Harness runtime: not available (${localized(found.dsh.missing!, 'en')})`);
}
if (found.opencode.options) {
  const d = found.opencode.detection!;
  console.log(`OpenCode runtime: ${d.version ?? 'version reported at initialize'} (${[d.command, ...d.argsPrefix].join(' ')}, acp) - billed by the chosen model's provider; OpenCode's hosted free models cost nothing`);
  if (process.env.HT_OPENCODE_PROTOCOL_LOG) console.log(`  Raw OpenCode ACP protocol log: ${process.env.HT_OPENCODE_PROTOCOL_LOG}`);
} else {
  console.log(`OpenCode runtime: not available (${localized(found.opencode.missing!, 'en')})`);
}
console.log('Mock agents are simulated.');

if (values.open) openBrowser(app.launchUrl);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  console.log('Shutting down...');
  await app.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Windows: closing the console window.
process.on('SIGHUP', shutdown);
// Started by a desktop shell over IPC (Electron): it asks for a clean shutdown, and if the shell itself goes away
// the Core shuts down too instead of leaving runtimes running in the background.
const ready = { type: 'ready', url: app.url, launchUrl: app.launchUrl, dataDir };
const isShutdown = (m: unknown) => !!m && typeof m === 'object' && (m as { type?: string }).type === 'shutdown';
if (process.send) {
  // child_process.fork
  process.on('message', (m) => isShutdown(m) && void shutdown());
  process.on('disconnect', () => void shutdown());
  process.send(ready);
}
// Electron utilityProcess.fork exposes process.parentPort instead.
if (parentPort) {
  parentPort.on('message', (ev) => isShutdown(ev.data) && void shutdown());
  parentPort.postMessage(ready);
}

function openBrowser(url: string) {
  // URL is generated locally (loopback + hex token), so it carries no shell metacharacters.
  if (!/^http:\/\/127\.0\.0\.1:\d+\/auth\?token=[0-9a-f]+$/.test(url)) return;
  const [cmd, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  const child = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true });
  child.on('error', () => console.log('Could not open a browser automatically; open the link above manually.'));
  child.unref();
}
