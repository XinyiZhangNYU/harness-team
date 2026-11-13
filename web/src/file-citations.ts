/**
 * Codex replies cite files as directives: `:codex-file-citation{path="C:/repo/a.ts" line_range_start="3"
 * line_range_end="9" purpose="output"}`. Each one is replaced by a link to `#ht-file-citation-N` that the message view
 * draws as a file chip; directives inside code spans and fenced code blocks are left as written.
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

export function extractCitations(body: string): { text: string; citations: FileCitation[] } {
  if (!body.includes('codex-file-citation')) return { text: body, citations: [] };
  const citations: FileCitation[] = [];
  const text = body.replace(SCAN, (whole: string, _nl: string | undefined, fence: string | undefined, attrs: string | undefined) => {
    if (fence || attrs === undefined) return whole;
    const c = parseCitationAttrs(attrs);
    if (!c) return whole;
    citations.push(c);
    return `[${escapeText(citationLabel(c))}](${CITATION_HREF}${citations.length - 1})`;
  });
  return { text, citations };
}

/** Absolute path for the desktop shell: a relative citation is taken from the member's workspace. */
export function citationPath(path: string, workspace: string | null | undefined): string | null {
  if (/^[A-Za-z]:[\\/]/.test(path) || (path.startsWith('/') && !path.startsWith('//'))) return path;
  if (!workspace || /^[\\/]/.test(path) || /^[A-Za-z]:/.test(path)) return null;
  const sep = workspace.includes('\\') ? '\\' : '/';
  return workspace.replace(/[\\/]+$/, '') + sep + path.replace(/^\.[\\/]/, '');
}
