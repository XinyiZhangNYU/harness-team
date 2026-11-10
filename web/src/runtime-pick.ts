import type { RuntimeDescriptor } from '../../shared/protocol.ts';

/**
 * The harness the add-member form selects on its own among the usable ones: one not billed per token first; when
 * only harnesses billed per token (their own API login, or a per-token runtime such as dsh) are left, the first of
 * those (the form shows how it is billed). Mock only when nothing else is left.
 */
export function autoPickRuntime(usable: RuntimeDescriptor[]): RuntimeDescriptor | undefined {
  const real = usable.filter((r) => !r.isMock);
  return real.find((r) => r.billing !== 'metered_api') ?? real[0] ?? usable.find((r) => r.isMock);
}

/**
 * The handlers of a harness card's radio. Every explicit choice is the user's: a change, a click, and Space on the card
 * already selected (the browser then fires neither click nor change). Moving focus to it (Tab) is not a choice. The
 * browser's own keyboard handling is left as it is.
 */
export function runtimeRadioHandlers(markPicked: () => void, select: () => void) {
  return {
    onClick: () => markPicked(),
    onKeyDown: (e: { key: string }) => {
      if (e.key === ' ' || e.key === 'Spacebar') markPicked();
    },
    onChange: () => {
      markPicked();
      select();
    },
  };
}

/**
 * After the harnesses were detected again: the harness the form should switch to, or null to keep the current one. A
 * harness the user chose (clicking it, even when it was already selected) is never replaced, also not when it stops
 * working: the form then cannot be submitted until the user chooses another. An automatic choice follows the same rule
 * as at the start.
 */
export function pickAfterDetect(current: { kind: string; usable: boolean } | null, userPicked: boolean, autoPick: RuntimeDescriptor | undefined): RuntimeDescriptor['kind'] | null {
  if (userPicked) return null;
  if (current?.usable && !autoPick) return null;
  return autoPick && autoPick.kind !== current?.kind ? autoPick.kind : null;
}

/** Short name a new member of each harness starts with. */
const MEMBER_NAME: Record<RuntimeDescriptor['kind'], string> = {
  mock: 'Mock',
  codex: 'Codex',
  claude: 'Claude',
  antigravity: 'Antigravity',
  dsh: 'DeepSeek',
  opencode: 'OpenCode',
  chat: 'Chat',
};

/** The name the add-member form starts with: the harness's short name, numbered from 2 when taken (any case). */
export function defaultMemberName(kind: RuntimeDescriptor['kind'], taken: string[]): string {
  return uniqueMemberName(MEMBER_NAME[kind], taken);
}

/** `base`, or `base 2`, `base 3`… when a member already has that name (case does not count). */
export function uniqueMemberName(base: string, taken: string[]): string {
  const used = new Set(taken.map((n) => n.trim().toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!used.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}
