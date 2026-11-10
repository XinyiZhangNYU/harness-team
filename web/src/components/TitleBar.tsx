import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePrefs } from '../i18n.tsx';
import { Icon } from './Icon.tsx';

/**
 * The window's title bar in the Windows desktop app, which leaves drawing it to the page: a ☰ button that opens the
 * application menu (also Alt or F10, as in Windows menus); the rest of the bar drags the window. Windows draws the minimize / maximize /
 * close buttons over the right end; they take this bar's colors. Nothing is drawn in the browser or on macOS.
 * While a dialog is open its backdrop covers the bar (above drawers, below dialogs), the window buttons are dimmed to
 * match and Alt / F10 don't open the menu.
 */
export function TitleBar() {
  const desktop = window.harnessDesktop;
  const height = desktop?.showMenu ? (desktop.titleBarHeight ?? 0) : 0;
  const { t, dark, palette, theme } = usePrefs();
  const barRef = useRef<HTMLElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [modal, setModal] = useState(false);
  const [update, setUpdate] = useState<DesktopUpdate | null>(null);

  useEffect(() => {
    if (!height || !desktop?.onUpdate) return;
    let live = true;
    void desktop.getUpdate?.().then((s) => live && s && setUpdate(s));
    const off = desktop.onUpdate((s) => setUpdate(s));
    return () => {
      live = false;
      off();
    };
  }, [height, desktop]);

  useLayoutEffect(() => {
    if (!height) return;
    const root = document.documentElement;
    root.classList.add('has-titlebar');
    root.style.setProperty('--titlebar-h', `${height}px`);
    return () => {
      root.classList.remove('has-titlebar');
      root.style.removeProperty('--titlebar-h');
    };
  }, [height]);

  // Dialogs are drawn straight into <body>.
  useEffect(() => {
    if (!height) return;
    const check = () => setModal(!!document.querySelector('.dialog-backdrop'));
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true });
    return () => observer.disconnect();
  }, [height]);

  // The window buttons follow the bar's colors (theme and palette are applied before this runs).
  useEffect(() => {
    const el = barRef.current;
    if (!height || !el || !desktop?.setTitleBarColors) return;
    const style = getComputedStyle(el);
    const backdrop = modal ? document.querySelector('.dialog-backdrop') : null;
    const colors = barColors(style.backgroundColor, style.color, backdrop && getComputedStyle(backdrop).backgroundColor);
    if (colors) desktop.setTitleBarColors(colors[0], colors[1]);
  }, [height, desktop, dark, palette, theme, modal]);

  const openMenu = useCallback(() => {
    const b = buttonRef.current;
    if (!b || !desktop?.showMenu || document.querySelector('.dialog-backdrop')) return;
    const r = b.getBoundingClientRect();
    desktop.showMenu(r.left, r.bottom);
  }, [desktop]);

  // Alt pressed and released on its own, or F10, opens the menu.
  useEffect(() => {
    if (!height) return;
    let altAlone = false;
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Alt') {
        if (!e.repeat) altAlone = !e.ctrlKey && !e.shiftKey && !e.metaKey;
        return;
      }
      altAlone = false;
      if (e.key === 'F10' && !e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
        e.preventDefault();
        openMenu();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key !== 'Alt' || !altAlone) return;
      altAlone = false;
      e.preventDefault();
      openMenu();
    };
    const reset = () => {
      altAlone = false;
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('mousedown', reset, true);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('mousedown', reset, true);
      window.removeEventListener('blur', reset);
    };
  }, [height, openMenu]);

  if (!height) return null;
  return (
    <header className="titlebar" ref={barRef}>
      <button ref={buttonRef} type="button" className="icon-btn titlebar-menu" aria-label={t('titlebar.menu')} title={t('titlebar.menu')} onClick={openMenu}>
        <Icon name="menu" />
      </button>
      {update && <UpdateButton update={update} act={(a) => desktop?.updateAction?.(a)} />}
    </header>
  );
}

/** The title bar's update button: download an available version, its progress, then restart to install it. */
function UpdateButton({ update, act }: { update: DesktopUpdate; act: (a: 'download' | 'restart') => void }) {
  const { t } = usePrefs();
  const v = update.version ?? '';
  if (update.state === 'available') {
    return (
      <button type="button" className="titlebar-update" onClick={() => act('download')}>
        <Icon name="download" size={14} />
        {t('update.available', { v })}
      </button>
    );
  }
  if (update.state === 'downloading') {
    return (
      <button type="button" className="titlebar-update" disabled aria-busy="true">
        <Icon name="download" size={14} />
        {t('update.downloading', { n: update.percent ?? 0 })}
      </button>
    );
  }
  if (update.state === 'ready') {
    return (
      <button type="button" className="titlebar-update primary" onClick={() => act('restart')}>
        <Icon name="refresh" size={14} />
        {t('update.restart', { v })}
      </button>
    );
  }
  if (update.state === 'error') {
    return (
      <button type="button" className="titlebar-update danger-outline" title={update.error} onClick={() => act('download')}>
        <Icon name="refresh" size={14} />
        {t('update.failed')}
      </button>
    );
  }
  return null;
}

type Rgba = [number, number, number, number];

/** A computed "rgb(…)" / "rgba(…)" color; null for other color spaces. */
function parseRgb(css: string): Rgba | null {
  const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(css.trim());
  if (!m) return null;
  const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return [Number(m[1]), Number(m[2]), Number(m[3]), Math.min(1, a)];
}

function hex(c: Rgba): string {
  return '#' + c.slice(0, 3).map((v) => Math.min(255, Math.round(v)).toString(16).padStart(2, '0')).join('');
}

/** "rgb(r, g, b)" → "#rrggbb"; null for anything else (transparent, other color spaces). */
export function toHex(css: string): string | null {
  const c = parseRgb(css);
  return c && c[3] >= 1 ? hex(c) : null;
}

/** The bar's background and text colors for the window buttons, dimmed by a dialog's backdrop when one is open. */
export function barColors(bg: string, fg: string, backdrop?: string | null): [string, string] | null {
  const b = parseRgb(bg);
  const f = parseRgb(fg);
  if (!b || !f || b[3] < 1 || f[3] < 1) return null;
  const o = backdrop ? parseRgb(backdrop) : null;
  const dim = (c: Rgba): Rgba => (o && o[3] > 0 ? [0, 1, 2].map((i) => c[i]! * (1 - o[3]) + o[i]! * o[3]).concat(1) as Rgba : c);
  return [hex(dim(b)), hex(dim(f))];
}
