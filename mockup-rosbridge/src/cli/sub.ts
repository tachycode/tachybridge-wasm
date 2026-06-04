import { connect, decodeFrame, parseFlags } from "./connect.js";

export function run(args: string[]): void {
  const { url, positional } = parseFlags(args);
  const [topic, type] = positional;

  if (!topic) {
    console.error("usage: tachybridge-mock sub [--port n] [--url u] <topic> [type]");
    console.error("example: tachybridge-mock sub /rosout");
    process.exit(1);
  }

  const messageType = type ?? "std_msgs/String";
  const ws = connect(url);

  ws.on("open", () => {
    ws.send(JSON.stringify({ op: "subscribe", topic, type: messageType }));
    console.log(`[tachybridge-mock] sub ${topic} (${messageType}) — Ctrl+C to exit`);
  });

  ws.on("message", (raw) => {
    const parsed = decodeFrame(raw as Buffer | ArrayBuffer | Buffer[]) as
      | { op?: string; topic?: string; msg?: unknown }
      | null;
    if (parsed?.op === "publish" && parsed.topic === topic) {
      console.log(`[${new Date().toISOString()}]`, JSON.stringify(parsed.msg));
    }
  });

  ws.on("error", (err) => {
    console.error(`[tachybridge-mock] sub connect ${url} failed: ${err.message}`);
    process.exit(1);
  });

  const exit = () => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ op: "unsubscribe", topic }));
      ws.close();
    }
    process.exit(0);
  };
  process.on("SIGINT", exit);
  process.on("SIGTERM", exit);
}
