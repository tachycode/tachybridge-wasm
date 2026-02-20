import { createRequire } from "node:module";
import { BridgeClientCore } from "./client-core.js";
import type { BridgeClientOptions, WasmProtocol, WebSocketLike } from "./types.js";
export { autoCodec, cborCodec, jsonCodec, resolveCodec } from "./codec.js";
export type {
  BridgeCodec,
  BridgeCodecName,
  BridgeCodecOption,
  BridgeReconnectContext,
  BridgeReconnectOptions,
  BridgeReconnectReason,
  BridgeReconnectScheduledEvent
} from "./types.js";

const require = createRequire(import.meta.url);

async function loadNodeProtocol(): Promise<WasmProtocol> {
  const wasmModule = require("./wasm/node/bridge_wasm.js") as WasmProtocol;
  return wasmModule;
}

async function loadNodeWebSocketCtor(): Promise<new (url: string) => WebSocketLike> {
  if (typeof globalThis.WebSocket !== "undefined") {
    return globalThis.WebSocket as unknown as new (url: string) => WebSocketLike;
  }

  const wsModule = (await import("ws")) as { default: new (url: string) => WebSocketLike };
  return wsModule.default;
}

export class BridgeClient extends BridgeClientCore {
  constructor(options: BridgeClientOptions = {}) {
    super(loadNodeProtocol, {
      ...options,
      webSocketFactory: options.webSocketFactory
    });
  }

  override async connect(url: string): Promise<void> {
    const ctor = await loadNodeWebSocketCtor();
    const factory = (targetUrl: string): WebSocketLike => new ctor(targetUrl);
    this.setWebSocketFactory(factory);
    await super.connect(url);
  }
}

export function createBridgeClient(options: BridgeClientOptions = {}): BridgeClient {
  return new BridgeClient(options);
}
