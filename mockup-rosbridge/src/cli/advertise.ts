import { connect, decodeFrame, parseJsonArg, resolveUrl } from "./connect.js";

export function run(args: string[]): void {
  const [service, responseRaw, type] = args;

  if (!service) {
    console.error("usage: tachybridge-mock advertise <service> [json-response] [type]");
    console.error("example: tachybridge-mock advertise /my/svc '{\"success\":true}'");
    process.exit(1);
  }

  const response = responseRaw
    ? parseJsonArg(responseRaw, "[json-response]")
    : { success: true, message: "ok from tachybridge-mock advertise" };
  const serviceType = type ?? "std_srvs/srv/Trigger";
  const ws = connect();

  ws.on("open", () => {
    ws.send(JSON.stringify({ op: "advertise_service", service, type: serviceType }));
    console.log(`[tachybridge-mock] advertise ${service} (${serviceType}) — Ctrl+C to exit`);
    console.log(`[tachybridge-mock] response →`, response);
  });

  ws.on("message", (raw) => {
    const parsed = decodeFrame(raw as Buffer | ArrayBuffer | Buffer[]) as
      | { op?: string; id?: string; service?: string; args?: unknown }
      | null;
    if (!parsed) return;

    if (parsed.op === "call_service" && parsed.service === service) {
      console.log(`[tachybridge-mock] incoming id=${parsed.id} args=`, parsed.args ?? {});
      ws.send(
        JSON.stringify({
          op: "service_response",
          service,
          id: parsed.id,
          values: response,
          result: true,
        }),
      );
    }
  });

  ws.on("error", (err) => {
    console.error(`[tachybridge-mock] advertise connect ${resolveUrl()} failed: ${err.message}`);
    process.exit(1);
  });

  const exit = () => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ op: "unadvertise_service", service }));
      ws.close();
    }
    process.exit(0);
  };
  process.on("SIGINT", exit);
  process.on("SIGTERM", exit);
}
