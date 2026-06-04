#!/usr/bin/env node
// Single-bin entrypoint for the tachybridge-mockup-rosbridge CLI helpers.
// Subcommands speak the rosbridge JSON protocol over a WebSocket and exit
// when their interaction is complete.
//
// Defaults to wss://localhost:9090 — override with TACHYBRIDGE_MOCK_URL.
import { run as runPub } from "./pub.js";
import { run as runSub } from "./sub.js";
import { run as runCall } from "./call.js";
import { run as runAdvertise } from "./advertise.js";

const SUBCOMMANDS: Record<string, (args: string[]) => void> = {
  pub: runPub,
  sub: runSub,
  call: runCall,
  advertise: runAdvertise,
};

function printUsage(): void {
  console.error("usage: tachybridge-mock <pub|sub|call|advertise> ...");
  console.error("");
  console.error("  pub <topic> <json-msg> [type]            Publish one message");
  console.error("  sub <topic> [type]                       Subscribe and print incoming messages");
  console.error("  call <service> [json-args] [type]        Call a service and print the response");
  console.error("  advertise <service> [json-response] [type]");
  console.error("                                           Advertise a service that replies with the given JSON");
  console.error("");
  console.error("Environment:");
  console.error("  TACHYBRIDGE_MOCK_URL        WebSocket URL (default wss://localhost:9090)");
  console.error("  TACHYBRIDGE_MOCK_TIMEOUT_MS Service-call timeout in ms (default 5000)");
}

function main(): void {
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
  handler(rest);
}

main();
