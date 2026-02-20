export const DEFAULT_TICK_MS = 200;
export const TOPIC_PAYLOADS = {
    "/mock/status": { seq: 1, state: "READY", stamp: 1700000000 }
};
export function deterministicTopicPayload(topic, tick) {
    const base = TOPIC_PAYLOADS[topic] ?? { seq: 0, state: "UNKNOWN" };
    return {
        ...(base ?? {}),
        topic,
        tick,
        stamp: 1700000000 + tick
    };
}
