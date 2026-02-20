import { describe, expect, it } from "vitest";
import { cborCodec, jsonCodec } from "../src/codec.js";

describe("codec", () => {
  it("json codec decodes string payload", () => {
    const msg = { op: "publish", topic: "/demo", msg: { text: "ok" } };
    const encoded = jsonCodec.encode(msg);
    expect(typeof encoded).toBe("string");
    const decoded = jsonCodec.decode(encoded);
    expect((decoded as { op: string }).op).toBe("publish");
  });

  it("cbor codec encodes/decodes binary payload", () => {
    const msg = { op: "call_service", service: "/demo/sum", args: { a: 1, b: 2 }, id: "svc-1" };
    const encoded = cborCodec.encode(msg);
    expect(encoded).toBeInstanceOf(Uint8Array);
    const decoded = cborCodec.decode(encoded);
    expect((decoded as { op: string }).op).toBe("call_service");
    expect((decoded as { args: { a: number } }).args.a).toBe(1);
  });

  it("cbor codec throws on invalid binary payload", () => {
    const invalid = new Uint8Array([0xff, 0x00]);
    expect(() => cborCodec.decode(invalid)).toThrow();
  });
});
