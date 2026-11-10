import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n.tsx';

const GAP = 6;
const MARGIN = 8;

/**
 * A small "?" next to a control that is not obvious from its label. The explanation opens on hover, keyboard focus
 * or a click (touch), and closes on leaving, Escape, focus moving away or a click elsewhere. The bubble is drawn in
 * a fixed layer on top of everything, so a dialog's scroll area cannot clip it; it opens below the "?" or, when there
 * is more room there, above it, and never covers the "?" itself. It ignores the pointer, so it can never sit between
 * you and the text box under it.
 */
export function HelpTip(props: { text: string; align?: 'start' | 'end' }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLSpanElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  const id = useId();

  const close = () => {
    setPinned(false);
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!btn.current?.contains(e.target as Node)) close();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    // Anything that moves the "?" (scrolling a list, resizing) would leave the bubble behind: just close it.
    const moved = () => close();
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc, true);
    window.addEventListener('scroll', moved, true);
    window.addEventListener('resize', moved);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', esc, true);
      window.removeEventListener('scroll', moved, true);
      window.removeEventListener('resize', moved);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setStyle({ visibility: 'hidden' });
      return;
    }
    const b = btn.current?.getBoundingClientRect();
    const p = pop.current;
    if (!b || !p) return;
    const w = p.offsetWidth;
    const h = p.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const below = vh - b.bottom - GAP - MARGIN;
    const above = b.top - GAP - MARGIN;
    const top = below >= h || below >= above ? b.bottom + GAP : Math.max(MARGIN, b.top - GAP - h);
    const preferred = props.align === 'end' ? b.right + 6 - w : b.left - 6;
    const left = Math.min(Math.max(MARGIN, preferred), Math.max(MARGIN, vw - MARGIN - w));
    setStyle({ top, left, maxHeight: Math.max(below, above), visibility: 'visible' });
  }, [open, props.text, props.align]);

  return (
    <span
      className="help-tip"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        if (!pinned) setOpen(false);
      }}
    >
      <button
        ref={btn}
        type="button"
        className="help-tip-btn"
        aria-label={t('help.label')}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onFocus={() => setOpen(true)}
        onBlur={close}
        onClick={(e) => {
          // Inside a <label>, a click would also toggle the labelled control.
          e.preventDefault();
          e.stopPropagation();
          if (open && pinned) close();
          else {
            setPinned(true);
            setOpen(true);
          }
        }}
      >
        ?
      </button>
      {open &&
        createPortal(
          <span ref={pop} id={id} role="tooltip" className="help-tip-pop" style={style}>
            {props.text}
          </span>,
          document.body,
        )}
    </span>
  );
}
