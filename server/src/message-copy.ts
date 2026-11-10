import type { MessageMeta } from '../../shared/protocol.ts';
import { isNotice, renderNotice, type Localized, type NoticeText, type NoticeValue } from '../../shared/notices.ts';
import { redactSecretField, redactText } from './redact.ts';

/** Inspect the rendered text as well as its parts: a template can supply the secret's key or quoting. */
export function redactNotice(source: NoticeText, redact: (text: string) => string = redactText): { value: NoticeText; changed: boolean } {
  let changed = false;
  const text = (s: string) => {
    const out = redact(s);
    changed ||= out !== s;
    return out;
  };
  const value = (v: NoticeValue | null | undefined): NoticeValue | null | undefined => {
    if (typeof v === 'string') return text(v);
    if (v == null || typeof v === 'number') return v;
    if (Array.isArray(v)) return v.map(x => value(x)) as string[] | NoticeText[];
    if (isNotice(v)) {
      const safe = redactNotice(v, redact);
      changed ||= safe.changed;
      return safe.value;
    }
    return { lines: v.lines.map(n => value(n) as NoticeText) };
  };
  const params = source.params
    ? Object.fromEntries(Object.entries(source.params).map(([k, v]) => {
        const field = redactSecretField(k, v) as NoticeValue | null | undefined;
        changed ||= field !== v;
        return [k, value(field)];
      }))
    : undefined;
  const safe: NoticeText = params ? { ...source, params } : { ...source };
  const zh = renderNotice(safe, 'zh'), en = renderNotice(safe, 'en');
  const safeZh = text(zh), safeEn = text(en);
  // Materialize only when the sensitive span crosses template/parameter boundaries. No raw params may survive it.
  if (safeZh !== zh || safeEn !== en) {
    // Keep rendered braces literal instead of interpreting them as a second template on the next read.
    return { value: { zh: '{zh}', en: '{en}', params: { zh: safeZh, en: safeEn } }, changed: true };
  }
  return { value: safe, changed };
}

export function redactLocalized(source: Localized, redact: (text: string) => string = redactText): { value: Localized; changed: boolean } {
  if (typeof source !== 'string') return redactNotice(source, redact);
  const value = redact(source);
  return { value, changed: value !== source };
}

/** Only display fields are copies; native ids, states and request routing remain exact. */
export function redactMessageCopy(body: string, source: MessageMeta | null, redact: (text: string) => string = redactText): { body: string; meta: MessageMeta | null; changed: boolean } {
  const safeBody = redact(body);
  let changed = safeBody !== body;
  const text = <T extends string | null | undefined>(s: T): T => {
    if (typeof s !== 'string') return s;
    const out = redact(s);
    changed ||= out !== s;
    return out as T;
  };
  const notice = (n: NoticeText) => {
    const safe = redactNotice(n, redact);
    changed ||= safe.changed;
    return safe.value;
  };
  let meta = source;
  switch (source?.type) {
    case 'command':
      meta = { ...source, args: text(source.args) };
      break;
    case 'notice':
      meta = { ...source, notice: notice(source.notice) };
      break;
    case 'activity':
      meta = {
        ...source, title: text(source.title),
        ...(source.detail !== undefined ? { detail: text(source.detail) } : {}),
        ...(source.label ? { label: notice(source.label) } : {}),
        ...(source.files ? { files: source.files.map(f => ({ ...f, path: text(f.path), diff: text(f.diff) })) } : {}),
      };
      break;
    case 'approval':
      meta = {
        ...source, title: text(source.title),
        ...(source.detail !== undefined ? { detail: text(source.detail) } : {}),
        ...(source.reason !== undefined ? { reason: text(source.reason) } : {}),
        ...(source.workspace !== undefined ? { workspace: text(source.workspace) } : {}),
        ...(source.decision !== undefined ? { decision: text(source.decision) } : {}),
        ...(source.label ? { label: notice(source.label) } : {}),
      };
      break;
  }
  return { body: safeBody, meta, changed };
}
