import { describe, expect, it } from "vitest";
import { BridgeClient } from "../src/browser.js";
import { cborCodec } from "../src/codec.js";

class FakeWebSocket {
  readyState = 1;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  sent: Array<string | Uint8Array> = [];

  constructor(_url: string) {
    setTimeout(() => this.onopen?.({}), 0);
  }

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.onclose?.({});
  }
}

describe("browser smoke", () => {
  it("can connect with injected websocket factory", async () => {
    const sockets: FakeWebSocket[] = [];
    const client = new BridgeClient({
      strictWasm: false,
      webSocketFactory: (url) => {
        const ws = new FakeWebSocket(url);
        sockets.push(ws);
        return ws;
      }
    });

    await client.connect("ws://fake");
    await client.advertise("/demo", "std_msgs/String");
    const actionHandle = await client.sendActionGoal({
      action: "/arm/move",
      actionType: "demo/MoveArm",
      goal: { x: 1 },
      id: "browser-action-1"
    });

    expect(sockets[0]?.sent.length).toBeGreaterThan(0);
    expect(actionHandle.id).toBe("browser-action-1");
    const sentText = String(sockets[0]?.sent[1] ?? "");
    expect(sentText).toContain("send_action_goal");
    void actionHandle.completion.catch(() => {});
    client.close();
  });

  it("can send CBOR binary frame with cbor codec", async () => {
    const sockets: FakeWebSocket[] = [];
    const client = new BridgeClient({
      strictWasm: false,
      codec: cborCodec,
      webSocketFactory: (url) => {
        const ws = new FakeWebSocket(url);
        sockets.push(ws);
        return ws;
      }
    });

    await client.connect("ws://fake");
    await client.advertise("/demo", "std_msgs/String");
    expect(sockets[0]?.sent[0]).toBeInstanceOf(Uint8Array);
    client.close();
  });
});
