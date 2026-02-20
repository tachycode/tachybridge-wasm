# tachybridge-wasm

`tachybridge-wasm` is a Rust/WASM-based WebSocket bridge client.

- Designed for tachybridge end-to-end behavior
- `topic` and `service` flows are compatible with rosbridge
- Native action support follows tachybridge protocol behavior

## Install

```bash
npm install tachybridge-wasm
```

Node.js: `>=20`

## Build

```bash
npm run build -w tachybridge-wasm
```

## API

- `connect(url)`
- `subscribe(topic, type, callback)`
- `subscribe(topic, type, callback, { compression? })`
- `unsubscribe(topic)`
- `advertise(topic, type)`
- `publish(topic, msg)`
- `callService(service, type, args, { id?, timeoutMs? })`
- `sendActionGoal(options)`
- `cancelActionGoal(options)`

## Codec

- Default: `json` (text frame)
- Optional: `cbor` (binary frame)
- Optional: `auto` (decode by payload type)

```ts
import { BridgeClient } from "tachybridge-wasm/node";

const client = new BridgeClient({ codec: "json", timeoutMs: 5000 });
await client.connect("ws://127.0.0.1:9090");
```

## Compatibility Notes

- Target protocol: tachybridge
- rosbridge compatibility: `topic` and `service` operations
- Action compatibility with rosbridge is limited due to event shape differences

## Browser and Node Entrypoints

- Browser: `import { BridgeClient } from "tachybridge-wasm"`
- Node: `import { BridgeClient } from "tachybridge-wasm/node"`

## Pre-Publish Checklist

```bash
npm run build -w tachybridge-wasm
npm run test -w tachybridge-wasm
npm pack --dry-run -w tachybridge-wasm
```
