import type { JsonObject, WasmProtocol } from "./types.js";

export const fallbackProtocol: WasmProtocol = {
  build_subscribe(topic: string, type: string, compression?: string): JsonObject {
    return { op: "subscribe", topic, type, compression };
  },
  build_unsubscribe(topic: string): JsonObject {
    return { op: "unsubscribe", topic };
  },
  build_advertise(topic: string, type: string): JsonObject {
    return { op: "advertise", topic, type };
  },
  build_publish(topic: string, msg: JsonObject): JsonObject {
    return { op: "publish", topic, msg };
  },
  build_call_service(service: string, type: string, args: JsonObject, id?: string): JsonObject {
    return { op: "call_service", service, type, args, id };
  },
  build_send_action_goal(
    action: string,
    actionType: string,
    goal: JsonObject,
    id?: string,
    sessionId?: string
  ): JsonObject {
    return {
      op: "send_action_goal",
      action,
      action_type: actionType,
      goal,
      id,
      session_id: sessionId
    };
  },
  build_cancel_action_goal(action: string, actionType: string, sessionId?: string): JsonObject {
    return {
      op: "cancel_action_goal",
      action,
      action_type: actionType,
      session_id: sessionId
    };
  }
};
