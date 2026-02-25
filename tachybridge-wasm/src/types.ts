export type JsonObject = Record<string, unknown>;

export type PublishMessage = {
  op: "publish";
  topic: string;
  msg: JsonObject;
};

export type ServiceResponseMessage = {
  op: "service_response";
  service: string;
  result: boolean;
  values?: JsonObject;
  id?: string;
  error?: string;
};

export type CliResponseMessage = {
  op: "cli_response";
  id?: string;
  success?: boolean;
  return_code?: number;
  output?: string;
  error?: string;
};

export type BridgeIncomingMessage = PublishMessage | ServiceResponseMessage | CliResponseMessage | JsonObject;

export type CallServiceOptions = {
  id?: string;
  timeoutMs?: number;
};

export type ExecuteCliOptions = {
  id?: string;
  timeoutMs?: number;
};

export type SubscribeOptions = {
  compression?: "none" | "png" | "cbor" | "cbor-raw" | string;
};

export type SendActionGoalOptions = {
  action: string;
  actionType: string;
  goal: JsonObject;
  id?: string;
  sessionId?: string;
  timeoutMs?: number;
  onRequest?: (msg: JsonObject) => void;
  onFeedback?: (msg: JsonObject) => void;
  onResult?: (msg: JsonObject) => void;
};

export type CancelActionGoalOptions = {
  action: string;
  actionType: string;
  sessionId?: string;
  timeoutMs?: number;
};

export type ActionHandle = {
  id: string;
  sessionId?: string;
  completion: Promise<JsonObject>;
};

export type BridgeReconnectOptions = {
  enabled: boolean;
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  jitterRatio: number;
  shouldRetry?: (context: BridgeReconnectContext) => boolean;
};

export type BridgeReconnectReason =
  | "socket_close"
  | "socket_error"
  | "connect_error"
  | "open_socket_throw"
  | "manual_close";

export type BridgeReconnectContext = {
  reason: BridgeReconnectReason;
  error?: Error;
  attempt: number;
};

export type BridgeReconnectScheduledEvent = {
  attempt: number;
  nextDelayMs: number;
  reason: BridgeReconnectReason;
  error?: Error;
};

export type BridgeClientOptions = {
  timeoutMs?: number;
  reconnect?: Partial<BridgeReconnectOptions>;
  strictWasm?: boolean;
  codec?: BridgeCodecOption;
  webSocketFactory?: (url: string) => WebSocketLike;
  onSocketOpen?: (url: string) => void;
  onSocketClose?: () => void;
  onSocketError?: (error: Error) => void;
  onReconnectScheduled?: (event: BridgeReconnectScheduledEvent) => void;
};

export interface WebSocketLike {
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(data: string | Uint8Array): void;
  close(): void;
}

export type BridgeCodec = {
  name: "json" | "cbor" | "auto" | string;
  encode: (message: JsonObject) => string | Uint8Array;
  decode: (payload: unknown) => BridgeIncomingMessage;
};

export type BridgeCodecName = "json" | "cbor" | "auto";
export type BridgeCodecOption = BridgeCodec | BridgeCodecName;

export type WasmProtocol = {
  build_subscribe(topic: string, type: string, compression?: string): JsonObject;
  build_unsubscribe(topic: string): JsonObject;
  build_advertise(topic: string, type: string): JsonObject;
  build_publish(topic: string, msg: JsonObject): JsonObject;
  build_call_service(service: string, type: string, args: JsonObject, id?: string): JsonObject;
  build_send_action_goal(
    action: string,
    actionType: string,
    goal: JsonObject,
    id?: string,
    sessionId?: string
  ): JsonObject;
  build_cancel_action_goal(action: string, actionType: string, sessionId?: string): JsonObject;
};
