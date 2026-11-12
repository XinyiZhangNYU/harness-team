import type { ApprovalAnswers, ApprovalField, ApprovalForm } from '../../../../shared/protocol.ts';
import { choiceTexts, elicitationContent, fieldsFromSchema } from '../forms.ts';

/**
 * Questions ACP runtimes ask the user, as a form the group chat renders (the same card as Claude Code's
 * AskUserQuestion and Codex request_user_input), and the user's checked answers in each runtime's own reply format.
 * A question that cannot be shown faithfully gives null: the caller then declines it, never guesses an answer.
 */
export interface AcpQuestion {
  form: ApprovalForm;
  /** Question text shown on the card. */
  detail: string | null;
  /** The reply: `allow` with the checked answers, `reject` (the user refused), `cancelled` (the turn ended first). */
  reply: (decision: 'allow' | 'reject' | 'cancelled', answers?: ApprovalAnswers) => unknown;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * ACP `elicitation/create` in form mode (OpenCode, Antigravity, Kimi Code once the client declares
 * `elicitation.form`). OpenCode's `<id>_custom` and Antigravity's `<id>_other` free-text fields belong to the choice
 * next to them: they become that choice's typed answer and go back under their own key.
 */
export function elicitationQuestion(p: any): AcpQuestion | null {
  if (p?.mode !== undefined && p.mode !== 'form') return null;
  const fields = fieldsFromSchema(p?.requestedSchema);
  if (!fields?.length) return null;
  const byId = new Map(fields.map((f) => [f.id, f]));
  const typedKey = new Map<string, string>();
  const merged = new Set<string>();
  for (const f of fields) {
    if (f.kind !== 'choice' || f.required) continue;
    for (const suffix of ['_custom', '_other']) {
      const o = byId.get(f.id + suffix);
      if (o?.kind === 'text' && !o.required && !o.format && !merged.has(o.id)) {
        typedKey.set(f.id, o.id);
        merged.add(o.id);
        break;
      }
    }
  }
  const form: ApprovalForm = {
    fields: fields.filter((f) => !merged.has(f.id)).map((f) => (f.kind === 'choice' && typedKey.has(f.id) ? { ...f, other: true } : f)),
  };
  return {
    form,
    detail: str(p?.message),
    reply: (decision, answers = {}) => {
      if (decision === 'cancelled') return { action: 'cancel' };
      if (decision === 'reject') return { action: 'decline' };
      const content: Record<string, unknown> = elicitationContent(form, answers);
      for (const [id, key] of typedKey) {
        const v = answers[id];
        if (!v || typeof v !== 'object') continue;
        if (!v.selected.length) delete content[id];
        if (v.other) content[key] = v.other;
      }
      return { action: 'accept', content };
    },
  };
}

/** Questions as a list of `{ question, options: [{ label, description }], multiSelect }` (Grok). */
function choiceFields(qs: { text: string; options: { value: string; label: string; description: string | null }[]; multiple: boolean }[], other: boolean): ApprovalField[] | null {
  if (!qs.length || qs.length > 30 || qs.some((q) => !q.text || !q.options.length)) return null;
  if (new Set(qs.map((q) => q.text)).size !== qs.length) return null;
  if (qs.some((q) => new Set(q.options.map((o) => o.value)).size !== q.options.length)) return null;
  return qs.map((q, i) => ({ kind: 'choice', id: `q${i}`, label: q.text, options: q.options, multiple: q.multiple, other, required: true }));
}

/**
 * Grok's `_x.ai/ask_user_question`. The answers go back by question text; an answer that is none of the options is
 * Grok's typed answer, so the user may type one. Several choices are a list.
 */
export function grokQuestion(p: any): AcpQuestion | null {
  const raw: any[] = Array.isArray(p?.questions) ? p.questions : [];
  const qs = raw.map((q) => ({
    text: str(q?.question) ?? '',
    options: (Array.isArray(q?.options) ? q.options : []).map((o: any) => {
      const label = str(o?.label) ?? '';
      return { value: label, label, description: str(o?.description) };
    }),
    multiple: q?.multiSelect === true,
  }));
  if (qs.some((q) => q.options.some((o: { value: string }) => !o.value))) return null;
  const fields = choiceFields(qs, true);
  if (!fields) return null;
  const form: ApprovalForm = { fields };
  return {
    form,
    detail: null,
    reply: (decision, answers = {}) => {
      if (decision !== 'allow') return { outcome: 'cancelled' };
      const out: Record<string, string | string[]> = {};
      for (const f of fields) {
        const texts = choiceTexts(f, answers[f.id]);
        if (!texts.length) continue;
        out[f.label] = f.kind === 'choice' && f.multiple ? texts : texts[0]!;
      }
      return { outcome: 'accepted', answers: out };
    },
  };
}

/**
 * Cursor's `cursor/ask_question`: options have ids, answers go back as the chosen option ids per question; there is
 * no typed answer. Refusing is Cursor's "skipped" (the model is told the user did not answer).
 */
export function cursorQuestion(p: any): AcpQuestion | null {
  const raw: any[] = Array.isArray(p?.questions) ? p.questions : [];
  const ids = raw.map((q) => str(q?.id) ?? '');
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) return null;
  const qs = raw.map((q) => ({
    text: str(q?.prompt) ?? '',
    options: (Array.isArray(q?.options) ? q.options : []).map((o: any) => ({ value: str(o?.id) ?? '', label: str(o?.label) ?? str(o?.id) ?? '', description: null })),
    multiple: q?.allowMultiple === true,
  }));
  if (qs.some((q) => q.options.some((o: { value: string }) => !o.value))) return null;
  const fields = choiceFields(qs, false);
  if (!fields) return null;
  return {
    form: { fields },
    detail: str(p?.title),
    reply: (decision, answers = {}) => {
      if (decision === 'cancelled') return { outcome: { outcome: 'cancelled' } };
      if (decision === 'reject') return { outcome: { outcome: 'skipped', reason: 'The user chose not to answer in the Harness Team chat.' } };
      return {
        outcome: {
          outcome: 'answered',
          answers: fields.map((f, i) => {
            const v = answers[f.id];
            return { questionId: ids[i], selectedOptionIds: v && typeof v === 'object' ? v.selected : [] };
          }),
        },
      };
    },
  };
}
