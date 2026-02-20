import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockupRosbridgeServer, type MockupRosbridgeServer } from "../../mockup-rosbridge/src/server.js";
import { Action, Ros, Service, Topic } from "../src/index.js";

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

function waitForEvent(target: Ros, event: "connection" | "close", timeoutMs = 5000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      target.off(event, onEvent);
      reject(new Error(`timeout waiting ${event}`));
    }, timeoutMs);
    const onEvent = (): void => {
      clearTimeout(timeout);
      target.off(event, onEvent);
      resolve();
    };
    target.on(event, onEvent);
  });
}

describe("tachybridge-roslib-compat", () => {
  let server: MockupRosbridgeServer;
  let ros: Ros;

  beforeAll(async () => {
    server = await createMockupRosbridgeServer(9290);
    ros = new Ros({ timeoutMs: 3000 });
    await ros.connect(server.url);
  });

  afterAll(async () => {
    ros?.close();
    await server?.stop();
  });

  it("topic subscribe/publish works with roslib-style API", async () => {
    const topic = new Topic<{ text: string }>({
      ros,
      name: "/demo/out",
      messageType: "std_msgs/String"
    });

    let received: { text: string } | undefined;
    topic.subscribe((msg) => {
      received = msg;
    });

    topic.publish({ text: "hello" });

    const recv = await waitFor(() => received);
    expect(recv.text).toBe("hello");
  });

  it("service call works with callback signature", async () => {
    const service = new Service<{ a: number; b: number }, { echoed_args: { a: number; b: number } }>({
      ros,
      name: "/demo/sum",
      serviceType: "example/AddTwoInts"
    });

    const result = await new Promise<{ echoed_args: { a: number; b: number } }>((resolve, reject) => {
      service.callService({ a: 1, b: 2 }, resolve, reject);
    });

    expect(result.echoed_args.a).toBe(1);
  });

  it("action goal/cancel works with roslib-style API", async () => {
    const action = new Action<{ x: number }, { progress: number }, { success: boolean }>({
      ros,
      name: "/arm/move",
      actionType: "demo/MoveArm"
    });

    const goalId = action.sendGoal(
      { x: 1 },
      () => {
        throw new Error("expected cancellation failure path");
      },
      () => {
        // no-op
      },
      () => {
        // expected due to status=2 on cancel
      }
    );

    action.cancelGoal(goalId);
    expect(goalId.includes("send_action_goal:/arm/move")).toBe(true);
  });

  it("can pass cbor codec via Ros options", async () => {
    const cborRos = new Ros({ timeoutMs: 3000, codec: "cbor" });
    await cborRos.connect(server.url);

    const topic = new Topic<{ text: string }>({
      ros: cborRos,
      name: "/demo/out",
      messageType: "std_msgs/String",
      compression: "cbor"
    });

    let received: { text: string } | undefined;
    topic.subscribe((msg) => {
      received = msg;
    });
    topic.publish({ text: "cbor" });

    const recv = await waitFor(() => received);
    expect(recv.text).toBe("cbor");
    cborRos.close();
  });

  it("topic compression cbor-raw is forwarded on subscribe", async () => {
    const topic = new Topic<{ bytes?: number[]; secs?: number }>({
      ros,
      name: "/mock/status",
      messageType: "std_msgs/String",
      compression: "cbor-raw"
    });

    let received: { bytes?: number[]; secs?: number } | undefined;
    topic.subscribe((msg) => {
      if (msg.bytes) {
        received = msg;
      }
    });

    const recv = await waitFor(() => received);
    expect(Array.isArray(recv.bytes)).toBe(true);
    expect(typeof recv.secs).toBe("number");
  });

  it("subscribe before connect is queued and activates after connect", async () => {
    const preconnectRos = new Ros({ timeoutMs: 3000 });
    const topic = new Topic<{ text: string }>({
      ros: preconnectRos,
      name: "/demo/out",
      messageType: "std_msgs/String"
    });

    let received: { text: string } | undefined;
    topic.subscribe((msg) => {
      received = msg;
    });

    await preconnectRos.connect(server.url);
    topic.publish({ text: "queued-before-connect" });

    const recv = await waitFor(() => received);
    expect(recv.text).toBe("queued-before-connect");
    preconnectRos.close();
  });

  it("subscribe then unsubscribe before connect does not receive after connect", async () => {
    const preconnectRos = new Ros({ timeoutMs: 3000 });
    const topic = new Topic<{ text: string }>({
      ros: preconnectRos,
      name: "/demo/out",
      messageType: "std_msgs/String"
    });

    let received = false;
    const callback = (): void => {
      received = true;
    };

    topic.subscribe(callback);
    topic.unsubscribe(callback);

    await preconnectRos.connect(server.url);
    topic.publish({ text: "should-not-receive" });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(received).toBe(false);
    preconnectRos.close();
  });

  it("unsubscribe stops receiving (active and pending-safe)", async () => {
    const topic = new Topic<{ text: string }>({
      ros,
      name: "/demo/out",
      messageType: "std_msgs/String"
    });

    let count = 0;
    const callback = (): void => {
      count += 1;
    };

    topic.subscribe(callback);
    topic.publish({ text: "first" });
    await waitFor(() => (count >= 1 ? count : undefined));

    topic.unsubscribe(callback);
    topic.publish({ text: "second" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(count).toBe(1);
  });

  it("disconnect/reconnect restores subscriptions", async () => {
    const reconnectPort = 9291;
    let reconnectServer = await createMockupRosbridgeServer(reconnectPort);
    const reconnectRos = new Ros({
      timeoutMs: 3000,
      reconnect: { enabled: true, initialDelayMs: 100, maxDelayMs: 500 }
    });
    await reconnectRos.connect(reconnectServer.url);

    const topic = new Topic<{ text: string }>({
      ros: reconnectRos,
      name: "/demo/out",
      messageType: "std_msgs/String"
    });

    let seenAfterReconnect = false;
    topic.subscribe((msg) => {
      if (msg.text === "after-reconnect") {
        seenAfterReconnect = true;
      }
    });

    topic.publish({ text: "before-reconnect" });
    const closed = waitForEvent(reconnectRos, "close");
    await reconnectServer.stop();
    await closed;
    reconnectServer = await createMockupRosbridgeServer(reconnectPort);
    await waitForEvent(reconnectRos, "connection");

    topic.publish({ text: "after-reconnect" });
    await waitFor(() => (seenAfterReconnect ? true : undefined));

    reconnectRos.close();
    await reconnectServer.stop();
  });

  it("duplicate subscribe/unsubscribe is idempotent", async () => {
    const topic = new Topic<{ text: string }>({
      ros,
      name: "/demo/out",
      messageType: "std_msgs/String"
    });

    let count = 0;
    const callback = (): void => {
      count += 1;
    };

    topic.subscribe(callback);
    topic.subscribe(callback);
    topic.publish({ text: "once" });
    await waitFor(() => (count >= 1 ? count : undefined));
    expect(count).toBe(1);

    topic.unsubscribe(callback);
    topic.unsubscribe(callback);
    topic.publish({ text: "none" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(count).toBe(1);
  });
});
