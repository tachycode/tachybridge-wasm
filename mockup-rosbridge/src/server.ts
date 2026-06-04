import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";
import { WebSocketServer, type WebSocket } from "ws";
import { DEFAULT_TICK_MS, TOPIC_PAYLOADS, deterministicRawBytes, deterministicTopicPayload } from "./mock-data.js";
import { decodeCbor, encodeCbor } from "./cbor.js";
import type {
  ActionContext,
  ActionHandler,
  BridgeServer,
  BridgeServerOptions,
  CliResponse,
  ServiceResponder,
  TopicStream
} from "./types.js";

export type {
  ActionContext,
  ActionHandler,
  BridgeServer,
  BridgeServerOptions,
  CliResponse,
  ServiceResponder,
  TopicStream
} from "./types.js";

export type MockupRosbridgeServer = {
  port: number;
  url: string;
  stop: () => Promise<void>;
};

type OpMessage = {
  op: string;
  topic?: string;
  service?: string;
  type?: string;
  command?: string;
  action?: string;
  action_type?: string;
  msg?: Record<string, unknown>;
  args?: Record<string, unknown>;
  goal?: Record<string, unknown>;
  values?: Record<string, unknown>;
  result?: boolean | Record<string, unknown>;
  status?: number;
  feedback?: Record<string, unknown>;
  error?: string;
  compression?: string;
  id?: string;
  session_id?: string;
};

type ActionState = {
  id: string;
  action: string;
  actionType: string;
  sessionId?: string;
  cleanup: () => void;
  ws: WebSocket;
};

type PendingForward = {
  caller: WebSocket;
  callerId?: string;
  service: string;
};

function actionKey(action: string, sessionId?: string): string {
  return `${action}::${sessionId ?? "default"}`;
}

export function createBridgeServer(options: BridgeServerOptions = {}): BridgeServer {
  const wss = new WebSocketServer({ noServer: true });
  const attachedServers = new Map<HttpServer | HttpsServer, (req: unknown, socket: unknown, head: Buffer) => void>();
  const ownedServers: HttpServer[] = [];

  const subscribers = new Map<string, Set<WebSocket>>();
  const subscriptionCompression = new Map<WebSocket, Map<string, string | undefined>>();
  const advertised = new Map<string, string>();
  const connectionCodec = new Map<WebSocket, "json" | "cbor">();
  const activeActions = new Map<string, ActionState>();

  const userServices = new Map<string, ServiceResponder>(Object.entries(options.services ?? {}));
  const advertisedServiceHandlers = new Map<string, ServiceResponder>();
  const advertisedServiceForwarders = new Map<string, WebSocket>();
  const pendingForwards = new Map<string, PendingForward>();
  let forwardCounter = 0;

  const userActions = new Map<string, ActionHandler>(Object.entries(options.actions ?? {}));

  const topicStreams = new Map<string, TopicStream>();
  const streamTimers = new Map<string, NodeJS.Timeout>();
  const streamTicks = new Map<string, number>();

  let closed = false;

  function send(ws: WebSocket, data: unknown): void {
    if (ws.readyState !== ws.OPEN) {
      return;
    }
    const codec = connectionCodec.get(ws) ?? "json";
    if (codec === "cbor") {
      ws.send(encodeCbor(data));
      return;
    }
    ws.send(JSON.stringify(data));
  }

  function parseIncoming(raw: unknown, isBinary: boolean): OpMessage {
    if (isBinary) {
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
      return decodeCbor(bytes) as OpMessage;
    }
    if (typeof raw === "string") {
      return JSON.parse(raw) as OpMessage;
    }
    if (raw instanceof Uint8Array) {
      return JSON.parse(Buffer.from(raw).toString("utf8")) as OpMessage;
    }
    return JSON.parse(String(raw)) as OpMessage;
  }

  function addSubscriber(topic: string, ws: WebSocket): void {
    let set = subscribers.get(topic);
    if (!set) {
      set = new Set();
      subscribers.set(topic, set);
    }
    set.add(ws);
    ensureStreamRunning(topic);
  }

  function removeSubscriber(topic: string, ws: WebSocket): void {
    const set = subscribers.get(topic);
    if (!set) {
      return;
    }
    set.delete(ws);
    if (set.size === 0) {
      subscribers.delete(topic);
    }
    subscriptionCompression.get(ws)?.delete(topic);
  }

  function ensureStreamRunning(topic: string): void {
    const stream = topicStreams.get(topic);
    if (!stream) {
      return;
    }
    if (streamTimers.has(topic)) {
      return;
    }
    streamTicks.set(topic, streamTicks.get(topic) ?? 0);
    const timer = setInterval(() => {
      const set = subscribers.get(topic);
      if (!set || set.size === 0) {
        return;
      }
      const tick = (streamTicks.get(topic) ?? 0) + 1;
      streamTicks.set(topic, tick);
      const payload = stream.make();
      const rawPayload = stream.makeRawFrame?.();
      for (const ws of set) {
        const compression = subscriptionCompression.get(ws)?.get(topic);
        if (compression === "cbor-raw" && rawPayload) {
          send(ws, { op: "publish", topic, msg: rawPayload });
        } else {
          send(ws, { op: "publish", topic, msg: payload });
        }
      }
    }, stream.interval);
    streamTimers.set(topic, timer);
  }

  function stopStream(topic: string): void {
    const timer = streamTimers.get(topic);
    if (timer) {
      clearInterval(timer);
      streamTimers.delete(topic);
    }
  }

  function registerTopicStream(stream: TopicStream): () => void {
    const prev = topicStreams.get(stream.topic);
    topicStreams.set(stream.topic, stream);
    stopStream(stream.topic);
    if (subscribers.get(stream.topic)?.size) {
      ensureStreamRunning(stream.topic);
    }
    return () => {
      if (topicStreams.get(stream.topic) === stream) {
        topicStreams.delete(stream.topic);
        stopStream(stream.topic);
        if (prev) {
          topicStreams.set(prev.topic, prev);
          if (subscribers.get(prev.topic)?.size) {
            ensureStreamRunning(prev.topic);
          }
        }
      }
    };
  }

  function publishToSubscribers(topic: string, msg: Record<string, unknown>, rawFallbackTick = 999): void {
    const set = subscribers.get(topic);
    if (!set || set.size === 0) {
      return;
    }
    for (const ws of set) {
      const compression = subscriptionCompression.get(ws)?.get(topic);
      if (compression === "cbor-raw") {
        const stream = topicStreams.get(topic);
        if (stream?.makeRawFrame) {
          send(ws, { op: "publish", topic, msg: stream.makeRawFrame() });
        } else {
          const bytes = deterministicRawBytes(topic, rawFallbackTick);
          send(ws, {
            op: "publish",
            topic,
            msg: { bytes: Array.from(bytes), secs: 1700000000 + rawFallbackTick, nsecs: rawFallbackTick * 1000 }
          });
        }
        continue;
      }
      send(ws, { op: "publish", topic, msg });
    }
  }

  function defaultBuiltinServiceResponse(
    name: string,
    args: Record<string, unknown> | undefined
  ): { result: boolean; values?: Record<string, unknown>; error?: string } {
    if (args && args.force_fail === true) {
      return { result: false, error: "forced_failure" };
    }
    return {
      result: true,
      values: {
        echoed_args: args ?? {},
        advertised_topics: Array.from(advertised.keys())
      }
    };
  }

  async function handleServiceCall(ws: WebSocket, message: OpMessage): Promise<void> {
    const name = message.service!;
    const args = (message.args ?? {}) as Record<string, unknown>;

    // 1. Runtime advertise_service forwarding (from a peer client) wins first.
    const forwarder = advertisedServiceForwarders.get(name);
    if (forwarder && forwarder !== ws && forwarder.readyState === forwarder.OPEN) {
      forwardCounter += 1;
      const forwardedId = `forward-${forwardCounter}-${Date.now()}`;
      pendingForwards.set(forwardedId, { caller: ws, callerId: message.id, service: name });
      send(forwarder, {
        op: "call_service",
        service: name,
        args,
        id: forwardedId
      });
      return;
    }

    // 2. Runtime advertiseService API.
    const runtimeHandler = advertisedServiceHandlers.get(name);
    if (runtimeHandler) {
      await invokeServiceHandler(runtimeHandler, name, args, ws, message.id);
      return;
    }

    // 3. options.services.
    const userHandler = userServices.get(name);
    if (userHandler) {
      await invokeServiceHandler(userHandler, name, args, ws, message.id);
      return;
    }

    // 4. Deterministic built-in: handles `force_fail` flag explicitly.
    if (args.force_fail === true) {
      send(ws, { op: "service_response", service: name, result: false, id: message.id, error: "forced_failure" });
      return;
    }

    // 5. options.defaultServiceResponse, if provided.
    if (options.defaultServiceResponse) {
      await invokeServiceHandler(options.defaultServiceResponse, name, args, ws, message.id);
      return;
    }

    // 6. Deterministic built-in echo (final catch-all).
    const builtin = defaultBuiltinServiceResponse(name, args);
    send(ws, {
      op: "service_response",
      service: name,
      result: builtin.result,
      id: message.id,
      ...(builtin.error ? { error: builtin.error } : {}),
      ...(builtin.values ? { values: builtin.values } : {})
    });
  }

  async function invokeServiceHandler(
    handler: ServiceResponder,
    name: string,
    args: Record<string, unknown>,
    ws: WebSocket,
    id?: string
  ): Promise<void> {
    try {
      const values = await handler(args);
      send(ws, { op: "service_response", service: name, result: true, id, values });
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : String(error);
      send(ws, { op: "service_response", service: name, result: false, id, error: errMessage });
    }
  }

  function handleServiceResponse(ws: WebSocket, message: OpMessage): void {
    if (!message.id) {
      return;
    }
    const pending = pendingForwards.get(message.id);
    if (!pending) {
      return;
    }
    pendingForwards.delete(message.id);
    if (pending.caller.readyState !== pending.caller.OPEN) {
      return;
    }
    const response: Record<string, unknown> = {
      op: "service_response",
      service: pending.service,
      result: message.result ?? false,
      id: pending.callerId
    };
    if (message.values !== undefined) {
      response.values = message.values;
    }
    if (message.error !== undefined) {
      response.error = message.error;
    }
    send(pending.caller, response);
  }

  function unregisterAdvertisedService(name: string, ws: WebSocket): void {
    if (advertisedServiceForwarders.get(name) === ws) {
      advertisedServiceForwarders.delete(name);
    }
  }

  function builtinDemoMoveArmHandler(ctx: ActionContext): () => void {
    let feedbackCount = 0;
    const interval = setInterval(() => {
      feedbackCount += 1;
      if (feedbackCount <= 2) {
        ctx.sendFeedback({ progress: feedbackCount * 50, stage: `step-${feedbackCount}` });
        return;
      }
      clearInterval(interval);
      ctx.sendResult({ success: true, output: "action-complete" }, 0);
    }, DEFAULT_TICK_MS);

    return () => {
      clearInterval(interval);
      ctx.sendResult({ success: false, canceled: true }, 2);
    };
  }

  function startNativeAction(ws: WebSocket, message: OpMessage): void {
    const id = message.id ?? "action-fixed-1";
    const action = message.action ?? "/demo/action";
    const actionType = message.action_type ?? "unknown/Action";
    const sessionId = message.session_id;
    const goal = message.goal ?? {};

    const handler =
      userActions.get(actionType) ?? (actionType === "demo/MoveArm" ? builtinDemoMoveArmHandler : undefined);

    if (!handler) {
      send(ws, { op: "action_result", action, id, session_id: sessionId, error: "unknown_action_type" });
      return;
    }

    send(ws, {
      type: "request",
      action,
      action_type: actionType,
      id,
      session_id: sessionId,
      goal
    });

    const key = actionKey(action, sessionId);

    const ctx: ActionContext = {
      id,
      sessionId,
      action,
      actionType,
      goal,
      sendFeedback: (feedback) => {
        send(ws, { type: "feedback", action, action_type: actionType, id, session_id: sessionId, feedback });
      },
      sendResult: (result, status = 0) => {
        send(ws, { type: "result", action, action_type: actionType, id, session_id: sessionId, status, result });
        activeActions.delete(key);
      }
    };

    const cleanup = handler(ctx) ?? (() => undefined);
    activeActions.set(key, { id, action, actionType, sessionId, cleanup, ws });
  }

  function cancelNativeAction(ws: WebSocket, message: OpMessage): void {
    const action = message.action ?? "/demo/action";
    const sessionId = message.session_id;
    const key = actionKey(action, sessionId);
    const state = activeActions.get(key);

    if (!state) {
      send(ws, {
        op: "cancel_action_result",
        action,
        session_id: sessionId,
        result: false,
        error: "action_not_found"
      });
      return;
    }

    send(ws, { op: "cancel_action_result", action, session_id: sessionId, result: true });
    state.cleanup();
    activeActions.delete(key);
  }

  async function handleExecuteCli(ws: WebSocket, message: OpMessage): Promise<void> {
    const command = (message.command ?? "").trim();
    if (!command) {
      send(ws, { op: "cli_response", success: false, return_code: 2, output: "" });
      return;
    }

    if (options.cliExecutor) {
      try {
        const result = await options.cliExecutor(command);
        send(ws, { op: "cli_response", ...result });
      } catch (error) {
        const errMessage = error instanceof Error ? error.message : String(error);
        send(ws, { op: "cli_response", success: false, return_code: 1, output: errMessage });
      }
      return;
    }

    if (command === "ros2 node list") {
      send(ws, {
        op: "cli_response",
        output:
          "/conversion_node\n/cpp_rosbridge_server\n/curation_node\n/dataset_manager_node\n/habilis_communicator\n/launch_ros_11867\n/play_lerobot\n",
        return_code: 0,
        success: true
      });
      return;
    }

    if (command.includes("fail")) {
      send(ws, { op: "cli_response", output: "", return_code: 1, success: false });
      return;
    }

    send(ws, {
      op: "cli_response",
      output: `[mockup-cli] executed: ${command}\n`,
      return_code: 0,
      success: true
    });
  }

  wss.on("connection", (ws: WebSocket) => {
    subscriptionCompression.set(ws, new Map<string, string | undefined>());
    connectionCodec.set(ws, "json");

    ws.on("message", async (raw, isBinary) => {
      let message: OpMessage;
      try {
        message = parseIncoming(raw, isBinary);
        if (isBinary) {
          connectionCodec.set(ws, "cbor");
        }
      } catch {
        send(ws, { op: "error", error: "invalid_json" });
        return;
      }

      if (message.op === "subscribe" && message.topic) {
        subscriptionCompression.get(ws)?.set(message.topic, message.compression);
        addSubscriber(message.topic, ws);
        return;
      }

      if (message.op === "unsubscribe" && message.topic) {
        removeSubscriber(message.topic, ws);
        return;
      }

      if (message.op === "advertise" && message.topic && message.type) {
        advertised.set(message.topic, message.type);
        return;
      }

      if (message.op === "publish" && message.topic) {
        publishToSubscribers(message.topic, (message.msg ?? {}) as Record<string, unknown>);
        return;
      }

      if (message.op === "advertise_service" && message.service) {
        advertisedServiceForwarders.set(message.service, ws);
        return;
      }

      if (message.op === "unadvertise_service" && message.service) {
        unregisterAdvertisedService(message.service, ws);
        return;
      }

      if (message.op === "service_response") {
        handleServiceResponse(ws, message);
        return;
      }

      if (message.op === "call_service" && message.service) {
        await handleServiceCall(ws, message);
        return;
      }

      if (message.op === "execute_cli") {
        await handleExecuteCli(ws, message);
        return;
      }

      if (message.op === "send_action_goal") {
        startNativeAction(ws, message);
        return;
      }

      if (message.op === "cancel_action_goal") {
        cancelNativeAction(ws, message);
        return;
      }

      send(ws, { op: "error", error: "unsupported_operation", received: message });
    });

    ws.on("close", () => {
      for (const topic of Array.from(subscribers.keys())) {
        removeSubscriber(topic, ws);
      }
      subscriptionCompression.delete(ws);
      connectionCodec.delete(ws);

      for (const [name, advertiser] of Array.from(advertisedServiceForwarders.entries())) {
        if (advertiser === ws) {
          advertisedServiceForwarders.delete(name);
        }
      }
      for (const [id, pending] of Array.from(pendingForwards.entries())) {
        if (pending.caller === ws) {
          pendingForwards.delete(id);
        }
      }

      for (const [key, state] of Array.from(activeActions.entries())) {
        if (state.ws === ws) {
          try {
            state.cleanup();
          } catch {
            // swallow — handler cleanup must never throw
          }
          activeActions.delete(key);
        }
      }
    });
  });

  // Pre-register topic streams from options.
  for (const stream of options.topicStreams ?? []) {
    topicStreams.set(stream.topic, stream);
  }

  const bridge: BridgeServer = {
    attach(server) {
      if (closed) {
        throw new Error("bridge server is closed");
      }
      if (attachedServers.has(server)) {
        return;
      }
      const upgradeHandler = (request: unknown, socket: unknown, head: Buffer): void => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wss.handleUpgrade(request as any, socket as any, head, (ws) => {
          wss.emit("connection", ws, request);
        });
      };
      server.on("upgrade", upgradeHandler);
      attachedServers.set(server, upgradeHandler);
    },

    async listen(port, host) {
      if (closed) {
        throw new Error("bridge server is closed");
      }
      const server = createHttpServer();
      bridge.attach(server);
      ownedServers.push(server);
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => {
          server.off("listening", onListening);
          reject(err);
        };
        const onListening = (): void => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host ?? "0.0.0.0");
      });
    },

    async close() {
      if (closed) {
        return;
      }
      closed = true;

      for (const timer of streamTimers.values()) {
        clearInterval(timer);
      }
      streamTimers.clear();

      for (const state of activeActions.values()) {
        try {
          state.cleanup();
        } catch {
          // ignore
        }
      }
      activeActions.clear();
      pendingForwards.clear();

      for (const ws of wss.clients) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }

      for (const [server, handler] of attachedServers.entries()) {
        server.off("upgrade", handler);
      }
      attachedServers.clear();

      await new Promise<void>((resolve, reject) => {
        wss.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });

      await Promise.all(
        ownedServers.map(
          (server) =>
            new Promise<void>((resolve, reject) => {
              server.close((err) => {
                if (err) {
                  reject(err);
                  return;
                }
                resolve();
              });
            })
        )
      );
      ownedServers.length = 0;
    },

    advertiseService(name, handler) {
      if (closed) {
        throw new Error("bridge server is closed");
      }
      const prev = advertisedServiceHandlers.get(name);
      advertisedServiceHandlers.set(name, handler);
      return () => {
        if (advertisedServiceHandlers.get(name) === handler) {
          if (prev) {
            advertisedServiceHandlers.set(name, prev);
          } else {
            advertisedServiceHandlers.delete(name);
          }
        }
      };
    },

    addTopicStream(stream) {
      if (closed) {
        throw new Error("bridge server is closed");
      }
      return registerTopicStream(stream);
    },

    publish(topic, msg) {
      publishToSubscribers(topic, msg);
    },

    subscribers(topic) {
      return subscribers.get(topic)?.size ?? 0;
    }
  };

  return bridge;
}

function defaultMockTopicStreams(): TopicStream[] {
  const streams: TopicStream[] = [];
  for (const topic of Object.keys(TOPIC_PAYLOADS)) {
    let tick = 0;
    streams.push({
      topic,
      type: "std_msgs/String",
      interval: DEFAULT_TICK_MS,
      make: () => {
        tick += 1;
        return deterministicTopicPayload(topic, tick);
      },
      makeRawFrame: () => {
        const bytes = deterministicRawBytes(topic, tick || 1);
        return {
          bytes: Array.from(bytes),
          secs: 1700000000 + (tick || 1),
          nsecs: (tick || 1) * 1000
        };
      }
    });
  }
  return streams;
}

export async function createMockupRosbridgeServer(port = 9090): Promise<MockupRosbridgeServer> {
  const bridge = createBridgeServer({
    topicStreams: defaultMockTopicStreams()
  });
  await bridge.listen(port, "0.0.0.0");
  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    stop: () => bridge.close()
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = process.env.MOCKUP_ROSBRIDGE_PORT ? Number(process.env.MOCKUP_ROSBRIDGE_PORT) : 9090;
  createMockupRosbridgeServer(port)
    .then((server) => {
      console.log(`[mockup] listening on ${server.url}`);
    })
    .catch((error) => {
      console.error("[mockup] failed to start", error);
      process.exitCode = 1;
    });
}
