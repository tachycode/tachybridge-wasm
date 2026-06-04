import WebSocket from "ws";

export const DEFAULT_URL = "wss://localhost:9090";

export function resolveUrl(): string {
  return process.env.TACHYBRIDGE_MOCK_URL ?? process.env.MOCK_ROS_URL ?? DEFAULT_URL;
}

// `rejectUnauthorized` is disabled because the mock server is typically
// served with a self-signed cert (Next.js dev cert / mkcert) on localhost.
export function connect(): WebSocket {
  return new WebSocket(resolveUrl(), { rejectUnauthorized: false });
}

export function parseJsonArg(
  raw: string | undefined,
  fieldName: string,
): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected an object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[tachybridge-mock] invalid JSON for ${fieldName}: ${message}`);
    process.exit(1);
  }
}

export function decodeFrame(raw: Buffer | ArrayBuffer | Buffer[] | string): unknown {
  const text =
    typeof raw === "string"
      ? raw
      : Buffer.isBuffer(raw)
        ? raw.toString("utf8")
        : Array.isArray(raw)
          ? Buffer.concat(raw).toString("utf8")
          : Buffer.from(raw as ArrayBuffer).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
