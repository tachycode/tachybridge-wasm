import type { BridgeCodecOption } from "tachybridge-wasm";

export type JsonMap = Record<string, unknown>;

export type RosOptions = {
  url?: string;
  timeoutMs?: number;
  codec?: BridgeCodecOption;
  reconnect?: {
    enabled?: boolean;
    initialDelayMs?: number;
    maxDelayMs?: number;
  };
};

export type RosExecuteCliOptions = {
  id?: string;
  timeoutMs?: number;
};

export type TopicOptions = {
  ros: { _compatClient: unknown };
  name: string;
  messageType: string;
  reconnect_on_close?: boolean;
  latch?: boolean;
  queue_size?: number;
  queue_length?: number;
  compression?: string;
  throttle_rate?: number;
};

export type ServiceOptions = {
  ros: { _compatClient: unknown };
  name: string;
  serviceType: string;
};

export type ActionOptions = {
  ros: { _compatClient: unknown };
  name: string;
  actionType: string;
};
