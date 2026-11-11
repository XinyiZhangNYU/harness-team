import { readFile } from 'node:fs/promises';
import type { ChatApiFormat, ChatModel, ChatProvider } from '../../../../shared/protocol.ts';
import { redactText } from '../../redact.ts';
import { extraBodyFor, extraHeadersFor, mappingFor, mergeInto, reasoningOn, SAMPLING_KEYS, type Json } from './body.ts';
import { DOC_LABEL, docKind, extractDocument, ExtractError, legacyOffice } from './extract.ts';

/**
 * What the four wire formats share: the transcript items a chat member keeps (stored as JSON in chat_items), the
 * request a format builds from them, the parsed answer, and the SSE reader.
 */

export interface ToolCall {
  id: string;
  name: string;
  /** Arguments as JSON text (as the model wrote them). */
  args: string;
}

export interface ToolResult {
  callId: string;
  name: string;
  content: string;
  isError?: boolean;
  /** Images and PDFs the tool returned for the model to see (read_file, fetch_url), base64. */
  media?: ToolMedia[];
}

export type ToolMedia = { type: 'image'; mime: string; data: string; name: string } | { type: 'pdf'; data: string; name: string };

export type UserPart =
  | { type: 'text'; text: string }
  | { type: 'attachment'; kind: 'image' | 'file'; name: string; mime: string; path: string };

/** The model's own content of one answer, sent back verbatim to the same format, provider and model. */
export interface RawReplay {
  format: ChatApiFormat;
  providerId: string;
  model: string;
  data: unknown;
  /** `CallSpec.binding` of the request that produced it (absent on older items, which count as changed). */
  binding?: string;
}

export type ChatItem =
  | { role: 'user'; parts: UserPart[] }
  | { role: 'assistant'; text: string; reasoning: string; toolCalls: ToolCall[]; raw: RawReplay | null }
  | { role: 'tool'; results: ToolResult[] }
  /** Replaces everything before it after a compaction. */
  | { role: 'summary'; text: string };

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface CallSpec {
  provider: ChatProvider;
  model: ChatModel;
  key: string | null;
  /** The member's reasoning tag (null = send nothing about reasoning). */
  level: string | null;
  /** Stable hash of member and chat ("{session}" in extra body / headers). */
  session: string;
  system: string;
  /** Items to send. `raw` is already cleared on items that must not be replayed. */
  items: ChatItem[];
  tools: ToolDef[];
  webSearch: boolean;
  /** Overrides the model's output limit (compaction summaries). */
  maxOutputTokens?: number;
  /**
   * Hash of what thinking signatures are bound to besides the appended history: system prompt, tools, web search and
   * the points where the history was rewritten (compaction, clearing, slimmed tool results).
   */
  binding?: string;
}

export interface HttpRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, Json>;
}

export interface Usage {
  /** Uncached input. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** All output, reasoning included. */
  output: number;
  reasoning: number;
}

export type StopKind = 'end' | 'tool_calls' | 'max_tokens' | 'pause' | 'refusal' | 'other';

export interface AssistantAnswer {
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
  raw: unknown;
  stop: StopKind;
  /** The API's own stop / refusal text, when it gave one. */
  stopDetail: string | null;
  usage: Usage | null;
  webSearches: number;
}

export interface StreamHooks {
  text(delta: string): void;
  reasoning(delta: string): void;
  /** A native web search the model ran (query when known). */
  webSearch?(query: string | null): void;
}

export interface SseEvent {
  event: string | null;
  data: string;
}

export interface CheckRequest {
  url: string;
  headers: Record<string, string>;
  method: 'GET' | 'POST';
  body?: unknown;
}

export interface WireFormat {
  build(spec: CallSpec): Promise<HttpRequest>;
  parse(events: AsyncIterable<SseEvent>, hooks: StreamHooks): Promise<AssistantAnswer>;
  /** What this format adds to the tools sent besides the function tools (part of `CallSpec.binding`). */
  builtInTools?(provider: ChatProvider, model: ChatModel, webSearch: boolean): string;
  /** A free request that proves the key works: the model list (or Vertex countTokens). */
  check(provider: ChatProvider, key: string | null, model: string | null): CheckRequest;
  /** Another free request for providers that answer the check with 404 (no model list), given a model to name. */
  checkWithoutList?(provider: ChatProvider, key: string | null, model: string): CheckRequest;
  /** Model ids from the check's answer, or null when the answer is not a model list. */
  models(json: unknown): string[] | null;
}

/** An HTTP or stream error from the provider, with the text it sent (redacted, capped). */
export class ChatHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;
  readonly contextTooLong: boolean;
  /** No output had been streamed when it failed (so the request may be sent again). */
  readonly beforeOutput: boolean;
  constructor(status: number, message: string, opts: { retryAfterMs?: number | null; beforeOutput?: boolean } = {}) {
    super(message);
    this.name = 'ChatHttpError';
    this.status = status;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.beforeOutput = opts.beforeOutput ?? true;
    this.contextTooLong =
      (status === 400 || status === 413 || status === 0) &&
      /context.{0,20}(length|window|limit)|too (long|many tokens)|maximum.{0,30}tokens|token.{0,10}(limit|exceed)|prompt is too long|input.{0,20}exceed/i.test(message);
  }
}

/** Short, redacted text of an error body (JSON `error.message` when there is one). */
export function errorText(body: string): string {
  let msg = body.trim();
  try {
    const j = JSON.parse(msg) as unknown;
    const pick = (o: unknown): string | null => {
      if (!o || typeof o !== 'object') return null;
      const e = (o as { error?: unknown }).error ?? o;
      if (typeof e === 'string') return e;
      if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') return (e as { message: string }).message;
      return null;
    };
    msg = (Array.isArray(j) ? pick(j[0]) : pick(j)) ?? msg;
  } catch {
    // not JSON
  }
  return redactText(msg.replace(/\s+/g, ' ')).slice(0, 600);
}

export function retryAfterMs(h: string | null): number | null {
  if (!h) return null;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(h);
  return Number.isNaN(t) ? null : Math.max(0, t - Date.now());
}

/** Reads `text/event-stream` bytes as events (CRLF, multi-line data and comments handled). */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buf = '';
  let event: string | null = null;
  let data: string[] = [];
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buf += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.search(/\r\n|\r|\n/)) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + (buf[nl] === '\r' && buf[nl + 1] === '\n' ? 2 : 1));
        if (line === '') {
          if (data.length) yield { event, data: data.join('\n') };
          event = null;
          data = [];
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let v = colon < 0 ? '' : line.slice(colon + 1);
        if (v.startsWith(' ')) v = v.slice(1);
        if (field === 'event') event = v;
        else if (field === 'data') data.push(v);
      }
      if (done) break;
    }
    if (buf.trim() && buf.startsWith('data:')) data.push(buf.slice(5).trimStart());
    if (data.length) yield { event, data: data.join('\n') };
  } finally {
    reader.releaseLock();
  }
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Parsed tool-call arguments (an object; anything else becomes {}). */
export function argsObject(args: string): Record<string, unknown> {
  const v = parseJson(args || '{}');
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Adds the reasoning mapping and extra body, and removes sampling keys while reasoning is on. */
export function finishBody(body: Record<string, Json>, spec: CallSpec): Record<string, Json> {
  const m = spec.model;
  if (spec.level !== null && m.reasoningLevels.includes(spec.level)) {
    const frag = mappingFor(m.reasoningMapping, m.reasoningLevels, spec.level);
    if (frag) mergeInto(body, frag);
  }
  const extra = extraBodyFor(m.extraBody, spec.session);
  if (extra) mergeInto(body, extra);
  if (reasoningOn(spec.level) && m.reasoningLevels.length) for (const k of SAMPLING_KEYS) delete body[k];
  return body;
}

export function finishHeaders(base: Record<string, string>, spec: CallSpec): Record<string, string> {
  const extra = extraHeadersFor(spec.model.extraHeaders, spec.session);
  const out: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream', 'user-agent': 'HarnessTeam', ...base };
  for (const [k, v] of Object.entries(extra)) out[k.toLowerCase()] = v;
  return out;
}

export const joinUrl = (base: string, path: string) => `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;

/** Text files sent inline (others are only named). SVG is XML text: no API takes it as an image. */
const TEXT_MIME = /^(text\/|image\/svg\+xml$|application\/(json|xml|x-yaml|yaml|javascript|typescript|x-sh|toml|csv))/;
/** The image types the APIs take (the same ones an upload is recognised as). */
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const INLINE_TEXT_MAX = 200_000;

/** A file of unknown type (source code, a Dockerfile…) counts as text when it is valid UTF-8 with no NUL byte. */
export function looksLikeText(buf: Uint8Array): boolean {
  if (buf.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

export type LoadedPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; data: string; name: string }
  | { type: 'pdf'; data: string; name: string };

/**
 * User parts with attachments read: images and PDFs as base64 when the model takes them, text files (and files of
 * unknown type that turn out to be UTF-8 text) inline, anything else (or what the model cannot take) as a note the
 * model can read.
 */
export async function loadParts(parts: UserPart[], model: ChatModel): Promise<LoadedPart[]> {
  const out: LoadedPart[] = [];
  for (const p of parts) {
    if (p.type === 'text') {
      if (p.text) out.push(p);
      continue;
    }
    const note = (why: string) => out.push({ type: 'text', text: `[Attachment ${p.name} (${p.mime}) not included: ${why}]` });
    try {
      if (IMAGE_MIME.has(p.mime)) {
        if (!model.image) note('this model does not accept images');
        else out.push({ type: 'image', mime: p.mime, data: (await readFile(p.path)).toString('base64'), name: p.name });
      } else if (p.mime === 'application/pdf') {
        if (!model.pdf) note('this model does not accept PDF files');
        else out.push({ type: 'pdf', data: (await readFile(p.path)).toString('base64'), name: p.name });
      } else if (docKind(p.name, p.mime)) {
        const kind = docKind(p.name, p.mime)!;
        try {
          const { text, truncated } = extractDocument(await readFile(p.path), kind, INLINE_TEXT_MAX);
          out.push({ type: 'text', text: `[Attachment ${p.name}: text of the ${DOC_LABEL[kind].en}]\n${text}${truncated ? '\n[…truncated]' : ''}` });
        } catch (e) {
          if (!(e instanceof ExtractError)) throw e;
          note(`its text could not be read (${e.message})`);
        }
      } else if (legacyOffice(p.name, p.mime)) {
        note(`the old Office format cannot be read; save it as ${legacyOffice(p.name, p.mime)}`);
      } else if (TEXT_MIME.test(p.mime) || p.mime === 'application/octet-stream') {
        const buf = await readFile(p.path);
        if (!TEXT_MIME.test(p.mime) && !looksLikeText(buf)) {
          note('this file type cannot be sent to the model');
          continue;
        }
        const text = buf.subarray(0, INLINE_TEXT_MAX).toString('utf8');
        out.push({ type: 'text', text: `[Attachment ${p.name}]\n${text}${buf.length > INLINE_TEXT_MAX ? '\n[…truncated]' : ''}` });
      } else note('this file type cannot be sent to the model');
    } catch {
      note('the file could not be read');
    }
  }
  return out;
}

/** The images and PDFs tools returned, as parts this model takes (a note for each one it does not take). */
export function toolMediaParts(results: ToolResult[], model: ChatModel): LoadedPart[] {
  const out: LoadedPart[] = [];
  for (const r of results) {
    for (const m of r.media ?? []) {
      if (m.type === 'image' ? model.image : model.pdf) out.push(m);
      else out.push({ type: 'text', text: `[${m.name} from ${r.name} left out: this model does not accept ${m.type === 'image' ? 'images' : 'PDF files'}]` });
    }
  }
  return out;
}

/** Text put before the media of tool results in formats that send them as a user message. */
export const TOOL_MEDIA_INTRO = '[Files returned by the tool calls above]';

export const SUMMARY_PREFIX = '[Summary of the earlier conversation]\n';

/** Whether an item's raw content may be replayed to this call (same format, provider and model). */
export const rawFits = (raw: RawReplay | null, spec: CallSpec) =>
  !!raw && raw.format === spec.provider.format && raw.providerId === spec.provider.id && raw.model === spec.model.id;

/** Tool definitions in a stable order (by name), so the cached prefix does not change between requests. */
export const sortedTools = (tools: ToolDef[]) => [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
