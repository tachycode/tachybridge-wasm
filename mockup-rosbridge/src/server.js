import { WebSocketServer } from "ws";
import { DEFAULT_TICK_MS, TOPIC_PAYLOADS, deterministicTopicPayload } from "./mock-data.js";
import { decodeCbor, encodeCbor } from "./cbor.js";
const activeActions = new Map();
function actionKey(action, sessionId) {
    return `${action}::${sessionId ?? "default"}`;
}
export function createMockupRosbridgeServer(port = 9090) {
    const wss = new WebSocketServer({ port });
    const subscriptions = new Map();
    const advertised = new Map();
    const connectionCodec = new Map();
    function send(ws, data) {
        const codec = connectionCodec.get(ws) ?? "json";
        if (codec === "cbor") {
            ws.send(encodeCbor(data));
            return;
        }
        ws.send(JSON.stringify(data));
    }
    function parseIncoming(raw, isBinary) {
        if (isBinary) {
            const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
            return decodeCbor(bytes);
        }
        if (typeof raw === "string") {
            return JSON.parse(raw);
        }
        if (raw instanceof Uint8Array) {
            return JSON.parse(Buffer.from(raw).toString("utf8"));
        }
        return JSON.parse(String(raw));
    }
    function startTopicStream(ws, topic) {
        if (!(topic in TOPIC_PAYLOADS)) {
            // Only predefined status-like topics are periodic.
            // Other topics emit only when a publish request arrives.
            return;
        }
        const streams = subscriptions.get(ws) ?? new Map();
        if (streams.has(topic)) {
            return;
        }
        let tick = 0;
        const timer = setInterval(() => {
            tick += 1;
            send(ws, { op: "publish", topic, msg: deterministicTopicPayload(topic, tick) });
        }, DEFAULT_TICK_MS);
        streams.set(topic, timer);
        subscriptions.set(ws, streams);
    }
    function stopTopicStream(ws, topic) {
        const streams = subscriptions.get(ws);
        if (!streams) {
            return;
        }
        const timer = streams.get(topic);
        if (timer) {
            clearInterval(timer);
            streams.delete(topic);
        }
    }
    function stopAllStreams(ws) {
        const streams = subscriptions.get(ws);
        if (!streams) {
            return;
        }
        for (const timer of streams.values()) {
            clearInterval(timer);
        }
        subscriptions.delete(ws);
    }
    function startNativeAction(ws, message) {
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
    function cancelNativeAction(ws, message) {
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
        subscriptions.set(ws, new Map());
        connectionCodec.set(ws, "json");
        ws.on("message", (raw, isBinary) => {
            let message;
            try {
                message = parseIncoming(raw, isBinary);
                if (isBinary) {
                    connectionCodec.set(ws, "cbor");
                }
            }
            catch {
                send(ws, { op: "error", error: "invalid_json" });
                return;
            }
            if (message.op === "subscribe" && message.topic) {
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
                send(ws, {
                    op: "publish",
                    topic: message.topic,
                    msg: message.msg ?? {}
                });
                return;
            }
            if (message.op === "call_service" && message.service) {
                if (message.args?.force_fail === true) {
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
                    await new Promise((closeResolve, closeReject) => {
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
