const pad = (n: number) => String(n).padStart(2, '0');

/** A time from a native form (RFC 3339) as the local value of a datetime-local control; '' when it is not a time. */
export function toLocalInput(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A datetime-local value (the user's local time) as RFC 3339 with the local offset; '' when cleared. */
export function fromLocalInput(local: string): string {
  const d = new Date(local);
  if (!local || Number.isNaN(d.getTime())) return '';
  const off = -d.getTimezoneOffset();
  const zone = `${off < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  return `${toLocalInput(local)}:${pad(d.getSeconds())}${zone}`;
}
