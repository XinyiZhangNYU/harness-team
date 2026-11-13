import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Draw a divider above this item. */
  separator?: boolean;
  /** A choice in a set (drawn with a check mark when true; announced as a radio item). */
  checked?: boolean;
  /** With `checked`: an on/off setting of its own (announced as a checkbox item). */
  toggle?: boolean;
  /** Tooltip, e.g. why a disabled item is not available. */
  title?: string;
}

/**
 * Small context menu at a screen point (right-click, the "⋯" button, or the keyboard menu key / Shift+F10).
 * Closes on outside click, Escape, Tab, scroll, resize or window blur. Arrow keys move between items.
 */
export function ContextMenu(props: { x: number; y: number; items: MenuItem[]; label: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: props.x, top: props.y });
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;

  // Keep the menu inside the viewport.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(props.x, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(props.y, window.innerHeight - r.height - 4)),
    });
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [props.x, props.y]);

  useEffect(() => {
    const close = () => onClose.current();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element;
      // The toggle that opened the menu handles its own click (so a second click closes instead of reopening).
      if (ref.current?.contains(t) || t.closest?.('[data-menu-toggle][aria-expanded="true"]')) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', close, true);
    };
  }, []);

  function move(e: React.KeyboardEvent, step: number) {
    e.preventDefault();
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    if (!buttons.length) return;
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(i + step + buttons.length) % buttons.length]!.focus();
  }

  // Drawn on <body>: a menu opened inside a sliding drawer must not be positioned or hidden with it.
  return createPortal(
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      aria-label={props.label}
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') move(e, 1);
        else if (e.key === 'ArrowUp') move(e, -1);
      }}
    >
      {props.items.map((it) => (
        <div key={it.label} role="none">
          {it.separator && <div className="context-menu-sep" role="separator" />}
          <button
            type="button"
            role={it.checked === undefined ? 'menuitem' : it.toggle ? 'menuitemcheckbox' : 'menuitemradio'}
            aria-checked={it.checked === undefined ? undefined : it.checked}
            className={[it.danger ? 'danger' : '', it.checked === undefined ? '' : it.toggle ? 'toggle' : 'choice', it.checked ? 'checked' : ''].filter(Boolean).join(' ') || undefined}
            disabled={it.disabled}
            title={it.title}
            onClick={() => {
              props.onClose();
              it.onSelect();
            }}
          >
            {it.label}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
