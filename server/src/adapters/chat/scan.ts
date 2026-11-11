/**
 * Linear-time helpers for reading untrusted markup (fetched pages, Office XML). A lazy `<x>[\s\S]*?</x>` regex or an
 * end-anchored `\s+$` scans to the end of the text from every candidate start, so a few kilobytes of unclosed tags or
 * one long run of spaces can block the server for minutes. These do the same jobs in one pass.
 */

/** `s` without the given characters at its end. */
export function trimEndOf(s: string, chars: string): string {
  let i = s.length;
  while (i > 0 && chars.includes(s[i - 1]!)) i--;
  return i === s.length ? s : s.slice(0, i);
}

/**
 * Replaces each `open` match and the text up to its closing tag with `fn(match, inner)`. `closeOf` gives the closing
 * pattern for a match (a global RegExp), or null when the tag closes itself (inner
 * ''). An opening tag without a closing one is left as it is. The search for each closing pattern only moves
 * forward, so many unclosed tags cost no more than one.
 */
export function replaceBlocks(
  text: string,
  open: RegExp,
  closeOf: (m: RegExpExecArray) => RegExp | null,
  fn: (m: RegExpExecArray, inner: string) => string,
): string {
  const found = new Map<string, { at: number; end: number }>();
  const closing = (re: RegExp, from: number) => {
    const key = `${re.flags}/${re.source}`;
    const c = found.get(key);
    if (c && (c.at === -1 || c.at >= from)) return c;
    re.lastIndex = from;
    const m = re.exec(text);
    const next = m ? { at: m.index, end: m.index + m[0].length } : { at: -1, end: -1 };
    found.set(key, next);
    return next;
  };
  let out = '';
  let pos = 0;
  open.lastIndex = 0;
  for (let m = open.exec(text); m; m = open.exec(text)) {
    const after = m.index + m[0].length;
    const re = closeOf(m);
    if (re === null) {
      out += text.slice(pos, m.index) + fn(m, '');
      pos = after;
      continue;
    }
    const c = closing(re, after);
    if (c.at === -1) continue;
    out += text.slice(pos, m.index) + fn(m, text.slice(after, c.at));
    pos = open.lastIndex = c.end;
  }
  return out + text.slice(pos);
}

/** Each block's match and inner text (see replaceBlocks), for reading rather than replacing. */
export function blocks(text: string, open: RegExp, closeOf: (m: RegExpExecArray) => RegExp | null): { m: RegExpExecArray; inner: string }[] {
  const out: { m: RegExpExecArray; inner: string }[] = [];
  replaceBlocks(text, open, closeOf, (m, inner) => {
    out.push({ m, inner });
    return '';
  });
  return out;
}
