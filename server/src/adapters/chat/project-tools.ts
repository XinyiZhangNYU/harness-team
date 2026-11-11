import { createReadStream, type Dirent, readdirSync, statSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createContext, Script } from 'node:vm';
import { ATTACHMENT_LIMITS } from '../../../../shared/protocol.ts';
import { isPdf, sniffImage } from '../../attachments.ts';
import { realPath, relativeInside } from '../../path-key.ts';
import { redactText } from '../../redact.ts';
import { DOC_LABEL, docKind, extractDocument, ExtractError, legacyOffice } from './extract.ts';
import type { ToolDef, ToolMedia } from './wire.ts';

/**
 * Read-only tools over the chat's project folder: list a folder, find files by pattern, read a file, search text.
 * Paths never leave the project folder (symlinks and junctions are resolved first), never enter the app's data folder,
 * and skip files that usually hold secrets. Everything returned as text is redacted. read_file also reads Word, Excel,
 * PowerPoint and zip files as text, and returns images and PDFs for the model to see when its model takes them.
 */

const READ_MAX_BYTES = 256 * 1024;
const READ_MAX_LINES = 2000;
const LIST_MAX = 500;
const GLOB_MAX_RESULTS = 500;
const WALK_MAX_ENTRIES = 50_000;
const SEARCH_MAX_RESULTS = 100;
const SEARCH_MAX_FILES = 5000;
const SEARCH_MAX_FILE_BYTES = 1024 * 1024;
/** A regular expression search stops after this long (a pattern that backtracks forever stops here too). */
/** Total time a regular-expression search may take (tests lower it). */
export const SEARCH_LIMITS = { regexMs: 10_000 };
/** Office and zip files larger than this are not unpacked. */
const DOC_MAX_BYTES = 64 * 1024 * 1024;
const DOC_MAX_CHARS = 2_000_000;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next', 'target', '.gradle']);

/** Names that usually hold secrets: never listed as readable, never read, never searched. */
const SECRET_NAME =
  /^(\.env(\..*)?|\.envrc|\.npmrc|\.pypirc|\.netrc|_netrc|\.git-credentials|\.dockercfg|credentials(\.\w+)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg))$/i;

export const PROJECT_TOOL_NAMES = ['list_dir', 'glob', 'read_file', 'search'] as const;

/** What the member's model can look at (read_file returns images and PDFs only then). */
export interface MediaCaps {
  image: boolean;
  pdf: boolean;
}

export interface ToolOutput {
  content: string;
  media?: ToolMedia[];
}

export function projectToolDefs(caps: MediaCaps = { image: false, pdf: false }): ToolDef[] {
  const media = (caps.image ? ' Images (PNG, JPEG, GIF, WebP) are shown to you.' : '') + (caps.pdf ? ' PDF files are shown to you.' : '');
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
      name: 'glob',
      description:
        'Find files of the chat’s project by a name pattern. * matches within one name, ** across folders, ? one character, {a,b} either one. ' +
        'A pattern without / matches file names at any depth ("*.md"); a pattern with / matches paths below `path` ("src/**/*.test.ts"). ' +
        `Folders such as node_modules, .git, dist and build are skipped. Returns at most ${GLOB_MAX_RESULTS} paths.`,
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'The pattern.' },
          path: { type: 'string', description: 'Folder to search, relative to the project folder (default: the whole project).' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
    {
      name: 'read_file',
      description:
        `Read a file of the chat’s project (read-only). Text files: up to ${READ_MAX_LINES} lines per call. ` +
        `Word, Excel and PowerPoint files (.docx, .xlsx, .pptx) and zip archives: their text, by lines like a text file.${media}`,
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
      description: 'Search the text files of the chat’s project. Returns matching lines with file and line number.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to find, or a JavaScript regular expression when `regex` is true.' },
          regex: { type: 'boolean', description: 'Treat `query` as a regular expression (default false).' },
          case_sensitive: { type: 'boolean', description: 'Match case (default false).' },
          glob: { type: 'string', description: 'Only files matching this pattern (same rules as the glob tool), e.g. "*.ts".' },
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
export function inside(root: string, dataDir: string, p: unknown): { abs: string; rel: string } {
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

export const isBinary = (buf: Buffer) => buf.subarray(0, 8000).includes(0);

// ---- glob patterns ----

const escapeRe = (s: string) => s.replace(/[.+^$()|\\[\]{}*?]/g, '\\$&');

function globSource(g: string): string {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = g.indexOf(']', i + 2);
      if (end < 0) re += '\\[';
      else {
        let body = g.slice(i + 1, end).replace(/\\/g, '\\\\');
        if (body.startsWith('!')) body = `^${body.slice(1)}`;
        re += `[${body}]`;
        i = end;
      }
    } else if (c === '{') {
      let depth = 0;
      let end = -1;
      for (let j = i; j < g.length; j++) {
        if (g[j] === '{') depth++;
        else if (g[j] === '}' && --depth === 0) {
          end = j;
          break;
        }
      }
      if (end < 0) re += '\\{';
      else {
        const alts: string[] = [];
        let d = 0;
        let from = i + 1;
        for (let j = i + 1; j < end; j++) {
          if (g[j] === '{') d++;
          else if (g[j] === '}') d--;
          else if (g[j] === ',' && d === 0) {
            alts.push(g.slice(from, j));
            from = j + 1;
          }
        }
        alts.push(g.slice(from, end));
        re += `(?:${alts.map(globSource).join('|')})`;
        i = end;
      }
    } else re += escapeRe(c);
  }
  return re;
}

/**
 * A matcher for paths relative to the searched folder ("/" separated). A pattern without "/" matches the file name at
 * any depth. Case-insensitive on Windows, like its file system.
 */
export function globMatcher(pattern: string): (rel: string) => boolean {
  const p = pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!p) throw new ProjectToolError('empty pattern');
  const re = new RegExp(`^${globSource(p)}$`, process.platform === 'win32' ? 'i' : '');
  return p.includes('/') ? (rel) => re.test(rel) : (rel) => re.test(rel.slice(rel.lastIndexOf('/') + 1));
}

// ---- walking ----

/**
 * Files below `base` (links not followed, skipped folders and secrets left out, the data folder left out), with their
 * path relative to `base`. `visit` returns false to stop. Returns true when the walk stopped at the entry limit.
 */
async function walkFiles(base: string, dataDir: string, signal: AbortSignal | undefined, visit: (abs: string, rel: string) => Promise<boolean> | boolean): Promise<boolean> {
  const realData = realPath(dataDir);
  let seen = 0;
  let stop = false;
  let capped = false;
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (stop || signal?.aborted) return;
      if (++seen > WALK_MAX_ENTRIES) {
        stop = capped = true;
        return;
      }
      // Links are not followed (they may point out of the project).
      if (e.isSymbolicLink() || SECRET_NAME.test(e.name)) continue;
      const p = join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || p === realData) continue;
        await walk(p, rel);
      } else if (e.isFile()) {
        if (!(await visit(p, rel))) stop = true;
      }
    }
  };
  await walk(base, '');
  return capped;
}

function folder(root: string, dataDir: string, p: unknown) {
  const at = inside(root, dataDir, p);
  let st;
  try {
    st = statSync(at.abs);
  } catch {
    throw new ProjectToolError(`not found: ${at.rel}`);
  }
  if (!st.isDirectory()) throw new ProjectToolError(`not a folder: ${at.rel}`);
  return at;
}

const prefixed = (rel: string, sub: string) => (rel === '.' ? sub : `${rel}/${sub}`);

// ---- regular expressions with a time limit ----

/** Runs in a separate context so that the time limit also stops a pattern that backtracks forever. */
const MATCH_LINES = new Script('(() => { const hits = []; for (let i = 0; i < lines.length && hits.length < limit; i++) if (re.test(lines[i])) hits.push(i); return hits; })()');

class RegexLines {
  private readonly ctx: { re: RegExp; lines: string[]; limit: number };
  private readonly deadline = Date.now() + SEARCH_LIMITS.regexMs;
  timedOut = false;
  constructor(re: RegExp) {
    this.ctx = createContext({ re, lines: [] as string[], limit: 0 }) as { re: RegExp; lines: string[]; limit: number };
  }
  /** Indexes of matching lines (at most `limit`), or null once the time is up. */
  match(lines: string[], limit: number): number[] | null {
    const left = this.deadline - Date.now();
    if (left <= 0) {
      this.timedOut = true;
      return null;
    }
    this.ctx.lines = lines;
    this.ctx.limit = limit;
    try {
      return [...(MATCH_LINES.runInContext(this.ctx, { timeout: Math.max(20, left) }) as number[])];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
        this.timedOut = true;
        return null;
      }
      throw e;
    } finally {
      this.ctx.lines = [];
    }
  }
}

// ---- read_file ----

function pageLines(text: string, start: number, count: number): { lines: string[]; more: boolean } {
  const all = text.split(/\r?\n/);
  const lines: string[] = [];
  let bytes = 0;
  let i = start - 1;
  for (; i < all.length && lines.length < count && bytes <= READ_MAX_BYTES; i++) {
    lines.push(`${i + 1}\t${all[i]}`);
    bytes += all[i]!.length;
  }
  return { lines, more: i < all.length };
}

async function readHead(abs: string, size: number): Promise<Buffer> {
  const fh = await open(abs, 'r');
  try {
    const head = Buffer.alloc(Math.min(8000, size));
    await fh.read(head, 0, head.length, 0);
    return head;
  } finally {
    await fh.close();
  }
}

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

export async function runProjectTool(
  root: string,
  dataDir: string,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  caps: MediaCaps = { image: false, pdf: false },
): Promise<ToolOutput> {
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
    return { content: redactText(`${rel}:\n${lines.join('\n') || '(empty)'}${more}`) };
  }

  if (name === 'glob') {
    const pattern = typeof args.pattern === 'string' ? args.pattern : '';
    const match = globMatcher(pattern);
    const { abs, rel } = folder(root, dataDir, args.path);
    const found: string[] = [];
    const capped = await walkFiles(abs, dataDir, signal, (_p, r) => {
      if (match(r)) found.push(prefixed(rel, r));
      return found.length < GLOB_MAX_RESULTS;
    });
    const note = found.length >= GLOB_MAX_RESULTS ? `\n… stopped at ${GLOB_MAX_RESULTS} paths` : capped ? `\n… stopped after ${WALK_MAX_ENTRIES} entries` : '';
    return { content: redactText(found.length ? `${found.join('\n')}${note}` : `no files match “${pattern}” in ${rel}${note}`) };
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
    const head = await readHead(abs, st.size);
    const file = basename(abs);

    const image = sniffImage(head);
    if (image) {
      if (!caps.image) throw new ProjectToolError(`${rel} is an image, and this model does not accept images`);
      if (st.size > ATTACHMENT_LIMITS.imageBytes) throw new ProjectToolError(`${rel} is too large to show (${st.size} bytes; images up to ${mb(ATTACHMENT_LIMITS.imageBytes)})`);
      const data = (await readFile(abs)).toString('base64');
      return { content: `${rel} (${st.size} bytes): ${image} image, attached`, media: [{ type: 'image', mime: image, data, name: file }] };
    }
    if (isPdf(head)) {
      if (!caps.pdf) throw new ProjectToolError(`${rel} is a PDF file, and this model does not accept PDF files`);
      if (st.size > ATTACHMENT_LIMITS.fileBytes) throw new ProjectToolError(`${rel} is too large to show (${st.size} bytes; PDF files up to ${mb(ATTACHMENT_LIMITS.fileBytes)})`);
      const data = (await readFile(abs)).toString('base64');
      return { content: `${rel} (${st.size} bytes): PDF document, attached`, media: [{ type: 'pdf', data, name: file }] };
    }
    const kind = docKind(file, '');
    if (kind && head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b) {
      if (st.size > DOC_MAX_BYTES) throw new ProjectToolError(`${rel} is too large to unpack (${st.size} bytes; at most ${mb(DOC_MAX_BYTES)})`);
      let text: string;
      try {
        text = extractDocument(await readFile(abs), kind, DOC_MAX_CHARS, (n) => SECRET_NAME.test(n)).text;
      } catch (e) {
        if (e instanceof ExtractError) throw new ProjectToolError(`cannot read the text of ${rel}: ${e.message}`);
        throw e;
      }
      const page = pageLines(text, start, count);
      const tail = page.more ? `\n… more lines follow (next: start_line ${start + page.lines.length})` : '';
      return { content: redactText(`${rel} (${st.size} bytes; text of the ${DOC_LABEL[kind].en}):\n${page.lines.join('\n') || '(no text)'}${tail}`) };
    }
    const legacy = legacyOffice(file, '');
    if (legacy && isBinary(head)) throw new ProjectToolError(`${rel} is an old Office file, which cannot be read; it can be read once saved as ${legacy}`);
    if (isBinary(head)) throw new ProjectToolError(`not a text file: ${rel}`);

    const lines: string[] = [];
    let n = 0;
    let bytes = 0;
    let more = false;
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
    return { content: redactText(`${rel} (${st.size} bytes):\n${lines.join('\n')}${tail}`) };
  }

  if (name === 'search') {
    const query = typeof args.query === 'string' ? args.query : '';
    if (!query.trim()) throw new ProjectToolError('empty query');
    const caseSensitive = args.case_sensitive === true;
    let regex: RegexLines | null = null;
    if (args.regex === true) {
      try {
        regex = new RegexLines(new RegExp(query, caseSensitive ? '' : 'i'));
      } catch (e) {
        throw new ProjectToolError(`invalid regular expression: ${(e as Error).message}`);
      }
    }
    const only = typeof args.glob === 'string' && args.glob.trim() ? globMatcher(args.glob) : null;
    const { abs, rel } = folder(root, dataDir, args.path);
    const needle = caseSensitive ? query : query.toLowerCase();
    const results: string[] = [];
    let files = 0;
    const capped = await walkFiles(abs, dataDir, signal, async (p, r) => {
      if (only && !only(r)) return true;
      if (++files > SEARCH_MAX_FILES) return false;
      let buf: Buffer;
      try {
        if (statSync(p).size > SEARCH_MAX_FILE_BYTES) return true;
        buf = await readFile(p);
      } catch {
        return true;
      }
      if (isBinary(buf)) return true;
      const lines = buf.toString('utf8').split(/\r?\n/);
      const left = SEARCH_MAX_RESULTS - results.length;
      let hits: number[];
      if (regex) {
        const m = regex.match(lines, left);
        if (m === null) return false;
        hits = m;
      } else {
        hits = [];
        for (let i = 0; i < lines.length && hits.length < left; i++) if ((caseSensitive ? lines[i]! : lines[i]!.toLowerCase()).includes(needle)) hits.push(i);
      }
      for (const i of hits) results.push(`${prefixed(rel, r)}:${i + 1}: ${lines[i]!.trim().slice(0, 300)}`);
      return results.length < SEARCH_MAX_RESULTS;
    });
    const note = regex?.timedOut
      ? `\n… stopped: the search took longer than ${SEARCH_LIMITS.regexMs / 1000} s (simplify the pattern or narrow path / glob)`
      : results.length >= SEARCH_MAX_RESULTS
        ? `\n… stopped at ${SEARCH_MAX_RESULTS} matches`
        : files > SEARCH_MAX_FILES
          ? `\n… stopped after ${SEARCH_MAX_FILES} files`
          : capped
            ? `\n… stopped after ${WALK_MAX_ENTRIES} entries`
            : '';
    return { content: redactText(results.length ? `${results.join('\n')}${note}` : `no matches for “${query}” in ${rel}${note}`) };
  }

  throw new ProjectToolError(`unknown tool: ${name}`);
}
