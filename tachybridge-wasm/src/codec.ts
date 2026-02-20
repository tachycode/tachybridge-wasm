import { decodeCbor, encodeCbor } from "./cbor.js";
import type { BridgeCodec, BridgeCodecOption, BridgeIncomingMessage, JsonObject } from "./types.js";

const utf8Decoder = new TextDecoder();

function decodeJsonLike(input: unknown): BridgeIncomingMessage {
  if (typeof input === "string") {
    return JSON.parse(input) as BridgeIncomingMessage;
  }
  if (input instanceof Uint8Array) {
    return JSON.parse(utf8Decoder.decode(input)) as BridgeIncomingMessage;
  }
  if (input instanceof ArrayBuffer) {
    return JSON.parse(utf8Decoder.decode(new Uint8Array(input))) as BridgeIncomingMessage;
  }
  throw new Error("Unsupported JSON payload type");
}

export const jsonCodec: BridgeCodec = {
  name: "json",
  encode(message) {
    return JSON.stringify(message);
  },
  decode(payload) {
    return decodeJsonLike(payload);
  }
};

export const cborCodec: BridgeCodec = {
  name: "cbor",
  encode(message) {
    return encodeCbor(message);
  },
  decode(payload) {
    if (payload instanceof Uint8Array || payload instanceof ArrayBuffer) {
      return decodeCbor(payload) as BridgeIncomingMessage;
    }
    if (typeof payload === "string") {
      return JSON.parse(payload) as BridgeIncomingMessage;
    }
    throw new Error("Unsupported CBOR payload type");
  }
};

export const autoCodec: BridgeCodec = {
  name: "auto",
  encode(message) {
    // Keep requests maximally compatible by defaulting to JSON text on transmit.
    return jsonCodec.encode(message);
  },
  decode(payload) {
    if (typeof payload === "string") {
      return decodeJsonLike(payload);
    }
    if (payload instanceof Uint8Array || payload instanceof ArrayBuffer) {
      try {
        return decodeCbor(payload) as BridgeIncomingMessage;
      } catch {
        return decodeJsonLike(payload);
      }
    }
    return decodeJsonLike(payload);
  }
};

export function resolveCodec(codecOption: BridgeCodecOption | undefined): BridgeCodec {
  if (!codecOption || codecOption === "json") {
    return jsonCodec;
  }
  if (codecOption === "cbor") {
    return cborCodec;
  }
  if (codecOption === "auto") {
    return autoCodec;
  }
  return codecOption;
}

export function isObjectMessage(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
