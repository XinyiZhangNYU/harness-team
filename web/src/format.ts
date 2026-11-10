// Pure display helpers shared by the chat components (kept free of React so they can be unit-tested).

/** 24-hour time in the UI language; the date is added for older messages. The full timestamp is in the tooltip. */
export function formatTime(iso: string, locale = 'en-US'): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    : d.toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

export const fullTime = (iso: string, locale = 'en-US') => new Date(iso).toLocaleString(locale, { hourCycle: 'h23' });

/**
 * Multi-line system notices (native session info with tools, MCP servers, skills…) are shown as one summary line
 * with the rest folded. "@x 会话信息" headers take their first detail line into the summary.
 */
export function splitNotice(body: string, sessionInfo = false): { summary: string; detail: string } {
  const [first = '', ...rest] = body.split('\n');
  if ((sessionInfo || first.endsWith('会话信息')) && rest[0]) {
    // "@cx session info · New Codex thread"; the native id goes into the folded part (older bodies had it inline).
    const id = /`([^`]+)`/.exec(rest[0]);
    const line = rest[0].replace(/\s*`[^`]+`/g, '').trim();
    const detail = [id ? `ID: ${id[1]}` : null, ...rest.slice(1)].filter((l) => l !== null).join('\n').trim();
    return { summary: `${first} · ${line}`, detail };
  }
  return { summary: first, detail: rest.join('\n').trim() };
}

/**
 * Shell wrappers make command titles unreadable ("C:\…\pwsh.exe" -Command 'Get-Content …'). Show the inner
 * command; the full native command line stays in the tooltip and the detail.
 */
export function readableCommand(title: string): string {
  const m = /^(?:"([^"]+)"|(\S+))\s+(?:(?:-NoProfile|-NoLogo|-l)\s+)*(?:-Command|-c|\/c|-lc)\s+([\s\S]+)$/i.exec(title.trim());
  const exe = (m?.[1] ?? m?.[2] ?? '').split(/[\\/]+/).pop() ?? '';
  if (!m || !/^(pwsh|powershell|cmd|bash|sh|zsh)(\.exe)?$/i.test(exe)) return title;
  let inner = m[3]!.trim();
  const q = inner[0];
  if ((q === "'" || q === '"') && inner.endsWith(q) && inner.length > 1) inner = inner.slice(1, -1);
  return inner;
}


/** Token counts: 1234 → "1.2K", 3_400_000 → "3.4M" (locale-aware). */
export function compactNumber(n: number, locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: n < 1000 ? 0 : 1 }).format(n);
}

/** Dollar estimate; small values keep cents precision instead of rounding to $0. */
export function formatUsd(n: number, locale = 'en-US'): string {
  const digits = n > 0 && n < 0.1 ? 3 : 2;
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}

/** A 0–1 ratio as a percentage: whole percents, one decimal below 10% so small rates don't round to 0%. */
export function formatPercent(r: number, locale = 'en-US'): string {
  const digits = r > 0 && r < 0.1 ? 1 : 0;
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: digits }).format(r);
}

/** Local calendar day (YYYY-MM-DD) of a Date, matching SQLite's date(at, 'localtime'). */
export function localDay(d: Date): string {
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
