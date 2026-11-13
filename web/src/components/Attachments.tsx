import { useState } from 'react';
import type { AttachmentInfo } from '../../../shared/protocol.ts';
import { attachmentUrl, formatBytes, type DraftAttachment } from '../attachments.ts';
import { citationLabel, citationPath, type FileCitation } from '../file-citations.ts';
import { useT } from '../i18n.tsx';
import { Dialog } from './Dialog.tsx';
import { HelpTip } from './HelpTip.tsx';
import { Icon } from './Icon.tsx';

/** Attachments of a sent message: image thumbnails (click opens a larger view inside the app) and file cards. */
export function AttachmentGrid({ roomId, attachments }: { roomId: string; attachments: AttachmentInfo[] }) {
  const t = useT();
  const [open, setOpen] = useState<AttachmentInfo | null>(null);
  const images = attachments.filter((a) => a.kind === 'image');
  const files = attachments.filter((a) => a.kind !== 'image');
  return (
    <>
      {images.length > 0 && (
        <div className={`att-grid${images.length === 1 ? ' single' : ''}`}>
          {images.map((a) => (
            <button key={a.id} type="button" className="att-thumb" title={a.name} aria-label={t('attach.open', { name: a.name })} onClick={() => setOpen(a)}>
              <img src={attachmentUrl(a.id)} alt={a.name} loading="lazy" draggable={false} />
              <span className="att-thumb-name">{a.name}</span>
            </button>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <ul className="att-files" aria-label={t('attach.list')}>
          {files.map((a) => (
            <FileCard key={a.id} roomId={roomId} file={a} />
          ))}
        </ul>
      )}
      {open && (
        <Dialog title={open.name} className="lightbox" onClose={() => setOpen(null)}>
          <img src={attachmentUrl(open.id)} alt={open.name} />
          <div className="lightbox-meta muted">
            {open.mime} · {formatBytes(open.size)}
          </div>
        </Dialog>
      )}
    </>
  );
}

function fileLabel(a: { name: string; mime: string }): string {
  if (a.mime === 'application/pdf') return 'PDF';
  const ext = /\.([a-z0-9]{1,8})$/i.exec(a.name)?.[1];
  return ext ? ext.toUpperCase() : '';
}

/**
 * A sent file. In the desktop app: open it with its default program or show it in its folder (programs, scripts and
 * pages are only ever shown in the folder). In a browser: download it.
 */
function FileCard({ roomId, file }: { roomId: string; file: AttachmentInfo }) {
  const t = useT();
  const desktop = window.harnessDesktop?.attachment ? window.harnessDesktop : null;
  const [note, setNote] = useState<string | null>(null);
  const act = async (action: 'open' | 'reveal') => {
    setNote(null);
    try {
      const r = await desktop!.attachment!(action, { roomId, id: file.id, name: file.name });
      if (!r.ok) setNote(r.error === 'missing' ? t('attach.missing') : t('attach.failedOpen'));
      else if (action === 'open' && r.revealed) setNote(t('attach.revealedInstead'));
    } catch {
      setNote(t('attach.failedOpen'));
    }
  };
  const label = fileLabel(file);
  return (
    <li className="att-file" title={file.name}>
      <span className="att-file-icon" aria-hidden="true">
        <Icon name="file" size={20} />
        {label && <span className="att-file-ext">{label.slice(0, 4)}</span>}
      </span>
      <span className="att-file-text">
        <span className="att-file-name">{file.name}</span>
        <span className="att-file-meta muted">{note ?? formatBytes(file.size)}</span>
      </span>
      {desktop ? (
        <span className="att-file-actions">
          <button type="button" className="icon-btn" title={t('attach.openFile')} aria-label={`${t('attach.openFile')} ${file.name}`} onClick={() => void act('open')}>
            <Icon name="external" size={16} />
          </button>
          <button type="button" className="icon-btn" title={t('attach.reveal')} aria-label={`${t('attach.reveal')} ${file.name}`} onClick={() => void act('reveal')}>
            <Icon name="folder" size={16} />
          </button>
        </span>
      ) : (
        <span className="att-file-actions">
          <a className="icon-btn" href={attachmentUrl(file.id)} download={file.name} title={t('attach.download')} aria-label={`${t('attach.download')} ${file.name}`}>
            <Icon name="download" size={16} />
          </a>
        </span>
      )}
    </li>
  );
}

/**
 * A file a member cited in its reply. In the desktop app a click opens it with its default program (programs, scripts
 * and pages are shown in their folder instead); in a browser it is plain text with the full path on hover.
 */
export function FileCitationChip({ citation, workspace }: { citation: FileCitation; workspace: string | null | undefined }) {
  const t = useT();
  const [note, setNote] = useState<string | null>(null);
  const label = citationLabel(citation);
  const target = citationPath(citation.path, workspace);
  const open = window.harnessDesktop?.localFile;
  const title = note ? `${note}: ${citation.path}` : citation.path;
  if (!open || !target) {
    return (
      <span className="file-cite" title={title}>
        <Icon name="file" size={13} />
        {label}
      </span>
    );
  }
  const act = async () => {
    setNote(null);
    try {
      const r = await open('open', target);
      if (!r.ok) setNote(r.error === 'missing' ? t('attach.missing') : t('attach.failedOpen'));
    } catch {
      setNote(t('attach.failedOpen'));
    }
  };
  return (
    <button type="button" className={`file-cite${note ? ' file-cite-failed' : ''}`} title={title} onClick={() => void act()}>
      <Icon name="file" size={13} />
      {label}
    </button>
  );
}

/** Attachments waiting in the composer. */
export function DraftStrip({ drafts, onRemove }: { drafts: DraftAttachment[]; onRemove: (key: string) => void }) {
  const t = useT();
  if (!drafts.length) return null;
  const hasFiles = drafts.some((d) => !d.image);
  return (
    <ul className="draft-strip" aria-label={t('attach.list')}>
      {drafts.map((d) => (
        <li
          key={d.key}
          className={`draft draft-${d.state}${d.image ? '' : ' draft-file'}`}
          title={d.error ? `${d.name}: ${d.error}` : `${d.name} · ${formatBytes(d.size)}`}
        >
          {d.image ? (
            d.preview ? <img src={d.preview} alt="" /> : <Icon name="image" size={20} />
          ) : (
            <>
              <Icon name="file" size={18} />
              <span className="draft-file-text">
                <span className="draft-file-name">{d.name}</span>
                <span className="muted">{d.state === 'failed' ? (d.error ?? t('attach.failed')) : formatBytes(d.size)}</span>
              </span>
            </>
          )}
          {d.state === 'uploading' && <span className="draft-veil">{t('attach.uploading')}</span>}
          {d.state === 'failed' && d.image && <span className="draft-veil draft-error">{d.error ?? t('attach.failed')}</span>}
          <button type="button" className="draft-remove" aria-label={t('attach.remove', { name: d.name })} onClick={() => onRemove(d.key)}>
            <Icon name="x" size={12} />
          </button>
        </li>
      ))}
      {hasFiles && (
        <li className="draft-help">
          <HelpTip text={t('attach.filesHelp')} />
        </li>
      )}
    </ul>
  );
}
