import { connect, decodeFrame, parseJsonArg, resolveUrl } from "./connect.js";

export function run(args: string[]): void {
  const [service, argsRaw, type] = args;

  if (!service) {
    console.error("usage: tachybridge-mock call <service> [json-args] [type]");
    console.error("example: tachybridge-mock call /my/service '{\"a\":1}'");
    process.exit(1);
  }

  const callArgs = parseJsonArg(argsRaw, "[json-args]");
  const id = `cli-${Date.now()}`;
  const timeoutMs = Number(process.env.TACHYBRIDGE_MOCK_TIMEOUT_MS ?? process.env.MOCK_ROS_TIMEOUT_MS ?? 5000);
  const ws = connect();

  const timeout = setTimeout(() => {
    console.error(`[tachybridge-mock] call timeout after ${timeoutMs}ms`);
    ws.close();
    process.exit(1);
  }, timeoutMs);

  ws.on("open", () => {
    ws.send(JSON.stringify({ op: "call_service", service, type, args: callArgs, id }));
  });

  ws.on("message", (raw) => {
    const parsed = decodeFrame(raw as Buffer | ArrayBuffer | Buffer[]) as
      | { op?: string; id?: string; service?: string; values?: unknown; result?: boolean; level?: string; msg?: string }
      | null;
    if (!parsed) return;

    if (parsed.op === "service_response" && parsed.id === id) {
      clearTimeout(timeout);
      console.log(`[tachybridge-mock] call ${service} result=${parsed.result}`);
      console.log(JSON.stringify(parsed.values, null, 2));
      ws.close();
      process.exit(0);
    }
    if (parsed.op === "status" && parsed.level === "error" && parsed.id === id) {
      clearTimeout(timeout);
      console.error(`[tachybridge-mock] ${parsed.msg}`);
      ws.close();
      process.exit(1);
    }
  });

  ws.on("error", (err) => {
    clearTimeout(timeout);
    console.error(`[tachybridge-mock] call connect ${resolveUrl()} failed: ${err.message}`);
    process.exit(1);
  });
}
