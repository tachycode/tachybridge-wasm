import { existsSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";

import WebSocket from "ws";

const DEFAULT_PROTOCOL = "ws";
const DEFAULT_HOST = "localhost";
export const DEFAULT_PORT = 9090;

// Walks up from `startDir` toward the nearest `.git` looking for the
// Next.js dev TLS cert pair under `certificates/`. Returns the discovered
// pair when both files exist — clients can default to `wss://` and the
// server subcommand can boot https without explicit flags.
export function detectLocalTls(
  startDir: string = process.cwd(),
): { cert: string; key: string } | undefined {
  const fsRoot = parse(startDir).root;
  let dir = resolve(startDir);
  while (true) {
    const cert = resolve(dir, "certificates/localhost.pem");
    const key = resolve(dir, "certificates/localhost-key.pem");
    if (existsSync(cert) && existsSync(key)) return { cert, key };
    if (existsSync(resolve(dir, ".git"))) break;
    const parent = dirname(dir);
    if (parent === dir || dir === fsRoot) break;
    dir = parent;
  }
  return undefined;
}

// URL precedence (highest first):
//   --url <url>
//   TACHYBRIDGE_MOCK_URL env (preferred)
//   MOCK_ROS_URL env (legacy alias)
//   --port <n>  → ws[s]://localhost:<n>
//   ws[s]://localhost:9090
// The protocol auto-upgrades to `wss` when the local Next.js dev cert pair
// is discoverable via detectLocalTls(); otherwise plain `ws`.
export function resolveUrl(opts: { port?: number; url?: string } = {}): string {
  if (opts.url) return opts.url;
  const fromEnv = process.env.TACHYBRIDGE_MOCK_URL ?? process.env.MOCK_ROS_URL;
  if (fromEnv) return fromEnv;
  const port = opts.port ?? DEFAULT_PORT;
  const protocol = detectLocalTls() ? "wss" : DEFAULT_PROTOCOL;
  return `${protocol}://${DEFAULT_HOST}:${port}`;
}

export type ParsedFlags = {
  url: string;
  positional: string[];
};

// Strips `--port <n>` and `--url <u>` (plus short forms `-p`, `-u`) from
// argv, resolves the final URL, and returns the remaining positional args.
export function parseFlags(args: string[]): ParsedFlags {
  const positional: string[] = [];
  let port: number | undefined;
  let url: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--port" || arg === "-p") {
      const value = args[++i];
      if (!value) {
        console.error(`[tachybridge-mock] ${arg} requires a value`);
        process.exit(1);
      }
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0 || n > 65535) {
        console.error(`[tachybridge-mock] invalid port: ${value}`);
        process.exit(1);
      }
      port = n;
    } else if (arg === "--url" || arg === "-u") {
      const value = args[++i];
      if (!value) {
        console.error(`[tachybridge-mock] ${arg} requires a value`);
        process.exit(1);
      }
      url = value;
    } else {
      positional.push(arg);
    }
  }

  return { url: resolveUrl({ port, url }), positional };
}

export function connect(url: string): WebSocket {
  // `rejectUnauthorized: false` covers consumers that point the bin at a mock
  // server with a self-signed cert. Plain ws:// is unaffected.
  return new WebSocket(url, { rejectUnauthorized: false });
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
