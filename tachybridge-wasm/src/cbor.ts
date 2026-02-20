const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function assertLength(length: number): void {
  if (!Number.isFinite(length) || length < 0) {
    throw new Error("Invalid CBOR length");
  }
}

function encodeTypeAndLength(majorType: number, length: number | bigint): Uint8Array {
  const major = majorType << 5;
  if (typeof length === "bigint") {
    if (length < 0n) {
      throw new Error("Negative CBOR length");
    }
    if (length <= 23n) {
      return Uint8Array.of(major | Number(length));
    }
    if (length <= 0xffn) {
      return Uint8Array.of(major | 24, Number(length));
    }
    if (length <= 0xffffn) {
      return Uint8Array.of(major | 25, Number(length >> 8n), Number(length & 0xffn));
    }
    if (length <= 0xffff_ffffn) {
      return Uint8Array.of(
        major | 26,
        Number((length >> 24n) & 0xffn),
        Number((length >> 16n) & 0xffn),
        Number((length >> 8n) & 0xffn),
        Number(length & 0xffn)
      );
    }
    if (length <= 0xffff_ffff_ffff_ffffn) {
      return Uint8Array.of(
        major | 27,
        Number((length >> 56n) & 0xffn),
        Number((length >> 48n) & 0xffn),
        Number((length >> 40n) & 0xffn),
        Number((length >> 32n) & 0xffn),
        Number((length >> 24n) & 0xffn),
        Number((length >> 16n) & 0xffn),
        Number((length >> 8n) & 0xffn),
        Number(length & 0xffn)
      );
    }
    throw new Error("CBOR length too large");
  }

  assertLength(length);
  if (length <= 23) {
    return Uint8Array.of(major | length);
  }
  if (length <= 0xff) {
    return Uint8Array.of(major | 24, length);
  }
  if (length <= 0xffff) {
    return Uint8Array.of(major | 25, (length >> 8) & 0xff, length & 0xff);
  }
  if (length <= 0xffff_ffff) {
    return Uint8Array.of(major | 26, (length >> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff);
  }
  return encodeTypeAndLength(majorType, BigInt(length));
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function encodeFloat64(value: number): Uint8Array {
  const out = new Uint8Array(9);
  out[0] = (7 << 5) | 27;
  new DataView(out.buffer).setFloat64(1, value, false);
  return out;
}

function encodeValue(value: unknown): Uint8Array {
  if (value === null) {
    return Uint8Array.of((7 << 5) | 22);
  }
  if (typeof value === "boolean") {
    return Uint8Array.of((7 << 5) | (value ? 21 : 20));
  }
  if (typeof value === "number") {
    if (Number.isInteger(value) && Number.isSafeInteger(value)) {
      if (value >= 0) {
        return encodeTypeAndLength(0, value);
      }
      return encodeTypeAndLength(1, -1 - value);
    }
    return encodeFloat64(value);
  }
  if (typeof value === "string") {
    const encoded = textEncoder.encode(value);
    return concatChunks([encodeTypeAndLength(3, encoded.length), encoded]);
  }
  if (value instanceof Uint8Array) {
    return concatChunks([encodeTypeAndLength(2, value.length), value]);
  }
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return concatChunks([encodeTypeAndLength(2, bytes.length), bytes]);
  }
  if (value instanceof ArrayBuffer) {
    const bytes = new Uint8Array(value);
    return concatChunks([encodeTypeAndLength(2, bytes.length), bytes]);
  }
  if (Array.isArray(value)) {
    const parts: Uint8Array[] = [encodeTypeAndLength(4, value.length)];
    for (const item of value) {
      parts.push(encodeValue(item));
    }
    return concatChunks(parts);
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    const parts: Uint8Array[] = [encodeTypeAndLength(5, entries.length)];
    for (const [key, item] of entries) {
      parts.push(encodeValue(key), encodeValue(item));
    }
    return concatChunks(parts);
  }
  throw new Error(`Unsupported CBOR value type: ${typeof value}`);
}

class Reader {
  private readonly view: DataView;
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  remaining(): number {
    return this.bytes.length - this.offset;
  }

  readByte(): number {
    if (this.offset >= this.bytes.length) {
      throw new Error("Unexpected end of CBOR payload");
    }
    const out = this.bytes[this.offset];
    this.offset += 1;
    return out;
  }

  readBytes(length: number): Uint8Array {
    if (this.offset + length > this.bytes.length) {
      throw new Error("Unexpected end of CBOR payload");
    }
    const out = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  readLength(additionalInfo: number): number {
    if (additionalInfo < 24) {
      return additionalInfo;
    }
    if (additionalInfo === 24) {
      return this.readByte();
    }
    if (additionalInfo === 25) {
      const value = this.view.getUint16(this.offset, false);
      this.offset += 2;
      return value;
    }
    if (additionalInfo === 26) {
      const value = this.view.getUint32(this.offset, false);
      this.offset += 4;
      return value;
    }
    if (additionalInfo === 27) {
      const hi = this.view.getUint32(this.offset, false);
      const lo = this.view.getUint32(this.offset + 4, false);
      this.offset += 8;
      const value = (BigInt(hi) << 32n) | BigInt(lo);
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("CBOR integer exceeds JS safe integer range");
      }
      return Number(value);
    }
    throw new Error(`Unsupported CBOR additional info: ${additionalInfo}`);
  }

  readFloat16(): number {
    const value = this.view.getUint16(this.offset, false);
    this.offset += 2;
    const sign = (value & 0x8000) ? -1 : 1;
    const exponent = (value >> 10) & 0x1f;
    const fraction = value & 0x3ff;
    if (exponent === 0) {
      return sign * Math.pow(2, -14) * (fraction / 1024);
    }
    if (exponent === 31) {
      return fraction === 0 ? sign * Infinity : Number.NaN;
    }
    return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
  }

  decode(): unknown {
    const initial = this.readByte();
    const majorType = initial >> 5;
    const additional = initial & 0x1f;

    if (majorType === 0) {
      return this.readLength(additional);
    }
    if (majorType === 1) {
      return -1 - this.readLength(additional);
    }
    if (majorType === 2) {
      const length = this.readLength(additional);
      return this.readBytes(length);
    }
    if (majorType === 3) {
      const length = this.readLength(additional);
      return textDecoder.decode(this.readBytes(length));
    }
    if (majorType === 4) {
      const length = this.readLength(additional);
      const out: unknown[] = [];
      for (let i = 0; i < length; i += 1) {
        out.push(this.decode());
      }
      return out;
    }
    if (majorType === 5) {
      const length = this.readLength(additional);
      const out: Record<string, unknown> = {};
      for (let i = 0; i < length; i += 1) {
        const key = this.decode();
        const val = this.decode();
        out[String(key)] = val;
      }
      return out;
    }
    if (majorType === 6) {
      this.readLength(additional);
      return this.decode();
    }
    if (majorType === 7) {
      if (additional === 20) {
        return false;
      }
      if (additional === 21) {
        return true;
      }
      if (additional === 22 || additional === 23) {
        return null;
      }
      if (additional === 25) {
        return this.readFloat16();
      }
      if (additional === 26) {
        const out = this.view.getFloat32(this.offset, false);
        this.offset += 4;
        return out;
      }
      if (additional === 27) {
        const out = this.view.getFloat64(this.offset, false);
        this.offset += 8;
        return out;
      }
      throw new Error(`Unsupported CBOR simple value: ${additional}`);
    }

    throw new Error(`Unsupported CBOR major type: ${majorType}`);
  }
}

export function encodeCbor(value: unknown): Uint8Array {
  return encodeValue(value);
}

export function decodeCbor(input: Uint8Array | ArrayBuffer): unknown {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const reader = new Reader(bytes);
  const decoded = reader.decode();
  if (reader.remaining() !== 0) {
    throw new Error("Trailing CBOR bytes detected");
  }
  return decoded;
}
