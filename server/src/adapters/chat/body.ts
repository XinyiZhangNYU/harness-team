/**
 * Request-body JSON the user writes per model: the reasoning mapping, extra body fields and extra headers. Plain JSON
 * only (no expression language): a mapping is either a template whose string values contain "{level}", or an object
 * whose top-level keys are all reasoning tags. A null value removes that key from the request body.
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** Parses an optional JSON object text ('' = none). Throws a short reason when it is not a JSON object. */
export function parseObject(text: string, what: string): Obj | null {
  if (!text.trim()) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new Error(`${what}: ${(e as Error).message}`);
  }
  if (!isObj(v)) throw new Error(`${what}: not a JSON object`);
  return v;
}

/** Whether a parsed mapping is written per tag (every top-level key is a tag) rather than as a "{level}" template. */
function perLevel(m: Obj, levels: string[]): boolean {
  const keys = Object.keys(m);
  return keys.length > 0 && keys.every((k) => levels.includes(k)) && keys.every((k) => isObj(m[k]));
}

/**
 * Checks a reasoning mapping against the model's tags. Returns null when fine, else the problem (in English; the UI
 * shows it as is next to the field).
 */
export function mappingProblem(text: string, levels: string[]): string | null {
  let m: Obj | null;
  try {
    m = parseObject(text, 'mapping');
  } catch (e) {
    return (e as Error).message;
  }
  if (!m) return null;
  if (perLevel(m, levels)) return null;
  const keys = Object.keys(m);
  const tags = keys.filter((k) => levels.includes(k));
  if (tags.length && tags.length !== keys.length) return `mixes tags (${tags.join(', ')}) with other keys`;
  if (!JSON.stringify(m).includes('{level}')) {
    if (!levels.length) return null;
    return 'neither a "{level}" template nor one entry per tag';
  }
  return null;
}

function replaceStrings(v: Json, from: string, to: string): Json {
  if (typeof v === 'string') return v.split(from).join(to);
  if (Array.isArray(v)) return v.map((x) => replaceStrings(x, from, to));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, replaceStrings(x, from, to)]));
  return v;
}

/** Deep-merges `patch` into `target` in place: objects merge, anything else replaces, null deletes the key. */
export function mergeInto(target: Obj, patch: Obj): Obj {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete target[k];
    else if (isObj(v) && isObj(target[k])) mergeInto(target[k] as Obj, v);
    else target[k] = isObj(v) ? mergeInto({}, v) : v;
  }
  return target;
}

/** The body fragment a mapping gives for `level` (null when the mapping has nothing for it). */
export function mappingFor(text: string, levels: string[], level: string): Obj | null {
  const m = parseObject(text, 'mapping');
  if (!m) return null;
  if (perLevel(m, levels)) return isObj(m[level]) ? (m[level] as Obj) : null;
  return replaceStrings(m, '{level}', level) as Obj;
}

/** The extra body fields with "{session}" replaced. */
export function extraBodyFor(text: string, session: string): Obj | null {
  const m = parseObject(text, 'extra body');
  return m ? (replaceStrings(m, '{session}', session) as Obj) : null;
}

/** Extra headers: string values only, "{session}" replaced. */
export function extraHeadersFor(text: string, session: string): Record<string, string> {
  const m = parseObject(text, 'extra headers');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m ?? {})) {
    if (typeof v !== 'string') throw new Error(`extra headers: "${k}" is not a string`);
    out[k] = v.split('{session}').join(session);
  }
  return out;
}

export function headersProblem(text: string): string | null {
  try {
    extraHeadersFor(text, 'x');
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Tags that mean "reasoning off": sampling parameters stay allowed only then. */
const OFF = new Set(['off', 'none', 'disabled']);
export const reasoningOn = (level: string | null) => level !== null && !OFF.has(level.toLowerCase());

/** Sampling parameters that reasoning models refuse (OpenAI, Anthropic: 400) or want left alone (Kimi). */
export const SAMPLING_KEYS = ['temperature', 'top_p', 'top_k', 'top_logprobs', 'logprobs', 'presence_penalty', 'frequency_penalty'];
