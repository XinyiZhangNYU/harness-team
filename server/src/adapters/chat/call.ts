import { L } from '../../../../shared/notices.ts';
import type { ChatConnectionCheck, ChatModel, ChatModelTest, ChatProvider } from '../../../../shared/protocol.ts';
import { WIRE_FORMATS } from './formats/index.ts';
import { isVertexUrl } from './catalog.ts';
import {
  type AssistantAnswer,
  type CallSpec,
  ChatHttpError,
  type CheckRequest,
  errorText,
  parseJson,
  readSse,
  retryAfterMs,
  type SseEvent,
  type StreamHooks,
  type WireFormat,
} from './wire.ts';

/**
 * One streamed model call over HTTP: retries before any output, an idle timeout on the stream, and the caller's abort.
 * Also the two settings checks: the free connection check and the (paid, confirmed) one-message model test.
 */

/** No response or no stream data in time, or the connection failed: safe to send again when nothing was streamed. */
export class ChatNetworkError extends ChatHttpError {
  constructor(message: string, beforeOutput: boolean) {
    super(0, message, { beforeOutput });
    this.name = 'ChatNetworkError';
  }
}

export interface CallOptions {
  signal?: AbortSignal;
  /** Stream idle limit (no bytes for this long ends the call). */
  idleMs?: number;
  /** Extra attempts on 408/429/5xx/network errors before any output (default 2). */
  retries?: number;
  /** A retry is about to wait `waitMs`. */
  onRetry?(attempt: number, waitMs: number, err: ChatHttpError): void;
}

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
const MAX_RETRY_WAIT_MS = 30_000;
export const DEFAULT_IDLE_MS = 300_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function callModel(format: WireFormat, spec: CallSpec, hooks: StreamHooks, opts: CallOptions = {}): Promise<AssistantAnswer> {
  const req = await format.build(spec);
  const retries = opts.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    const state = { emitted: false };
    const h: StreamHooks = {
      text: (d) => {
        state.emitted = true;
        hooks.text(d);
      },
      reasoning: (d) => {
        state.emitted = true;
        hooks.reasoning(d);
      },
      webSearch: (q) => {
        state.emitted = true;
        hooks.webSearch?.(q);
      },
    };
    try {
      return await once(format, req, h, state, opts);
    } catch (e) {
      if (opts.signal?.aborted || !(e instanceof ChatHttpError)) throw e;
      const retryable = (e instanceof ChatNetworkError || RETRY_STATUS.has(e.status)) && e.beforeOutput && !state.emitted;
      if (!retryable || attempt >= retries) throw e;
      if (e.retryAfterMs !== null && e.retryAfterMs > MAX_RETRY_WAIT_MS) throw e;
      const wait = e.retryAfterMs ?? Math.min(MAX_RETRY_WAIT_MS, 1000 * 2 ** attempt);
      opts.onRetry?.(attempt + 1, wait, e);
      await sleep(wait, opts.signal);
    }
  }
}

const IDLE = Symbol('idle');

async function once(
  format: WireFormat,
  req: { url: string; headers: Record<string, string>; body: unknown },
  hooks: StreamHooks,
  state: { emitted: boolean },
  opts: CallOptions,
): Promise<AssistantAnswer> {
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(opts.signal!.reason);
  if (opts.signal?.aborted) throw opts.signal.reason;
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(IDLE), idleMs);
  };
  const idleError = () => new ChatNetworkError(`no data from the API for ${Math.round(idleMs / 1000)}s`, !state.emitted);
  touch();
  try {
    let res: Response;
    try {
      res = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: ctrl.signal });
    } catch (e) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      if (ctrl.signal.reason === IDLE) throw idleError();
      throw new ChatNetworkError(`connection failed: ${networkText(e)}`, true);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ChatHttpError(res.status, errorText(text) || res.statusText || `HTTP ${res.status}`, {
        retryAfterMs: retryAfterMs(res.headers.get('retry-after')),
      });
    }
    const ct = res.headers.get('content-type') ?? '';
    let events: AsyncIterable<SseEvent>;
    if (res.body && /event-stream/i.test(ct)) events = touching(readSse(res.body), touch);
    else {
      // Some servers answer a stream request with one JSON body (often an error).
      const text = await res.text();
      const j = parseJson(text) as { error?: unknown } | undefined;
      if (j?.error) throw new ChatHttpError(res.status, errorText(text));
      events = (async function* () {
        if (text.trim()) yield { event: null, data: text };
      })();
    }
    try {
      return await format.parse(events, hooks);
    } catch (e) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      if (ctrl.signal.reason === IDLE) throw idleError();
      if (e instanceof ChatHttpError) throw e;
      throw new ChatNetworkError(`the stream broke: ${networkText(e)}`, !state.emitted);
    }
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

async function* touching(events: AsyncIterable<SseEvent>, touch: () => void): AsyncGenerator<SseEvent> {
  for await (const ev of events) {
    touch();
    yield ev;
  }
}

function networkText(e: unknown): string {
  const err = e as { message?: string; cause?: { code?: string; message?: string } };
  return [err?.cause?.code, err?.cause?.message ?? err?.message].filter(Boolean).join(' ').slice(0, 300) || 'unknown error';
}

/** Without a project, Vertex AI picks a regional location; newer models are served only in `global`. */
export const needsVertexProject = (e: unknown, provider?: ChatProvider): e is ChatHttpError =>
  e instanceof ChatHttpError && e.status === 404 && !!provider && provider.format === 'gemini' && isVertexUrl(provider.baseUrl) && !provider.vertexProject;

export const VERTEX_PROJECT_HINT = L(
  '未填项目 ID 时请求落在某个地区，部分新模型只在 global 区域提供，填上项目 ID 即可',
  'without a project ID the request lands in a region; some newer models are served only in global, so fill in the project ID',
);

const httpNotice = (e: unknown, provider?: ChatProvider) => {
  if (needsVertexProject(e, provider)) return L('HTTP 404：{m}（{hint}）', 'HTTP 404: {m} ({hint})', { m: e.message, hint: VERTEX_PROJECT_HINT });
  if (e instanceof ChatHttpError) {
    return e.status
      ? L('HTTP {s}：{m}', 'HTTP {s}: {m}', { s: e.status, m: e.message })
      : L('请求失败：{m}', 'Request failed: {m}', { m: e.message });
  }
  return L('请求失败：{m}', 'Request failed: {m}', { m: networkText(e) });
};

const NO_KEY = L('没有可用的 Key（未设置，或环境变量为空）', 'No key available (not set, or the environment variable is empty)');

/**
 * The free check: the model list (or, on Vertex AI, counting tokens of one word). Proves Base URL and key; lists the
 * models the provider offers when it has a list. A 404 falls back to counting tokens where the format can.
 */
export async function checkConnection(provider: ChatProvider, key: string | null): Promise<ChatConnectionCheck> {
  if (!key) return { ok: false, models: [], listed: false, error: NO_KEY };
  const format = WIRE_FORMATS[provider.format];
  const model = provider.models.find((m) => m.enabled)?.id ?? provider.models[0]?.id ?? null;
  try {
    let json: unknown;
    let listed = true;
    try {
      json = await sendCheck(format.check(provider, key, model));
    } catch (e) {
      if (!(e instanceof ChatHttpError && e.status === 404 && format.checkWithoutList && model)) throw e;
      json = await sendCheck(format.checkWithoutList(provider, key, model));
      listed = false;
    }
    const models = listed ? format.models(json) : null;
    return { ok: true, models: models ?? [], listed: models !== null, error: null };
  } catch (e) {
    return { ok: false, models: [], listed: false, error: httpNotice(e, provider) };
  }
}

async function sendCheck(c: CheckRequest): Promise<unknown> {
  const res = await fetch(c.url, {
    method: c.method,
    headers: { 'user-agent': 'HarnessTeam', ...c.headers },
    body: c.body === undefined ? undefined : JSON.stringify(c.body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new ChatHttpError(res.status, errorText(text) || res.statusText);
  return parseJson(text);
}

/** One short message to the model (billed by the provider; the API asks for confirmation first). */
export async function testModel(provider: ChatProvider, model: ChatModel, key: string | null, signal?: AbortSignal): Promise<ChatModelTest> {
  if (!key) return { ok: false, text: '', usage: null, error: NO_KEY };
  const spec: CallSpec = {
    provider,
    model,
    key,
    // The lowest reasoning tag keeps the test cheap.
    level: model.reasoningLevels[0] ?? null,
    session: 'connection-test',
    system: '',
    items: [{ role: 'user', parts: [{ type: 'text', text: 'Reply with the single word OK.' }] }],
    tools: [],
    webSearch: false,
    maxOutputTokens: Math.min(model.maxOutputTokens, 1024),
  };
  let text = '';
  try {
    const a = await callModel(WIRE_FORMATS[provider.format], spec, { text: (d) => (text += d), reasoning: () => {} }, { signal, retries: 0, idleMs: 60_000 });
    const ok = a.stop === 'end' || a.stop === 'max_tokens';
    return {
      ok,
      text: (a.text || text).slice(0, 200),
      usage: a.usage,
      error: ok ? null : L('模型没有正常结束：{m}', 'The model did not finish normally: {m}', { m: a.stopDetail ?? a.stop }),
    };
  } catch (e) {
    return { ok: false, text: text.slice(0, 200), usage: null, error: httpNotice(e, provider) };
  }
}
