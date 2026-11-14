/**
 * Files named in a member's reply become file chips that open the file in the desktop app:
 * - Codex citation directives: `:codex-file-citation{path="C:/repo/a.ts" line_range_start="3" line_range_end="9"
 *   purpose="output"}`, and an inline code span that holds nothing but an absolute local path. Each one is replaced by
 *   a link to `#ht-file-citation-N`; directives inside code spans and fenced code blocks are left as written.
 * - Markdown links to a local path (`C:/…`, `/C:/…`, `file:///…`, a path relative to the workspace): see
 *   localLinkPath; the message view draws them as chips when it renders the link.
 */
export interface FileCitation {
  path: string;
  start: number | null;
  end: number | null;
}

export const CITATION_HREF = '#ht-file-citation-';

const SCAN =
  /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(?:\n\2[^\n]*(?=\n|$)|$)|`[^`\n]+`|:{1,2}codex-file-citation\{((?:"[^"\n]*"|'[^'\n]*'|[^}"'\n])*)\}/g;
const ATTR = /([A-Za-z_][\w-]*)\s*=\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"'}]+))/g;

function lineNumber(v: string | undefined): number | null {
  if (!v || !/^\d{1,9}$/.test(v)) return null;
  const n = Number(v);
  return n > 0 ? n : null;
}

export function parseCitationAttrs(raw: string): FileCitation | null {
  const attrs: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR)) attrs[m[1]!] = m[2] ?? m[3] ?? m[4] ?? '';
  const path = attrs.path?.trim();
  if (!path) return null;
  const start = lineNumber(attrs.line_range_start);
  const end = start == null ? null : lineNumber(attrs.line_range_end);
  return { path, start, end: end != null && end > start! ? end : null };
}

function fileName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function citationLabel(c: FileCitation): string {
  const lines = c.start == null ? '' : c.end == null ? `:${c.start}` : `:${c.start}-${c.end}`;
  return fileName(c.path) + lines;
}

/** Markdown-safe link text. */
function escapeText(s: string): string {
  return s.replace(/[\\`*_[\]<>!&|~#]/g, (ch) => `\\${ch}`);
}

/**
 * An inline code span that is just an absolute local path: a Windows drive path, or a POSIX path under a folder that
 * holds users' files. Command lines (a space before an option) and wildcards stay code.
 */
export function codePath(code: string): string | null {
  const p = code.trim();
  if (!p || p.length > 1024 || /[*?"<>|]/.test(p) || /\s[-/]/.test(p)) return null;
  if (/^[A-Za-z]:[\\/]./.test(p) && p.indexOf(':', 2) === -1) return p;
  if (/^\/(?:Users|home|Volumes|tmp|private|mnt)\/./.test(p)) return p;
  return null;
}

export function extractCitations(body: string): { text: string; citations: FileCitation[] } {
  if (!body.includes('codex-file-citation') && !body.includes('`')) return { text: body, citations: [] };
  const citations: FileCitation[] = [];
  const text = body.replace(SCAN, (whole: string, _nl: string | undefined, fence: string | undefined, attrs: string | undefined) => {
    if (fence) return whole;
    if (attrs === undefined) {
      const path = whole.startsWith('`') ? codePath(whole.slice(1, -1)) : null;
      if (!path) return whole;
      citations.push({ path, start: null, end: null });
      return `[${escapeText(citationLabel(citations[citations.length - 1]!))}](${CITATION_HREF}${citations.length - 1})`;
    }
    const c = parseCitationAttrs(attrs);
    if (!c) return whole;
    citations.push(c);
    return `[${escapeText(citationLabel(c))}](${CITATION_HREF}${citations.length - 1})`;
  });
  return { text, citations };
}

/** The body as plain text for copying: each citation becomes its path, with `:line` or `:start-end`. */
export function citationsAsText(body: string): string {
  if (!body.includes('codex-file-citation')) return body;
  return body.replace(SCAN, (whole: string, _nl: string | undefined, fence: string | undefined, attrs: string | undefined) => {
    if (fence || attrs === undefined) return whole;
    const c = parseCitationAttrs(attrs);
    return c ? c.path + (c.start == null ? '' : c.end == null ? `:${c.start}` : `:${c.start}-${c.end}`) : whole;
  });
}

const LINE_SUFFIX = /(?::(\d{1,9})(?:-(\d{1,9}))?|#L(\d{1,9})(?:-L?(\d{1,9}))?)$/;

/**
 * The local file or folder a Markdown link points at, or null when it points anywhere else (a web page, another
 * scheme, a network share, an in-page anchor). Accepts `C:/…` and `C:\…`, `/C:/…`, `file:///C:/…` and
 * `file:///home/…`, POSIX absolute paths and paths relative to the workspace, percent-encoded or not, with an optional
 * `:line`, `:start-end` or `#Lline` suffix.
 */
export function localLinkPath(href: string | null | undefined): FileCitation | null {
  let p = (href ?? '').trim();
  if (!p || p.startsWith('#') || p.startsWith('?')) return null;
  if (/^file:/i.test(p)) {
    p = p.slice(5);
    if (/^\/\/localhost\//i.test(p)) p = p.slice(11);
    else if (p.startsWith('///')) p = p.slice(2);
    else if (p.startsWith('//')) return null;
  }
  if (/%[0-9A-Fa-f]{2}/.test(p)) {
    try {
      p = decodeURIComponent(p);
    } catch {
      return null;
    }
  }
  if (/^[\\/][A-Za-z]:[\\/]/.test(p)) p = p.slice(1);
  let start: number | null = null;
  let end: number | null = null;
  const m = LINE_SUFFIX.exec(p);
  if (m && m.index > 0) {
    start = lineNumber(m[1] ?? m[3]);
    end = start == null ? null : lineNumber(m[2] ?? m[4]);
    if (end != null && end <= start!) end = null;
    p = p.slice(0, m.index);
  }
  if (!p || p.includes('\0')) return null;
  if (/^[A-Za-z]:[\\/]/.test(p)) return p.indexOf(':', 2) === -1 ? { path: p, start, end } : null;
  if (/^[\\/]{2}/.test(p)) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(p)) return null;
  if (p === '/' || p === '.' || p === '..') return null;
  return { path: p, start, end };
}

/** Whether a cited path looks like a folder (a trailing separator, or a last part with no extension). */
export function looksLikeFolder(path: string): boolean {
  if (/[\\/]$/.test(path)) return true;
  return !/\.[^.\\/]+$/.test(fileName(path));
}

/** Absolute path for the desktop shell: a relative citation is taken from the member's workspace. */
export function citationPath(path: string, workspace: string | null | undefined): string | null {
  if (/^[A-Za-z]:[\\/]/.test(path) || (path.startsWith('/') && !path.startsWith('//'))) return path;
  if (!workspace || /^[\\/]/.test(path) || /^[A-Za-z]:/.test(path)) return null;
  const sep = workspace.includes('\\') ? '\\' : '/';
  return workspace.replace(/[\\/]+$/, '') + sep + path.replace(/^\.[\\/]/, '');
}
