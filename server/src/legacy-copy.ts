import type { MessageMeta } from '../../shared/protocol.ts';
import { renderNotice, type Localized, type NoticeText } from '../../shared/notices.ts';
import { redactMessageCopy, redactNotice } from './message-copy.ts';
import { redactText } from './redact.ts';

const R = '[redacted]';
const PROBE = 'HT_LEGACY_REDACTION_VALUE_23';
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

/**
 * Earlier redactors could remove an escape before a quote while leaving a secret's tail outside that quote.
 * Test whether an existing marker occupies a sensitive value; a literal marker in ordinary prose stays literal.
 * This is migration-only. The probe never leaves this function or replaces any source sent to a runtime.
 */
export function hasLegacySecretMarker(text: string): boolean {
  if (!text.includes(R)) return false;
  // A final marker followed only by closing syntax cannot have the leaked tail this migration repairs.
  // Keep its existing provenance, including NULL. Find the last other character once, rather than
  // repeatedly scanning the suffix of every marker in a large message.
  let lastContent = -1;
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith(R, i)) { i += R.length - 1; continue; }
    if (!/[\s"'\\},;\])]/.test(text[i]!)) lastContent = i;
  }
  const probe = text.replaceAll(R, (_marker, at: number) => at + R.length <= lastContent ? PROBE : R);
  return occurrences(redactText(probe), PROBE) < occurrences(probe, PROBE);
}

/**
 * A damaged old copy cannot establish its original value boundary. Replace this one display field, without
 * guessing where its surviving secret ends or scanning into other fields/records. Unchanged values keep their form.
 */
export function redactLegacyText(text: string): string {
  // Newly discovered secrets use the same fixed point as old partial copies: repeating the migration cannot
  // turn a freshly redacted value into a different, more destructive result on the next pass.
  return hasLegacySecretMarker(text) || redactText(text) !== text ? R : text;
}

export function redactLegacyNotice(source: NoticeText): { value: NoticeText; changed: boolean } {
  // A template may supply the key/quotes around a parameter. If either language exposes an old damaged value,
  // replace the localized display unit in both languages and discard its parameters, including unused ones.
  const safe = redactNotice(source, redactLegacyText);
  if (safe.changed || hasLegacySecretMarker(renderNotice(source, 'zh')) || hasLegacySecretMarker(renderNotice(source, 'en'))) {
    return { value: { zh: R, en: R }, changed: true };
  }
  return safe;
}

export function redactLegacyLocalized(source: Localized): { value: Localized; changed: boolean } {
  if (typeof source !== 'string') return redactLegacyNotice(source);
  const value = redactLegacyText(source);
  return { value, changed: value !== source };
}

/** Typed metadata traversal preserves native identifiers, kinds, states and routing fields. */
export function redactLegacyMessageCopy(body: string, source: MessageMeta | null): { body: string; meta: MessageMeta | null; changed: boolean } {
  let meta = source, legacyChanged = false;
  if (source?.type === 'notice') {
    const safe = redactLegacyNotice(source.notice);
    meta = { ...source, notice: safe.value };
    legacyChanged = safe.changed;
  } else if ((source?.type === 'activity' || source?.type === 'approval') && source.label) {
    const safe = redactLegacyNotice(source.label);
    meta = { ...source, label: safe.value };
    legacyChanged = safe.changed;
  }
  const copy = redactMessageCopy(body, meta, redactLegacyText);
  return { ...copy, changed: copy.changed || legacyChanged };
}
