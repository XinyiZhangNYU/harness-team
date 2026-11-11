import { inflateRawSync } from 'node:zlib';
import { blocks, replaceBlocks, trimEndOf } from './scan.ts';

/**
 * Text out of Word, Excel and PowerPoint files (the zip-of-XML formats) and out of zip archives, without any library:
 * a small zip reader (stored and deflated entries) and tag-level XML scanning. Formatting, images, charts and formulas
 * are left out; what is left is the text a model needs to read the file. Old binary Office files (.doc, .xls, .ppt),
 * encrypted and ZIP64 archives are refused with a reason the model can read.
 */

export type DocKind = 'docx' | 'xlsx' | 'pptx' | 'zip';

const OFFICE_MIME: Record<string, DocKind> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/x-zip': 'zip',
};
const OFFICE_EXT: Record<string, DocKind> = { docx: 'docx', docm: 'docx', xlsx: 'xlsx', xlsm: 'xlsx', pptx: 'pptx', pptm: 'pptx', zip: 'zip' };
const LEGACY_EXT: Record<string, string> = { doc: '.docx', xls: '.xlsx', ppt: '.pptx' };
const LEGACY_MIME: Record<string, string> = { 'application/msword': '.docx', 'application/vnd.ms-excel': '.xlsx', 'application/vnd.ms-powerpoint': '.pptx' };

const extOf = (name: string) => /\.([a-z0-9]{1,8})$/i.exec(name.trim())?.[1]?.toLowerCase() ?? '';

/** Which extractor reads this file (by type, then by extension), or null. */
export function docKind(name: string, mime: string): DocKind | null {
  return OFFICE_MIME[mime] ?? OFFICE_EXT[extOf(name)] ?? null;
}

/** The newer format to save an old binary Office file as, or null when the file is not one. */
export function legacyOffice(name: string, mime: string): string | null {
  return LEGACY_MIME[mime] ?? LEGACY_EXT[extOf(name)] ?? null;
}

export const DOC_LABEL: Record<DocKind, { zh: string; en: string }> = {
  docx: { zh: 'Word 文档', en: 'Word document' },
  xlsx: { zh: 'Excel 表格', en: 'Excel workbook' },
  pptx: { zh: 'PowerPoint 演示文稿', en: 'PowerPoint presentation' },
  zip: { zh: 'zip 压缩包', en: 'zip archive' },
};

export class ExtractError extends Error {}

// ---- zip ----

const ZIP_MAX_ENTRIES = 20_000;
/** Unpacked bytes of one entry, and of everything read from one archive (zip bombs stop here). */
const ZIP_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const ZIP_MAX_TOTAL_BYTES = 128 * 1024 * 1024;

export interface ZipEntry {
  name: string;
  dir: boolean;
  encrypted: boolean;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/** Entry names: UTF-8 when flagged or valid; otherwise GBK (Chinese Windows zips), then Latin-1. */
function entryName(bytes: Buffer, utf8: boolean): string {
  if (utf8) return bytes.toString('utf8');
  try {
    return strictUtf8.decode(bytes);
  } catch {
    try {
      return new TextDecoder('gbk', { fatal: true }).decode(bytes);
    } catch {
      return bytes.toString('latin1');
    }
  }
}

export class ZipReader {
  readonly entries: ZipEntry[] = [];
  private readonly byName = new Map<string, ZipEntry>();
  private total = 0;
  private readonly buf: Buffer;

  constructor(buf: Buffer) {
    this.buf = buf;
    const min = Math.max(0, buf.length - 22 - 0xffff);
    let eocd = -1;
    for (let i = buf.length - 22; i >= min; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ExtractError('not a zip file');
    const count = buf.readUInt16LE(eocd + 10);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdOffset === 0xffffffff) throw new ExtractError('ZIP64 archives are not supported');
    if (count > ZIP_MAX_ENTRIES) throw new ExtractError(`too many entries (${count})`);
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ExtractError('the zip directory is damaged');
      const flags = buf.readUInt16LE(p + 8);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const name = entryName(buf.subarray(p + 46, p + 46 + nameLen), (flags & 0x800) !== 0).replace(/\\/g, '/');
      const e: ZipEntry = {
        name,
        dir: name.endsWith('/'),
        encrypted: (flags & 1) !== 0,
        method: buf.readUInt16LE(p + 10),
        compressedSize: buf.readUInt32LE(p + 20),
        size: buf.readUInt32LE(p + 24),
        offset: buf.readUInt32LE(p + 42),
      };
      this.entries.push(e);
      if (!this.byName.has(name)) this.byName.set(name, e);
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  get(name: string): ZipEntry | undefined {
    return this.byName.get(name);
  }

  read(e: ZipEntry): Buffer {
    if (e.encrypted) throw new ExtractError(`${e.name} is encrypted`);
    const b = this.buf;
    const at = e.offset;
    if (at + 30 > b.length || b.readUInt32LE(at) !== 0x04034b50) throw new ExtractError(`${e.name}: damaged entry`);
    const start = at + 30 + b.readUInt16LE(at + 26) + b.readUInt16LE(at + 28);
    const data = b.subarray(start, start + e.compressedSize);
    if (data.length < e.compressedSize) throw new ExtractError(`${e.name}: damaged entry`);
    const room = Math.min(ZIP_MAX_ENTRY_BYTES, ZIP_MAX_TOTAL_BYTES - this.total);
    if (room <= 0) throw new ExtractError('the archive unpacks to too much data');
    let out: Buffer;
    if (e.method === 0) out = data;
    else if (e.method === 8) {
      try {
        out = inflateRawSync(data, { maxOutputLength: room });
      } catch (err) {
        throw new ExtractError((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' ? `${e.name} unpacks to too much data` : `${e.name}: damaged entry`);
      }
    } else throw new ExtractError(`${e.name}: compression method ${e.method} is not supported`);
    if (out.length > room) throw new ExtractError(`${e.name} unpacks to too much data`);
    this.total += out.length;
    return out;
  }

  text(name: string): string | null {
    const e = this.get(name);
    return e ? this.read(e).toString('utf8') : null;
  }
}

// ---- XML ----

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const attr = (attrs: string, name: string) => {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(attrs);
  return m ? decodeEntities(m[2] ?? m[3] ?? '') : null;
};

/** Trailing spaces off every line, at most one empty line in a row. */
const tidy = (s: string) =>
  s
    .split('\n')
    .map((l) => trimEndOf(l, ' \t\u00a0'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** Relationship id → target path inside the package (targets are relative to `base`). */
function relationships(zip: ZipReader, relsPath: string, base: string): Map<string, { target: string; type: string }> {
  const out = new Map<string, { target: string; type: string }>();
  const xml = zip.text(relsPath);
  if (!xml) return out;
  for (const m of xml.matchAll(/<Relationship\b([^<>]*)\/?>/g)) {
    const id = attr(m[1]!, 'Id');
    const target = attr(m[1]!, 'Target');
    if (!id || !target || attr(m[1]!, 'TargetMode') === 'External') continue;
    out.set(id, { target: resolvePart(base, target), type: attr(m[1]!, 'Type') ?? '' });
  }
  return out;
}

function resolvePart(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base ? base.split('/') : [];
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

/** Collects text up to a limit; `full` turns true once the limit is reached. */
class Budget {
  out = '';
  full = false;
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  add(s: string) {
    if (this.full) return;
    if (this.out.length + s.length > this.max) {
      this.out += s.slice(0, this.max - this.out.length);
      this.full = true;
    } else this.out += s;
  }
}

// ---- Word ----

function wordText(xml: string): string {
  // Pieces, not one string: a table cell trims the spaces before it, which must not rescan everything before it.
  const out: string[] = [];
  const trimSpaces = () => {
    while (out.length) {
      const t = trimEndOf(out.at(-1)!, ' ');
      if (t) return void (out[out.length - 1] = t);
      out.pop();
    }
  };
  let cells = 0;
  const re = /<w:t(?:\s[^<>]*)?>([^<]*)<\/w:t>|<w:tab\s*\/>|<w:(?:br|cr)\b[^<>]*\/>|<(\/?)w:(p|tc|tr)\b[^<>]*?(\/?)>/g;
  for (const m of xml.matchAll(re)) {
    if (m[1] !== undefined) {
      if (m[1]) out.push(decodeEntities(m[1]));
    } else if (m[0].startsWith('<w:tab')) out.push('\t');
    else if (m[0].startsWith('<w:br') || m[0].startsWith('<w:cr')) out.push('\n');
    else {
      const close = m[2] === '/';
      const tag = m[3];
      if (m[4] === '/') {
        if (tag === 'p') out.push(cells ? ' ' : '\n');
        continue;
      }
      if (tag === 'p' && close) out.push(cells ? ' ' : '\n');
      else if (tag === 'tc') {
        if (close) {
          cells = Math.max(0, cells - 1);
          trimSpaces();
          out.push(' | ');
        } else cells++;
      } else if (tag === 'tr' && close) {
        if (out.at(-1) === ' | ') out.pop();
        out.push('\n');
      }
    }
  }
  return out.join('');
}

function docxText(zip: ZipReader, budget: Budget) {
  const main = zip.text('word/document.xml');
  if (main === null) throw new ExtractError('no word/document.xml: not a Word document');
  budget.add(tidy(wordText(main)));
  for (const [path, title] of [
    ['word/footnotes.xml', 'Footnotes'],
    ['word/endnotes.xml', 'Endnotes'],
  ] as const) {
    const xml = zip.text(path);
    const t = xml ? tidy(wordText(xml)) : '';
    if (t) budget.add(`\n\n--- ${title} ---\n${t}`);
  }
}

// ---- PowerPoint ----

function drawingText(xml: string): string {
  let out = '';
  for (const m of xml.matchAll(/<a:t>([^<]*)<\/a:t>|<a:t\s[^<>]*>([^<]*)<\/a:t>|<a:br\b[^<>]*\/>|<\/a:p>/g)) {
    if (m[1] !== undefined || m[2] !== undefined) out += decodeEntities(m[1] ?? m[2]!);
    else out += '\n';
  }
  return tidy(out);
}

function pptxText(zip: ZipReader, budget: Budget) {
  const pres = zip.text('ppt/presentation.xml');
  if (pres === null) throw new ExtractError('no ppt/presentation.xml: not a PowerPoint file');
  const rels = relationships(zip, 'ppt/_rels/presentation.xml.rels', 'ppt');
  let slides = [...pres.matchAll(/<p:sldId\b([^<>]*)\/?>/g)]
    .map((m) => rels.get(attr(m[1]!, 'r:id') ?? '')?.target)
    .filter((p): p is string => !!p && !!zip.get(p));
  if (!slides.length) {
    slides = zip.entries
      .map((e) => e.name)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  }
  slides.forEach((path, i) => {
    if (budget.full) return;
    const body = drawingText(zip.text(path) ?? '');
    const dir = path.slice(0, path.lastIndexOf('/'));
    const file = path.slice(path.lastIndexOf('/') + 1);
    const notesPath = [...relationships(zip, `${dir}/_rels/${file}.rels`, dir).values()].find((r) => r.type.endsWith('/notesSlide'))?.target;
    const notes = notesPath ? drawingText(zip.text(notesPath) ?? '') : '';
    budget.add(`${i ? '\n\n' : ''}--- Slide ${i + 1} ---\n${body || '(no text)'}${notes ? `\n[Notes] ${notes}` : ''}`);
  });
  if (!slides.length) budget.add('(no slides)');
}

// ---- Excel ----

const MAX_COLUMNS = 200;

function columnIndex(ref: string | null): number | null {
  const m = ref ? /^([A-Z]{1,3})\d+$/i.exec(ref) : null;
  if (!m) return null;
  let n = 0;
  for (const ch of m[1]!.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const runText = (xml: string) =>
  [...replaceBlocks(xml, /<rPh\b[^<>]*>/g, () => /<\/rPh>/g, () => '').matchAll(/<t(?:\s[^<>]*)?>([^<]*)<\/t>/g)].map((m) => decodeEntities(m[1]!)).join('');

function xlsxText(zip: ZipReader, budget: Budget) {
  const book = zip.text('xl/workbook.xml');
  if (book === null) throw new ExtractError('no xl/workbook.xml: not an Excel workbook');
  const sharedXml = zip.text('xl/sharedStrings.xml') ?? '';
  const shared = blocks(sharedXml, /<si(\/?)>/g, (m) => (m[1] ? null : /<\/si>/g)).map((b) => (b.inner ? runText(b.inner) : ''));
  const rels = relationships(zip, 'xl/_rels/workbook.xml.rels', 'xl');
  const sheets = [...book.matchAll(/<sheet\b([^<>]*)\/?>/g)].map((m) => ({ name: attr(m[1]!, 'name') ?? 'Sheet', path: rels.get(attr(m[1]!, 'r:id') ?? '')?.target }));
  let first = true;
  for (const sheet of sheets) {
    if (budget.full) break;
    const xml = sheet.path ? zip.text(sheet.path) : null;
    if (xml === null) continue;
    // Rows end with a newline already: one more gives the empty line between sheets.
    budget.add(`${first ? '' : '\n'}--- Sheet: ${sheet.name} ---\n`);
    first = false;
    let rows = 0;
    for (const { inner: rowXml } of blocks(xml, /<row\b[^<>]*?(\/?)>/g, (m) => (m[1] ? null : /<\/row>/g))) {
      if (budget.full) break;
      const cells: string[] = [];
      let next = 0;
      for (const { m: c, inner } of blocks(rowXml, /<c\b([^<>]*?)(\/?)>/g, (m) => (m[2] ? null : /<\/c>/g))) {
        const col = columnIndex(attr(c[1]!, 'r')) ?? next;
        next = col + 1;
        if (col >= MAX_COLUMNS) continue;
        const type = attr(c[1]!, 't');
        const v = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
        let value =
          type === 'inlineStr'
            ? runText(inner)
            : v === undefined
              ? ''
              : type === 's'
                ? (shared[Number(v)] ?? '')
                : type === 'b'
                  ? v === '1'
                    ? 'TRUE'
                    : 'FALSE'
                  : decodeEntities(v);
        value = value.replace(/[\t\r\n]+/g, ' ');
        while (cells.length < col) cells.push('');
        cells[col] = value;
      }
      if (cells.some((x) => x !== '')) {
        budget.add(`${trimEndOf(cells.join('\t'), '\t')}\n`);
        rows++;
      }
    }
    if (!rows) budget.add('(empty)\n');
  }
  if (!sheets.length) budget.add('(no sheets)');
  budget.out = trimEndOf(budget.out, '\n');
}

// ---- zip archives ----

const ZIP_LIST_MAX = 500;
const ZIP_TEXT_ENTRY_MAX = 1024 * 1024;
const SKIP_ENTRY = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$)/;

function looksLikeText(buf: Uint8Array): boolean {
  if (buf.includes(0)) return false;
  try {
    strictUtf8.decode(buf);
    return true;
  } catch {
    return false;
  }
}

function zipText(zip: ZipReader, budget: Budget, isSecret: (name: string) => boolean) {
  const files = zip.entries.filter((e) => !e.dir && !SKIP_ENTRY.test(e.name));
  budget.add(`${files.length} file${files.length === 1 ? '' : 's'}:\n`);
  for (const e of files.slice(0, ZIP_LIST_MAX)) budget.add(`${e.name} (${e.size} bytes${e.encrypted ? ', encrypted' : ''})\n`);
  if (files.length > ZIP_LIST_MAX) budget.add(`… ${files.length - ZIP_LIST_MAX} more\n`);
  for (const e of files) {
    if (budget.full) break;
    const base = e.name.slice(e.name.lastIndexOf('/') + 1);
    if (e.encrypted || e.size > ZIP_MAX_ENTRY_BYTES || isSecret(base)) continue;
    const kind = docKind(base, '');
    try {
      if (kind && kind !== 'zip') {
        const inner = new Budget(200_000);
        extractInto(new ZipReader(zip.read(e)), kind, inner, isSecret);
        budget.add(`\n--- ${e.name} (${DOC_LABEL[kind].en}) ---\n${inner.out}\n`);
      } else if (!kind && e.size <= ZIP_TEXT_ENTRY_MAX) {
        const data = zip.read(e);
        if (looksLikeText(data)) budget.add(`\n--- ${e.name} ---\n${data.toString('utf8').replace(/\r\n/g, '\n')}\n`);
      }
    } catch (err) {
      if (err instanceof ExtractError) budget.add(`\n--- ${e.name}: not read (${err.message}) ---\n`);
      else throw err;
    }
  }
  budget.out = trimEndOf(budget.out, '\n');
}

function extractInto(zip: ZipReader, kind: DocKind, budget: Budget, isSecret: (name: string) => boolean) {
  if (kind === 'docx') docxText(zip, budget);
  else if (kind === 'pptx') pptxText(zip, budget);
  else if (kind === 'xlsx') xlsxText(zip, budget);
  else zipText(zip, budget, isSecret);
}

/**
 * The text of a Word, Excel or PowerPoint file, or a zip archive's file list followed by its text files (and the text of
 * Office files inside it), at most `maxChars` characters. Entries whose names `isSecret` matches are listed, not read.
 * Throws an ExtractError the model can read when the file cannot be read.
 */
export function extractDocument(buf: Buffer, kind: DocKind, maxChars: number, isSecret: (name: string) => boolean = () => false): { text: string; truncated: boolean } {
  const budget = new Budget(maxChars);
  try {
    extractInto(new ZipReader(buf), kind, budget, isSecret);
  } catch (e) {
    if (e instanceof ExtractError) throw e;
    if (e instanceof RangeError) throw new ExtractError('the file is damaged');
    throw e;
  }
  return { text: budget.out, truncated: budget.full };
}
