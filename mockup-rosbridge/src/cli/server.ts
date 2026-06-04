import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { existsSync, readFileSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createBridgeServer } from "../server.js";
import type {
  ActionHandler,
  BridgeServer,
  BridgeServerOptions,
  ServiceResponder,
  TopicStream,
} from "../types.js";

import { DEFAULT_PORT } from "./connect.js";

type ParsedArgs = {
  port: number;
  host: string;
  handlersPath?: string;
  watch: boolean | "auto";
  help: boolean;
};

// Cosmiconfig-style discovery: walk up from cwd toward the filesystem root,
// looking at each level for one of the canonical config filenames (in order)
// or a `tachybridgeMock` field in package.json. Stops at a `.git` directory
// so a monorepo's nearest project boundary always wins.
const CONFIG_BASENAMES = [
  "tachybridge-mock.config.ts",
  "tachybridge-mock.config.mjs",
  "tachybridge-mock.config.js",
  "tachybridge-mock.config.cjs",
];

function readPackageHandlerField(dir: string): string | undefined {
  const pkgPath = resolve(dir, "package.json");
  if (!existsSync(pkgPath)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { tachybridgeMock?: unknown };
    if (typeof pkg.tachybridgeMock === "string") {
      return resolve(dir, pkg.tachybridgeMock);
    }
  } catch {
    /* malformed package.json — ignore */
  }
  return undefined;
}

function autoDiscoverHandlers(startDir: string = process.cwd()): string | undefined {
  const fsRoot = parse(startDir).root;
  let dir = resolve(startDir);
  while (true) {
    for (const name of CONFIG_BASENAMES) {
      const candidate = resolve(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const fromPkg = readPackageHandlerField(dir);
    if (fromPkg && existsSync(fromPkg)) return fromPkg;
    if (existsSync(resolve(dir, ".git"))) break;
    const parent = dirname(dir);
    if (parent === dir || dir === fsRoot) break;
    dir = parent;
  }
  return undefined;
}

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = {
    port: DEFAULT_PORT,
    host: "0.0.0.0",
    handlersPath: undefined,
    watch: "auto",
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      result.help = true;
    } else if (arg === "--port" || arg === "-p") {
      const value = args[++i];
      if (!value) usage(`${arg} requires a value`, 1);
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0 || n > 65535) usage(`invalid port: ${value}`, 1);
      result.port = n;
    } else if (arg === "--host") {
      const value = args[++i];
      if (!value) usage(`${arg} requires a value`, 1);
      result.host = value;
    } else if (arg === "--handlers") {
      const value = args[++i];
      if (!value) usage(`${arg} requires a value`, 1);
      result.handlersPath = value;
    } else if (arg === "--watch" || arg === "-w") {
      result.watch = true;
    } else if (arg === "--no-watch") {
      result.watch = false;
    } else {
      usage(`unknown argument: ${arg}`, 1);
    }
  }
  if (!result.handlersPath) {
    result.handlersPath = autoDiscoverHandlers();
  }
  return result;
}

function usage(message?: string, exitCode = 0): never {
  if (message) console.error(`[tachybridge-mock] ${message}`);
  console.error("usage: tachybridge-mock server [--port n] [--host h] [--handlers <path>] [--watch]");
  console.error("");
  console.error("  --port <n>       Port to listen on (default 9090)");
  console.error("  --host <h>       Host to bind to (default 0.0.0.0)");
  console.error("  --handlers <p>   Path to a module exporting some of:");
  console.error("                     services, topicStreams, actions, cliExecutor,");
  console.error("                     defaultServiceResponse");
  console.error("                   .ts modules require `tsx` installed locally");
  console.error("                   If omitted, auto-discovers (cosmiconfig-style):");
  console.error("                     tachybridge-mock.config.{ts,mjs,js,cjs}");
  console.error("                     package.json:tachybridgeMock (string path)");
  console.error("                   walking up from cwd to the nearest .git directory");
  console.error("  --watch          Force handler hot-reload (default: on when handlers found)");
  console.error("  --no-watch       Disable hot-reload");
  process.exit(exitCode);
}

type HandlersModule = {
  services?: Record<string, ServiceResponder>;
  topicStreams?: TopicStream[];
  actions?: Record<string, ActionHandler>;
  cliExecutor?: BridgeServerOptions["cliExecutor"];
  defaultServiceResponse?: ServiceResponder;
};

async function ensureTypeScriptLoader(absPath: string): Promise<void> {
  if (!absPath.endsWith(".ts") && !absPath.endsWith(".tsx")) return;
  try {
    // Dynamic specifier so TypeScript does not try to resolve `tsx/esm/api`
    // at compile time — tsx is an opt-in peer the consumer brings.
    const tsxModule = "tsx/esm/api";
    const tsx: unknown = await import(tsxModule);
    const register = (tsx as { register?: () => void }).register;
    if (typeof register === "function") {
      register();
      return;
    }
  } catch {
    /* fall through */
  }
  console.error(
    `[tachybridge-mock] TypeScript handlers at ${absPath} require \`tsx\` installed as a devDependency.`,
  );
  process.exit(1);
}

async function loadHandlers(handlersPath: string, bustCache = false): Promise<HandlersModule> {
  const abs = isAbsolute(handlersPath) ? handlersPath : resolve(process.cwd(), handlersPath);
  if (!existsSync(abs)) {
    console.error(`[tachybridge-mock] handlers file not found: ${abs}`);
    process.exit(1);
  }
  await ensureTypeScriptLoader(abs);
  // First load: import the file URL straight so the tsx loader sees a
  // recognizable `.ts` extension. Subsequent reloads append `?t=N` so the
  // ESM cache yields a fresh module evaluation.
  const baseUrl = pathToFileURL(abs).href;
  const url = bustCache ? `${baseUrl}?t=${Date.now()}` : baseUrl;
  const mod = (await import(url)) as HandlersModule;
  return mod;
}

function modulesToOptions(mod: HandlersModule): BridgeServerOptions {
  return {
    services: mod.services,
    topicStreams: mod.topicStreams,
    actions: mod.actions,
    cliExecutor: mod.cliExecutor,
    defaultServiceResponse: mod.defaultServiceResponse,
  };
}

async function startBridge(
  httpServer: HttpServer,
  handlersPath: string | undefined,
  bustCache: boolean,
): Promise<BridgeServer> {
  const options = handlersPath
    ? modulesToOptions(await loadHandlers(handlersPath, bustCache))
    : {};
  const bridge = createBridgeServer(options);
  bridge.attach(httpServer);
  return bridge;
}

export async function run(args: string[]): Promise<void> {
  const opts = parseArgs(args);
  if (opts.help) usage(undefined, 0);
  const watch = opts.watch === "auto" ? Boolean(opts.handlersPath) : opts.watch;
  if (watch && !opts.handlersPath) {
    console.error("[tachybridge-mock] --watch has no effect without handlers; ignoring");
  }

  const httpServer = createHttpServer();
  let bridge = await startBridge(httpServer, opts.handlersPath, false);

  await new Promise<void>((resolveListen) => {
    httpServer.listen(opts.port, opts.host, () => resolveListen());
  });
  console.log(`[tachybridge-mock] listening on ws://${opts.host}:${opts.port}`);
  if (opts.handlersPath) {
    console.log(`[tachybridge-mock] handlers: ${opts.handlersPath}${watch ? " (watching)" : ""}`);
  } else {
    console.log("[tachybridge-mock] no handlers — running with deterministic defaults");
  }

  let watcher: FSWatcher | undefined;
  if (watch && opts.handlersPath) {
    const handlersAbs = isAbsolute(opts.handlersPath)
      ? opts.handlersPath
      : resolve(process.cwd(), opts.handlersPath);
    let reloadInFlight = false;
    watcher = fsWatch(handlersAbs, { persistent: true }, (eventType) => {
      if (eventType !== "change" || reloadInFlight) return;
      reloadInFlight = true;
      void (async () => {
        try {
          console.log("[tachybridge-mock] handlers changed, reloading...");
          await bridge.close();
          bridge = await startBridge(httpServer, opts.handlersPath, true);
          console.log("[tachybridge-mock] reload ok");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[tachybridge-mock] reload failed: ${message}`);
        } finally {
          reloadInFlight = false;
        }
      })();
    });
  }

  const shutdown = async () => {
    console.log("[tachybridge-mock] shutting down");
    watcher?.close();
    await bridge.close();
    httpServer.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
