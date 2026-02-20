import { WebSocketServer, type WebSocket } from "ws";
import { DEFAULT_TICK_MS, TOPIC_PAYLOADS, deterministicRawBytes, deterministicTopicPayload } from "./mock-data.js";
import { decodeCbor, encodeCbor } from "./cbor.js";

type OpMessage = {
  op: string;
  topic?: string;
  service?: string;
  type?: string;
  action?: string;
  action_type?: string;
  msg?: Record<string, unknown>;
  args?: Record<string, unknown>;
  goal?: Record<string, unknown>;
  compression?: string;
  id?: string;
  session_id?: string;
};

type ActionState = {
  id: string;
  action: string;
  actionType: string;
  sessionId?: string;
  interval: NodeJS.Timeout;
  ws: WebSocket;
};

export type MockupRosbridgeServer = {
  port: number;
  url: string;
  stop: () => Promise<void>;
};

const activeActions = new Map<string, ActionState>();

function actionKey(action: string, sessionId?: string): string {
  return `${action}::${sessionId ?? "default"}`;
}

export function createMockupRosbridgeServer(port = 9090): Promise<MockupRosbridgeServer> {
  const wss = new WebSocketServer({ port });
  const subscriptions = new Map<WebSocket, Map<string, NodeJS.Timeout>>();
  const subscriptionCompression = new Map<WebSocket, Map<string, string | undefined>>();
  const advertised = new Map<string, string>();
  const connectionCodec = new Map<WebSocket, "json" | "cbor">();

  function send(ws: WebSocket, data: unknown): void {
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

  function startTopicStream(ws: WebSocket, topic: string): void {
    if (!(topic in TOPIC_PAYLOADS)) {
      // Only predefined status-like topics are periodic.
      // Other topics emit only when a publish request arrives.
      return;
    }

    const streams = subscriptions.get(ws) ?? new Map<string, NodeJS.Timeout>();
    if (streams.has(topic)) {
      return;
    }
    let tick = 0;
    const timer = setInterval(() => {
      tick += 1;
      const compression = subscriptionCompression.get(ws)?.get(topic);
      if (compression === "cbor-raw") {
        const bytes = deterministicRawBytes(topic, tick);
        send(ws, {
          op: "publish",
          topic,
          msg: {
            bytes: Array.from(bytes),
            secs: 1700000000 + tick,
            nsecs: tick * 1000
          }
        });
      } else {
        send(ws, { op: "publish", topic, msg: deterministicTopicPayload(topic, tick) });
      }
    }, DEFAULT_TICK_MS);
    streams.set(topic, timer);
    subscriptions.set(ws, streams);
  }

  function stopTopicStream(ws: WebSocket, topic: string): void {
    const streams = subscriptions.get(ws);
    if (!streams) {
      return;
    }
    const timer = streams.get(topic);
    if (timer) {
      clearInterval(timer);
      streams.delete(topic);
      subscriptionCompression.get(ws)?.delete(topic);
    }
  }

  function stopAllStreams(ws: WebSocket): void {
    const streams = subscriptions.get(ws);
    if (!streams) {
      return;
    }
    for (const timer of streams.values()) {
      clearInterval(timer);
    }
    subscriptions.delete(ws);
    subscriptionCompression.delete(ws);
  }

  function startNativeAction(ws: WebSocket, message: OpMessage): void {
    const id = message.id ?? "action-fixed-1";
    const action = message.action ?? "/demo/action";
    const actionType = message.action_type ?? "unknown/Action";
    const sessionId = message.session_id;

    if (actionType !== "demo/MoveArm") {
      send(ws, {
        op: "action_result",
        action,
        id,
        session_id: sessionId,
        error: "unknown_action_type"
      });
      return;
    }

    send(ws, {
      type: "request",
      action,
      action_type: actionType,
      id,
      session_id: sessionId,
      goal: message.goal ?? {}
    });

    let feedbackCount = 0;
    const interval = setInterval(() => {
      feedbackCount += 1;

      if (feedbackCount <= 2) {
        send(ws, {
          type: "feedback",
          action,
          action_type: actionType,
          id,
          session_id: sessionId,
          feedback: {
            progress: feedbackCount * 50,
            stage: `step-${feedbackCount}`
          }
        });
        return;
      }

      clearInterval(interval);
      activeActions.delete(actionKey(action, sessionId));
      send(ws, {
        type: "result",
        action,
        action_type: actionType,
        id,
        session_id: sessionId,
        status: 0,
        result: {
          success: true,
          output: "action-complete"
        }
      });
    }, DEFAULT_TICK_MS);

    activeActions.set(actionKey(action, sessionId), {
      id,
      action,
      actionType,
      sessionId,
      interval,
      ws
    });
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

    clearInterval(state.interval);
    activeActions.delete(key);

    send(ws, {
      op: "cancel_action_result",
      action,
      session_id: sessionId,
      result: true
    });

    send(ws, {
      type: "result",
      action,
      action_type: state.actionType,
      id: state.id,
      session_id: state.sessionId,
      status: 2,
      result: {
        success: false,
        canceled: true
      }
    });
  }

  wss.on("connection", (ws) => {
    subscriptions.set(ws, new Map<string, NodeJS.Timeout>());
    subscriptionCompression.set(ws, new Map<string, string | undefined>());
    connectionCodec.set(ws, "json");

    ws.on("message", (raw, isBinary) => {
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
        startTopicStream(ws, message.topic);
        return;
      }

      if (message.op === "unsubscribe" && message.topic) {
        stopTopicStream(ws, message.topic);
        return;
      }

      if (message.op === "advertise" && message.topic && message.type) {
        advertised.set(message.topic, message.type);
        console.log(`[mockup] advertised ${message.topic} (${message.type})`);
        return;
      }

      if (message.op === "publish" && message.topic) {
        console.log(`[mockup] publish ${message.topic}`, message.msg ?? {});
        const compression = subscriptionCompression.get(ws)?.get(message.topic);
        if (compression === "cbor-raw") {
          const bytes = deterministicRawBytes(message.topic, 999);
          send(ws, {
            op: "publish",
            topic: message.topic,
            msg: {
              bytes: Array.from(bytes),
              secs: 1700000999,
              nsecs: 999000
            }
          });
          return;
        }
        send(ws, {
          op: "publish",
          topic: message.topic,
          msg: message.msg ?? {}
        });
        return;
      }

      if (message.op === "call_service" && message.service) {
        if ((message.args as Record<string, unknown> | undefined)?.force_fail === true) {
          send(ws, {
            op: "service_response",
            service: message.service,
            result: false,
            id: message.id,
            error: "forced_failure"
          });
          return;
        }
        send(ws, {
          op: "service_response",
          service: message.service,
          result: true,
          id: message.id,
          values: {
            echoed_args: message.args ?? {},
            advertised_topics: Array.from(advertised.keys())
          }
        });
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
      stopAllStreams(ws);
      connectionCodec.delete(ws);
      for (const [key, state] of activeActions.entries()) {
        if (state.ws === ws) {
          clearInterval(state.interval);
          activeActions.delete(key);
        }
      }
    });
  });

  return new Promise((resolve) => {
    wss.on("listening", () => {
      resolve({
        port,
        url: `ws://127.0.0.1:${port}`,
        stop: async () => {
          for (const action of activeActions.values()) {
            clearInterval(action.interval);
          }
          activeActions.clear();

          for (const ws of wss.clients) {
            stopAllStreams(ws);
            ws.close();
          }

          await new Promise<void>((closeResolve, closeReject) => {
            wss.close((err) => {
              if (err) {
                closeReject(err);
                return;
              }
              closeResolve();
            });
          });
        }
      });
    });
  });
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
