export type EventHandler = (...args: unknown[]) => void;

export class TinyEmitter {
  private readonly listeners = new Map<string, Set<EventHandler>>();

  on(event: string, handler: EventHandler): this {
    const bucket = this.listeners.get(event) ?? new Set<EventHandler>();
    bucket.add(handler);
    this.listeners.set(event, bucket);
    return this;
  }

  once(event: string, handler: EventHandler): this {
    const wrapped: EventHandler = (...args: unknown[]) => {
      this.off(event, wrapped);
      handler(...args);
    };
    return this.on(event, wrapped);
  }

  off(event: string, handler?: EventHandler): this {
    if (!handler) {
      this.listeners.delete(event);
      return this;
    }
    const bucket = this.listeners.get(event);
    if (!bucket) {
      return this;
    }
    bucket.delete(handler);
    if (bucket.size === 0) {
      this.listeners.delete(event);
    }
    return this;
  }

  emit(event: string, ...args: unknown[]): boolean {
    const bucket = this.listeners.get(event);
    if (!bucket || bucket.size === 0) {
      return false;
    }
    for (const handler of Array.from(bucket)) {
      handler(...args);
    }
    return true;
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}
