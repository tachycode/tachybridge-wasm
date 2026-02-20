import { BridgeClient, autoCodec, cborCodec, jsonCodec } from "tachybridge-wasm";
import { mountMockupWeb } from "./app";
import "./styles.css";

const root = document.getElementById("app");
if (!root) {
  throw new Error("#app not found");
}

mountMockupWeb(root, {
  BridgeClient: BridgeClient as never,
  codecs: {
    json: jsonCodec as never,
    cbor: cborCodec as never,
    auto: autoCodec as never
  }
});
