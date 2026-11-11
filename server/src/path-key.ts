import { lstatSync, opendirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Default file systems that ignore case (NTFS on Windows, APFS / HFS+ on macOS); used only when a folder cannot be asked. */
const DEFAULT_IGNORES_CASE = process.platform === 'win32' || process.platform === 'darwin';

/** The real path of `p` (see realPath) and the real path of its nearest existing part. */
function resolveReal(p: string): { real: string; existing: string | null } {
  let abs = resolve(p);
  // A link whose target does not exist (yet) is followed, as writing through it would: its name is not a new file in
  // the folder that holds the link. Bounded, so a link loop ends.
  for (let hops = 0; ; ) {
    const tail: string[] = [];
    let next: string | null = null;
    for (let head = abs; ; ) {
      try {
        const existing = realpathSync.native(head);
        return { real: tail.length ? join(existing, ...tail.reverse()) : existing, existing };
      } catch {
        const target = hops < 40 ? linkTarget(head) : null;
        if (target !== null) {
          next = resolve(dirname(head), target, ...tail.reverse());
          break;
        }
        const parent = dirname(head);
        if (parent === head) return { real: abs, existing: null };
        tail.push(basename(head));
        head = parent;
      }
    }
    hops++;
    abs = next;
  }
}

/** Where a symlink (or junction) points, as stored; null when `p` is not one. */
function linkTarget(p: string): string | null {
  try {
    return lstatSync(p).isSymbolicLink() ? readlinkSync(p) : null;
  } catch {
    return null;
  }
}

/**
 * `p` with symlinks and junctions resolved (on macOS also `/tmp` → `/private/tmp`, `/var` → `/private/var`). A part
 * that does not exist yet is kept as written after the real path of its nearest existing parent; a link whose target
 * does not exist is followed to where that target would be. Never throws.
 */
export function realPath(p: string): string {
  return resolveReal(p).real;
}

/**
 * A file name the way a volume that ignores case compares it, for deny lists: compatibility forms and case folded, so
 * `.claudſ` style spellings (`ſ` → `s`, Kelvin `K` → `k`) that APFS or NTFS open as the listed name are caught.
 */
export const foldName = (name: string) => name.normalize('NFKC').toLowerCase();

const LETTER = /[A-Za-z]/;
const swapCase = (s: string) => s.replace(/[A-Za-z]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));

/** Whether `b` names the same file system entry as `a`; null when that cannot be told. */
function sameEntry(a: string, b: string): boolean | null {
  let x;
  try {
    x = statSync(a, { bigint: true });
  } catch {
    return null;
  }
  try {
    const y = statSync(b, { bigint: true });
    return x.dev === y.dev && x.ino === y.ino;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? false : null;
  }
}

/**
 * Whether names that differ only in case are one entry where the existing real path `dir` lives (with `ofEntries`:
 * inside `dir`, for names below it that do not exist yet). The file system is asked rather than assumed: macOS can
 * mount case-sensitive APFS (disk images, external drives), and Linux and Windows can have folders that ignore or keep
 * case. A name on that volume (`dir`'s own or a parent's, or one of its entries) is looked up again with its case
 * swapped; it finds the same entry only where case is ignored. Only ASCII letters are swapped, whose case every such
 * file system folds. The platform's default is used when nothing can be asked.
 */
export function ignoresCase(dir: string, ofEntries = false): boolean {
  return (ofEntries ? (byEntry(dir) ?? byOwnName(dir)) : (byOwnName(dir) ?? byEntry(dir))) ?? DEFAULT_IGNORES_CASE;
}

/** Asks with `dir`'s own name, else a parent's, staying on `dir`'s volume (the folder that holds the name decides). */
function byOwnName(dir: string): boolean | null {
  let dev: bigint;
  try {
    dev = statSync(dir, { bigint: true }).dev;
  } catch {
    return null;
  }
  for (let cur = dir; ; ) {
    const parent = dirname(cur);
    if (parent === cur) return null;
    try {
      // `cur` is the volume's mount point: its name belongs to the outer volume.
      if (statSync(parent, { bigint: true }).dev !== dev) return null;
    } catch {
      return null;
    }
    const name = basename(cur);
    if (LETTER.test(name)) {
      const same = sameEntry(cur, join(parent, swapCase(name)));
      if (same !== null) return same;
    }
    cur = parent;
  }
}

/** Asks with one of `dir`'s entries (`dir` itself decides). */
function byEntry(dir: string): boolean | null {
  try {
    const d = opendirSync(dir);
    try {
      for (let i = 0; i < 64; i++) {
        const ent = d.readSync();
        if (!ent) return null;
        if (!LETTER.test(ent.name)) continue;
        const same = sameEntry(join(dir, ent.name), join(dir, swapCase(ent.name)));
        if (same !== null) return same;
      }
    } finally {
      d.closeSync();
    }
  } catch {
    // not a readable folder
  }
  return null;
}

/**
 * One key per directory, whatever the spelling: real path, no trailing separator, and lower case where the folder's
 * volume ignores case. NFC on macOS (APFS and HFS+ treat both Unicode forms as one name) and wherever case is ignored.
 */
export function pathKey(p: string): string {
  const k = keyOf(p);
  return spell(k.real, k.fold);
}

function keyOf(p: string): { real: string; fold: boolean } {
  const { real, existing } = resolveReal(p);
  return { real: real.replace(/[\\/]+$/, '') || sep, fold: existing ? ignoresCase(existing, existing !== real) : DEFAULT_IGNORES_CASE };
}

function spell(real: string, fold: boolean): string {
  const n = fold || process.platform === 'darwin' ? real.normalize('NFC') : real;
  return fold ? n.toLowerCase() : n;
}

/**
 * True when one path is the other or inside it, however either is spelled. The containing path's volume decides
 * whether case counts, so a case-sensitive volume mounted inside a case-insensitive one is compared correctly (real
 * paths carry each existing name's case as stored).
 */
export function pathsOverlap(a: string, b: string): boolean {
  const x = keyOf(a);
  const y = keyOf(b);
  const inside = (p: typeof x, root: typeof x) => {
    const P = spell(p.real, root.fold);
    const R = spell(root.real, root.fold);
    return P === R || P.startsWith(R.endsWith(sep) ? R : R + sep);
  };
  return inside(x, y) || inside(y, x);
}

/** `p` relative to `root` when it lies inside it (also through symlinks such as `/var` → `/private/var`), else null. */
export function relativeInside(root: string, p: string): string | null {
  const inside = (r: string) => (r && !r.startsWith('..') && !isAbsolute(r) ? r.replace(/\\/g, '/') : null);
  return inside(relative(root, p)) ?? inside(relative(realPath(root), realPath(p)));
}
