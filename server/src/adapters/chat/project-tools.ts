import { createReadStream, type Dirent, readdirSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { realPath, relativeInside } from '../../path-key.ts';
import { redactText } from '../../redact.ts';
import type { ToolDef } from './wire.ts';

/**
 * Read-only tools over the chat's project folder: list a folder, read a file, search text. Paths never leave the
 * project folder (symlinks and junctions are resolved first), never enter the app's data folder, and skip files that
 * usually hold secrets. Everything returned is redacted.
 */

const READ_MAX_BYTES = 256 * 1024;
const READ_MAX_LINES = 2000;
const LIST_MAX = 500;
const SEARCH_MAX_RESULTS = 100;
const SEARCH_MAX_FILES = 5000;
const SEARCH_MAX_FILE_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next', 'target', '.gradle']);

/** Names that usually hold secrets: never listed as readable, never read, never searched. */
const SECRET_NAME =
  /^(\.env(\..*)?|\.envrc|\.npmrc|\.pypirc|\.netrc|_netrc|\.git-credentials|\.dockercfg|credentials(\.\w+)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg))$/i;

export const PROJECT_TOOL_NAMES = ['list_dir', 'read_file', 'search'] as const;

export function projectToolDefs(): ToolDef[] {
  return [
    {
      name: 'list_dir',
      description: 'List a folder of the chat’s project (read-only). Paths are relative to the project folder.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Folder relative to the project folder; "." or empty for the project folder itself.' } },
        additionalProperties: false,
      },
    },
    {
      name: 'read_file',
      description: `Read a text file of the chat’s project (read-only, up to ${READ_MAX_LINES} lines per call).`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File relative to the project folder.' },
          start_line: { type: 'integer', minimum: 1, description: 'First line to read (default 1).' },
          max_lines: { type: 'integer', minimum: 1, maximum: READ_MAX_LINES, description: `Lines to read (default and at most ${READ_MAX_LINES}).` },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    {
      name: 'search',
      description: 'Search the text files of the chat’s project for a string (case-insensitive). Returns matching lines with file and line number.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to find (not a regular expression).' },
          path: { type: 'string', description: 'Folder to search, relative to the project folder (default: the whole project).' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ];
}

export class ProjectToolError extends Error {}

/** A path inside the project, resolved; throws a ProjectToolError the model can read when it is not allowed. */
function inside(root: string, dataDir: string, p: unknown): { abs: string; rel: string } {
  const raw = typeof p === 'string' ? p.trim() : '';
  const abs = resolve(root, raw || '.');
  const real = realPath(abs);
  const rel = relativeInside(realPath(root), real) ?? (real === realPath(root) ? '' : null);
  if (rel === null) throw new ProjectToolError(`not inside the project folder: ${raw}`);
  if (relativeInside(realPath(dataDir), real) !== null || real === realPath(dataDir)) throw new ProjectToolError('this folder is not available');
  for (const part of rel.split('/')) {
    if (part && SECRET_NAME.test(part)) throw new ProjectToolError(`not available (may hold secrets): ${rel}`);
    if (part === '.git') throw new ProjectToolError('the .git folder is not available');
  }
  return { abs: real, rel: rel || '.' };
}

const isBinary = (buf: Buffer) => buf.subarray(0, 8000).includes(0);

export async function runProjectTool(root: string, dataDir: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  if (name === 'list_dir') {
    const { abs, rel } = inside(root, dataDir, args.path);
    let entries: Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch (e) {
      throw new ProjectToolError(`cannot list ${rel}: ${(e as NodeJS.ErrnoException).code ?? 'error'}`);
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const lines: string[] = [];
    for (const e of entries.slice(0, LIST_MAX)) {
      if (e.name === '.git') continue;
      if (e.isDirectory()) lines.push(`${e.name}/`);
      else if (e.isSymbolicLink()) lines.push(`${e.name} (link)`);
      else if (SECRET_NAME.test(e.name)) lines.push(`${e.name} (not readable)`);
      else {
        let size = '';
        try {
          size = ` (${statSync(join(abs, e.name)).size} bytes)`;
        } catch {
          // gone or unreadable: listed without a size
        }
        lines.push(`${e.name}${size}`);
      }
    }
    const more = entries.length > LIST_MAX ? `\n… ${entries.length - LIST_MAX} more entries` : '';
    return redactText(`${rel}:\n${lines.join('\n') || '(empty)'}${more}`);
  }

  if (name === 'read_file') {
    const { abs, rel } = inside(root, dataDir, args.path);
    let st;
    try {
      st = statSync(abs);
    } catch (e) {
      throw new ProjectToolError(`cannot read ${rel}: ${(e as NodeJS.ErrnoException).code ?? 'error'}`);
    }
    if (!st.isFile()) throw new ProjectToolError(`not a file: ${rel}`);
    const start = Math.max(1, Math.floor(Number(args.start_line) || 1));
    const count = Math.min(READ_MAX_LINES, Math.max(1, Math.floor(Number(args.max_lines) || READ_MAX_LINES)));
    const lines: string[] = [];
    let n = 0;
    let bytes = 0;
    let more = false;
    let binary = false;
    const fh = await open(abs, 'r');
    try {
      const head = Buffer.alloc(Math.min(8000, st.size));
      await fh.read(head, 0, head.length, 0);
      binary = isBinary(head);
    } finally {
      await fh.close();
    }
    if (binary) throw new ProjectToolError(`not a text file: ${rel}`);
    const stream = createReadStream(abs, { encoding: 'utf8' });
    let rest = '';
    try {
      outer: for await (const chunk of stream) {
        if (signal?.aborted) break;
        rest += chunk as string;
        let nl: number;
        while ((nl = rest.indexOf('\n')) >= 0) {
          const line = rest.slice(0, nl).replace(/\r$/, '');
          rest = rest.slice(nl + 1);
          n++;
          if (n < start) continue;
          if (lines.length >= count || bytes > READ_MAX_BYTES) {
            more = true;
            break outer;
          }
          lines.push(`${n}\t${line}`);
          bytes += line.length;
        }
      }
      if (!more && rest && ++n >= start && lines.length < count) lines.push(`${n}\t${rest}`);
    } finally {
      stream.destroy();
    }
    const tail = more ? `\n… more lines follow (next: start_line ${start + lines.length})` : '';
    return redactText(`${rel} (${st.size} bytes):\n${lines.join('\n')}${tail}`);
  }

  if (name === 'search') {
    const query = typeof args.query === 'string' ? args.query : '';
    if (!query.trim()) throw new ProjectToolError('empty query');
    const { abs, rel } = inside(root, dataDir, args.path);
    const needle = query.toLowerCase();
    const results: string[] = [];
    let files = 0;
    const realRoot = realPath(root);
    const realData = realPath(dataDir);
    const walk = async (dir: string): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (results.length >= SEARCH_MAX_RESULTS || files >= SEARCH_MAX_FILES || signal?.aborted) return;
        // Links are not followed (they may point out of the project).
        if (e.isSymbolicLink() || SECRET_NAME.test(e.name)) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name) || p === realData) continue;
          await walk(p);
        } else if (e.isFile()) {
          files++;
          let buf: Buffer;
          try {
            if (statSync(p).size > SEARCH_MAX_FILE_BYTES) continue;
            const fh = await open(p, 'r');
            try {
              buf = await fh.readFile();
            } finally {
              await fh.close();
            }
          } catch {
            continue;
          }
          if (isBinary(buf)) continue;
          const lines = buf.toString('utf8').split(/\r?\n/);
          for (let i = 0; i < lines.length && results.length < SEARCH_MAX_RESULTS; i++) {
            if (lines[i]!.toLowerCase().includes(needle)) {
              const relFile = relativeInside(realRoot, p) ?? basename(p);
              results.push(`${relFile}:${i + 1}: ${lines[i]!.trim().slice(0, 300)}`);
            }
          }
        }
      }
    };
    let st;
    try {
      st = statSync(abs);
    } catch {
      throw new ProjectToolError(`not found: ${rel}`);
    }
    if (!st.isDirectory()) throw new ProjectToolError(`not a folder: ${rel}`);
    await walk(abs);
    const capped = results.length >= SEARCH_MAX_RESULTS ? `\n… stopped at ${SEARCH_MAX_RESULTS} matches` : files >= SEARCH_MAX_FILES ? `\n… stopped after ${SEARCH_MAX_FILES} files` : '';
    return redactText(results.length ? `${results.join('\n')}${capped}` : `no matches for “${query}” in ${rel}${capped}`);
  }

  throw new ProjectToolError(`unknown tool: ${name}`);
}
