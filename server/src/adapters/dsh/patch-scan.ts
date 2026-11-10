/**
 * Whether a dsh patch file (YAML) names one of the permission entries as an `id`. Harness Team has no YAML parser, so
 * this reads a strict subset: block and single-line flow mappings and sequences, plain scalars, single-quoted
 * scalars, and double-quoted scalars without escapes, with comments. Anything outside it (anchors, aliases, tags,
 * block scalars, escapes, multi-line values, several documents, directives, merge keys, tabs) cannot be checked:
 * the answer is then 'unknown', never a guess.
 */

export type PatchScan = 'permission' | 'none' | 'unknown';

const PERMISSION_IDS = new Set(['sandbox-policy', 'approval', 'permission']);

type Token = { t: 'scalar'; v: string; plain: boolean; col: number } | { t: 'ind'; c: string; col: number };

class Unknown extends Error {}

/** Tokens of one line; comments dropped. Throws Unknown outside the subset. */
function lex(line: string): Token[] {
  const out: Token[] = [];
  let depth = 0;
  let i = 0;
  const n = line.length;
  const space = (k: number) => k >= n || line[k] === ' ';
  while (i < n) {
    const c = line[i]!;
    if (c === ' ') {
      i++;
      continue;
    }
    if (c === '\t') throw new Unknown();
    // A comment starts at the line start or after a space.
    if (c === '#' && (i === 0 || line[i - 1] === ' ')) break;
    if (c === '{' || c === '[') {
      depth++;
      out.push({ t: 'ind', c, col: i++ });
      continue;
    }
    if (c === '}' || c === ']') {
      depth--;
      if (depth < 0) throw new Unknown();
      out.push({ t: 'ind', c, col: i++ });
      continue;
    }
    if (c === ',') {
      if (depth === 0) throw new Unknown();
      out.push({ t: 'ind', c, col: i++ });
      continue;
    }
    if (c === '-' && depth === 0 && space(i + 1)) {
      out.push({ t: 'ind', c, col: i++ });
      continue;
    }
    const prev = out.at(-1);
    // ":" ends a key before a space (or a flow end), and right after a quoted key ("id":"x").
    if (c === ':' && (space(i + 1) || (depth > 0 && ',]}'.includes(line[i + 1] ?? '')) || (prev?.t === 'scalar' && !prev.plain && prev.col + 1 < i))) {
      out.push({ t: 'ind', c, col: i++ });
      continue;
    }
    if (c === "'") {
      let v = '';
      let k = i + 1;
      for (;;) {
        if (k >= n) throw new Unknown(); // multi-line
        if (line[k] === "'") {
          if (line[k + 1] === "'") {
            v += "'";
            k += 2;
            continue;
          }
          break;
        }
        v += line[k++];
      }
      out.push({ t: 'scalar', v, plain: false, col: i });
      i = k + 1;
      continue;
    }
    if (c === '"') {
      const k = line.indexOf('"', i + 1);
      if (k < 0) throw new Unknown(); // multi-line
      const v = line.slice(i + 1, k);
      if (v.includes('\\')) throw new Unknown(); // escapes
      out.push({ t: 'scalar', v, plain: false, col: i });
      i = k + 1;
      continue;
    }
    // Anchors, aliases, tags, block scalars, complex keys, directives, reserved characters.
    if ('&*!|>%@`'.includes(c) || (c === '?' && space(i + 1))) throw new Unknown();
    // A plain scalar: to ": ", " #", the line end, and in a flow also to , [ ] { }.
    let k = i;
    while (k < n) {
      const d = line[k]!;
      if (d === ':' && (space(k + 1) || (depth > 0 && ',]}'.includes(line[k + 1] ?? '')))) break;
      if (d === '#' && line[k - 1] === ' ') break;
      if (depth > 0 && ',[]{}'.includes(d)) break;
      if (d === '\t') throw new Unknown();
      k++;
    }
    const v = line.slice(i, k).trimEnd();
    if (v === '<<') throw new Unknown(); // merge key
    out.push({ t: 'scalar', v, plain: true, col: i });
    i = k;
  }
  if (depth !== 0) throw new Unknown(); // a flow collection over several lines
  return out;
}

export function scanPatch(text: string): PatchScan {
  try {
    // YAML breaks lines at a lone CR as well as LF and CRLF; NEL / LS / PS (line breaks in YAML 1.1) are not read here.
    if (/[\u0085\u2028\u2029]/.test(text)) throw new Unknown();
    const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
    const content: { indent: number; tokens: Token[] }[] = [];
    let started = false;
    for (const line of lines) {
      if (/^(---|\.\.\.)(\s|$)/.test(line)) {
        // One leading document marker is fine; a second document (or an end marker) is not read.
        if (started || line.startsWith('...')) throw new Unknown();
        started = true;
        if (line.slice(3).trim() && !line.slice(3).trim().startsWith('#')) throw new Unknown();
        continue;
      }
      const tokens = lex(line);
      if (!tokens.length) continue;
      started = true;
      content.push({ indent: line.length - line.trimStart().length, tokens });
    }
    let found = false;
    for (let li = 0; li < content.length; li++) {
      const { tokens } = content[li]!;
      for (let k = 0; k + 1 < tokens.length; k++) {
        const key = tokens[k]!;
        const colon = tokens[k + 1]!;
        if (key.t !== 'scalar' || colon.t !== 'ind' || colon.c !== ':' || key.v !== 'id') continue;
        const value = tokens[k + 2];
        if (!value || value.t !== 'scalar') {
          // `id:` with its value on the next lines (or a collection as the value): not read here.
          if (!value || value.c === '{' || value.c === '[') throw new Unknown();
          continue;
        }
        // A plain value continued on a more indented line is folded into one longer value: not read here.
        const next = content[li + 1];
        if (value.plain && k + 3 === tokens.length && next && next.indent > key.col) throw new Unknown();
        if (PERMISSION_IDS.has(value.v)) found = true;
      }
    }
    return found ? 'permission' : 'none';
  } catch (e) {
    if (e instanceof Unknown) return 'unknown';
    throw e;
  }
}
