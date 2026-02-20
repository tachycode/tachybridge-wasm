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

async function loadBrowserProtocol(): Promise<WasmProtocol> {
  const moduleUrl = new URL("./wasm/web/bridge_wasm.js", import.meta.url).href;
  const wasmModule = (await import(moduleUrl)) as {
    default: (modulePath?: string | URL) => Promise<void>;
    build_subscribe: WasmProtocol["build_subscribe"];
    build_unsubscribe: WasmProtocol["build_unsubscribe"];
    build_advertise: WasmProtocol["build_advertise"];
    build_publish: WasmProtocol["build_publish"];
    build_call_service: WasmProtocol["build_call_service"];
    build_send_action_goal: WasmProtocol["build_send_action_goal"];
    build_cancel_action_goal: WasmProtocol["build_cancel_action_goal"];
  };

  const wasmBinaryUrl = new URL("./wasm/web/bridge_wasm_bg.wasm", import.meta.url).href;
  await wasmModule.default(wasmBinaryUrl);

  return {
    build_subscribe: wasmModule.build_subscribe,
    build_unsubscribe: wasmModule.build_unsubscribe,
    build_advertise: wasmModule.build_advertise,
    build_publish: wasmModule.build_publish,
    build_call_service: wasmModule.build_call_service,
    build_send_action_goal: wasmModule.build_send_action_goal,
    build_cancel_action_goal: wasmModule.build_cancel_action_goal
  };
}

function browserWebSocketFactory(url: string): WebSocketLike {
  if (!globalThis.WebSocket) {
    throw new Error("Browser WebSocket is not available");
  }
  return new globalThis.WebSocket(url) as unknown as WebSocketLike;
}

export class BridgeClient extends BridgeClientCore {
  constructor(options: BridgeClientOptions = {}) {
    super(loadBrowserProtocol, {
      ...options,
      webSocketFactory: options.webSocketFactory ?? browserWebSocketFactory
    });
  }
}

export function createBridgeClient(options: BridgeClientOptions = {}): BridgeClient {
  return new BridgeClient(options);
}
