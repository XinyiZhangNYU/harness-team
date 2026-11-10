/**
 * Removes secrets from what Harness Team stores, shows, sends to the browser or writes to logs: errors and stderr a
 * runtime passes on, the chat text and tool output of a turn, notices, protocol receipts. Only these output copies are
 * redacted; what goes to the runtime (prompts, approval answers, settings) is never changed.
 */

const R = '[redacted]';
/** Characters of an unquoted value. */
const VCH = String.raw`[^\s"'\\,;}&<>)]`;
const KEY_NAMES = String.raw`api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|(?:access|auth|refresh|id|session|security|bearer)[_-]?token|token|secret|password|passwd|credentials?`;
const HEADERS = String.raw`(?:proxy-)?authorization|set-cookie|cookie|x-api-key|api-key|x-goog-api-key|x-amz-security-token|x-auth-token`;
const FLAGS = String.raw`api-key|token|auth-token|access-token|password|secret|client-secret`;
const FSEP = String.raw`(?:=|(?:[ \t]|\\+t)+)`;
/** Name, then ":" or "=", on one line; quotes around the name allowed ("token": , ' token ' =, \"token\": in JSON text). */
const SEP = String.raw`[ \t]*(?:\\*["'][ \t]*)?[:=][ \t]*`;
/** A header name's separator: ":" only (cookie=… in a query string is not a header). */
const HSEP = String.raw`[ \t]*(?:\\*["'][ \t]*)?:[ \t]*`;
const HEADER_START = new RegExp(String.raw`(?<![A-Za-z0-9-])(${HEADERS})${HSEP}(?:\r?\n[ \t]+)*`, 'gi');
/** Whitespace in a JSON object, optionally itself serialized into a string. */
const JSON_SPACE = String.raw`(?:[ \t\r\n]|\\+[nrt])*`;
/** Only a "name" property marks a list entry: a header name under another key (type, kind, note) is ordinary content. */
const HEADER_LIST_FIRST = new RegExp(
  String.raw`(?<!\\)(\\*["'])name\1${JSON_SPACE}:${JSON_SPACE}\1(?:${HEADERS})\1${JSON_SPACE},${JSON_SPACE}(\\*["'])value\2${JSON_SPACE}:${JSON_SPACE}(\\*["'])`, 'gi',
);
const HEADER_LIST_VALUE = new RegExp(
  String.raw`(?<!\\)(\\*["'])value\1${JSON_SPACE}:${JSON_SPACE}(\\*["'])`, 'gi',
);
const HEADER_LIST_NAME = new RegExp(
  String.raw`${JSON_SPACE},${JSON_SPACE}(\\*["'])name\1${JSON_SPACE}:${JSON_SPACE}(\\*["'])(?:${HEADERS})\2`, 'iy',
);

/**
 * A reference to a secret in code, not the secret itself: process.env.X, import.meta.env.X, env.X, os.environ[…],
 * os.getenv(…), ${X}, $X, %X%. The whole value must be the reference.
 */
const REFERENCE =
  /^(?:(?:process\.env|import\.meta\.env|env|os\.environ)(?:\.[A-Za-z_$][\w$]*)*(?:\[|\.get\()?|os\.getenv\(|Deno\.env\.get\(|\$\{[A-Za-z_]\w*\}?|\$[A-Za-z_]\w*|%[A-Za-z_]\w*%)$/;
/** These identifiers are references only in a declaration or a type/property expression. */
const CODE_REFERENCE = /^(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(|\[)?|\[\]|[\[({])$/;
const TYPE_IDENTIFIER = /^(?:[A-Z][a-z]+(?:[A-Z][a-z]+)*|[a-z]+(?:[A-Z][a-z]+)+)$/;
/** Type names, literal constants and diagnostic words do not carry a credential value. */
const WORD = /^(?:string|number|bigint|boolean|symbol|object|any|unknown|never|void|undefined|null|true|false|missing|required|optional|unset)$/;

/**
 * Quoted values after a secret's name are literals, even when short. Unquoted code references, identifiers and known
 * type/diagnostic words are preserved. A value that is only "[redacted]" was redacted already.
 */
function isSecret(value: string, quoted: boolean, context: 'field' | 'type' | 'code' = 'field'): boolean {
  if (value === R || value.length === 0) return false;
  if (quoted) return true;
  if (REFERENCE.test(value)) return false;
  if (context === 'code' && CODE_REFERENCE.test(value)) return false;
  if (context === 'type' && (WORD.test(value) || TYPE_IDENTIFIER.test(value) || value === 'YOUR_API_KEY_HERE')) return false;
  return true;
}

function hasJwtClaims(header: string, payload: string): boolean {
  try {
    const h = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return !!h && typeof h === 'object' && !Array.isArray(h) && typeof h.alg === 'string' && !!p && typeof p === 'object' && !Array.isArray(p);
  } catch {
    return false;
  }
}

const QUOTED_SECRET = new RegExp(
  String.raw`(?:(?<![A-Za-z0-9-])(${HEADERS})${HSEP}(?:\r?\n[ \t]+)*|(?<![A-Za-z0-9])(?:${KEY_NAMES})(?![A-Za-z0-9])${SEP}|--(?:${FLAGS})${FSEP})(?:\([ \t]*)*(\\*["'])`,
  'gi',
);

/** Lexical JSON-string state only: no source text survives a streamed prefix. */
type EncodingState = { quoted: boolean; escape: boolean; unicode: string | null; child?: EncodingState };
const encodingState = (): EncodingState => ({ quoted: false, escape: false, unicode: null });
function cloneEncoding(s: EncodingState): EncodingState {
  return { ...s, ...(s.child ? { child: cloneEncoding(s.child) } : {}) };
}
function encodedCharacter(s: EncodingState, c: string): void {
  if (!s.quoted) {
    if (c === '"') { s.quoted = true; s.child = encodingState(); }
    return;
  }
  const decoded = (value: string) => { if (s.child) encodedCharacter(s.child, value); };
  if (s.unicode !== null) {
    if (!/^[0-9a-f]$/i.test(c)) { s.quoted = false; s.escape = false; s.unicode = null; delete s.child; return; }
    s.unicode += c;
    if (s.unicode.length === 4) { decoded(String.fromCharCode(parseInt(s.unicode, 16))); s.unicode = null; }
    return;
  }
  if (s.escape) {
    s.escape = false;
    if (c === 'u') { s.unicode = ''; return; }
    const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
    if (Object.hasOwn(escapes, c)) decoded(escapes[c]!);
    else { s.quoted = false; delete s.child; }
    return;
  }
  if (c === '\\') { s.escape = true; return; }
  if (c === '"' || c.charCodeAt(0) < 0x20) { s.quoted = false; delete s.child; return; }
  decoded(c);
}
function advanceEncoding(state: EncodingState, text: string): void {
  for (const c of text) encodedCharacter(state, c);
}
class QuoteContext {
  completedTo = -1;
  waiting: PendingScan | undefined;
  private cursor = 0;
  private state: EncodingState;
  private text: string;
  constructor(text: string, initial = encodingState()) { this.text = text; this.state = cloneEncoding(initial); }
  depthAt(at: number): number {
    while (this.cursor < at) encodedCharacter(this.state, this.text[this.cursor++]!);
    let depth = 0, s: EncodingState | undefined = this.state;
    while (s?.quoted) { depth++; s = s.child; }
    return depth;
  }
}

type QuotedEnd = { value: number; after: number; close?: string; parentEnd?: true };

/**
 * `kept()` is the earliest position the next scan reads; text before it may be dropped (with `shift`). A stream only
 * uses the result to decide when to look at its held text again, so a lookback cut short there delays that at most.
 */
type PendingScan = { scan(text: string, final?: boolean): QuotedEnd | null; shift(n: number): void; kept(): number };
/** Read the adjacent property syntax once; legal whitespace must not erase its JSON context. */
function propertyQuoteAt(text: string, at: number): { quote: string; opening: number; closing: number } | null {
  let i = at - 1;
  while (i >= 0 && /[ \t]/.test(text[i]!)) i--;
  if (text[i--] !== ':') return null;
  while (i >= 0 && /[ \t]/.test(text[i]!)) i--;
  const quote = text[i--];
  if (quote !== '"' && quote !== "'") return null;
  let closing = 0;
  while (text[i] === '\\') { closing++; i--; }
  const nameEnd = i;
  while (i >= 0 && /[A-Za-z0-9_-]/.test(text[i]!)) i--;
  if (i === nameEnd || text[i--] !== quote) return null;
  let opening = 0;
  while (text[i] === '\\') { opening++; i--; }
  return { quote, opening, closing };
}
/** A quoted property name and value use the same JSON encoding layer. */
function jsonPropertyAt(text: string, at: number, escaped: number): boolean {
  const property = propertyQuoteAt(text, at);
  return property?.quote === '"' && property.opening === escaped && property.closing === escaped;
}
function quotedPropertyAt(text: string, at: number): boolean {
  return propertyQuoteAt(text, at) !== null;
}
/** The remainder of an HTTP header is sensitive, including further quoted and unquoted tokens. */
class HeaderTailScanner implements PendingScan {
  private cursor: number;
  private unit: number;
  private slashes = 0;
  private newline: { at: number; cr: boolean } | undefined;
  constructor(from: number, depth: number) { this.cursor = from; this.unit = 2 ** depth; }
  shift(n: number): void { this.cursor -= n; if (this.newline) this.newline.at -= n; }
  kept(): number { return this.cursor; }
  scan(text: string, final = false): QuotedEnd | null {
    const end = (at: number): QuotedEnd => ({ value: at, after: at });
    while (this.cursor < text.length) {
      const i = this.cursor, c = text[i]!;
      if (c === '\\') { this.slashes++; this.cursor++; continue; }
      if (this.unit > 1 && c === '"' && this.slashes < this.unit - 1) return end(this.newline?.at ?? i - this.slashes);
      const escapedControl = this.unit > 1 && this.slashes % this.unit === this.unit / 2 && /[nrt]/.test(c);
      const logical = escapedControl ? ({ n: '\n', r: '\r', t: '\t' } as Record<string, string>)[c]! : c;
      const at = escapedControl ? i - this.unit / 2 : i;
      if (this.newline) {
        if (this.slashes >= this.unit) return end(this.newline.at);
        if (this.newline.cr && logical === '\n') this.newline.cr = false;
        else if (logical === ' ' || logical === '\t') this.newline = undefined;
        else return end(this.newline.at);
      } else if (logical === '\r' || logical === '\n') {
        this.newline = { at, cr: logical === '\r' };
      }
      this.slashes = 0;
      this.cursor++;
    }
    return final ? end(this.newline?.at ?? text.length) : null;
  }
}
/** A list value can precede its name. Wait only through this object's closing boundary, across formatted lines. */
class HeaderListScanner implements PendingScan {
  private cursor: number;
  private unit: number;
  private slashes = 0;
  private quote: string | undefined;
  private nested = 0;
  constructor(from: number, depth: number) { this.cursor = from; this.unit = 2 ** depth; }
  shift(n: number): void { this.cursor -= n; }
  kept(): number { return this.cursor; }
  scan(text: string, final = false): QuotedEnd | null {
    while (this.cursor < text.length) {
      const i = this.cursor, c = text[i]!;
      if (c === '\\') { this.slashes++; this.cursor++; continue; }
      if (c === '"' && this.unit > 1 && this.slashes < this.unit - 1) return { value: i - this.slashes, after: i };
      if (c === '"' || c === "'") {
        const escaped = c === '"' ? this.unit - 1 : 0;
        if (this.slashes % (2 * this.unit) === escaped) {
          if (!this.quote) this.quote = c;
          else if (this.quote === c) this.quote = undefined;
        }
      } else if (!this.quote) {
        if (c === '{' || c === '[') this.nested++;
        else if (c === '}' || c === ']') {
          if (this.nested === 0) return { value: i, after: i + 1 };
          this.nested--;
        }
      }
      this.slashes = 0;
      this.cursor++;
    }
    return final ? { value: text.length, after: text.length } : null;
  }
}
/** Spaces (or escapes) between a secret name and its value: the stream looks again once the value starts. */
class GapScanner implements PendingScan {
  private cursor: number;
  constructor(from: number) { this.cursor = from; }
  shift(n: number): void { this.cursor -= n; }
  kept(): number { return this.cursor; }
  scan(text: string): QuotedEnd | null {
    while (this.cursor < text.length && /[ \t(\\]/.test(text[this.cursor]!)) this.cursor++;
    return this.cursor < text.length ? { value: this.cursor, after: this.cursor } : null;
  }
}
function headerListEnd(text: string, at: number, context: QuoteContext): number {
  const scan = new HeaderListScanner(at, context.depthAt(at));
  const end = scan.scan(text);
  if (end) context.completedTo = end.after;
  else context.waiting = scan;
  return end?.after ?? -1;
}

class RawHeaderScanner implements PendingScan {
  private quote: QuoteScanner;
  private tail: HeaderTailScanner | undefined;
  private delimiter: string;
  private start: number;
  private depth: number;
  private quotedEnd: QuotedEnd | undefined;
  constructor(text: string, at: number, context: QuoteContext) {
    this.depth = context.depthAt(at);
    this.quote = new QuoteScanner(text, at, context);
    let q = at;
    while (text[q] === '\\') q++;
    this.delimiter = text.slice(at, q + 1);
    this.start = q + 1;
  }
  shift(n: number): void {
    this.quote.shift(n);
    this.tail?.shift(n);
    this.start -= n;
    if (this.quotedEnd) { this.quotedEnd.value -= n; this.quotedEnd.after -= n; }
  }
  kept(): number { return this.tail ? this.tail.kept() : this.quote.kept(); }
  scan(text: string, final = false): QuotedEnd | null {
    if (!this.tail) {
      const q = this.quote.scan(text, final);
      if (!q) return null;
      if (q.parentEnd) return q;
      this.quotedEnd = q;
      this.tail = new HeaderTailScanner(q.after, this.depth);
    }
    const end = this.tail.scan(text, final);
    if (!end) return null;
    const q = this.quotedEnd!;
    if (q.value === this.start && /^\s*$/.test(text.slice(q.after, end.value))) return q;
    return { ...end, close: this.delimiter };
  }
}

/** A resumable scan: incomplete escape/quote pairs retain only their short lookahead. */
class QuoteScanner {
  private cursor: number;
  private quote: string;
  private quoteEscaped: number;
  private quoted = true;
  private concatenated = false;
  private slashes = 0;
  private unit: number;
  private firstDelimiter: string;
  private markup: string;
  private strictJson: boolean;
  private boundaryProbe: { start: number; at: number } | undefined;
  constructor(text: string, at: number, context: QuoteContext, jsonProperty = false) {
    let q = at;
    while (text[q] === '\\') q++;
    this.quote = text[q]!;
    this.quoteEscaped = q - at;
    this.unit = this.quote === '"' ? this.quoteEscaped + 1 : 2 ** context.depthAt(q);
    this.strictJson = this.quote === '"' && (jsonProperty || jsonPropertyAt(text, at, this.quoteEscaped));
    this.firstDelimiter = '\\'.repeat(this.quoteEscaped) + this.quote;
    this.cursor = q + 1;
    const before = text.slice(Math.max(0, at - 128), at);
    this.markup = /(?:^|\s)(\x60+|\*{1,2})[^\s]*$/.exec(before)?.[1] ?? '';
  }
  /** A published prefix has been removed from the pending buffer. */
  shift(n: number): void {
    this.cursor -= n;
    if (this.boundaryProbe) { this.boundaryProbe.start -= n; this.boundaryProbe.at -= n; }
  }
  /** The backtick count before a closing quote looks back a little. */
  kept(): number { return this.cursor - 64; }
  scan(text: string, final = false): QuotedEnd | null {
    let runEnd = -1;
    const boundary = (i: number): boolean | null => {
      if (i === text.length) return final ? true : null;
      const c = text[i]!;
      if (/[\s,;}&<>)\]|]/.test(c)) return true;
      if (this.markup && text.startsWith(this.markup, i)) return true;
      if (!final && this.markup && this.markup.startsWith(text.slice(i))) return null;
      if (c !== '\\' && c !== '"') return false;
      let j = this.boundaryProbe?.start === i ? this.boundaryProbe.at : i;
      while (text[j] === '\\') j++;
      if (j === text.length && !final) { this.boundaryProbe = { start: i, at: j }; return null; }
      this.boundaryProbe = undefined;
      const count = j - i;
      runEnd = j;
      if (this.unit > 1 && text[j] === '"' && count < this.unit - 1) return true;
      if (this.unit > 1 && count % this.unit === this.unit / 2 && /[nrt]/.test(text[j] ?? '')) return true;
      return false;
    };
    while (this.cursor < text.length) {
      const i = this.cursor, c = text[i]!;
      if (!this.quoted) {
        const ends = boundary(i);
        if (ends === null) return null;
        if (ends) return { value: i, after: i, close: this.firstDelimiter };
        if (c === '\\' && runEnd > i) {
          this.slashes = runEnd - i;
          this.cursor = runEnd;
          continue;
        }
        if (c === '"' || c === "'") {
          this.quote = c;
          this.quoteEscaped = c === '"' ? this.unit - 1 : 0;
          this.quoted = true;
        }
        this.slashes = 0;
        this.cursor++;
        continue;
      }
      // An enclosing JSON string ended before its embedded value closed.
      if (this.unit > 1 && c === '"' && this.slashes < this.unit - 1) {
        return { value: i - this.slashes, after: i + 1, parentEnd: true };
      }
      if (c === this.quote && this.slashes >= this.quoteEscaped && (this.slashes - this.quoteEscaped) % this.unit === 0) {
        const literalSlashes = (this.slashes - this.quoteEscaped) / this.unit;
        let ticks = 0;
        for (let j = i - this.slashes - 1; text[j] === '\x60'; j--) ticks++;
        if (literalSlashes % 2 === 0 && (this.strictJson || ticks % 2 === 0)) {
          if (this.strictJson) return { value: i - this.quoteEscaped, after: i + 1 };
          const delimiter = '\\'.repeat(this.quoteEscaped) + this.quote;
          if (!final && text.length < i + 1 + delimiter.length && delimiter.startsWith(text.slice(i + 1))) return null;
          if (text.startsWith(delimiter, i + 1)) {
            this.cursor = i + 1 + delimiter.length;
            this.slashes = 0;
            continue;
          }
          const next = boundary(i + 1);
          if (next === null) return null;
          if (next) return this.concatenated
            ? { value: i + 1, after: i + 1, close: this.firstDelimiter }
            : { value: i - this.quoteEscaped, after: i + 1 };
          this.quoted = false;
          this.concatenated = true;
        }
      }
      this.slashes = c === '\\' ? this.slashes + 1 : 0;
      this.cursor++;
    }
    return !this.quoted && final ? { value: text.length, after: text.length, close: this.firstDelimiter } : null;
  }
}
/**
 * Parse quoted sensitive values at their JSON encoding layer. Adjacent fragments belong to the same
 * argument; a complete value never borrows a later quote. The stream can resume an unfinished scan.
 */
function quotedEnd(text: string, at: number, final = true, context = new QuoteContext(text), rawHeader = false): QuotedEnd | null {
  const scan: PendingScan = rawHeader ? new RawHeaderScanner(text, at, context) : new QuoteScanner(text, at, context);
  const result = scan.scan(text, final);
  if (result) context.completedTo = result.after;
  else context.waiting = scan;
  return result;
}

function redactQuotedSecrets(text: string, initial = encodingState()): string {
  const context = new QuoteContext(text, initial);
  QUOTED_SECRET.lastIndex = 0;
  const parts: string[] = [];
  let from = 0;
  for (let m = QUOTED_SECRET.exec(text); m; m = QUOTED_SECRET.exec(text)) {
    const start = m.index + m[0].length;
    const at = start - m[2]!.length;
    const end = quotedEnd(text, at, true, context, !!m[1] && !quotedPropertyAt(text, at));
    const to = end?.value ?? text.length;
    const value = text.slice(start, to);
    const scheme = m[1] ? /^(?:bearer|basic|digest|token)[ \t]+/i.exec(value)?.[0] ?? '' : '';
    parts.push(text.slice(from, start), value ? scheme + R : '', end?.close ?? '');
    from = to;
    QUOTED_SECRET.lastIndex = end?.after ?? text.length;
    if (!end) break;
  }
  if (!parts.length) return text;
  parts.push(text.slice(from));
  return parts.join('');
}


/** A bare HTTP value follows the same logical line rules as the tail of a quoted header. */
function redactBareHeaders(text: string, initial: EncodingState): string {
  const context = new QuoteContext(text, initial), parts: string[] = [];
  HEADER_START.lastIndex = 0;
  let from = 0;
  for (let m = HEADER_START.exec(text); m; m = HEADER_START.exec(text)) {
    const at = m.index + m[0].length, q = quoteAt(text, at);
    if (text[q] === '"' || text[q] === "'") continue;
    const end = quotedPropertyAt(text, at)
      ? endOf(X_BARE, text, at)
      : new HeaderTailScanner(at, context.depthAt(at)).scan(text, true)!.value;
    if (end <= at) continue;
    const value = text.slice(at, end), scheme = /^(?:bearer|basic|digest|token)[ \t]+/i.exec(value)?.[0] ?? '';
    parts.push(text.slice(from, at), scheme + R);
    from = end;
    HEADER_START.lastIndex = end;
  }
  if (!parts.length) return text;
  parts.push(text.slice(from));
  return parts.join('');
}

/** Scan the value, not an escape-count-specific regex, in adjacent name/value header-list entries. */
function redactHeaderLists(text: string, initial: EncodingState): string {
  for (const nameFirst of [true, false]) {
    const start = nameFirst ? HEADER_LIST_FIRST : HEADER_LIST_VALUE;
    const context = new QuoteContext(text, initial), parts: string[] = [];
    let from = 0;
    start.lastIndex = 0;
    for (let m = start.exec(text); m; m = start.exec(text)) {
      const delimiter = m[nameFirst ? 3 : 2]!, property = m[nameFirst ? 2 : 1]!;
      const value = m.index + m[0].length, at = value - delimiter.length;
      const end = new QuoteScanner(text, at, context, delimiter.endsWith('"') && delimiter === property).scan(text, true);
      start.lastIndex = end?.after ?? text.length;
      if (!nameFirst && (!end || !stick(HEADER_LIST_NAME, text, end.after))) continue;
      const to = end?.value ?? text.length;
      parts.push(text.slice(from, value), to > value ? R : '', end?.close ?? '');
      from = to;
      if (!end) break;
    }
    if (parts.length) { parts.push(text.slice(from)); text = parts.join(''); }
  }
  return text;
}

function isHeaderField(name: string, sep: string, at: number, text: string): boolean {
  if (!sep.includes(':') || !SECRET_HEADER.test(name)) return false;
  const before = text.slice(Math.max(0, at - 160), at);
  let start = before.length;
  while (start > 0 && /[A-Za-z0-9-]/.test(before[start - 1]!)) start--;
  return SECRET_HEADER.test(before.slice(start) + name);
}


/** Keep only syntax classes across published chunks, never a source identifier or value. */
function codePrefixAt(text: string, at = text.length, initial = ''): string {
  const char = (i: number) => i >= 0 ? text[i] ?? '' : initial[initial.length + i] ?? '';
  let i = at - 1;
  while (/[ \t]/.test(char(i)) && char(i)) i--;
  const gap = i < at - 1;
  const member = char(i) === '.';
  if (member) {
    i--;
    while (/[ \t]/.test(char(i)) && char(i)) i--;
  }
  const end = i + 1;
  while (/[\w$]/.test(char(i)) && char(i)) i--;
  const start = i + 1;
  if (start === end || !/[A-Za-z_$]/.test(char(start))) return '';
  if (member) return '_.' + (gap ? ' ' : '');
  let name = '_';
  if (end - start <= 5) {
    const word = Array.from({ length: end - start }, (_, p) => char(start + p)).join('');
    if (/^(?:const|let|var)$/.test(word)) name = word;
  }
  return name + (gap ? ' ' : '');
}
function codeAssignmentAt(text: string, at: number, initial = ''): boolean {
  return /^(?:_\. ?|(?:const|let|var) )$/.test(codePrefixAt(text, at, initial));
}
/** A wrapping expression is exempt only when it contains an identifier/property reference. */
function parenthesizedReferenceEnd(text: string, at: number, final = true, checked?: { to: number }): number {
  let i = at, depth = 0;
  const space = () => { while (/[ \t]/.test(text[i] ?? '') && i < text.length) i++; };
  const incomplete = () => i >= text.length && !final ? -1 : 0;
  while (text[i] === '(') { depth++; i++; space(); }
  if (!depth) return 0;
  const identifier = () => {
    if (!/[A-Za-z_$]/.test(text[i] ?? '')) return false;
    i++;
    while (/[\w$]/.test(text[i] ?? '') && i < text.length) i++;
    return true;
  };
  if (!identifier()) return incomplete();
  for (;;) {
    space();
    if (text[i] !== '.') break;
    i++; space();
    if (!identifier()) return incomplete();
  }
  while (depth > 0) {
    space();
    if (text[i] !== ')') return incomplete();
    i++; depth--;
  }
  const end = i;
  space();
  if (i >= text.length) return final ? end : -1;
  if (/[,;)}\]\r\n]/.test(text[i]!)) return end;
  if (checked) checked.to = i + 1;
  return 0;
}
function redactField(m: string, ...groups: string[]): string {
  const [name = '', sep = '', value = '', offset = '', text = '', initial = ''] = groups;
  const at = Number(offset);
  if (isHeaderField(name, sep, at, text)) return m;
  const code = codeAssignmentAt(text, at, initial);
  const valueAt = at + name.length + sep.length;
  if (code && value.startsWith('(') && parenthesizedReferenceEnd(text, valueAt) > 0) return m;
  // Direct quoted literals inside wrapping parentheses were already handled by the quoted scanner.
  if (/^\(+$/.test(value)) {
    let q = valueAt;
    while (text[q] === '(' || text[q] === ' ' || text[q] === '\t') q++;
    while (text[q] === '\\') q++;
    if (text[q] === '"' || text[q] === "'") return m;
  }
  const context = sep.includes(':') ? 'type' : code ? 'code' : 'field';
  return isSecret(value, /["']$/.test(sep), context) ? name + sep + R : m;
}

type Rule = [RegExp, string | ((m: string, ...groups: string[]) => string)];

// Every rule starts at a fixed word or shape, and no part of a pattern can match the same text in two ways, so the
// rules take linear time. Which values are secrets is decided in code on the captured value, not by the pattern.
// Quoted fields and arguments share one boundary for actual and JSON-escaped line breaks.
const RULES: Rule[] = [
  // The Team MCP token in the URL path.
  [/\/team-mcp\/[A-Za-z0-9_-]+/g, '/team-mcp/[redacted]'],
  // PEM private keys (also inside JSON strings, where the line breaks are escaped).
  [/-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?(?:-----END \1PRIVATE KEY-----|$)/g, '[redacted private key]'],
  // user:password@ in a URL.
  [/\b([a-z][a-z0-9+.-]{1,15}:\/\/)[^\s/@:"'<>]+:[^\s/@"<>]+@/gi, '$1[redacted]@'],
  // Authorization schemes on their own: 8+ characters with a digit or punctuation, or 16+ (so "Basic configuration" stays).
  [/\b(bearer|basic)[ \t]+(?!\[redacted\])(?:(?=[A-Za-z0-9._~+/=-]*[0-9._~+/=-])[A-Za-z0-9._~+/=-]{8,}|[A-Za-z0-9._~+/=-]{16,})/gi, '$1 [redacted]'],
  // name=value, name: value, "name": "value" for API keys, tokens, secrets and passwords (DEEPSEEK_API_KEY=…, ?token=…).
  [
    new RegExp(String.raw`(?<![A-Za-z0-9])(${KEY_NAMES})(?![A-Za-z0-9])(${SEP}\\?["']?)(${VCH}+)`, 'gi'),
    redactField,
  ],
  // Unquoted command-line arguments; quoted arguments share the scanner above.
  [
    new RegExp(String.raw`(--(?:${FLAGS})${FSEP})([^\s"\'\\]+)`, 'gi'),
    (m, flag, value) => !value || value === R || REFERENCE.test(value) ? m : flag + R,
  ],
  // Known key shapes.
  [/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-[redacted]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, R],
  [/\bya29\.[0-9A-Za-z_-]{20,}/g, 'ya29.[redacted]'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g, R],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, R],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, R],
  // A JSON Web Token on its own (header.payload.signature, both parts JSON in base64url).
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, R],
  // JSON whitespace changes the base64 prefix; verify these wider candidates instead of treating dotted words as JWTs.
  [
    /(?<![A-Za-z0-9_-])([A-Za-z0-9_-]{8,})\.([A-Za-z0-9_-]{2,})\.[A-Za-z0-9_-]*/g,
    (m, header, payload) => (hasJwtClaims(header, payload) ? R : m),
  ],
];

export function redactText(text: string): string {
  return redactInContext(text, encodingState());
}
function redactInContext(text: string, initial: EncodingState, codeBefore = ''): string {
  let out = redactHeaderLists(redactQuotedSecrets(text, initial), initial);
  out = redactBareHeaders(out, initial);
  for (const [re, to] of RULES) out = typeof to === 'string' ? out.replace(re, to) : out.replace(re, to === redactField ? (m, ...groups) => redactField(m, ...groups, codeBefore) : to);
  return out;
}

/**
 * Where a rule can start a match that goes past a space: a secret's name, a header name, "value" of a header list, an
 * Authorization scheme, a command-line flag, a URL scheme, a private key. Every other rule matches within one word.
 */
const START = new RegExp(
  [
    String.raw`(?<d>\b(?:const|let|var)\b)`,
    String.raw`(?<k>(?<![A-Za-z0-9])(?:${KEY_NAMES})(?![A-Za-z0-9]))`,
    String.raw`(?<h>(?<![A-Za-z0-9-])(?:${HEADERS})(?![A-Za-z0-9-]))`,
    String.raw`(?<v>(?<!\\)\\*["']value\\*["'])`,
    String.raw`(?<n>(?<!\\)\\*["']name\\*["'])`,
    String.raw`(?<b>\b(?:bearer|basic)\b)`,
    String.raw`(?<f>--(?:${FLAGS})(?![A-Za-z0-9-]))`,
    String.raw`(?<u>\b[a-z][a-z0-9+.-]{1,15}:\/\/)`,
    String.raw`(?<p>-----BEGIN )`,
  ].join('|'),
  'gi',
);
// What each of them can take after it (as much as the text so far allows).
const X_KEY = new RegExp(String.raw`[ \t]*(?:\\*["'][ \t]*)?(?:[:=][ \t]*(?:(["'])(?:(?!\1)[^\\\r\n]|\\[^\r\n])*\1?|(\\?["']?)))?`, 'y');
// The run of value characters after X_KEY's group 2, measured by bareEnd.
const X_BARE = new RegExp(`${VCH}*`, 'y');
const X_ASSIGN = new RegExp(SEP, 'y');
const X_HEADER_VALUE = /[ \t]*(?:\r?\n[ \t]+)*/y;
const X_DECLARE = /[ \t]+([A-Za-z_$][\w$]*)?/y;
const X_HEADER = /[ \t]*(?:\\*["'][ \t]*)?/y;
const X_SPACE = /[ \t]*/y;
const X_JSON_SPACE = new RegExp(JSON_SPACE, 'y');
const X_HEADER_NAME = /[A-Za-z-]*/y;
const X_BEARER = /[ \t]+[A-Za-z0-9._~+/=-]*/y;
const X_FLAG_ASSIGN = new RegExp(FSEP, 'y');
const X_FLAG_VALUE = /[^\s"'\\]*/y;
const X_URL = /[^\s/@:"'<>]*(?::[^\s/@"<>]*)?@?/y;
const X_PEM = /([A-Z0-9 ]*)PRIVATE KEY-----/y;
const X_PEM_PART = /[A-Z0-9 ]*-{0,5}$/y;

function stick(re: RegExp, t: string, at: number): RegExpExecArray | null {
  re.lastIndex = at;
  return re.exec(t);
}
const endOf = (re: RegExp, t: string, at: number) => at + (stick(re, t, at)?.[0].length ?? 0);

/**
 * The last run of value characters measured in one safeCut. Names inside a value (token=token=…) start inside the same
 * run and end where it ends; measuring it once keeps safeCut linear.
 */
type Run = { from: number; to: number };
type Runs = { bare: Run; flag: Run };

function bareEnd(t: string, at: number, run: Run, characters = X_BARE): number {
  if (at >= run.from && at <= run.to) return run.to;
  run.from = at;
  run.to = endOf(characters, t, at);
  return run.to;
}

/** Flag arguments admit punctuation that field values do not, so they have a separate cached run. */
function flagEnd(t: string, at: number, run: Run): number {
  const prefix = stick(X_FLAG_ASSIGN, t, at);
  return prefix ? bareEnd(t, at + prefix[0].length, run, X_FLAG_VALUE) : at;
}

function keyEnd(t: string, at: number, run: Run): number {
  const m = stick(X_KEY, t, at);
  if (!m) return at;
  const end = at + m[0].length;
  return m[2] === undefined ? end : bareEnd(t, end, run);
}

function quoteAt(t: string, at: number): number {
  while (t[at] === '\\') at++;
  return at;
}

function valueEnd(t: string, at: number, run: Runs, context: QuoteContext, flag = false): number {
  const bare = () => (flag ? flagEnd(t, at, run.flag) : keyEnd(t, at, run.bare));
  const prefix = stick(flag ? X_FLAG_ASSIGN : X_ASSIGN, t, at);
  if (!prefix) return bare();
  const value = at + prefix[0].length;
  let quoteValue = value;
  if (t[value] === '(') {
    const checked = { to: 0 };
    const reference = parenthesizedReferenceEnd(t, value, false, checked);
    if (reference !== 0) return reference;
    if (checked.to) return Math.max(bare(), checked.to);
    while (t[quoteValue] === '(' || t[quoteValue] === ' ' || t[quoteValue] === '\t') quoteValue++;
  }
  const q = quoteAt(t, quoteValue);
  if (q === t.length) {
    context.waiting = new GapScanner(value);
    return -1;
  }
  if (t[q] === '"' || t[q] === "'") return quotedEnd(t, quoteValue, false, context)?.after ?? -1;
  return bare();
}

function headerEnd(t: string, colon: number, context: QuoteContext): number {
  const at = endOf(X_HEADER_VALUE, t, colon + 1);
  const q = t[quoteAt(t, at)];
  if (q !== '"' && q !== "'") {
    const scan = new HeaderTailScanner(at, context.depthAt(at));
    const end = scan.scan(t);
    if (end) context.completedTo = end.after;
    else context.waiting = scan;
    return end?.after ?? -1;
  }
  const end = quotedEnd(t, at, false, context, !quotedPropertyAt(t, at));
  return end?.after ?? -1;
}

/** Where what a START match can take ends, or -1 when it can still go on (more text may change it). */
function extent(t: string, g: Record<string, string | undefined>, at: number, run: Runs, context: QuoteContext): number {
  if (g.d !== undefined) {
    const declaration = stick(X_DECLARE, t, at);
    if (!declaration) return at;
    const p = at + declaration[0].length;
    if (p >= t.length) return p;
    return declaration[1] && SECRET_KEY.test(keyName(declaration[1])) ? valueEnd(t, p, run, context) : at;
  }
  if (g.k !== undefined) {
    // api-key also names a header; the colon form includes its folded continuation lines.
    const p = endOf(X_HEADER, t, at);
    if (SECRET_HEADER.test(g.k)) {
      if (t[p] === ':') return headerEnd(t, p, context);
      if (t[p] === ',' && /["']/.test(t.slice(at, p))) return headerListEnd(t, p, context);
    }
    return valueEnd(t, at, run, context);
  }
  if (g.n !== undefined) {
    // A list entry's "name": only a header name after it makes this a header list, so wait until that name is known.
    const rest = (i: number) => quoteAt(t, i) >= t.length;
    let p = endOf(X_JSON_SPACE, t, at);
    if (rest(p)) return -1;
    if (t[p] !== ':') return at;
    p = endOf(X_JSON_SPACE, t, p + 1);
    if (rest(p)) return -1;
    p = quoteAt(t, p);
    const quote = t[p];
    if (quote !== '"' && quote !== "'") return at;
    const name = endOf(X_HEADER_NAME, t, p + 1);
    if (rest(name)) return -1;
    if (!SECRET_HEADER.test(t.slice(p + 1, name))) return at;
    const close = quoteAt(t, name);
    return t[close] === quote ? headerListEnd(t, close + 1, context) : at;
  }
  if (g.h !== undefined || g.v !== undefined) {
    const p = endOf(g.h !== undefined ? X_HEADER : X_SPACE, t, at);
    if (p >= t.length) return -1;
    // A header line or header list: everything up to the end of the line (and its folded lines).
    if (g.h !== undefined && t[p] === ':') return headerEnd(t, p, context);
    return t[p] === ':' || (g.h !== undefined && t[p] === ',' && /["']/.test(t.slice(at, p)))
      ? headerListEnd(t, p, context) : p;
  }
  if (g.b !== undefined) return endOf(X_BEARER, t, at);
  if (g.f !== undefined) return valueEnd(t, at, run, context, true);
  if (g.u !== undefined) return endOf(X_URL, t, at);
  const pem = stick(X_PEM, t, at);
  if (pem) {
    const end = `-----END ${pem[1]}PRIVATE KEY-----`;
    const i = t.indexOf(end, at + pem[0].length);
    return i < 0 ? -1 : i + end.length;
  }
  return stick(X_PEM_PART, t, at) ? -1 : at;
}

/** A printable ASCII character: a word that can be (part of) a key shape is made of these. */
const word = (c: number) => c > 0x20 && c < 0x7f;

/**
 * How much of `t` is final: redacting it alone gives what redacting it with any text after it would give for it. It
 * ends before the word still arriving and before anything after a secret's name, header, scheme, flag, URL or private
 * key that more text could still extend, never inside one of these or inside a word.
 */
type StreamWait = { quote?: PendingScan; completed?: number; wordOnly?: boolean };
function safeCut(t: string, initial = encodingState(), wait?: StreamWait): number {
  const context = new QuoteContext(t, initial);
  const n = t.length;
  let cut = n;
  while (cut > 0 && word(t.charCodeAt(cut - 1))) cut--;
  const wordCut = cut;
  const spans: number[] = [];
  const run: Runs = { bare: { from: -1, to: -1 }, flag: { from: -1, to: -1 } };
  START.lastIndex = 0;
  let m = START.exec(t);
  for (; m && m.index < cut; m = START.exec(t)) {
    const e = extent(t, m.groups!, m.index + m[0].length, run, context);
    // One character of room: a backslash or a space at the end can still start or continue it.
    if (e < 0 || e >= n - 1) {
      cut = m.index;
      m = null;
      break;
    }
    spans.push(m.index, e);
    START.lastIndex = Math.max(m.index + 1, context.completedTo);
  }
  const completed = context.completedTo;
  // The word still arriving can open a long value of its own (token="…" with no space in it). Its scan only tells the
  // stream when to look again; the cut stays where it is.
  if (m && wait) extent(t, m.groups!, m.index + m[0].length, run, context);
  for (let moved = true; moved; ) {
    moved = false;
    while (cut > 0 && cut < n && word(t.charCodeAt(cut - 1)) && word(t.charCodeAt(cut))) cut--;
    const c = t.charCodeAt(cut - 1);
    if (cut > 0 && cut < n && c >= 0xd800 && c <= 0xdbff) {
      cut--;
      moved = true;
    }
    for (let i = 0; i < spans.length; i += 2) {
      if (spans[i]! < cut && spans[i + 1]! > cut) {
        cut = spans[i]!;
        moved = true;
      }
    }
  }
  if (wait) { wait.quote = context.waiting; wait.completed = completed; wait.wordOnly = cut === wordCut; }
  return cut;
}

/** Held-back text longer than this is looked at again only each time it has doubled (linear time overall). */
const MAX_PENDING = 1024;

/**
 * Redacts a message that arrives in pieces without ever showing part of a secret and without redacting the whole
 * text again for every piece. Text is published once it is final (see safeCut), redacted once; the word still
 * arriving, and what follows a secret's name, a header or a URL until it has ended, are held back. Nothing is ever
 * taken back: what was published is the start of the whole text redacted.
 */
export class StreamRedactor {
  /** Arrived, not published yet. */
  private pending = '';
  private encoding = encodingState();
  private codeBefore = '';
  private nextCheck = 0;
  private waitingQuote: PendingScan | undefined;
  /**
   * The end of `pending` that the waiting scan still reads. Growing `pending` by small pieces and reading it again
   * would copy all of it each time; this stays short.
   */
  private scanText = '';
  /** Held back only for the word still arriving: look again once a piece ends that word. */
  private recheckAtBreak = false;
  /** Whether this copy has replaced any source text. No source text is retained for this flag. */
  redacted = false;
  /** What has been published so far. */
  shown = '';

  /** Adds a piece; returns the text to append to what was published, or nothing. */
  push(piece: string): { append: string } | null {
    if (!piece) return null;
    this.pending += piece;
    if (this.waitingQuote) {
      this.scanText += piece;
      if (!this.waitingQuote.scan(this.scanText)) {
        const kept = this.waitingQuote.kept();
        if (kept >= 64 && kept * 2 >= this.scanText.length) {
          this.scanText = this.scanText.slice(kept);
          this.waitingQuote.shift(kept);
        }
        return null;
      }
      this.waitingQuote = undefined;
      this.scanText = '';
    } else if (this.pending.length > MAX_PENDING && this.pending.length < this.nextCheck && !(this.recheckAtBreak && /[^\x21-\x7e]/.test(piece))) {
      return null;
    }
    // A word that just ended at the very end still needs one more character before it is final.
    const endedWord = this.recheckAtBreak && !word(this.pending.charCodeAt(this.pending.length - 1));
    const wait: StreamWait = {};
    const cut = safeCut(this.pending, this.encoding, wait);
    const append = cut > 0 ? redactInContext(this.pending.slice(0, cut), this.encoding, this.codeBefore) : '';
    if (cut > 0) {
      this.redacted ||= append !== this.pending.slice(0, cut);
      this.codeBefore = codePrefixAt(this.pending, cut, this.codeBefore);
      advanceEncoding(this.encoding, this.pending.slice(0, cut));
      this.pending = this.pending.slice(cut);
    }
    this.waitingQuote = wait.quote;
    this.waitingQuote?.shift(cut);
    this.scanText = this.waitingQuote ? this.pending : '';
    this.recheckAtBreak = !!wait.wordOnly && !wait.quote;
    const soon = (endedWord && cut === 0) || (wait.completed !== undefined && wait.completed > cut);
    this.nextCheck = soon && !wait.quote ? this.pending.length + 1 : this.pending.length * 2;
    if (!append) return null;
    this.shown += append;
    return { append };
  }

  /** The text is complete: what was held back is published too. */
  end(): { append: string } | null {
    const append = redactInContext(this.pending, this.encoding, this.codeBefore);
    this.redacted ||= append !== this.pending;
    this.pending = '';
    this.waitingQuote = undefined;
    this.scanText = '';
    this.recheckAtBreak = false;
    if (!append) return null;
    this.shown += append;
    return { append };
  }

  /** The whole text, redacted (what is still held back included). */
  final(): string {
    return this.shown + redactInContext(this.pending, this.encoding, this.codeBefore);
  }

  /** The runtime's authoritative final text replaces what arrived in pieces. */
  replaceAll(text: string): string {
    this.pending = '';
    this.encoding = encodingState();
    this.codeBefore = '';
    this.waitingQuote = undefined;
    this.scanText = '';
    this.recheckAtBreak = false;
    this.nextCheck = 0;
    this.shown = redactText(text);
    this.redacted = this.shown !== text;
    return this.shown;
  }
}

/** Every string in a value (a notice and its parameters, an error object), redacted; the shape stays. */
export function redactStrings<T>(v: T, depth = 0): T {
  if (typeof v === 'string') return redactText(v) as T;
  if (!v || typeof v !== 'object' || depth > 32) return v;
  if (Array.isArray(v)) return v.map((x) => redactStrings(x, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = redactStrings(x, depth + 1);
  return out as T;
}

const FRAGMENT_TEXT = new Set(['text', 'thinking', 'partial_json', 'output', 'chunk']);
const SECRET_KEY = new RegExp(String.raw`^(?:.*_)?(?:${KEY_NAMES}|${HEADERS.replaceAll('-', '_')})$`, 'i');
const SECRET_NUMBER_KEY = /^(?:.*_)?(?:password|passwd|secret|pin)$/i;
const SECRET_HEADER = new RegExp(String.raw`^(?:${HEADERS})$`, 'i');

/** "apiKey" / "x-api-key" / "API_KEY" → "api_key" for the name checks. */
const keyName = (k: string) => k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_');

/** A free-form display parameter can identify its secret by key even when its template omits that key. */
export function redactSecretField(key: string, value: unknown): unknown {
  const name = keyName(key);
  if (SECRET_KEY.test(name) && (typeof value === 'string' || (value && typeof value === 'object'))) return value === '' ? value : R;
  if (typeof value === 'number' && SECRET_NUMBER_KEY.test(name)) return R;
  return value;
}

/**
 * A copy of a protocol message for a log line, redacted field by field so the line stays valid JSON: values of
 * secret-named fields (apiKey, token, password, Authorization, Cookie…) and of secret headers in {name, value} lists
 * become "[redacted]", image data is replaced by its size, and every other string goes through redactText.
 */
export function redactForLog(v: unknown, depth = 0, fragment = false): unknown {
  if (typeof v === 'string') return redactText(v);
  if (!v || typeof v !== 'object' || depth > 32) return v;
  if (Array.isArray(v)) return v.map((x) => redactForLog(x, depth + 1, fragment));
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const header = typeof o.name === 'string' && SECRET_HEADER.test(o.name);
  // A piece of streamed text (ACP *_chunk content, Codex / Claude deltas): a secret split over pieces cannot be
  // recognized in one piece, so only its size is logged.
  const chunk = typeof o.sessionUpdate === 'string' && o.sessionUpdate.endsWith('_chunk');
  for (const [k, x] of Object.entries(o)) {
    const name = keyName(k);
    if (typeof x === 'string' && (k === 'delta' || (fragment && FRAGMENT_TEXT.has(k)))) out[k] = `[${x.length} characters]`;
    else if ((k === 'delta' || (chunk && k === 'content')) && x && typeof x === 'object') out[k] = redactForLog(x, depth + 1, true);
    else if (header && k === 'value' && x !== null && x !== undefined) out[k] = R;
    else if (k === 'data' && o.type === 'image' && typeof x === 'string') out[k] = `[${x.length} base64 characters]`;
    else if (SECRET_KEY.test(name) && (typeof x === 'string' || (x && typeof x === 'object'))) out[k] = x === '' ? x : R;
    else if (typeof x === 'number' && SECRET_NUMBER_KEY.test(name)) out[k] = R;
    else out[k] = redactForLog(x, depth + 1);
  }
  return out;
}
