# tachybridge-mockup-rosbridge

Embeddable deterministic rosbridge mock server. Drops into your `http.Server`
or `https.Server`, speaks the rosbridge JSON protocol (plus CBOR binary
frames), and lets you wire your own services, topic streams, actions, and CLI
executor on top.

Built for end-to-end tests, demos, and local development against a
tachybridge / rosbridge client without a live ROS stack.

## Install

```bash
npm install tachybridge-mockup-rosbridge
```

## Quick start

```ts
import { createBridgeServer } from "tachybridge-mockup-rosbridge";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";

const bridge = createBridgeServer({
  services: {
    "/my/service": (args) => ({ success: true, echo: args }),
  },
  topicStreams: [
    {
      topic: "/heartbeat",
      type: "std_msgs/String",
      interval: 1000,
      make: () => ({ data: "tick" }),
    },
  ],
});

const server = createHttpsServer({
  cert: readFileSync("cert.pem"),
  key: readFileSync("key.pem"),
});
bridge.attach(server);
server.listen(9090);
```

Any rosbridge JSON WebSocket client connecting to `wss://localhost:9090` can
now subscribe to `/heartbeat`, call `/my/service`, etc.

TLS is the consumer's concern — the library accepts any
`http.Server` / `https.Server` via `attach()` and never imports `node:tls`
options itself. For plain HTTP you can skip the manual server and call
`bridge.listen(9090)`.

## API

### `createBridgeServer(options?): BridgeServer`

Factory. All state lives in the returned `BridgeServer` — create as many
independent instances as you need.

### `BridgeServerOptions`

| Field | Description |
| --- | --- |
| `services` | `Record<string, ServiceResponder>` — static service responders, keyed by service name. |
| `topicStreams` | `TopicStream[]` — periodic topic publishers (see below). |
| `actions` | `Record<string, ActionHandler>` — handlers keyed by `action_type`. |
| `cliExecutor` | `(command: string) => CliResponse \| Promise<CliResponse>` — handler for `op:"execute_cli"`. If unset, a deterministic built-in answers a small set of test commands. |
| `defaultServiceResponse` | `ServiceResponder` — fallback for service calls that fall through every higher-priority tier (see precedence below). |

#### `ServiceResponder`

```ts
(args: Record<string, unknown>) =>
  Record<string, unknown> | Promise<Record<string, unknown>>;
```

Return value becomes the `values` field of the `service_response`. Throw to
respond with `result: false` and an error message.

```ts
createBridgeServer({
  services: {
    "/add": ({ a, b }) => ({ sum: Number(a) + Number(b) }),
  },
});
```

#### `TopicStream`

```ts
{
  topic: string;
  type: string;
  interval: number;          // milliseconds
  make: () => Record<string, unknown>;
  makeRawFrame?: () => Record<string, unknown>;
}
```

`make()` is called every `interval` ms when there is at least one subscriber,
and the result is broadcast to all subscribers of the topic.

`makeRawFrame` is optional. If a subscriber requested
`compression: "cbor-raw"`, the server emits `makeRawFrame()` instead of
`make()` — useful for streams that expose a `{ bytes, secs, nsecs }` envelope.

#### `ActionHandler`

```ts
(ctx: {
  id: string;
  sessionId?: string;
  action: string;
  actionType: string;
  goal: Record<string, unknown>;
  sendFeedback: (feedback: Record<string, unknown>) => void;
  sendResult: (result: Record<string, unknown>, status?: number) => void;
}) => (() => void) | void;
```

Called on every `send_action_goal` with a matching `action_type`. The
returned function (if any) is invoked on cancel — emit a terminal result
with `status: 2` from there to fulfill outstanding `result` promises.

```ts
createBridgeServer({
  actions: {
    "demo/MoveArm": (ctx) => {
      const timer = setInterval(() => ctx.sendFeedback({ progress: 50 }), 100);
      setTimeout(() => {
        clearInterval(timer);
        ctx.sendResult({ success: true });
      }, 300);
      return () => {
        clearInterval(timer);
        ctx.sendResult({ canceled: true }, 2);
      };
    },
  },
});
```

#### `cliExecutor`

```ts
createBridgeServer({
  cliExecutor: async (command) => ({
    output: `ran: ${command}\n`,
    return_code: 0,
    success: true,
  }),
});
```

### `BridgeServer`

| Method | Description |
| --- | --- |
| `attach(server)` | Bind to an existing `http.Server` or `https.Server`. Adds an `upgrade` listener; multiple servers can share one bridge. |
| `listen(port, host?)` | Convenience for the common plain-HTTP case. Creates an `http.Server`, attaches, listens. Resolves once the socket is bound. Default host: `0.0.0.0`. |
| `close()` | Stops every periodic stream, closes every connected client, removes upgrade listeners from attached servers, and closes any `listen()`-owned servers. |
| `advertiseService(name, handler)` | Register/override a service at runtime. Returns an unregister function that restores the previously installed handler (if any). |
| `addTopicStream(stream)` | Register/override a topic stream at runtime. Returns an unregister function. Later registrations win. |
| `publish(topic, msg)` | Push a message to every current subscriber of `topic`. Cheap no-op if there are no subscribers. |
| `subscribers(topic)` | Read-only count of subscribers, mostly for tests/logging. |

```ts
const unregister = bridge.advertiseService("/probe", () => ({ alive: true }));
// …later
unregister();
```

```ts
bridge.publish("/sensor", { temperature: 21.3 });
```

## Handler precedence

For each `op:"call_service"`, the server walks this chain and stops at the
first tier that produces a response:

1. **`advertise_service` from a peer client** — if any connected client sent
   `op:"advertise_service"` for this service name, the call is forwarded to
   that client. The reply is routed back to the caller with the caller's
   original `id` preserved.
2. **`bridge.advertiseService(name, handler)`** — handlers registered at
   runtime on the server.
3. **`options.services[name]`** — static handlers passed at construction.
4. **Deterministic built-in (`args.force_fail === true`)** — answers any
   service call with `result: false, error: "forced_failure"`. Lets existing
   tachybridge tests model failure paths without per-service wiring.
5. **`options.defaultServiceResponse`** — your fallback for everything else.
6. **Built-in echo** — final catch-all that returns
   `{ echoed_args, advertised_topics }`. Matches the legacy mockup behavior
   so the bundled vitest fixtures keep working.

Topic streams use simpler "later wins" semantics: registering a stream for an
already-registered topic replaces the prior handler, and the returned
unregister function restores the previous registration.

## Speaking the protocol

A separate rosbridge JSON WebSocket client (or `tachybridge-roslib-compat`,
or your own CLI scripts) connecting to the server URL can:

- `op: "subscribe"` — receive periodic `op: "publish"` events for any
  registered `TopicStream`. Pass `compression: "cbor-raw"` to switch to the
  raw bytes envelope where `makeRawFrame` is set.
- `op: "advertise"` + `op: "publish"` on any topic — the server rebroadcasts
  to every subscriber of that topic (including the publisher if it is
  subscribed).
- `op: "call_service"` — resolved through the precedence chain above.
- `op: "advertise_service"` + `op: "service_response"` — peer-to-peer service
  forwarding (see precedence rule 1).
- `op: "send_action_goal"` / `op: "cancel_action_goal"` — drives the
  registered `ActionHandler`. Returns `op: "action_result"` with
  `error: "unknown_action_type"` if no handler is registered.
- `op: "execute_cli"` — answered via `options.cliExecutor` if set, otherwise
  by the deterministic built-in (`ros2 node list` returns a static node
  list; commands containing "fail" return a non-zero exit; everything else
  echoes back).

CBOR binary frames are auto-detected per connection: send one binary frame
and the server replies in CBOR for the rest of the session.

## Bundled script entry

`node dist/server.js` (`npm run start`) is unchanged — it boots a default
deterministic bridge on `0.0.0.0:9090` (override with
`MOCKUP_ROSBRIDGE_PORT`) using the same `createBridgeServer` factory under
the hood. This is what the `tachybridge-wasm` vitest fixtures use.

```bash
npm run build -w mockup-rosbridge
npm run start -w mockup-rosbridge
# or, from the monorepo root:
npm run mockup:start
```

Default URL: `ws://127.0.0.1:9090`

## CLI

The package ships a `tachybridge-mock` bin with five subcommands. Four are
clients (`pub`, `sub`, `call`, `advertise`) that speak the rosbridge JSON
protocol over a single WebSocket; one runs an embedded server (`server`).

```bash
# clients (default URL ws://localhost:9090)
npx tachybridge-mock pub <topic> <json-msg> [type]
npx tachybridge-mock sub <topic> [type]
npx tachybridge-mock call <service> [json-args] [type]
npx tachybridge-mock advertise <service> [json-response] [type]

# embedded server (auto-discovers config — see below)
npx tachybridge-mock server [--port n] [--host h] [--handlers <path>] [--no-watch]
```

### Client subcommands

| subcommand | behaviour |
| --- | --- |
| `pub` | Advertise the topic, publish the message once, unadvertise, exit. |
| `sub` | Subscribe and print every incoming message until `SIGINT`. |
| `call` | Issue a `call_service` and print the response (or status error). Exits when the response is received or after `TACHYBRIDGE_MOCK_TIMEOUT_MS`. |
| `advertise` | `advertise_service` and reply to every forwarded call with the given JSON until `SIGINT`. Pairs with `call` for cross-client service flows. |

All clients accept `--port <n>` (overrides the port on `ws://localhost`) and
`--url <u>` (overrides the full WebSocket URL). The CLI accepts self-signed
TLS certificates without verification, so pointing at a local `wss://`
endpoint also works.

### `server` subcommand

Runs the same `createBridgeServer` factory the library exports, with handler
configuration loaded from a consumer file. Listens on plain HTTP — bring
your own TLS termination if you need `wss://`.

Flags:

- `--port <n>` (default `9090`)
- `--host <h>` (default `0.0.0.0`)
- `--handlers <path>` — module to load. If omitted, auto-discovery runs.
- `--watch` / `--no-watch` — handler hot reload. Default: on when handlers
  are found, off otherwise.

#### Config discovery (cosmiconfig-style)

When `--handlers` is omitted, the bin walks up from cwd toward the nearest
`.git` directory and at each level looks for, in order:

1. `tachybridge-mock.config.ts`
2. `tachybridge-mock.config.mjs`
3. `tachybridge-mock.config.js`
4. `tachybridge-mock.config.cjs`
5. `package.json` with a `"tachybridgeMock"` string field pointing at a
   module path

The first hit wins. `.ts` configs require `tsx` installed locally — for
zero-tooling setups, prefer `.mjs`.

#### Config file shape

The discovered module is `await import()`-ed; any of these named exports are
picked up and forwarded into `BridgeServerOptions`:

```js
// tachybridge-mock.config.mjs
export const services = {
  "/my/service": (args) => ({ success: true, echo: args }),
};

export const topicStreams = [
  { topic: "/heartbeat", type: "std_msgs/String", interval: 1000, make: () => ({ data: "tick" }) },
];

export const defaultServiceResponse = (args) => ({ success: true, args });

export const actions = {
  // "demo/MoveArm": (ctx) => { ... },
};

export const cliExecutor = async (command) => ({ output: command, return_code: 0, success: true });
```

Missing exports fall through to the library's deterministic defaults.

### Environment overrides

| Variable | Default | Used by |
| --- | --- | --- |
| `TACHYBRIDGE_MOCK_URL` | `ws://localhost:9090` | Client subcommands. Overrides `--port`. |
| `TACHYBRIDGE_MOCK_TIMEOUT_MS` | `5000` | `call` subcommand only. |
