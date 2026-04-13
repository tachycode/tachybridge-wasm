import { BridgeClientCore } from "./client-core.js";
import type { BridgeClientOptions, WasmProtocol, WebSocketLike } from "./types.js";
// Static imports — every modern bundler resolves these without extra config.
// `bridge_wasm.js` is the wasm-pack web glue (post-processed to remove its
// static `new URL(..., import.meta.url)` asset reference).
// `bridge_wasm_inline.js` exports the .wasm bytes as a base64 string so we
// never have to fetch the binary at runtime.
import init, * as wasmModule from "./wasm/web/bridge_wasm.js";
import { wasmBase64 } from "./wasm/web/bridge_wasm_inline.js";

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

let wasmReady: Promise<WasmProtocol> | null = null;

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function loadBrowserProtocol(): Promise<WasmProtocol> {
  if (!wasmReady) {
    wasmReady = (async () => {
      await init({ module_or_path: decodeBase64(wasmBase64) });
      return {
        build_subscribe: wasmModule.build_subscribe,
        build_unsubscribe: wasmModule.build_unsubscribe,
        build_advertise: wasmModule.build_advertise,
        build_publish: wasmModule.build_publish,
        build_call_service: wasmModule.build_call_service,
        build_send_action_goal: wasmModule.build_send_action_goal,
        build_cancel_action_goal: wasmModule.build_cancel_action_goal
      };
    })();
  }
  return wasmReady;
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
