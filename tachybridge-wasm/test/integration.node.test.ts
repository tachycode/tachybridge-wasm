import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BridgeClient } from "../src/node.js";
import { createMockupRosbridgeServer, type MockupRosbridgeServer } from "../../mockup-rosbridge/src/server.ts";

function waitFor<T>(predicate: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const startedAt = Date.now();
  return new Promise<T>((resolve, reject) => {
    const timer = setInterval(() => {
      const value = predicate();
      if (value !== undefined) {
        clearInterval(timer);
        resolve(value);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(new Error("timeout"));
      }
    }, 25);
  });
}

describe.each([
  { label: "json codec", codec: "json" as const },
  { label: "cbor codec", codec: "cbor" as const }
])("tachybridge-wasm node integration with mockup-rosbridge ($label)", ({ codec }) => {
  let server: MockupRosbridgeServer;
  let client: BridgeClient;

  beforeAll(async () => {
    server = await createMockupRosbridgeServer(codec === "json" ? 9190 : 9191);
    client = new BridgeClient({ strictWasm: false, timeoutMs: 3000, codec });
    await client.connect(server.url);
  });

  afterAll(async () => {
    client?.close();
    await server?.stop();
  });

  it("topic subscribe/publish roundtrip", async () => {
    let statusMessage: Record<string, unknown> | undefined;
    let pubMessage: Record<string, unknown> | undefined;

    await client.subscribe("/mock/status", "std_msgs/String", (msg) => {
      statusMessage = msg;
    });

    await client.subscribe("/demo/out", "std_msgs/String", (msg) => {
      pubMessage = msg;
    });

    await client.advertise("/demo/out", "std_msgs/String");
    await client.publish("/demo/out", { text: "hello" });

    const status = await waitFor(() => statusMessage);
    expect(status.topic).toBe("/mock/status");

    const recv = await waitFor(() => pubMessage);
    expect(recv.text).toBe("hello");
  });

  it("subscribe with cbor-raw compression returns raw bytes envelope", async () => {
    let rawMessage: Record<string, unknown> | undefined;

    await client.unsubscribe("/mock/status");

    await client.subscribe(
      "/mock/status",
      "std_msgs/String",
      (msg) => {
        if (msg.bytes) {
          rawMessage = msg;
        }
      },
      { compression: "cbor-raw" }
    );

    const recv = await waitFor(() => rawMessage);
    expect(Array.isArray(recv.bytes)).toBe(true);
    expect(typeof recv.secs).toBe("number");
  });

  it("call_service success/failure", async () => {
    const success = await client.callService("/demo/sum", "example/AddTwoInts", { a: 1, b: 2 });
    expect((success.echoed_args as Record<string, unknown>).a).toBe(1);

    await expect(
      client.callService("/demo/fail", "example/Fail", { force_fail: true }, { id: `svc-fail-${codec}` })
    ).rejects.toThrow(/forced_failure/);
  });

  it("native action success flow", async () => {
    const feedbacks: Array<Record<string, unknown>> = [];

    const action = await client.sendActionGoal({
      action: "/arm/move",
      actionType: "demo/MoveArm",
      goal: { x: 1, y: 2 },
      id: `action-success-${codec}`,
      sessionId: `session-success-${codec}`,
      onFeedback: (msg) => {
        feedbacks.push(msg);
      }
    });

    const result = await action.completion;
    expect(result.success).toBe(true);
    expect(feedbacks.length).toBeGreaterThan(0);
  });

  it("native action cancel flow", async () => {
    const action = await client.sendActionGoal({
      action: "/arm/move",
      actionType: "demo/MoveArm",
      goal: { x: 3, y: 4 },
      id: `action-cancel-${codec}`,
      sessionId: `session-cancel-${codec}`
    });

    const cancelAck = await client.cancelActionGoal({
      action: "/arm/move",
      actionType: "demo/MoveArm",
      sessionId: `session-cancel-${codec}`
    });
    expect(cancelAck.result).toBe(true);

    await expect(action.completion).rejects.toThrow(/non-success status/);
  });

  it("native action unknown type error flow", async () => {
    const action = await client.sendActionGoal({
      action: "/arm/move",
      actionType: "demo/Unknown",
      goal: { x: 9 },
      id: `action-error-${codec}`,
      sessionId: `session-error-${codec}`
    });

    await expect(action.completion).rejects.toThrow(/unknown_action_type/);
  });
});
