import { BridgeClient } from "tachybridge-wasm/node";
import { TinyEmitter } from "./emitter.js";
import type { JsonMap, RosExecuteCliOptions, RosOptions } from "./types.js";

type TopicSubscriptionState = {
  type: string;
  compression?: string;
  active: boolean;
  pending: boolean;
};

export default class Ros extends TinyEmitter {
  public _compatClient: BridgeClient;
  private readonly topicCallbacks = new Map<string, Set<(msg: JsonMap) => void>>();
  private readonly topicHandlers = new Map<string, (msg: JsonMap) => void>();
  private readonly topicStates = new Map<string, TopicSubscriptionState>();
  private connected = false;
  private connectedUrl?: string;

  constructor(options: RosOptions = {}) {
    super();
    this._compatClient = new BridgeClient({
      timeoutMs: options.timeoutMs,
      codec: options.codec,
      onSocketOpen: (url) => {
        this.connectedUrl = url;
        this._setConnected(true);
      },
      onSocketClose: () => {
        this._setConnected(false);
      },
      onSocketError: (error) => {
        this.emit("error", error);
      },
      reconnect: {
        enabled: options.reconnect?.enabled ?? false,
        initialDelayMs: options.reconnect?.initialDelayMs ?? 500,
        maxDelayMs: options.reconnect?.maxDelayMs ?? 30000
      }
    });
    this.on("connection", () => {
      void this._flushPendingTopicSubscriptions();
    });

    if (options.url) {
      void this.connect(options.url);
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(url: string): Promise<void> {
    this.connectedUrl = url;
    try {
      await this._compatClient.connect(url);
    } catch (error) {
      this._setConnected(false);
      throw error;
    }
  }

  close(): void {
    this._compatClient.close();
    this._setConnected(false);
  }

  async executeCli(command: string, options: RosExecuteCliOptions = {}): Promise<JsonMap> {
    return await (
      this._compatClient as unknown as {
        executeCli: (cmd: string, opts?: RosExecuteCliOptions) => Promise<JsonMap>;
      }
    ).executeCli(command, options);
  }

  async _ensureTopicSubscription(
    topic: string,
    type: string,
    options?: { compression?: string }
  ): Promise<void> {
    const existingState = this.topicStates.get(topic);
    if (existingState) {
      existingState.type = type;
      existingState.compression = options?.compression;
    } else {
      this.topicStates.set(topic, {
        type,
        compression: options?.compression,
        active: false,
        pending: !this.connected
      });
    }

    if (this.topicHandlers.has(topic)) {
      const state = this.topicStates.get(topic);
      if (state && !this.connected) {
        state.pending = true;
        return;
      }
      if (state && this.connected && (state.pending || !state.active)) {
        await this._activateTopicSubscription(topic);
      }
      return;
    }

    const handler = (msg: JsonMap): void => {
      const callbacks = this.topicCallbacks.get(topic);
      if (!callbacks) {
        return;
      }
      for (const callback of callbacks) {
        callback(msg);
      }
      this.emit(topic, { op: "publish", topic, msg });
    };

    this.topicHandlers.set(topic, handler);
    if (!this.connected) {
      const state = this.topicStates.get(topic);
      if (state) {
        state.pending = true;
      }
      return;
    }

    await this._activateTopicSubscription(topic);
  }

  _registerTopicCallback(topic: string, callback: (msg: JsonMap) => void): void {
    const callbacks = this.topicCallbacks.get(topic) ?? new Set<(msg: JsonMap) => void>();
    callbacks.add(callback);
    this.topicCallbacks.set(topic, callbacks);
  }

  async _unregisterTopicCallback(topic: string, callback?: (msg: JsonMap) => void): Promise<void> {
    const callbacks = this.topicCallbacks.get(topic);
    if (!callbacks) {
      return;
    }

    if (callback) {
      callbacks.delete(callback);
    } else {
      callbacks.clear();
    }

    if (callbacks.size > 0) {
      return;
    }

    const state = this.topicStates.get(topic);
    this.topicCallbacks.delete(topic);
    this.topicHandlers.delete(topic);
    this.topicStates.delete(topic);
    if (!state?.active || !this.connected) {
      return;
    }
    try {
      await this._compatClient.unsubscribe(topic);
    } catch (error) {
      this.emit("error", error);
    }
  }

  private _setConnected(nextConnected: boolean): void {
    if (this.connected === nextConnected) {
      return;
    }
    this.connected = nextConnected;
    if (nextConnected) {
      this.emit("connection", { url: this.connectedUrl });
      return;
    }
    for (const state of this.topicStates.values()) {
      state.active = false;
      state.pending = true;
    }
    this.emit("close", {});
  }

  private async _flushPendingTopicSubscriptions(): Promise<void> {
    if (!this.connected) {
      return;
    }
    for (const [topic, state] of this.topicStates.entries()) {
      if (!state.pending) {
        continue;
      }
      await this._activateTopicSubscription(topic);
    }
  }

  private async _activateTopicSubscription(topic: string): Promise<void> {
    const state = this.topicStates.get(topic);
    const handler = this.topicHandlers.get(topic);
    const callbacks = this.topicCallbacks.get(topic);
    if (!state || !handler || !callbacks || callbacks.size === 0) {
      return;
    }

    try {
      await (this._compatClient as unknown as {
        subscribe: (
          topic: string,
          type: string,
          callback: (msg: JsonMap) => void,
          opts?: { compression?: string }
        ) => Promise<void>;
      }).subscribe(topic, state.type, handler, { compression: state.compression });
      state.active = true;
      state.pending = false;
    } catch (error) {
      state.active = false;
      state.pending = true;
      this.emit("error", error);
    }
  }
}
