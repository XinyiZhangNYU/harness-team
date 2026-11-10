import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { redactText } from '../redact.ts';

/**
 * Finding the official harness CLIs the way users actually install them: native installers, npm (including the
 * Windows .cmd shims, which cannot be spawned without a shell), Homebrew, and a macOS app started from Finder, whose
 * PATH lacks everything the user's login shell adds.
 */

/** How to start a CLI that was found: `command` with `argsPrefix` before its own arguments. */
export interface CliLaunch {
  command: string;
  argsPrefix: string[];
  /** The file that was found (the .cmd shim for an npm install on Windows). */
  path: string;
}

/** Folders where installers put CLIs but which a GUI-started process may not have on PATH. */
export function extraBinDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = homedir();
  if (process.platform === 'win32') {
    return [
      join(home, '.local', 'bin'),
      ...(env.APPDATA ? [join(env.APPDATA, 'npm')] : []),
      ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'), join(env.LOCALAPPDATA, 'agy', 'bin')] : []),
    ];
  }
  return [
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.npm-global', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.bun', 'bin'),
    ...nvmBinDirs(env),
  ];
}

/**
 * The global bin folder of every Node version nvm installed, newest first. The login shell only puts nvm's default
 * version on PATH, so a CLI installed with `npm i -g` under another version would not be found from Finder.
 */
function nvmBinDirs(env: NodeJS.ProcessEnv): string[] {
  const root = join(env.NVM_DIR || join(homedir(), '.nvm'), 'versions', 'node');
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const versions = names.map((n) => [n, parseVersion(n)] as const).filter((x): x is readonly [string, [number, number, number]] => x[1] !== null);
  versions.sort(([, a], [, b]) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]);
  return versions.map(([n]) => join(root, n, 'bin'));
}

export function pathDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
}

/** `current` followed by the entries of `more` it does not have yet. */
export function mergePath(current: string, more: string[]): string {
  const have = current.split(delimiter).filter(Boolean);
  const seen = new Set(have);
  for (const d of more) {
    if (d && !seen.has(d)) {
      seen.add(d);
      have.push(d);
    }
  }
  return have.join(delimiter);
}

/**
 * PATH as the user's login shell sets it (macOS / Linux). An app opened from Finder or a desktop launcher starts with
 * a minimal PATH, so CLIs installed through Homebrew, npm, nvm and the like would not be found, and npm-installed CLIs
 * (`#!/usr/bin/env node` scripts) could not find node. null on Windows or when the shell does not answer.
 */
export function loginShellPath(env: NodeJS.ProcessEnv = process.env, timeoutMs = 5000): Promise<string | null> {
  if (process.platform === 'win32') return Promise.resolve(null);
  const shell = env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
  const mark = '__HT_PATH__';
  return new Promise((done) => {
    execFile(shell, ['-ilc', `printf '${mark}%s${mark}' "$PATH"`], { timeout: timeoutMs, env, encoding: 'utf8' }, (_err, stdout) => {
      const m = new RegExp(`${mark}(.*?)${mark}`, 's').exec(stdout ?? '');
      done(m?.[1]?.trim() || null);
    });
  });
}

function executable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (process.platform !== 'win32') accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * What an npm / pnpm .cmd shim runs: `"%dp0%\…\cli.js" %*` (run with node) or `"%dp0%\…\bin\claude.exe" %*`.
 * null when the file is not such a shim or its target is missing.
 */
export function readCmdShim(file: string, env: NodeJS.ProcessEnv = process.env): CliLaunch | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const targets = [...text.matchAll(/"%~?dp0%?\\([^"]+)"\s+%\*/gi)];
  const rel = targets.at(-1)?.[1];
  if (!rel) return null;
  const target = resolve(dirname(file), rel);
  if (!existsSync(target)) return null;
  if (/\.exe$/i.test(target)) return { command: target, argsPrefix: [], path: file };
  // The shim prefers a node.exe next to itself, then the one on PATH.
  const local = join(dirname(file), 'node.exe');
  const node = existsSync(local) ? local : findOnPath('node.exe', env);
  return node ? { command: node, argsPrefix: [target], path: file } : null;
}

function findOnPath(file: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of pathDirs(env)) {
    const p = join(dir, file);
    if (executable(p)) return p;
  }
  return null;
}

/** Finds `name` on PATH, then in the usual install folders. On Windows, `name.exe` wins over an npm `name.cmd`. */
export function findCli(name: string, env: NodeJS.ProcessEnv = process.env, more: string[] = []): CliLaunch | null {
  const dirs = [...pathDirs(env), ...extraBinDirs(env), ...more];
  if (process.platform === 'win32') {
    for (const dir of dirs) {
      const exe = join(dir, `${name}.exe`);
      if (executable(exe)) return { command: exe, argsPrefix: [], path: exe };
    }
    for (const dir of dirs) {
      const shim = readCmdShim(join(dir, `${name}.cmd`), env);
      if (shim) return shim;
    }
    return null;
  }
  for (const dir of dirs) {
    const p = join(dir, name);
    if (executable(p)) return { command: p, argsPrefix: [], path: p };
  }
  return null;
}

/** An explicit path from HT_CLAUDE_PATH / HT_CODEX_PATH (an .exe, an npm .cmd shim, or a POSIX executable). */
export function cliFromPath(file: string, env: NodeJS.ProcessEnv = process.env): CliLaunch | null {
  if (process.platform === 'win32' && /\.cmd$/i.test(file)) return readCmdShim(file, env);
  // Windows starts only .exe / .com files without a shell; elsewhere the file must be executable.
  if (process.platform === 'win32' && !/\.(exe|com)$/i.test(file)) return null;
  return executable(file) ? { command: file, argsPrefix: [], path: file } : null;
}

/**
 * Runs `<cli> --version` (20 s at most). Any failure is reported, so the harness is shown as unusable with the
 * reason instead of being offered: a timeout, a non-zero exit, or a file that cannot be started.
 */
export function cliVersion(found: CliLaunch, env: NodeJS.ProcessEnv, timeoutMs = 20_000): Promise<{ output: string; failure: null } | { output: null; failure: string }> {
  return new Promise((resolve) => {
    // The reason is shown in the app and logged: secrets in the CLI's own output are removed.
    const done = (r: { output: string; failure: null } | { output: null; failure: string }) => resolve(r.failure === null ? { output: redactText(r.output), failure: null } : { output: null, failure: redactText(r.failure) });
    let child: ReturnType<typeof execFile>;
    try {
      child = execFile(found.command, [...found.argsPrefix, '--version'], { timeout: timeoutMs, windowsHide: true, env }, (err, stdout, stderr) => {
        const output = `${stdout}${stderr}`;
        if (!err) return done({ output, failure: null });
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: unknown };
        const first = output.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
        const failure = e.killed && e.signal
          ? `--version timed out after ${Math.round(timeoutMs / 1000)} s`
          : typeof e.code === 'number'
            ? `--version exited with code ${e.code}${first ? `: ${first}` : ''}`
            : (e.message.split('\n')[0] ?? String(e.code ?? 'error'));
        done({ output: null, failure });
      });
    } catch (e) {
      // Some start failures throw at once instead of calling back (Windows: spawn UNKNOWN for a file that is no program).
      done({ output: null, failure: ((e as Error)?.message ?? String(e)).split('\n')[0] ?? 'error' });
      return;
    }
    child.stdin?.end();
  });
}

/** First x.y.z in a `--version` line ("2.1.317 (Claude Code)", "codex-cli 0.167.0-alpha.3"); null if none. */
export function parseVersion(text: string | null | undefined): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when `version` (a --version line) is older than `min` ("x.y.z"). An unreadable version is not "too old". */
export function olderThan(version: string | null | undefined, min: string): boolean {
  const v = parseVersion(version);
  const m = parseVersion(min)!;
  if (!v) return false;
  for (let i = 0; i < 3; i++) {
    if (v[i]! !== m[i]!) return v[i]! < m[i]!;
  }
  return false;
}

/** The x.y.z of a --version line, or the line itself (trimmed, first line) when it has none. */
export function versionLabel(text: string): string {
  const v = parseVersion(text);
  return v ? v.join('.') : (text.trim().split('\n')[0] ?? '');
}
