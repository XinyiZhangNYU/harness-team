import { useEffect, useRef, useState } from 'react';
import type { Message, Room } from '../../shared/protocol.ts';
import type { TFunc } from './i18n.tsx';

/**
 * Things that need the user: pending native approvals in the loaded rooms. Shown in the tab title and, if the user
 * turned it on, as a desktop notification while the page is in the background. Purely informational: nothing is
 * decided from here.
 */

const PREF_KEY = 'ht.desktopNotifications';

export function pendingApprovals(messages: Record<string, Message[]>): Message[] {
  const out: Message[] = [];
  for (const list of Object.values(messages)) {
    for (const m of list) if (m.kind === 'approval' && m.meta?.type === 'approval' && m.meta.state === 'pending') out.push(m);
  }
  return out;
}

function readPref(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === '1';
  } catch {
    return false;
  }
}

export type NotifyState = 'unsupported' | 'off' | 'on' | 'blocked';

export function useDesktopNotifications(): { state: NotifyState; toggle: () => void } {
  const supported = typeof window !== 'undefined' && 'Notification' in window;
  const compute = (): NotifyState => {
    if (!supported) return 'unsupported';
    if (Notification.permission === 'denied') return 'blocked';
    return readPref() && Notification.permission === 'granted' ? 'on' : 'off';
  };
  const [state, setState] = useState<NotifyState>(compute);
  const toggle = () => {
    if (!supported) return;
    const next = state !== 'on';
    try {
      localStorage.setItem(PREF_KEY, next ? '1' : '0');
    } catch {
      // per-browser convenience only
    }
    if (next && Notification.permission === 'default') {
      void Notification.requestPermission().then(() => setState(compute()));
    } else setState(compute());
  };
  return { state, toggle };
}

export function useAttention(pending: Message[], rooms: Room[], notify: NotifyState, t: TFunc) {
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    document.title = pending.length ? t('notify.docTitle', { n: pending.length }) : 'Harness Team';
  }, [pending.length, t]);
  useEffect(() => {
    // The first load only records what is already there; only approvals that arrive later notify.
    if (seen.current === null) {
      seen.current = new Set(pending.map((m) => m.id));
      return;
    }
    for (const m of pending) {
      if (seen.current.has(m.id)) continue;
      seen.current.add(m.id);
      if (notify !== 'on' || !document.hidden) continue;
      const room = rooms.find((r) => r.id === m.roomId);
      const title = m.meta?.type === 'approval' ? m.meta.title : m.body;
      try {
        const n = new Notification(t('notify.title'), {
          body: `${room ? `#${room.name} · ` : ''}${title}`.slice(0, 180),
          tag: m.id,
        });
        n.onclick = () => window.focus();
      } catch {
        // notifications are best-effort
      }
    }
  }, [pending, rooms, notify, t]);
}
