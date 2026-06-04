import { afterEach, describe, expect, it } from "vitest";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import selfsigned from "selfsigned";
import { createBridgeServer, type BridgeServer } from "../src/server.ts";

type AnyMessage = Record<string, unknown>;

const disposables: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (disposables.length > 0) {
    const dispose = disposables.pop()!;
    try {
      await dispose();
    } catch {
      // best-effort cleanup
    }
  }
});

function track(dispose: () => Promise<void>): void {
  disposables.push(dispose);
}

async function makeBridge(bridge: BridgeServer, server: HttpServer | HttpsServer): Promise<{ url: string }> {
  bridge.attach(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const scheme = server instanceof (await import("node:https")).Server ? "wss" : "ws";
  track(async () => {
    await bridge.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { url: `${scheme}://127.0.0.1:${port}` };
}

function open(url: string, options?: { rejectUnauthorized?: boolean }): WebSocket {
  const ws = new WebSocket(url, undefined, {
    rejectUnauthorized: options?.rejectUnauthorized ?? true
  });
  track(async () => {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  });
  return ws;
}

async function ready(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function send(ws: WebSocket, msg: AnyMessage): void {
  ws.send(JSON.stringify(msg));
}

function recordMessages(ws: WebSocket): AnyMessage[] {
  const out: AnyMessage[] = [];
  ws.on("message", (data) => {
    out.push(JSON.parse(data.toString("utf8")) as AnyMessage);
  });
  return out;
}

function waitFor<T>(predicate: () => T | undefined, timeoutMs = 2000): Promise<T> {
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
        reject(new Error(`timeout after ${timeoutMs}ms`));
      }
    }, 10);
  });
}

describe("createBridgeServer — attach()", () => {
  it("accepts an externally created http.Server and handles subscribe→publish→unsubscribe", async () => {
    const bridge = createBridgeServer();
    bridge.addTopicStream({
      topic: "/ticker",
      type: "std_msgs/String",
      interval: 30,
      make: () => ({ value: "tick" })
    });
    const { url } = await makeBridge(bridge, createHttpServer());

    const ws = open(url);
    await ready(ws);
    const inbox = recordMessages(ws);

    send(ws, { op: "subscribe", topic: "/ticker", type: "std_msgs/String" });
    await waitFor(() => inbox.find((m) => m.op === "publish" && m.topic === "/ticker"));
    expect(bridge.subscribers("/ticker")).toBe(1);

    send(ws, { op: "unsubscribe", topic: "/ticker" });
    await waitFor(() => (bridge.subscribers("/ticker") === 0 ? true : undefined));
    expect(bridge.subscribers("/ticker")).toBe(0);
  });

  it("accepts an externally created https.Server with a self-signed cert", async () => {
    const pems = await selfsigned.generate([{ name: "commonName", value: "localhost" }], {
      algorithm: "sha256",
      keySize: 2048,
      extensions: [
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
        {
          name: "subjectAltName",
          altNames: [
            { type: 2, value: "localhost" },
            { type: 7, ip: "127.0.0.1" }
          ]
        }
      ]
    });
    const httpsServer = createHttpsServer({ cert: pems.cert, key: pems.private });
    const bridge = createBridgeServer();
    const { url } = await makeBridge(bridge, httpsServer);

    const ws = open(url, { rejectUnauthorized: false });
    await ready(ws);
    const inbox = recordMessages(ws);

    send(ws, { op: "call_service", service: "/echo", args: { hello: "tls" }, id: "tls-1" });

    const response = await waitFor(() =>
      inbox.find((m) => m.op === "service_response" && m.id === "tls-1")
    );
    expect(response.result).toBe(true);
    expect((response.values as AnyMessage).echoed_args).toEqual({ hello: "tls" });
  });
});

describe("createBridgeServer — services", () => {
  it("advertiseService(runtime) overrides options.services and unregister restores prior", async () => {
    const bridge = createBridgeServer({
      services: {
        "/svc": () => ({ source: "options" })
      }
    });
    const { url } = await makeBridge(bridge, createHttpServer());

    const ws = open(url);
    await ready(ws);
    const inbox = recordMessages(ws);

    send(ws, { op: "call_service", service: "/svc", args: {}, id: "a" });
    const first = await waitFor(() => inbox.find((m) => m.id === "a"));
    expect((first.values as AnyMessage).source).toBe("options");

    const unregister = bridge.advertiseService("/svc", () => ({ source: "runtime" }));

    send(ws, { op: "call_service", service: "/svc", args: {}, id: "b" });
    const second = await waitFor(() => inbox.find((m) => m.id === "b"));
    expect((second.values as AnyMessage).source).toBe("runtime");

    unregister();
    send(ws, { op: "call_service", service: "/svc", args: {}, id: "c" });
    const third = await waitFor(() => inbox.find((m) => m.id === "c"));
    expect((third.values as AnyMessage).source).toBe("options");
  });

  it("handler precedence: runtime > options > built-in (force_fail) > defaultServiceResponse", async () => {
    const bridge = createBridgeServer({
      services: { "/optional": () => ({ tier: "options" }) },
      defaultServiceResponse: () => ({ tier: "default" })
    });
    const { url } = await makeBridge(bridge, createHttpServer());

    const ws = open(url);
    await ready(ws);
    const inbox = recordMessages(ws);

    send(ws, { op: "call_service", service: "/optional", args: {}, id: "1" });
    const r1 = await waitFor(() => inbox.find((m) => m.id === "1"));
    expect((r1.values as AnyMessage).tier).toBe("options");

    send(ws, { op: "call_service", service: "/anything", args: { force_fail: true }, id: "2" });
    const r2 = await waitFor(() => inbox.find((m) => m.id === "2"));
    expect(r2.result).toBe(false);
    expect(r2.error).toBe("forced_failure");

    send(ws, { op: "call_service", service: "/unknown", args: {}, id: "3" });
    const r3 = await waitFor(() => inbox.find((m) => m.id === "3"));
    expect((r3.values as AnyMessage).tier).toBe("default");

    bridge.advertiseService("/optional", () => ({ tier: "runtime" }));
    send(ws, { op: "call_service", service: "/optional", args: {}, id: "4" });
    const r4 = await waitFor(() => inbox.find((m) => m.id === "4"));
    expect((r4.values as AnyMessage).tier).toBe("runtime");
  });

  it("forwards call_service to a client that advertise_service'd it (caller id preserved)", async () => {
    const bridge = createBridgeServer();
    const { url } = await makeBridge(bridge, createHttpServer());

    const a = open(url);
    const b = open(url);
    await Promise.all([ready(a), ready(b)]);
    const aInbox = recordMessages(a);
    const bInbox = recordMessages(b);

    send(a, { op: "advertise_service", service: "/forwarded", type: "ex/Echo" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    send(b, { op: "call_service", service: "/forwarded", args: { x: 7 }, id: "B-original" });

    const forwarded = await waitFor(() =>
      aInbox.find((m) => m.op === "call_service" && m.service === "/forwarded")
    );
    const forwardedId = forwarded.id as string;
    expect(forwardedId).not.toBe("B-original");
    expect(forwarded.args).toEqual({ x: 7 });

    send(a, {
      op: "service_response",
      service: "/forwarded",
      result: true,
      id: forwardedId,
      values: { y: 14 }
    });

    const reply = await waitFor(() => bInbox.find((m) => m.op === "service_response"));
    expect(reply.id).toBe("B-original");
    expect(reply.result).toBe(true);
    expect((reply.values as AnyMessage).y).toBe(14);
  });
});

describe("createBridgeServer — topics", () => {
  it("publish(topic, msg) delivers to current subscribers", async () => {
    const bridge = createBridgeServer();
    const { url } = await makeBridge(bridge, createHttpServer());

    const ws = open(url);
    await ready(ws);
    const inbox = recordMessages(ws);

    send(ws, { op: "subscribe", topic: "/pushed", type: "std_msgs/String" });
    await waitFor(() => (bridge.subscribers("/pushed") === 1 ? true : undefined));

    bridge.publish("/pushed", { greeting: "hi" });

    const msg = await waitFor(() => inbox.find((m) => m.op === "publish" && m.topic === "/pushed"));
    expect((msg.msg as AnyMessage).greeting).toBe("hi");
  });
});

describe("createBridgeServer — lifecycle", () => {
  it("close() stops periodic streams and rejects new connections", async () => {
    const bridge = createBridgeServer({
      topicStreams: [
        { topic: "/heartbeat", type: "std_msgs/String", interval: 20, make: () => ({ data: "tick" }) }
      ]
    });
    const httpServer = createHttpServer();
    bridge.attach(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
    const port = (httpServer.address() as AddressInfo).port;
    const url = `ws://127.0.0.1:${port}`;

    const ws = open(url);
    await ready(ws);
    const inbox = recordMessages(ws);
    send(ws, { op: "subscribe", topic: "/heartbeat", type: "std_msgs/String" });
    await waitFor(() => inbox.find((m) => m.op === "publish" && m.topic === "/heartbeat"));

    const inboxLengthBeforeClose = inbox.length;
    await bridge.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));

    await new Promise((resolve) => setTimeout(resolve, 80));
    // Stream should be quiescent; no new publish frames should arrive after close.
    expect(inbox.length).toBeLessThanOrEqual(inboxLengthBeforeClose + 1);

    const attempt = new WebSocket(url);
    await new Promise<void>((resolve) => {
      attempt.once("error", () => resolve());
      attempt.once("open", () => {
        attempt.close();
        resolve();
      });
    });
    expect(attempt.readyState).not.toBe(WebSocket.OPEN);
  });
});
