import { useCallback, useEffect, useRef, useState } from 'react';
import { ATTACHMENT_LIMITS, IMAGE_MIME_TYPES, type AttachmentInfo } from '../../shared/protocol.ts';
import { api } from './api.ts';
import type { TFunc } from './i18n.tsx';

/** An attachment in the composer before the message is sent. */
export interface DraftAttachment {
  key: string;
  name: string;
  size: number;
  /** Shown as a thumbnail (the server has the final say once uploaded). */
  image: boolean;
  /** Local object URL for the thumbnail (revoked when the draft goes away). */
  preview: string | null;
  state: 'uploading' | 'ready' | 'failed';
  info?: AttachmentInfo;
  error?: string;
}

export interface AttachmentDrafts {
  drafts: DraftAttachment[];
  add: (files: File[]) => void;
  remove: (key: string) => void;
  /** After a successful send: the server now owns the files, only local previews are released. */
  clear: () => void;
  ready: boolean;
}

const IMAGE_TYPES = new Set<string>(IMAGE_MIME_TYPES);
let seq = 0;

export function isImageFile(f: File): boolean {
  return IMAGE_TYPES.has(f.type);
}

/** Files the user is about to send in one room. Uploads start right away; unsent ones are deleted on room change. */
export function useAttachmentDrafts(roomId: string, t: TFunc, onError: (err: unknown) => void): AttachmentDrafts {
  const [drafts, setDrafts] = useState<DraftAttachment[]>([]);
  const live = useRef<DraftAttachment[]>([]);
  live.current = drafts;
  const room = useRef(roomId);

  const patch = useCallback((key: string, p: Partial<DraftAttachment>) => {
    setDrafts((list) => list.map((d) => (d.key === key ? { ...d, ...p } : d)));
  }, []);

  useEffect(() => {
    room.current = roomId;
    return () => {
      // Leaving the room (or unmounting) drops unsent drafts: free previews, delete uploads (else swept after a day).
      for (const d of live.current) {
        if (d.preview) URL.revokeObjectURL(d.preview);
        if (d.info) void api.deleteAttachment(d.info.id).catch(() => {});
      }
      setDrafts([]);
    };
  }, [roomId]);

  const add = useCallback(
    (files: File[]) => {
      const room0 = room.current;
      const free = ATTACHMENT_LIMITS.perMessage - live.current.length;
      if (files.length > free) onError(new Error(t('attach.tooMany', { n: ATTACHMENT_LIMITS.perMessage })));
      const next: DraftAttachment[] = files.slice(0, Math.max(free, 0)).map((f) => {
        const key = `a${++seq}`;
        const image = isImageFile(f);
        const base = { key, name: f.name || (image ? 'image' : 'file'), size: f.size, image };
        const max = image ? ATTACHMENT_LIMITS.imageBytes : ATTACHMENT_LIMITS.fileBytes;
        if (!f.size) return { ...base, preview: null, state: 'failed', error: t('attach.empty') };
        if (f.size > max) return { ...base, preview: null, state: 'failed', error: t('attach.tooLarge', { mb: max / 1024 / 1024 }) };
        const preview = image ? URL.createObjectURL(f) : null;
        const draft: DraftAttachment = { ...base, preview, state: 'uploading' };
        api.uploadAttachment(room0, f).then(
          (info) => {
            if (room.current !== room0) return void api.deleteAttachment(info.id).catch(() => {});
            // The bytes decide: a file named .png that is not really an image becomes a file card.
            if (info.kind !== 'image' && preview) URL.revokeObjectURL(preview);
            patch(key, { state: 'ready', info, name: info.name, image: info.kind === 'image', ...(info.kind === 'image' ? {} : { preview: null }) });
          },
          (e: unknown) => patch(key, { state: 'failed', error: e instanceof Error ? e.message : String(e) }),
        );
        return draft;
      });
      if (next.length) setDrafts((list) => [...list, ...next]);
    },
    [onError, patch, t],
  );

  const remove = useCallback((key: string) => {
    const d = live.current.find((x) => x.key === key);
    if (!d) return;
    if (d.preview) URL.revokeObjectURL(d.preview);
    if (d.info) void api.deleteAttachment(d.info.id).catch(() => {});
    setDrafts((list) => list.filter((x) => x.key !== key));
  }, []);

  const clear = useCallback(() => {
    for (const d of live.current) if (d.preview) URL.revokeObjectURL(d.preview);
    live.current = [];
    setDrafts([]);
  }, []);

  return { drafts, add, remove, clear, ready: drafts.every((d) => d.state === 'ready') };
}

/** Same-origin URL of a stored attachment (the session cookie authenticates it). */
export function attachmentUrl(id: string): string {
  return `/api/attachments/${encodeURIComponent(id)}/raw`;
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
}
