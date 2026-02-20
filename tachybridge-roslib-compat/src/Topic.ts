import type Ros from "./Ros.js";
import type { JsonMap, TopicOptions } from "./types.js";

export default class Topic<T = unknown> {
  private static compressionWarningShown = false;
  private readonly ros: Ros;
  private readonly name: string;
  private readonly messageType: string;
  private readonly compression?: string;
  private isAdvertised = false;

  constructor(options: TopicOptions) {
    this.ros = options.ros as Ros;
    this.name = options.name;
    this.messageType = options.messageType;
    this.compression = options.compression;
    if (options.compression && options.compression !== "none" && !Topic.compressionWarningShown) {
      Topic.compressionWarningShown = true;
      console.warn(
        "[tachybridge-roslib-compat] Topic.compression is applied only to subscribe op. " +
          "Use Ros({ codec: 'cbor' }) to enable CBOR websocket frames."
      );
    }
  }

  subscribe(callback: (message: T) => void): void {
    const internalCallback = callback as unknown as (msg: JsonMap) => void;
    this.ros._registerTopicCallback(this.name, internalCallback);
    void this.ros
      ._ensureTopicSubscription(this.name, this.messageType, { compression: this.compression })
      .catch((error) => {
        this.ros.emit("error", error);
      });
  }

  unsubscribe(callback?: (message: T) => void): void {
    const internalCallback = callback as unknown as ((msg: JsonMap) => void) | undefined;
    void this.ros._unregisterTopicCallback(this.name, internalCallback).catch((error) => {
      this.ros.emit("error", error);
    });
  }

  advertise(): void {
    if (this.isAdvertised) {
      return;
    }
    this.isAdvertised = true;
    void this.ros._compatClient.advertise(this.name, this.messageType);
  }

  unadvertise(): void {
    this.isAdvertised = false;
  }

  publish(message: T): void {
    if (!this.isAdvertised) {
      this.advertise();
    }
    void this.ros._compatClient.publish(this.name, message as JsonMap);
  }
}
