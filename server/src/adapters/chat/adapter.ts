import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { L, localized, type Localized, type NoticeText } from '../../../../shared/notices.ts';
import {
  type Agent,
  type AgentLanguage,
  type ChatModel,
  type ChatProvider,
  DEFAULT_CHAT_MEMBER,
  type RuntimeDescriptor,
} from '../../../../shared/protocol.ts';
import { estimateCostUsd, localDate } from '../../pricing.ts';
import type { TeamIdentity } from '../../core.ts';
import type { ToolInfo } from '../../team/mcp.ts';
import {
  type AgentSession,
  type OpenSessionArgs,
  ResumeFailedError,
  type RuntimeAdapter,
  type TurnEventSink,
  type TurnInput,
  type TurnResult,
  type TurnUsage,
} from '../types.ts';
import { callModel, ChatNetworkError, needsVertexProject, VERTEX_PROJECT_HINT } from './call.ts';
import { WIRE_FORMATS } from './formats/index.ts';
import { PROJECT_TOOL_NAMES, ProjectToolError, projectToolDefs, runProjectTool } from './project-tools.ts';
import type { ChatProviders } from './providers.ts';
import { type StoredItem, Transcripts } from './transcript.ts';
import {
  argsObject,
  type AssistantAnswer,
  type CallSpec,
  ChatHttpError,
  type ChatItem,
  sortedTools,
  type ToolCall,
  type ToolDef,
  type ToolResult,
  type Usage,
  type UserPart,
} from './wire.ts';

/**
 * Chat members: Harness Team calls a model API with the user's own key. Not a Harness and not a coding agent: it has
 * Team tools, optional read-only project tools and the model's own web search, never file writes or commands. The
 * conversation is Harness Team's own (chat_sessions / chat_items), so the native session id is that conversation's id.
 */

/** What the adapter needs from the Core (bound after the Core exists). */
export interface ChatHost {
  agent(id: string): Agent | undefined;
  projectDir(roomId: string): string | null;
  /** Tokens (all kinds) the member used today (local day), from the usage records. */
  tokensToday(agentId: string): number;
  teamTools(id: TeamIdentity): ToolInfo[];
  runTeamTool(id: TeamIdentity, name: string, args: unknown): { text: string; isError: boolean };
}

export interface ChatAdapterOptions {
  db: DatabaseSync;
  providers: ChatProviders;
  /** The app's data folder (never readable through the project tools). */
  dataDir: string;
  host: () => ChatHost | null;
  /** Stream idle limit (tests use a short one). */
  idleMs?: number;
}

const MAX_TOOLS = 20;
const TOOL_RESULT_MAX = 100_000;
const SLIM_KEEP_TURNS = 3;
const SLIM_MIN_CHARS = 400;
const SUMMARY_MAX_OUTPUT = 8192;

const COMMANDS = [
  { name: 'compact', description: L('压缩上下文：把较早的对话总结成摘要（一次计费请求）', 'Compact the context: summarize the earlier conversation (one billed request)'), action: 'native' as const },
  { name: 'clear', description: L('清空上下文：之后的请求只带系统提示', 'Clear the context: later requests carry only the system prompt'), action: 'native' as const },
];

export class ChatAdapter implements RuntimeAdapter {
  readonly kind = 'chat' as const;
  private readonly opts: ChatAdapterOptions;
  private readonly transcripts: Transcripts;

  constructor(opts: ChatAdapterOptions) {
    this.opts = opts;
    this.transcripts = new Transcripts(opts.db);
  }

  describe(): RuntimeDescriptor {
    return {
      kind: 'chat',
      backend: 'chat-api',
      label: 'Chat API',
      isMock: false,
      available: true,
      installed: true,
      note: null,
      requiresWorkspace: false,
      // Every chat member calls a paid API with the user's own key.
      billing: 'metered_api',
      capabilities: {
        streaming: true,
        nativeTools: true,
        nativeApprovals: false,
        interrupt: true,
        resume: true,
        steer: false,
        teamMcp: true,
        standingInstructions: true,
        commands: COMMANDS,
      },
    };
  }

  async openSession(args: OpenSessionArgs): Promise<AgentSession> {
    let id = args.resumeNativeSessionId;
    if (id) {
      if (!this.transcripts.find(id, args.agent.id, args.roomId)) throw new ResumeFailedError(`chat session ${id} not found`, 'missing');
    } else id = this.transcripts.create(args.agent.id, args.roomId);
    return new ChatSession(this.opts, this.transcripts, id, args);
  }
}

class ChatSession implements AgentSession {
  readonly nativeSessionId: string;
  private readonly opts: ChatAdapterOptions;
  private readonly transcripts: Transcripts;
  private readonly args: OpenSessionArgs;

  constructor(opts: ChatAdapterOptions, transcripts: Transcripts, id: string, args: OpenSessionArgs) {
    this.opts = opts;
    this.transcripts = transcripts;
    this.nativeSessionId = id;
    this.args = args;
  }

  async close(): Promise<void> {}

  private lang(): AgentLanguage {
    return this.args.language?.() ?? 'zh';
  }

  async runTurn(input: TurnInput, sink: TurnEventSink, signal: AbortSignal): Promise<TurnResult> {
    const host = this.opts.host();
    const agent = host?.agent(this.args.agent.id) ?? this.args.agent;
    const settings = { ...DEFAULT_CHAT_MEMBER, ...(agent.chat ?? {}) };
    const modelId = input.config ? input.config.model : agent.model;
    const resolved = this.opts.providers.resolve(agent.providerId, modelId);
    if ('error' in resolved) return { status: 'failed', error: resolved.error };
    const { provider, model } = resolved;
    const level = input.config ? input.config.effort : agent.effort;
    if (level !== null && !model.reasoningLevels.includes(level)) {
      return {
        status: 'failed',
        error: L('推理等级「{l}」不在模型「{m}」的标签里，请在成员设置里重新选择', 'The reasoning level “{l}” is not one of the model “{m}” tags; choose it again in the member settings', {
          l: level,
          m: model.id,
        }),
      };
    }
    const key = await this.opts.providers.key(provider.id);
    if (!key) {
      return { status: 'failed', error: L('供应商「{p}」没有可用的 Key（未设置，或环境变量为空）', 'The provider “{p}” has no key available (not set, or the environment variable is empty)', { p: provider.label }) };
    }
    const turn = new Turn(this, { input, sink, signal, agent, settings, provider, model, level, key });
    sink({ type: 'turn.started', nativeTurnId: `turn-${randomUUID()}` });
    sink({ type: 'config.effective', effective: { model: model.id, effort: level, source: L('聊天 API 请求', 'Chat API request') } });
    return turn.run();
  }

  // ---- used by Turn ----
  get id() {
    return this.nativeSessionId;
  }
  get store() {
    return this.transcripts;
  }
  get options() {
    return this.opts;
  }
  get open() {
    return this.args;
  }
  language() {
    return this.lang();
  }
}

interface TurnContext {
  input: TurnInput;
  sink: TurnEventSink;
  signal: AbortSignal;
  agent: Agent;
  settings: typeof DEFAULT_CHAT_MEMBER;
  provider: ChatProvider;
  model: ChatModel;
  level: string | null;
  key: string;
}

/** One turn: append the message, call the model, run its tools, repeat; then report usage. */
class Turn {
  private readonly s: ChatSession;
  private readonly c: TurnContext;
  private readonly tally = new UsageTally();
  /** First item seq of this turn (raw content before it is replayed only when the model keeps reasoning across turns). */
  private turnStart = 0;
  private readonly team: TeamIdentity;

  constructor(s: ChatSession, c: TurnContext) {
    this.s = s;
    this.c = c;
    this.team = { agentId: c.agent.id, roomId: s.open.roomId };
  }

  private notice(n: NoticeText) {
    this.c.sink({ type: 'notice', text: localized(n, 'zh'), notice: n });
  }

  private result(status: TurnResult['status'], error?: Localized): TurnResult {
    const usage = this.tally.list(this.c.model);
    return { status, ...(error ? { error } : {}), ...(usage.length ? { usage } : {}) };
  }

  private overLimit(): Localized | null {
    const limit = this.c.settings.dailyTokenLimit;
    if (!limit) return null;
    const used = (this.s.options.host()?.tokensToday(this.c.agent.id) ?? 0) + this.tally.total();
    if (used < limit) return null;
    return L('已达到这个成员每天 {n} token 的上限（可在成员设置里修改）', 'This member reached its daily limit of {n} tokens (change it in the member settings)', { n: limit });
  }

  async run(): Promise<TurnResult> {
    const { input, signal } = this.c;
    try {
      if (input.command) return await this.command(input.command.name);
      const limited = this.overLimit();
      if (limited) return this.result('failed', limited);
      const parts: UserPart[] = [{ type: 'text', text: input.text }];
      for (const a of input.attachments ?? []) parts.push({ type: 'attachment', kind: a.kind, name: a.name, mime: a.mime, path: a.path });
      this.turnStart = this.s.store.append(this.s.id, { role: 'user', parts });
      return await this.loop();
    } catch (e) {
      if (signal.aborted) return this.result('interrupted');
      return this.result('failed', errorNotice(e, this.c.provider));
    }
  }

  private async command(name: string): Promise<TurnResult> {
    if (name === 'clear') {
      this.s.store.setFromSeq(this.s.id, this.s.store.nextSeq(this.s.id));
      this.s.store.patchState(this.s.id, { lastInput: 0, lastSeq: 0, slimBefore: 0 });
      this.notice(L('已清空上下文：之后的请求只带系统提示', 'Context cleared: later requests carry only the system prompt'));
      return this.result('completed');
    }
    if (name === 'compact') {
      const done = await this.compact('manual', true);
      if (!done) this.notice(L('没有可以压缩的内容', 'Nothing to compact'));
      return this.result('completed');
    }
    return this.result('failed', L('聊天成员没有 /{n} 命令', 'Chat members have no /{n} command', { n: name }));
  }

  private tools(): ToolDef[] {
    const { model, settings } = this.c;
    if (!model.tools) return [];
    const host = this.s.options.host();
    const defs: ToolDef[] = (host?.teamTools(this.team) ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Record<string, unknown>,
    }));
    if (settings.projectTools && host?.projectDir(this.s.open.roomId)) defs.push(...projectToolDefs());
    return defs.slice(0, MAX_TOOLS);
  }

  private system(tools: ToolDef[]): string {
    const { agent, provider, model } = this.c;
    const zh = this.s.language() === 'zh';
    const project = tools.some((t) => t.name === 'read_file');
    const self = zh
      ? `你是群聊成员 ${agent.displayName}（@${agent.handle}），是一个聊天成员：Harness Team 直接调用 ${provider.label} 的模型 ${model.id}。` +
        '你不能写文件、执行命令或操作 Git；需要改代码或运行命令时，在回复里 @ 群里的编程成员（例如 Claude Code、Codex 成员）请他们做。' +
        (project ? '你可以用 list_dir、read_file、search 只读查看本群的项目目录。' : '')
      : `You are the chat member ${agent.displayName} (@${agent.handle}): Harness Team calls the model ${model.id} of ${provider.label} directly. ` +
        'You cannot write files, run commands or use Git; when code must change or a command must run, @mention a coding member of the chat ' +
        '(for example a Claude Code or Codex member) in your reply and ask them.' +
        (project ? ' You can look at the chat’s project folder read-only with list_dir, read_file and search.' : '');
    return [self, this.s.open.instructions ?? ''].filter(Boolean).join('\n\n');
  }

  private webSearch(): boolean {
    const { model, settings, provider } = this.c;
    return settings.webSearch && model.webSearch && provider.format !== 'openai_chat';
  }

  /** Items to send: from from_seq, tool calls paired with results, raw cleared where it must not be replayed. */
  private items(): ChatItem[] {
    const state = this.s.store.state(this.s.id);
    const stored = this.s.store.items(this.s.id);
    const replayAll = this.c.model.replayReasoning;
    const out = stored.map(({ seq, item }): ChatItem => {
      if (item.role === 'assistant' && item.raw && !replayAll && seq < this.turnStart) return { ...item, raw: null };
      if (item.role === 'tool' && state.slimBefore && seq < state.slimBefore) {
        return { ...item, results: item.results.map(slimResult) };
      }
      return item;
    });
    return normalize(out);
  }

  private spec(tools: ToolDef[]): CallSpec {
    const { provider, model, key, level, agent } = this.c;
    const system = this.system(tools);
    const webSearch = this.webSearch();
    const state = this.s.store.state(this.s.id);
    const builtIn = WIRE_FORMATS[provider.format].builtInTools?.(provider, model, webSearch) ?? webSearch;
    const binding = fnv(JSON.stringify([system, sortedTools(tools), builtIn, this.s.store.fromSeq(this.s.id), state.slimBefore ?? 0]));
    return {
      provider,
      model,
      key,
      level,
      session: sessionHash(agent.id, this.s.open.roomId),
      system,
      items: this.items(),
      tools,
      webSearch,
      binding,
    };
  }

  private async loop(): Promise<TurnResult> {
    const { sink, signal, model, provider, settings } = this.c;
    const format = WIRE_FORMATS[provider.format];
    let toolRounds = 0;
    let call = 0;
    let retriedOverflow = false;
    for (;;) {
      const limited = this.overLimit();
      if (limited) return this.result('failed', limited);
      const tools = this.tools();
      await this.compactIfNeeded(tools);
      const spec = this.spec(tools);
      const round = call++;
      const view = new RoundView(sink, round, this.s.language());
      let answer: AssistantAnswer;
      try {
        answer = await callModel(format, spec, view.hooks, {
          signal,
          idleMs: this.s.options.idleMs,
          onRetry: (n, wait, e) =>
            this.notice(L('API 暂时不可用（{m}），{s} 秒后第 {n} 次重试', 'The API is unavailable for now ({m}); retry {n} in {s}s', { m: e.status ? `HTTP ${e.status}` : e.message, s: Math.ceil(wait / 1000), n })),
        });
      } catch (e) {
        view.finish();
        if (view.text) this.s.store.append(this.s.id, { role: 'assistant', text: `${view.text}\n[interrupted]`, reasoning: '', toolCalls: [], raw: null });
        if (signal.aborted) {
          if (view.started) this.tally.unknown(model.id);
          return this.result('interrupted');
        }
        if (e instanceof ChatHttpError && e.contextTooLong && !retriedOverflow && !view.started) {
          retriedOverflow = true;
          this.notice(L('请求超出了模型的上下文窗口，压缩后重试一次', 'The request exceeded the model’s context window; compacting and retrying once'));
          if (await this.compact('overflow', true)) continue;
        }
        if (e instanceof ChatNetworkError ? view.started : e instanceof ChatHttpError && !e.beforeOutput) this.tally.unknown(model.id);
        return this.result('failed', errorNotice(e, provider));
      }
      view.finish();
      if (answer.usage) this.tally.add(model, answer.usage);
      else this.tally.unknown(model.id);
      const seq = this.s.store.append(this.s.id, {
        role: 'assistant',
        text: answer.text,
        reasoning: answer.reasoning,
        toolCalls: answer.toolCalls,
        raw: { format: provider.format, providerId: provider.id, model: model.id, data: answer.raw, binding: spec.binding },
      });
      if (answer.usage) {
        const u = answer.usage;
        this.s.store.patchState(this.s.id, { lastInput: u.input + u.cacheRead + u.cacheWrite, lastSeq: seq - 1 });
      }
      if (answer.text) sink({ type: 'text.done', itemId: view.itemId, text: answer.text });

      if (answer.stop === 'pause') continue;
      if (answer.stop === 'tool_calls' && answer.toolCalls.length) {
        const results = await this.runTools(answer.toolCalls, toolRounds + 1 > settings.maxToolRounds);
        this.s.store.append(this.s.id, { role: 'tool', results });
        if (signal.aborted) return this.result('interrupted');
        toolRounds++;
        if (toolRounds > settings.maxToolRounds) {
          this.notice(L('工具调用已达每回合 {n} 轮的上限，回合结束', 'Tool calls reached the limit of {n} rounds per turn; the turn ended', { n: settings.maxToolRounds }));
          return this.result('completed');
        }
        continue;
      }
      if (answer.stop === 'max_tokens') {
        this.notice(L('回复达到了输出上限（{n} token），被截断', 'The reply reached the output limit ({n} tokens) and was cut off', { n: model.maxOutputTokens }));
      } else if (answer.stop === 'refusal') {
        this.notice(L('模型拒绝回答：{m}', 'The model declined to answer: {m}', { m: answer.stopDetail ?? 'refusal' }));
      } else if (answer.stop === 'other' || (answer.stop === 'tool_calls' && !answer.toolCalls.length)) {
        if (!answer.text) return this.result('failed', L('模型没有正常结束：{m}', 'The model did not finish normally: {m}', { m: answer.stopDetail ?? answer.stop }));
        this.notice(L('模型没有正常结束：{m}', 'The model did not finish normally: {m}', { m: answer.stopDetail ?? answer.stop }));
      }
      return this.result('completed');
    }
  }

  private async runTools(calls: ToolCall[], overLimit: boolean): Promise<ToolResult[]> {
    const { sink, signal } = this.c;
    const host = this.s.options.host();
    const projectDir = host?.projectDir(this.s.open.roomId) ?? null;
    const project = this.c.settings.projectTools && projectDir && this.c.model.tools;
    const results: ToolResult[] = [];
    for (const [i, call] of calls.entries()) {
      if (signal.aborted || overLimit) {
        results.push({ callId: call.id, name: call.name, content: overLimit ? 'not run: the tool round limit of this turn was reached' : 'cancelled: the user stopped the turn', isError: true });
        continue;
      }
      const itemId = `tool-${call.id || i}`;
      const isProject = (PROJECT_TOOL_NAMES as readonly string[]).includes(call.name);
      const title = toolTitle(call);
      sink({ type: 'activity', itemId, activity: isProject ? 'other' : 'mcpToolCall', title, detail: preview(call.args), done: false });
      let content: string;
      let isError = false;
      const args = parseArgs(call.args);
      if (args === null) {
        content = 'invalid arguments: not a JSON object';
        isError = true;
      } else if (isProject) {
        if (!project) {
          content = 'project tools are turned off for this member';
          isError = true;
        } else {
          try {
            content = await runProjectTool(projectDir!, this.s.options.dataDir, call.name, args, signal);
          } catch (e) {
            content = e instanceof ProjectToolError ? e.message : `failed: ${(e as Error).message ?? e}`;
            isError = true;
          }
        }
      } else if (host) {
        const r = host.runTeamTool(this.team, call.name, args);
        content = r.text;
        isError = r.isError;
      } else {
        content = 'Team tools are not available right now';
        isError = true;
      }
      if (content.length > TOOL_RESULT_MAX) content = `${content.slice(0, TOOL_RESULT_MAX)}\n… [truncated: ${content.length} characters in total]`;
      sink({ type: 'activity', itemId, activity: isProject ? 'other' : 'mcpToolCall', title, detail: isError ? content.slice(0, 500) : preview(call.args), done: true, failed: isError });
      results.push({ callId: call.id, name: call.name, content, ...(isError ? { isError: true } : {}) });
    }
    return results;
  }

  // ---- context management ----

  private limit(): number {
    const { contextTokens, maxOutputTokens, compactAt } = this.c.model;
    return Math.max(1024, Math.min(compactAt * contextTokens, contextTokens - Math.min(maxOutputTokens, contextTokens / 4)));
  }

  /**
   * Estimated input tokens of the next request: the last request's count plus what was appended since. Without a count
   * (a new session, or right after compacting) the system prompt and the tool definitions are estimated too.
   */
  private estimate(stored: StoredItem[], tools: ToolDef[]): number {
    const st = this.s.store.state(this.s.id);
    const base = st.lastInput && st.lastSeq ? st.lastInput : estimateText(this.system(tools)) + estimateText(JSON.stringify(tools));
    const since = st.lastInput && st.lastSeq ? stored.filter((x) => x.seq > st.lastSeq!) : stored;
    return base + since.reduce((n, x) => n + estimateItem(x.item, !!(st.slimBefore && x.seq < st.slimBefore)), 0);
  }

  private async compactIfNeeded(tools: ToolDef[]): Promise<void> {
    const stored = this.s.store.items(this.s.id);
    const limit = this.limit();
    const est = this.estimate(stored, tools);
    if (est <= limit) return;
    // First the free step: older tool results become one line each.
    const st = this.s.store.state(this.s.id);
    const starts = stored.filter((x) => x.item.role === 'user').map((x) => x.seq);
    const slimTo = starts.length > SLIM_KEEP_TURNS ? starts[starts.length - SLIM_KEEP_TURNS]! : 0;
    if (slimTo > (st.slimBefore ?? 0)) {
      const saved = stored
        .filter((x) => x.item.role === 'tool' && x.seq < slimTo && x.seq >= (st.slimBefore ?? 0))
        .reduce((n, x) => n + estimateItem(x.item, false) - estimateItem(x.item, true), 0);
      this.s.store.patchState(this.s.id, { slimBefore: slimTo, lastInput: 0, lastSeq: 0 });
      if (est - saved <= limit) {
        this.notice(L('上下文接近上限：较早的工具结果已换成一行占位', 'The context is near its limit: older tool results were replaced by one-line placeholders'));
        return;
      }
    }
    await this.compact('auto', false);
  }

  /**
   * Summarizes the conversation before the last turns with the same model (a billed request, counted in the usage),
   * then continues from the summary. When that fails, drops the oldest items instead (with a notice).
   */
  private async compact(why: 'auto' | 'manual' | 'overflow', force: boolean): Promise<boolean> {
    const stored = this.s.store.items(this.s.id);
    const starts = stored.map((x, i) => (x.item.role === 'user' ? i : -1)).filter((i) => i >= 0);
    if (!starts.length) return false;
    // Keep the last two turns when they are small enough, else only the last one.
    let keepFrom = starts[starts.length - 1]!;
    if (starts.length >= 2 && why !== 'overflow') {
      const two = starts[starts.length - 2]!;
      const size = stored.slice(two).reduce((n, x) => n + estimateItem(x.item, false), 0);
      if (size < this.c.model.contextTokens * 0.3) keepFrom = two;
    }
    if (why === 'manual') keepFrom = stored.length;
    const old = stored.slice(0, keepFrom);
    const kept = stored.slice(keepFrom);
    if (!old.length || (!force && old.every((x) => x.item.role === 'summary'))) return false;
    this.notice(L('正在压缩上下文（一次计费请求）…', 'Compacting the context (one billed request)…'));
    const { provider, model, key, signal } = this.c;
    const budgetChars = Math.max(8000, Math.floor(this.limit() * 0.6) * 3);
    let text = renderTranscript(old.map((x) => x.item));
    if (text.length > budgetChars) text = `[…the oldest part is left out]\n${text.slice(text.length - budgetChars)}`;
    const zh = this.s.language() === 'zh';
    const spec: CallSpec = {
      provider,
      model,
      key,
      level: model.reasoningLevels[0] ?? null,
      session: sessionHash(this.c.agent.id, this.s.open.roomId),
      system: zh
        ? '你负责为一段群聊成员的对话写摘要，供它之后继续对话。只输出摘要正文。'
        : 'You write the summary of a chat member’s conversation so it can continue from it. Output only the summary.',
      items: [
        {
          role: 'user',
          parts: [
            {
              type: 'text',
              text:
                `${text}\n\n---\n` +
                (zh
                  ? '请总结上面的对话：保留所有决定、未完成的事、提到的文件和路径、代码要点、成员之间的分工，以及用户的要求和偏好。用对话所用的语言写，尽量简洁但不要漏掉之后还需要的信息。'
                  : 'Summarize the conversation above: keep every decision, open item, file and path mentioned, code details, who does what, and the user’s requests and preferences. Write in the conversation’s language, concise but without losing what is still needed.'),
            },
          ],
        },
      ],
      tools: [],
      webSearch: false,
      maxOutputTokens: Math.min(model.maxOutputTokens, SUMMARY_MAX_OUTPUT),
    };
    try {
      const a = await callModel(WIRE_FORMATS[provider.format], spec, { text: () => {}, reasoning: () => {} }, { signal, idleMs: this.s.options.idleMs });
      if (a.usage) this.tally.add(model, a.usage);
      else this.tally.unknown(model.id);
      if (!a.text.trim() || (a.stop !== 'end' && a.stop !== 'max_tokens')) throw new Error(a.stopDetail ?? a.stop);
      const sumSeq = this.s.store.append(this.s.id, { role: 'summary', text: a.text.trim() });
      for (const x of kept) {
        const seq = this.s.store.append(this.s.id, x.item);
        if (x.seq === this.turnStart) this.turnStart = seq;
      }
      this.s.store.setFromSeq(this.s.id, sumSeq);
      this.s.store.patchState(this.s.id, { lastInput: 0, lastSeq: 0, slimBefore: 0 });
      this.notice(L('上下文已压缩：较早的 {n} 条记录换成了摘要', 'Context compacted: {n} earlier items were replaced by a summary', { n: old.length }));
      return true;
    } catch (e) {
      if (signal.aborted) throw e;
      if (why === 'manual') {
        this.notice(L('压缩失败：{m}', 'Compacting failed: {m}', { m: errorText(e) }));
        return false;
      }
      // Fallback: drop the oldest items (never silently).
      if (!kept.length) return false;
      this.s.store.setFromSeq(this.s.id, kept[0]!.seq);
      this.s.store.patchState(this.s.id, { lastInput: 0, lastSeq: 0, slimBefore: 0 });
      this.notice(
        L('压缩失败（{m}），已从最早处删去 {n} 条记录', 'Compacting failed ({m}); the {n} oldest items were dropped', { m: errorText(e), n: old.length }),
      );
      return true;
    }
  }
}

/** Streams one model call into the chat: text as one message per call, reasoning as a folded activity. */
class RoundView {
  readonly itemId: string;
  text = '';
  started = false;
  private reasoning = '';
  private readonly sink: TurnEventSink;
  private readonly thinkId: string;
  private readonly title: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private searches = 0;
  private readonly round: number;
  readonly hooks;

  constructor(sink: TurnEventSink, round: number, lang: AgentLanguage) {
    this.sink = sink;
    this.round = round;
    this.itemId = `r${round}`;
    this.thinkId = `think-r${round}`;
    this.title = lang === 'zh' ? '思考' : 'Thinking';
    this.hooks = {
      text: (d: string) => {
        // Thinking still waiting for its first flush goes out first, so it sits above the answer.
        if (this.timer) this.emitThinking(false);
        this.started = true;
        this.text += d;
        sink({ type: 'text.delta', itemId: this.itemId, text: d });
      },
      reasoning: (d: string) => {
        this.started = true;
        this.reasoning += d;
        if (!this.timer) this.timer = setTimeout(() => this.emitThinking(false), 400);
      },
      webSearch: (q: string | null) => {
        this.started = true;
        sink({ type: 'activity', itemId: `search-r${this.round}-${this.searches++}`, activity: 'webSearch', title: q ?? 'web search', done: true });
      },
    };
  }

  private emitThinking(done: boolean) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.reasoning.trim()) return;
    this.sink({ type: 'activity', itemId: this.thinkId, activity: 'reasoning', title: this.title, label: L('思考', 'Thinking'), detail: this.reasoning.trim(), done });
  }

  finish() {
    this.emitThinking(true);
  }
}

class UsageTally {
  private readonly known = new Map<string, TurnUsage>();
  private unknownModels = new Set<string>();

  add(model: ChatModel, u: Usage) {
    const cur = this.known.get(model.id) ?? { model: model.id, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: 0 };
    cur.input += u.input;
    cur.cacheRead += u.cacheRead;
    cur.cacheWrite += u.cacheWrite;
    cur.output += u.output;
    cur.reasoning += u.reasoning;
    const cost = costOf(model, u);
    cur.costUsd = cur.costUsd === null || cost === null ? null : cur.costUsd + cost;
    this.known.set(model.id, cur);
  }

  /** A request whose usage the API did not report (a broken or stopped stream): recorded as unknown, never as 0. */
  unknown(modelId: string) {
    this.unknownModels.add(modelId);
  }

  total(): number {
    let n = 0;
    for (const u of this.known.values()) n += u.input + u.cacheRead + u.cacheWrite + u.output;
    return n;
  }

  list(_model: ChatModel): TurnUsage[] {
    const out = [...this.known.values()];
    for (const m of this.unknownModels) out.push({ model: m, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: null, tokensUnknown: true });
    return out;
  }
}

function costOf(model: ChatModel, u: Usage): number | null {
  const p = model.price;
  if (p) return (u.input * p.input + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite + u.output * p.output) / 1_000_000;
  const now = new Date();
  return estimateCostUsd('chat', model.id, localDate(now), u, now);
}

/** FNV-1a over a string, twice with different seeds: short, stable, not reversible. */
function fnv(s: string): string {
  const h = (seed: number) => {
    let x = seed >>> 0;
    for (const ch of s) {
      x ^= ch.charCodeAt(0);
      x = Math.imul(x, 0x01000193) >>> 0;
    }
    return x.toString(16).padStart(8, '0');
  };
  return h(0x811c9dc5) + h(0x2c9277b5);
}

/** Stable, non-reversible id of member and chat ("{session}" in extra body / headers). */
function sessionHash(agentId: string, roomId: string): string {
  return `ht-${fnv(`${agentId}\u0000${roomId}`)}`;
}

/** Tool calls always followed by a result for each of them; stray results dropped. */
export function normalize(items: ChatItem[]): ChatItem[] {
  const out: ChatItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (it.role === 'tool') {
      const prev = out[out.length - 1];
      if (prev?.role !== 'assistant' || !prev.toolCalls.length) continue;
      out.push(pairResults(prev.toolCalls, it.results));
      continue;
    }
    out.push(it);
    if (it.role === 'assistant' && it.toolCalls.length && items[i + 1]?.role !== 'tool') out.push(pairResults(it.toolCalls, []));
  }
  return out;
}

function pairResults(calls: ToolCall[], results: ToolResult[]): ChatItem {
  const byId = new Map(results.map((r) => [r.callId, r]));
  return {
    role: 'tool',
    results: calls.map((c) => byId.get(c.id) ?? { callId: c.id, name: c.name, content: 'cancelled: no result was recorded', isError: true }),
  };
}

function slimResult(r: ToolResult): ToolResult {
  if (r.content.length <= SLIM_MIN_CHARS) return r;
  return { ...r, content: `[left out to save context: ${r.name} result, ${r.content.length} characters; call the tool again if it is needed]` };
}

/** Rough token count: one per non-ASCII character, one per four ASCII characters; attachments a fixed amount. */
function estimateText(s: string): number {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < s.length; i++) (s.charCodeAt(i) < 128 ? ascii++ : other++);
  return Math.ceil(ascii / 4) + other;
}

function estimateItem(it: ChatItem, slim: boolean): number {
  switch (it.role) {
    case 'user':
      return it.parts.reduce((n, p) => n + (p.type === 'text' ? estimateText(p.text) : p.kind === 'image' ? 1600 : 4000), 8);
    case 'summary':
      return estimateText(it.text) + 8;
    case 'assistant':
      return estimateText(it.text) + estimateText(it.reasoning) + it.toolCalls.reduce((n, c) => n + estimateText(c.args) + 16, 8);
    case 'tool':
      return it.results.reduce((n, r) => n + estimateText(slim ? slimResult(r).content : r.content) + 16, 0);
  }
}

/** The conversation as plain text, for the summary request. */
function renderTranscript(items: ChatItem[]): string {
  const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more characters]` : s);
  return items
    .map((it) => {
      switch (it.role) {
        case 'summary':
          return `[Earlier summary]\n${it.text}`;
        case 'user':
          return `[Message]\n${it.parts.map((p) => (p.type === 'text' ? p.text : `[attachment ${p.name}]`)).join('\n')}`;
        case 'assistant':
          return `[You]\n${it.text}${it.toolCalls.map((c) => `\n[tool call ${c.name} ${cap(c.args, 500)}]`).join('')}`;
        case 'tool':
          return it.results.map((r) => `[tool result ${r.name}${r.isError ? ' (error)' : ''}]\n${cap(r.content, 2000)}`).join('\n');
      }
    })
    .join('\n\n');
}

function parseArgs(args: string): Record<string, unknown> | null {
  const t = (args || '').trim();
  if (!t) return {};
  try {
    const v = JSON.parse(t) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toolTitle(c: ToolCall): string {
  const a = argsObject(c.args);
  const arg = typeof a.path === 'string' ? a.path : typeof a.query === 'string' ? a.query : typeof a.title === 'string' ? a.title : '';
  return arg ? `${c.name} ${arg.slice(0, 120)}` : c.name;
}

function preview(args: string): string | null {
  const t = (args || '').trim();
  if (!t || t === '{}') return null;
  return t.length > 500 ? `${t.slice(0, 500)}…` : t;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function errorNotice(e: unknown, provider?: ChatProvider): NoticeText {
  if (needsVertexProject(e, provider)) {
    return L('模型 API 返回错误 HTTP 404：{m}（{hint}，在设置 › 模型供应商里填写）', 'The model API returned HTTP 404: {m} ({hint}, in Settings › Model providers)', { m: e.message, hint: VERTEX_PROJECT_HINT });
  }
  if (e instanceof ChatHttpError) {
    return e.status
      ? L('模型 API 返回错误 HTTP {s}：{m}', 'The model API returned HTTP {s}: {m}', { s: e.status, m: e.message })
      : L('模型 API 请求失败：{m}', 'The model API request failed: {m}', { m: e.message });
  }
  return L('聊天成员出错：{m}', 'The chat member failed: {m}', { m: errorText(e) });
}
