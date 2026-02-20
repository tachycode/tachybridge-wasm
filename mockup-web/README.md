# mockup-web

Vite-based browser UI for smoke-testing `tachybridge-wasm` flows.

- Validates `topic`, `service`, and native action behavior
- Validates codec paths: `json`, `cbor`, and `subscribe.compression: "cbor-raw"`

## Setup

```bash
npm install
```

## Start Mock Server

```bash
npm run mockup:start
```

Default WebSocket URL: `ws://127.0.0.1:9090`

## Run Web App

```bash
npm run web:dev
```

Open the URL printed by Vite (usually `http://127.0.0.1:5173`).

## Expected Smoke Results

- `Smoke JSON`: connect, subscribe/publish roundtrip, call_service success
- `Smoke CBOR + cbor-raw`: cbor connect, cbor-raw subscribe payload, call_service success

Passing runs display `PASS ...` in the result panel.

## Troubleshooting

- Port conflict (`9090`): change `MOCKUP_ROSBRIDGE_PORT` and use the same URL in UI
- WebSocket connect failures: verify mock server is running first
- Missing `msg.bytes` in `cbor-raw`: verify server compression support and `codec: "cbor"`
- Import failure for `tachybridge-wasm`: run `npm run build -w tachybridge-wasm`
