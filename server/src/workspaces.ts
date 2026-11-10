import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { pathKey } from './path-key.ts';
import { errorNotice, L, NoticeError, type NoticeText } from '../../shared/notices.ts';
import { unquotePath, type DirListing, type RecentWorkspace, type RecentWorkspacesResponse, type WorkspaceSource } from '../../shared/protocol.ts';

/**
 * Helpers for choosing a member's working directory: the project directories the user already worked in with Codex
 * or Claude Code, and a plain directory listing for the in-app folder browser.
 *
 * Only directory paths are collected. Codex is asked through its own app-server (`thread/list`, which reads Codex's
 * local thread index and makes no model request). For Claude Code only the `cwd` field of its local session logs
 * (`<config>/projects/<project>/<session>.jsonl`) is read; `~/.claude.json` and credential files are never opened.
 */

export interface WorkspaceHit {
  path: string;
  /** Unix milliseconds of the last use, when known. */
  at: number | null;
}

export interface RecentWorkspaceSources {
  codex?: () => Promise<WorkspaceHit[]>;
  claude?: () => Promise<WorkspaceHit[]>;
  harness?: () => WorkspaceHit[];
}

const MAX_RECENT = 60;

export async function recentWorkspaces(sources: RecentWorkspaceSources): Promise<RecentWorkspacesResponse> {
  const errors: RecentWorkspacesResponse['errors'] = [];
  const merged = new Map<string, { path: string; sources: Set<WorkspaceSource>; at: number | null }>();
  const add = (source: WorkspaceSource, hits: WorkspaceHit[]) => {
    for (const h of hits) {
      if (typeof h.path !== 'string' || !isAbsolute(h.path)) continue;
      const path = resolve(h.path);
      // Member worktrees made by Harness Team belong to one member; they are not a project to start from.
      if (path.split(/[\\/]/).some((part) => part.endsWith('.ht-worktrees'))) continue;
      const key = pathKey(path);
      const e = merged.get(key) ?? { path, sources: new Set<WorkspaceSource>(), at: null };
      e.sources.add(source);
      if (h.at !== null && (e.at === null || h.at > e.at)) e.at = h.at;
      merged.set(key, e);
    }
  };
  const run = async (source: WorkspaceSource, label: [string, string], fn: (() => Promise<WorkspaceHit[]>) | undefined) => {
    if (!fn) return;
    try {
      add(source, await fn());
    } catch (e) {
      errors.push({ source, message: L(`${label[0]}：{error}`, `${label[1]}: {error}`, { error: errorNotice(e) }) });
    }
  };
  await Promise.all([
    run('codex', ['无法读取 Codex 会话列表', 'Could not read the Codex session list'], sources.codex),
    run('claude', ['无法读取 Claude Code 会话记录', 'Could not read the Claude Code session logs'], sources.claude),
  ]);
  if (sources.harness) add('harness', sources.harness());

  const workspaces: RecentWorkspace[] = [...merged.values()]
    .filter((e) => isDir(e.path))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || a.path.localeCompare(b.path))
    .slice(0, MAX_RECENT)
    .map((e) => ({
      path: e.path,
      name: basename(e.path) || e.path,
      sources: (['codex', 'claude', 'harness'] as const).filter((s) => e.sources.has(s)),
      lastUsedAt: e.at === null ? null : new Date(e.at).toISOString(),
    }));
  return { workspaces, errors };
}

/** `<CLAUDE_CONFIG_DIR or ~/.claude>/projects`, where Claude Code keeps one folder of session logs per project. */
export function claudeProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
}

const CLAUDE_MAX_PROJECTS = 200;
const CLAUDE_FILES_PER_PROJECT = 3;
const CLAUDE_HEAD_BYTES = 256 * 1024;

/**
 * Working directories recorded in Claude Code's session logs. The project folder names encode the path lossily, so
 * the real path is taken from the `cwd` field of the newest session's first entries. Message contents are not kept.
 */
export function claudeRecentWorkspaces(projectsDir: string = claudeProjectsDir()): WorkspaceHit[] {
  if (!existsSync(projectsDir)) return [];
  // Most recently changed project folders first (a new session file updates the folder's time).
  const projects = readdirSync(projectsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(projectsDir, d.name))
    .map((dir) => ({ dir, mtime: mtimeOf(dir) }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((p) => p.dir);
  const hits: WorkspaceHit[] = [];
  for (const dir of projects) {
    let sessions: { file: string; mtime: number }[];
    try {
      sessions = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith('.jsonl'))
        .map((d) => {
          const file = join(dir, d.name);
          return { file, mtime: statSync(file).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch {
      continue;
    }
    for (const s of sessions.slice(0, CLAUDE_FILES_PER_PROJECT)) {
      const cwd = firstCwd(s.file);
      if (cwd) {
        hits.push({ path: cwd, at: s.mtime });
        break;
      }
    }
    if (hits.length >= CLAUDE_MAX_PROJECTS) break;
  }
  return hits;
}

function firstCwd(file: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(CLAUDE_HEAD_BYTES);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const lines = buf.subarray(0, n).toString('utf8').split('\n');
    if (n === buf.length) lines.pop(); // possibly cut off
    for (const line of lines) {
      if (!line.includes('"cwd"')) continue;
      try {
        const cwd = JSON.parse(line)?.cwd;
        if (typeof cwd === 'string' && cwd) return cwd;
      } catch {
        // not a complete JSON line
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

const MAX_DIR_ENTRIES = 2000;

export class DirListError extends NoticeError {
  readonly status: number;
  constructor(status: number, message: NoticeText) {
    super(message);
    this.status = status;
  }
}

/**
 * Subdirectories of `path` for the in-app folder browser (names only, never file contents). Without a path it lists
 * the starting points: the drives on Windows (or `/`) and the usual folders in the user's home directory.
 */
export function listDirectories(path: string | null): DirListing {
  if (!path) {
    const roots =
      process.platform === 'win32'
        ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
            .split('')
            .map((l) => `${l}:\\`)
            .filter((p) => isDir(p))
        : ['/'];
    return { path: null, parent: null, dirs: roots.map((p) => ({ name: p, path: p })), places: places(), truncated: false };
  }
  path = unquotePath(path);
  if (!isAbsolute(path)) throw new DirListError(400, L('请提供绝对路径', 'Give an absolute path'));
  const abs = resolve(path);
  let entries;
  try {
    if (!statSync(abs).isDirectory()) throw new DirListError(400, L('不是目录：{path}', 'Not a folder: {path}', { path: abs }));
    entries = readdirSync(abs, { withFileTypes: true });
  } catch (e) {
    if (e instanceof DirListError) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new DirListError(404, L('目录不存在：{path}', 'The folder does not exist: {path}', { path: abs }));
    if (code === 'EACCES' || code === 'EPERM') throw new DirListError(403, L('没有权限读取：{path}', 'No permission to read: {path}', { path: abs }));
    throw new DirListError(400, L('无法读取目录 {path}：{error}', 'Could not read the folder {path}: {error}', { path: abs, error: (e as Error).message }));
  }
  // Junctions and symlinks (e.g. the legacy "Application Data" links) are not followed.
  const dirs = entries
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
  const up = dirname(abs);
  return {
    path: abs,
    parent: up !== abs ? up : null,
    dirs: dirs.slice(0, MAX_DIR_ENTRIES).map((name) => {
      const path = abs.endsWith(sep) ? abs + name : abs + sep + name;
      return existsSync(join(path, '.git')) ? { name, path, git: true } : { name, path };
    }),
    places: places(),
    truncated: dirs.length > MAX_DIR_ENTRIES,
  };
}

function places(): DirListing['places'] {
  const home = homedir();
  const list: DirListing['places'] = [{ id: 'home', label: '用户目录', path: home }];
  for (const [id, label, rel] of [
    ['desktop', '桌面', 'Desktop'],
    ['oneDriveDesktop', '桌面（OneDrive）', join('OneDrive', 'Desktop')],
    ['documents', '文档', 'Documents'],
    ['downloads', '下载', 'Downloads'],
  ] as const) {
    const p = join(home, rel);
    if (isDir(p)) list.push({ id, label, path: p });
  }
  return list;
}

function mtimeOf(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The project a member workspace belongs to: the workspace itself, or for a member worktree made by Harness Team
 * (`<parent>/<repo>.ht-worktrees/<handle>`) the repository it was made from (`<parent>/<repo>`).
 */
export function projectDirOf(workspace: string): string {
  const path = resolve(workspace);
  for (let p = path; dirname(p) !== p; p = dirname(p)) {
    const name = basename(p);
    if (name.endsWith(WORKTREES_SUFFIX) && name.length > WORKTREES_SUFFIX.length) {
      return join(dirname(p), name.slice(0, -WORKTREES_SUFFIX.length));
    }
  }
  return path;
}

const WORKTREES_SUFFIX = '.ht-worktrees';

/** Most common project among member workspaces (however each is spelled; ties go to the earliest member). */
export function commonProjectDir(workspaces: (string | null | undefined)[]): string | null {
  const counts = new Map<string, { path: string; n: number; first: number }>();
  workspaces.forEach((w, idx) => {
    if (!w || !isAbsolute(w)) return;
    const path = projectDirOf(w);
    const key = pathKey(path);
    const e = counts.get(key) ?? { path, n: 0, first: idx };
    e.n++;
    counts.set(key, e);
  });
  let best: { path: string; n: number; first: number } | null = null;
  for (const e of counts.values()) if (!best || e.n > best.n || (e.n === best.n && e.first < best.first)) best = e;
  return best?.path ?? null;
}
