import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { renderNotice } from '../../../shared/notices.ts';
import { ApiError } from '../api.ts';
import { activeLang, useT } from '../i18n.tsx';
import { Icon } from './Icon.tsx';

const stack: object[] = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), summary';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hidden && el.getClientRects().length > 0);
}

/**
 * Modal dialog: backdrop click and Escape close it unless `busy`. `actions` go in the footer, right-aligned.
 * Focus moves into the dialog when it opens (an `autoFocus` control, else the first field, else the first button
 * after the close button), Tab and Shift+Tab stay inside it, and focus goes back to where it was when it closes.
 */
export function Dialog(props: {
  title: ReactNode;
  /** Accessible name when the title is not plain text (e.g. a title with a help tip). */
  label?: string;
  onClose: () => void;
  busy?: boolean;
  className?: string;
  alert?: boolean;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const t = useT();
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  const busyRef = useRef(props.busy);
  busyRef.current = props.busy;
  const box = useRef<HTMLDivElement>(null);
  // Read while rendering, before an autoFocus control inside the dialog takes the focus.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  useEffect(() => {
    // Only the topmost open dialog reacts to Escape and Tab (a folder browser can open above a form dialog).
    const token = {};
    stack.push(token);
    const root = box.current;
    if (root && !root.contains(document.activeElement)) {
      const list = focusables(root);
      const field = list.find((el) => el.matches('input, select, textarea'));
      const firstAction = list.find((el) => !el.closest('.dialog-head'));
      (field ?? firstAction ?? root).focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== token) return;
      if (e.key === 'Escape' && !busyRef.current) {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !box.current) return;
      const list = focusables(box.current);
      if (!list.length) {
        e.preventDefault();
        return;
      }
      const first = list[0]!;
      const last = list[list.length - 1]!;
      const active = document.activeElement;
      if (!box.current.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      stack.splice(stack.indexOf(token), 1);
      // Back to the control that opened the dialog, if it is still on the page (a menu item may be gone by now).
      if (opener && opener !== document.body) requestAnimationFrame(() => opener.isConnected && opener.focus());
    };
  }, [opener]);
  // Drawn on <body>, so a dialog opened from a sliding drawer is neither moved nor hidden with the drawer.
  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !props.busy && props.onClose()}>
      <div
        ref={box}
        tabIndex={-1}
        className={`dialog${props.className ? ` ${props.className}` : ''}`}
        role={props.alert ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-label={props.label ?? (typeof props.title === 'string' ? props.title : undefined)}
      >
        <header className="dialog-head">
          <h2>{props.title}</h2>
          <button type="button" className="icon-btn" aria-label={t('common.close')} disabled={props.busy} onClick={props.onClose}>
            <Icon name="x" />
          </button>
        </header>
        {props.children !== undefined && <div className="dialog-body">{props.children}</div>}
        {props.actions && <footer className="dialog-actions">{props.actions}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/** An error for display: server errors in the UI language when the server sent both (see `ApiError.notice`). */
export function errorText(e: unknown): string {
  if (e instanceof ApiError && e.notice) return renderNotice(e.notice, activeLang());
  return e instanceof Error ? e.message : String(e);
}
