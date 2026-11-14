import { L, type Localized } from '../../../shared/notices.ts';
import type { ApprovalAnswers, ApprovalAnswerValue, ApprovalField, ApprovalForm } from '../../../shared/protocol.ts';

/**
 * Native "ask the user" requests (Codex request_user_input, MCP elicitation, Claude Code AskUserQuestion) as a form the
 * group chat can render, and the user's answers checked against it before anything is sent back to the runtime.
 */

const MAX_FIELDS = 30;
const MAX_TEXT = 20_000;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Fields of an MCP elicitation `requestedSchema` (a flat object of primitive properties). Returns null when the schema
 * uses anything we cannot render faithfully: the request then stays refuse-only rather than sending a guessed answer.
 * An object without properties is a plain yes / no question (the empty list).
 */
export function fieldsFromSchema(schema: unknown): ApprovalField[] | null {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
  const s = schema as any;
  if (s.type !== undefined && s.type !== 'object') return null;
  const props = s.properties ?? {};
  if (!props || typeof props !== 'object' || Array.isArray(props)) return null;
  const required = new Set(Array.isArray(s.required) ? s.required.filter((r: unknown) => typeof r === 'string') : []);
  const entries = Object.entries<any>(props);
  if (entries.length > MAX_FIELDS) return null;
  const fields: ApprovalField[] = [];
  for (const [id, p] of entries) {
    if (!p || typeof p !== 'object') return null;
    const label = str(p.title) ?? id;
    const description = str(p.description);
    const req = required.has(id);
    const single = enumOptions(p);
    if (single) {
      if (p.type !== undefined && p.type !== 'string') return null;
      const def = typeof p.default === 'string' && single.some((o) => o.value === p.default) ? [p.default] : null;
      fields.push({ kind: 'choice', id, label, description, options: single, multiple: false, other: false, required: req, default: def });
      continue;
    }
    switch (p.type) {
      case 'string': {
        const format = ['email', 'uri', 'date', 'date-time'].includes(p.format) ? p.format : null;
        if (p.format !== undefined && !format) return null;
        fields.push({
          kind: 'text',
          id,
          label,
          description,
          secret: false,
          format,
          required: req,
          default: typeof p.default === 'string' ? p.default : null,
          minLength: num(p.minLength),
          maxLength: num(p.maxLength),
        });
        break;
      }
      case 'number':
      case 'integer':
        fields.push({
          kind: 'number',
          id,
          label,
          description,
          integer: p.type === 'integer',
          required: req,
          default: num(p.default),
          min: num(p.minimum),
          max: num(p.maximum),
        });
        break;
      case 'boolean':
        fields.push({ kind: 'boolean', id, label, description, required: req, default: typeof p.default === 'boolean' ? p.default : null });
        break;
      case 'array': {
        const options = p.items && typeof p.items === 'object' ? enumOptions(p.items) : null;
        if (!options) return null;
        const def = Array.isArray(p.default) ? p.default.filter((d: unknown) => typeof d === 'string' && options.some((o) => o.value === d)) : null;
        fields.push({
          kind: 'choice',
          id,
          label,
          description,
          options,
          multiple: true,
          other: false,
          required: req,
          default: def,
          minItems: num(p.minItems),
          maxItems: num(p.maxItems),
        });
        break;
      }
      default:
        return null;
    }
  }
  return fields;
}

/** `enum` (+ legacy `enumNames`), titled `oneOf` / `anyOf` of `{ const, title, description }`. null when it is not a string enum. */
function enumOptions(p: any): { value: string; label: string; description?: string | null }[] | null {
  if (Array.isArray(p.enum)) {
    if (!p.enum.length || !p.enum.every((v: unknown) => typeof v === 'string')) return null;
    const names = Array.isArray(p.enumNames) ? p.enumNames : [];
    return p.enum.map((v: string, i: number) => ({ value: v, label: str(names[i]) ?? v }));
  }
  const list = Array.isArray(p.oneOf) ? p.oneOf : Array.isArray(p.anyOf) ? p.anyOf : null;
  if (!list || !list.length) return null;
  if (!list.every((o: any) => o && typeof o.const === 'string')) return null;
  return list.map((o: any) => ({ value: o.const, label: str(o.title) ?? o.const, ...(str(o.description) ? { description: o.description } : {}) }));
}

/** RFC 3339 date-time (JSON Schema `date-time`): seconds and a time zone are part of it. */
const DATE_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/i;

export type CheckedAnswers = { ok: true; answers: ApprovalAnswers } | { ok: false; error: Localized };

/**
 * Checks the user's answers against the form: every required field answered, choices among the offered options (or
 * typed where the field allows it), numbers in range, text within its limits. Unknown ids are dropped. The result holds
 * only answered fields.
 */
export function checkAnswers(form: ApprovalForm, raw: unknown): CheckedAnswers {
  const given = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: ApprovalAnswers = {};
  for (const f of form.fields) {
    const v = given[f.id];
    const missing = () => (f.required ? { ok: false as const, error: L('请回答“{field}”', 'Please answer “{field}”', { field: f.label }) } : null);
    const bad = (zh: string, en: string) => ({ ok: false as const, error: L(`“{field}”：${zh}`, `“{field}”: ${en}`, { field: f.label }) });
    switch (f.kind) {
      case 'text': {
        if (v === undefined || v === null || v === '') {
          const m = missing();
          if (m) return m;
          continue;
        }
        if (typeof v !== 'string') return bad('应为文本', 'expected text');
        if (v.length > MAX_TEXT || (f.maxLength != null && v.length > f.maxLength)) return bad('太长', 'too long');
        if (f.minLength != null && v.length < f.minLength) return bad('太短', 'too short');
        if (f.format === 'date-time' && (!DATE_TIME.test(v) || Number.isNaN(Date.parse(v)))) return bad('应为带时区的日期时间', 'expected a date and time with a time zone');
        out[f.id] = v;
        break;
      }
      case 'number': {
        if (v === undefined || v === null || v === '') {
          const m = missing();
          if (m) return m;
          continue;
        }
        const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
        if (!Number.isFinite(n) || (f.integer && !Number.isInteger(n))) return bad(f.integer ? '应为整数' : '应为数字', f.integer ? 'expected a whole number' : 'expected a number');
        if ((f.min != null && n < f.min) || (f.max != null && n > f.max)) return bad('超出范围', 'out of range');
        out[f.id] = n;
        break;
      }
      case 'boolean': {
        if (v === undefined || v === null) {
          const m = missing();
          if (m) return m;
          continue;
        }
        if (typeof v !== 'boolean') return bad('应为是或否', 'expected yes or no');
        out[f.id] = v;
        break;
      }
      case 'choice': {
        const c = v && typeof v === 'object' && !Array.isArray(v) ? (v as any) : null;
        const selected: string[] = Array.isArray(c?.selected) ? c.selected.filter((s: unknown) => typeof s === 'string') : [];
        const other = typeof c?.other === 'string' && c.other.trim() ? c.other : null;
        if (!selected.length && !other) {
          const m = missing();
          if (m) return m;
          continue;
        }
        if (other && !f.other) return bad('不能自行填写', 'a typed answer is not accepted');
        if (other && other.length > MAX_TEXT) return bad('太长', 'too long');
        if (selected.some((s) => !f.options.some((o) => o.value === s))) return bad('选项无效', 'not one of the options');
        if (new Set(selected).size !== selected.length) return bad('选项重复', 'repeated option');
        const count = selected.length + (other ? 1 : 0);
        if (!f.multiple && count > 1) return bad('只能选一项', 'choose one');
        if (f.multiple && ((f.minItems != null && count < f.minItems) || (f.maxItems != null && count > f.maxItems))) return bad('选择数量不符', 'wrong number of choices');
        out[f.id] = other ? { selected, other } : { selected };
        break;
      }
    }
  }
  return { ok: true, answers: out };
}

/** MCP elicitation `content` for checked answers (choices: the value, or a list of values when multiple). */
export function elicitationContent(form: ApprovalForm, answers: ApprovalAnswers): Record<string, string | number | boolean | string[]> {
  const out: Record<string, string | number | boolean | string[]> = {};
  for (const f of form.fields) {
    const v = answers[f.id];
    if (v === undefined) continue;
    if (f.kind === 'choice') {
      const sel = (v as { selected: string[] }).selected;
      out[f.id] = f.multiple ? sel : (sel[0] ?? '');
    } else out[f.id] = v as string | number | boolean;
  }
  return out;
}

/** A choice answer as option labels plus the typed text (what Codex / Claude Code expect for their question tools). */
export function choiceTexts(field: ApprovalField, v: ApprovalAnswerValue | undefined): string[] {
  if (field.kind !== 'choice' || !v || typeof v !== 'object') return typeof v === 'string' ? [v] : v === undefined ? [] : [String(v)];
  const labels = v.selected.map((s) => field.options.find((o) => o.value === s)?.label ?? s);
  return v.other ? [...labels, v.other] : labels;
}

/** The answers as shown on the card, by field label. Secret fields are never stored. */
export function answersSummary(form: ApprovalForm, answers: ApprovalAnswers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of form.fields) {
    const v = answers[f.id];
    if (v === undefined) continue;
    const key = out[f.label] === undefined ? f.label : `${f.label} (${f.id})`;
    if (f.kind === 'text' && f.secret) out[key] = '••••';
    else if (f.kind === 'choice') out[key] = choiceTexts(f, v).join(', ');
    else out[key] = String(v);
  }
  return out;
}
