# mockup-rosbridge

Deterministic WebSocket mock server for validating tachybridge protocol flows without ROS.

- Accepts JSON text frames and CBOR binary frames
- Replies in the same frame style for deterministic tests

## Run

```bash
npm run build -w mockup-rosbridge
npm run start -w mockup-rosbridge
npm run mockup:start
```

Default URL: `ws://127.0.0.1:9090`

## Supported Scenarios

- Topic
- `subscribe` with periodic `publish` events
- `advertise/publish` echo-style flow
- `compression: "cbor-raw"` path with `msg: { bytes, secs, nsecs }`
- Service
- `call_service` success and forced-failure path (`args.force_fail=true`)
- CLI
- `execute_cli` returns `cli_response` (`ros2 node list` deterministic output)
- Native action
- `send_action_goal -> request -> feedback -> result(status:0)`
- `cancel_action_goal -> cancel_action_result + result(status:2,canceled:true)`
- unsupported `action_type -> {"op":"action_result","error":"unknown_action_type"}`

## Protocol Sample

```json
{"op":"send_action_goal","action":"/arm/move","action_type":"demo/MoveArm","goal":{"x":1},"id":"goal-1","session_id":"sess-1"}
```
