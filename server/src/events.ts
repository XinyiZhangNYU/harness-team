import type { ServerEvent, ServerEventInput } from '../../shared/protocol.ts';

export type Listener = (event: ServerEvent) => void;

/** In-process fan-out of Core events to WebSocket clients. `eventSeq` is per-process and only for ordering/debug. */
export class EventBus {
  private seq = 0;
  private readonly listeners = new Set<Listener>();

  get currentSeq(): number {
    return this.seq;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: ServerEventInput): ServerEvent {
    const full = { ...event, eventSeq: ++this.seq } as ServerEvent;
    for (const l of this.listeners) {
      try {
        l(full);
      } catch {
        // A failing listener must not break the Core.
      }
    }
    return full;
  }
}
