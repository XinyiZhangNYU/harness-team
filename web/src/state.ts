import type {
  AgentWithStatus,
  AvatarDefaults,
  DeliveryInfo,
  Message,
  Room,
  RoomSnapshot,
  RuntimeDescriptor,
  ScheduledTask,
  ServerEvent,
  Task,
} from '../../shared/protocol.ts';
import { applyDelta } from '../../shared/protocol.ts';
import type { ConnectionState } from './api.ts';

export interface State {
  rooms: Room[];
  agents: Record<string, AgentWithStatus>;
  runtimes: RuntimeDescriptor[];
  currentRoomId: string | null;
  /** Loaded room contents; only rooms that were opened are present. */
  messages: Record<string, Message[]>;
  members: Record<string, string[]>;
  /** Delivery records per loaded room (push queue stages). */
  deliveries: Record<string, DeliveryInfo[]>;
  tasks: Record<string, Task[]>;
  /** Scheduled tasks per loaded room. */
  schedules: Record<string, ScheduledTask[]>;
  connection: ConnectionState;
  /** Default member avatar per runtime (for members without their own picture). */
  avatarDefaults: AvatarDefaults;
}

export const initialState: State = {
  rooms: [],
  agents: {},
  runtimes: [],
  currentRoomId: null,
  messages: {},
  members: {},
  deliveries: {},
  tasks: {},
  schedules: {},
  connection: 'connecting',
  avatarDefaults: {},
};

export type Action =
  | { type: 'bootstrap'; rooms: Room[]; agents: AgentWithStatus[]; runtimes: RuntimeDescriptor[] }
  | { type: 'select'; roomId: string | null }
  | { type: 'snapshot'; snapshot: RoomSnapshot }
  | { type: 'connection'; state: ConnectionState }
  | { type: 'avatarDefaults'; defaults: AvatarDefaults }
  | { type: 'event'; event: ServerEvent };

function upsertById<T extends { id: string | number }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

function upsertMessage(list: Message[], m: Message): Message[] {
  const i = list.findIndex((x) => x.id === m.id);
  if (i >= 0) {
    const next = list.slice();
    next[i] = m;
    return next;
  }
  const next = [...list, m];
  next.sort((a, b) => a.seq - b.seq);
  return next;
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'bootstrap': {
      const agents = Object.fromEntries(action.agents.map((a) => [a.id, a]));
      const currentRoomId =
        state.currentRoomId && action.rooms.some((r) => r.id === state.currentRoomId)
          ? state.currentRoomId
          : (action.rooms[0]?.id ?? null);
      return { ...state, rooms: action.rooms, agents, runtimes: action.runtimes, currentRoomId };
    }
    case 'select':
      return { ...state, currentRoomId: action.roomId };
    case 'snapshot': {
      const { room, members, messages, deliveries, tasks, schedules } = action.snapshot;
      const agents = { ...state.agents };
      for (const m of members) agents[m.id] = m;
      return {
        ...state,
        agents,
        messages: { ...state.messages, [room.id]: messages },
        members: { ...state.members, [room.id]: members.map((m) => m.id) },
        deliveries: { ...state.deliveries, [room.id]: deliveries },
        tasks: { ...state.tasks, [room.id]: tasks },
        schedules: { ...state.schedules, [room.id]: schedules ?? [] },
        rooms: state.rooms.map((r) => (r.id === room.id ? room : r)),
      };
    }
    case 'connection':
      return { ...state, connection: action.state };
    case 'avatarDefaults':
      return { ...state, avatarDefaults: action.defaults };
    case 'event':
      return applyEvent(state, action.event);
  }
}

function applyEvent(state: State, e: ServerEvent): State {
  switch (e.type) {
    case 'hello':
      return state;
    case 'runtimes.updated':
      return { ...state, runtimes: e.runtimes };
    case 'avatar-defaults.updated':
      return { ...state, avatarDefaults: e.defaults };
    case 'room.created':
      if (state.rooms.some((r) => r.id === e.room.id)) return state;
      return { ...state, rooms: [...state.rooms, e.room] };
    case 'room.updated':
      return { ...state, rooms: state.rooms.map((r) => (r.id === e.room.id ? e.room : r)) };
    case 'room.deleted': {
      const i = state.rooms.findIndex((r) => r.id === e.roomId);
      if (i < 0) return state;
      const rooms = state.rooms.filter((r) => r.id !== e.roomId);
      // The deleted room was open: move to its neighbour in the list.
      const currentRoomId =
        state.currentRoomId === e.roomId ? (rooms[Math.min(i, rooms.length - 1)]?.id ?? null) : state.currentRoomId;
      return {
        ...state,
        rooms,
        currentRoomId,
        messages: without(state.messages, e.roomId),
        members: without(state.members, e.roomId),
        deliveries: without(state.deliveries, e.roomId),
        tasks: without(state.tasks, e.roomId),
        schedules: without(state.schedules, e.roomId),
      };
    }
    case 'delivery.updated': {
      const list = state.deliveries[e.delivery.roomId];
      if (!list) return state;
      return { ...state, deliveries: { ...state.deliveries, [e.delivery.roomId]: upsertById(list, e.delivery) } };
    }
    case 'task.updated': {
      const list = state.tasks[e.task.roomId];
      if (!list) return state;
      return { ...state, tasks: { ...state.tasks, [e.task.roomId]: upsertById(list, e.task) } };
    }
    case 'schedule.updated': {
      const list = state.schedules[e.schedule.roomId];
      if (!list) return state;
      return { ...state, schedules: { ...state.schedules, [e.schedule.roomId]: upsertById(list, e.schedule) } };
    }
    case 'schedule.deleted': {
      const list = state.schedules[e.roomId];
      if (!list) return state;
      return { ...state, schedules: { ...state.schedules, [e.roomId]: list.filter((x) => x.id !== e.scheduleId) } };
    }
    case 'agent.created':
    case 'agent.updated':
      return { ...state, agents: { ...state.agents, [e.agent.id]: e.agent } };
    case 'agent.status': {
      const a = state.agents[e.agentId];
      if (!a) return state;
      return { ...state, agents: { ...state.agents, [a.id]: { ...a, status: e.status } } };
    }
    case 'member.added': {
      const cur = state.members[e.roomId];
      if (!cur || cur.includes(e.agentId)) return state;
      return { ...state, members: { ...state.members, [e.roomId]: [...cur, e.agentId] } };
    }
    case 'members.reordered': {
      if (!state.members[e.roomId]) return state;
      return { ...state, members: { ...state.members, [e.roomId]: e.agentIds } };
    }
    case 'member.removed': {
      const cur = state.members[e.roomId];
      if (!cur || !cur.includes(e.agentId)) return state;
      return { ...state, members: { ...state.members, [e.roomId]: cur.filter((id) => id !== e.agentId) } };
    }
    case 'message.created':
    case 'message.updated': {
      const list = state.messages[e.message.roomId];
      if (!list) return state;
      return { ...state, messages: { ...state.messages, [e.message.roomId]: upsertMessage(list, e.message) } };
    }
    case 'message.delta': {
      const list = state.messages[e.roomId];
      if (!list) return state;
      const i = list.findIndex((m) => m.id === e.messageId);
      if (i < 0) return state;
      const cur = list[i]!;
      const body = applyDelta(cur.body, e.offset, e.delta);
      if (body === null || body === cur.body) return state;
      const next = list.slice();
      next[i] = { ...cur, body };
      return { ...state, messages: { ...state.messages, [e.roomId]: next } };
    }
  }
}

function without<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec;
  const next = { ...rec };
  delete next[key];
  return next;
}
