import type { ChatProvider } from '../../../../../shared/protocol.ts';
import type { Json } from '../body.ts';
import {
  type AssistantAnswer,
  ChatHttpError,
  finishBody,
  finishHeaders,
  joinUrl,
  loadParts,
  type LoadedPart,
  toolMediaParts,
  TOOL_MEDIA_INTRO,
  parseJson,
  rawFits,
  type StopKind,
  SUMMARY_PREFIX,
  sortedTools,
  type ToolCall,
  type Usage,
  type WireFormat,
} from '../wire.ts';
import { openaiChat } from './openai-chat.ts';

/**
 * OpenAI Responses API, stateless: `store: false`, and the model's own output items (reasoning with its encrypted
 * content, messages, function calls) are sent back as input. Ids and statuses are removed from replayed items (they
 * refer to stored items, which do not exist), and web search calls are dropped (they cannot be sent back).
 */

type Item = Record<string, Json>;

const auth = (key: string | null): Record<string, string> => (key ? { authorization: `Bearer ${key}` } : {});

function replayItems(items: unknown): Item[] {
  if (!Array.isArray(items)) return [];
  const out: Item[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const it = { ...(raw as Item) };
    if (it.type === 'web_search_call') continue;
    delete it.id;
    delete it.status;
    out.push(it);
  }
  return out;
}

const partJson = (p: LoadedPart): Json =>
  p.type === 'text'
    ? { type: 'input_text', text: p.text }
    : p.type === 'image'
      ? { type: 'input_image', image_url: `data:${p.mime};base64,${p.data}` }
      : { type: 'input_file', filename: p.name, file_data: `data:application/pdf;base64,${p.data}` };

export const openaiResponses: WireFormat = {
  async build(spec) {
    const input: Item[] = [];
    for (const it of spec.items) {
      if (it.role === 'summary') {
        input.push({ role: 'user', content: [{ type: 'input_text', text: SUMMARY_PREFIX + it.text }] });
      } else if (it.role === 'user') {
        const parts = await loadParts(it.parts, spec.model);
        const content: Json[] = parts.map(partJson);
        const prev = input[input.length - 1];
        if (prev?.role === 'user' && Array.isArray(prev.content)) (prev.content as Json[]).push(...content);
        else input.push({ role: 'user', content: content.length ? content : [{ type: 'input_text', text: ' ' }] });
      } else if (it.role === 'assistant') {
        if (rawFits(it.raw, spec)) {
          input.push(...replayItems(it.raw!.data));
          continue;
        }
        if (it.text) input.push({ role: 'assistant', content: [{ type: 'output_text', text: it.text }] });
        for (const c of it.toolCalls) input.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.args || '{}' });
      } else {
        for (const r of it.results) input.push({ type: 'function_call_output', call_id: r.callId, output: r.content });
        // Images and PDFs a tool returned follow as a user message (understood by every Responses-compatible API).
        const media = toolMediaParts(it.results, spec.model);
        if (media.length) input.push({ role: 'user', content: [{ type: 'input_text', text: TOOL_MEDIA_INTRO }, ...media.map(partJson)] });
      }
    }
    const tools: Json[] = sortedTools(spec.tools).map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.parameters as Json,
      strict: false,
    }));
    if (spec.webSearch) tools.push({ type: 'web_search' });
    const body: Record<string, Json> = {
      model: spec.model.id,
      input,
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
      max_output_tokens: spec.maxOutputTokens ?? spec.model.maxOutputTokens,
    };
    if (spec.system) body.instructions = spec.system;
    if (tools.length) body.tools = tools;
    return {
      url: joinUrl(spec.provider.baseUrl, 'responses'),
      headers: finishHeaders(auth(spec.key), spec),
      body: finishBody(body, spec),
    };
  },

  async parse(events, hooks) {
    let text = '';
    let reasoning = '';
    const done: Item[] = [];
    let final: Record<string, unknown> | null = null;
    let searches = 0;
    for await (const ev of events) {
      const j = parseJson(ev.data) as Record<string, unknown> | undefined;
      if (!j) continue;
      const type = String(j.type ?? ev.event ?? '');
      if (type === 'response.output_text.delta' && typeof j.delta === 'string') {
        text += j.delta;
        hooks.text(j.delta);
      } else if ((type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') && typeof j.delta === 'string') {
        reasoning += j.delta;
        hooks.reasoning(j.delta);
      } else if (type === 'response.reasoning_summary_part.done' && reasoning && !reasoning.endsWith('\n\n')) {
        reasoning += '\n\n';
        hooks.reasoning('\n\n');
      } else if (type === 'response.output_item.done' && j.item && typeof j.item === 'object') {
        const item = j.item as Item;
        done.push(item);
        if (item.type === 'web_search_call') {
          searches++;
          const action = (item.action ?? {}) as { query?: unknown };
          hooks.webSearch?.(typeof action.query === 'string' ? action.query : null);
        }
      } else if (type === 'response.completed' || type === 'response.incomplete') {
        final = (j.response ?? null) as Record<string, unknown> | null;
      } else if (type === 'response.failed' || type === 'error') {
        const r = (j.response ?? j) as { error?: { message?: string; code?: string }; message?: string; code?: string };
        const msg = r.error?.message ?? r.message ?? 'the response failed';
        throw new ChatHttpError(0, `${r.error?.code ?? r.code ?? ''} ${msg}`.trim(), { beforeOutput: !text && !done.length });
      }
    }
    const output = done.length ? done : ((final?.output as Item[] | undefined) ?? []);
    if (!text) {
      for (const it of output) {
        if (it.type !== 'message') continue;
        for (const c of (it.content as Item[] | undefined) ?? []) if (c.type === 'output_text' && typeof c.text === 'string') text += c.text;
      }
    }
    const toolCalls: ToolCall[] = output
      .filter((it) => it.type === 'function_call')
      .map((it) => ({ id: String(it.call_id ?? it.id ?? ''), name: String(it.name ?? ''), args: String(it.arguments ?? '{}') }))
      .filter((c) => c.name && c.id);
    const status = final?.status;
    const incomplete = (final?.incomplete_details ?? null) as { reason?: string } | null;
    const stop: StopKind = toolCalls.length
      ? 'tool_calls'
      : status === 'incomplete'
        ? incomplete?.reason === 'max_output_tokens'
          ? 'max_tokens'
          : incomplete?.reason === 'content_filter'
            ? 'refusal'
            : 'other'
        : final || output.length
          ? 'end'
          : 'other';
    return {
      text,
      reasoning,
      toolCalls,
      raw: output,
      stop,
      stopDetail: stop === 'other' || stop === 'refusal' ? (incomplete?.reason ?? (final ? null : 'the stream ended before the response completed')) : null,
      usage: final?.usage ? responsesUsage(final.usage as Record<string, unknown>) : null,
      webSearches: searches,
    };
  },

  check(provider: ChatProvider, key: string | null) {
    return { method: 'GET', url: joinUrl(provider.baseUrl, 'models'), headers: { accept: 'application/json', ...auth(key) } };
  },

  models: openaiChat.models,
};

function responsesUsage(u: Record<string, unknown>): Usage {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const input = n(u.input_tokens);
  const cached = Math.min(input, n((u.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens));
  return {
    input: input - cached,
    cacheRead: cached,
    cacheWrite: 0,
    output: n(u.output_tokens),
    reasoning: n((u.output_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens),
  };
}
