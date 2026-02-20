export const DEFAULT_TICK_MS = 200;

export const TOPIC_PAYLOADS: Record<string, unknown> = {
  "/mock/status": { seq: 1, state: "READY", stamp: 1700000000 }
};

export function deterministicTopicPayload(topic: string, tick: number): Record<string, unknown> {
  const base = TOPIC_PAYLOADS[topic] ?? { seq: 0, state: "UNKNOWN" };
  return {
    ...((base as Record<string, unknown>) ?? {}),
    topic,
    tick,
    stamp: 1700000000 + tick
  };
}

export function deterministicRawBytes(topic: string, tick: number): Uint8Array {
  const prefix = `${topic}:${tick}:`;
  const bytes = new TextEncoder().encode(prefix);
  const out = new Uint8Array(Math.max(8, bytes.length));
  out.set(bytes.slice(0, out.length));
  return out;
}
