import { createHash } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';
import { redactText } from './redact.ts';

/**
 * Files the local user attaches to messages. Bytes are kept under `<dataDir>/attachments/<roomId>/<id>/<name>`:
 * outside every workspace and repository. Every path is built here from server-side ids; nothing a client sends is
 * ever used as a path.
 */

/** Image type from the file's own signature (PNG, JPEG, GIF, WebP). SVG and anything else is not an image here. */
export function sniffImage(buf: Uint8Array): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null {
  const at = (i: number, bytes: number[]) => bytes.every((b, k) => buf[i + k] === b);
  if (buf.length >= 8 && at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (buf.length >= 3 && at(0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (buf.length >= 6 && (at(0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || at(0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))) return 'image/gif';
  if (buf.length >= 12 && at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp';
  return null;
}

/** True when the bytes start like a PDF document. */
export function isPdf(buf: Uint8Array): boolean {
  return buf.length >= 5 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46 && buf[4] === 0x2d;
}

/** Display types for common non-image files, by extension. Only shown in the UI; the file is never served inline. */
const FILE_TYPES: Record<string, string> = {
  txt: 'text/plain', log: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values',
  json: 'application/json', xml: 'application/xml', yaml: 'application/yaml', yml: 'application/yaml',
  html: 'text/html', htm: 'text/html', css: 'text/css', svg: 'image/svg+xml',
  zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar', '7z': 'application/x-7z-compressed',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** Kind and display type of an uploaded file: images and PDFs by their bytes, anything else by its extension. */
export function detectType(buf: Uint8Array, rawName: string): { kind: 'image' | 'file'; mime: string } {
  const image = sniffImage(buf);
  if (image) return { kind: 'image', mime: image };
  if (isPdf(buf)) return { kind: 'file', mime: 'application/pdf' };
  const ext = /\.([a-z0-9]{1,8})$/i.exec(rawName.trim())?.[1]?.toLowerCase() ?? '';
  // A name ending in .pdf whose bytes are not a PDF is just bytes.
  return { kind: 'file', mime: (ext !== 'pdf' && FILE_TYPES[ext]) || 'application/octet-stream' };
}

const EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

/**
 * Display / on-disk name: no path parts, no control, direction-override or Windows-reserved characters, at most 120 characters, and for
 * images and PDFs an extension that matches the detected type (a pasted screenshot arrives as "image.png" or with no
 * name at all). Other files keep their own extension.
 */
export function cleanName(raw: string, mime: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  let name = base
    .replace(/[\u0000-\u001f\u007f-\u009f<>:"|?*]/g, '')
    // Direction overrides and invisible marks: "a‮txt.exe" would show as "aexe.txt". The emoji joiner stays.
    .replace(/[؜​‎‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name)) name = `_${name}`;
  const ext = EXT[mime];
  if (!name) name = ext ? `image${ext}` : mime === 'application/pdf' ? 'document.pdf' : 'file';
  if (mime === 'application/pdf' && !/\.pdf$/i.test(name)) name += '.pdf';
  if (ext && !name.toLowerCase().endsWith(ext) && !(ext === '.jpg' && /\.jpe?g$/i.test(name))) name += ext;
  if (name.length > 120) {
    const dot = name.lastIndexOf('.');
    const tail = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : '';
    name = name.slice(0, 120 - tail.length) + tail;
  }
  return name;
}


/**
 * The name used when the original one held a secret: nothing of the original is kept, since a redactor that found
 * part of a secret cannot prove it found all of it. Only the extension of the detected type remains.
 */
export function replacementName(mime: string, attachmentId?: string): string {
  const ext = EXT[mime] ?? (mime === 'application/pdf' ? '.pdf' : '');
  const known = Object.entries(FILE_TYPES).find(([, type]) => type === mime)?.[0];
  const base = ext ? cleanName('', mime) : known ? `file.${known}` : 'file';
  if (attachmentId === undefined) return base;
  // The full opaque identity distinguishes files even when they share a type, size and UUID prefix.
  // Old/imported ids need not be UUIDs: hash the identity, never the unsafe original name.
  const identity = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attachmentId)
    ? attachmentId
    : createHash('sha256').update(attachmentId).digest('hex');
  const dot = base.lastIndexOf('.');
  return dot < 0 ? `${base}-${identity}` : `${base.slice(0, dot)}-${identity}${base.slice(dot)}`;
}

/** The name to store, show and hand to a runtime. Checked before path/character cleanup can discard a secret's context. */
export function safeAttachmentName(raw: string, mime: string, attachmentId?: string): { name: string; redacted: boolean } {
  const cleaned = cleanName(raw, mime);
  if (redactText(raw) !== raw || redactText(cleaned) !== cleaned) return { name: replacementName(mime, attachmentId), redacted: true };
  return { name: cleaned, redacted: false };
}

export class AttachmentFiles {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Absolute path of a stored attachment. Throws if the ids would leave the attachments directory. */
  pathFor(roomId: string, id: string, name: string): string {
    const p = resolve(this.root, roomId, id, name);
    const rel = relative(this.root, p);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('attachment path outside the attachments directory');
    return p;
  }

  /**
   * SQL has already forgotten unsafe names. Each id directory still identifies its sole file after an interrupted
   * startup. Exclusive hard-link creation never replaces a destination; a restart can finish the unlink.
   */
  reconcileName(a: { roomId: string; id: string; name: string; size: number; sha256: string }): void {
    try {
      const room = this.roomDir(a.roomId), dir = this.pathFor(a.roomId, a.id, '.');
      for (let p = dir; ; p = dirname(p)) {
        const s = lstatSync(p);
        if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('unsafe directory');
        if (p === this.root) break;
        if (p === dirname(p) || !p.startsWith(this.root + sep)) throw new Error('unsafe directory');
      }
      const target = this.pathFor(a.roomId, a.id, a.name);
      if (dirname(target) !== dir || dirname(dir) !== room) throw new Error('unsafe name');
      const entries = readdirSync(dir).map(name => join(dir, name));
      const targetExists = existsSync(target);
      const realTarget = targetExists ? realpathSync.native(target) : null;
      const others = entries.filter(p => realpathSync.native(p) !== realTarget);
      // The stored size and hash identify the file: a sole entry under the safe name is not proof it is this attachment.
      const verify = (p: string) => {
        const s = lstatSync(p, { bigint: true });
        if (!s.isFile() || s.isSymbolicLink() || s.size !== BigInt(a.size)) throw new Error('unexpected file');
        if (createHash('sha256').update(readFileSync(p)).digest('hex') !== a.sha256) throw new Error('unexpected file');
        return s;
      };
      if (targetExists && others.length === 0) {
        verify(target);
        return;
      }
      if (others.length !== 1) throw new Error('ambiguous file');
      const old = others[0]!;
      const stat = verify(old);
      if (targetExists) {
        const saved = lstatSync(target, { bigint: true });
        if (!saved.isFile() || saved.isSymbolicLink() || stat.dev !== saved.dev || stat.ino !== saved.ino) throw new Error('destination conflict');
      } else {
        linkSync(old, target);
      }
      unlinkSync(old);
    } catch {
      // Native filesystem errors include the old filename, which must never reach logs or the browser.
      const id = /^[0-9a-f-]{36}$/i.test(a.id) ? ' ' + a.id : '';
      throw new Error(`Attachment${id} name upgrade could not finish. Close the app, restore the attachment file or remove the conflicting entry from its id directory, then restart.`);
    }
  }

  /** The room's attachments directory (may not exist yet). Throws if the id would leave the attachments directory. */
  roomDir(roomId: string): string {
    const p = resolve(this.root, roomId);
    const rel = relative(this.root, p);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || /[\\/]/.test(rel)) throw new Error('room directory outside the attachments directory');
    return p;
  }

  write(roomId: string, id: string, name: string, bytes: Uint8Array): string {
    const p = this.pathFor(roomId, id, name);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, bytes, { flag: 'wx' });
    return p;
  }

  remove(roomId: string, id: string): void {
    rmSync(this.pathFor(roomId, id, '.'), { recursive: true, force: true });
  }

  removeRoom(roomId: string): void {
    const p = resolve(this.root, roomId);
    const rel = relative(this.root, p);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.includes('/') || rel.includes('\\')) return;
    rmSync(p, { recursive: true, force: true });
  }
}
