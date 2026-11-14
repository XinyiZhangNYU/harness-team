import type { ChatProvider } from '../../../../../shared/protocol.ts';
import type { Json } from '../body.ts';
import {
  argsObject,
  type AssistantAnswer,
  ChatHttpError,
  finishBody,
  finishHeaders,
  joinUrl,
  loadParts,
  type LoadedPart,
  toolMediaParts,
  parseJson,
  rawFits,
  type StopKind,
  SUMMARY_PREFIX,
  sortedTools,
  type Usage,
  type WireFormat,
} from '../wire.ts';
import { openaiChat } from './openai-chat.ts';

/**
 * Anthropic Messages API (also served by DeepSeek, Kimi, GLM and others at their own Base URL). The answer's content
 * blocks are sent back verbatim on the same model (thinking blocks carry signatures bound to model and conversation;
 * the history is only ever appended to). `pause_turn` (a server tool paused) is continued by the adapter.
 */

type Block = Record<string, Json>;
type Msg = { role: 'user' | 'assistant'; content: Block[] };

const ANTHROPIC_VERSION = '2023-06-01';
/**
 * Web search with dynamic filtering on Anthropic's own API for Opus, Sonnet, Fable and Mythos; the basic variant
 * elsewhere and for Haiku (Haiku 5.5 sent malformed input to the dynamic one and fell back to code execution, 2026-11-10).
 */
const WEB_SEARCH = (baseUrl: string, model: string) =>
  /api\.anthropic\.com/i.test(baseUrl) && !/haiku/i.test(model) ? 'web_search_20260209' : 'web_search_20250305';

/** Anthropic's own API checks where thinking signatures came from; DeepSeek and others want their thinking back as it is. */
const bindsThinking = (baseUrl: string) => /api\.anthropic\.com/i.test(baseUrl);

const auth = (key: string | null): Record<string, string> => ({ 'anthropic-version': ANTHROPIC_VERSION, ...(key ? { 'x-api-key': key } : {}) });

const partBlock = (p: LoadedPart): Block =>
  p.type === 'text'
    ? { type: 'text', text: p.text }
    : p.type === 'image'
      ? { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } }
      : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.data } };

export const anthropic: WireFormat = {
  async build(spec) {
    const messages: Msg[] = [];
    const push = (role: Msg['role'], content: Block[]) => {
      if (!content.length) return;
      const prev = messages[messages.length - 1];
      if (prev?.role === role) prev.content.push(...content);
      else messages.push({ role, content });
    };
    for (const it of spec.items) {
      if (it.role === 'summary') push('user', [{ type: 'text', text: SUMMARY_PREFIX + it.text }]);
      else if (it.role === 'user') {
        const parts = await loadParts(it.parts, spec.model);
        push('user', parts.map(partBlock));
      } else if (it.role === 'assistant') {
        if (rawFits(it.raw, spec) && Array.isArray(it.raw!.data)) {
          let blocks = it.raw!.data as Block[];
          // Anthropic binds thinking to the system prompt, the tools and the history before it: when one of them
          // changed since, the thinking goes and the text and tool calls stay (the same bytes on every later request).
          const stale = bindsThinking(spec.provider.baseUrl) && !!spec.binding && it.raw!.binding !== spec.binding;
          if (stale) blocks = blocks.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
          push('assistant', blocks.length ? blocks : [{ type: 'text', text: '…' }]);
          continue;
        }
        const content: Block[] = [];
        if (it.text) content.push({ type: 'text', text: it.text });
        for (const c of it.toolCalls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: argsObject(c.args) as Json });
        push('assistant', content.length ? content : [{ type: 'text', text: '…' }]);
      } else {
        // Tool results go first in the user message that follows (merging keeps them first).
        push(
          'user',
          it.results.map((r) => {
            // Images and PDFs a tool returned go inside its result.
            const media = toolMediaParts([r], spec.model);
            const content: Json = media.length ? [{ type: 'text', text: r.content || ' ' }, ...media.map(partBlock)] : r.content || ' ';
            return { type: 'tool_result', tool_use_id: r.callId, content, ...(r.isError ? { is_error: true } : {}) };
          }),
        );
      }
    }
    if (messages[0]?.role !== 'user') messages.unshift({ role: 'user', content: [{ type: 'text', text: '…' }] });
    const system: Block[] = spec.system ? [{ type: 'text', text: spec.system }] : [];
    if (spec.model.explicitCache) {
      // Breakpoints: the system prompt (tools come before it, so they are cached too) and the end of the conversation.
      if (system.length) system[system.length - 1]!.cache_control = { type: 'ephemeral' };
      const last = messages[messages.length - 1]!.content;
      const tail = [...last].reverse().find((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
      if (tail) tail.cache_control = { type: 'ephemeral' };
    }
    const tools: Json[] = sortedTools(spec.tools).map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Json }));
    if (spec.webSearch) tools.push({ type: WEB_SEARCH(spec.provider.baseUrl, spec.model.id), name: 'web_search' });
    const body: Record<string, Json> = {
      model: spec.model.id,
      max_tokens: spec.maxOutputTokens ?? spec.model.maxOutputTokens,
      messages: messages as unknown as Json,
      stream: true,
    };
    if (system.length) body.system = system;
    if (tools.length) body.tools = tools;
    return { url: joinUrl(spec.provider.baseUrl, 'messages'), headers: finishHeaders(auth(spec.key), spec), body: finishBody(body, spec) };
  },

  async parse(events, hooks) {
    const blocks: Block[] = [];
    const partial = new Map<number, string>();
    let text = '';
    let reasoning = '';
    let stopReason: string | null = null;
    let stopDetail: string | null = null;
    let usage: Usage | null = null;
    let searches = 0;
    let ended = false;
    let tier: string | null = null;
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const takeUsage = (u: Record<string, unknown> | undefined) => {
      if (!u) return;
      const cur = usage ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
      usage = {
        input: n(u.input_tokens) ?? cur.input,
        cacheRead: n(u.cache_read_input_tokens) ?? cur.cacheRead,
        cacheWrite: n(u.cache_creation_input_tokens) ?? cur.cacheWrite,
        output: n(u.output_tokens) ?? cur.output,
        reasoning: 0,
      };
      if (typeof u.speed === 'string' && u.speed) tier = u.speed;
      const st = u.server_tool_use as { web_search_requests?: unknown } | undefined;
      if (n(st?.web_search_requests) !== null) searches = n(st!.web_search_requests)!;
    };
    for await (const ev of events) {
      const j = parseJson(ev.data) as Record<string, unknown> | undefined;
      if (!j) continue;
      const type = String(j.type ?? ev.event ?? '');
      if (type === 'message_start') takeUsage((j.message as { usage?: Record<string, unknown> } | undefined)?.usage);
      else if (type === 'content_block_start') {
        const i = Number(j.index);
        const b = { ...((j.content_block ?? {}) as Block) };
        if (b.type === 'tool_use' || b.type === 'server_tool_use') {
          partial.set(i, '');
          b.input = {};
        }
        if (b.type === 'text' && typeof b.text === 'string' && b.text) {
          text += b.text;
          hooks.text(b.text);
        }
        blocks[i] = b;
      } else if (type === 'content_block_delta') {
        const i = Number(j.index);
        const b = blocks[i];
        const d = (j.delta ?? {}) as Record<string, unknown>;
        if (!b) continue;
        if (d.type === 'text_delta' && typeof d.text === 'string') {
          b.text = String(b.text ?? '') + d.text;
          text += d.text;
          hooks.text(d.text);
        } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
          b.thinking = String(b.thinking ?? '') + d.thinking;
          reasoning += d.thinking;
          hooks.reasoning(d.thinking);
        } else if (d.type === 'signature_delta' && typeof d.signature === 'string') {
          b.signature = String(b.signature ?? '') + d.signature;
        } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          partial.set(i, (partial.get(i) ?? '') + d.partial_json);
        } else if (d.type === 'citations_delta' && d.citation) {
          b.citations = [...((b.citations as Json[] | undefined) ?? []), d.citation as Json];
        }
      } else if (type === 'content_block_stop') {
        const i = Number(j.index);
        const b = blocks[i];
        if (b && partial.has(i)) {
          const raw = partial.get(i)!;
          b.input = raw ? ((parseJson(raw) as Json) ?? {}) : {};
          partial.delete(i);
          if (b.type === 'server_tool_use' && b.name === 'web_search') {
            const q = (b.input as { query?: unknown }).query;
            hooks.webSearch?.(typeof q === 'string' ? q : null);
          }
        }
        if (b?.type === 'thinking' && reasoning && !reasoning.endsWith('\n\n')) {
          reasoning += '\n\n';
          hooks.reasoning('\n\n');
        }
      } else if (type === 'message_delta') {
        const d = (j.delta ?? {}) as { stop_reason?: string | null; stop_details?: { explanation?: string; category?: string } | null };
        if (d.stop_reason) stopReason = d.stop_reason;
        if (d.stop_details) stopDetail = [d.stop_details.category, d.stop_details.explanation].filter(Boolean).join(': ') || null;
        takeUsage(j.usage as Record<string, unknown> | undefined);
      } else if (type === 'message_stop') {
        ended = true;
      } else if (type === 'error') {
        const e = (j.error ?? {}) as { type?: string; message?: string };
        const status = e.type === 'overloaded_error' ? 529 : e.type === 'rate_limit_error' ? 429 : e.type === 'api_error' ? 500 : 0;
        throw new ChatHttpError(status, `${e.type ?? 'error'}: ${e.message ?? ''}`.trim(), { beforeOutput: !blocks.length });
      }
    }
    const content = blocks.filter(Boolean);
    const toolCalls = content
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: String(b.id ?? ''), name: String(b.name ?? ''), args: JSON.stringify(b.input ?? {}) }))
      .filter((c) => c.id && c.name);
    const stop: StopKind = !ended && !stopReason
      ? 'other'
      : stopReason === 'tool_use' && toolCalls.length
        ? 'tool_calls'
        : stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded'
          ? 'max_tokens'
          : stopReason === 'pause_turn'
            ? 'pause'
            : stopReason === 'refusal'
              ? 'refusal'
              : stopReason === 'end_turn' || stopReason === 'stop_sequence' || stopReason === null
                ? 'end'
                : 'other';
    return {
      text,
      reasoning: reasoning.trim(),
      toolCalls,
      raw: content,
      stop,
      stopDetail: stop === 'other' && !ended ? 'the stream ended before the message completed' : stop === 'refusal' || stop === 'other' ? (stopDetail ?? stopReason) : null,
      usage,
      webSearches: searches,
      tier,
    };
  },

  builtInTools(provider, model, webSearch) {
    return webSearch ? WEB_SEARCH(provider.baseUrl, model.id) : '';
  },

  check(provider: ChatProvider, key: string | null) {
    return { method: 'GET', url: joinUrl(provider.baseUrl, 'models'), headers: { accept: 'application/json', ...auth(key) } };
  },

  // DeepSeek's Anthropic endpoint has no model list; counting tokens is free there and on Anthropic.
  checkWithoutList(provider: ChatProvider, key: string | null, model: string) {
    return {
      method: 'POST',
      url: joinUrl(provider.baseUrl, 'messages/count_tokens'),
      headers: { 'content-type': 'application/json', accept: 'application/json', ...auth(key) },
      body: { model, messages: [{ role: 'user', content: 'ping' }] },
    };
  },

  models: openaiChat.models,
};
