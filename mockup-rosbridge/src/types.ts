import type { Server as HttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";

export type ServiceResponder = (
  args: Record<string, unknown>
) => Record<string, unknown> | Promise<Record<string, unknown>>;

export type TopicStream = {
  topic: string;
  type: string;
  interval: number;
  make: () => Record<string, unknown>;
  /**
   * Optional alternate factory used when a subscriber requests
   * `compression: "cbor-raw"`. Should return the bytes envelope shape
   * (e.g. `{ bytes, secs, nsecs }`). If omitted, `make()` is used as-is.
   */
  makeRawFrame?: () => Record<string, unknown>;
};

export type CliResponse = {
  output: string;
  return_code: number;
  success: boolean;
};

export type ActionContext = {
  id: string;
  sessionId?: string;
  action: string;
  actionType: string;
  goal: Record<string, unknown>;
  sendFeedback: (feedback: Record<string, unknown>) => void;
  sendResult: (result: Record<string, unknown>, status?: number) => void;
};

/**
 * Action handler. Invoked when a `send_action_goal` arrives with a matching
 * `action_type`. The returned function is called when the goal is canceled —
 * implementations should clear timers and emit a terminal result via
 * `ctx.sendResult({ success: false, canceled: true }, 2)`.
 */
export type ActionHandler = (ctx: ActionContext) => (() => void) | void;

export interface BridgeServerOptions {
  services?: Record<string, ServiceResponder>;
  topicStreams?: TopicStream[];
  actions?: Record<string, ActionHandler>;
  cliExecutor?: (command: string) => Promise<CliResponse> | CliResponse;
  defaultServiceResponse?: ServiceResponder;
}

export interface BridgeServer {
  attach(server: HttpServer | HttpsServer): void;
  listen(port: number, host?: string): Promise<void>;
  close(): Promise<void>;
  advertiseService(name: string, handler: ServiceResponder): () => void;
  addTopicStream(stream: TopicStream): () => void;
  publish(topic: string, msg: Record<string, unknown>): void;
  subscribers(topic: string): number;
}
