#!/usr/bin/env node
// Single-bin entrypoint for the tachybridge-mockup-rosbridge CLI helpers.
// Subcommands speak the rosbridge JSON protocol over a single WebSocket
// connection (`pub`, `sub`, `call`, `advertise`) or run an embedded mock
// server (`server`).
//
// Default URL is ws://localhost:9090; override with --port, --url, or the
// TACHYBRIDGE_MOCK_URL environment variable.
import { run as runPub } from "./pub.js";
import { run as runSub } from "./sub.js";
import { run as runCall } from "./call.js";
import { run as runAdvertise } from "./advertise.js";
import { run as runServer } from "./server.js";

const SUBCOMMANDS: Record<string, (args: string[]) => void | Promise<void>> = {
  pub: runPub,
  sub: runSub,
  call: runCall,
  advertise: runAdvertise,
  server: runServer,
};

function printUsage(): void {
  console.error("usage: tachybridge-mock <pub|sub|call|advertise|server> ...");
  console.error("");
  console.error("Clients (default URL ws://localhost:9090):");
  console.error("  pub <topic> <json-msg> [type]            Publish one message");
  console.error("  sub <topic> [type]                       Subscribe and print incoming messages");
  console.error("  call <service> [json-args] [type]        Call a service and print the response");
  console.error("  advertise <service> [json-response] [type]");
  console.error("                                           Advertise a service that replies with the given JSON");
  console.error("");
  console.error("Server:");
  console.error("  server [--port n] [--host h] [--handlers <path>] [--watch]");
  console.error("                                           Run the embedded mock rosbridge");
  console.error("");
  console.error("Client flags (pub/sub/call/advertise):");
  console.error("  --port <n>                  Override port on ws://localhost (default 9090)");
  console.error("  --url <u>                   Override full WebSocket URL");
  console.error("");
  console.error("Environment:");
  console.error("  TACHYBRIDGE_MOCK_URL        Client WebSocket URL (overrides --port)");
  console.error("  TACHYBRIDGE_MOCK_TIMEOUT_MS Client `call` timeout in ms (default 5000)");
}

async function main(): Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2);
  if (!subcommand || subcommand === "-h" || subcommand === "--help") {
    printUsage();
    process.exit(subcommand ? 0 : 1);
  }
  const handler = SUBCOMMANDS[subcommand];
  if (!handler) {
    console.error(`unknown subcommand: ${subcommand}`);
    printUsage();
    process.exit(1);
  }
  await handler(rest);
}

void main();
