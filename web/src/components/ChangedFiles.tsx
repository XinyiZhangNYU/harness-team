import { useState } from 'react';
import type { FileChange, Message, RuntimeKind } from '../../../shared/protocol.ts';
import { useT } from '../i18n.tsx';
import { Dialog } from './Dialog.tsx';
import { HelpTip } from './HelpTip.tsx';
import { Icon } from './Icon.tsx';

/** The files one member's turn changed through its edit tools, merged per path in the order they were first touched. */
export interface TurnChanges {
  runtime: RuntimeKind;
  files: FileChange[];
}

/**
 * Per turn (same member, same native turn id), the edit-tool changes that completed, keyed by the id of the turn's
 * last message, where the summary is shown. Messages without a native turn id are left out (they cannot be grouped).
 */
export function collectTurnChanges(messages: Message[]): Map<string, TurnChanges> {
  const lastOfTurn = new Map<string, string>();
  const changes = new Map<string, TurnChanges & { byPath: Map<string, FileChange> }>();
  for (const m of messages) {
    if (m.senderKind !== 'agent' || !m.meta || (m.meta.type !== 'chat' && m.meta.type !== 'activity')) continue;
    const turn = m.meta.nativeTurnId;
    if (!turn) continue;
    const key = `${m.senderId}\u0000${turn}`;
    lastOfTurn.set(key, m.id);
    if (m.meta.type !== 'activity' || !m.meta.files?.length || m.status !== 'complete') continue;
    let c = changes.get(key);
    if (!c) changes.set(key, (c = { runtime: m.meta.runtime, files: [], byPath: new Map() }));
    for (const f of m.meta.files) {
      const prev = c.byPath.get(f.path);
      if (!prev) {
        const copy = { ...f };
        c.byPath.set(f.path, copy);
        c.files.push(copy);
        continue;
      }
      // Several edits of one file in a turn: keep them all, in order; a file created in this turn stays "added".
      prev.diff = prev.diff && f.diff ? `${prev.diff}\n@@\n${f.diff}` : prev.diff || f.diff;
      prev.truncated = prev.truncated || f.truncated;
      if (f.change === 'delete') prev.change = 'delete';
      else if (prev.change !== 'add' && prev.change !== 'write') prev.change = f.change;
    }
  }
  const out = new Map<string, TurnChanges>();
  for (const [key, c] of changes) {
    const last = lastOfTurn.get(key);
    if (last) out.set(last, { runtime: c.runtime, files: c.files });
  }
  return out;
}

function countLines(diff: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) add++;
    else if (l.startsWith('-') && !l.startsWith('---')) del++;
  }
  return { add, del };
}

function DiffLines(props: { diff: string }) {
  if (!props.diff) return null;
  return (
    <pre className="diff">
      {props.diff.split('\n').map((l, i) => {
        const cls = l.startsWith('@@') ? 'd-hunk' : l.startsWith('+') && !l.startsWith('+++') ? 'd-add' : l.startsWith('-') && !l.startsWith('---') ? 'd-del' : l.startsWith('+++') || l.startsWith('---') ? 'd-hunk' : '';
        return (
          <span key={i} className={cls}>
            {l || ' '}
            {'\n'}
          </span>
        );
      })}
    </pre>
  );
}

/** "Changed 2 files +12 −3" under a member's turn; opens the per-file diffs. */
export function ChangedFiles(props: { changes: TurnChanges; handle?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { files, runtime } = props.changes;
  const totals = files.reduce(
    (acc, f) => {
      const n = countLines(f.diff);
      return { add: acc.add + n.add, del: acc.del + n.del };
    },
    { add: 0, del: 0 },
  );
  return (
    <div className="changed-files">
      <button type="button" className="changed-files-btn" onClick={() => setOpen(true)}>
        <Icon name="diff" size={14} />
        <span>{t('diff.summary', { n: files.length })}</span>
        <span className="d-add">+{totals.add}</span>
        <span className="d-del">−{totals.del}</span>
      </button>
      {open && (
        <Dialog
          title={
            <>
              {props.handle ? t('diff.titleBy', { handle: props.handle }) : t('diff.title')}{' '}
              <HelpTip text={runtime === 'claude' ? t('diff.noteClaude') : t('diff.note')} />
            </>
          }
          label={props.handle ? t('diff.titleBy', { handle: props.handle }) : t('diff.title')}
          className="diff-dialog"
          onClose={() => setOpen(false)}
        >
          {files.map((f, i) => {
            const n = countLines(f.diff);
            return (
              <details key={f.path} className="diff-file" open={files.length <= 3 || i === 0}>
                <summary>
                  <span className={`chip diff-kind diff-kind-${f.change}`}>{t(`diff.kind_${f.change}`)}</span>
                  <span className="mono diff-path" title={f.path}>
                    {f.path}
                  </span>
                  <span className="d-add">+{n.add}</span>
                  <span className="d-del">−{n.del}</span>
                </summary>
                {f.diff ? <DiffLines diff={f.diff} /> : <div className="hint">{t('diff.empty')}</div>}
                {f.truncated && <div className="hint">{t('diff.truncated')}</div>}
              </details>
            );
          })}
        </Dialog>
      )}
    </div>
  );
}
