import { resolveCodec } from "./codec.js";
import { fallbackProtocol } from "./protocol-fallback.js";
import type {
  ActionHandle,
  BridgeClientOptions,
  BridgeCodec,
  BridgeIncomingMessage,
  BridgeReconnectContext,
  BridgeReconnectReason,
  BridgeReconnectOptions,
  CallServiceOptions,
  CancelActionGoalOptions,
  JsonObject,
  SendActionGoalOptions,
  SubscribeOptions,
  WasmProtocol,
  WebSocketLike
} from "./types.js";

type PendingCall = {
  service: string;
  resolve: (value: JsonObject) => void;
  reject: (error: Error) => void;
  timeout?: NodeJS.Timeout;
};

type PendingAction = {
  id: string;
  sessionId?: string;
  action: string;
  actionType: string;
  resolve: (value: JsonObject) => void;
  reject: (error: Error) => void;
  timeout?: NodeJS.Timeout;
  onRequest?: (msg: JsonObject) => void;
  onFeedback?: (msg: JsonObject) => void;
  onResult?: (msg: JsonObject) => void;
};

type PendingActionCancel = {
  key: string;
  resolve: (value: JsonObject) => void;
  reject: (error: Error) => void;
  timeout?: NodeJS.Timeout;
};

type SubscriptionInfo = {
  type: string;
  compression?: string;
  callbacks: Set<(msg: JsonObject) => void>;
};

const OPEN = 1;
function randomId(prefix: string): string {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

function asRecord(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as JsonObject;
}

function hasValidOpEnvelope(value: unknown): value is JsonObject & { op: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const op = (value as { op?: unknown }).op;
  return typeof op === "string" && op.length > 0;
}

export class BridgeClientCore {
  protected readonly options: Pick<BridgeClientOptions, "timeoutMs"> & Required<Pick<BridgeClientOptions, "strictWasm">> & {
    reconnect: BridgeReconnectOptions;
    webSocketFactory?: (url: string) => WebSocketLike;
    onSocketOpen?: (url: string) => void;
    onSocketClose?: () => void;
    onSocketError?: (error: Error) => void;
    onReconnectScheduled?: BridgeClientOptions["onReconnectScheduled"];
  };

  private readonly protocolPromise: Promise<WasmProtocol>;
  private readonly codec: BridgeCodec;

  private ws: WebSocketLike | undefined;
  private socketGeneration = 0;
  private activeSocketGeneration = 0;
  private wsUrl: string | undefined;
  private manualClose = false;
  private connectInFlight: Promise<void> | undefined;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private pendingCalls = new Map<string, PendingCall>();
  private pendingActions = new Map<string, PendingAction>();
  private actionIdBySession = new Map<string, string>();
  private pendingActionCancels = new Map<string, PendingActionCancel>();
  private subscriptions = new Map<string, SubscriptionInfo>();
  private advertisedTopics = new Map<string, string>();

  constructor(protocolLoader: () => Promise<WasmProtocol>, options: BridgeClientOptions = {}) {
    this.options = {
      timeoutMs: options.timeoutMs,
      strictWasm: options.strictWasm ?? false,
      webSocketFactory: options.webSocketFactory,
      onSocketOpen: options.onSocketOpen,
      onSocketClose: options.onSocketClose,
      onSocketError: options.onSocketError,
      onReconnectScheduled: options.onReconnectScheduled,
      reconnect: {
        enabled: options.reconnect?.enabled ?? true,
        initialDelayMs: options.reconnect?.initialDelayMs ?? 500,
        maxDelayMs: options.reconnect?.maxDelayMs ?? 30000,
        multiplier: options.reconnect?.multiplier ?? 2,
        jitterRatio: options.reconnect?.jitterRatio ?? 0.2,
        shouldRetry: options.reconnect?.shouldRetry
      }
    };
    this.codec = resolveCodec(options.codec);

    this.protocolPromise = protocolLoader().catch((error: unknown) => {
      if (this.options.strictWasm) {
        throw error instanceof Error ? error : new Error(String(error));
      }
      return fallbackProtocol;
    });
  }

  protected setWebSocketFactory(factory: (url: string) => WebSocketLike): void {
    this.options.webSocketFactory = factory;
  }

  async connect(url: string): Promise<void> {
    if (this.connectInFlight) {
      return this.connectInFlight;
    }

    this.manualClose = false;
    this.wsUrl = url;
    this.clearReconnectTimer();
    this.ws?.close();
    const opening = this.openSocket(url);
    this.connectInFlight = opening;
    try {
      await opening;
    } finally {
      if (this.connectInFlight === opening) {
        this.connectInFlight = undefined;
      }
    }
  }

  async subscribe(
    topic: string,
    type: string,
    callback: (msg: JsonObject) => void,
    options: SubscribeOptions = {}
  ): Promise<void> {
    const existing = this.subscriptions.get(topic);
    if (existing) {
      existing.callbacks.add(callback);
      const nextCompression = options.compression;
      const shouldResubscribe = existing.type !== type || existing.compression !== nextCompression;
      if (!shouldResubscribe) {
        return;
      }

      existing.type = type;
      existing.compression = nextCompression;
      await this.sendWithProtocol((protocol) => protocol.build_subscribe(topic, type, nextCompression));
      return;
    }

    const entry: SubscriptionInfo = {
      type,
      compression: options.compression,
      callbacks: new Set([callback])
    };
    this.subscriptions.set(topic, entry);

    await this.sendWithProtocol((protocol) => protocol.build_subscribe(topic, type, options.compression));
  }

  async unsubscribe(topic: string): Promise<void> {
    this.subscriptions.delete(topic);
    await this.sendWithProtocol((protocol) => protocol.build_unsubscribe(topic));
  }

  async advertise(topic: string, type: string): Promise<void> {
    this.advertisedTopics.set(topic, type);
    await this.sendWithProtocol((protocol) => protocol.build_advertise(topic, type));
  }

  async publish(topic: string, msg: JsonObject): Promise<void> {
    await this.sendWithProtocol((protocol) => protocol.build_publish(topic, msg));
  }

  async callService(
    service: string,
    type: string,
    args: JsonObject,
    options: CallServiceOptions = {}
  ): Promise<JsonObject> {
    const id = options.id ?? randomId("svc");
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs;

    return new Promise<JsonObject>((resolve, reject) => {
      const timeout =
        typeof timeoutMs === "number" && timeoutMs > 0
          ? setTimeout(() => {
              this.pendingCalls.delete(id);
              reject(new Error(`Service call timeout for ${service} (${id})`));
            }, timeoutMs)
          : undefined;

      this.pendingCalls.set(id, { service, resolve, reject, timeout });

      this.sendWithProtocol((protocol) => protocol.build_call_service(service, type, args, id)).catch((error: unknown) => {
        if (timeout) {
          clearTimeout(timeout);
        }
        this.pendingCalls.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async sendActionGoal(options: SendActionGoalOptions): Promise<ActionHandle> {
    const id = options.id ?? randomId("action");
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs;

    let resolveCompletion: (value: JsonObject) => void = () => {};
    let rejectCompletion: (error: Error) => void = () => {};

    const completion = new Promise<JsonObject>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    const timeout =
      typeof timeoutMs === "number" && timeoutMs > 0
        ? setTimeout(() => {
            this.pendingActions.delete(id);
            rejectCompletion(new Error(`Action goal timeout for ${options.action} (${id})`));
          }, timeoutMs)
        : undefined;

    const pending: PendingAction = {
      id,
      sessionId: options.sessionId,
      action: options.action,
      actionType: options.actionType,
      resolve: resolveCompletion,
      reject: rejectCompletion,
      timeout,
      onRequest: options.onRequest,
      onFeedback: options.onFeedback,
      onResult: options.onResult
    };

    this.pendingActions.set(id, pending);
    if (options.sessionId) {
      this.actionIdBySession.set(options.sessionId, id);
    }

    await this.sendWithProtocol((protocol) =>
      protocol.build_send_action_goal(options.action, options.actionType, options.goal, id, options.sessionId)
    ).catch((error: unknown) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      this.pendingActions.delete(id);
      if (options.sessionId) {
        this.actionIdBySession.delete(options.sessionId);
      }
      throw error;
    });

    return {
      id,
      sessionId: options.sessionId,
      completion
    };
  }

  async cancelActionGoal(options: CancelActionGoalOptions): Promise<JsonObject> {
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs;
    const key = `${options.action}::${options.sessionId ?? "default"}`;

    return new Promise<JsonObject>((resolve, reject) => {
      const timeout =
        typeof timeoutMs === "number" && timeoutMs > 0
          ? setTimeout(() => {
              this.pendingActionCancels.delete(key);
              reject(new Error(`Action cancel timeout for ${options.action} (${key})`));
            }, timeoutMs)
          : undefined;

      this.pendingActionCancels.set(key, { key, resolve, reject, timeout });

      this.sendWithProtocol((protocol) =>
        protocol.build_cancel_action_goal(options.action, options.actionType, options.sessionId)
      ).catch((error: unknown) => {
        if (timeout) {
          clearTimeout(timeout);
        }
        this.pendingActionCancels.delete(key);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  close(): void {
    this.manualClose = true;
    this.clearReconnectTimer();
    this.connectInFlight = undefined;
    this.ws?.close();
    this.ws = undefined;
    this.resetReconnectState();
  }

  private async openSocket(url: string): Promise<void> {
    const wsFactory = this.options.webSocketFactory;
    if (!wsFactory) {
      throw new Error("No WebSocket factory configured for this runtime");
    }

    let ws: WebSocketLike;
    try {
      ws = wsFactory(url);
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.options.onSocketError?.(normalized);
      this.scheduleReconnect("open_socket_throw", normalized);
      throw normalized;
    }
    this.socketGeneration += 1;
    const generation = this.socketGeneration;
    this.activeSocketGeneration = generation;
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const resolveOnce = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };
      const rejectOnce = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };
      ws.onopen = () => {
        if (generation !== this.activeSocketGeneration) {
          return;
        }
        this.resetReconnectState();
        this.rebindState()
          .then(() => {
            this.options.onSocketOpen?.(url);
            resolveOnce();
          })
          .catch((error: unknown) => {
            const normalized = error instanceof Error ? error : new Error(String(error));
            this.options.onSocketError?.(normalized);
            this.scheduleReconnect("connect_error", normalized);
            rejectOnce(normalized);
          });
      };
      ws.onerror = () => {
        if (generation !== this.activeSocketGeneration) {
          return;
        }
        const error = new Error("WebSocket connection error");
        this.options.onSocketError?.(error);
        this.scheduleReconnect("socket_error", error);
        rejectOnce(error);
      };
      ws.onclose = () => {
        if (generation !== this.activeSocketGeneration) {
          return;
        }
        this.options.onSocketClose?.();
        this.scheduleReconnect("socket_close");
      };
      ws.onmessage = (event) => {
        if (generation !== this.activeSocketGeneration) {
          return;
        }
        void this.handleMessage(event.data);
      };
    });
  }

  private scheduleReconnect(reason: BridgeReconnectReason, error?: Error): void {
    this.rejectPendingActionsOnDisconnect();

    if (this.manualClose || !this.options.reconnect.enabled || !this.wsUrl) {
      return;
    }
    const nextAttempt = this.reconnectAttempt + 1;
    const context: BridgeReconnectContext = { reason, error, attempt: nextAttempt };
    if (this.options.reconnect.shouldRetry && !this.options.reconnect.shouldRetry(context)) {
      return;
    }
    if (this.reconnectTimer) {
      return;
    }

    this.reconnectAttempt = nextAttempt;
    const delay = this.computeReconnectDelayMs(nextAttempt);
    this.options.onReconnectScheduled?.({
      attempt: nextAttempt,
      nextDelayMs: delay,
      reason,
      error
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.openSocket(this.wsUrl as string).catch((openError: unknown) => {
        const normalized = openError instanceof Error ? openError : new Error(String(openError));
        this.scheduleReconnect("connect_error", normalized);
      });
    }, delay);
  }

  private computeReconnectDelayMs(attempt: number): number {
    const boundedInitial = Math.max(0, this.options.reconnect.initialDelayMs);
    const boundedMax = Math.max(boundedInitial, this.options.reconnect.maxDelayMs);
    const multiplier = this.options.reconnect.multiplier > 0 ? this.options.reconnect.multiplier : 1;
    const baseDelay = Math.min(boundedInitial * Math.pow(multiplier, Math.max(0, attempt - 1)), boundedMax);

    const jitterRatio = Math.min(Math.max(this.options.reconnect.jitterRatio, 0), 1);
    if (jitterRatio === 0) {
      return Math.max(0, Math.floor(baseDelay));
    }
    const spread = (Math.random() * 2 - 1) * jitterRatio;
    const jittered = baseDelay * (1 + spread);
    return Math.max(0, Math.min(boundedMax, Math.floor(jittered)));
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private resetReconnectState(): void {
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
  }

  private async handleMessage(raw: unknown): Promise<void> {
    const payload = await this.normalizeIncomingPayload(raw);

    let parsed: BridgeIncomingMessage;
    try {
      parsed = this.codec.decode(payload);
    } catch {
      return;
    }

    if ((parsed as { op?: string }).op === "publish") {
      const publish = parsed as { topic?: string; msg?: JsonObject };
      const topic = publish.topic;
      if (!topic || !publish.msg) {
        return;
      }
      const subscription = this.subscriptions.get(topic);
      if (!subscription) {
        return;
      }
      for (const callback of subscription.callbacks) {
        callback(publish.msg);
      }
      return;
    }

    if ((parsed as { op?: string }).op === "service_response") {
      const response = parsed as { id?: string; result?: boolean; values?: JsonObject; error?: string; service?: string };
      if (!response.id) {
        return;
      }
      const pending = this.pendingCalls.get(response.id);
      if (!pending) {
        return;
      }
      if (pending.timeout) {
        clearTimeout(pending.timeout);
      }
      this.pendingCalls.delete(response.id);

      if (!response.result) {
        pending.reject(new Error(response.error ?? `Service call failed: ${response.service ?? pending.service}`));
        return;
      }
      pending.resolve(response.values ?? {});
      return;
    }

    if ((parsed as { op?: string }).op === "cancel_action_result") {
      const response = parsed as { action?: string; result?: boolean; error?: string; session_id?: string };
      const key = `${response.action ?? ""}::${response.session_id ?? "default"}`;
      const pending = this.pendingActionCancels.get(key);
      if (!pending) {
        return;
      }
      if (pending.timeout) {
        clearTimeout(pending.timeout);
      }
      this.pendingActionCancels.delete(key);

      if (!response.result) {
        pending.reject(new Error(response.error ?? `Action cancel failed for ${response.action ?? "unknown"}`));
        return;
      }
      pending.resolve(asRecord(parsed));
      return;
    }

    if ((parsed as { op?: string }).op === "action_result") {
      const response = parsed as { id?: string; session_id?: string; error?: string; result?: JsonObject };
      const pending = this.findPendingAction(response.id, response.session_id);
      if (!pending) {
        return;
      }
      this.finishPendingAction(pending.id);
      if (response.error) {
        pending.reject(new Error(response.error));
        return;
      }
      pending.resolve(response.result ?? asRecord(parsed));
      return;
    }

    if ((parsed as { type?: string }).type) {
      const event = parsed as {
        type: string;
        id?: string;
        session_id?: string;
        feedback?: JsonObject;
        result?: JsonObject;
        message?: string;
        status?: number;
      };

      const pending = this.findPendingAction(event.id, event.session_id);
      if (!pending) {
        return;
      }

      if (event.type === "request") {
        pending.onRequest?.(asRecord(parsed));
        return;
      }

      if (event.type === "feedback") {
        pending.onFeedback?.(event.feedback ?? asRecord(parsed));
        return;
      }

      if (event.type === "result") {
        pending.onResult?.(event.result ?? asRecord(parsed));
        this.finishPendingAction(pending.id);
        if (typeof event.status === "number" && event.status !== 0) {
          pending.reject(new Error(`Action ${pending.id} completed with non-success status ${event.status}`));
          return;
        }
        pending.resolve(event.result ?? asRecord(parsed));
        return;
      }

      if (event.type === "error") {
        this.finishPendingAction(pending.id);
        pending.reject(new Error(event.message ?? "action_error"));
      }
    }
  }

  private async normalizeIncomingPayload(raw: unknown): Promise<unknown> {
    if (typeof raw === "string" || raw instanceof Uint8Array || raw instanceof ArrayBuffer) {
      return raw;
    }

    if (ArrayBuffer.isView(raw)) {
      return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    }

    if (typeof Blob !== "undefined" && raw instanceof Blob) {
      return new Uint8Array(await raw.arrayBuffer());
    }

    return raw;
  }

  private async rebindState(): Promise<void> {
    for (const [topic, info] of this.subscriptions.entries()) {
      await this.sendWithProtocol((protocol) => protocol.build_subscribe(topic, info.type, info.compression));
    }
    for (const [topic, type] of this.advertisedTopics.entries()) {
      await this.sendWithProtocol((protocol) => protocol.build_advertise(topic, type));
    }
  }

  private findPendingAction(id?: string, sessionId?: string): PendingAction | undefined {
    if (id && this.pendingActions.has(id)) {
      return this.pendingActions.get(id);
    }
    if (sessionId) {
      const actionId = this.actionIdBySession.get(sessionId);
      if (actionId) {
        return this.pendingActions.get(actionId);
      }
    }
    if (this.pendingActions.size === 1) {
      return this.pendingActions.values().next().value;
    }
    return undefined;
  }

  private finishPendingAction(id: string): void {
    const pending = this.pendingActions.get(id);
    if (!pending) {
      return;
    }
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    this.pendingActions.delete(id);
    if (pending.sessionId) {
      this.actionIdBySession.delete(pending.sessionId);
    }
  }

  private rejectPendingActionsOnDisconnect(): void {
    for (const pending of this.pendingActions.values()) {
      if (pending.timeout) {
        clearTimeout(pending.timeout);
      }
      pending.reject(new Error(`Action ${pending.id} interrupted by disconnect; resend after reconnect`));
    }
    this.pendingActions.clear();
    this.actionIdBySession.clear();

    for (const pendingCancel of this.pendingActionCancels.values()) {
      if (pendingCancel.timeout) {
        clearTimeout(pendingCancel.timeout);
      }
      pendingCancel.reject(new Error("Action cancel interrupted by disconnect; retry after reconnect"));
    }
    this.pendingActionCancels.clear();
  }

  private async sendWithProtocol(build: (protocol: WasmProtocol) => JsonObject): Promise<void> {
    if (!this.ws || this.ws.readyState !== OPEN) {
      throw new Error("WebSocket is not connected");
    }
    const protocol = await this.protocolPromise;
    let message = build(protocol);

    // Some wasm-bindgen return paths can produce non-plain objects in browser builds.
    // If no op envelope is detected, retry using the pure TS fallback protocol.
    if (!hasValidOpEnvelope(message)) {
      message = build(fallbackProtocol);
    }
    if (!hasValidOpEnvelope(message)) {
      throw new Error("Failed to build a valid protocol message");
    }

    this.ws.send(this.codec.encode(message));
  }
}
