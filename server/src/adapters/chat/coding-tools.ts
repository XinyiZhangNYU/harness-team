import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { FileChange, PermissionMode } from '../../../../shared/protocol.ts';
import { foldName } from '../../path-key.ts';
import { redactText } from '../../redact.ts';
import { inside, isBinary, ProjectToolError } from './project-tools.ts';
import type { ToolDef } from './wire.ts';

/**
 * Tools that change the chat's project: write a file, edit a file, run a command in the project folder. Harness Team
 * runs them itself (there is no Harness behind a chat member), so it also asks for the approvals:
 * - manual: every write, edit and command waits for the user's decision in the chat;
 * - acceptEdits: writes and edits inside the project run at once, commands wait for a decision;
 * - full-access: nothing asks (a risky mode, chosen only after the warning).
 * Besides "allow once" and "deny" the user may allow for the rest of the session: this exact command, commands that
 * start with a prefix, this file, or every file write (SessionGrants). No model decides in the user's place.
 * Paths follow the read tools' rules (inside the project, not the app's data folder, not .git, not files that usually
 * hold secrets). Commands have no sandbox: they run with the user's rights in the project folder.
 */

export const CODING_TOOL_NAMES = ['write_file', 'edit_file', 'run_command'] as const;
export type CodingToolName = (typeof CODING_TOOL_NAMES)[number];

/** Permission modes of chat members (PERMISSION_MODES.chat); null is read-only. */
export type ChatWriteMode = 'manual' | 'acceptEdits' | 'full-access';

export function chatWriteMode(mode: PermissionMode | null | undefined): ChatWriteMode | null {
  return mode === 'manual' || mode === 'acceptEdits' || mode === 'full-access' ? mode : null;
}

export function isCodingTool(name: string): name is CodingToolName {
  return (CODING_TOOL_NAMES as readonly string[]).includes(name);
}

/** Folders and files whose contents other tools run on their own (hooks, MCP servers, tasks, git hooks). */
const AGENT_CONFIG_DIRS = new Set(['.claude', '.codex', '.gemini', '.cursor', '.vscode', '.idea', '.zed', '.opencode', '.kimi', '.grok', '.copilot', '.trae', '.agents', '.husky']);
const AGENT_CONFIG_FILES = new Set(['.mcp.json', 'opencode.json', 'opencode.jsonc']);

/**
 * A file that a harness, editor or git runs from: changing it is asked about one by one even under acceptEdits or
 * "allow all file changes", and never covered by a session grant.
 */
export function isAgentConfig(rel: string): boolean {
  const parts = foldName(rel).split(/[\\/]/);
  return parts.slice(0, -1).some((p) => AGENT_CONFIG_DIRS.has(p)) || AGENT_CONFIG_FILES.has(parts.at(-1)!);
}

/** Whether a call waits for the user's decision in this mode. */
export function needsApproval(mode: ChatWriteMode, name: CodingToolName): boolean {
  if (mode === 'full-access') return false;
  if (mode === 'acceptEdits') return name === 'run_command';
  return true;
}

// ---- approvals for the rest of the session ----

/**
 * Characters that chain or nest commands (or redirect output) in PowerShell and sh. A command with any of them is
 * never covered by a prefix: `npm test; rm -rf x` must not pass as "starts with npm test". A bare `(` counts too:
 * PowerShell runs `(…)` in argument position (`git status (Remove-Item x)`).
 */
const CHAINING = /[;&|<>`(\r\n]|\$\{/;
/**
 * Shells and launchers run the program named in their arguments: `sudo rm x` would offer "sudo rm", which covers
 * every rm. They never get a prefix.
 */
const LAUNCHERS = new Set([
  'cmd', 'powershell', 'pwsh', 'bash', 'sh', 'zsh', 'fish', 'dash', 'wsl', 'env', 'sudo', 'doas', 'runas', 'start',
  'start-process', 'saps', 'invoke-expression', 'iex', 'invoke-command', 'icm', 'call', 'exec', 'xargs', 'nohup',
  'time', 'timeout', 'nice', 'watch', 'foreach-object', 'cscript', 'wscript', 'mshta', 'rundll32',
]);
/** Second words after which the third word says what actually runs (`npm run build`, not every `npm run`). */
const RUNNER_SUBCOMMANDS = new Set(['run', 'run-script', 'exec', 'x', 'dlx']);
const words = (command: string) => command.trim().split(/\s+/).filter(Boolean);
/** A word that is a plain name or path: not an option, not quoted, no variables. */
const plainWord = (w: string) => !/^[-/]/.test(w) && !/["'$%^*?[\]{}()]/.test(w);
const programName = (w: string) => w.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();

/**
 * The prefix offered as "allow commands that start with …" for the rest of the session, or null when none is safe:
 * the program and its first plain argument (and the script name after `npm run` and the like). Never a bare program,
 * never a shell or launcher, never for a command that chains others.
 */
export function commandPrefix(command: string): string | null {
  if (CHAINING.test(command)) return null;
  const w = words(command);
  if (w.length < 2 || !plainWord(w[0]!) || !plainWord(w[1]!)) return null;
  if (LAUNCHERS.has(programName(w[0]!))) return null;
  const take = RUNNER_SUBCOMMANDS.has(w[1]!.toLowerCase()) ? 3 : 2;
  if (take === 3 && (w.length < 3 || !plainWord(w[2]!))) return null;
  return w.slice(0, take).join(' ');
}

/** Whether a prefix allowed earlier covers this command (whole words, and nothing chained). */
export function prefixCovers(prefix: string, command: string): boolean {
  if (CHAINING.test(command)) return false;
  const p = words(prefix);
  const w = words(command);
  return w.length >= p.length && p.every((x, i) => w[i] === x);
}

/** The key of a file for "this file for the rest of the session". */
const fileKey = (abs: string) => (process.platform === 'win32' ? abs.toLowerCase() : abs);

/**
 * What the user allowed for the rest of a member's session in one chat: exact commands, command prefixes, files, or
 * every file write. Kept in memory only, so an app restart forgets it; also forgotten on /clear and when the
 * permission mode, the provider or the model changes (the key).
 */
export class SessionGrants {
  private key = '';
  private readonly commands = new Set<string>();
  private readonly prefixes = new Set<string>();
  private readonly files = new Set<string>();
  private readonly sites = new Set<string>();
  private allEdits = false;

  /** Starts a turn: forgets everything when what the grants were given for has changed. */
  use(key: string) {
    if (key !== this.key) this.clear();
    this.key = key;
  }

  clear() {
    this.commands.clear();
    this.prefixes.clear();
    this.files.clear();
    this.sites.clear();
    this.allEdits = false;
  }

  /** fetch_url: the user allowed this host (host[:port], lower case) for the session. */
  coversSite(host: string): boolean {
    return this.sites.has(host);
  }

  grantSite(host: string) {
    this.sites.add(host);
  }

  /** Why this call needs no question, or null when it does. */
  covers(p: PreparedCall): 'command' | 'prefix' | 'file' | 'edits' | null {
    if (p.kind === 'command') {
      if (this.commands.has(p.command.trim())) return 'command';
      for (const x of this.prefixes) if (prefixCovers(x, p.command)) return 'prefix';
      return null;
    }
    if (this.allEdits) return 'edits';
    return this.files.has(fileKey(p.abs)) ? 'file' : null;
  }

  /** Records a decision that covers later calls. */
  grant(p: PreparedCall, decision: 'allow_session' | 'allow_prefix' | 'allow_all_edits', prefix: string | null) {
    if (p.kind === 'command') {
      if (decision === 'allow_session') this.commands.add(p.command.trim());
      else if (decision === 'allow_prefix' && prefix) this.prefixes.add(prefix);
      return;
    }
    if (decision === 'allow_all_edits') this.allEdits = true;
    else if (decision === 'allow_session') this.files.add(fileKey(p.abs));
  }
}

const WRITE_MAX_CHARS = 1_000_000;
const EDIT_MAX_BYTES = 2 * 1024 * 1024;
const COMMAND_MAX_CHARS = 8000;
const TIMEOUT_DEFAULT_S = 120;
const TIMEOUT_MAX_S = 600;
const OUTPUT_HEAD = 40_000;
const OUTPUT_TAIL = 40_000;
const DIFF_MAX_CHARS = 20_000;
const DIFF_CONTEXT = 3;

export function codingToolDefs(): ToolDef[] {
  return [
    {
      name: 'write_file',
      description:
        'Create a file in the chat’s project, or replace all of its content. Parent folders are created. Prefer edit_file for changing part of an existing file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File relative to the project folder.' },
          content: { type: 'string', description: 'The whole new content of the file.' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
    {
      name: 'edit_file',
      description:
        'Replace text in an existing file of the chat’s project. old_text must match the file exactly (including indentation) and only once, unless replace_all is true. Read the file first.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File relative to the project folder.' },
          old_text: { type: 'string', description: 'The exact text to replace.' },
          new_text: { type: 'string', description: 'The text to put in its place.' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' },
        },
        required: ['path', 'old_text', 'new_text'],
        additionalProperties: false,
      },
    },
    {
      name: 'run_command',
      description:
        `Run a command in the chat’s project folder (${process.platform === 'win32' ? 'Windows PowerShell' : '/bin/sh'}, non-interactive, no input). ` +
        `Returns the exit code and the output. Stopped after timeout_seconds (default ${TIMEOUT_DEFAULT_S}, at most ${TIMEOUT_MAX_S}).`,
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command line to run.' },
          timeout_seconds: { type: 'integer', minimum: 1, maximum: TIMEOUT_MAX_S, description: `Seconds before the command is stopped (default ${TIMEOUT_DEFAULT_S}).` },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  ];
}

export type PreparedCall =
  | { kind: 'file'; name: 'write_file' | 'edit_file'; rel: string; abs: string; before: string | null; after: string; change: FileChange; summary: string }
  | { kind: 'command'; name: 'run_command'; command: string; timeoutS: number };

const str = (v: unknown) => (typeof v === 'string' ? v : null);

/**
 * Checks a call and works out what it would do, without changing anything (what the approval card shows). Throws a
 * ProjectToolError the model can read when the call is not allowed or cannot work.
 */
export function prepareCodingCall(root: string, dataDir: string, name: CodingToolName, args: Record<string, unknown>): PreparedCall {
  if (name === 'run_command') {
    const command = str(args.command)?.trim() ?? '';
    if (!command) throw new ProjectToolError('empty command');
    if (command.length > COMMAND_MAX_CHARS) throw new ProjectToolError(`the command is too long (at most ${COMMAND_MAX_CHARS} characters); write a script file and run that`);
    const t = Math.floor(Number(args.timeout_seconds) || TIMEOUT_DEFAULT_S);
    return { kind: 'command', name, command, timeoutS: Math.min(TIMEOUT_MAX_S, Math.max(1, t)) };
  }
  if (!str(args.path)?.trim()) throw new ProjectToolError('missing path');
  const { abs, rel } = inside(root, dataDir, args.path);
  if (rel === '.') throw new ProjectToolError('the project folder itself is not a file');
  const before = readText(abs, rel, name === 'edit_file');
  if (name === 'write_file') {
    const content = str(args.content);
    if (content === null) throw new ProjectToolError('missing content');
    if (content.length > WRITE_MAX_CHARS) throw new ProjectToolError(`the content is too long (at most ${WRITE_MAX_CHARS} characters)`);
    const change: FileChange = { path: rel, change: before === null ? 'add' : 'update', ...diffOf(before ?? '', content) };
    return { kind: 'file', name, rel, abs, before, after: content, change, summary: before === null ? `new file, ${content.length} characters` : 'whole file replaced' };
  }
  const oldText = str(args.old_text);
  const newText = str(args.new_text);
  if (oldText === null || newText === null) throw new ProjectToolError('missing old_text or new_text');
  if (!oldText) throw new ProjectToolError('old_text is empty; use write_file to create a file');
  if (oldText === newText) throw new ProjectToolError('old_text and new_text are the same');
  const text = before!;
  let [from, to] = [oldText, newText];
  // Models usually send \n; the file may use \r\n.
  if (!text.includes(from) && text.includes('\r\n') && !from.includes('\r')) [from, to] = [from.replace(/\n/g, '\r\n'), to.replace(/\n/g, '\r\n')];
  const count = text.split(from).length - 1;
  if (!count) throw new ProjectToolError(`old_text was not found in ${rel}; read the file again and copy the text exactly`);
  if (count > 1 && args.replace_all !== true) throw new ProjectToolError(`old_text occurs ${count} times in ${rel}; add surrounding lines so it is unique, or set replace_all`);
  const after = args.replace_all === true ? text.split(from).join(to) : text.replace(from, () => to);
  const change: FileChange = { path: rel, change: 'update', ...diffOf(text, after) };
  return { kind: 'file', name, rel, abs, before: text, after, change, summary: `${count} replacement${count > 1 ? 's' : ''}` };
}

/** Current text of a file in the project; null when it does not exist (allowed only for write_file). */
function readText(abs: string, rel: string, mustExist: boolean): string | null {
  let st;
  try {
    st = statSync(abs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' && !mustExist) return null;
    throw new ProjectToolError(code === 'ENOENT' ? `not found: ${rel}` : `cannot read ${rel}: ${code ?? 'error'}`);
  }
  if (!st.isFile()) throw new ProjectToolError(`not a file: ${rel}`);
  if (st.size > EDIT_MAX_BYTES) throw new ProjectToolError(`${rel} is too large to change with this tool (${st.size} bytes)`);
  const buf = readFileSync(abs);
  if (isBinary(buf)) throw new ProjectToolError(`not a text file: ${rel}`);
  return buf.toString('utf8');
}

/**
 * Writes a prepared change. The path is checked again and the file must still hold what the approval showed: a file
 * changed in between is not overwritten.
 */
export async function applyFileChange(root: string, dataDir: string, p: Extract<PreparedCall, { kind: 'file' }>): Promise<string> {
  const again = inside(root, dataDir, p.rel);
  if (again.abs !== p.abs) throw new ProjectToolError(`the path ${p.rel} changed meanwhile; nothing was written`);
  const now = readText(p.abs, p.rel, false);
  if (now !== p.before) throw new ProjectToolError(`${p.rel} changed after the change was prepared; nothing was written. Read it again`);
  await mkdir(dirname(p.abs), { recursive: true });
  // The parent folders just created must still be inside the project (a link could have been put there meanwhile).
  if (inside(root, dataDir, p.rel).abs !== p.abs) throw new ProjectToolError(`the path ${p.rel} changed meanwhile; nothing was written`);
  await writeFile(p.abs, p.after, 'utf8');
  return p.name === 'write_file' ? `${p.before === null ? 'created' : 'replaced'} ${p.rel} (${p.after.length} characters)` : `edited ${p.rel}: ${p.summary}`;
}

// ---- diff ----

type Op = { t: ' ' | '-' | '+'; s: string };

/** A line diff in hunks (@@ -a,b +c,d @@ with up to three lines of context), cut when long. */
export function diffOf(before: string, after: string): { diff: string; truncated?: boolean } {
  const a = splitLines(before);
  const b = splitLines(after);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const ops: Op[] = a.slice(0, p).map((x) => ({ t: ' ', s: x }));
  ops.push(...middle(a.slice(p, a.length - s), b.slice(p, b.length - s)));
  ops.push(...a.slice(a.length - s).map((x): Op => ({ t: ' ', s: x })));
  const out = hunks(ops).join('\n');
  return out.length > DIFF_MAX_CHARS ? { diff: out.slice(0, DIFF_MAX_CHARS), truncated: true } : { diff: out };
}

function splitLines(t: string): string[] {
  if (!t) return [];
  const lines = t.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Longest common subsequence over the changed middle; too large a middle is shown as removed then added. */
function middle(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (!n || !m || n * m > 4_000_000) return [...a.map((s): Op => ({ t: '-', s })), ...b.map((s): Op => ({ t: '+', s }))];
  const w = m + 1;
  const L = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) L[i * w + j] = a[i] === b[j] ? L[(i + 1) * w + j + 1]! + 1 : Math.max(L[(i + 1) * w + j]!, L[i * w + j + 1]!);
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: ' ', s: a[i++]! });
      j++;
    } else if (L[(i + 1) * w + j]! >= L[i * w + j + 1]!) ops.push({ t: '-', s: a[i++]! });
    else ops.push({ t: '+', s: b[j++]! });
  }
  while (i < n) ops.push({ t: '-', s: a[i++]! });
  while (j < m) ops.push({ t: '+', s: b[j++]! });
  return ops;
}

function hunks(ops: Op[]): string[] {
  const out: string[] = [];
  let k = 0;
  // Line numbers (1-based) of ops[k] in the old and the new text.
  const oldAt: number[] = [];
  const newAt: number[] = [];
  let o = 1;
  let nn = 1;
  for (const op of ops) {
    oldAt.push(o);
    newAt.push(nn);
    if (op.t !== '+') o++;
    if (op.t !== '-') nn++;
  }
  while (k < ops.length) {
    if (ops[k]!.t === ' ') {
      k++;
      continue;
    }
    const start = Math.max(0, k - DIFF_CONTEXT);
    let end = k;
    // Extend while the next change is within twice the context.
    for (;;) {
      while (end < ops.length && ops[end]!.t !== ' ') end++;
      let next = end;
      while (next < ops.length && ops[next]!.t === ' ' && next - end < DIFF_CONTEXT * 2) next++;
      if (next < ops.length && ops[next]!.t !== ' ') end = next;
      else break;
    }
    const stop = Math.min(ops.length, end + DIFF_CONTEXT);
    const slice = ops.slice(start, stop);
    const oldLen = slice.filter((x) => x.t !== '+').length;
    const newLen = slice.filter((x) => x.t !== '-').length;
    out.push(`@@ -${oldLen ? oldAt[start] : oldAt[start]! - 1},${oldLen} +${newLen ? newAt[start] : newAt[start]! - 1},${newLen} @@`);
    for (const x of slice) out.push(`${x.t}${x.s}`);
    k = stop;
  }
  return out;
}

// ---- commands ----

export interface CommandOutcome {
  text: string;
  exitCode: number | null;
  timedOut: boolean;
  stopped: boolean;
}

/** Names of environment variables a command never gets: the app's own and API keys (the output goes to a model API). */
export function commandEnv(base: NodeJS.ProcessEnv, keyNames: readonly string[]): NodeJS.ProcessEnv {
  const drop = new Set(keyNames.map((n) => n.toUpperCase()));
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    const u = k.toUpperCase();
    if (drop.has(u) || u.startsWith('HT_') || /(^|_)API_?KEY$/.test(u) || /^ELECTRON_/.test(u)) continue;
    env[k] = v;
  }
  return env;
}

const systemRoot = () => process.env.SystemRoot || process.env.windir || 'C:\\Windows';

/** The shell, by absolute path (a program of the same name in the project folder is never started instead). */
function shellFor(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    const script =
      "$ProgressPreference = 'SilentlyContinue'\n" +
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n' +
      '$OutputEncoding = [System.Text.Encoding]::UTF8\n' +
      `${command}\n` +
      '$__htOk = $?; $__htCode = $LASTEXITCODE; if ($__htCode) { exit $__htCode }; if (-not $__htOk) { exit 1 }\n';
    return {
      file: join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    };
  }
  return { file: '/bin/sh', args: ['-c', command] };
}

export function killTree(pid: number) {
  if (process.platform === 'win32') {
    spawn(join(systemRoot(), 'System32', 'taskkill.exe'), ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

/** Keeps the start and the end of a long output. */
class Capped {
  private head = '';
  private tail = '';
  private dropped = 0;
  add(s: string) {
    if (this.head.length < OUTPUT_HEAD) {
      const room = OUTPUT_HEAD - this.head.length;
      this.head += s.slice(0, room);
      s = s.slice(room);
    }
    if (!s) return;
    this.tail += s;
    if (this.tail.length > OUTPUT_TAIL) {
      this.dropped += this.tail.length - OUTPUT_TAIL;
      this.tail = this.tail.slice(-OUTPUT_TAIL);
    }
  }
  text() {
    return this.dropped ? `${this.head}\n… [${this.dropped} characters left out] …\n${this.tail}` : this.head + this.tail;
  }
}

/** Runs a command in `cwd`; the whole process tree is stopped on timeout or when the turn is stopped. Never throws. */
export function runCommand(cwd: string, command: string, timeoutS: number, signal: AbortSignal, env: NodeJS.ProcessEnv): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    const { file, args } = shellFor(command);
    const out = new Capped();
    let timedOut = false;
    let stopped = false;
    let done = false;
    const finish = (exitCode: number | null, error?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(lingering);
      signal.removeEventListener('abort', onAbort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      const head = timedOut
        ? `stopped: the command ran longer than ${timeoutS} s`
        : stopped
          ? 'stopped: the user stopped the turn'
          : error
            ? `failed to start: ${error}`
            : `exit code: ${exitCode ?? 'none'}`;
      const body = out.text().trimEnd();
      resolve({ text: redactText(body ? `${head}\n${body}` : `${head}\n(no output)`), exitCode, timedOut, stopped });
    };
    const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    const decode = (d: StringDecoder) => (chunk: Buffer) => out.add(d.write(chunk));
    const outDec = new StringDecoder('utf8');
    const errDec = new StringDecoder('utf8');
    child.stdout!.on('data', decode(outDec));
    child.stderr!.on('data', decode(errDec));
    const stop = () => {
      if (child.pid) killTree(child.pid);
      else child.kill('SIGKILL');
    };
    const onAbort = () => {
      stopped = true;
      stop();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutS * 1000);
    let lingering: ReturnType<typeof setTimeout> | undefined;
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    child.on('error', (e) => finish(null, (e as NodeJS.ErrnoException).code ?? e.message));
    // Output is complete at 'close'; a process left running in the background can hold the pipes open, so the result
    // is taken a moment after the command itself exits.
    child.on('exit', (code) => {
      lingering = setTimeout(() => finish(code), 2000);
    });
    child.on('close', (code) => {
      out.add(outDec.end());
      out.add(errDec.end());
      finish(code);
    });
  });
}
