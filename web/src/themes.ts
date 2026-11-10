/**
 * Color themes ("palettes"). A palette overrides the surface, text and accent tokens from styles.css; light / dark
 * mode stays a separate choice, so every palette has both tones. Colors are approximations, not official brand assets.
 * Amber / Starry were sampled from screenshots the user supplied (2026-11-07). Amber light = warm paper and rust;
 *   Starry light = misty lavender, Starry dark = night sky. Amber dark was derived from Amber light. These two also
 *   tint the status colors and draw a soft CSS-gradient background behind the chat and sidebar (no image files).
 * Button text on the accent keeps a WCAG contrast of at least 4.5: light tones darken the brand color slightly,
 * dark tones keep the bright brand color with dark button text. Text, secondary and muted text keep at least 4.5 on
 * every background of their tone (test/palettes.test.ts).
 */

// The Claude and GPT palettes were removed at the user's request (2026-11-07); a saved 'claude' / 'gpt' falls back to default.
export const PALETTE_IDS = ['default', 'amber', 'starry'] as const;
export type PaletteId = (typeof PALETTE_IDS)[number];

export const isPaletteId = (v: unknown): v is PaletteId => typeof v === 'string' && (PALETTE_IDS as readonly string[]).includes(v);

interface Tone {
  bg: string;
  sidebar: string;
  surface: string;
  surface2: string;
  text: string;
  text2: string;
  muted: string;
  border: string;
  borderStrong: string;
  accent: string;
  accentText: string;
  /** Optional status colors; when absent the defaults from styles.css stay. */
  status?: { ok: string; okSoft: string; warn: string; warnSoft: string; err: string; errSoft: string };
  /** Optional CSS background-image layers behind the chat area and the sidebar (gradients only). */
  deco?: { main: string; sidebar?: string };
}

interface Palette {
  /** Shown in the picker; a product name stays the same in every language. */
  name: string | { zh: string; en: string };
  light: Tone;
  dark: Tone;
}

/** A few fixed star dots for the Starry night background (no repeat, so the sky does not look tiled). */
const STAR_LAYERS = [
  [6, 12], [14, 64], [22, 30], [31, 82], [38, 8], [45, 52], [53, 22], [61, 74], [67, 40], [74, 14], [81, 60], [88, 34],
  [94, 86], [10, 92], [27, 48], [57, 94], [70, 4], [91, 6],
]
  .map(([x, y], i) => {
    const r = i % 3 === 0 ? 1.6 : 1;
    return `radial-gradient(${r}px ${r}px at ${x}% ${y}%, rgb(255 255 255 / ${i % 3 === 0 ? 0.75 : 0.45}) 50%, transparent 51%)`;
  });
const STARS = STAR_LAYERS.join(', ');

export const PALETTES: Record<Exclude<PaletteId, 'default'>, Palette> = {
  amber: {
    name: { zh: '暖菊', en: 'Amber' },
    light: {
      bg: '#f6ecdf', sidebar: '#f6f1e7', surface: '#fffcf7', surface2: '#f2ebdd',
      text: '#27211c', text2: '#5f564c', muted: '#685f55', border: '#e3d9c8', borderStrong: '#cebfa5',
      accent: '#994723', accentText: '#fffcf7',
      status: { ok: '#3f6b4c', okSoft: '#e2e9db', warn: '#795306', warnSoft: '#f7e9cc', err: '#873d4b', errSoft: '#f5e3df' },
      deco: {
        main:
          'radial-gradient(1100px 620px at 100% 100%, rgb(236 146 84 / 0.20), transparent 62%), ' +
          'radial-gradient(700px 380px at 92% 78%, rgb(246 186 120 / 0.16), transparent 70%), ' +
          'radial-gradient(900px 500px at 0% 0%, rgb(255 252 244 / 0.70), transparent 70%)',
        sidebar: 'linear-gradient(180deg, rgb(255 250 240 / 0.6), transparent 40%)',
      },
    },
    dark: {
      bg: '#1d1814', sidebar: '#17130f', surface: '#26201b', surface2: '#2f2721',
      text: '#f4ebe0', text2: '#cdbfae', muted: '#a19282', border: '#3a3029', borderStrong: '#52453a',
      accent: '#e8935f', accentText: '#1d1814',
      status: { ok: '#8fc79d', okSoft: '#1f2c22', warn: '#f2c46d', warnSoft: '#33281a', err: '#ec8f9c', errSoft: '#3a1f22' },
      deco: {
        main:
          'radial-gradient(1000px 560px at 100% 100%, rgb(232 147 95 / 0.13), transparent 62%), ' +
          'radial-gradient(800px 420px at 0% 0%, rgb(255 210 160 / 0.04), transparent 70%)',
      },
    },
  },
  starry: {
    name: { zh: '星夜', en: 'Starry' },
    light: {
      bg: '#f1f0f8', sidebar: '#fdfcff', surface: '#ffffff', surface2: '#f0eff6',
      text: '#1c1929', text2: '#5c5769', muted: '#62616e', border: '#e6e5eb', borderStrong: '#c5c3cd',
      accent: '#554c89', accentText: '#ffffff',
      status: { ok: '#3c735e', okSoft: '#e0ece8', warn: '#7c5a09', warnSoft: '#f6efdc', err: '#974153', errSoft: '#f8eaed' },
      deco: {
        main:
          'radial-gradient(1000px 560px at 100% 0%, rgb(150 140 230 / 0.16), transparent 62%), ' +
          'radial-gradient(900px 600px at 0% 100%, rgb(214 210 240 / 0.55), transparent 66%), ' +
          'radial-gradient(700px 420px at 70% 90%, rgb(255 255 255 / 0.55), transparent 70%)',
      },
    },
    dark: {
      bg: '#0c0d21', sidebar: '#100c24', surface: '#171232', surface2: '#1f1b41',
      text: '#f3f0fe', text2: '#b1acdc', muted: '#9089bb', border: '#2e2755', borderStrong: '#40387a',
      accent: '#b3aafd', accentText: '#100c24',
      status: { ok: '#82cbb8', okSoft: '#16283a', warn: '#f9d290', warnSoft: '#2a2235', err: '#e396b2', errSoft: '#301f40' },
      deco: {
        main:
          `${STARS}, ` +
          'radial-gradient(1000px 560px at 88% 0%, rgb(124 92 230 / 0.22), transparent 62%), ' +
          'radial-gradient(800px 480px at 0% 100%, rgb(70 96 210 / 0.16), transparent 62%), ' +
          'radial-gradient(600px 360px at 60% 70%, rgb(235 139 220 / 0.06), transparent 70%)',
        sidebar: STAR_LAYERS.filter((_, i) => i % 2 === 0).join(', '),
      },
    },
  },
};

/** CSS custom properties a palette sets on <html>; derived tokens mix the accent into the surfaces. */
export function paletteVars(id: PaletteId, dark: boolean): Record<string, string> | null {
  if (id === 'default') return null;
  const p = PALETTES[id];
  const c = dark ? p.dark : p.light;
  const vars: Record<string, string> = {
    '--bg': c.bg,
    '--bg-sidebar': c.sidebar,
    '--bg-side': `color-mix(in srgb, ${c.sidebar} 50%, ${c.bg})`,
    '--surface': c.surface,
    '--surface-2': c.surface2,
    '--text': c.text,
    '--text-2': c.text2,
    '--muted': c.muted,
    '--border': c.border,
    '--border-strong': c.borderStrong,
    '--accent': c.accent,
    '--accent-hover': `color-mix(in srgb, ${c.accent} 84%, ${c.text})`,
    '--accent-text': c.accentText,
    '--accent-soft': `color-mix(in srgb, ${c.accent} ${dark ? 18 : 11}%, ${c.surface})`,
    '--accent-soft-text': `color-mix(in srgb, ${c.accent} ${dark ? 70 : 78}%, ${c.text})`,
    '--code-bg': c.surface2,
  };
  if (c.status) {
    const s = c.status;
    Object.assign(vars, { '--ok': s.ok, '--ok-soft': s.okSoft, '--warn': s.warn, '--warn-soft': s.warnSoft, '--err': s.err, '--err-soft': s.errSoft });
  }
  if (c.deco) {
    vars['--deco-main'] = c.deco.main;
    if (c.deco.sidebar) vars['--deco-sidebar'] = c.deco.sidebar;
  }
  return vars;
}

/** Every property any palette may set, so switching palettes removes the previous one's extras. */
export const PALETTE_VAR_NAMES = [
  ...new Set(
    (PALETTE_IDS.filter((id) => id !== 'default') as Exclude<PaletteId, 'default'>[]).flatMap((id) => [
      ...Object.keys(paletteVars(id, false) ?? {}),
      ...Object.keys(paletteVars(id, true) ?? {}),
    ]),
  ),
];

/** Two swatch colors for the picker: accent and the page background of the current tone. */
export function paletteSwatch(id: PaletteId, dark: boolean): [string, string] {
  if (id === 'default') return dark ? ['#7c74ff', '#17171a'] : ['#4f46e5', '#ffffff'];
  const c = dark ? PALETTES[id].dark : PALETTES[id].light;
  return [c.accent, c.bg];
}

export function paletteName(id: Exclude<PaletteId, 'default'>, lang: 'zh' | 'en'): string {
  const n = PALETTES[id].name;
  return typeof n === 'string' ? n : n[lang];
}
