import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePrefs } from '../i18n.tsx';
import { Icon, type IconName } from './Icon.tsx';

/**
 * Time and date pickers drawn in the app's own style instead of the browser's. The hour and minute columns are plain
 * lists from 00 to 23 and 00 to 59: they stop at both ends rather than wrapping around. Values use the same text as
 * the native controls they replace: `HH:mm`, and `YYYY-MM-DDTHH:mm` (local time).
 */

const pad = (n: number) => String(n).padStart(2, '0');
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 60 }, (_, i) => i);

function parseTime(v: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})/.exec(v);
  const h = m ? Math.min(23, Number(m[1])) : 9;
  const min = m ? Math.min(59, Number(m[2])) : 0;
  return [h, min];
}

/** A popover on <body> under (or, without room, above) its field; closes on an outside click, Escape or resize. */
function Popover({ anchor, onClose, children }: { anchor: HTMLElement; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    const place = () => {
      const el = ref.current;
      if (!el) return;
      const a = anchor.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const below = a.bottom + 4;
      const top = below + r.height <= window.innerHeight - 4 ? below : Math.max(4, a.top - 4 - r.height);
      setPos({ left: Math.max(4, Math.min(a.left, window.innerWidth - r.width - 4)), top });
    };
    place();
    // The field moves with the dialog's own scrolling: follow it, but not the popover's columns scrolling.
    const onScroll = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) place();
    };
    document.addEventListener('scroll', onScroll, true);
    return () => document.removeEventListener('scroll', onScroll, true);
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.contains(t)) return;
      close.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Close the picker, not the dialog under it.
        e.preventDefault();
        e.stopPropagation();
        close.current();
        anchor.focus();
      }
    };
    const onResize = () => close.current();
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
    };
  }, [anchor]);

  return createPortal(
    <div ref={ref} className="picker-pop" style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0, visibility: 'hidden' }}>
      {children}
    </div>,
    document.body,
  );
}

/** One column of numbers; the chosen one is scrolled to the middle when the column opens. */
function Column({ values, value, label, onPick }: { values: number[]; value: number; label: string; onPick: (v: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const list = ref.current;
    const on = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (list && on) list.scrollTop = on.offsetTop - (list.clientHeight - on.offsetHeight) / 2;
    // Only when the column opens; afterwards the user's own scrolling is left alone.
  }, []);
  const step = (e: React.KeyboardEvent, d: number) => {
    e.preventDefault();
    const i = values.indexOf(value) + d;
    if (i < 0 || i >= values.length) return;
    onPick(values[i]!);
    ref.current?.querySelectorAll<HTMLElement>('button')[i]?.scrollIntoView({ block: 'nearest' });
  };
  return (
    <div
      ref={ref}
      className="picker-col"
      role="listbox"
      aria-label={label}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') step(e, 1);
        else if (e.key === 'ArrowUp') step(e, -1);
      }}
    >
      {values.map((v) => (
        <button key={v} type="button" role="option" tabIndex={-1} aria-selected={v === value} className={v === value ? 'on' : ''} onClick={() => onPick(v)}>
          {pad(v)}
        </button>
      ))}
    </div>
  );
}

function TimeColumns({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = usePrefs();
  const [h, m] = parseTime(value);
  return (
    <div className="picker-time">
      <Column values={HOURS} value={h} label={t('picker.hour')} onPick={(v) => onChange(`${pad(v)}:${pad(m)}`)} />
      <Column values={MINUTES} value={m} label={t('picker.minute')} onPick={(v) => onChange(`${pad(h)}:${pad(v)}`)} />
    </div>
  );
}

function FieldButton(props: { id?: string; icon: IconName; text: string; open: boolean; onToggle: () => void; buttonRef: (el: HTMLButtonElement | null) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      ref={props.buttonRef}
      id={props.id}
      type="button"
      className="picker-field"
      aria-haspopup="dialog"
      aria-expanded={props.open}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={props.onToggle}
    >
      <span className="picker-value">{props.text}</span>
      <Icon name={props.icon} size={16} />
    </button>
  );
}

/** A time of day, `HH:mm`. */
export function TimeField({ id, value, onChange, label }: { id?: string; value: string; onChange: (v: string) => void; label?: string }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [h, m] = parseTime(value);
  return (
    <>
      <FieldButton id={id} icon="clock" text={`${pad(h)}:${pad(m)}`} open={open} onToggle={() => setOpen((o) => !o)} buttonRef={setAnchor} label={label} />
      {open && anchor && (
        <Popover anchor={anchor} onClose={() => setOpen(false)}>
          <TimeColumns value={value} onChange={onChange} />
        </Popover>
      )}
    </>
  );
}

function splitLocal(v: string): { date: Date | null; time: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(v);
  if (!m) return { date: null, time: '09:00' };
  return { date: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])), time: m[4]! };
}

const dateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** A month of days, Monday first; the days of the months around it fill the first and last weeks. */
function Calendar({ value, onPick }: { value: Date | null; onPick: (d: Date) => void }) {
  const { locale, t } = usePrefs();
  const [month, setMonth] = useState(() => {
    const d = value ?? new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const lead = (month.getDay() + 6) % 7;
  const days = Array.from({ length: 42 }, (_, i) => new Date(month.getFullYear(), month.getMonth(), 1 - lead + i));
  const today = dateKey(new Date());
  const chosen = value ? dateKey(value) : null;
  const shift = (n: number) => setMonth((cur) => new Date(cur.getFullYear(), cur.getMonth() + n, 1));
  return (
    <div className="picker-cal">
      <div className="picker-cal-head">
        <button type="button" className="icon-btn" aria-label={t('picker.prevMonth')} onClick={() => shift(-1)}>
          <Icon name="chevronLeft" size={16} />
        </button>
        <span>{month.toLocaleDateString(locale, { year: 'numeric', month: 'long' })}</span>
        <button type="button" className="icon-btn" aria-label={t('picker.nextMonth')} onClick={() => shift(1)}>
          <Icon name="chevronRight" size={16} />
        </button>
      </div>
      <div className="picker-cal-grid" role="grid">
        {days.slice(0, 7).map((d) => (
          <span key={`w${d.getDay()}`} className="picker-cal-wd">
            {d.toLocaleDateString(locale, { weekday: 'narrow' })}
          </span>
        ))}
        {days.map((d) => {
          const k = dateKey(d);
          const cls = [d.getMonth() !== month.getMonth() ? 'other' : '', k === today ? 'today' : '', k === chosen ? 'on' : ''].filter(Boolean).join(' ');
          return (
            <button key={k} type="button" className={cls} aria-pressed={k === chosen} aria-label={d.toLocaleDateString(locale, { dateStyle: 'full' })} onClick={() => onPick(d)}>
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A date and time, `YYYY-MM-DDTHH:mm` in local time ('' while none is chosen). */
export function DateTimeField(props: { id?: string; value: string; onChange: (v: string) => void; disabled?: boolean; label?: string }) {
  const { locale, t } = usePrefs();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const { date, time } = splitLocal(props.value);
  const text = date ? `${date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric', weekday: 'short' })} ${time}` : t('picker.none');
  const set = (d: Date | null, tm: string) => props.onChange(`${dateKey(d ?? new Date())}T${tm}`);
  return (
    <>
      <FieldButton id={props.id} icon="calendar" text={text} open={open} onToggle={() => setOpen((o) => !o)} buttonRef={setAnchor} disabled={props.disabled} label={props.label} />
      {open && anchor && (
        <Popover anchor={anchor} onClose={() => setOpen(false)}>
          <div className="picker-datetime">
            <Calendar value={date} onPick={(d) => set(d, time)} />
            <TimeColumns value={time} onChange={(tm) => set(date, tm)} />
          </div>
        </Popover>
      )}
    </>
  );
}
