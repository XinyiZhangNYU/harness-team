import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { errorNotice, L, NoticeError, type NoticeText, zhText } from '../../shared/notices.ts';
import { AGENT_AVATAR_MAX, AGENT_AVATAR_RE, ATTACHMENT_LIMITS, CHAT_API_FORMATS, CHAT_MODEL_FIELD_NAMES, IMAGE_MIME_TYPES } from '../../shared/protocol.ts';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import type { ServerEvent } from '../../shared/protocol.ts';
import { AntigravityAdapter, type AntigravityAdapterOptions } from './adapters/antigravity/adapter.ts';
import { DshAdapter, type DshAdapterOptions } from './adapters/dsh/adapter.ts';
import { OpenCodeAdapter, type OpenCodeAdapterOptions } from './adapters/opencode/adapter.ts';
import { CursorAdapter, type CursorAdapterOptions } from './adapters/cursor/adapter.ts';
import { GrokAdapter, type GrokAdapterOptions } from './adapters/grok/adapter.ts';
import { KimiAdapter, type KimiAdapterOptions } from './adapters/kimi/adapter.ts';
import { ClaudeAdapter, type ClaudeAdapterOptions } from './adapters/claude/adapter.ts';
import { CodexAdapter, type CodexAdapterOptions } from './adapters/codex/adapter.ts';
import { MockAdapter } from './adapters/mock.ts';
import { AdapterRegistry } from './adapters/registry.ts';
import { Core, CoreError } from './core.ts';
import { prepareDatabase } from './db.ts';
import { acquireDataDirLock, updateLockUrl } from './instance.ts';
import { EventBus } from './events.ts';
import {
  type AccessPolicy,
  checkApi,
  checkHost,
  checkWebSocket,
  loadOrCreateToken,
  policyFor,
  TOKEN_COOKIE,
  tokenEquals,
} from './security.ts';
import { Store } from './store.ts';
import type { DetectedRuntimes } from './harnesses.ts';
import { claudeProjectsDir, claudeRecentWorkspaces, DirListError, listDirectories, recentWorkspaces } from './workspaces.ts';
import { TEAM_MCP_PATH, createTeamMcpHandler, runTeamTool, teamToolsFor } from './team/mcp.ts';
import { ChatAdapter, type ChatHost } from './adapters/chat/adapter.ts';
import { checkConnection, testModel } from './adapters/chat/call.ts';
import { ChatConfigError, ChatProviders } from './adapters/chat/providers.ts';
import { KeyFiles, type SecretBox } from './adapters/chat/secrets.ts';

export const SERVER_VERSION = '0.12.2';

export interface AppOptions {
  /** 0 = pick a free port (tests). */
  port: number;
  dataDir: string;
  /** Directory with the built web UI (production). */
  webDistDir?: string;
  /** Use Vite dev middleware instead of the built UI. */
  dev?: boolean;
  mockChunkDelayMs?: number;
  /** Chat members' stream idle limit (tests use a short one). */
  chatIdleMs?: number;
  /** Tests only: chat members' fetch_url may reach loopback addresses. */
  chatFetchAllowPrivate?: boolean;
  /** Register the real Codex runtime (official app-server). Omitted = Codex stays unavailable. */
  codex?: CodexAdapterOptions | null;
  /** Register Claude Code through the user's own `claude` CLI (subscription login). Omitted = unavailable. */
  claude?: ClaudeAdapterOptions | null;
  /** Register Antigravity through Google's official ACP runtime (`agy acp`). Omitted = unavailable. */
  antigravity?: AntigravityAdapterOptions | null;
  /** Register DeepSeek Harness through DeepSeek's official ACP runtime (`dsh --profile acp`). Omitted = unavailable. */
  dsh?: DshAdapterOptions | null;
  /** Register OpenCode through its official ACP runtime (`opencode acp`). Omitted = unavailable. */
  opencode?: OpenCodeAdapterOptions | null;
  /** Register Cursor through its official ACP runtime (`cursor-agent acp`). Omitted = unavailable. */
  cursor?: CursorAdapterOptions | null;
  /** Register Grok Build through its official ACP runtime (`grok agent stdio`). Omitted = unavailable. */
  grok?: GrokAdapterOptions | null;
  /** Register Kimi Code through its official ACP runtime (`kimi acp`). Omitted = unavailable. */
  kimi?: KimiAdapterOptions | null;
  /** Why a real runtime has no adapter at start (shown on its card in the add-member form). */
  missingRuntimes?: { codex?: NoticeText; claude?: NoticeText; antigravity?: NoticeText; dsh?: NoticeText; opencode?: NoticeText; cursor?: NoticeText; grok?: NoticeText; kimi?: NoticeText };
  /** Detects the CLIs again (POST /api/runtimes/detect), so installing or logging in needs no restart. */
  detectRuntimes?: () => Promise<DetectedRuntimes>;
  /** Serve the built-in Team MCP to real runtimes (default true). */
  teamMcp?: boolean;
  /** Append a JSONL audit line per Team MCP tool call (no tokens). */
  teamMcpAuditLog?: string;
  /** Database copies kept in <dataDir>/backups (default 10). */
  keepBackups?: number;
  /**
   * Claude Code session-log folder read for "recent workspaces" (default `<CLAUDE_CONFIG_DIR or ~/.claude>/projects`).
   * null = do not read it.
   */
  claudeProjectsDir?: string | null;
  /** The system key store for chat member API keys (desktop app); null = only environment variables. */
  secrets?: SecretBox | null;
}

export interface RunningApp {
  url: string;
  launchUrl: string;
  port: number;
  token: string;
  core: Core;
  store: Store;
  /** What happened to the database at start (backup taken before use / migration). */
  startup: { backupFile: string | null; fromVersion: number; migrated: number[] };
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

const AgentLanguageSchema = z.enum(['zh', 'en']);
const CreateRoom = z.object({
  name: z.string(),
  projectDir: z.string().max(1000).nullable().optional(),
  agentLanguage: AgentLanguageSchema.optional(),
});
const RuntimeKindSchema = z.enum(['mock', 'codex', 'claude', 'antigravity', 'dsh', 'opencode', 'cursor', 'grok', 'kimi', 'chat']);
/** Any mode a runtime offers (PERMISSION_MODES); the Core checks it belongs to the member's runtime. */
const PermissionModeSchema = z.enum([
  'manual',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions',
  'read-only',
  'workspace-write',
  'untrusted',
  'auto-review',
  'full-access',
  'default',
  'accept-edits',
  'skip-permissions',
  'build',
  'agent',
  'ask',
  'yolo',
]);
const CreateAgent = z.object({
  handle: z.string().max(100).nullable().optional(),
  displayName: z.string().max(200),
  runtimeKind: RuntimeKindSchema,
  workspace: z.string().max(1000).optional(),
  worktree: z.boolean().optional(),
  model: z.string().max(200).nullable().optional(),
  effort: z.string().max(40).nullable().optional(),
  permissionMode: PermissionModeSchema.nullable().optional(),
  acknowledgePermissionRisk: z.string().max(100).optional(),
  collabMode: z.enum(['restricted', 'full']).optional(),
  acknowledgeCollabRisk: z.string().max(100).optional(),
  language: AgentLanguageSchema.nullable().optional(),
  providerId: z.string().max(100).nullable().optional(),
  chat: z.lazy(() => ChatMemberSchema).optional(),
});
/** Only display name / model / effort / permission mode / avatar / language are editable. Strict: handle, runtime or workspace in the body is refused. */
const UpdateAgent = z
  .object({
    displayName: z.string().max(200).optional(),
    model: z.string().max(200).nullable().optional(),
    effort: z.string().max(40).nullable().optional(),
    permissionMode: PermissionModeSchema.nullable().optional(),
    acknowledgePermissionRisk: z.string().max(100).optional(),
    avatar: z.string().max(AGENT_AVATAR_MAX).regex(AGENT_AVATAR_RE).nullable().optional(),
    collabMode: z.enum(['restricted', 'full']).optional(),
    acknowledgeCollabRisk: z.string().max(100).optional(),
    language: AgentLanguageSchema.nullable().optional(),
    chat: z.lazy(() => ChatMemberSchema).optional(),
  })
  .strict();
const ChatMemberSchema = z
  .object({
    projectTools: z.boolean(),
    webSearch: z.boolean(),
    webFetch: z.boolean().default(false),
    dailyTokenLimit: z.number().int().min(0).max(1_000_000_000),
    maxToolRounds: z.number().int().min(1).max(200),
  })
  .strict();
const ChatKey = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('env'), name: z.string().max(128) }).strict(),
  z.object({ kind: z.literal('app'), value: z.string().max(4096) }).strict(),
]);
const SaveChatProvider = z
  .object({
    label: z.string().max(100).optional(),
    presetId: z.string().max(40).nullable().optional(),
    format: z.enum(CHAT_API_FORMATS as [string, ...string[]]).optional(),
    baseUrl: z.string().max(500).optional(),
    enabled: z.boolean().optional(),
    vertexProject: z.string().max(100).nullable().optional(),
    vertexLocation: z.string().max(60).nullable().optional(),
    key: ChatKey.optional(),
  })
  .strict();
const AddChatModel = z.object({ id: z.string().max(200) }).strict();
const ModelCatalogQuery = z.object({ refresh: z.boolean().optional(), cwd: z.string().max(4096).nullable().optional() }).strict();
const ConfirmBody = z.object({ confirm: z.boolean().optional() }).passthrough();
const SaveChatModel = z
  // partialRecord: an enum-keyed z.record is exhaustive and would add every missing field as undefined.
  .object({ fields: z.partialRecord(z.enum(CHAT_MODEL_FIELD_NAMES), z.unknown()) })
  .strict();
const FIXED_AGENT_FIELDS = ['handle', 'runtimeKind', 'workspace', 'worktree', 'isMock', 'id', 'createdAt', 'providerId'];
const SetAvatarDefault = z.object({ avatar: z.string().max(AGENT_AVATAR_MAX).regex(AGENT_AVATAR_RE).nullable() }).strict();
const AddMember = z.object({ agentId: z.string(), defaultReply: z.boolean().optional() });
const UpdateMember = z.object({ defaultReply: z.boolean() });
const ReorderMembers = z.object({ agentIds: z.array(z.string()).max(1000) }).strict();
const DecideApproval = z.object({ decision: z.enum(['allow', 'allow_session', 'allow_prefix', 'allow_all_edits', 'deny']) });
const ChooseSession = z.object({ choice: z.enum(['restore', 'retry', 'new']) });
const PostMessage = z.object({
  body: z.string(),
  clientMessageId: z.string(),
  attachmentIds: z.array(z.string().max(100)).max(ATTACHMENT_LIMITS.perMessage).optional(),
});
const UpdateRoom = z.object({
  name: z.string().max(200).optional(),
  autoPaused: z.boolean().optional(),
  autoHopLimit: z.number().int().nullable().optional(),
  projectDir: z.string().max(1000).nullable().optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  agentLanguage: AgentLanguageSchema.optional(),
});
const CreateTask = z.object({ title: z.string(), assigneeId: z.string().nullable().optional() });
const UpdateTask = z.object({
  title: z.string().optional(),
  status: z.enum(['todo', 'doing', 'done']).optional(),
  assigneeId: z.string().nullable().optional(),
});

class HttpError extends Error {
  readonly status: number;
  readonly notice: NoticeText | null;
  constructor(status: number, message: string | NoticeText) {
    super(typeof message === 'string' ? message : zhText(message));
    this.status = status;
    this.notice = typeof message === 'string' ? null : message;
  }
}

export async function startApp(opts: AppOptions): Promise<RunningApp> {
  const lock = acquireDataDirLock(opts.dataDir);
  let prepared;
  try {
    prepared = await prepareDatabase(join(opts.dataDir, 'harness-team.sqlite'), {
      backupDir: join(opts.dataDir, 'backups'),
      keepBackups: opts.keepBackups,
    });
  } catch (e) {
    lock.release();
    throw e;
  }
  const db = prepared.db;
  const store = new Store(db);
  const bus = new EventBus();
  const registry = new AdapterRegistry();
  registry.register(new MockAdapter({ chunkDelayMs: opts.mockChunkDelayMs }));
  if (opts.codex) registry.register(new CodexAdapter({ clientVersion: SERVER_VERSION, ...opts.codex }));
  if (opts.claude) registry.register(new ClaudeAdapter(opts.claude));
  if (opts.antigravity) registry.register(new AntigravityAdapter(opts.antigravity));
  if (opts.dsh) registry.register(new DshAdapter(opts.dsh));
  if (opts.opencode) registry.register(new OpenCodeAdapter(opts.opencode));
  if (opts.cursor) registry.register(new CursorAdapter(opts.cursor));
  if (opts.grok) registry.register(new GrokAdapter(opts.grok));
  if (opts.kimi) registry.register(new KimiAdapter(opts.kimi));
  const chatProviders = new ChatProviders(db, new KeyFiles(opts.dataDir, opts.secrets ?? null));
  let chatHost: ChatHost | null = null;
  registry.register(new ChatAdapter({ db, providers: chatProviders, dataDir: opts.dataDir, host: () => chatHost, idleMs: opts.chatIdleMs, fetchAllowPrivate: opts.chatFetchAllowPrivate }));
  for (const kind of ['codex', 'claude', 'antigravity', 'dsh', 'opencode', 'cursor', 'grok', 'kimi'] as const) {
    const why = opts.missingRuntimes?.[kind];
    if (why && !registry.get(kind)) registry.setMissing(kind, why);
  }
  let core: Core;
  try {
    core = new Core(store, bus, registry, {
      protectedDirs: [opts.dataDir],
      attachmentsDir: join(opts.dataDir, 'attachments'),
      chatModels: chatProviders,
    });
    const c = core;
    chatHost = {
      agent: (id) => store.getAgent(id),
      projectDir: (roomId) => store.getRoom(roomId)?.projectDir ?? null,
      tokensToday: (agentId) => store.agentTokensOnDay(agentId),
      teamTools: (id) => teamToolsFor(c, id),
      runTeamTool: (id, name, args) => runTeamTool(c, id, name, args),
    };
    core.recover();
  } catch (e) {
    for (const a of registry.all()) await a.dispose?.().catch(() => {});
    db.close();
    lock.release();
    throw e;
  }

  /** Applies a new detection: adapters are created, updated or marked unusable; running sessions are left alone. */
  function applyRuntimes(found: DetectedRuntimes) {
    const codex = registry.get('codex');
    if (found.codex.options) {
      if (codex instanceof CodexAdapter) codex.update(found.codex.options);
      else registry.register(new CodexAdapter({ clientVersion: SERVER_VERSION, ...found.codex.options }));
      registry.setMissing('codex', null);
    } else if (codex instanceof CodexAdapter) codex.update({ problem: found.codex.missing });
    else registry.setMissing('codex', found.codex.missing);
    const claude = registry.get('claude');
    if (found.claude.options) {
      if (claude instanceof ClaudeAdapter) claude.update(found.claude.options);
      else registry.register(new ClaudeAdapter(found.claude.options));
      registry.setMissing('claude', null);
    } else if (claude instanceof ClaudeAdapter) claude.update({ problem: found.claude.missing });
    else registry.setMissing('claude', found.claude.missing);
    const ag = registry.get('antigravity');
    if (found.antigravity.options) {
      if (ag instanceof AntigravityAdapter) ag.update(found.antigravity.options);
      else registry.register(new AntigravityAdapter(found.antigravity.options));
      registry.setMissing('antigravity', null);
    } else if (ag instanceof AntigravityAdapter) ag.update({ problem: found.antigravity.missing });
    else registry.setMissing('antigravity', found.antigravity.missing);
    const dsh = registry.get('dsh');
    if (found.dsh.options) {
      if (dsh instanceof DshAdapter) dsh.update(found.dsh.options);
      else registry.register(new DshAdapter(found.dsh.options));
      registry.setMissing('dsh', null);
    } else if (dsh instanceof DshAdapter) dsh.update({ problem: found.dsh.missing });
    else registry.setMissing('dsh', found.dsh.missing);
    const oc = registry.get('opencode');
    if (found.opencode.options) {
      if (oc instanceof OpenCodeAdapter) oc.update(found.opencode.options);
      else registry.register(new OpenCodeAdapter(found.opencode.options));
      registry.setMissing('opencode', null);
    } else if (oc instanceof OpenCodeAdapter) oc.update({ problem: found.opencode.missing });
    else registry.setMissing('opencode', found.opencode.missing);
    const cur = registry.get('cursor');
    if (found.cursor.options) {
      if (cur instanceof CursorAdapter) cur.update(found.cursor.options);
      else registry.register(new CursorAdapter(found.cursor.options));
      registry.setMissing('cursor', null);
    } else if (cur instanceof CursorAdapter) cur.update({ problem: found.cursor.missing });
    else registry.setMissing('cursor', found.cursor.missing);
    const gk = registry.get('grok');
    if (found.grok.options) {
      if (gk instanceof GrokAdapter) gk.update(found.grok.options);
      else registry.register(new GrokAdapter(found.grok.options));
      registry.setMissing('grok', null);
    } else if (gk instanceof GrokAdapter) gk.update({ problem: found.grok.missing });
    else registry.setMissing('grok', found.grok.missing);
    const km = registry.get('kimi');
    if (found.kimi.options) {
      if (km instanceof KimiAdapter) km.update(found.kimi.options);
      else registry.register(new KimiAdapter(found.kimi.options));
      registry.setMissing('kimi', null);
    } else if (km instanceof KimiAdapter) km.update({ problem: found.kimi.missing });
    else registry.setMissing('kimi', found.kimi.missing);
    core.runtimesChanged();
    bus.publish({ type: 'runtimes.updated', runtimes: registry.describeAll() });
  }
  let detecting: Promise<void> | null = null;
  const redetect = (): Promise<void> => {
    if (!opts.detectRuntimes) return Promise.resolve();
    detecting ??= opts.detectRuntimes().then(applyRuntimes).finally(() => {
      detecting = null;
    });
    return detecting;
  };

  const token = loadOrCreateToken(opts.dataDir);
  let policy: AccessPolicy = policyFor(opts.port, token);

  const server: Server = createServer();
  const teamMcp = createTeamMcpHandler({
    core,
    serverVersion: SERVER_VERSION,
    allowedHosts: () => policy.allowedHosts,
    auditLog: opts.teamMcpAuditLog,
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  let vite: { middlewares: (req: IncomingMessage, res: ServerResponse, next: () => void) => void; close(): Promise<void> } | null =
    null;
  if (opts.dev) {
    const { createServer: createVite } = await import('vite');
    vite = await createVite({
      configFile: resolve(import.meta.dirname, '../../vite.config.ts'),
      server: { middlewareMode: true, hmr: { server } },
      appType: 'spa',
    });
  }

  server.on('request', (req, res) => {
    handleRequest(req, res).catch((err) => {
      if (err instanceof ChatConfigError) err = new HttpError(err.status, err.notice);
      let status = err instanceof HttpError || err instanceof CoreError ? err.status : 500;
      let message = status === 500 ? 'internal error' : (err as Error).message;
      if (err instanceof z.ZodError) {
        status = 400;
        message = 'invalid request: ' + err.issues.map((i) => `${i.path.join('.') || '(body)'} ${i.message}`).join('; ');
      }
      if (status === 500) console.error(err);
      // `notice`: the same message in both languages, so the UI can show it in the user's language.
      const notice = status !== 500 && (err instanceof HttpError || err instanceof CoreError) ? err.notice : null;
      if (!res.headersSent) sendJson(res, status, notice ? { error: message, notice } : { error: message });
      else res.end();
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse) {
    setSecurityHeaders(res, !!opts.dev, policy);
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname.startsWith(TEAM_MCP_PATH)) {
      // Agent-side collaboration endpoint; authenticated only by the per-session token in the path.
      return teamMcp(req, res, url.pathname.slice(TEAM_MCP_PATH.length));
    }

    if (url.pathname.startsWith('/api/')) {
      const check = checkApi(req, policy, { binary: UPLOAD_PATH.test(url.pathname) });
      if (!check.ok) return sendJson(res, check.status, { error: check.reason });
      return handleApi(req, res, url);
    }

    const host = checkHost(req, policy);
    if (!host.ok) return sendText(res, host.status, host.reason);

    if (url.pathname === '/auth') {
      // One-time login link printed on the console: sets an HttpOnly, SameSite=Strict cookie, then strips the token from the URL.
      if (!tokenEquals(url.searchParams.get('token') ?? undefined, token)) return sendText(res, 401, 'invalid token');
      res.setHeader('Set-Cookie', `${TOKEN_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
      res.statusCode = 302;
      res.setHeader('Location', '/');
      return res.end();
    }

    if (vite) {
      return vite.middlewares(req, res, () => sendText(res, 404, 'not found'));
    }
    return serveStatic(req, res, url.pathname);
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
    const method = req.method ?? 'GET';
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
    const [a, b, c, d, e] = parts;

    if (method === 'GET' && a === 'session' && !b) {
      return sendJson(res, 200, { ok: true, serverVersion: SERVER_VERSION });
    }
    if (a === 'usage' && !b && method === 'GET') {
      return sendJson(res, 200, core.usageSummary(isoParam(url, 'from'), isoParam(url, 'to')));
    }
    if (a === 'runtimes' && !b && method === 'GET') {
      return sendJson(res, 200, { runtimes: registry.describeAll() });
    }
    if (a === 'runtimes' && b === 'detect' && !c && method === 'POST') {
      await redetect();
      return sendJson(res, 200, { runtimes: registry.describeAll() });
    }
    if (a === 'rooms' && !b) {
      if (method === 'GET') return sendJson(res, 200, { rooms: core.listRooms() });
      if (method === 'POST') {
        const body = CreateRoom.parse(await readJson(req));
        return sendJson(res, 201, { room: core.createRoom(body.name, body.projectDir, body.agentLanguage) });
      }
    }
    if (a === 'rooms' && b && !c && method === 'GET') {
      return sendJson(res, 200, core.roomSnapshot(b, intParam(url, 'limit')));
    }
    if (a === 'rooms' && b && !c && method === 'DELETE') {
      await core.deleteRoom(b);
      return sendJson(res, 200, { ok: true });
    }
    if (a === 'rooms' && b && c === 'settings' && !d && method === 'POST') {
      const body = UpdateRoom.parse(await readJson(req));
      return sendJson(res, 200, { room: core.updateRoom(b, body) });
    }
    if (a === 'rooms' && b && c === 'tasks' && method === 'POST') {
      if (!d) {
        const body = CreateTask.parse(await readJson(req));
        return sendJson(res, 201, { task: core.createTask(b, body) });
      }
      const taskId = Number(d);
      if (!Number.isInteger(taskId) || taskId < 1 || parts.length > 4) throw new HttpError(404, 'not found');
      const body = UpdateTask.parse(await readJson(req));
      return sendJson(res, 200, { task: core.updateTask(taskId, body, 'user', b) });
    }
    if (a === 'rooms' && b && c === 'members' && !d && method === 'POST') {
      const body = AddMember.parse(await readJson(req));
      core.addMember(b, body.agentId, body.defaultReply === true);
      return sendJson(res, 200, { ok: true });
    }
    if (a === 'rooms' && b && c === 'members' && d === 'order' && parts.length === 4 && method === 'PUT') {
      core.reorderMembers(b, ReorderMembers.parse(await readJson(req)).agentIds);
      return sendJson(res, 200, { ok: true });
    }
    if (a === 'rooms' && b && c === 'members' && d && parts.length === 4 && method === 'PATCH') {
      const body = UpdateMember.parse(await readJson(req));
      return sendJson(res, 200, { room: core.setDefaultReply(b, d, body.defaultReply) });
    }
    if (a === 'rooms' && b && c === 'members' && d && parts.length === 4 && method === 'DELETE') {
      await core.removeMember(b, d);
      return sendJson(res, 200, { ok: true });
    }
    if (a === 'rooms' && b && c === 'messages' && !d) {
      if (method === 'GET') {
        const after = intParam(url, 'afterSeq');
        const limit = intParam(url, 'limit');
        const messages = after === undefined ? core.roomSnapshot(b, limit).messages : core.messagesAfter(b, after, limit);
        return sendJson(res, 200, { messages });
      }
      if (method === 'POST') {
        const body = PostMessage.parse(await readJson(req));
        await core.prepareMessage(b, body.body);
        return sendJson(res, 201, { message: core.postUserMessage(b, body.body, body.clientMessageId, body.attachmentIds ?? []) });
      }
    }
    if (a === 'rooms' && b && c === 'attachments' && !d && method === 'POST') {
      // Raw file bytes; the original name (URL-encoded) in X-Filename. Size is enforced while reading.
      const ct = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      if (ct !== 'application/octet-stream') throw new HttpError(415, 'content-type must be application/octet-stream');
      let name = '';
      try {
        name = decodeURIComponent(String(req.headers['x-filename'] ?? ''));
      } catch {
        name = '';
      }
      // The larger of the two limits here; Core applies the per-kind limit once it knows what the bytes are.
      const bytes = await readRaw(req, Math.max(ATTACHMENT_LIMITS.imageBytes, ATTACHMENT_LIMITS.fileBytes));
      return sendJson(res, 201, { attachment: core.uploadAttachment(b, name, bytes) });
    }
    if (a === 'attachments' && b && !c && method === 'DELETE') {
      core.deleteAttachment(b);
      return sendJson(res, 200, { ok: true });
    }
    if (a === 'attachments' && b && c === 'raw' && !d && method === 'GET') {
      const { path, info } = core.attachmentFile(b);
      if (!existsSync(path)) throw new HttpError(404, 'attachment file missing');
      res.statusCode = 200;
      // Only the detected image types are ever served inline; anything else downloads.
      const image = info.kind === 'image' && IMAGE_TYPES.has(info.mime);
      res.setHeader('Content-Type', image ? info.mime : 'application/octet-stream');
      res.setHeader('Content-Length', String(statSync(path).size));
      res.setHeader('Content-Disposition', `${image ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(info.name)}`);
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      createReadStream(path).pipe(res);
      return;
    }
    if (a === 'attention' && !b && method === 'GET') return sendJson(res, 200, core.attention());
    if (a === 'agents' && !b) {
      if (method === 'GET') return sendJson(res, 200, { agents: core.listAgents() });
      if (method === 'POST') {
        const body = CreateAgent.parse(await readJson(req));
        return sendJson(res, 201, { agent: await core.createAgent(body) });
      }
    }
    if (a === 'agents' && b === 'handle-suggestion' && !c && method === 'GET') {
      const kind = RuntimeKindSchema.parse(url.searchParams.get('runtimeKind') ?? 'mock');
      return sendJson(res, 200, { handle: core.suggestHandle(url.searchParams.get('displayName') ?? '', kind) });
    }
    if (a === 'agents' && b && b !== 'handle-suggestion' && !c && method === 'GET') {
      return sendJson(res, 200, core.agentDetail(b));
    }
    if (a === 'agents' && b && b !== 'handle-suggestion' && !c && method === 'DELETE') {
      await core.deleteAgent(b);
      return sendJson(res, 200, { ok: true });
    }
    if (a === 'agents' && b && c === 'commands' && !d && method === 'GET') {
      return sendJson(res, 200, await core.agentCommands(b, url.searchParams.get('refresh') === '1'));
    }
    if (a === 'agents' && b && !c && method === 'PATCH') {
      const raw = await readJson(req);
      const fixed = raw && typeof raw === 'object' ? FIXED_AGENT_FIELDS.filter((k) => k in (raw as object)) : [];
      if (fixed.length) {
        throw new HttpError(
          400,
          L(
            '创建后不可修改：{fields}（@ 名称、Runtime、工作目录和模型来源关系到原生会话、计费、Worktree 分支和 @提及）',
            'Cannot be changed after creation: {fields} (the handle, runtime, working folder and model source decide the native session, billing, worktree branch and @mentions)',
            { fields: [...fixed] },
          ),
        );
      }
      return sendJson(res, 200, await core.updateAgent(b, UpdateAgent.parse(raw)));
    }
    if (a === 'chat-providers') {
      const dec = (v: string | undefined) => {
        try {
          return v === undefined ? undefined : decodeURIComponent(v);
        } catch {
          throw new HttpError(400, 'bad path');
        }
      };
      const [id, sub, modelId] = [dec(b), c, dec(d)];
      if (!id && method === 'GET') return sendJson(res, 200, chatProviders.response());
      if (!id && method === 'POST') {
        const p = await chatProviders.create(SaveChatProvider.parse(await readJson(req)) as Parameters<ChatProviders['create']>[0]);
        return sendJson(res, 201, { provider: p });
      }
      if (id && !sub && parts.length === 2 && method === 'PATCH') {
        const p = await chatProviders.update(id, SaveChatProvider.parse(await readJson(req)) as Parameters<ChatProviders['update']>[1]);
        return sendJson(res, 200, { provider: p });
      }
      if (id && !sub && parts.length === 2 && method === 'DELETE') {
        const hadAvatar = !!core.avatarDefaults()[`chat:${id}`];
        chatProviders.delete(id, store.providerInUse(id));
        if (hadAvatar) bus.publish({ type: 'avatar-defaults.updated', defaults: core.avatarDefaults() });
        return sendJson(res, 200, { ok: true });
      }
      if (id && sub === 'models' && !modelId && parts.length === 3 && method === 'POST') {
        return sendJson(res, 201, { provider: chatProviders.addModel(id, AddChatModel.parse(await readJson(req)).id) });
      }
      if (id && sub === 'models' && modelId && parts.length === 4 && method === 'PATCH') {
        const body = SaveChatModel.parse(await readJson(req)) as Parameters<ChatProviders['updateModel']>[2];
        return sendJson(res, 200, { provider: chatProviders.updateModel(id, modelId, body) });
      }
      if (id && sub === 'models' && modelId && parts.length === 4 && method === 'DELETE') {
        return sendJson(res, 200, { provider: chatProviders.removeModel(id, modelId, store.providerInUse(id, modelId)) });
      }
      if (id && sub === 'check' && parts.length === 3 && method === 'POST') {
        const p = chatProviders.get(id);
        if (!p) throw new HttpError(404, 'provider not found');
        return sendJson(res, 200, await checkConnection(p, await chatProviders.key(id)));
      }
      if (id && sub === 'models' && modelId && e === 'test' && parts.length === 5 && method === 'POST') {
        // A billed request: only with an explicit confirmation from the user.
        if (ConfirmBody.parse(await readJson(req)).confirm !== true) throw new HttpError(400, 'confirm required');
        const p = chatProviders.get(id);
        const m = p?.models.find((x) => x.id === modelId);
        if (!p || !m) throw new HttpError(404, 'model not found');
        return sendJson(res, 200, await testModel(p, m, await chatProviders.key(id)));
      }
    }
    if (a === 'avatar-defaults' && !b && method === 'GET') return sendJson(res, 200, { defaults: core.avatarDefaults() });
    if (a === 'avatar-defaults' && b && !c && method === 'PUT') {
      let key: string;
      try {
        key = decodeURIComponent(b);
      } catch {
        throw new HttpError(400, 'bad path');
      }
      // A model provider's default avatar: only for a saved provider.
      if (key.startsWith('chat:') && !chatProviders.get(key.slice(5))) throw new HttpError(404, 'provider not found');
      return sendJson(res, 200, { defaults: core.setAvatarDefault(key, SetAvatarDefault.parse(await readJson(req)).avatar) });
    }
    // POST, not GET: it starts the harness CLI in `cwd`, and a GET could be sent by an image in a chat message.
    if (a === 'runtimes' && b && c === 'models' && !d && method === 'POST') {
      const kind = RuntimeKindSchema.parse(b);
      const { refresh, cwd } = ModelCatalogQuery.parse(await readJson(req));
      return sendJson(res, 200, { catalog: await core.modelCatalog(kind, { refresh: refresh === true, cwd: cwd || null }) });
    }
    if (a === 'workspaces' && b === 'recent' && !c && method === 'GET') {
      // Project directories the user already worked in with Codex / Claude Code (and existing members), for the
      // member form. Paths only; see workspaces.ts for exactly what is read. `?history=0` (the "include Codex / Claude
      // Code history" switch turned off) skips reading their history: only folders of existing members.
      const history = url.searchParams.get('history') !== '0';
      const codex = history ? registry.get('codex') : undefined;
      const claudeDir = opts.claudeProjectsDir === undefined ? claudeProjectsDir() : opts.claudeProjectsDir;
      return sendJson(
        res,
        200,
        await recentWorkspaces({
          codex: codex?.describe().available && codex.recentWorkspaces ? () => codex.recentWorkspaces!() : undefined,
          claude: history && claudeDir ? async () => claudeRecentWorkspaces(claudeDir) : undefined,
          harness: () =>
            core
              .listAgents()
              .filter((ag) => ag.workspace)
              .map((ag) => ({ path: ag.workspace!, at: Date.parse(ag.createdAt) || null })),
        }),
      );
    }
    if (a === 'fs' && b === 'dirs' && !c && method === 'GET') {
      // In-app folder browser (the desktop shell also offers the native Windows dialog). Directory names only.
      try {
        return sendJson(res, 200, listDirectories(url.searchParams.get('path') || null));
      } catch (e) {
        if (e instanceof DirListError) throw new HttpError(e.status, errorNotice(e));
        throw e;
      }
    }
    if (a === 'approvals' && b && !c && method === 'POST') {
      // The local user's decision on a native approval request (cookie-authenticated user API only).
      const body = DecideApproval.parse(await readJson(req));
      return sendJson(res, 200, { message: core.decideApproval(b, body.decision) });
    }
    if (a === 'session-choices' && b && !c && method === 'POST') {
      // The user's answer to "a member's session could not be resumed" (restore / retry / new session).
      const body = ChooseSession.parse(await readJson(req));
      return sendJson(res, 200, { message: await core.chooseSession(b, body.choice) });
    }
    if (a === 'rooms' && b && c === 'interrupt' && !d && method === 'POST') {
      await readJson(req);
      return sendJson(res, 202, core.interruptRoom(b));
    }
    if (a === 'agents' && b && c === 'interrupt' && !d && method === 'POST') {
      await readJson(req);
      return sendJson(res, 202, core.interruptAgent(b));
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
    const root = opts.webDistDir;
    if (!root || !existsSync(join(root, 'index.html'))) {
      return sendText(res, 503, 'Web UI is not built. Run "npm start" (builds the UI) or "npm run dev".');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'method not allowed');
    let rel: string;
    try {
      rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
    } catch {
      return sendText(res, 400, 'bad path');
    }
    let file = resolve(root, rel);
    if (file !== resolve(root) && !file.startsWith(resolve(root) + sep)) return sendText(res, 403, 'forbidden');
    if (!existsSync(file) || !statSync(file).isFile()) file = join(root, 'index.html'); // SPA fallback
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
    res.statusCode = 200;
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable');
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  }

  // ---- WebSocket: server -> client event stream ----
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') return; // leave other upgrades (e.g. Vite HMR in dev) alone
    const check = checkWebSocket(req, policy);
    if (!check.ok) {
      socket.write(`HTTP/1.1 ${check.status} ${check.reason}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
  });

  function onConnection(ws: WebSocket) {
    const send = (ev: ServerEvent) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(ev));
    };
    send({ type: 'hello', serverVersion: SERVER_VERSION, eventSeq: bus.currentSeq });
    const unsubscribe = bus.subscribe(send);
    // Client -> server traffic is not used yet; commands go through the HTTP API.
    ws.on('message', () => {});
    ws.on('close', unsubscribe);
    ws.on('error', unsubscribe);
  }

  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(opts.port, '127.0.0.1', () => resolveListen());
    });
  } catch (e) {
    for (const a of registry.all()) await a.dispose?.().catch(() => {});
    if (vite) await vite.close().catch(() => {});
    db.close();
    lock.release();
    throw (e as NodeJS.ErrnoException).code === 'EADDRINUSE'
      ? new NoticeError(L('端口 {port} 已被占用；请用 --port 指定其他端口（或 --port 0 自动选择）', 'Port {port} is already in use; choose another one with --port (or --port 0 to pick one automatically)', { port: opts.port }))
      : e;
  }
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;
  policy = policyFor(port, token);
  const url = `http://127.0.0.1:${port}`;
  updateLockUrl(lock, url);
  core.start(opts.teamMcp === false ? null : `${url}${TEAM_MCP_PATH}`);

  return {
    url,
    launchUrl: `${url}/auth?token=${token}`,
    port,
    token,
    core,
    store,
    startup: { backupFile: prepared.backupFile, fromVersion: prepared.fromVersion, migrated: prepared.migrated },
    async close() {
      await core.shutdown();
      for (const a of registry.all()) await a.dispose?.().catch(() => {});
      for (const client of wss.clients) client.terminate();
      wss.close();
      if (vite) await vite.close();
      await new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections();
      db.close();
      lock.release();
    },
  };
}

function setSecurityHeaders(res: ServerResponse, dev: boolean, policy: AccessPolicy) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (!dev) {
    const ws = [...policy.allowedHosts].map((h) => `ws://${h}`).join(' ');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; ` +
        `connect-src 'self' ${ws}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    );
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, text: string) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(text);
}

/** Optional timestamp query parameter, normalized to the ISO form usage rows are stored in (so text order = time order). */
function isoParam(url: URL, name: string): string | null {
  const v = url.searchParams.get(name);
  if (!v) return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new HttpError(400, `${name} must be a timestamp`);
  return new Date(t).toISOString();
}

function intParam(url: URL, name: string): number | undefined {
  const v = url.searchParams.get(name);
  if (v === null) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `invalid ${name}`);
  return n;
}

const UPLOAD_PATH = /^\/api\/rooms\/[^/]+\/attachments$/;
const IMAGE_TYPES = new Set<string>(IMAGE_MIME_TYPES);

async function readRaw(req: IncomingMessage, max: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) throw new HttpError(413, `file too large (max ${Math.round(max / 1024 / 1024)} MB)`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new HttpError(413, `file too large (max ${Math.round(max / 1024 / 1024)} MB)`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 256 * 1024) throw new HttpError(413, 'request body too large');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}
