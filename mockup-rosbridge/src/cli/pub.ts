import { connect, parseFlags, parseJsonArg } from "./connect.js";

export function run(args: string[]): void {
  const { url, positional } = parseFlags(args);
  const [topic, payloadRaw, type] = positional;

  if (!topic || !payloadRaw) {
    console.error("usage: tachybridge-mock pub [--port n] [--url u] <topic> <json-msg> [type]");
    console.error("example: tachybridge-mock pub /chatter '{\"data\":\"hi\"}'");
    process.exit(1);
  }

  const msg = parseJsonArg(payloadRaw, "<json-msg>");
  const messageType = type ?? "std_msgs/String";
  const ws = connect(url);

  ws.on("open", () => {
    ws.send(JSON.stringify({ op: "advertise", topic, type: messageType }));
    ws.send(JSON.stringify({ op: "publish", topic, msg }));
    setTimeout(() => {
      ws.send(JSON.stringify({ op: "unadvertise", topic }));
      ws.close();
      console.log(`[tachybridge-mock] pub ${topic} (${messageType}) →`, msg);
    }, 150);
  });

  ws.on("error", (err) => {
    console.error(`[tachybridge-mock] pub connect ${url} failed: ${err.message}`);
    process.exit(1);
  });
}
