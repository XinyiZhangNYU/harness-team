import { isNotice, type NoticeText } from '../../shared/notices.ts';
import type {
  SessionChoiceOption,
  UsageSummary,
  AgentCommands,
  AgentDetailResponse,
  AgentWithStatus,
  ApprovalDecision,
  AvatarDefaultKey,
  AvatarDefaults,
  AttachmentInfo,
  ChatConnectionCheck,
  ChatModelTest,
  ChatProvider,
  ChatProvidersResponse,
  CreateAgentRequest,
  DirListing,
  Message,
  RecentWorkspacesResponse,
  AgentLanguage,
  Room,
  RoomPatch,
  RoomSnapshot,
  RuntimeDescriptor,
  RuntimeKind,
  RuntimeModelCatalog,
  SaveChatModelRequest,
  SaveChatProviderRequest,
  ServerEvent,
  Task,
  TaskStatus,
  UpdateAgentRequest,
  UpdateAgentResponse,
} from '../../shared/protocol.ts';

export class ApiError extends Error {
  readonly status: number;
  /** The same message in both languages (when the server sent one); see `errorText`. */
  readonly notice: NoticeText | null;
  constructor(status: number, message: string, notice?: unknown) {
    super(message);
    this.status = status;
    this.notice = isNotice(notice) ? notice : null;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, json.error ?? res.statusText, json.notice);
  return json as T;
}

export const api = {
  session: () => request<{ ok: boolean; serverVersion: string }>('GET', '/api/session'),
  usage: (from: string | null) =>
    request<UsageSummary>('GET', `/api/usage${from ? `?from=${encodeURIComponent(from)}` : ''}`),
  runtimes: () => request<{ runtimes: RuntimeDescriptor[] }>('GET', '/api/runtimes').then((r) => r.runtimes),
  /** Looks for the harness CLIs again (no model request); the result also arrives as `runtimes.updated`. */
  detectRuntimes: () => request<{ runtimes: RuntimeDescriptor[] }>('POST', '/api/runtimes/detect', {}).then((r) => r.runtimes),
  rooms: () => request<{ rooms: Room[] }>('GET', '/api/rooms').then((r) => r.rooms),
  createRoom: (name: string, projectDir: string | null = null, agentLanguage: AgentLanguage = 'zh') =>
    request<{ room: Room }>('POST', '/api/rooms', { name, projectDir, agentLanguage }).then((r) => r.room),
  room: (id: string) => request<RoomSnapshot>('GET', `/api/rooms/${id}?limit=500`),
  deleteRoom: (id: string) => request<{ ok: boolean }>('DELETE', `/api/rooms/${id}`, {}),
  agents: () => request<{ agents: AgentWithStatus[] }>('GET', '/api/agents').then((r) => r.agents),
  createAgent: (req: CreateAgentRequest) =>
    request<{ agent: AgentWithStatus }>('POST', '/api/agents', req).then((r) => r.agent),
  agentDetail: (id: string) => request<AgentDetailResponse>('GET', `/api/agents/${id}`),
  agentCommands: (id: string, refresh = false) => request<AgentCommands>('GET', `/api/agents/${id}/commands${refresh ? '?refresh=1' : ''}`),
  updateAgent: (id: string, patch: UpdateAgentRequest) => request<UpdateAgentResponse>('PATCH', `/api/agents/${id}`, patch),
  handleSuggestion: (displayName: string, runtimeKind: RuntimeKind) =>
    request<{ handle: string }>(
      'GET',
      `/api/agents/handle-suggestion?displayName=${encodeURIComponent(displayName)}&runtimeKind=${runtimeKind}`,
    ).then((r) => r.handle),
  modelCatalog: (kind: RuntimeKind, opts: { refresh?: boolean; cwd?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.refresh) q.set('refresh', '1');
    if (opts.cwd) q.set('cwd', opts.cwd);
    const qs = q.toString();
    return request<{ catalog: RuntimeModelCatalog }>('GET', `/api/runtimes/${kind}/models${qs ? `?${qs}` : ''}`).then((r) => r.catalog);
  },
  chatProviders: () => request<ChatProvidersResponse>('GET', '/api/chat-providers'),
  createChatProvider: (req: SaveChatProviderRequest) =>
    request<{ provider: ChatProvider }>('POST', '/api/chat-providers', req).then((r) => r.provider),
  updateChatProvider: (id: string, req: SaveChatProviderRequest) =>
    request<{ provider: ChatProvider }>('PATCH', `/api/chat-providers/${encodeURIComponent(id)}`, req).then((r) => r.provider),
  deleteChatProvider: (id: string) => request<{ ok: boolean }>('DELETE', `/api/chat-providers/${encodeURIComponent(id)}`, {}),
  addChatModel: (id: string, modelId: string) =>
    request<{ provider: ChatProvider }>('POST', `/api/chat-providers/${encodeURIComponent(id)}/models`, { id: modelId }).then((r) => r.provider),
  updateChatModel: (id: string, modelId: string, req: SaveChatModelRequest) =>
    request<{ provider: ChatProvider }>('PATCH', `/api/chat-providers/${encodeURIComponent(id)}/models/${encodeURIComponent(modelId)}`, req).then((r) => r.provider),
  removeChatModel: (id: string, modelId: string) =>
    request<{ provider: ChatProvider }>('DELETE', `/api/chat-providers/${encodeURIComponent(id)}/models/${encodeURIComponent(modelId)}`, {}).then((r) => r.provider),
  /** Free: reads the provider's model list (no message is sent). */
  checkChatProvider: (id: string) => request<ChatConnectionCheck>('POST', `/api/chat-providers/${encodeURIComponent(id)}/check`, {}),
  /** Billed: one short test message. Only after the user confirmed it. */
  testChatModel: (id: string, modelId: string) =>
    request<ChatModelTest>('POST', `/api/chat-providers/${encodeURIComponent(id)}/models/${encodeURIComponent(modelId)}/test`, { confirm: true }),
  avatarDefaults: () => request<{ defaults: AvatarDefaults }>('GET', '/api/avatar-defaults').then((r) => r.defaults),
  /** null removes the runtime's (or model provider's) default; the result also arrives as `avatar-defaults.updated`. */
  setAvatarDefault: (key: AvatarDefaultKey, avatar: string | null) =>
    request<{ defaults: AvatarDefaults }>('PUT', `/api/avatar-defaults/${encodeURIComponent(key)}`, { avatar }).then((r) => r.defaults),
  recentWorkspaces: (history = true) =>
    request<RecentWorkspacesResponse>('GET', `/api/workspaces/recent${history ? '' : '?history=0'}`),
  listDirs: (path: string | null) =>
    request<DirListing>('GET', `/api/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  addMember: (roomId: string, agentId: string, defaultReply = false) =>
    request('POST', `/api/rooms/${roomId}/members`, { agentId, ...(defaultReply ? { defaultReply } : {}) }),
  setDefaultReply: (roomId: string, agentId: string, defaultReply: boolean) =>
    request<{ room: Room }>('PATCH', `/api/rooms/${roomId}/members/${agentId}`, { defaultReply }),
  /** Every current member of the room, in the new order; the result also arrives as `members.reordered`. */
  reorderMembers: (roomId: string, agentIds: string[]) =>
    request<{ ok: true }>('PUT', `/api/rooms/${encodeURIComponent(roomId)}/members/order`, { agentIds }),
  removeMember: (roomId: string, agentId: string) =>
    request<{ ok: boolean }>('DELETE', `/api/rooms/${roomId}/members/${agentId}`, {}),
  deleteAgent: (id: string) => request<{ ok: boolean }>('DELETE', `/api/agents/${id}`, {}),
  postMessage: (roomId: string, body: string, clientMessageId: string, attachmentIds: string[] = []) =>
    request<{ message: Message }>('POST', `/api/rooms/${roomId}/messages`, {
      body,
      clientMessageId,
      ...(attachmentIds.length ? { attachmentIds } : {}),
    }).then((r) => r.message),
  /** Raw file bytes; the server decides the type from the bytes themselves. */
  uploadAttachment: async (roomId: string, file: Blob & { name?: string }): Promise<AttachmentInfo> => {
    const res = await fetch(`/api/rooms/${roomId}/attachments`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(file.name ?? '') },
      body: file,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new ApiError(res.status, json.error ?? res.statusText, json.notice);
    return (json as { attachment: AttachmentInfo }).attachment;
  },
  deleteAttachment: (id: string) => request<{ ok: boolean }>('DELETE', `/api/attachments/${id}`, {}),
  updateRoom: (roomId: string, patch: RoomPatch) =>
    request<{ room: Room }>('POST', `/api/rooms/${roomId}/settings`, patch).then((r) => r.room),
  createTask: (roomId: string, title: string, assigneeId: string | null) =>
    request<{ task: Task }>('POST', `/api/rooms/${roomId}/tasks`, { title, assigneeId }).then((r) => r.task),
  updateTask: (roomId: string, taskId: number, patch: { status?: TaskStatus; assigneeId?: string | null; title?: string }) =>
    request<{ task: Task }>('POST', `/api/rooms/${roomId}/tasks/${taskId}`, patch).then((r) => r.task),
  interrupt: (agentId: string) => request<{ requested: boolean }>('POST', `/api/agents/${agentId}/interrupt`, {}),
  interruptRoom: (roomId: string) => request<{ requested: number }>('POST', `/api/rooms/${roomId}/interrupt`, {}),
  decideApproval: (messageId: string, decision: ApprovalDecision) =>
    request<{ message: Message }>('POST', `/api/approvals/${messageId}`, { decision }).then((r) => r.message),
  chooseSession: (messageId: string, choice: SessionChoiceOption) =>
    request<{ message: Message }>('POST', `/api/session-choices/${messageId}`, { choice }).then((r) => r.message),
};

export type ConnectionState = 'connecting' | 'open' | 'closed';

/** Event stream with automatic reconnect. `onOpen` fires on every (re)connect so the UI can resync. */
export function connectEvents(handlers: {
  onEvent: (e: ServerEvent) => void;
  onState: (s: ConnectionState) => void;
  onOpen: () => void;
}): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let attempt = 0;
  let timer: number | undefined;

  const open = () => {
    if (stopped) return;
    handlers.onState('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      attempt = 0;
      handlers.onState('open');
      handlers.onOpen();
    };
    ws.onmessage = (msg) => {
      try {
        handlers.onEvent(JSON.parse(String(msg.data)) as ServerEvent);
      } catch {
        /* ignore malformed */
      }
    };
    ws.onclose = () => {
      handlers.onState('closed');
      if (stopped) return;
      const delay = Math.min(10000, 500 * 2 ** attempt++);
      timer = window.setTimeout(open, delay);
    };
  };
  open();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}

export function newClientMessageId(): string {
  return crypto.randomUUID();
}
