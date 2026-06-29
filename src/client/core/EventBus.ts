export type EventMap = object;
export type EventHandler<TPayload> = (payload: TPayload) => void;

/**
 * Strongly typed observer boundary. Systems publish domain events without taking
 * a hard dependency on UI, audio, achievements, or analytics consumers.
 */
export class EventBus<TEvents extends EventMap> {
  private readonly handlers = new Map<keyof TEvents, Set<EventHandler<TEvents[keyof TEvents]>>>();

  on<TKey extends keyof TEvents>(type: TKey, handler: EventHandler<TEvents[TKey]>): () => void {
    const typedHandler = handler as EventHandler<TEvents[keyof TEvents]>;
    const handlers = this.handlers.get(type) ?? new Set<EventHandler<TEvents[keyof TEvents]>>();
    handlers.add(typedHandler);
    this.handlers.set(type, handlers);
    return () => this.off(type, handler);
  }

  off<TKey extends keyof TEvents>(type: TKey, handler: EventHandler<TEvents[TKey]>): void {
    this.handlers.get(type)?.delete(handler as EventHandler<TEvents[keyof TEvents]>);
  }

  emit<TKey extends keyof TEvents>(type: TKey, payload: TEvents[TKey]): void {
    for (const handler of this.handlers.get(type) ?? []) {
      (handler as EventHandler<TEvents[TKey]>)(payload);
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
