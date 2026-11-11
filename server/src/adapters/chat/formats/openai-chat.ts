import type { ChatProvider } from '../../../../../shared/protocol.ts';
import type { Json } from '../body.ts';
import {
  type AssistantAnswer,
  type CallSpec,
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
  type SseEvent,
  type StopKind,
  type StreamHooks,
  SUMMARY_PREFIX,
  sortedTools,
  type ToolCall,
  type Usage,
  type WireFormat,
} from '../wire.ts';

/**
 * OpenAI Chat Completions and the many APIs that copy it (DeepSeek, GLM, Kimi, OpenRouter, local servers).
 * Reasoning comes back as `reasoning_content` (DeepSeek, GLM) or `reasoning` (OpenRouter); it is sent back as
 * `reasoning_content`, which the APIs that need it in a tool loop (DeepSeek, GLM) read.
 */

type Msg = Record<string, Json>;

const auth = (key: string | null): Record<string, string> => (key ? { authorization: `Bearer ${key}` } : {});

const partJson = (p: LoadedPart): Json =>
  p.type === 'text'
    ? { type: 'text', text: p.text }
    : p.type === 'image'
      ? { type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.data}` } }
      : { type: 'file', file: { filename: p.name, file_data: `data:application/pdf;base64,${p.data}` } };

export const openaiChat: WireFormat = {
  async build(spec) {
    const messages: Msg[] = [];
    if (spec.system) messages.push({ role: 'system', content: spec.system });
    for (const it of spec.items) {
      if (it.role === 'summary') {
        messages.push({ role: 'user', content: SUMMARY_PREFIX + it.text });
      } else if (it.role === 'user') {
        const parts = await loadParts(it.parts, spec.model);
        const content: Json[] = parts.map(partJson);
        const prev = messages[messages.length - 1];
        // Consecutive user messages are merged (some APIs refuse two in a row).
        if (prev?.role === 'user' && Array.isArray(prev.content)) (prev.content as Json[]).push(...content);
        else if (prev?.role === 'user' && typeof prev.content === 'string') prev.content = [{ type: 'text', text: prev.content }, ...content];
        else messages.push({ role: 'user', content: content.length ? content : [{ type: 'text', text: ' ' }] });
      } else if (it.role === 'assistant') {
        const m: Msg = { role: 'assistant', content: it.text || null };
        if (it.toolCalls.length) {
          m.tool_calls = it.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } }));
        }
        const raw = rawFits(it.raw, spec) ? (it.raw!.data as { reasoning_content?: string } | null) : null;
        if (raw?.reasoning_content) m.reasoning_content = raw.reasoning_content;
        if (m.content === null && !m.tool_calls) m.content = '';
        messages.push(m);
      } else {
        for (const r of it.results) messages.push({ role: 'tool', tool_call_id: r.callId, content: r.content });
        // Tool messages take text only: images and PDFs a tool returned follow as a user message.
        const media = toolMediaParts(it.results, spec.model);
        if (media.length) messages.push({ role: 'user', content: [{ type: 'text', text: TOOL_MEDIA_INTRO }, ...media.map(partJson)] });
      }
    }
    const max = spec.maxOutputTokens ?? spec.model.maxOutputTokens;
    const body: Record<string, Json> = {
      model: spec.model.id,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      // OpenAI itself only takes max_completion_tokens for reasoning models; the copies take max_tokens.
      [/api\.openai\.com/i.test(spec.provider.baseUrl) ? 'max_completion_tokens' : 'max_tokens']: max,
    };
    if (spec.tools.length) {
      body.tools = sortedTools(spec.tools).map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters as Json },
      }));
    }
    return {
      url: joinUrl(spec.provider.baseUrl, 'chat/completions'),
      headers: finishHeaders(auth(spec.key), spec),
      body: finishBody(body, spec),
    };
  },

  async parse(events, hooks) {
    return parseChatStream(events, hooks);
  },

  check(provider: ChatProvider, key: string | null) {
    return { method: 'GET', url: joinUrl(provider.baseUrl, 'models'), headers: { accept: 'application/json', ...auth(key) } };
  },

  models(json) {
    const data = (json as { data?: unknown })?.data;
    return Array.isArray(data) ? data.map((m) => (m as { id?: unknown }).id).filter((x): x is string => typeof x === 'string') : null;
  },
};

export async function parseChatStream(events: AsyncIterable<SseEvent>, hooks: StreamHooks): Promise<AssistantAnswer> {
  let text = '';
  let reasoning = '';
  let finish: string | null = null;
  let usage: Usage | null = null;
  const calls = new Map<number, ToolCall>();
  for await (const ev of events) {
    if (ev.data === '[DONE]') break;
    const j = parseJson(ev.data) as Record<string, unknown> | undefined;
    if (!j) continue;
    if (j.error) {
      const e = j.error as { message?: string; code?: unknown };
      throw new ChatHttpError(Number(e.code) || 0, String(e.message ?? 'stream error'), { beforeOutput: !text && !calls.size });
    }
    const u = j.usage as Record<string, unknown> | null | undefined;
    if (u) usage = chatUsage(u);
    const choice = (j.choices as Record<string, unknown>[] | undefined)?.[0];
    if (!choice) continue;
    const d = (choice.delta ?? {}) as Record<string, unknown>;
    const r = typeof d.reasoning_content === 'string' ? d.reasoning_content : typeof d.reasoning === 'string' ? d.reasoning : '';
    if (r) {
      reasoning += r;
      hooks.reasoning(r);
    }
    if (typeof d.content === 'string' && d.content) {
      text += d.content;
      hooks.text(d.content);
    }
    for (const tc of (d.tool_calls as Record<string, unknown>[] | undefined) ?? []) {
      const idx = typeof tc.index === 'number' ? tc.index : calls.size;
      const f = (tc.function ?? {}) as { name?: string; arguments?: string };
      const cur = calls.get(idx) ?? { id: '', name: '', args: '' };
      if (typeof tc.id === 'string' && tc.id) cur.id = tc.id;
      if (f.name) cur.name += f.name;
      if (f.arguments) cur.args += f.arguments;
      calls.set(idx, cur);
    }
    if (typeof choice.finish_reason === 'string') finish = choice.finish_reason;
  }
  const toolCalls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, c]) => ({ ...c, id: c.id || `call_${i}` }))
    .filter((c) => c.name);
  const stop: StopKind =
    toolCalls.length ? 'tool_calls' : finish === 'length' ? 'max_tokens' : finish === 'content_filter' ? 'refusal' : finish === 'stop' || finish === null ? 'end' : 'other';
  return {
    text,
    reasoning,
    toolCalls,
    raw: reasoning ? { reasoning_content: reasoning } : null,
    stop,
    stopDetail: stop === 'other' || stop === 'refusal' ? finish : null,
    usage,
    webSearches: 0,
  };
}

function chatUsage(u: Record<string, unknown>): Usage {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const prompt = n(u.prompt_tokens);
  const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  // DeepSeek reports cache hits as prompt_cache_hit_tokens; the rest as prompt_tokens_details.cached_tokens.
  const cached = Math.min(prompt, n(details.cached_tokens) || n(u.prompt_cache_hit_tokens));
  const out = (u.completion_tokens_details ?? {}) as Record<string, unknown>;
  return { input: prompt - cached, cacheRead: cached, cacheWrite: 0, output: n(u.completion_tokens), reasoning: n(out.reasoning_tokens) };
}
