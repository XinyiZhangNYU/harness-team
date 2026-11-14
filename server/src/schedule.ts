import { SCHEDULE_MIN_INTERVAL_MINUTES, type ScheduleRepeat } from '../../shared/protocol.ts';

/** Longest gap an `interval` task may have (30 days). */
const MAX_INTERVAL_MINUTES = 30 * 24 * 60;

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Checks a repeat rule from the client and returns it in its stored form, or an error (L-style pair). */
export function normalizeRepeat(r: ScheduleRepeat): { repeat: ScheduleRepeat } | { error: [string, string] } {
  switch (r.kind) {
    case 'once': {
      const at = new Date(r.at);
      if (!r.at || Number.isNaN(at.getTime())) return { error: ['时间无效', 'Invalid time'] };
      return { repeat: { kind: 'once', at: at.toISOString() } };
    }
    case 'daily':
      if (!TIME.test(r.time)) return { error: ['时间应为 HH:MM', 'Time must be HH:MM'] };
      return { repeat: { kind: 'daily', time: r.time } };
    case 'weekly': {
      if (!TIME.test(r.time)) return { error: ['时间应为 HH:MM', 'Time must be HH:MM'] };
      const days = [...new Set(r.days)].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort((a, b) => a - b);
      if (!days.length || days.length !== new Set(r.days).size) return { error: ['请选择星期几', 'Choose the days of the week'] };
      return { repeat: { kind: 'weekly', time: r.time, days } };
    }
    case 'interval': {
      const m = r.minutes;
      if (!Number.isInteger(m) || m < SCHEDULE_MIN_INTERVAL_MINUTES || m > MAX_INTERVAL_MINUTES) {
        return { error: [`间隔应为 ${SCHEDULE_MIN_INTERVAL_MINUTES} 分钟到 30 天`, `The interval must be ${SCHEDULE_MIN_INTERVAL_MINUTES} minutes to 30 days`] };
      }
      return { repeat: { kind: 'interval', minutes: m } };
    }
  }
}

/** The first time after `from` that the rule fires (local time of this machine), or null when it never does again. */
export function nextRunAfter(r: ScheduleRepeat, from: Date): Date | null {
  switch (r.kind) {
    case 'once': {
      const at = new Date(r.at);
      return at.getTime() > from.getTime() ? at : null;
    }
    case 'interval':
      return new Date(from.getTime() + r.minutes * 60_000);
    case 'daily':
    case 'weekly': {
      const [h, m] = r.time.split(':').map(Number) as [number, number];
      const days = r.kind === 'weekly' ? new Set(r.days) : null;
      // Eight days covers every weekday once more; setDate keeps the wall-clock time across a DST change.
      for (let i = 0; i <= 8; i++) {
        const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, h, m, 0, 0);
        if (d.getTime() <= from.getTime()) continue;
        if (days && !days.has(d.getDay())) continue;
        return d;
      }
      return null;
    }
  }
}
