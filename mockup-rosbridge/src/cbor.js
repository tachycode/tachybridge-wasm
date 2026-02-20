const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
function encodeTypeAndLength(majorType, length) {
    const major = majorType << 5;
    if (length < 24) {
        return Uint8Array.of(major | length);
    }
    if (length <= 0xff) {
        return Uint8Array.of(major | 24, length);
    }
    if (length <= 0xffff) {
        return Uint8Array.of(major | 25, (length >> 8) & 0xff, length & 0xff);
    }
    return Uint8Array.of(major | 26, (length >> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff);
}
function concat(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}
function encodeFloat64(value) {
    const out = new Uint8Array(9);
    out[0] = (7 << 5) | 27;
    new DataView(out.buffer).setFloat64(1, value, false);
    return out;
}
function encodeValue(value) {
    if (value === null) {
        return Uint8Array.of((7 << 5) | 22);
    }
    if (typeof value === "boolean") {
        return Uint8Array.of((7 << 5) | (value ? 21 : 20));
    }
    if (typeof value === "number") {
        if (Number.isSafeInteger(value)) {
            if (value >= 0) {
                return encodeTypeAndLength(0, value);
            }
            return encodeTypeAndLength(1, -1 - value);
        }
        return encodeFloat64(value);
    }
    if (typeof value === "string") {
        const bytes = textEncoder.encode(value);
        return concat([encodeTypeAndLength(3, bytes.length), bytes]);
    }
    if (Array.isArray(value)) {
        const parts = [encodeTypeAndLength(4, value.length)];
        for (const item of value) {
            parts.push(encodeValue(item));
        }
        return concat(parts);
    }
    if (typeof value === "object") {
        const entries = Object.entries(value).filter(([, v]) => v !== undefined);
        const parts = [encodeTypeAndLength(5, entries.length)];
        for (const [key, item] of entries) {
            parts.push(encodeValue(key), encodeValue(item));
        }
        return concat(parts);
    }
    throw new Error(`Unsupported CBOR type: ${typeof value}`);
}
class Reader {
    input;
    view;
    offset = 0;
    constructor(input) {
        this.input = input;
        this.view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    }
    remaining() {
        return this.input.length - this.offset;
    }
    byte() {
        if (this.offset >= this.input.length) {
            throw new Error("Unexpected CBOR end");
        }
        return this.input[this.offset++];
    }
    bytes(length) {
        if (this.offset + length > this.input.length) {
            throw new Error("Unexpected CBOR end");
        }
        const out = this.input.subarray(this.offset, this.offset + length);
        this.offset += length;
        return out;
    }
    length(additional) {
        if (additional < 24) {
            return additional;
        }
        if (additional === 24) {
            return this.byte();
        }
        if (additional === 25) {
            const out = this.view.getUint16(this.offset, false);
            this.offset += 2;
            return out;
        }
        if (additional === 26) {
            const out = this.view.getUint32(this.offset, false);
            this.offset += 4;
            return out;
        }
        throw new Error(`Unsupported CBOR length: ${additional}`);
    }
    decode() {
        const initial = this.byte();
        const major = initial >> 5;
        const additional = initial & 0x1f;
        if (major === 0) {
            return this.length(additional);
        }
        if (major === 1) {
            return -1 - this.length(additional);
        }
        if (major === 2) {
            const len = this.length(additional);
            return this.bytes(len);
        }
        if (major === 3) {
            const len = this.length(additional);
            return textDecoder.decode(this.bytes(len));
        }
        if (major === 4) {
            const len = this.length(additional);
            const out = [];
            for (let i = 0; i < len; i += 1) {
                out.push(this.decode());
            }
            return out;
        }
        if (major === 5) {
            const len = this.length(additional);
            const out = {};
            for (let i = 0; i < len; i += 1) {
                const key = this.decode();
                out[String(key)] = this.decode();
            }
            return out;
        }
        if (major === 6) {
            this.length(additional);
            return this.decode();
        }
        if (major === 7) {
            if (additional === 20) {
                return false;
            }
            if (additional === 21) {
                return true;
            }
            if (additional === 22 || additional === 23) {
                return null;
            }
            if (additional === 27) {
                const out = this.view.getFloat64(this.offset, false);
                this.offset += 8;
                return out;
            }
            throw new Error(`Unsupported CBOR simple: ${additional}`);
        }
        throw new Error(`Unsupported CBOR major type: ${major}`);
    }
}
export function encodeCbor(value) {
    return encodeValue(value);
}
export function decodeCbor(input) {
    const reader = new Reader(input);
    const value = reader.decode();
    if (reader.remaining() !== 0) {
        throw new Error("Trailing CBOR bytes");
    }
    return value;
}
