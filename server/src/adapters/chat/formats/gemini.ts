import type { ChatProvider } from '../../../../../shared/protocol.ts';
import type { Json } from '../body.ts';
import { isVertexUrl } from '../catalog.ts';
import {
  argsObject,
  type AssistantAnswer,
  ChatHttpError,
  type CallSpec,
  finishBody,
  finishHeaders,
  parseJson,
  loadParts,
  type LoadedPart,
  toolMediaParts,
  rawFits,
  type StopKind,
  SUMMARY_PREFIX,
  sortedTools,
  type ToolCall,
  type Usage,
  type WireFormat,
} from '../wire.ts';

/**
 * Gemini API (AI Studio) and Vertex AI with an API key. The model's parts are sent back verbatim on the same model
 * (they carry thought signatures, which Gemini 3 requires for function calls of the current turn). Rebuilt function
 * calls get Google's documented placeholder signature instead.
 */

type Part = Record<string, Json>;
type Content = { role: 'user' | 'model'; parts: Part[] };

/** Google's documented value for a function call whose real signature is not available (history from elsewhere). */
const SKIP_SIGNATURE = 'skip_thought_signature_validator';

const auth = (key: string | null): Record<string, string> => (key ? { 'x-goog-api-key': key } : {});

/** `{prefix}/models/{m}` (Gemini API) or the Vertex AI publisher path. */
export function modelPath(provider: Pick<ChatProvider, 'baseUrl' | 'vertexProject' | 'vertexLocation'>, model: string): string {
  const base = provider.baseUrl.replace(/\/+$/, '');
  const m = encodeURIComponent(model);
  if (!isVertexUrl(base)) return `${base}/models/${m}`;
  if (!provider.vertexProject) return `${base}/publishers/google/models/${m}`;
  const loc = provider.vertexLocation || 'global';
  let root = base;
  if (loc !== 'global') {
    // A regional location has its own host: {location}-aiplatform.googleapis.com.
    const u = new URL(base);
    if (u.hostname === 'aiplatform.googleapis.com') u.hostname = `${loc}-aiplatform.googleapis.com`;
    root = u.toString().replace(/\/+$/, '');
  }
  return `${root}/projects/${encodeURIComponent(provider.vertexProject)}/locations/${encodeURIComponent(loc)}/publishers/google/models/${m}`;
}

/** JSON schema keys Gemini accepts (an OpenAPI subset); the rest is dropped. A type array becomes type + nullable. */
const SCHEMA_KEYS = new Set(['type', 'format', 'description', 'nullable', 'enum', 'properties', 'required', 'items', 'minItems', 'maxItems', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'anyOf', 'title']);

export function geminiSchema(s: unknown): Json {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return {};
  const src = s as Record<string, unknown>;
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(src)) {
    if (!SCHEMA_KEYS.has(k)) continue;
    if (k === 'type' && Array.isArray(v)) {
      const types = v.filter((t) => t !== 'null');
      if (types.length !== v.length) out.nullable = true;
      if (types[0]) out.type = String(types[0]);
    } else if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([p, ps]) => [p, geminiSchema(ps)]));
    } else if (k === 'items') out.items = geminiSchema(v);
    else if (k === 'anyOf' && Array.isArray(v)) out.anyOf = v.map(geminiSchema);
    else out[k] = v as Json;
  }
  if (src.const !== undefined && out.enum === undefined) out.enum = [src.const as Json];
  return out;
}

const partOf = (p: LoadedPart): Part =>
  p.type === 'text' ? { text: p.text } : { inlineData: { mimeType: p.type === 'image' ? p.mime : 'application/pdf', data: p.data } };

async function contents(spec: CallSpec): Promise<Content[]> {
  const list: Content[] = [];
  const push = (role: Content['role'], parts: Part[]) => {
    if (!parts.length) return;
    const prev = list[list.length - 1];
    if (prev?.role === role) prev.parts.push(...parts);
    else list.push({ role, parts });
  };
  for (const it of spec.items) {
    if (it.role === 'summary') push('user', [{ text: SUMMARY_PREFIX + it.text }]);
    else if (it.role === 'user') {
      const parts = await loadParts(it.parts, spec.model);
      push('user', parts.map(partOf));
    } else if (it.role === 'assistant') {
      if (rawFits(it.raw, spec) && Array.isArray(it.raw!.data)) {
        push('model', it.raw!.data as Part[]);
        continue;
      }
      const parts: Part[] = [];
      if (it.text) parts.push({ text: it.text });
      for (const c of it.toolCalls) parts.push({ functionCall: { name: c.name, args: argsObject(c.args) as Json }, thoughtSignature: SKIP_SIGNATURE });
      push('model', parts.length ? parts : [{ text: '…' }]);
    } else {
      push(
        'user',
        it.results.map((r): Part => ({ functionResponse: { name: r.name, response: r.isError ? { error: r.content } : { result: r.content } } })),
      );
      // Images and PDFs a tool returned follow the function responses in the same turn.
      push('user', toolMediaParts(it.results, spec.model).map(partOf));
    }
  }
  if (list[0]?.role !== 'user') list.unshift({ role: 'user', parts: [{ text: '…' }] });
  return list;
}

export const gemini: WireFormat = {
  async build(spec) {
    const tools: Json[] = [];
    if (spec.tools.length) {
      tools.push({
        functionDeclarations: sortedTools(spec.tools).map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(t.parameters) })),
      });
    }
    if (spec.webSearch) tools.push({ googleSearch: {} });
    const body: Record<string, Json> = {
      contents: (await contents(spec)) as unknown as Json,
      generationConfig: { maxOutputTokens: spec.maxOutputTokens ?? spec.model.maxOutputTokens },
    };
    if (spec.system) body.systemInstruction = { parts: [{ text: spec.system }] };
    if (tools.length) body.tools = tools;
    // Google Search next to function declarations is refused (HTTP 400) unless server-side invocations are returned.
    if (spec.webSearch && spec.tools.length) body.toolConfig = { includeServerSideToolInvocations: true };
    return {
      url: `${modelPath(spec.provider, spec.model.id)}:streamGenerateContent?alt=sse`,
      headers: finishHeaders(auth(spec.key), spec),
      body: finishBody(body, spec),
    };
  },

  async parse(events, hooks) {
    const parts: Part[] = [];
    let text = '';
    let reasoning = '';
    let finish: string | null = null;
    let blocked: string | null = null;
    let usage: Usage | null = null;
    // Search queries come as grounding metadata, or (search combined with functions) as server-side toolCall parts.
    const queries = new Set<string>();
    const searched = (q: unknown) => {
      if (typeof q !== 'string' || queries.has(q)) return;
      queries.add(q);
      hooks.webSearch?.(q);
    };
    let any = false;
    for await (const ev of events) {
      const j = parseJson(ev.data) as Record<string, unknown> | undefined;
      if (!j) continue;
      any = true;
      if (j.error) {
        const e = j.error as { code?: number; message?: string; status?: string };
        throw new ChatHttpError(Number(e.code) || 0, `${e.status ?? ''} ${e.message ?? ''}`.trim(), { beforeOutput: !parts.length });
      }
      const fb = j.promptFeedback as { blockReason?: string } | undefined;
      if (fb?.blockReason) blocked = fb.blockReason;
      const u = j.usageMetadata as Record<string, unknown> | undefined;
      if (u) usage = geminiUsage(u);
      const cand = (j.candidates as Record<string, unknown>[] | undefined)?.[0];
      if (!cand) continue;
      for (const p of ((cand.content as { parts?: Part[] } | undefined)?.parts ?? [])) {
        const part = { ...p };
        const st = part.toolCall as { toolType?: unknown; args?: { queries?: unknown } } | undefined;
        if (st && /SEARCH/i.test(String(st.toolType ?? '')) && Array.isArray(st.args?.queries)) st.args.queries.forEach(searched);
        if (typeof part.text === 'string') {
          if (part.thought === true) {
            reasoning += part.text;
            if (part.text) hooks.reasoning(part.text);
          } else {
            text += part.text;
            if (part.text) hooks.text(part.text);
          }
          // Text chunks of one kind are joined; a part with a signature starts or ends a run and is kept as it is.
          const prev = parts[parts.length - 1];
          if (
            prev &&
            typeof prev.text === 'string' &&
            !prev.thoughtSignature &&
            !part.thoughtSignature &&
            (prev.thought === true) === (part.thought === true) &&
            Object.keys(part).every((k) => k === 'text' || k === 'thought')
          ) {
            prev.text = prev.text + part.text;
            continue;
          }
        }
        parts.push(part);
      }
      const gm = cand.groundingMetadata as { webSearchQueries?: unknown } | undefined;
      if (Array.isArray(gm?.webSearchQueries)) gm.webSearchQueries.forEach(searched);
      if (typeof cand.finishReason === 'string') finish = cand.finishReason;
    }
    const toolCalls: ToolCall[] = [];
    parts.forEach((p, i) => {
      const fc = p.functionCall as { name?: string; args?: unknown; id?: string } | undefined;
      if (fc?.name) toolCalls.push({ id: fc.id || `fc_${i}_${fc.name}`, name: fc.name, args: JSON.stringify(fc.args ?? {}) });
    });
    const stop: StopKind = blocked
      ? 'refusal'
      : toolCalls.length
        ? 'tool_calls'
        : finish === 'MAX_TOKENS'
          ? 'max_tokens'
          : finish === 'STOP' || (finish === null && any && parts.length)
            ? 'end'
            : finish && /SAFETY|RECITATION|BLOCKLIST|PROHIBITED|SPII|IMAGE_SAFETY/.test(finish)
              ? 'refusal'
              : 'other';
    return {
      text,
      reasoning,
      toolCalls,
      raw: parts,
      stop,
      stopDetail: stop === 'refusal' || stop === 'other' ? (blocked ?? finish ?? 'the stream ended without an answer') : null,
      usage,
      webSearches: queries.size,
    };
  },

  check(provider: ChatProvider, key: string | null, model: string | null) {
    if (isVertexUrl(provider.baseUrl)) {
      // Vertex AI with an API key has no model list; counting tokens is free and proves key, project and model.
      return {
        method: 'POST',
        url: `${modelPath(provider, model ?? 'gemini-3-flash-preview')}:countTokens`,
        headers: { 'content-type': 'application/json', accept: 'application/json', ...auth(key) },
        body: { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] },
      };
    }
    return { method: 'GET', url: `${provider.baseUrl.replace(/\/+$/, '')}/models?pageSize=1000`, headers: { accept: 'application/json', ...auth(key) } };
  },

  models(json) {
    const list = (json as { models?: unknown })?.models;
    if (!Array.isArray(list)) return null;
    return list
      .filter((m) => {
        const methods = (m as { supportedGenerationMethods?: unknown }).supportedGenerationMethods;
        return !Array.isArray(methods) || methods.includes('generateContent');
      })
      .map((m) => String((m as { name?: unknown }).name ?? '').replace(/^models\//, ''))
      .filter(Boolean);
  },
};

function geminiUsage(u: Record<string, unknown>): Usage {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const prompt = n(u.promptTokenCount) + n(u.toolUsePromptTokenCount);
  const cached = Math.min(prompt, n(u.cachedContentTokenCount));
  const thoughts = n(u.thoughtsTokenCount);
  return { input: prompt - cached, cacheRead: cached, cacheWrite: 0, output: n(u.candidatesTokenCount) + thoughts, reasoning: thoughts };
}
