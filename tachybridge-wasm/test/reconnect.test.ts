import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeClientCore } from "../src/client-core.js";
import type {
  BridgeReconnectScheduledEvent,
  BridgeReconnectOptions,
  JsonObject,
  WasmProtocol,
  WebSocketLike
} from "../src/types.js";

type SocketOutcome = "open" | "fail";

class ScriptedWebSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  private closed = false;

  constructor(private readonly outcome: SocketOutcome) {
    setTimeout(() => {
      if (this.closed) {
        return;
      }
      if (this.outcome === "open") {
        this.readyState = 1;
        this.onopen?.({});
        return;
      }
      this.onerror?.({});
      this.readyState = 3;
      this.closed = true;
      this.onclose?.({});
    }, 0);
  }

  send(_data: string | Uint8Array): void {
    // no-op for reconnect scheduling tests
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.readyState = 3;
    setTimeout(() => {
      this.onclose?.({});
    }, 0);
  }
}

function protocolStub(): Promise<WasmProtocol> {
  return Promise.resolve({
    build_subscribe: (_topic: string, _type: string, _compression?: string): JsonObject => ({ op: "subscribe" }),
    build_unsubscribe: (_topic: string): JsonObject => ({ op: "unsubscribe" }),
    build_advertise: (_topic: string, _type: string): JsonObject => ({ op: "advertise" }),
    build_publish: (_topic: string, _msg: JsonObject): JsonObject => ({ op: "publish" }),
    build_call_service: (_service: string, _type: string, _args: JsonObject, _id?: string): JsonObject => ({
      op: "call_service"
    }),
    build_send_action_goal: (
      _action: string,
      _actionType: string,
      _goal: JsonObject,
      _id?: string,
      _sessionId?: string
    ): JsonObject => ({ op: "send_action_goal" }),
    build_cancel_action_goal: (_action: string, _actionType: string, _sessionId?: string): JsonObject => ({
      op: "cancel_action_goal"
    })
  });
}

function makeClient(
  outcomes: SocketOutcome[],
  events: BridgeReconnectScheduledEvent[],
  reconnect: Partial<BridgeReconnectOptions> = {}
): {
  client: BridgeClientCore;
  sockets: ScriptedWebSocket[];
} {
  const sockets: ScriptedWebSocket[] = [];
  const client = new BridgeClientCore(protocolStub, {
    reconnect: {
      enabled: true,
      initialDelayMs: 100,
      maxDelayMs: 1000,
      multiplier: 2,
      jitterRatio: 0,
      ...reconnect
    },
    onReconnectScheduled: (event) => {
      events.push(event);
    },
    webSocketFactory: () => {
      const outcome = outcomes.shift() ?? "fail";
      const ws = new ScriptedWebSocket(outcome);
      sockets.push(ws);
      return ws;
    }
  });
  return { client, sockets };
}

describe("reconnect backoff", () => {
  async function advanceReconnectCycle(delayMs: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(delayMs + 1);
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("increases delay on consecutive failures", async () => {
    vi.useFakeTimers();
    const events: BridgeReconnectScheduledEvent[] = [];
    const { client } = makeClient(["fail", "fail", "fail"], events);

    void client.connect("ws://test").catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1);
    expect(events.map((e) => e.nextDelayMs)).toEqual([100]);

    await advanceReconnectCycle(100);
    expect(events.map((e) => e.nextDelayMs)).toEqual([100, 200]);

    await advanceReconnectCycle(200);
    expect(events.map((e) => e.nextDelayMs)).toEqual([100, 200, 400]);
    client.close();
  });

  it("does not exceed maxDelayMs", async () => {
    vi.useFakeTimers();
    const events: BridgeReconnectScheduledEvent[] = [];
    const { client } = makeClient(["fail", "fail", "fail", "fail"], events, { maxDelayMs: 250 });

    void client.connect("ws://test").catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1);
    await advanceReconnectCycle(100);
    await advanceReconnectCycle(200);
    await advanceReconnectCycle(250);

    expect(events.map((e) => e.nextDelayMs)).toEqual([100, 200, 250, 250]);
    client.close();
  });

  it("applies jitter within configured range", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValueOnce(1).mockReturnValueOnce(0);

    const events: BridgeReconnectScheduledEvent[] = [];
    const { client } = makeClient(["fail", "fail"], events, { jitterRatio: 0.2 });

    void client.connect("ws://test").catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1);
    await advanceReconnectCycle(120);

    expect(events[0].nextDelayMs).toBe(120);
    expect(events[1].nextDelayMs).toBe(160);
    client.close();
  });

  it("resets backoff state after successful reconnect", async () => {
    vi.useFakeTimers();
    const events: BridgeReconnectScheduledEvent[] = [];
    const { client, sockets } = makeClient(["fail", "fail", "open", "fail"], events);

    void client.connect("ws://test").catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1);
    await advanceReconnectCycle(100);
    await advanceReconnectCycle(200);
    await vi.advanceTimersByTimeAsync(1);

    sockets[2].close();
    await vi.advanceTimersByTimeAsync(1);

    expect(events.map((e) => e.nextDelayMs)).toEqual([100, 200, 100]);
    expect(events.map((e) => e.attempt)).toEqual([1, 2, 1]);
    client.close();
  });

  it("stops retries after manual close", async () => {
    vi.useFakeTimers();
    const events: BridgeReconnectScheduledEvent[] = [];
    const { client, sockets } = makeClient(["fail", "fail", "fail"], events);

    void client.connect("ws://test").catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets.length).toBe(1);

    client.close();
    await vi.advanceTimersByTimeAsync(1000);

    expect(sockets.length).toBe(1);
    expect(events.length).toBe(1);
  });

  it("keeps only one reconnect timer per failure cycle", async () => {
    vi.useFakeTimers();
    const events: BridgeReconnectScheduledEvent[] = [];
    const { client, sockets } = makeClient(["fail", "fail", "open"], events);

    void client.connect("ws://test").catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1);
    await advanceReconnectCycle(100);
    await advanceReconnectCycle(200);
    await vi.advanceTimersByTimeAsync(1);

    expect(sockets.length).toBe(3);
    expect(events.length).toBe(2);
    client.close();
  });

  it("ignores stale socket close events after a newer connection is active", async () => {
    vi.useFakeTimers();
    const events: BridgeReconnectScheduledEvent[] = [];
    const { client, sockets } = makeClient(["open", "open"], events);

    const firstConnect = client.connect("ws://test");
    await vi.advanceTimersByTimeAsync(1);
    await firstConnect;
    expect(sockets.length).toBe(1);

    const stale = sockets[0];
    const secondConnect = client.connect("ws://test");
    await vi.advanceTimersByTimeAsync(1);
    await secondConnect;
    expect(sockets.length).toBe(2);

    stale.close();
    await vi.advanceTimersByTimeAsync(1);

    expect(events.length).toBe(0);
    expect(sockets.length).toBe(2);
    client.close();
  });

  it("deduplicates concurrent connect calls to a single socket attempt", async () => {
    vi.useFakeTimers();
    const events: BridgeReconnectScheduledEvent[] = [];
    const { client, sockets } = makeClient(["open"], events);

    const p1 = client.connect("ws://test");
    const p2 = client.connect("ws://test");

    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([p1, p2]);

    expect(sockets.length).toBe(1);
    expect(events.length).toBe(0);
    client.close();
  });
});
